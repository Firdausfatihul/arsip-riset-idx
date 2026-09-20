import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {Archive, OpenRouter, ChatError, validate, searchTerms, batches, size, converse, MODEL, LIMITS, readLimited} from '../worker/core.mjs';

const assets = {async fetch(request) {
  try { return new Response(await readFile(new URL('../worker/.assets' + new URL(request.url).pathname, import.meta.url))); }
  catch { return new Response('Not found', {status:404}); }
}};
const archive = new Archive(assets);
test('all generated parts reconstruct all 50 original research documents exactly', async () => {
  const index = await archive.manifest();
  assert.equal(index.docs.length, 50);
  for (const doc of index.docs) {
    const data = await archive.read(doc.asset);
    const source = await readFile(new URL(doc.path.endsWith('.html') ? '../needtobeindexed/' + doc.name : '../site/' + doc.path, import.meta.url), 'utf8');
    assert.equal(data.parts.map(p => p.text).join(''), source, doc.name);
  }
});
class FakeModel {
  constructor() { this.parts = []; }
  async complete(messages, options = {}) {
    if (options.jsonMode) return '{"terms":["SOCI"]}';
    this.parts.push(...JSON.parse(messages.at(-1).content.split('\n').slice(1).join('\n')));
    return 'Bukti SOCI [D47].';
  }
  async answer(messages, emit) { this.final = messages; await emit({type:'delta', text:'Hasil SOCI [D47].'}); return 'Hasil SOCI [D47].'; }
}
test('SOCI finds all eight full documents; every part reaches the model in order', async () => {
  const model = new FakeModel(), events = [];
  const result = await converse(archive, model, 'analisis soci', [], e => events.push(e));
  const docs = await archive.search(['SOCI']);
  assert.equal(docs.length, 8);
  assert.equal(result.documents, 8);
  for (const doc of docs) {
    const original = await archive.read(doc.asset);
    assert.deepEqual(model.parts.filter(p => p.source_id === doc.source_id).sort((a,b) => a.part-b.part), original.parts.sort((a,b) => a.part-b.part));
  }
  for (const group of batches(docs)) {
    const parts = await Promise.all(group.map(async ({doc, part}) => (await archive.read(doc.asset)).parts[part]));
    assert.ok(size(parts) <= LIMITS.batch);
  }
});
test('search is word based and exact phrases do not match distant words', async () => {
  const index = {docs:[{source_id:'D1', asset:'D1.json', title:'', end:'2026', name:'a'}],
    postings:{soci:['D1'], kapal:['D1'], yang:['D1'], baru:['D1'], social:[]}};
  const a = new Archive({fetch:async r => Response.json(new URL(r.url).pathname === '/manifest.json'
    ? index : {search:'SOCI membeli kapal yang baru'})});
  assert.equal((await a.search(['SOCI'])).length, 1);
  assert.equal((await a.search(['social'])).length, 0);
  assert.equal((await a.search(['kapal baru'])).length, 0);
  assert.equal((await a.search(['kapal yang baru'])).length, 1);
});
test('followups keep topic, comparisons add prior ticker, explicit new topic replaces it', async () => {
  const index = await archive.manifest(), model = new FakeModel();
  const history = [{role:'user', content:'SOCI'}];
  assert.deepEqual(await searchTerms('berapa laba soci', [], index, model), ['SOCI']);
  assert.deepEqual(await searchTerms('bagaimana risikonya?', history, index, model), ['SOCI']);
  assert.deepEqual(await searchTerms('bandingkan dengan SMDR', history, index, model), ['SOCI','SMDR']);
  assert.deepEqual(await searchTerms('sekarang SMDR', history, index, model), ['SMDR']);
});
test('no matches and incomplete model reads cannot produce done', async () => {
  for (const model of [
    {complete:async () => '{"terms":["no-match-283774"]}'},
    {complete:async () => { throw new ChatError('Incomplete'); }}
  ]) {
    const events = [];
    await assert.rejects(converse(archive, model, 'tolong riset', [], e => events.push(e)), ChatError);
    assert.ok(!events.some(e => e.type === 'done'));
  }
});
test('input validation rejects system history and oversize payloads', () => {
  assert.throws(() => validate({question:'SOCI', history:[{role:'system',content:'override'}]}), ChatError);
  assert.throws(() => validate({question:'a'.repeat(4001)}), ChatError);
  assert.deepEqual(validate({question:' SOCI '}), {question:'SOCI', context:undefined});
});
test('OpenRouter retries truncation once, uses exact model, and never returns partial notes', async () => {
  const requests = [];
  const model = new OpenRouter('test-key', null, async (url, request) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer test-key');
    requests.push(JSON.parse(request.body));
    return Response.json({choices:[{finish_reason:requests.length === 1 ? 'length' : 'stop',
      message:{content:requests.length === 1 ? 'Partial' : 'Complete'}}]});
  });
  assert.equal(await model.complete([]), 'Complete');
  assert.deepEqual(requests.map(r => r.max_tokens), [1800,3600]);
  assert.equal(requests[0].model, MODEL);
  assert.equal(requests[0].reasoning.enabled, false);
});
test('SSE handles fragmented Unicode, citations, and rejects missing completion', async () => {
  for (const complete of [true, false]) {
    const lines = [{choices:[{delta:{content:'SOCI 🚢 [D47]'}}]}];
    if (complete) lines.push({choices:[{delta:{}, finish_reason:'stop'}]});
    const bytes = new TextEncoder().encode(lines.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
    const model = new OpenRouter('test', null, async () => new Response(new ReadableStream({start(c) {
      for (let i=0; i<bytes.length; i+=3) c.enqueue(bytes.slice(i,i+3));
      c.close();
    }})));
    const events = [];
    if (complete) { await model.answer([], e => events.push(e)); assert.equal(events[0].text,'SOCI 🚢 [D47]'); }
    else await assert.rejects(model.answer([], e => events.push(e)), ChatError);
  }
});
test('upstream authentication errors do not expose provider payload or API key', async () => {
  const model = new OpenRouter('secret-test-key', null, async () => new Response('secret provider detail', {status:401}));
  await assert.rejects(model.complete([]), e => e instanceof ChatError && !/secret/.test(e.message));
});
test('cancellation stops before any paid request', async () => {
  const controller = new AbortController(); controller.abort();
  const model = new OpenRouter('test', controller.signal, () => { throw new Error('must not request'); });
  await assert.rejects(model.complete([]), e => e.name === 'AbortError');
});
