#!/usr/bin/env node
// A/B token benchmark for the archive chat: runs the same questions through converse() of one code copy and
// records every model call (kind, input bytes, estimated tokens; real Claude usage in --bridge mode).
//
//   # offline (default): stub model, no network, no quota. Exact bytes per call; tokens estimated as bytes/1.8.
//   node tools/bench_tokens.mjs --impl <repo copy A> --assets <assets A> --questions q.json --out a.json
//   node tools/bench_tokens.mjs --impl .            --assets <assets B> --questions q.json --out b.json
//   # real: claude -p through <impl>/local/claude-bridge.mjs (Claude subscription; uses the rate limit)
//   node tools/bench_tokens.mjs --bridge --model sonnet --effort low --impl <repo> --assets <dir> --questions q.json --out live.json --limit 8
//   # compare two runs (Markdown table on stdout, JSON summary to --out)
//   node tools/bench_tokens.mjs --diff a.json b.json [--out diff.json]
//
// Options: --limit N, --only id1,id2 (id or id prefix), --concurrency N (questions at once, default 1),
//   --bridge-concurrency N (claude processes, default 2×concurrency), --bin claude, --now 2026-10-15T05:00:00Z
//   (freezes Date.now, e.g. "terbaru"/year defaults), --no-store (Assets fallback instead of the SQLite source index), --verbose.
// --impl is a repo copy (with worker/ and, for --bridge, local/) or its worker/ dir. --assets is tools/build_worker.py
// output for that arm (rebuild per arm when build_worker/evidence_index differ). --questions: the VPS question dump
// (rows with question, terms, metrics.retrieval.{mode,intent,terms}) or a JSON array of strings / {id, question, terms?, intent?}.
// Agentic rows are skipped and identical questions run once. Each question starts with a cold app cache (CacheStore);
// the SQLite source index is shared, as in production. Offline, the term/intent JSON call replays the production
// terms (deterministic); in --bridge mode the real model answers it.
// Prompt cache: run each --bridge arm in its own process. A bridge that persists its turn-boundary key
// (<impl>/.local/boundary.key) tags the same material identically across runs, so run the arms from different copies
// or more than the cache TTL apart; a bridge with a per-process key shares only the small system prefix between arms.
// Questions inside one arm can hit each other's cache, as in production. --out must be outside the repo or git-ignored (e.g. reports/private/), never tracked files.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {existsSync, realpathSync, readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), REPO = path.resolve(HERE, '..');
export const BYTES_PER_TOKEN = 1.8; // production Claude reads this archive at ~1.7-1.9 bytes per prompt token
export const estTokens = bytes => Math.round(bytes / BYTES_PER_TOKEN);
const json = value => { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return null; } };
const norm = text => String(text || '').trim().replace(/\s+/g, ' ');

// Questions: VPS dump rows, plain strings or {id, question, terms?, intent?}. Agentic rows skipped, duplicates merged.
export function loadQuestions(raw) {
  if (!Array.isArray(raw)) throw new Error('--questions harus berupa array JSON');
  const out = [], seen = new Map(); let skipped = 0;
  raw.forEach((row, i) => {
    const r = typeof row === 'string' ? {question:row} : row || {};
    const metrics = json(r.metrics) || {}, retrieval = metrics.retrieval || {};
    if ((r.mode || retrieval.mode) === 'agentic') { skipped++; return; }
    const question = norm(r.question);
    if (!question) return;
    let terms = json(r.terms); if (!Array.isArray(terms)) terms = Array.isArray(retrieval.terms) ? retrieval.terms : null;
    const intent = r.intent || retrieval.intent || null, known = seen.get(question);
    if (known) { if (!known.terms?.length && terms?.length) known.terms = terms; if (!known.intent && intent) known.intent = intent; return; }
    const u = metrics.usage;
    const q = {id:String(r.id || 'q' + (i + 1)).slice(0, 36), question, terms, intent,
      prod:u ? {status:r.status || null, calls:u.calls, input_bytes:u.input_bytes, prompt_tokens:u.prompt_tokens, cached_tokens:u.cached_tokens,
        cache_write_tokens:u.cache_write_tokens, completion_tokens:u.completion_tokens, estimated_cost_usd:u.estimated_cost_usd,
        evidence_mode:retrieval.evidence_mode || null} : null};
    seen.set(question, q); out.push(q);
  });
  return {questions:out, skipped_agentic:skipped};
}

