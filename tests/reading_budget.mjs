import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {Archive, CacheStore, ChatError, LIMITS, OpenRouter, converse, size, validate} from '../worker/core.mjs';
import {agentic} from '../worker/agent.mjs';

const question = 'stockbit tanggal 3 oktober 2026 sampai tanggal 5 oktober 2026, ringkas semua, jangan hilangkan detail, ringkas dan urutkan dari yg plg menarik';
const archive = new Archive({fetch:async request => new Response(await readFile(
  new URL('../worker/.assets' + new URL(request.url).pathname, import.meta.url)))});
const sourceNames = ['stockbit_03102026.md', 'stockbit_05102026.md', 'stockbit_05102026_1.md'];
const currentIndex = await archive.manifest();
const sourceDocs = currentIndex.docs.filter(doc => sourceNames.includes(doc.name));
const sourceIds = sourceDocs.map(doc => doc.source_id).sort();
assert.equal(sourceIds.length, 3, 'All regression source documents must be present');
// Reproduce the three documents available when the failure was reported. New
// archive imports must not silently turn this raw-document regression into a
// different (notes) path; the current corpus has its own integration test below.
const historicalArchive = new Archive(archive.assets);
historicalArchive.index = Promise.resolve({...currentIndex,
  version:currentIndex.version + '-historical-three-documents', docs:sourceDocs});
const answer = 'Ringkasan sumber Stockbit menurut materialitas, dengan fakta dan rumor dibedakan '
  + sourceIds.map(id => '[' + id + ']').join(' ') + '.';

function cacheFixture() {
  const db = new DatabaseSync(':memory:');
  const sql = {exec(query, ...args) {
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
    return {toArray:() => rows};
  }};
  return {db, cache:new CacheStore(sql), count:kind =>
    db.prepare('SELECT COUNT(*) n FROM evidence_cache WHERE kind = ?').get(kind).n};
}

function streamResponse(content, finish, id) {
  const events = [
    {id, choices:[{delta:{content}, finish_reason:null}]},
    {id, choices:[{delta:{}, finish_reason:finish}]},
    {id, choices:[], usage:{prompt_tokens:100, completion_tokens:20, cost:0.0001}}
  ];
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n');
}

function provider({cutNotes = false, emptyFirst = false, topic = false, answerText = answer} = {}) {
  const requests = [];
  const model = new OpenRouter('OFFLINE-READING-BUDGET', null, async (_url, options) => {
    const payload = JSON.parse(options.body);
    requests.push(payload);
    assert.equal(payload.stream, true, 'Reported document request needs no classifier or agent planning call');
    if ([6500, 24000].includes(payload.max_tokens)) {
      return streamResponse(answerText, 'stop', 'final');
    }
    assert.ok(payload.max_tokens >= 1800 && payload.max_tokens <= 5000, 'Note allowance stays within its configured range');
    const first = !topic || payload.max_tokens === 1800;
    return streamResponse(first && emptyFirst ? '' : 'Bukti sumber dan batasnya [D1].',
      first && cutNotes ? 'length' : 'stop', 'note-' + requests.length);
  });
  return {model, requests};
}

async function ask(model, cache, stats = {}, events = [], selectedArchive = historicalArchive) {
  return agentic({archive:selectedArchive, model, question, cache, stats, emit:async event => events.push(event),
    env:{DATACAT_API_KEY:'OFFLINE-NOT-USED'}, today:'2026-10-05'});
}

