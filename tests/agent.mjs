import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {Archive, CacheStore, validate} from '../worker/core.mjs';
import {AGENT, agentic, citations, compact, datacatRequest, fetchDatacat, prune, Refs, TOOLS} from '../worker/agent.mjs';

// No network: every datacat and model call below is simulated.
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Network forbidden in agent tests'); };
test.after(() => { globalThis.fetch = realFetch; });

const assets = {fetch:async r => new Response(await readFile(new URL('../worker/.assets' + new URL(r.url).pathname, import.meta.url)))};
function sqlite() {
  const db = new DatabaseSync(':memory:');
  return {db, sql:{exec(q, ...a) { const s = db.prepare(q), rows = s.columns().length ? s.all(...a) : (s.run(...a), []); return {toArray:() => rows, one:() => rows[0]}; }}};
}
const issuer = {account:{id:194, name:'SOCI', ticker:'SOCI', url:'https://quant.renr.ai/api/v1/issuers/SOCI/', html_url:'https://quant.renr.ai/issuer/SOCI/', name_normalized:'SOCI'},
  holdings_registry:[{holder:{id:3230, name:'PT Pilar Sukses Utama', html_url:'https://quant.renr.ai/account/3230/'}, pct:'35.10', date:'2026-08-31'}],
  linked_documents:Array.from({length:40}, (_, i) => ({id:i, doc_type:'RUPS_MINUTES', filename:'x'.repeat(900), extracted_at:'2026', html_url:'https://quant.renr.ai/document/' + i + '/'}))};

test('mode is the only new request field and accepts only "agentic"', () => {
  assert.equal(validate({question:'SOCI', mode:'agentic'}).mode, 'agentic');
  assert.equal(validate({question:'SOCI'}).mode, 'archive');
  assert.throws(() => validate({question:'SOCI', mode:'admin'}));
  assert.throws(() => validate({question:'SOCI', mode:'agentic', tools:[]}));
});

test('tool arguments are validated; paths are fixed and ids cannot escape them', () => {
  assert.deepEqual(datacatRequest('datacat_detail', {jenis:'emiten', id:'soci'}), {path:'/api/v1/issuers/SOCI/', params:{}});
  const list = datacatRequest('datacat_daftar', {jenis:'perubahan_kepemilikan', ticker:'BBCA', dari:'2024-01-01', sampai:'2024-12-31', limit:99});
  assert.equal(list.path, '/api/v1/movements/');
  assert.deepEqual(list.params, {limit:'25', sort:'-date', ticker:'BBCA', from:'2024-01-01', to:'2024-12-31'});
  for (const bad of [{jenis:'emiten', id:'SOCI/../../me'}, {jenis:'pihak', id:'1 OR 1'}, {jenis:'rups', id:'../analyses'},
    {jenis:'pengumuman', id:'x/../../api/v1/analyses'}, {jenis:'analyses_delete', id:'1'}])
    assert.throws(() => datacatRequest('datacat_detail', bad), bad.id);
  assert.throws(() => datacatRequest('datacat_daftar', {jenis:'perubahan_kepemilikan', ticker:'BBCA.JK'}));
  assert.throws(() => datacatRequest('datacat_daftar', {jenis:'rups', dari:'kemarin'}));
  assert.throws(() => datacatRequest('http_get', {url:'https://evil.example'}));
  // Write endpoints of the API are not reachable through any tool.
  assert.ok(!JSON.stringify(TOOLS).includes('bundle'));
});

test('datacat responses are pruned, capped, and links become citation ids', () => {
  const refs = new Refs(), text = compact(issuer, refs);
  assert.ok(text.length <= 6000, text.length);
  assert.ok(!text.includes('https://'), 'links never reach the model');
  assert.ok(text.includes('ref:K1') && text.includes('lagi'), text.slice(0, 300));
  assert.equal(refs.list()[0].url, 'https://quant.renr.ai/issuer/SOCI/');
  // Empty lists stay ("no holdings on record"); nulls, empty strings and API links are dropped.
  assert.deepEqual(prune({a:null, b:'', c:[], d:{url:'x'}}), {c:[]});
});

test('unsupported filters are refused instead of returning unrelated rows; ids are typed by kind', () => {
  assert.throws(() => datacatRequest('datacat_daftar', {jenis:'pemegang_saham', q:'zeinihzafahrozi'}), /q tidak didukung/);
  assert.throws(() => datacatRequest('datacat_daftar', {jenis:'transaksi'}), /memerlukan ticker/);
  assert.equal(datacatRequest('datacat_daftar', {jenis:'pengumuman', q:'rights issue'}).params.q, 'rights issue');
  const text = compact({results:[{id:5, board_role:'DIREKTUR', person:{id:12117, name:'A', html_url:'https://quant.renr.ai/account/12117/'},
    document:{id:167162, html_url:'https://quant.renr.ai/document/167162/'}}]}, new Refs());
  assert.ok(text.includes('id_baris:5') && text.includes('id_pihak:12117') && text.includes('id_dokumen:167162'), text);
});

