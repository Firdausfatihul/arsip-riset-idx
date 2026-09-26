import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {Archive, OpenRouter, converse, directTickers, nearestWord, rememberTurn} from '../worker/core.mjs';
import {dateQuery, documentRequest} from '../worker/retrieval.mjs';
import {SourceStore} from '../worker/source-store.mjs';

const read = name => readFile(new URL('../worker/.assets/' + name, import.meta.url), 'utf8').then(JSON.parse);
const manifest = await read('manifest.json');

test('word-like tickers need capitals or a cue; real codes in any case still work', () => {
  const t = q => directTickers(q, manifest);
  assert.deepEqual(t('analisakan dokumen NASI dan alasan kenapa sahamnya naik banyak'), ['NASI']);
  assert.deepEqual(t('Ringkas perkembangan Far East Gold (FEG) dan Xingye'), []);
  assert.deepEqual(t('Analisa buka dan semua dokumen yang tersedia'), ['BUKA']);
  assert.deepEqual(t('ship'), ['SHIP']);
  assert.deepEqual(t('analisis soci'), ['SOCI']);
  assert.deepEqual(t('analisa GTSI dan LEAD. coba bandingkan'), ['GTSI', 'LEAD']);
});

test('ticker search is case-sensitive in SQLite and in the asset fallback', async () => {
  const db = new DatabaseSync(':memory:');
  const sql = {exec(q, ...a) { const s = db.prepare(q), rows = s.columns().length ? s.all(...a) : (s.run(...a), []); return {toArray:() => rows}; }};
  const store = new SourceStore({storage:{sql, transactionSync:fn => fn()}});
  for (const doc of manifest.docs) await store.importDocument(manifest, doc, await read(doc.evidence_asset));
  const assets = {fetch:async r => new Response(await readFile(new URL('../worker/.assets' + new URL(r.url).pathname, import.meta.url)))};
  for (const archive of [new Archive(assets, store), new Archive(assets)]) {
    const docs = await archive.search(['NAIK']);
    for (const doc of docs) assert.match((await archive.read(doc.asset)).search, /(?<![\p{L}\p{N}_])NAIK(?![\p{L}\p{N}_])/u);
    assert.ok(docs.length < 10, 'lowercase "naik" must not match the ticker: ' + docs.length);
  }
  db.close();
});

test('whole-document requests resolve by category and date, including a missing year', () => {
  const years = [...new Set(manifest.docs.map(d => +d.end.slice(0, 4)))];
  const scope = dateQuery('summary dokumen keterbukaan informasi tanggal 22 september', [], years);
  assert.equal(scope.date, '2026-09-22');
  // KI 24 September covers 22–24 September (its opening states the period), so it matches too.
  const names = documentRequest('summary dokumen keterbukaan informasi tanggal 22 september', scope, manifest).map(d => d.name);
  assert.ok(names.includes('ki_22092026.md') && names.every(n => n.startsWith('ki_')), names.join());
  assert.equal(documentRequest('SOCI tanggal 17 September 2026', dateQuery('SOCI tanggal 17 September 2026'), manifest), null);
  assert.ok(dateQuery('SOCI tanggal 17', [], years).clarification, 'day without month still asks');
});

test('each date in a request is paired with the source named in its own clause', () => {
  const years = [...new Set(manifest.docs.map(d => +d.end.slice(0, 4)))];
  const q = 'coba baca arsip 25 september di stream stockbit dan 26 september di keterbukaan indonesia, apa yg plg hidden gems';
  const names = documentRequest(q, dateQuery(q, [], years), manifest).map(d => d.name).sort();
  assert.deepEqual(names, ['ki_26092026.md', 'stockbit_25092026.md']);
});