function largeArchive() {
  const text = 'ALFA bukti. '.repeat(80000);
  const originalParts = Array.from({length:Math.ceil(text.length / 90000)}, (_, i) =>
    ({source_id:'D2', part:i + 1, text:text.slice(i * 90000, (i + 1) * 90000)}));
  const doc = {source_id:'D2', document_id:'large-fixture', document_hash:'large-hash',
    name:'stockbit_05102026.md', title:'ALFA evidence', cat:'stockbit', path:'files/stockbit/2026-10-05/stockbit_05102026.md',
    label:'5 Oktober 2026', start:'2026-10-05', end:'2026-10-05',
    asset:'large.json', evidence_asset:'large.evidence.json', sizes:originalParts.map(part => Buffer.byteLength(JSON.stringify(part)))};
  const index = {version:'large-budget', retrieval_version:'evidence-v1', docs:[doc],
    tickers:['ALFA'], commonWords:[], handles:[], postings:{}, system:'Use source evidence.'};
  return {
    manifest:async () => index, search:async () => [doc], events:async () => ({names:{}}),
    read:async asset => asset === doc.asset ? {parts:originalParts} : {
      version:index.retrieval_version, document_hash:doc.document_hash, coverage:'full-source-partition',
      records:[{section_id:'alfa-section', line:1, content:text, context:'ALFA', tickers:['ALFA'], event_date:null}]
    }
  };
}
const fallbackArchive = largeArchive();
const askFallback = (model, cache, stats = {}) => converse(fallbackArchive, model,
  'ringkas semua Stockbit tanggal 5 Oktober 2026', [], async () => {}, null, {cache, metrics:stats});

test('historical three-document agent request answers in one call with every original source character intact', async () => {
  const fixture = cacheFixture(), {model, requests} = provider(), stats = {}, events = [];
  try {
    const result = await ask(model, fixture.cache, stats, events);
    assert.equal(stats.agent_redirect, 'document_request');
    assert.equal(stats.agent_tool_calls, 0);
    assert.deepEqual(result.sources.map(source => source.source_id).sort(), sourceIds);
    assert.equal(result.documents, 3);
    assert.equal(stats.evidence_mode, 'original-text');
    assert.equal(stats.note_reads, 0);
    assert.equal(requests.length, 1);
    assert.ok(requests.every(request => request.max_tokens === 24000));
    assert.equal(model.calls, 1);
    assert.equal(model.output, 24000);
    assert.equal(stats.answer_reserved_tokens, 24000);
    assert.ok(size(requests[0].messages) > LIMITS.message, 'This regression exercises the larger document-only allowance');
    assert.ok(requests.every(request => size(request.messages) <= LIMITS.documentMessage));
    assert.ok(model.input <= LIMITS.input);
    assert.ok(model.output <= LIMITS.output);
    assert.equal(model.usage().missing_usage_calls, 0, 'Truncated streams retain their trailing usage receipts');
    assert.equal(stats.exhaustive_summary, true);
    assert.match(requests[0].messages.at(-1).content, /jangan batasi menjadi 3–5/);
    assert.equal(result.incomplete, undefined);
    assert.equal(fixture.count('notes'), 0);
    assert.equal(fixture.count('answer'), 1);
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), result.answer);
    assert.ok(result.answer.includes(answer));
    const material = requests[0].messages.find(message => message.content.startsWith('BAHAN ARSIP'));
    const context = JSON.parse(material.content.slice(material.content.indexOf('\n') + 1)
      .split('\n\nFAKTA TERHITUNG SISTEM')[0].split('\n\nNAMA EMITEN')[0]);
    assert.ok(context.every(unit => unit.raw && !unit.notes));
    for (const doc of sourceDocs) {
      const sent = context.filter(unit => unit.source_id === doc.source_id)
        .flatMap(unit => unit.raw).map(part => part.text).join('');
      const original = (await archive.read(doc.asset)).parts.map(part => part.text).join('');
      assert.equal(sent, original, doc.name);
      assert.equal(createHash('sha256').update(sent).digest('hex'), doc.document_hash, doc.name);
    }
  } finally { fixture.db.close(); }
});