// Call kind from the OpenRouter-shaped payload only (no core.mjs internals): agent step, term/intent JSON,
// thematic candidate selection, final answer (streamed with a reasoning budget) or source note.
export function classify(payload) {
  const first = String(payload.messages?.[0]?.content || '');
  if (payload.tools && !payload.stream) return 'step';
  if (payload.response_format) return /^Ubah pertanyaan riset arsip|"intent"/.test(first) ? 'term' : /"ids"/.test(first) ? 'select' : 'json';
  if (payload.stream && payload.reasoning && payload.reasoning.enabled !== false) return 'answer';
  return 'note';
}

const pick = (object, pattern) => {
  for (const [key, value] of Object.entries(object || {})) if (pattern.test(key) && typeof value === 'number') return value;
  return null;
};
// Normalised usage; the raw receipt is kept too, so fields a newer bridge adds are never lost.
function usageFields(u) {
  if (!u) return {};
  const pd = u.prompt_tokens_details || {}, cd = u.completion_tokens_details || {}, n = v => typeof v === 'number' ? v : null;
  return {prompt_tokens:n(u.prompt_tokens), cached_tokens:n(pd.cached_tokens), cache_write_tokens:n(pd.cache_write_tokens),
    cache_write_1h:pick(pd, /1h/i) ?? pick(u, /1h/i), cache_write_5m:pick(pd, /5m/i) ?? pick(u, /5m/i),
    thinking_tokens:pick(cd, /thinking|reasoning/i) ?? pick(pd, /thinking/i) ?? pick(u, /thinking/i),
    completion_tokens:n(u.completion_tokens), estimated_cost_usd:n(u.estimated_cost) ?? n(u.estimated_cost_usd)};
}

// Passes the body through unchanged (cancel still reaches the bridge) while reading usage/finish_reason/text size.
function sniff(response, stream, call) {
  if (!response.body) return response;
  const decoder = new TextDecoder(); let pending = '', whole = '';
  const line = text => {
    if (!text.startsWith('data:')) return;
    const event = json(text.slice(5).trim()); if (!event || typeof event !== 'object') return;
    if (event.usage) call.usage_raw = event.usage;
    const choice = event.choices?.[0];
    if (typeof choice?.delta?.content === 'string') call.output_chars += choice.delta.content.length;
    if (choice?.finish_reason) call.finish_reason = choice.finish_reason;
  };
  const done = () => {
    if (stream) { if (pending) line(pending); }
    else { const event = json(whole); if (event?.usage) call.usage_raw = event.usage; const c = event?.choices?.[0];
      if (c) { call.finish_reason = c.finish_reason || null; call.output_chars = String(c.message?.content || '').length; } }
    call.ms = Math.round(performance.now() - call.started);
  };
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, {stream:true});
      if (stream) { pending += text; const lines = pending.split('\n'); pending = lines.pop(); lines.forEach(line); }
      else if (whole.length < 8000000) whole += text;
      controller.enqueue(chunk);
    },
    flush() { done(); }}));
  return new Response(body, {status:response.status, statusText:response.statusText, headers:response.headers});
}

const sse = text => new Response(['data: ' + JSON.stringify({id:'bench', choices:[{delta:{content:text}, finish_reason:null}]}),
  'data: ' + JSON.stringify({id:'bench', choices:[{delta:{}, finish_reason:'stop'}], usage:{prompt_tokens:0, completion_tokens:0, cost:0}}),
  'data: [DONE]'].join('\n\n') + '\n\n', {headers:{'Content-Type':'text/event-stream'}});
