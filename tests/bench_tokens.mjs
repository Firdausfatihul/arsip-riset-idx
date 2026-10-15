// tools/bench_tokens.mjs stays in step with converse(): question parsing, call classification, diff, and an offline
// smoke run (stub model, and the real bridge against a fake `claude`). No model or network call is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadQuestions, classify, diffRuns, diffTable, estTokens} from '../tools/bench_tokens.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), script = path.join(root, 'tools/bench_tokens.mjs');
const assets = path.join(root, 'worker/.assets'), haveAssets = existsSync(path.join(assets, 'manifest.json'));
const bench = (...args) => spawnSync(process.execPath, ['--no-warnings', script, ...args], {encoding:'utf8', cwd:root, timeout:120000});

test('loadQuestions: VPS dump, agentic skipped, duplicates merged, plain lists', () => {
  const metrics = (retrieval, usage) => JSON.stringify({retrieval, ...(usage ? {usage} : {})});
  const {questions, skipped_agentic} = loadQuestions([
    {id:'aaaaaaaa-1', question:'analisis  ERAL', terms:'[]', metrics:metrics({mode:'agentic'})},
    {id:'bbbbbbbb-2', question:'apa katalis TOWR', terms:null, metrics:metrics({intent:null})},
    {id:'cccccccc-3', question:'apa katalis  TOWR ', terms:'["TOWR"]', metrics:metrics({intent:'search', terms:['TOWR']}, {calls:1, input_bytes:9, prompt_tokens:5})},
    {id:'dddddddd-4', question:'perubahan pengendali', terms:'', metrics:metrics({intent:'search', terms:['pengendali']})},
  ]);
  assert.equal(skipped_agentic, 1);
  assert.deepEqual(questions.map(q => [q.id, q.question, q.terms, q.intent]),
    [['bbbbbbbb-2', 'apa katalis TOWR', ['TOWR'], 'search'], ['dddddddd-4', 'perubahan pengendali', ['pengendali'], 'search']]);
  assert.deepEqual(loadQuestions(['ringkas KI 2 oktober', {question:'x', id:'k'}]).questions.map(q => q.id), ['q1', 'k']);
  assert.throws(() => loadQuestions({}), /array/);
});

test('classify: kinds from the OpenRouter payload only', () => {
  const m = content => [{role:'system', content}, {role:'user', content:'q'}];
  assert.equal(classify({messages:m('Ubah pertanyaan riset arsip ...'), response_format:{type:'json_object'}}), 'term');
  assert.equal(classify({messages:m('Pilih {"ids":[...]}'), response_format:{type:'json_object'}}), 'select');
  assert.equal(classify({messages:m('s'), stream:true, reasoning:{max_tokens:512}}), 'answer');
  assert.equal(classify({messages:m('s'), stream:true, reasoning:{enabled:false}}), 'note');
  assert.equal(classify({messages:m('s'), reasoning:{enabled:false}}), 'note');
  assert.equal(classify({messages:m('s'), tools:[{}]}), 'step');
});

test('diffRuns matches by id and totals both arms', () => {
  const row = (id, bytes, calls = 1) => ({id, question:'q ' + id, kinds:'answer', evidence_mode:'original-text', error:null,
    n_calls:calls, input_bytes:bytes, est_tokens:estTokens(bytes), output_token_budget:6500, calls:[{kind:'answer', input_bytes:bytes, est_tokens:estTokens(bytes)}]});
  const d = diffRuns({mode:'offline', rows:[row('a', 1800), row('b', 3600, 2), row('c', 10)]}, {mode:'offline', rows:[row('b', 1800), row('a', 900)]});
  assert.equal(d.matched, 2); assert.deepEqual(d.only_a, ['c']);
  assert.deepEqual([d.totals.a.input_bytes, d.totals.b.input_bytes, d.totals.change_pct.input_bytes], [5400, 2700, -50]);
  assert.equal(d.questions.find(q => q.id === 'a').change_pct, -50);
  assert.match(diffTable(d), /\| \*\*total\*\* \| 2 pertanyaan/);
});

test('--out inside the repo must be git-ignored', () => {
  const run = bench('--impl', '.', '--assets', assets, '--questions', 'x.json', '--out', 'tools/bench-out.json');
  assert.equal(run.status, 1); assert.match(run.stderr, /tidak di-ignore Git/);
});

test('offline and bridge smoke runs through converse()', {skip:!haveAssets && 'worker/.assets belum dibangun'}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'bench-tokens-')), questions = path.join(dir, 'q.json');
  await writeFile(questions, JSON.stringify([{id:'t1', question:'analisis homi'}, {id:'t2', question:'tes', terms:[]}, 'analisis  homi']));
  const offline = bench('--impl', root, '--assets', assets, '--questions', questions, '--out', path.join(dir, 'a.json'), '--no-store');
  assert.equal(offline.status, 0, offline.stderr);
  const a = JSON.parse(await readFile(path.join(dir, 'a.json'), 'utf8'));
  assert.equal(a.mode, 'offline'); assert.equal(a.rows.length, 2);
  for (const r of a.rows) {
    assert.ok(r.calls.length >= 1, r.question);
    assert.equal(r.input_bytes, r.calls.reduce((n, c) => n + c.input_bytes, 0));
  }
  assert.equal(a.rows[1].kinds, 'term'); assert.ok(a.rows[1].error);
  // Fake CLI: logged-in subscription, streams one cited sentence and reports usage with the cache TTL split.
  const fake = path.join(dir, 'claude');
  await writeFile(fake, `#!/usr/bin/env node
const args=process.argv.slice(2);
if(args[0]==='auth'){process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));process.exit(0);}
process.stdin.resume();process.stdin.on('end',()=>{const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');
  const usage={input_tokens:5,cache_read_input_tokens:7,cache_creation_input_tokens:3,output_tokens:4,cache_creation:{ephemeral_1h_input_tokens:3,ephemeral_5m_input_tokens:0}};
  if(args.includes('--json-schema'))return out({type:'result',is_error:false,result:'{"intent":"search","terms":[]}',structured_output:{intent:'search',terms:[]},usage});
  out({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Bukti [D1].'}}});
  out({type:'result',is_error:false,result:'Bukti [D1].',usage,total_cost_usd:0.01});});
`);
  await chmod(fake, 0o755);
  const live = bench('--bridge', '--bin', fake, '--impl', root, '--assets', assets, '--questions', questions, '--only', 't1', '--out', path.join(dir, 'b.json'), '--no-store');
  assert.equal(live.status, 0, live.stderr);
  const b = JSON.parse(await readFile(path.join(dir, 'b.json'), 'utf8')), call = b.rows[0].calls[0];
  assert.equal(b.mode, 'bridge'); assert.equal(b.rows.length, 1);
  assert.deepEqual([call.prompt_tokens, call.cached_tokens, call.cache_write_tokens, call.completion_tokens], [15, 7, 3, 4]);
  assert.ok(call.usage_raw); assert.equal(b.totals.estimated_cost_usd, 0.01 * b.rows[0].calls.length);
  const diff = bench('--diff', path.join(dir, 'a.json'), path.join(dir, 'b.json'), '--out', path.join(dir, 'd.json'));
  assert.equal(diff.status, 0, diff.stderr); assert.match(diff.stdout, /prompt tok/);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'd.json'), 'utf8')).matched, 1);
});