test('current-corpus agent request reads every matching document and reserves the final answer within budget', async () => {
  const docs = currentIndex.docs.filter(doc => doc.cat === 'stockbit'
    && doc.start <= '2026-10-05' && doc.end >= '2026-10-03');
  assert.equal(docs.length, 4, 'Current regression corpus includes the added 3 October source');
  const ids = docs.map(doc => doc.source_id).sort();
  const fixture = cacheFixture(), stats = {}, events = [];
  const {model, requests} = provider({answerText:'Bukti seluruh sumber '
    + ids.map(id => '[' + id + ']').join(' ') + '.'});
  try {
    const result = await ask(model, fixture.cache, stats, events, archive);
    assert.equal(stats.agent_redirect, 'document_request');
    assert.equal(stats.agent_tool_calls, 0);
    assert.deepEqual(result.sources.map(source => source.source_id).sort(), ids);
    assert.equal(result.documents, docs.length);
    assert.ok(stats.selected_source_bytes > 900000, 'Current corpus exercises the document-note fallback');
    assert.equal(stats.evidence_mode, 'source-notes');
    assert.equal(stats.answer_reserved_tokens, 6500);
    assert.equal(requests.at(-1).max_tokens, 6500);
    const notes = requests.slice(0, -1);
    assert.equal(notes.length, stats.note_reads);
    assert.ok(notes.length > 0);
    assert.equal(stats.note_output_tokens, Math.min(5000, Math.floor((LIMITS.output - 6500) / notes.length)));
    assert.ok(notes.every(request => request.max_tokens === stats.note_output_tokens));
    assert.equal(model.output, notes.length * stats.note_output_tokens + 6500);
    assert.ok(model.output <= LIMITS.output);
    assert.ok(model.input <= LIMITS.input);
    assert.equal(model.calls, requests.length);
    assert.ok(model.calls <= LIMITS.calls);
    assert.ok(requests.every(request => size(request.messages) <= LIMITS.message));
    assert.equal(model.usage().missing_usage_calls, 0);
    assert.equal(result.incomplete, undefined);
    assert.equal(fixture.count('notes'), notes.length);
    assert.equal(fixture.count('answer'), 1);
    assert.equal(events.filter(event => event.type === 'delta').map(event => event.text).join(''), result.answer);

    const material = requests.at(-1).messages.find(message => message.content.startsWith('BAHAN ARSIP'));
    const context = JSON.parse(material.content.slice(material.content.indexOf('\n') + 1)
      .split('\n\nFAKTA TERHITUNG SISTEM')[0].split('\n\nNAMA EMITEN')[0]);
    for (const doc of docs) {
      const noteParts = notes.filter(request => request.messages.at(-1).content
        .includes('Sumber unit ini: ' + doc.title + ' (' + doc.label + ').'))
        .flatMap(request => JSON.parse(request.messages[1].content.slice(request.messages[1].content.indexOf('\n') + 1)));
      const rawParts = context.filter(unit => unit.source_id === doc.source_id).flatMap(unit => unit.raw || []);
      const sent = [...noteParts, ...rawParts].sort((a, b) => a.source_start - b.source_start)
        .map(part => part.text).join('');
      const original = (await archive.read(doc.asset)).parts.map(part => part.text).join('');
      assert.equal(sent, original, doc.name + ': every source character reaches the provider');
      assert.equal(createHash('sha256').update(sent).digest('hex'), doc.document_hash, doc.name);
    }
  } finally { fixture.db.close(); }
});

