import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dateQuery, requestScope, requestedDates, scopeDocuments, documentRequest} from '../worker/retrieval.mjs';
import {converse, CacheStore} from '../worker/core.mjs';
import {stockbitBudget, stockbitHandles, PENILAIAN_LABEL} from '../worker/stockbit.mjs';

const doc = (name, cat, start, end = start, extra = {}) => ({name, cat, start, end, title:name, label:end, path:`files/${cat}/${start}/${name}`, ...extra});
const sb = d => doc(`sbringkas_${d}_${d}.md`, 'stockbit-ringkasan', d);
const detail = d => doc(`sbdetail_${d}_${d}.md`, 'stockbit-detail', d, d, {priority:'low'});
const names = docs => docs?.map(d => d.name).sort();
const index = {docs:[
  doc('stockbit_05102026.md', 'stockbit', '2026-10-05'),
  doc('stockbit_28092026.md', 'stockbit', '2026-09-28', '2026-09-28', {covers:['2026-09-26','2026-09-28']}),
  sb('2026-10-05'), detail('2026-10-05'), sb('2026-10-06'),
  doc('ki_05102026.md', 'keterbukaan-informasi', '2026-10-05'),
]};
const documents = (q, archive = index, today) => {
  const scope = dateQuery(q, [], [2026]);
  return documentRequest(q, scope, archive, requestScope(q, archive, scope.date?.slice(0,4), today));
};

test('plain "stockbit" reads the daily summary; raw only on request; detail only when asked', () => {
  assert.deepEqual(names(documents('ringkas stockbit 5 Oktober')), ['sbringkas_2026-10-05_2026-10-05.md']);
  assert.deepEqual(names(documents('stockbit mentah 5 Oktober')), ['stockbit_05102026.md']);
  assert.deepEqual(names(documents('baca laporan lama stockbit 5 oktober')), ['stockbit_05102026.md']);
  assert.deepEqual(names(documents('stockbit 5 oktober semua temuan')),
    ['sbdetail_2026-10-05_2026-10-05.md', 'sbringkas_2026-10-05_2026-10-05.md']);
  // "jangan hilangkan detail" asks for completeness, not for the per-ticker detail files.
  assert.deepEqual(names(documents('ringkas stockbit 5 oktober, jangan hilangkan detail')), ['sbringkas_2026-10-05_2026-10-05.md']);
  // A date without a source never pulls in the low-priority detail file.
  assert.deepEqual(names(documents('ringkas semua dokumen tanggal 5 oktober 2026')),
    ['ki_05102026.md', 'sbringkas_2026-10-05_2026-10-05.md']);
  // Days without a summary keep their raw report, so September stays answerable.
  assert.deepEqual(names(documents('stockbit 27 september')), ['stockbit_28092026.md']);
  // Newest snapshot: the newest summary, not the older raw report.
  assert.deepEqual(names(documents('baca stockbit terbaru')), ['sbringkas_2026-10-06_2026-10-06.md']);
  assert.deepEqual(names(documents('keterbukaan terbaru sama stockbit terbaru')),
    ['ki_05102026.md', 'sbringkas_2026-10-06_2026-10-06.md']);
});

test('ticker searches read summaries and detail, never a raw report whose day is summarized', () => {
  const hits = index.docs.filter(d => d.cat !== 'keterbukaan-informasi');
  const request = {...requestScope('FORU', index), stockbitDetail:true};
  assert.deepEqual(names(scopeDocuments(hits, request)), ['sbdetail_2026-10-05_2026-10-05.md',
    'sbringkas_2026-10-05_2026-10-05.md', 'sbringkas_2026-10-06_2026-10-06.md', 'stockbit_28092026.md']);
  // A topic search without a ticker or "detail" skips the per-ticker detail file.
  assert.ok(!scopeDocuments(hits, requestScope('rights issue', index)).some(d => d.cat === 'stockbit-detail'));
});