test('grouped and ranged citations are read as separate ids', () => {
  assert.deepEqual(citations('a [K1, K2] b [D3] c [K4-K6] d [datacat_daftar]'), ['K1', 'K2', 'D3', 'K4', 'K5', 'K6']);
});

test('datacat calls use the fixed host, the server key, no redirects, and the shared cache', async () => {
  const {db, sql} = sqlite(), cache = new CacheStore(sql), seen = [];
  const fetcher = async (url, init) => { seen.push({url, init}); return Response.json(issuer); };
  const first = await fetchDatacat({key:'KEY', cache, fetcher}, datacatRequest('datacat_detail', {jenis:'emiten', id:'SOCI'}));
  const second = await fetchDatacat({key:'KEY', cache, fetcher}, datacatRequest('datacat_detail', {jenis:'emiten', id:'SOCI'}));
  assert.equal(seen.length, 1); assert.equal(first.cached, false); assert.equal(second.cached, true);
  assert.equal(new URL(seen[0].url).origin, 'https://quant.renr.ai');
  assert.equal(seen[0].init.headers.Authorization, 'Api-Key KEY'); assert.equal(seen[0].init.redirect, 'manual');
  await assert.rejects(fetchDatacat({key:'KEY', fetcher:async () => new Response(null, {status:302, headers:{Location:'https://evil.example/'}})},
    datacatRequest('datacat_cari', {q:'redirect'})), /mengalihkan/);
  db.close();
});

test('agent loop: tools run, evidence is cited, sources map to archive and datacat, quota only on a cache miss', async () => {
  const {db, sql} = sqlite(), cache = new CacheStore(sql), events = [];
  let quota = 0, steps = 0, answerInput;
  const fetcher = async () => Response.json(issuer);
  const model = {
    step:async (messages, tools) => {
      assert.equal(tools, TOOLS);
      steps++;
      if (steps === 1) return {message:{content:'', tool_calls:[
        {id:'a', type:'function', function:{name:'cari_arsip', arguments:'{"kata":["SOCI"]}'}},
        {id:'b', type:'function', function:{name:'datacat_detail', arguments:'{"jenis":"emiten","id":"SOCI"}'}},
        {id:'c', type:'function', function:{name:'datacat_detail', arguments:'{"jenis":"emiten","id":"../x"}'}}]}};
      return {message:{content:'SIAP'}};
    },
    answer:async (messages, emit) => { answerInput = messages; const text = 'Pemegang terbesar PT Pilar Sukses Utama 35,10% [K2]; diskusi [D0] dan [K99].'; await emit({type:'delta', text}); return text; }};
  const archive = new Archive(assets);
  const options = {archive, model, question:'siapa pemegang saham SOCI?', emit:async e => events.push(e), cache,
    env:{DATACAT_API_KEY:'KEY'}, reserveQuota:() => { quota++; }, fetcher, stats:{}};
  const result = await agentic(options);
  assert.equal(quota, 1); assert.equal(steps, 2);
  assert.ok(options.stats.agent_calls.some(c => c.tool === 'cari_arsip'));
  // The answer reuses the transcript (cached prefix): a rejected call stays an uncitable error, and the
  // instruction arrives as the last tool result.
  const toolMessages = answerInput.filter(m => m.role === 'tool');
  assert.ok(toolMessages.some(m => typeof m.content === 'string' && m.content.startsWith('KESALAHAN')));
  assert.ok(toolMessages.filter(m => !String(m.content).startsWith('KESALAHAN')).slice(0, -1).every(m => /^rujukan:/.test(m.content)));
  assert.match(JSON.stringify(answerInput.at(-1)), /tulis jawaban sekarang/);
  assert.ok(result.sources.some(s => s.source_id === 'K2' && s.url === 'https://quant.renr.ai/account/3230/'));
  assert.ok(!result.sources.some(s => s.source_id === 'K99'), 'uncited or unknown ids are not sources');
  const again = await agentic({...options, stats:{}});
  assert.equal(again.cache_hit, true); assert.equal(quota, 1, 'a cached answer does not use the daily quota');
  db.close();
});

test('the agent stops at the round and call limits', async () => {
  let steps = 0;
  const model = {step:async () => { steps++; return {message:{tool_calls:Array.from({length:5}, (_, i) =>
      ({id:String(steps * 10 + i), type:'function', function:{name:'datacat_cari', arguments:JSON.stringify({q:'nama ' + steps + i})}}))}}; },
    answer:async (m, emit) => { await emit({type:'delta', text:'ok'}); return 'ok'; }};
  const stats = {};
  await agentic({archive:new Archive(assets), model, question:'x', emit:async () => {}, env:{DATACAT_API_KEY:'KEY'},
    fetcher:async () => Response.json({sections:[]}), stats});
  assert.ok(steps <= AGENT.rounds); assert.ok(stats.agent_tool_calls <= AGENT.calls, stats.agent_tool_calls);
});