test('constrained document budget shares remaining tokens across every note and preserves the final answer', async () => {
  const fixture = cacheFixture(), {model, requests} = provider({cutNotes:true, answerText:'Temuan ALFA [D2].'}), stats = {};
  // Simulate allowance already consumed earlier in the same request. All five
  // notes receive 3,700 tokens after reserving 6,500 for the final answer.
  model.output = 11000;
  try {
    const result = await askFallback(model, fixture.cache, stats);
    assert.equal(stats.evidence_mode, 'source-notes');
    assert.ok(stats.selected_source_bytes > 900000);
    assert.equal(requests.filter(request => request.max_tokens === 3700).length, 5);
    assert.equal(requests.length, 6, 'Truncated document notes are not retried');
    assert.equal(requests.at(-1).max_tokens, 6500);
    assert.equal(stats.note_reads, 5);
    assert.equal(stats.note_output_tokens, 3700);
    assert.equal(stats.truncated_notes, 5);
    assert.equal(model.output, LIMITS.output);
    assert.equal(result.incomplete, true, 'Runtime must not remember this as a complete answer');
    assert.equal(stats.incomplete, true);
    assert.equal(result.documents, 1);
    assert.match(result.answer, /Sebagian catatan sumber terpotong/);
    assert.match(result.answer, /belum mencakup seluruh rincian/);
    assert.equal(fixture.count('answer'), 0);
    assert.equal(fixture.count('notes'), 0, 'Incomplete document notes cannot be reused');
    const finalMaterial = requests.at(-1).messages.find(message => message.content.startsWith('BAHAN ARSIP'));
    assert.match(finalMaterial.content, /"incomplete":true/);
  } finally { fixture.db.close(); }
});

test('topic notes retain bounded retries and reserve unread notes plus the final answer', async () => {
  const fixture = cacheFixture();
  const {model, requests} = provider({cutNotes:true, topic:true, answerText:'Temuan ALFA [D2].'}), stats = {};
  model.output = 11000;
  try {
    const result = await converse(fallbackArchive, model, 'analisis ALFA', [], async () => {}, null,
      {cache:fixture.cache, metrics:stats});
    assert.equal(stats.note_output_tokens, 1800);
    assert.equal(stats.note_reads, 5);
    assert.equal(requests.filter(request => request.max_tokens === 1800).length, 5);
    assert.equal(requests.filter(request => request.max_tokens === 3600).length, 2);
    assert.equal(requests.at(-1).max_tokens, 6500);
    assert.equal(stats.skipped_note_retries, 3);
    assert.equal(stats.truncated_notes, 3);
    assert.equal(model.output, 33700);
    assert.equal(result.incomplete, true);
    assert.equal(fixture.count('notes'), 2);
    assert.equal(fixture.count('answer'), 0);
  } finally { fixture.db.close(); }
});

test('insufficient minimum read-and-answer budget rejects before any source reading reaches the provider', async () => {
  const fixture = cacheFixture(), {model, requests} = provider();
  model.output = LIMITS.output - (5 * 1800 + 6500) + 1;
  try {
    await assert.rejects(askFallback(model, fixture.cache), error =>
      error instanceof ChatError && /Belum ada pembacaan bahan yang dikirim/.test(error.message));
    assert.equal(requests.length, 0);
    assert.equal(model.calls, 0);
    assert.equal(fixture.count('notes'), 0);
    assert.equal(fixture.count('answer'), 0);
  } finally { fixture.db.close(); }
});

test('raw document answers also reject before the provider when their reserved final allowance cannot fit', async () => {
  const fixture = cacheFixture(), {model, requests} = provider();
  model.output = LIMITS.output - 24000 + 1;
  try {
    await assert.rejects(ask(model, fixture.cache), error =>
      error instanceof ChatError && /Belum ada pembacaan bahan yang dikirim/.test(error.message));
    assert.equal(requests.length, 0);
    assert.equal(model.calls, 0);
    assert.equal(fixture.count('answer'), 0);
  } finally { fixture.db.close(); }
});