test('weekly recaps replace daily summaries for ranges of more than two days', () => {
  const days = Array.from({length:9}, (_, i) => `2026-10-${String(5 + i).padStart(2,'0')}`);
  const archive = {docs:[...days.map(sb), doc('sbpekan_2026-10-05_2026-10-11.md', 'stockbit-pekan', '2026-10-05', '2026-10-11')]};
  assert.deepEqual(names(documents('ringkas stockbit 5 sampai 13 oktober 2026', archive)),
    ['sbpekan_2026-10-05_2026-10-11.md', 'sbringkas_2026-10-12_2026-10-12.md', 'sbringkas_2026-10-13_2026-10-13.md']);
  assert.deepEqual(names(documents('ringkas stockbit 6 oktober', archive)), ['sbringkas_2026-10-06_2026-10-06.md']);
  assert.deepEqual(names(documents('ringkas stockbit 6 dan 7 oktober', archive)),
    ['sbringkas_2026-10-06_2026-10-06.md', 'sbringkas_2026-10-07_2026-10-07.md']);
  // Only two of the recap's days were asked for: read those days, not the whole week.
  assert.deepEqual(names(documents('ringkas stockbit 10 sampai 13 oktober 2026', archive)),
    days.slice(5).map(d => `sbringkas_${d}_${d}.md`));
  assert.deepEqual(names(documents('ringkas stockbit minggu lalu', archive, '2026-10-14')), ['sbpekan_2026-10-05_2026-10-11.md']);
  assert.deepEqual(names(documents('stockbit terbaru', archive)), ['sbringkas_2026-10-13_2026-10-13.md']);
});

test('week words and bare month names become explicit ranges', () => {
  assert.deepEqual(requestedDates('stockbit minggu ini', '2026', '2026-10-07'), [{from:'2026-10-05', to:'2026-10-11'}]);
  assert.deepEqual(requestedDates('stockbit pekan lalu', '2026', '2026-10-05'), [{from:'2026-09-28', to:'2026-10-04'}]);
  assert.deepEqual(requestedDates('ringkas stockbit oktober', '2026'), [{from:'2026-10-01', to:'2026-10-31'}]);
  assert.deepEqual(requestedDates('stockbit Februari 2027'), [{from:'2027-02-01', to:'2027-02-28'}]);
  assert.deepEqual(requestedDates('stockbit 5 oktober', '2026'), [{from:'2026-10-05', to:'2026-10-05'}]);
  assert.deepEqual(requestedDates('stockbit oktober 5', '2026'), [{from:'2026-10-05', to:'2026-10-05'}]);
  assert.deepEqual(requestedDates('stockbit 30 september sampai 2 oktober', '2026'), [{from:'2026-09-30', to:'2026-10-02'}]);
  assert.deepEqual(requestedDates('may I ask about FORU', '2026'), []);
  assert.deepEqual(requestedDates('stockbit oktober'), []); // no year known: never guessed
});

test('bare month names widen only Stockbit questions', () => {
  assert.deepEqual(requestedDates('keterbukaan BBCA april', '2026'), []);
  assert.deepEqual(requestedDates('ringkasan bulan september', '2026'), []);
  assert.deepEqual(requestedDates('oktober', '2026'), []);
  assert.deepEqual(requestScope('ringkasan bulan september', index).dates, []);
});

test('"posting asli" is not a raw-report request; raw requests fall back to summaries', () => {
  const q = 'stockbit BBCA 5 oktober, sertakan link posting asli';
  assert.equal(requestScope(q, index).stockbitRaw, undefined);
  assert.deepEqual(names(documents('ringkas stockbit 5 oktober, sertakan link posting asli')), ['sbringkas_2026-10-05_2026-10-05.md']);
  // Raw report not indexed for a summarized day: the summary answers instead of nothing.
  const summarizedOnly = {docs:[sb('2026-10-05'), detail('2026-10-05')]};
  const request = requestScope('stockbit mentah 5 oktober', summarizedOnly, '2026');
  assert.equal(request.stockbitRaw, true);
  assert.deepEqual(names(scopeDocuments(summarizedOnly.docs, request, {dates:true})), ['sbringkas_2026-10-05_2026-10-05.md']);
});