const reply = content => Response.json({id:'bench', choices:[{message:{role:'assistant', content}, finish_reason:'stop'}],
  usage:{prompt_tokens:0, completion_tokens:0, cost:0}});
// Offline model: replays production terms; cites the first source id in the material so citation checks pass.
function stub(payload, kind, q) {
  const last = String(payload.messages.at(-1)?.content || '');
  if (kind === 'term') return reply(JSON.stringify({intent:q.intent || 'search', terms:q.terms || []}));
  if (kind === 'select') { const ids = [...last.matchAll(/"id":(\d+)/g)].map(m => +m[1]); return reply(JSON.stringify({ids:ids.length ? [...new Set(ids)] : [0]})); }
  if (kind === 'json') return reply('{}');
  if (kind === 'step') return reply('SIAP');
  const id = (JSON.stringify(payload.messages).match(/"source_id":"(D\d+)"/) || [, 'D1'])[1];
  const text = kind === 'answer' ? 'Ringkasan uji bench [' + id + '].' : 'Catatan bukti bench [D1].';
  return payload.stream ? sse(text) : reply(text);
}

function sqlite() {
  const db = new DatabaseSync(':memory:');
  const cursor = rows => ({toArray:() => rows, one() { if (rows.length !== 1) throw new Error('Expected exactly one row'); return rows[0]; },
    [Symbol.iterator]:() => rows[Symbol.iterator]()});
  const sql = {exec(query, ...args) { const s = db.prepare(query); return cursor(s.columns().length ? s.all(...args) : (s.run(...args), [])); }};
  let depth = 0;
  const transactionSync = fn => {
    const name = 'tx' + depth++; db.exec('SAVEPOINT ' + name);
    try { const result = fn(); db.exec('RELEASE ' + name); return result; }
    catch (error) { db.exec('ROLLBACK TO ' + name); db.exec('RELEASE ' + name); throw error; }
    finally { depth--; }
  };
  return {db, sql, ctx:{storage:{sql, transactionSync}}};
}

const SUM = ['input_bytes', 'est_tokens', 'output_token_budget', 'prompt_tokens', 'cached_tokens', 'cache_write_tokens', 'cache_write_1h',
  'cache_write_5m', 'thinking_tokens', 'completion_tokens', 'estimated_cost_usd'];
function totals(rows) {
  const t = {questions:rows.length, errors:rows.filter(r => r.error).length, calls:0, by_kind:{}}; for (const k of SUM) t[k] = 0;
  for (const r of rows) for (const c of r.calls) {
    t.calls++; const k = t.by_kind[c.kind] ||= {calls:0, input_bytes:0, est_tokens:0, prompt_tokens:0, completion_tokens:0};
    k.calls++; k.input_bytes += c.input_bytes; k.est_tokens += c.est_tokens; k.prompt_tokens += c.prompt_tokens || 0; k.completion_tokens += c.completion_tokens || 0;
    for (const f of SUM) t[f] += c[f] || 0;
  }
  t.estimated_cost_usd = +t.estimated_cost_usd.toFixed(6);
  return t;
}

// Output must not dirty tracked files (publish_stockbit.py refuses a dirty tree): outside the repo or git-ignored.
function checkOut(file) {
  const out = path.resolve(file), dir = existsSync(path.dirname(out)) ? realpathSync(path.dirname(out)) : path.dirname(out);
  const rel = path.relative(REPO, path.join(dir, path.basename(out)));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return out;
  const ignored = spawnSync('git', ['-C', REPO, 'check-ignore', '-q', rel]).status === 0;
  if (!ignored) throw new Error('--out ' + rel + ' ada di dalam repo dan tidak di-ignore Git; pakai folder sementara atau reports/private/');
  return out;
}

function args(argv) {
  const opt = {flags:new Set(), positional:[]}, flags = new Set(['offline', 'bridge', 'diff', 'no-store', 'verbose', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opt.positional.push(a); continue; }
    const name = a.slice(2);
    if (flags.has(name)) opt.flags.add(name); else { if (i + 1 >= argv.length) throw new Error(a + ' perlu nilai'); opt[name] = argv[++i]; }
  }
  return opt;
}