test('cached notes cost no planned reading budget and still allow a final answer at the exact remaining limit', async () => {
  const fixture = cacheFixture();
  try {
    const first = provider({answerText:'Temuan ALFA [D2].'});
    await askFallback(first.model, fixture.cache);
    assert.equal(first.requests.filter(request => request.max_tokens === 5000).length, 5);
    assert.equal(first.model.calls, 6);
    assert.equal(first.model.output, 31500);
    assert.equal(fixture.count('notes'), 5);
    fixture.db.prepare("DELETE FROM evidence_cache WHERE kind = 'answer'").run();
    const {model, requests} = provider({answerText:'Temuan ALFA [D2].'}), stats = {};
    model.output = LIMITS.output - 6500;
    const result = await askFallback(model, fixture.cache, stats);
    assert.equal(stats.answer_cache_hit, false);
    assert.equal(stats.note_reads, 0);
    assert.equal(stats.note_cache_hits, 5);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].max_tokens, 6500);
    assert.equal(model.output, LIMITS.output);
    assert.equal(result.incomplete, undefined);
    assert.equal(fixture.count('answer'), 1);
  } finally { fixture.db.close(); }
});

test('an empty truncated first read cannot bypass a denied retry or masquerade as complete evidence', async () => {
  const {model, requests} = provider({cutNotes:true, emptyFirst:true, topic:true});
  let truncated = false, retryChecks = 0;
  const value = await model.complete([{role:'user', content:'Evidence'}], {
    onActivity:async () => {},
    canRetry:tokens => { retryChecks++; assert.equal(tokens, 3600); return false; },
    onTruncated:() => { truncated = true; }
  });
  assert.equal(requests.length, 1);
  assert.equal(retryChecks, 1);
  assert.equal(truncated, true);
  assert.match(value, /belum menghasilkan catatan/);
});

test('an empty truncated retry preserves readable evidence from the first attempt', async () => {
  for (const stream of [false, true]) {
    let calls = 0, truncated = false;
    const model = new OpenRouter('OFFLINE-READING-BUDGET', null, async () => {
      const content = ++calls === 1 ? 'Bukti yang telah terbaca [D1].' : '';
      return stream ? streamResponse(content, 'length', 'note-' + calls)
        : Response.json({choices:[{message:{content}, finish_reason:'length'}]});
    });
    const value = await model.complete([{role:'user', content:'Evidence'}], {
      ...(stream ? {onActivity:async () => {}} : {}), onTruncated:() => { truncated = true; }
    });
    assert.equal(calls, 2);
    assert.equal(truncated, true);
    assert.equal(value, 'Bukti yang telah terbaca [D1].');
  }
});

test('an empty non-streamed length response also respects retry denial and marks the note incomplete', async () => {
  let calls = 0, retryChecks = 0, truncated = false;
  const model = new OpenRouter('OFFLINE-NONSTREAM-BUDGET', null, async (_url, options) => {
    calls++;
    const payload = JSON.parse(options.body);
    assert.equal(payload.stream, false);
    assert.equal(payload.max_tokens, 1800);
    return Response.json({choices:[{finish_reason:'length', message:{content:''}}],
      usage:{prompt_tokens:100, completion_tokens:20, cost:0.0001}});
  });
  const value = await model.complete([{role:'user', content:'Evidence'}], {
    canRetry:tokens => { retryChecks++; assert.equal(tokens, 3600); return false; },
    onTruncated:() => { truncated = true; }
  });
  assert.equal(calls, 1);
  assert.equal(retryChecks, 1);
  assert.equal(truncated, true);
  assert.match(value, /belum menghasilkan catatan/);
  assert.equal(model.usage().missing_usage_calls, 0);
});

test('single-pass notes mark empty and partial length responses incomplete in both transports without retrying', async () => {
  for (const streamed of [false, true]) for (const content of ['', 'Partial evidence [D1].']) {
    let calls = 0, truncated = false;
    const model = new OpenRouter('OFFLINE-SINGLE-PASS', null, async (_url, options) => {
      calls++;
      const payload = JSON.parse(options.body);
      assert.equal(payload.stream, streamed);
      assert.equal(payload.max_tokens, 5000);
      return streamed ? streamResponse(content, 'length', 'single-note') : Response.json({
        choices:[{finish_reason:'length', message:{content}}],
        usage:{prompt_tokens:100, completion_tokens:20, cost:0.0001}
      });
    });
    const value = await model.complete([{role:'user', content:'Evidence'}], {
      maxTokens:5000, retry:false, ...(streamed ? {onActivity:async () => {}} : {}),
      onTruncated:() => { truncated = true; }
    });
    assert.equal(calls, 1);
    assert.equal(truncated, true);
    if (content) assert.equal(value, content);
    else assert.match(value, /belum menghasilkan catatan/);
    assert.equal(model.usage().missing_usage_calls, 0);
  }
});

