#!/usr/bin/env node
// Live evaluation of agentic mode: real OpenRouter model, real datacat API, local archive assets.
// Records tool choices, rounds, cost and citations per question. Does not touch the production quota.
//   node tools/eval_agentic.mjs --label run1 [--only 1,3] [--max-usd 0.5] [--repeat 1]
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const {Archive, CacheStore, OpenRouter} = await import(path.join(root, 'worker/core.mjs'));
const {SourceStore} = await import(path.join(root, 'worker/source-store.mjs'));
const {agentic} = await import(path.join(root, 'worker/agent.mjs'));
const env = await readFile(path.join(root, '.env.chat'), 'utf8');
const key = name => env.match(new RegExp('^' + name + '\\s*=\\s*["\']?([^\\s"\']+)', 'm'))?.[1];
const label = arg('label', 'run'), maxUsd = Number(arg('max-usd', '0.5')), only = arg('only', '') ? new Set(arg('only').split(',').map(Number)) : null;
const shared = arg('shared-cache', '') === '1';

export const QUESTIONS = [
  'siapa pemegang saham terbesar SOCI dan apakah ada perubahan kepemilikan terbaru?',
  'RUPS tahunan BBCA 2026 memutuskan apa saja? termasuk dividen',
  'siapa yang menambah kepemilikan saham di BBCA selama 2024?',
  'perubahan direksi atau komisaris GOTO dalam setahun terakhir',
  'transaksi material atau afiliasi TLKM tahun 2026',
  'PT Soechi Group punya saham di emiten apa saja?',
  'analisis ENRG: rights issue dan perubahan pengendali, gabungkan arsip dan data resmi',
  'user zeinihzafahrozi sering bahas saham apa? cek juga data resmi kepemilikan emiten yang paling sering dia bahas',
  'laporan keuangan terbaru SOCI: pendapatan dan laba bersih',
  'pengumuman keterbukaan informasi terbaru TOWR',
  'siapa pelapor perubahan kepemilikan saham MDKA terbaru? periksa silang profil pihak itu: jabatan dan kepemilikan lainnya',
  'direksi atau komisaris yang baru diangkat di GOTO, siapa mereka dan apa jabatan atau kepemilikan lainnya?',
  'siapa pembeli saham terbesar di TOWR bulan ini dan apa hubungannya dengan emiten?',
];

const manifest = JSON.parse(await readFile(path.join(root, 'worker/.assets/manifest.json'), 'utf8'));
const readAsset = name => readFile(path.join(root, 'worker/.assets', name));
function sqlite() {
  const db = new DatabaseSync(':memory:');
  const sql = {exec(q, ...a) { const s = db.prepare(q), rows = s.columns().length ? s.all(...a) : (s.run(...a), []); return {toArray:() => rows, one:() => rows[0]}; }};
  return {db, sql, ctx:{storage:{sql, transactionSync(fn) { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } }}}};
}
const store = sqlite(), sources = new SourceStore(store.ctx);
for (const doc of manifest.docs) await sources.importDocument(manifest, doc, JSON.parse(await readAsset(doc.evidence_asset)));
const archive = new Archive({fetch:async r => new Response(await readAsset(new URL(r.url).pathname.slice(1)))}, sources);
const sharedCache = sqlite();

let spent = 0;
const results = [];
for (const [i, question] of QUESTIONS.entries()) {
  if (only && !only.has(i + 1)) continue;
  const own = shared ? sharedCache : sqlite(), cache = new CacheStore(own.sql);
  const model = new OpenRouter(key('OPENROUTER_API_KEY'), null, undefined, () => { if (spent > maxUsd) throw Error('Eval USD ceiling reached'); }, {responseCache:false});
  const stats = {}, started = Date.now(), events = [];
  let result, error;
  // A provider rate limit says nothing about the agent; wait and run the question again.
  for (let attempt = 1; attempt <= 3; attempt++) {
    error = undefined;
    try {
      result = await agentic({archive, model, question, emit:async e => events.push(e), cache, env:{DATACAT_API_KEY:key('DATACAT_API_KEY')}, stats});
    } catch (e) { error = e.message; }
    if (!/membatasi permintaan/.test(error || '')) break;
    await new Promise(ok => setTimeout(ok, 20000 * attempt));
  }
  const usage = model.usage(); spent += usage.known_cost_usd;
  const cited = [...new Set([...(result?.answer || '').matchAll(/\[([DK]\d+)\]/g)].map(m => m[1]))];
  const known = new Set((result?.sources || []).map(s => s.source_id));
  const row = {n:i + 1, question, error:error || null, rounds:stats.agent_rounds, calls:stats.agent_calls, tool_calls:stats.agent_tool_calls,
    datacat_cache_hits:stats.datacat_cache_hits, cost:usage.known_cost_usd, model_calls:usage.calls, prompt_tokens:usage.prompt_tokens,
    completion_tokens:usage.completion_tokens, cached_tokens:usage.cached_tokens, seconds:(Date.now() - started) / 1000,
    sources:result?.sources, cited, unmatched_citations:cited.filter(c => !known.has(c)), answer:result?.answer};
  results.push(row);
  console.log(`${error ? 'ERR ' : 'OK  '} #${row.n} rounds=${row.rounds} tools=${row.tool_calls} calls=${row.model_calls} $${row.cost.toFixed(5)} ${row.seconds.toFixed(0)}s `
    + `sources=${row.sources?.length ?? 0} unmatched=${row.unmatched_citations.length} ${error || ''}`);
  for (const c of stats.agent_calls || []) console.log(`      ${c.tool} ${JSON.stringify(c.args)}${c.cached ? ' (cache)' : ''}${c.bytes ? ' ' + c.bytes + 'B' : ''}`);
  if (own !== sharedCache) own.db.close();
}
const summary = {label, created_at:new Date().toISOString(), questions:results.length, ok:results.filter(r => !r.error).length,
  total_usd:spent, mean_usd:spent / Math.max(1, results.length), max_usd:Math.max(0, ...results.map(r => r.cost)),
  mean_tool_calls:results.reduce((n, r) => n + (r.tool_calls || 0), 0) / Math.max(1, results.length),
  mean_seconds:results.reduce((n, r) => n + r.seconds, 0) / Math.max(1, results.length)};
await mkdir(path.join(root, 'reports/eval'), {recursive:true});
await writeFile(path.join(root, 'reports/eval', 'agentic-' + label + '.json'), JSON.stringify({summary, results}, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