async function run(opt) {
  const bridge = opt.flags.has('bridge');
  if (!opt.impl || !opt.assets || !opt.questions || !opt.out) throw new Error('Perlu --impl, --assets, --questions dan --out (lihat kepala berkas)');
  const out = checkOut(opt.out);
  const impl = path.resolve(opt.impl);
  const root = existsSync(path.join(impl, 'worker', 'core.mjs')) ? impl : existsSync(path.join(impl, 'core.mjs')) ? path.dirname(impl) : null;
  if (!root) throw new Error('--impl tidak berisi worker/core.mjs');
  const workerDir = path.join(root, 'worker'), assets = path.resolve(opt.assets);
  if (!existsSync(path.join(assets, 'manifest.json'))) throw new Error('--assets tidak berisi manifest.json');
  if (opt.now) { const t = Date.parse(opt.now); if (!Number.isFinite(t)) throw new Error('--now tidak valid'); Date.now = () => t; }
  const {Archive, CacheStore, OpenRouter, converse} = await import(pathToFileURL(path.join(workerDir, 'core.mjs')));
  const {SourceStore} = await import(pathToFileURL(path.join(workerDir, 'source-store.mjs')));

  const loaded = loadQuestions(JSON.parse(await readFile(path.resolve(opt.questions), 'utf8')));
  let list = loaded.questions;
  if (opt.only) { const ids = opt.only.split(',').map(s => s.trim()).filter(Boolean); list = list.filter(q => ids.some(id => q.id === id || q.id.startsWith(id))); }
  list = list.slice(0, Number(opt.limit) || Infinity);
  const concurrency = Math.max(1, Number(opt.concurrency) || 1);

  let fetcher = null, bridgePath = null;
  if (bridge) {
    bridgePath = path.join(root, 'local', 'claude-bridge.mjs');
    if (!existsSync(bridgePath)) { bridgePath = path.join(REPO, 'local', 'claude-bridge.mjs'); console.error('Peringatan: --impl tanpa local/, memakai bridge ' + bridgePath); }
    const mod = await import(pathToFileURL(bridgePath));
    const bin = opt.bin || process.env.ARSIP_CLAUDE_BIN || 'claude';
    if (mod.checkAuth) { // Same gate as local/server.mjs: only the owner's subscription login, never per-token API billing.
      const status = spawnSync(bin, ['auth', 'status', '--json'], {encoding:'utf8', env:mod.cliEnv ? mod.cliEnv() : process.env, timeout:30000});
      mod.checkAuth(json(status.stdout));
    }
    fetcher = mod.claudeFetcher({bin, model:opt.model || 'sonnet', effort:opt.effort || 'low',
      concurrency:Number(opt['bridge-concurrency']) || 2 * concurrency,
      log:opt.flags.has('verbose') ? e => process.stderr.write('[claude] ' + JSON.stringify(e) + '\n') : () => {}});
  }

  const t0 = performance.now(), manifest = JSON.parse(await readFile(path.join(assets, 'manifest.json'), 'utf8'));
  const readAsset = name => { const file = path.resolve(assets, name); if (!file.startsWith(assets + path.sep)) throw new Error('asset di luar folder'); return readFile(file); };
  const assetFetch = {fetch:async request => { try { return new Response(await readAsset(decodeURIComponent(new URL(request.url).pathname.slice(1)))); } catch { return new Response('Not found', {status:404}); } }};
  let store = null;
  if (!opt.flags.has('no-store')) {
    store = new SourceStore(sqlite().ctx);
    for (const doc of manifest.docs) await store.importDocument(manifest, doc, JSON.parse(await readAsset(doc.evidence_asset)));
  }
  const header = {tool:'bench_tokens', format:1, mode:bridge ? 'bridge' : 'offline', impl:root, bridge:bridgePath,
    model:bridge ? opt.model || 'sonnet' : null, effort:bridge ? opt.effort || 'low' : null, assets, questions_file:path.resolve(opt.questions),
    archive_version:manifest.version, retrieval_version:manifest.retrieval_version, bytes_per_token:BYTES_PER_TOKEN,
    started_at:new Date().toISOString(), now:opt.now || null, store:!!store, import_ms:Math.round(performance.now() - t0), skipped_agentic:loaded.skipped_agentic};
  console.error(`${header.mode}: ${list.length} pertanyaan, arsip ${manifest.version}, impor indeks ${header.import_ms} ms`);

  const rows = new Array(list.length);
  const save = async () => { const done = rows.filter(Boolean);
    await mkdir(path.dirname(out), {recursive:true});
    await writeFile(out, JSON.stringify({...header, totals:totals(done), rows:done}, null, 2) + '\n'); };

  async function ask(q) {
    const own = sqlite(), cache = new CacheStore(own.sql), calls = [];
    const archive = new Archive(assetFetch, store);
    let model;
    const wrapped = async (url, init = {}) => {
      const payload = JSON.parse(init.body), kind = classify(payload), receipt = model.receipts.at(-1);
      let call = calls.find(c => c.receipt === receipt && c.body === init.body); // a 429/503 resend of the same request
      if (call) call.sends++;
      else {
        const bytes = Buffer.byteLength(JSON.stringify(payload.messages));
        call = {kind, input_bytes:bytes, est_tokens:estTokens(bytes), output_token_budget:payload.max_tokens || 0, stream:!!payload.stream,
          reasoning:payload.reasoning?.enabled === false ? 0 : payload.reasoning?.max_tokens ?? null, sends:1, status:null,
          finish_reason:null, output_chars:0, started:performance.now(), ms:null, usage_raw:null, receipt, body:init.body};
        calls.push(call);
      }
      const response = fetcher ? await fetcher(url, init) : stub(payload, kind, q);
      call.status = response.status;
      return sniff(response, !!payload.stream, call);
    };
    model = new OpenRouter(bridge ? 'local-claude-code' : 'OFFLINE', null, wrapped);
    const metrics = {}, start = performance.now(); let result, error = null, emitted = '', sources = null;
    const emit = async event => { if (event?.type === 'delta') emitted += event.text || ''; if (event?.type === 'sources') sources = event.sources; };
    try { result = await converse(archive, model, q.question, [], emit, null, {cache, metrics, client:'bench'}); }
    catch (e) { error = e?.message || String(e); }
    own.db.close();
    const callRows = calls.map(({receipt, body, started, usage_raw, ...c}) => {
      const fromReceipt = receipt ? {prompt_tokens:receipt.prompt_tokens, cached_tokens:receipt.cached_tokens, cache_write_tokens:receipt.cache_write_tokens,
        completion_tokens:receipt.completion_tokens, estimated_cost_usd:receipt.estimated_cost} : {};
      const u = usageFields(usage_raw), merged = {...c};
      for (const [k, v] of Object.entries({...fromReceipt, ...Object.fromEntries(Object.entries(u).filter(([, v]) => v !== null))})) if (v !== null && v !== undefined) merged[k] = v;
      if (!bridge) for (const k of ['prompt_tokens', 'cached_tokens', 'cache_write_tokens', 'completion_tokens', 'estimated_cost_usd']) delete merged[k];
      if (bridge) merged.usage_raw = usage_raw;
      return merged;
    });
    const answer = result?.answer ?? emitted, src = result?.sources || sources || [];
    const row = {id:q.id, question:q.question, terms_replayed:bridge ? null : q.terms, error, elapsed_ms:Math.round(performance.now() - start),
      kinds:callRows.map(c => c.kind).join(','), calls:callRows, intent:metrics.intent ?? null, evidence_mode:metrics.evidence_mode ?? null,
      selected_source_bytes:metrics.selected_source_bytes ?? null, baseline_source_bytes:metrics.baseline_source_bytes ?? null,
      documents:result?.documents ?? null, sources:src.map(s => s.title || s.name || s.id), answer:bridge ? answer : null,
      answer_chars:answer.length, truncated:!!model.truncated, prod:q.prod, retrieval:metrics};
    Object.assign(row, Object.fromEntries(Object.entries(totals([row])).filter(([k]) => SUM.includes(k))), {n_calls:callRows.length});
    return row;
  }

  let next = 0;
  await Promise.all(Array.from({length:Math.min(concurrency, list.length)}, async () => {
    while (next < list.length) {
      const i = next++, q = list[i];
      rows[i] = await ask(q);
      const r = rows[i];
      console.log([String(r.input_bytes).padStart(8), String(r.est_tokens).padStart(7), String(r.n_calls).padStart(2),
        (r.evidence_mode || '-').padEnd(14), bridge ? `p${r.prompt_tokens} c${r.cached_tokens} o${r.completion_tokens} $${r.estimated_cost_usd.toFixed(3)}` : '',
        r.error ? 'ERR ' + r.error.slice(0, 50) : '', q.question.slice(0, 70)].filter(Boolean).join('  '));
      await save();
    }
  }));
  fetcher?.closeAll?.();
  await save();
  const t = totals(rows);
  console.log(JSON.stringify({mode:header.mode, questions:t.questions, errors:t.errors, calls:t.calls, input_bytes:t.input_bytes, est_tokens:t.est_tokens,
    ...(bridge ? {prompt_tokens:t.prompt_tokens, cached_tokens:t.cached_tokens, cache_write_tokens:t.cache_write_tokens,
      completion_tokens:t.completion_tokens, estimated_cost_usd:t.estimated_cost_usd} : {}), out}));
}