test('document requests: every date, range, numeric date, pasted title and per-source "terbaru"', () => {
  const years = [...new Set(manifest.docs.map(d => +d.end.slice(0, 4)))];
  // Real questions from the log plus phrasings written afterwards; [] = not a document request.
  const cases = {
    'coba baca arsip 25-26 september di stream stockbit dan keterbukaan indonesia, apa yg plg hidden gems': ['stockbit_25092026.md', 'ki_26092026.md'],
    'Simpulkan 21 september 2026': ['stockbit_22092026.md'],
    'Simpulkan tanggal 23 september 2026 dari stockbit summary dan bei keterbukaan informasi': ['ki_24092026.md', 'stockbit_24092026.md'],
    'simpulkan postingan stockbit dari 23-24 sept': ['stockbit_24092026.md'],
    'Stockbit — 20–22 September 2026 jelaskan kesimpulan': ['stockbit_22092026.md'],
    'ada loh itu disini Keterbukaan Informasi · 22 September 2026': ['ki_22092026.md'],
    'stockbit 22 dan 25 september ada apa aja': ['stockbit_22092026.md', 'stockbit_25092026.md'],
    'bandingkan ki 18 september dengan ki 19 september': ['ki_18092026.md', 'ki_19092026.md'],
    'keterbukaan terbaru sama stockbit terbaru, mana yang paling menarik': ['ki_26092026.md', 'stockbit_25092026.md'],
    'KI 26/9 ada corporate action apa': ['ki_26092026.md'],
    'stockbit 24/9 sama KI 24/9 bandingin': ['stockbit_24092026.md', 'ki_24092026.md'],
    'apa yang dibahas di stockbit 20 sampai 22 september': ['stockbit_22092026.md'],
    'ringkas semua dokumen tanggal 22 september': ['ki_22092026.md', 'ki_24092026.md', 'stockbit_22092026.md'],
    'rights issue september siapa aja': [], 'ada berita apa soal emiten nikel minggu ini': [],
    'siapa yang beli saham di pasar nego tanggal 22 september 2026': [],
  };
  for (const [q, need] of Object.entries(cases)) {
    const names = (documentRequest(q, dateQuery(q, [], years), manifest) || []).map(d => d.name);
    if (need.length) assert.ok(need.every(n => names.includes(n)), q + ' -> ' + names.join());
    else assert.deepEqual(names, [], q);
  }
});

test('misspelled names reach the archive spelling; unknown names are not forced onto another word', () => {
  assert.equal(nearestWord('Zeinfahrozi', manifest), 'zeinihzafahrozi');   // letters dropped from a username
  assert.equal(nearestWord('Zein Fahrozi', manifest), 'zeinihzafahrozi');
  assert.equal(nearestWord('Mirzall', manifest), 'mirzal');                 // one extra letter
  for (const unknown of ['Budiman', 'kurniawanto', 'budisantoso']) assert.equal(nearestWord(unknown, manifest), null, unknown);
  assert.equal(nearestWord('Tanoko', manifest), null, 'an existing word is not corrected');
  // Usernames are searched as written; words the archive mostly uses as words are not usernames.
  for (const h of ['primestockid', 'athira', 'zeinihzafahrozi']) assert.ok(manifest.handles.includes(h), h);
  for (const w of ['media', 'stockbit']) assert.ok(!manifest.handles.includes(w), w);
});

test('a username in the question is searched even when the model returns no terms', async () => {
  const assets = {fetch:async r => new Response(await readFile(new URL('../worker/.assets' + new URL(r.url).pathname, import.meta.url)))};
  const model = {complete:async () => '{"terms":[]}',
    answer:async (m, emit) => { await emit({type:'delta', text:'Ringkasan.'}); return 'Ringkasan.'; }};
  const result = await converse(new Archive(assets), model, 'user zeinfahrozi suka ngomgin apa sih? sp nya apa aja, singkat padat, jelas', [], async () => {});
  assert.deepEqual(result.terms, ['zeinihzafahrozi']);
  assert.ok(result.documents > 0);
});