test('budget reads newest days first and lists the rest; detail only after summaries fit', () => {
  const entries = ['2026-10-03','2026-10-04','2026-10-05'].flatMap(d => [
    {doc:sb(d), bytes:30000}, {doc:detail(d), bytes:20000}]);
  const plan = stockbitBudget(entries, 90000);
  assert.deepEqual(plan.read, ['2026-10-05','2026-10-04','2026-10-03']);
  assert.deepEqual(plan.listed, []);
  assert.equal(plan.dropped.size, 3);
  assert.ok([...plan.dropped].every(d => d.cat === 'stockbit-detail'));
  const tight = stockbitBudget(entries, 50000);
  assert.deepEqual(tight.read, ['2026-10-05']);
  assert.deepEqual(tight.listed.map(l => l.day), ['2026-10-04','2026-10-03']);
  assert.deepEqual(stockbitBudget([{doc:sb('2026-10-05'), bytes:200000}], 90000).read, ['2026-10-05']);
});

test('handles are matched by @ or as known usernames only', () => {
  const table = {users:{budi_trader:[], media:[]}};
  assert.deepEqual(stockbitHandles('apa kata @Budi_Trader soal FORU', table), ['budi_trader']);
  assert.deepEqual(stockbitHandles('apa kata budi_trader', table), []);
  assert.deepEqual(stockbitHandles('apa kata budi_trader', table, new Set(['budi_trader'])), ['budi_trader']);
  assert.deepEqual(stockbitHandles('media sosial', table), []);
});

// ---- converse with a synthetic 120-day FORU archive -------------------------------------
function fixture() {
  const db = new DatabaseSync(':memory:');
  const sql = {exec(q, ...args) { const s = db.prepare(q), rows = s.columns().length ? s.all(...args) : (s.run(...args), []); return {toArray:() => rows}; }};
  const start = Date.parse('2026-10-01T00:00:00Z');
  const days = Array.from({length:120}, (_, i) => new Date(start + i * 86400000).toISOString().slice(0,10));
  const docs = [], bodies = new Map(), table = {days:{}, tickers:{FORU:[]}, users:{budi_trader:[]}, user_notes:{}};
  const add = (d, body) => { d.source_id = 'D' + (docs.length + 1); d.document_id = 'id-' + d.name; d.document_hash = 'h-' + d.name;
    d.asset = d.source_id + '.json'; d.evidence_asset = d.source_id + '.evidence.json'; d.covers = [d.start, d.end];
    d.sizes = [body.length + 100]; docs.push(d); bodies.set(d.source_id, body); };
  for (const [i, day] of days.entries()) {
    const line = `FORU · ${day} · ${10 + i % 7} posting / ${4 + i % 3} akun · bahan: 2 rumor · inti (diskusi pengguna, belum diverifikasi): rencana rights issue.`;
    add(sb(day), `# Ringkasan Stockbit Ideas · ${day}\n\nCakupan: final\n\n## FORU\n\n${line}\n${'- klaim pengguna tentang FORU, angka dan tautan [pos](https://stockbit.com/post/1).\n'.repeat(28)}`);
    add(detail(day), `# Detail Stockbit · ${day}\n\n## FORU\n\n${'- temuan FORU lengkap dengan atribusi akun.\n'.repeat(40)}`);
    table.days[day] = {file:`sbringkas_${day}_${day}.md`, n:11000, findings:900, k:130};
    table.tickers.FORU.push([day, `sbringkas_${day}_${day}.md`, 10 + i % 7, 4 + i % 3, 2, 'rencana rights issue']);
  }
  table.users.budi_trader.push(['2026-10-05', 'sbringkas_2026-10-05_2026-10-05.md', 4, ['FORU'], ['F12','F13']]);
  table.user_notes.budi_trader = {penilaian:{text:'Argumen memakai angka tanpa sumber.', finding_ids:['F12']}};
  // Raw report for a summarized day (as if build-time exclusion had not run): never read for FORU.
  add(doc('stockbit_05102026.md', 'stockbit', '2026-10-05'), '# Stockbit 5 Oktober\n\n## FORU\n\nFORU rumor mentah.\n');
  const index = {docs, tickers:['FORU'], commonWords:[], handles:['budi_trader'], postings:{}, system:'Gunakan bukti.',
    version:'v1', retrieval_version:'evidence-v1', asset_hashes:{'events.json':'e1','stockbit.json':'s1'},
    stockbit:{asset:'stockbit.json'}};
  const evidence = d => {
    const body = bodies.get(d.source_id), at = body.indexOf('## FORU');
    const records = [{section_id:'head', line:1, kind:'context', context:'', content:body.slice(0, at), tickers:[], event_date:null}];
    if (at >= 0) records.push({section_id:'foru', line:5, kind:'issuer_section', context:'FORU', content:body.slice(at), tickers:['FORU'], event_date:null});
    return {version:index.retrieval_version, document_hash:d.document_hash, coverage:'full-source-partition', records};
  };
  const reads = [];
  const archive = {manifest:async () => index, events:async () => ({names:{}, types:[], events:[]}), stockbit:async () => table,
    search:async terms => docs.filter(d => terms.some(t => bodies.get(d.source_id).toLowerCase().includes(t.toLowerCase())))
      .sort((a, b) => b.end.localeCompare(a.end)),
    read:async asset => { const d = docs.find(x => x.asset === asset || x.evidence_asset === asset); reads.push(d.name);
      return asset === d.asset ? {parts:[{source_id:d.source_id, part:1, text:bodies.get(d.source_id)}]} : evidence(d); }};
  return {db, cache:new CacheStore(sql), archive, reads, days};
}
function model() {
  const m = {messages:[], complete:async (messages, options) => options?.jsonMode ? JSON.stringify({terms:[]}) : 'Catatan [D1].',
    answer:async messages => { m.messages.push(messages); return 'Ringkasan FORU dari bahan [D1].'; }};
  return m;
}