// Per-question comparison of two runs, matched by id (then by question text).
export function diffRuns(a, b) {
  const key = r => r.id || norm(r.question), byB = new Map(b.rows.map(r => [key(r), r])), byText = new Map(b.rows.map(r => [norm(r.question), r]));
  const real = a.mode === 'bridge' || b.mode === 'bridge', pairs = [], onlyA = [];
  for (const ra of a.rows) { const rb = byB.get(key(ra)) || byText.get(norm(ra.question)); if (rb) pairs.push([ra, rb]); else onlyA.push(ra.id); }
  const matched = new Set(pairs.map(([, rb]) => rb)), onlyB = b.rows.filter(r => !matched.has(r)).map(r => r.id);
  const pct = (x, y) => x ? Math.round((y - x) / x * 1000) / 10 : null;
  const fields = ['n_calls', 'input_bytes', 'est_tokens', 'output_token_budget', ...(real ? ['prompt_tokens', 'cached_tokens', 'cache_write_tokens', 'completion_tokens', 'estimated_cost_usd'] : [])];
  const questions = pairs.map(([ra, rb]) => ({id:ra.id, question:ra.question, a:Object.fromEntries(fields.map(f => [f, ra[f] ?? 0])),
    b:Object.fromEntries(fields.map(f => [f, rb[f] ?? 0])), mode:[ra.evidence_mode, rb.evidence_mode], kinds:[ra.kinds, rb.kinds],
    error:[ra.error, rb.error], change_pct:pct(ra.est_tokens, rb.est_tokens), ...(real ? {prompt_change_pct:pct(ra.prompt_tokens, rb.prompt_tokens)} : {})}));
  const sum = side => Object.fromEntries(fields.map(f => [f, +questions.reduce((n, q) => n + (q[side][f] || 0), 0).toFixed(6)]));
  const ta = sum('a'), tb = sum('b');
  return {a:{file:a.file, mode:a.mode, impl:a.impl, archive_version:a.archive_version}, b:{file:b.file, mode:b.mode, impl:b.impl, archive_version:b.archive_version},
    real, matched:pairs.length, only_a:onlyA, only_b:onlyB, totals:{a:ta, b:tb, change_pct:Object.fromEntries(fields.map(f => [f, pct(ta[f], tb[f])]))},
    by_kind:{a:totals(pairs.map(p => p[0])).by_kind, b:totals(pairs.map(p => p[1])).by_kind}, questions};
}