test('an answer cut at the length limit is kept and marked incomplete, not discarded', async () => {
  const model = new OpenRouter('test', null, async () => new Response([
    {choices:[{delta:{content:'Sebagian jawaban [D1].'}}]}, {choices:[{finish_reason:'length'}]}
  ].map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('')));
  assert.equal(await model.answer([], () => {}), 'Sebagian jawaban [D1].');
  assert.equal(model.truncated, true);
});

test('invalid citations become a notice; follow-up terms are reused from the stored turn', async () => {
  const doc = manifest.docs.find(d => d.name === 'ki_22092026.md');
  const archive = {manifest:async () => manifest, search:async () => [doc], read:name => read(name)};
  const asked = [];
  const model = {complete:async m => { asked.push(m); return '{"terms":["salah"]}'; },
    answer:async (m, emit) => { const text = 'Ringkasan [' + doc.source_id + '] dan [D999].'; await emit({type:'delta', text}); return text; }};
  const first = await converse(archive, model, 'analisis VISI', [], () => {});
  assert.match(first.answer, /D999.*tidak termasuk sumber/s);
  const history = rememberTurn([], 'analisis VISI', first);
  const second = await converse(archive, model, 'Analisa lebih dalam gunakan lebih banyak dokumen', history, () => {});
  assert.deepEqual(second.terms, ['VISI']);
  assert.equal(asked.length, 0, 'no model call needed to re-guess the search terms');
});

test('zero-hit model terms get one retry with other wording, never repeating the failed terms', async () => {
  const assets = {fetch:async r => new Response(await readFile(new URL('../worker/.assets' + new URL(r.url).pathname, import.meta.url)))};
  const archive = new Archive(assets), prompts = [];
  const replies = ['{"terms":["transaksi nego gede"]}', '{"terms":["transaksi nego gede","pasar negosiasi","crossing"]}'];
  const model = {complete:async m => { prompts.push(m[0].content); return replies.shift(); },
    answer:async (m, emit) => { await emit({type:'delta', text:'ok'}); return 'ok'; }};
  const stats = {};
  const result = await converse(archive, model, 'apakah ada transaksi nego gede?', [], () => {}, null, {metrics:stats});
  assert.deepEqual(result.terms, ['pasar negosiasi', 'crossing']);
  assert.ok(result.documents >= 3);
  assert.match(prompts[1], /tidak ditemukan dalam arsip/);
  assert.equal(stats.term_retry.failed[0], 'transaksi nego gede');
});

test('when model terms and the retry both miss, the user\'s own distinctive words are searched', async () => {
  const assets = {fetch:async r => new Response(await readFile(new URL('../worker/.assets' + new URL(r.url).pathname, import.meta.url)))};
  const replies = ['{"terms":["Tanoto Foundation"]}', '{"terms":[]}'];
  const model = {complete:async () => replies.shift(), answer:async (m, emit) => { await emit({type:'delta', text:'ok'}); return 'ok'; }};
  const stats = {};
  // Lowercase, so the capitalised-name guard does not apply and the last-resort path is exercised.
  const result = await converse(new Archive(assets), model, 'tanoko?', [], () => {}, null, {metrics:stats});
  assert.deepEqual(result.terms, ['tanoko']);
  assert.equal(result.documents, 2);
});

const events = await read('events.json');
test('corporate-action table skips negations, routine treasury holdings and KBLI as an issuer', () => {
  // A negated list is not an event; a later affirmative clause in the same bullet still is (BAJA).
  assert.ok(!events.events.some(e => /^tidak ada aksi korporasi seperti [^.;]*$/i.test(e.text)));
  assert.ok(events.events.some(e => e.ticker === 'BAJA' && e.type === 'rights_issue'));
  assert.ok(!events.events.some(e => e.type === 'buyback' && /^Saham treasuri (tetap )?[\d.]+ lembar/.test(e.text)));
  assert.ok(!events.events.some(e => e.ticker === 'KBLI' && e.type === 'business_change'));
  assert.ok(events.events.some(e => e.ticker === 'EURO' && e.type === 'rights_issue'));
  assert.deepEqual(directTickers('emiten indonesia apa saja yang baru menambah KBLI', manifest), []);
  assert.deepEqual(directTickers('analisa saham KBLI', manifest), ['KBLI']);
});

