import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {CacheStore, MODEL, hash} from '../worker/core.mjs';
import {AGENT, DATACAT_CACHE_VERSION, WEB_CACHE_VERSION, agentic, agenticKey, datacatRequest, fetchDatacat, requestIdentity, searchText} from '../worker/agent.mjs';
import {dataVersion, loadSignals} from '../worker/signals.mjs';

globalThis.fetch = () => { throw new Error('Network forbidden in optimization tests'); };
const pause = ms => new Promise(done => setTimeout(done, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };
function cache() {
  const db = new DatabaseSync(':memory:');
  const sql = {exec(q, ...args) { const stmt = db.prepare(q), rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return {toArray:() => rows, one:() => rows[0]}; }};
  return {db, cache:new CacheStore(sql)};
}
const index = {version:'optimization-docs', data_version:'optimization-data', docs:[], tickers:['BBCA'], postings:{}, handles:[], commonWords:[]};
const archive = {manifest:async () => index, search:async () => [], events:async () => ({}), read:async () => { throw Error('Unexpected asset'); }};
const fixture = {count:1, next:null, results:[{id:1, judul:'UNIQUE_EVIDENCE', date:'2026-03-12', html_url:'https://quant.renr.ai/announcement/20260312100000-1/'}]};
const tool = (id, args) => ({id, type:'function', function:{name:'datacat_daftar', arguments:JSON.stringify(args)}});
function model(counter, {gate, started, signal, text = 'Temuan yang sama [K1].'} = {}) {
  let round = 0;
  return {step:async () => {
    counter.steps++; signal?.throwIfAborted();
    if (++round === 1) { started?.resolve(); if (gate) await gate.promise; signal?.throwIfAborted();
      return {message:{tool_calls:[tool('read', {jenis:'rups', ticker:'BBCA'})]}}; }
    return {message:{content:'SIAP'}};
  }, answer:async (messages, emit) => { signal?.throwIfAborted(); counter.answers++; await emit({type:'delta', text}); return text; }};
}
const base = {archive, question:'RUPS tahunan BBCA', today:'2026-09-29', env:{DATACAT_API_KEY:'TEST'}, emit:async () => {},
  fetcher:async () => Response.json(fixture)};

test('agent keys preserve ticker case, effective date, model, source fingerprint and conversational identity', async () => {
  const key = (q, options = {}, history = [], client = 'a') => agenticKey(q, history, client, 'docs', {date:'2026-09-29', data:'data-a', ...options});
  assert.notEqual(await key('apa yang NAIK'), await key('apa yang naik'));
  assert.notEqual(await key('hari ini'), await key('hari ini', {date:'2026-09-30'}));
  assert.notEqual(await key('BBCA'), await key('BBCA', {data:'data-b'}));
  assert.notEqual(await key('BBCA'), await key('BBCA', {model:MODEL + '-other'}));
  assert.equal(await key('  RUPS  BBCA '), await key('RUPS BBCA', {}, [], 'b'), 'first-turn public questions can share');
  const history = [{role:'user', content:'RUPS BBCA', context:{scope:'keterbukaan-informasi'}}];
  assert.notEqual(await key('lanjut', {}, history), await key('lanjut', {}, history, 'b'));
  assert.notEqual(await key('lanjut', {}, history), await key('lanjut', {}, [{...history[0], context:{scope:'stockbit'}}]));
});

test('two simultaneous identical questions compute once and both receive the same cited answer', async () => {
  const c = cache(), gate = deferred(), started = deferred(), count = {steps:0, answers:0};
  let quota = 0, http = 0;
  const one = [], two = [], s1 = {}, s2 = {};
  const options = {...base, cache:c.cache, reserveQuota:() => { quota++; }, fetcher:async () => { http++; return Response.json(fixture); }};
  const first = agentic({...options, model:model(count, {gate, started}), emit:async e => one.push(e), stats:s1});
  await started.promise;
  const second = agentic({...options, model:model(count), emit:async e => two.push(e), stats:s2});
  await pause(15); gate.resolve();
  const [a,b] = await Promise.all([first, second]);
  assert.equal(a.answer, b.answer); assert.deepEqual(a.sources, b.sources);
  assert.equal(count.steps, 2); assert.equal(count.answers, 1); assert.equal(http, 1); assert.equal(quota, 1);
  assert.equal(s2.answer_shared, true); assert.equal(s1.agent_version, AGENT.version);
  assert.equal(two.filter(e => e.type === 'delta').map(e => e.text).join(''), a.answer);
  c.db.close();
});

test('a failed planning attempt retains the count of tools already dispatched', async () => {
  const stats = {};
  await assert.rejects(agentic({...base, stats, model:{step:async () => { throw Error('planning failed'); }}}), /planning failed/);
  assert.equal(stats.agent_rounds,1);
  assert.deepEqual(stats.agent_calls.map(call => call.tool), ['cari_arsip']);
  assert.equal(stats.agent_tool_calls,1, 'failed attempts still report their dispatched automatic search');
});

test('an aborted waiter leaves the owner running; an aborted owner lets a live waiter retry with its own model', async () => {
  for (const who of ['waiter','owner']) {
    const c = cache(), gate = deferred(), started = deferred(), owner = new AbortController(), waiter = new AbortController();
    const count1 = {steps:0, answers:0}, count2 = {steps:0, answers:0}; let quota = 0;
    const options = {...base, cache:c.cache, reserveQuota:() => { quota++; }};
    const first = agentic({...options, signal:owner.signal, model:model(count1, {gate, started, signal:owner.signal, text:'owner [K1].'})});
    await started.promise;
    const second = agentic({...options, signal:waiter.signal, model:model(count2, {signal:waiter.signal, text:'waiter [K1].'})});
    const rejected = who === 'waiter' ? second : first;
    const check = assert.rejects(rejected, /cancelled/);
    await pause(15); (who === 'waiter' ? waiter : owner).abort(new Error('cancelled'));
    await check;
    if (who === 'waiter') { gate.resolve(); assert.match((await first).answer, /^owner/); assert.equal(count2.steps,0); assert.equal(quota,1); }
    else {
      assert.match((await second).answer, /^waiter/); assert.equal(count2.answers,1); assert.equal(quota,2);
      gate.resolve(); await pause(15);
      const cached = await agentic({...options, model:{step:async () => { throw Error('must remain cached'); }}});
      assert.match(cached.answer, /^waiter/, 'late cancelled owner cannot overwrite the surviving result');
    }
    c.db.close();
  }
});

test('canonical equivalent tools share a pending fetch and one evidence body; distinct queries and periods stay distinct', async () => {
  let round = 0, http = 0, transcript;
  const firstId = 'original_' + 'a'.repeat(120);
  const stats = {}, model = {step:async () => {
    if (++round > 1) return {message:{content:'SIAP'}};
    return {message:{tool_calls:[tool(firstId, {jenis:'rups', ticker:'BBCA'}), tool('b', {q:'BBCA', jenis:'rups'}),
      tool('c', {jenis:'rups', ticker:'BBCA', q:'dividen'}), tool('d', {jenis:'rups', ticker:'BBCA', dari:'2025-01-01'})]}};
  }, answer:async m => { transcript=m; return 'Temuan [K1].'; }};
  const result = await agentic({...base, model, stats, fetcher:async () => { http++; await pause(5); return Response.json(fixture); }});
  assert.equal(http, 3); assert.equal(stats.agent_tool_reuse, 1);
  const bodies = transcript.filter(m => m.role === 'tool' && typeof m.content === 'string');
  assert.equal(bodies.filter(m => m.content.includes('UNIQUE_EVIDENCE')).length, 3, 'different q/date evidence is retained even if this fixture text matches');
  assert.ok(bodies.find(m => m.tool_call_id === 'b').content.includes('rujukan:K1\nhasil_sama_dengan:' + firstId), 'reference retains the exact original call ID');
  assert.ok(transcript.some(m => m.role === 'assistant' && m.tool_calls?.some(c => c.id === firstId)), 'original call remains in model history');
  assert.deepEqual(result.sources.map(s => s.source_id), ['K1']);
  assert.equal(transcript.filter(m => m.role === 'tool' && [firstId,'b','c','d'].includes(m.tool_call_id)).length, 4, 'every protocol tool call receives a result');
});

test('failed tools can retry without being replaced by a reference to failed evidence', async () => {
  let round = 0, http = 0, transcript;
  const stats = {}, model = {step:async () => (++round <= 2
    ? {message:{tool_calls:[tool('attempt' + round, {jenis:'rups', ticker:'BBCA'})]}}
    : {message:{content:'SIAP'}}), answer:async m => { transcript=m; return 'Temuan [K1].'; }};
  await agentic({...base, model, stats, fetcher:async () => ++http === 1 ? new Response('', {status:503}) : Response.json(fixture)});
  assert.equal(http,2); assert.equal(stats.agent_calls.filter(c => c.tool === 'datacat_daftar').length,2);
  assert.match(transcript.find(m => m.tool_call_id === 'attempt1').content, /^KESALAHAN:/);
  const retry = transcript.find(m => m.tool_call_id === 'attempt2').content;
  assert.match(retry, /UNIQUE_EVIDENCE/); assert.ok(!retry.includes('hasil_sama_dengan:'));
});

test('per-question raw memo coalesces shared documents, keeps cache limits, and uses schema/parser versions', async () => {
  let http = 0; const saved = new Map(), writes = [];
  const c = {get:(kind,key) => saved.get(kind+key), put:(kind,key,data,ttl) => { saved.set(kind+key,data); writes.push({kind,key,ttl}); }};
  const request = datacatRequest('datacat_detail', {jenis:'dokumen', id:'1'});
  const ctx = {key:'TEST', cache:c, requests:new Map(), fetcher:async () => { http++; await pause(5); return Response.json(fixture); }};
  await Promise.all([fetchDatacat(ctx,request), fetchDatacat(ctx,request)]);
  assert.equal(http,1);
  const url = new URL(requestIdentity(request), 'https://quant.renr.ai');
  assert.equal(writes[0].key, await hash([DATACAT_CACHE_VERSION,url.pathname+url.search]));
  assert.equal(writes[0].ttl, AGENT.dataTtl);
  const large = {...ctx, requests:new Map(), cache:{get:() => null, put:() => { throw Error('oversize persisted'); }},
    fetcher:async () => { http++; return Response.json({text:'x'.repeat(300001)}); }};
  const before = http; await fetchDatacat(large,request); await fetchDatacat(large,request); assert.equal(http,before+1);
  let missing=0;
  const absent={...ctx,cache:{get:()=>null,put:()=>{throw Error('404 persisted');}},requests:new Map(),fetcher:async()=>{missing++;return new Response('',{status:404});}};
  await fetchDatacat(absent,request); await fetchDatacat(absent,request); assert.equal(missing,2);
  const web = {...ctx, requests:new Map(), fetcher:async () => { http++; await pause(5); return new Response('<table class="t-table"><tr><a href="/document/1/">doc</a></tr></table>'); }};
  const webStart=http; await Promise.all([searchText(web,{q:'RUPS'}),searchText(web,{q:'RUPS'})]); assert.equal(http,webStart+1);
  const webWrite=writes.find(w=>w.kind==='web'); assert.equal(webWrite.key,await hash([WEB_CACHE_VERSION,'web','/explore/documents/?q=RUPS']));
  assert.equal(webWrite.ttl,AGENT.webTtl);
});

test('auxiliary content and legacy metadata changes reload signals without archive document changes', async () => {
  let revision=1, reads=0;
  const fake={read:async name=>{reads++;return name==='signals'?{asof:revision,issuers:{},parties:{}}:{issuers:{}};}};
  const m={version:'unchanged-docs',data_version:'signals-a',signals:{asset:'signals',history:'history',month:'2026-08'}};
  assert.equal((await loadSignals(fake,m)).signals.asof,1);
  revision=2; assert.equal((await loadSignals(fake,{...m,data_version:'signals-b'})).signals.asof,2);
  const legacy={version:'legacy-docs',signals:{asset:'signals',history:'history',month:'2026-08'}};
  await loadSignals(fake,legacy); revision=3;
  const next={...legacy,signals:{...legacy.signals,month:'2026-09'}};
  assert.notEqual(dataVersion(legacy),dataVersion(next)); assert.equal((await loadSignals(fake,next)).signals.asof,3);
  assert.equal(reads,8);
});