export function diffTable(d) {
  const kb = n => (n / 1024).toFixed(0), k = n => (n / 1000).toFixed(1) + 'k', arrow = (x, y, f = String) => f(x) + ' → ' + f(y);
  const cell = s => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ');
  const head = ['id', 'question', 'calls', 'KB', 'est tok', 'Δ%', 'mode', ...(d.real ? ['prompt tok', 'out tok', 'est $'] : []), 'err'];
  const lines = ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|'];
  for (const q of d.questions) lines.push('| ' + [q.id.slice(0, 8), cell(q.question.slice(0, 48)), arrow(q.a.n_calls, q.b.n_calls), arrow(q.a.input_bytes, q.b.input_bytes, kb),
    arrow(q.a.est_tokens, q.b.est_tokens, k), q.change_pct ?? '-', cell(arrow(q.mode[0] || '-', q.mode[1] || '-')),
    ...(d.real ? [arrow(q.a.prompt_tokens, q.b.prompt_tokens, k), arrow(q.a.completion_tokens, q.b.completion_tokens, k), arrow(q.a.estimated_cost_usd, q.b.estimated_cost_usd, x => x.toFixed(3))] : []),
    cell([q.error[0] && 'A', q.error[1] && 'B'].filter(Boolean).join('+'))].join(' | ') + ' |');
  const {a, b, change_pct:c} = d.totals;
  lines.push('| **total** | ' + d.matched + ' pertanyaan | ' + arrow(a.n_calls, b.n_calls) + ' | ' + arrow(a.input_bytes, b.input_bytes, kb) + ' | ' + arrow(a.est_tokens, b.est_tokens, k)
    + ' | ' + (c.est_tokens ?? '-') + ' | | ' + (d.real ? [arrow(a.prompt_tokens, b.prompt_tokens, k), arrow(a.completion_tokens, b.completion_tokens, k), arrow(a.estimated_cost_usd, b.estimated_cost_usd, x => x.toFixed(3))].join(' | ') + ' | ' : '') + ' |');
  lines.push('', '| kind | calls | est tok' + (d.real ? ' | prompt tok' : '') + ' |', '|---|---|---' + (d.real ? '|---' : '') + '|');
  for (const kind of [...new Set([...Object.keys(d.by_kind.a), ...Object.keys(d.by_kind.b)])]) {
    const x = d.by_kind.a[kind] || {calls:0, est_tokens:0, prompt_tokens:0}, y = d.by_kind.b[kind] || {calls:0, est_tokens:0, prompt_tokens:0};
    lines.push('| ' + kind + ' | ' + arrow(x.calls, y.calls) + ' | ' + arrow(x.est_tokens, y.est_tokens, k) + (d.real ? ' | ' + arrow(x.prompt_tokens, y.prompt_tokens, k) : '') + ' |');
  }
  if (d.only_a.length || d.only_b.length) lines.push('', 'Hanya di A: ' + (d.only_a.join(', ') || '-') + '; hanya di B: ' + (d.only_b.join(', ') || '-'));
  return lines.join('\n');
}

async function diffMain(opt) {
  const [fa, fb] = opt.positional;
  if (!fa || !fb) throw new Error('--diff a.json b.json');
  const load = async f => ({...JSON.parse(await readFile(path.resolve(f), 'utf8')), file:path.resolve(f)});
  const d = diffRuns(await load(fa), await load(fb));
  console.log(diffTable(d));
  if (opt.out) { const out = checkOut(opt.out); await mkdir(path.dirname(out), {recursive:true}); await writeFile(out, JSON.stringify(d, null, 2) + '\n'); console.error('Ringkasan JSON: ' + out); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opt = args(process.argv.slice(2));
    if (opt.flags.has('help')) console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0].replace(/^#!.*\n/, '').replace(/^\/\/ ?/gm, ''));
    else if (opt.flags.has('diff')) await diffMain(opt);
    else await run(opt);
  } catch (error) { console.error('Gagal: ' + (error?.message || error)); process.exit(1); }
}