test('screening questions are answered from the table: code writes the full list and the count', async () => {
  const assets = {fetch:async r => new Response(await readFile(new URL('../worker/.assets' + new URL(r.url).pathname, import.meta.url)))};
  let calls = 0, material = '';
  const model = {complete:async () => '{"terms":["rights issue","HMETD"]}',
    answer:async (m, emit) => { calls++; material = m[1].content; const t = 'Ringkasan: EURO rights issue 2 miliar saham.'; await emit({type:'delta', text:t}); return t; }};
  const stats = {};
  const result = await converse(new Archive(assets), model, 'siapa aja yang mau rights issue', [], () => {}, null, {metrics:stats});
  assert.equal(result.screening, true);
  assert.equal(calls, 1);
  assert.match(material, new RegExp('FAKTA TERHITUNG SISTEM: ' + stats.screening.issuers + ' emiten'));
  assert.match(result.answer, new RegExp('Daftar lengkap: ' + stats.screening.issuers + ' emiten'));
  assert.match(result.answer, /\| EURO · PT Estee Gold Feet Tbk \|/);
  assert.match(material, /EURO \(PT Estee Gold Feet Tbk\)/);
});

test('document requests get code-computed counts; numbers absent from the sources are flagged', async () => {
  const {documentFacts, unverifiedNumbers} = await import('../worker/screening.mjs');
  const doc = manifest.docs.find(d => d.name === 'ki_22092026.md');
  const facts = documentFacts(doc, (await read(doc.evidence_asset)).records, new Set(manifest.tickers));
  assert.match(facts, /25 baris tabel bertanggal 22 September, 25 emiten berbeda/);
  assert.deepEqual(unverifiedNumbers('Ada 18 emiten dan 25 emiten; Rp1,422181; 85.000.000 saham; 99,9% [D39].', facts + ' Rp1,422181 85.000.000'),
    ['18 emiten', '99,9%']);
});

test('a name the user wrote is searched even when the model "corrects" it', async () => {
  const assets = {fetch:async r => new Response(await readFile(new URL('../worker/.assets' + new URL(r.url).pathname, import.meta.url)))};
  const model = {complete:async () => '{"terms":["Tanoto","TPI"]}', answer:async (m, emit) => { await emit({type:'delta', text:'ok'}); return 'ok'; }};
  const result = await converse(new Archive(assets), model, 'Tanoko?', [], () => {}, null, {metrics:{}});
  assert.equal(result.terms[0], 'Tanoko');
  const names = result.sources.map(s => manifest.docs.find(d => d.source_id === s.source_id).name);
  assert.ok(names.includes('digest_2026-08-26_2026-08-27.md') && names.includes('digest_2026-09-07_2026-09-09.md'));
});

test('issuer names that differ from the archive are reported with the official name', async () => {
  const {wrongNames} = await import('../worker/screening.mjs');
  const names = events.names;
  assert.equal(names.BAJA, 'PT Saranacentral Bajatama Tbk');
  const found = wrongNames('**BAJA** (Barata Indonesia) dan EURO (Elnusa Tbk); PT Pelita IMC Logistik Tbk (PSSI); VICI (Akuisisi tahap penjajakan); MKNT (Pergantian Pengurus); SINI (Sinarmas Agro Resources).',
    names, events.aliases, events.plainWords);
  assert.deepEqual(found.map(n => n.code), ['BAJA', 'EURO', 'SINI']);
});

test('a renamed issuer accepts every name the archive used', async () => {
  const {wrongNames} = await import('../worker/screening.mjs');
  assert.deepEqual(wrongNames('PT APAC Inti Corpora Tbk (IPAC) dan IPAC (PT Era Graharealty Tbk)', events.names, events.aliases), []);
});