test('successful preflight does not relax per-request or cumulative provider limits', async () => {
  const {model, requests} = provider();
  model.planReading({input:100, output:1800, calls:1});
  await assert.rejects(model.request([], {maxTokens:6501}), ChatError);
  await assert.rejects(model.request([{role:'user', content:'x'.repeat(LIMITS.message)}]), ChatError);
  for (const [field, limit] of [['input', LIMITS.input], ['output', LIMITS.output], ['calls', LIMITS.calls]]) {
    model.input = 0; model.output = 0; model.calls = 0; model[field] = limit;
    await assert.rejects(model.request([{role:'user', content:'Evidence'}]), ChatError);
  }
  assert.equal(requests.length, 0);
});

test('larger message and output limits require the server document flag and retain absolute caps', async () => {
  const {model, requests} = provider();
  const messages = [{role:'user', content:'x'.repeat(500000)}];
  assert.throws(() => validate({question:'ringkas Stockbit', fullDocument:true}), ChatError);
  await assert.rejects(model.request(messages, {maxTokens:6500}), ChatError);
  await assert.rejects(model.request([], {maxTokens:24000}), ChatError);
  assert.equal(requests.length, 0);
  const result = await model.answer(messages, async () => {}, {fullDocument:true, maxTokens:24000});
  assert.equal(result, answer);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].max_tokens, 24000);
  await assert.rejects(model.request([{role:'user', content:'x'.repeat(LIMITS.documentMessage)}],
    {fullDocument:true, maxTokens:24000}), ChatError);
  await assert.rejects(model.request([], {fullDocument:true, maxTokens:24001}), ChatError);
  for (const [field, limit] of [['input', LIMITS.input], ['output', LIMITS.output], ['calls', LIMITS.calls]]) {
    model.input = 0; model.output = 0; model.calls = 0; model[field] = limit;
    await assert.rejects(model.request([{role:'user', content:'Evidence'}],
      {fullDocument:true, maxTokens:24000}), ChatError);
  }
  assert.equal(requests.length, 1, 'Denied calls never reach the provider');
});


test('document answer streams allow longer output while ordinary and absolute size limits remain bounded', async () => {
  const makeModel = (characters, padding = 0) => new OpenRouter('OFFLINE-READING-BUDGET', null, async () => {
    const frames = [];
    for (let offset = 0; offset < characters; offset += 10000) {
      frames.push({choices:[{delta:{content:'x'.repeat(Math.min(10000, characters - offset))}}]});
    }
    for (let offset = 0; offset < padding; offset += 60000) {
      frames.push({padding:'x'.repeat(Math.min(60000, padding - offset)), choices:[]});
    }
    frames.push({choices:[{delta:{}, finish_reason:'stop'}]});
    return new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join(''));
  });
  const long = await makeModel(90000, 1600000).answer([], async () => {}, {fullDocument:true, maxTokens:24000});
  assert.equal(long.length, 90000);
  await assert.rejects(makeModel(40001).answer([], async () => {}), /Keluaran AI melampaui batas ukuran/);
  await assert.rejects(makeModel(160001).answer([], async () => {}, {fullDocument:true}), /Keluaran AI melampaui batas ukuran/);
  await assert.rejects(makeModel(10, 1500000).answer([], async () => {}), /Aliran AI melampaui batas ukuran/);
  await assert.rejects(makeModel(10, 6000000).answer([], async () => {}, {fullDocument:true}), /Aliran AI melampaui batas ukuran/);
});