test('FORU over 120 days stays within the byte budget, skips raw, and lists unread days', async () => {
  const f = fixture(), m = model(), stats = {};
  try {
    const result = await converse(f.archive, m, 'FORU', [], () => {}, null, {cache:f.cache, metrics:stats});
    assert.ok(stats.selected_source_bytes <= 100000, 'selected ' + stats.selected_source_bytes);
    assert.ok(stats.stockbit_days_read >= 10 && stats.stockbit_days_read < 120);
    assert.equal(stats.stockbit_days_read + stats.stockbit_days_listed, 120);
    assert.equal(stats.evidence_mode, 'original-text');
    assert.ok(!f.reads.includes('stockbit_05102026.md'), 'raw report of a summarized day is not read');
    const material = m.messages[0][1].content;
    assert.match(material, new RegExp(`INDEKS STOCKBIT, ${stats.stockbit_days_listed} hari lain`));
    assert.match(material, /ringkasan diskusi Stockbit \(bukan keterbukaan resmi\)/);
    assert.match(result.answer, new RegExp(`\\*\\*${stats.stockbit_days_listed} hari lain \\(tidak dibaca utuh\\)\\*\\*`));
    assert.match(result.answer, /- 2026-10-01 · FORU 10 posting \/ 4 akun · 2 temuan · inti \(diskusi pengguna, belum diverifikasi\): rencana rights issue \[D\d+\]/);
    // Newest summaries fill the budget first (detail sections only when room is left); the oldest day is only listed.
    const read = new Set(m.messages[0][1].content.match(/"title":"[^"]+"/g));
    assert.ok(read.has(`"title":"sbringkas_${f.days.at(-1)}_${f.days.at(-1)}.md"`));
    assert.ok(![...read].some(t => t.includes('sbdetail_')));
    assert.ok(!read.has(`"title":"sbringkas_${f.days[0]}_${f.days[0]}.md"`));
    // Listed days stay linkable sources.
    assert.ok(result.sources.some(s => s.title === `sbringkas_${f.days[0]}_${f.days[0]}.md`));
  } finally { f.db.close(); }
});

test('an @handle gets a code-built factual block and its labelled automatic assessment', async () => {
  const f = fixture(), m = model(), stats = {};
  try {
    const result = await converse(f.archive, m, 'apa kata @budi_trader minggu ini', [], () => {}, null, {cache:f.cache, metrics:stats});
    assert.deepEqual(stats.stockbit_handles, ['budi_trader']);
    const material = m.messages[0][1].content;
    assert.match(material, /DATA STOCKBIT @budi_trader/);
    assert.match(material, /1 hari aktif \(2026-10-05 s\.d\. 2026-10-05\), 4 posting, 2 temuan publik/);
    assert.ok(material.includes(PENILAIAN_LABEL + ': Argumen memakai angka tanpa sumber. (temuan F12)'));
    assert.ok(result.answer.includes('**' + PENILAIAN_LABEL + '**'));
    assert.ok(result.sources.some(s => s.title === 'sbringkas_2026-10-05_2026-10-05.md'));
  } finally { f.db.close(); }
});
