// Whole-document requests: desk digest budgets, KI/detail dedupe, completeness phrases, over-cap ranges, fuzzy months.
// No network; the real desk files under needtobeindexed/ are read only (tests skip when they are absent).
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {storage} from '../local/sqlite-storage.mjs';
import {dateQuery, requestScope, requestedDates, documentRequest, fixMonths} from '../worker/retrieval.mjs';
import {deskDigest, deskSegments, deskText, digestUnits, kiHead, DIGEST_BUDGET, KI_HEAD_BUDGET} from '../worker/document-material.mjs';
import {converse, CacheStore, OpenRouter, EXHAUSTIVE} from '../worker/core.mjs';

const utf8 = s => Buffer.byteLength(s);
const doc = (name, cat, start, end = start, extra = {}) => ({name, cat, start, end, title:name, label:end, path:`files/${cat}/${start}/${name}`, ...extra});
const names = docs => docs?.map(d => d.name).sort();
const documents = (q, archive) => {
  const scope = dateQuery(q, [], [2026]);
  return documentRequest(q, scope, archive, requestScope(q, archive, scope.date?.slice(0,4)));
};
const day = i => `2026-10-${String(i).padStart(2, '0')}`;

// A synthetic Stockbit daily summary in the desk layout: head sections, ranked "## KODE" sections, then
// one-line "### KODE" sections inside "Emiten lain dengan temuan material", and appendices.
function sbringkas(d, top = 12, minor = 200) {
  // Four-character codes (as documentFacts expects), unique per day: A000… on day 1, B000… on day 2.
  const codes = Array.from({length:top + minor}, (_, i) => String.fromCharCode(64 + +d.slice(-2)) + String(i).padStart(3, '0'));
  let text = `# Ringkasan Stockbit Ideas · ${d}\n\nCakupan: 1.000/1.000 posting utama · final\n\nPeriode: ${d} 00:00–23:59 WIB\n\n`
    + `## Yang berubah\n\n- ${codes[0]}: posting naik tajam (https://www.idx.co.id/StaticData/x.pdf)\n\n## Sorotan\n\n- [Klaim penulis] sorotan hari ${d} (F20261001-0001)\n\n`
    + `## Jarang disebut tapi material\n\n- ${codes[1]} · 3 posting · klaim jarang\n\n`;
  codes.slice(0, top).forEach((c, i) => {
    text += `## ${c}\n\n${c} · ${d} · 100 posting / 50 akun · inti (diskusi pengguna, belum diverifikasi): pokok bahasan ${c} hari ${d}.\n\n`
      + Array.from({length:30}, (_, j) => `- [Klaim penulis] klaim ${j} tentang ${c} senilai Rp${i + 1}.${j}00 miliar — @akun${j} [pos](https://stockbit.com/post/${j}) (F20261001-${j})\n`).join('') + '\n';
  });
  text += '## Emiten lain dengan temuan material\n\nSatu baris per emiten.\n\n';
  for (const c of codes.slice(top)) text += `### ${c}\n\n${c} · 5 posting / 4 akun · inti: diskusi kecil ${c}.\n\n`;
  text += '## Emiten lain\n\nHanya temuan minor.\n\n## Cakupan\n\n| Ukuran | Nilai |\n|---|---|\n| Akun | 7.635 |\n';
  return {text, codes};
}
const entry = (d, text, cat = 'stockbit-ringkasan', prefix = 'sbringkas') =>
  ({doc:doc(`${prefix}_${d}_${d}.md`, cat, d), rows:[{content:text}]});

test('fuzzy month names next to a day number; abbreviations already parse', () => {
  assert.equal(fixMonths('22 Septembet - 5 Oct'), '22 september - 5 Oct');
  assert.deepEqual(requestedDates('stockbit dari tanggal 22 Septembet - 5 Oct ringkas semua', '2026', '2026-10-15'),
    [{from:'2026-09-22', to:'2026-10-05'}]);
  assert.deepEqual(requestedDates('ringkas bei oktber 5', '2026', '2026-10-15'), [{from:'2026-10-05', to:'2026-10-05'}]);
  assert.deepEqual(requestedDates('ringkas bei 3 okt sampai 5 sept', '2026', '2026-10-15'), []); // reversed range is invalid
  // Not a month: different first letters, more than one edit, or not next to a day number.
  for (const text of ['5 detail', 'sesudah 5 maret', 'tanggal 5 sampai 7 oktober', 'septembet saja']) assert.equal(fixMonths(text), text);
  // Ordinary words one edit from a short month name stay words ("market" ~ maret, "marsh" ~ march).
  for (const text of ['ringkas stockbit market 5 oktober', 'top 10 market terbaru', 'kondisi market 3 hari', '3 marsh', '5 marah', '7 augusta'])
    assert.equal(fixMonths(text), text, text);
  assert.deepEqual(dateQuery('ringkas stockbit market 5 oktober', [], [2026]).date, '2026-10-05');
  assert.equal(dateQuery('ringkas stockbit top 10 market terbaru', [], [2026]).date, null);
  assert.equal(dateQuery('analisis BBCA kondisi market 3 hari terakhir', [], [2026]).date, null);
});

test('completeness phrases set exhaustive; ranking requests do not; "semua temuan" no longer reads detail files', () => {
  for (const q of ['ringkas semua, jangan hilangkan detail', 'semua temuan stockbit 5 oktober', 'seluruh isi dokumen', 'stockbit 5 oktober selengkapnya',
    'detail lengkap', 'tanpa terkecuali', 'jangan lewatkan apapun']) assert.ok(EXHAUSTIVE.test(q), q);
  for (const q of ['ringkas semua yang penting', 'ringkas semua, urutkan dari yang paling menarik', 'semua dokumen stockbit', 'lebih detail',
    'tuliskan tanggal lengkap', 'stockbit 5 oktober lengkap dengan tanggal']) assert.ok(!EXHAUSTIVE.test(q), q);
  for (const q of ['ringkasan lengkap stockbit 5 oktober', 'jelaskan secara lengkap']) assert.ok(EXHAUSTIVE.test(q), q);
  const index = {docs:[doc('sbringkas_2026-10-05_2026-10-05.md', 'stockbit-ringkasan', day(5)), doc('sbdetail_2026-10-05_2026-10-05.md', 'stockbit-detail', day(5))]};
  assert.deepEqual(names(documents('stockbit 5 oktober semua temuan', index)), ['sbringkas_2026-10-05_2026-10-05.md']);
  assert.deepEqual(names(documents('detail stockbit 5 oktober', index)), ['sbdetail_2026-10-05_2026-10-05.md', 'sbringkas_2026-10-05_2026-10-05.md']);
});

test('a retired KI analysis is dropped only when BEI files cover every day it covers, unless the old analysis is asked for', () => {
  const index = {docs:[doc('ki_05102026.md', 'keterbukaan-informasi', day(5)), doc('ki_07102026.md', 'keterbukaan-informasi', day(7)),
    doc('ki_01102026.md', 'keterbukaan-informasi', day(1), day(7)),
    doc('beiringkas_2026-10-07_2026-10-07.md', 'bei-ringkasan', day(7)), doc('beidetail_2026-10-07_2026-10-07.md', 'bei-detail', day(7))]};
  // ki_07 covers only day 7 (dropped); the 1–7 Oct analysis also covers days 1–6 that no BEI file covers (kept).
  assert.deepEqual(names(documents('ringkas keterbukaan informasi 7 oktober', index)), ['beiringkas_2026-10-07_2026-10-07.md', 'ki_01102026.md']);
  // A KI named for the day its digest ran covers the evening before (ki_07102026: 6–7 Oct): BEI 7 Oct does not replace it.
  const real = {docs:[doc('ki_07102026.md', 'keterbukaan-informasi', day(7), day(7), {covers:[day(6), day(7)]}),
    doc('beiringkas_2026-10-07_2026-10-07.md', 'bei-ringkasan', day(7))]};
  assert.deepEqual(names(documents('ringkas keterbukaan informasi 7 oktober', real)), ['beiringkas_2026-10-07_2026-10-07.md', 'ki_07102026.md']);
  real.docs.push(doc('beiringkas_2026-10-06_2026-10-06.md', 'bei-ringkasan', day(6)));
  assert.deepEqual(names(documents('ringkas keterbukaan informasi 6 sampai 7 oktober', real)),
    ['beiringkas_2026-10-06_2026-10-06.md', 'beiringkas_2026-10-07_2026-10-07.md']);
  // Day 5 has no BEI summary: its KI analysis stays; the 1–7 Oct analysis covers uncovered days too.
  assert.deepEqual(names(documents('ringkas keterbukaan 5 sampai 7 oktober', index)),
    ['beiringkas_2026-10-07_2026-10-07.md', 'ki_01102026.md', 'ki_05102026.md']);
  for (const q of ['ringkas KI lama 7 oktober', 'analisis KI 7 oktober'])
    assert.deepEqual(names(documents(q, index)), ['beiringkas_2026-10-07_2026-10-07.md', 'ki_01102026.md', 'ki_07102026.md'], q);
});

test('ranges over the document cap: digest within 31 documents, code-built clarification beyond', () => {
  const docs = Array.from({length:12}, (_, i) => doc(`sbringkas_${day(i + 1)}_${day(i + 1)}.md`, 'stockbit-ringkasan', day(i + 1)));
  const twelve = documents('ringkas stockbit 1-12 oktober 2026', {docs});
  assert.equal(twelve.length, 12);
  assert.equal(twelve.clarification, undefined);
  const many = Array.from({length:40}, (_, i) => doc(`sbringkas_${i}.md`, 'stockbit-ringkasan', new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)));
  const wide = documents('ringkas stockbit 1 september sampai 10 oktober 2026', {docs:many});
  assert.equal(wide.length, 0);
  assert.match(wide.clarification, /40 dokumen \(Stockbit\).*Persempit rentang tanggal/);
  // Without dates an over-cap selection is still not a document request.
  assert.equal(documents('ringkas semua stockbit', {docs:many}), null);
});

test('desk digest: head sections of every day, issuer sections shared fairly, the rest listed; within budget', () => {
  const tickers = null, days = [1, 2, 3, 4, 5, 6].map(day), built = days.map(d => sbringkas(d));
  const entries = days.map((d, i) => entry(d, built[i].text));
  const fullBytes = built.reduce((n, b) => n + utf8(b.text), 0);
  assert.ok(fullBytes > 4 * DIGEST_BUDGET.normal, 'fixture larger than the budget: ' + fullBytes);
  const plan = deskDigest(entries, {budget:DIGEST_BUDGET.normal, tickers});
  const sent = [...plan.values()].reduce((n, d) => n + d.sent, 0);
  assert.ok(sent <= DIGEST_BUDGET.normal, 'sent ' + sent);
  for (const [i, e] of entries.entries()) {
    const d = plan.get(e.doc), text = d.pieces.map(p => p.text).join('');
    assert.equal(d.whole, false);
    assert.match(text, /## Yang berubah/); assert.match(text, /## Sorotan/); assert.match(text, /## Jarang disebut/);
    assert.match(text, new RegExp('## ' + built[i].codes[0]), 'every day gets its top issuer section');
    assert.ok(d.stats.full + d.stats.partial >= 3, 'issuer sections shared across days: ' + JSON.stringify(d.stats));
    assert.match(text, /DAFTAR BAGIAN YANG TIDAK DIKIRIM/);
    assert.match(d.coverage, /Dipadatkan sistem: .* dari 212 bagian emiten/);
    // Model copy: no links or finding ids; listed sections never appear as sent sections.
    assert.doesNotMatch(text, /https?:\/\/|\(F2026/);
    const listed = built[i].codes.filter(c => !d.codes.includes(c));
    assert.ok(listed.length > 100);
    assert.ok(!new RegExp('^#{2,3} ' + listed.at(-1), 'm').test(text));
  }
  // Exhaustive reads more within its own budget; compact less.
  const ex = deskDigest(entries, {budget:DIGEST_BUDGET.exhaustive, exhaustive:true, tickers});
  const compact = deskDigest(entries, {budget:DIGEST_BUDGET.compact, tickers});
  const total = p => [...p.values()].reduce((n, d) => n + d.sent, 0);
  assert.ok(total(ex) <= DIGEST_BUDGET.exhaustive && total(ex) > sent);
  assert.ok(total(compact) <= DIGEST_BUDGET.compact + 2000, 'compact ' + total(compact));
  // A cross-check reads the issuer sections the other document covers first, even minor ones that are otherwise listed.
  const minor = built[5].codes.at(-1), preferred = deskDigest(entries, {budget:DIGEST_BUDGET.normal, tickers, prefer:new Set([minor])});
  assert.ok(!plan.get(entries[5].doc).codes.includes(minor) && preferred.get(entries[5].doc).codes.includes(minor));
  // A request that fits is sent whole (model copy), without a listing or coverage note.
  const small = deskDigest([entry(day(1), sbringkas(day(1), 2, 5).text)], {budget:DIGEST_BUDGET.normal, tickers});
  const one = [...small.values()][0];
  assert.equal(one.whole, true); assert.equal(one.coverage, null);
  assert.doesNotMatch(one.pieces.map(p => p.text).join(''), /DAFTAR BAGIAN/);
});

test('detail with its same-day summary: summary contributes head only; BEI appendix replaced unless exhaustive', () => {
  const d = day(9);
  const detail = `# Detail keterbukaan BEI · ${d}\n\nCakupan: 3 pengumuman\n\n## Ikhtisar emiten\n\n- AAAA · lanjutan\n- BBBB · baru\n\n`
    + ['AAAA', 'BBBB'].map(c => `## ${c} — PT ${c} Tbk\n\nStatus: lanjutan · tahap: rencana\n\n` + `- 09:00 · Pengumuman ${c} · [pengumuman](https://www.idx.co.id/a.pdf) · 20261009090000-1/X_id-id\n`.repeat(60) + '\n').join('')
    + '## Lampiran: semua pengumuman\n\n3 pengumuman.\n\n' + '- 07:00 · CCCC · Laporan Bulanan · rutin\n'.repeat(400);
  const ringkas = `# Ringkasan keterbukaan BEI · ${d}\n\n## Sorotan\n\n- AAAA sorotan\n\n## Yang berubah dari progres sebelumnya\n\n| Emiten | Hari ini |\n|---|---|\n| AAAA | naik |\n\n`
    + `## Emiten material\n\n### AAAA — PT AAAA Tbk\n\nStatus: lanjutan\n\n## Jadwal 30 hari\n\n| Tanggal | Emiten |\n|---|---|\n| ${d} | AAAA |\n`;
  const entries = [entry(d, detail, 'bei-detail', 'beidetail'), entry(d, ringkas, 'bei-ringkasan', 'beiringkas')];
  const plan = deskDigest(entries, {budget:DIGEST_BUDGET.normal});
  const det = plan.get(entries[0].doc), rk = plan.get(entries[1].doc);
  const detText = det.pieces.map(p => p.text).join(''), rkText = rk.pieces.map(p => p.text).join('');
  assert.equal(rk.headOnly, true);
  assert.match(rkText, /## Sorotan/); assert.match(rkText, /## Yang berubah/);
  // Issuer sections come from the detail file; sections the detail file lacks (the schedule) still come from the summary.
  assert.doesNotMatch(rkText, /### AAAA/); assert.match(rkText, /## Jadwal 30 hari/);
  assert.match(rk.coverage, /bagian per emiten dibaca dari dokumen detail/i); assert.match(rk.coverage, /Jadwal 30 hari/);
  assert.match(detText, /## AAAA — PT AAAA Tbk/); assert.match(detText, /## BBBB/);
  assert.match(detText, /Lampiran tidak dikirim: 400 butir/);
  assert.doesNotMatch(detText, /CCCC · Laporan Bulanan/);
  assert.doesNotMatch(detText, /idx\.co\.id|20261009090000/);
  const ex = deskDigest(entries, {budget:DIGEST_BUDGET.exhaustive, exhaustive:true});
  assert.match(ex.get(entries[0].doc).pieces.map(p => p.text).join(''), /CCCC · Laporan Bulanan/);
  // Units keep the full original for the number check and stay out of the notes path.
  const units = digestUnits(entries[0].doc, det, detail);
  assert.equal(units[0].checked, detail); assert.ok(units.every(u => u.digest));
  assert.equal(units[0].coverage, det.coverage ?? undefined);
});

test('digest: every partial issuer section is marked; exhaustive reaches every issuer before the appendices', () => {
  const tickers = null, days = [1, 2, 3, 4].map(day), built = days.map(d => sbringkas(d, 30, 20));
  const entries = days.map((d, i) => entry(d, built[i].text));
  const plan = deskDigest(entries, {budget:DIGEST_BUDGET.normal, tickers});
  let partial = 0;
  for (const e of entries) {
    const whole = new Map(deskSegments(e.rows[0].content).map(seg => [seg.heading, deskText(seg.text)]));
    for (const p of plan.get(e.doc).pieces.filter(p => /^[A-Z]\d{3}$/.test(p.heading))) {
      if (p.text === whole.get(p.heading)) continue;
      partial++;
      assert.match(p.text, /\(… (?:\d+ baris lain: )?(?:rincian|sisa) bagian ini tidak dikirim\)\n\n$/, p.heading);
    }
  }
  assert.ok(partial > 10, 'fixture has partial sections: ' + partial);
  // 4 × 50 issuers whose leads fit the exhaustive budget: none is only listed while appendices are sent.
  const ex = deskDigest(entries, {budget:DIGEST_BUDGET.exhaustive, exhaustive:true, tickers});
  for (const d of ex.values()) assert.equal(d.stats.listed, 0, JSON.stringify(d.stats));
  assert.ok([...ex.values()].reduce((n, d) => n + d.sent, 0) <= DIGEST_BUDGET.exhaustive);
});

test('digest over many days: heads stay within the budget and the listing names what it lists', () => {
  const days = Array.from({length:18}, (_, i) => day(i + 1)), built = days.map(d => sbringkas(d, 12, 200));
  const entries = days.map((d, i) => entry(d, built[i].text));
  const plan = deskDigest(entries, {budget:DIGEST_BUDGET.compact});
  const sent = [...plan.values()].reduce((n, d) => n + d.sent, 0);
  assert.ok(sent <= DIGEST_BUDGET.compact + 18 * 40, 'sent ' + sent);
  for (const d of plan.values()) {
    const listing = d.pieces.find(p => p.heading === 'Daftar bagian tidak dikirim')?.text || '';
    // counted-only sections are said to be counted, not listed
    const counted = d.coverage.match(/(\d+) hanya dihitung/)?.[1];
    if (counted) assert.match(listing, /- dan \d+ bagian lain/);
    assert.doesNotMatch(d.coverage, new RegExp(`, ${d.stats.listed} hanya tercantum`), 'named and counted are reported apart');
  }
});

test('real desk files: six Stockbit days and a BEI detail day stay within budget with their head sections', {skip:!existsSync(new URL('../needtobeindexed/idx-signal-desk/sbringkas_2026-10-06_2026-10-06.md', import.meta.url))}, () => {
  const read = name => readFileSync(new URL('../needtobeindexed/idx-signal-desk/' + name, import.meta.url), 'utf8');
  const entries = [1, 2, 3, 4, 5, 6].map(i => entry(day(i), read(`sbringkas_${day(i)}_${day(i)}.md`)));
  const plan = deskDigest(entries, {budget:DIGEST_BUDGET.normal});
  assert.ok([...plan.values()].reduce((n, d) => n + d.sent, 0) <= DIGEST_BUDGET.normal);
  for (const d of plan.values()) {
    const text = d.pieces.map(p => p.text).join('');
    assert.match(text, /## Yang berubah/); assert.match(text, /## Sorotan/);
    // Head sections are whole (no cut marker inside them).
    assert.doesNotMatch(text.slice(text.indexOf('## Yang berubah'), text.search(/\n## (?!Yang berubah|Sorotan|Jarang)/)), /butir lain bagian ini tidak dikirim/);
    assert.ok(d.stats.full + d.stats.partial >= 4, JSON.stringify(d.stats));
  }
  // Codes that topped an earlier day give way to that day's lower-ranked sections, and a lead carries the quoted
  // disclosures: TLKM's new director (1 Oct), the BI rate (2 Oct, BBRI/BMRI) and KOTA's rights issue (5 Oct).
  const all = [...plan.values()].map(d => d.pieces.map(p => p.text).join('')).join('\n');
  for (const item of ['Nanang Hendarno', 'BI tahan suku bunga', 'Rp4,95 triliun', '65,77']) assert.ok(all.includes(item), item);
  const segs = deskSegments(read('beidetail_2026-10-12_2026-10-12.md'));
  assert.ok(segs.some(s => s.kind === 'appendix') && segs.filter(s => s.kind === 'issuer').length > 20);
});

// ---- converse with a synthetic archive -------------------------------------------------------------------------
function fixture(count = 6) {
  const {db, storage:{sql}} = storage();
  const docs = [], bodies = new Map(), tickers = new Set();
  for (let i = 1; i <= count; i++) {
    const {text, codes} = sbringkas(day(i));
    codes.forEach(c => tickers.add(c));
    const d = doc(`sbringkas_${day(i)}_${day(i)}.md`, 'stockbit-ringkasan', day(i));
    Object.assign(d, {source_id:'D' + i, document_id:'id' + i, document_hash:'h' + i, asset:`D${i}.json`, evidence_asset:`D${i}.evidence.json`, sizes:[utf8(text)]});
    docs.push(d); bodies.set(d.source_id, text);
  }
  const index = {docs, tickers:[...tickers], commonWords:[], handles:[], postings:{}, system:'Gunakan bukti.', version:'v1', retrieval_version:'evidence-v1', asset_hashes:{}};
  const evidence = d => {
    const body = bodies.get(d.source_id), records = [];
    // Records as tools/evidence_index.py partitions them: one per H2/H3 section (issuer sections tagged).
    const starts = [...body.matchAll(/^#{2,3} /gm)].map(m => m.index);
    [0, ...starts].forEach((s, k, all) => { const content = body.slice(s, all[k + 1] ?? body.length);
      if (content) records.push({section_id:'s' + k, line:1, kind:/^#{2,3} [A-Z]\d{3}/.test(content) ? 'issuer_section' : 'context', context:'', content, tickers:[], event_date:null}); });
    return {version:index.retrieval_version, document_hash:d.document_hash, coverage:'full-source-partition', records};
  };
  const archive = {manifest:async () => index, events:async () => ({names:{}, types:[], events:[]}), search:async () => [],
    read:async asset => { const d = docs.find(x => x.asset === asset || x.evidence_asset === asset);
      return asset === d.asset ? {parts:[{source_id:d.source_id, part:1, text:bodies.get(d.source_id)}]} : evidence(d); }};
  return {db, cache:new CacheStore(sql), archive};
}
function model() {
  const m = {answers:[], calls:0, complete:async () => { m.calls++; return JSON.stringify({terms:[]}); },
    answer:async (messages, emit, options) => { m.answers.push({messages, options}); return 'Ringkasan [D1].'; }};
  return m;
}

test('converse: a six-day range is one answer call over the digest; counts come from the full documents', async () => {
  const f = fixture(), m = model(), stats = {};
  try {
    const result = await converse(f.archive, m, 'stockbit dari tanggal 1-6 oktober 2026 ringkas semua yang penting', [], () => {}, null, {cache:f.cache, metrics:stats});
    assert.equal(m.calls, 0, 'no term-extraction call');
    assert.equal(m.answers.length, 1);
    assert.equal(stats.evidence_mode, 'original-text');
    assert.ok(stats.selected_source_bytes <= DIGEST_BUDGET.broad + 6000, 'selected ' + stats.selected_source_bytes);
    assert.equal(stats.document_digest.documents, 6);
    assert.equal(stats.document_digest.budget, DIGEST_BUDGET.broad);
    assert.equal(m.answers[0].options.maxTokens, 12000, '"semua yang penting" over several days is a broad request');
    assert.equal(stats.broad_summary, true);
    const material = m.answers[0].messages[1].content;
    assert.match(material, /"cakupan_bahan":"Dipadatkan sistem/);
    // documentFacts counts every issuer section of the original, including the listed ones.
    assert.match(material, /\[D1\] 2026-10-01: 212 bagian berjudul kode emiten \((?:A\d{3}, ){40}… dan 172 kode lain\)/);
    const question = m.answers[0].messages.at(-1).content;
    assert.match(question, /DAFTAR BAGIAN YANG TIDAK DIKIRIM/); assert.doesNotMatch(question, /maksimal \d+ butir/);
    assert.match(question, /Setiap butir Sorotan, Yang berubah dan Jarang disebut tapi material tiap hari mendapat satu baris/);
    assert.equal(result.documents, 6);
  } finally { f.db.close(); }
});

test('converse: a ranking over several days scales its item count; "semua … paling menarik" stays a ranking', async () => {
  const f = fixture(), m = model(), stats = {};
  try {
    await converse(f.archive, m, 'stockbit 1-6 oktober 2026, urutkan semua yang paling menarik', [], () => {}, null, {cache:f.cache, metrics:stats});
    assert.equal(m.answers[0].options.maxTokens, 6500);
    assert.equal(stats.broad_summary, undefined);
    assert.match(m.answers[0].messages.at(-1).content, /maksimal 18 butir/);
  } finally { f.db.close(); }
});

test('converse: "detail" is never a top-N ranking; a single day gets the detail budget and the larger answer allowance', async () => {
  const f = fixture(), m = model(), stats = {};
  try {
    await converse(f.archive, m, 'ringkas stockbit 5 oktober detail', [], () => {}, null, {cache:f.cache, metrics:stats});
    assert.equal(stats.digest_budget, DIGEST_BUDGET.detail);
    assert.equal(stats.detail_summary, 'day');
    assert.equal(m.answers[0].options.maxTokens, 12000);
    const question = m.answers[0].messages.at(-1).content;
    assert.doesNotMatch(question, /Susun peringkat|maksimal \d+ butir/);
    assert.match(question, /Pengguna meminta rincian: jangan susun peringkat/);
  } finally { f.db.close(); }
  // Several days asked "detail": no ranking, normal digest budget.
  const g = fixture(), n = model(), more = {};
  try {
    await converse(g.archive, n, 'ringkas stockbit 1-3 oktober 2026 detail', [], () => {}, null, {cache:g.cache, metrics:more});
    assert.equal(more.document_digest.budget, DIGEST_BUDGET.normal);
    const question = n.answers[0].messages.at(-1).content;
    assert.doesNotMatch(question, /Susun peringkat/);
    assert.equal(more.detail_summary, true);
    assert.match(question, /“tidak termasuk bahan yang dibaca”, bukan “terpotong”/);
    // Coverage sentence: sent sections counted as whole and partial; listed ones counted apart.
    const {full, partial, listed} = more.document_digest;
    assert.ok(question.includes(`dan ${full + partial} bagian emiten (` + [full ? full + ' utuh' : '', partial ? partial + ' sebagian: bagian awal dan butir utama' : ''].filter(Boolean).join(', ') + ')'
      + (listed ? `; ${listed} bagian emiten lain hanya tercantum di daftar atau dihitung` : '.')), question.slice(-800));
    assert.doesNotMatch(question, /di antaranya hanya bagian awal/);
  } finally { g.db.close(); }
});

test('rich digest: BEI detail sections are sent as briefs (Ringkasan + leading Fakta), within budget', () => {
  const d = day(12), fact = i => `    - Fakta ${i}: pembeli PT Pihak ${i} membeli ${i},5% saham senilai Rp${i}0 miliar.\n`;
  const section = c => `## ${c} — PT ${c} Tbk\n\nStatus: lanjutan · tahap: rencana\n\nKesinambungan (disusun kode): hari ini ${c}.\n\n**Hari ini**\n\n`
    + `- 10:00 · Keterbukaan ${c} · [pengumuman](https://www.idx.co.id/a.pdf) · 20261012-1/X_id-id\n  - Ringkasan: ${c} menjual aset kepada PT Pembeli ${c} dengan persetujuan RUPS.\n`
    + '  - Fakta:\n' + Array.from({length:30}, (_, i) => fact(i + 1)).join('') + '  - Angka:\n' + '    - nilai: 1.000.000\n'.repeat(80)
    + '  - Batasan:\n    - tidak diaudit\n\n**Riwayat** (pengumuman non-rutin sebelumnya)\n\n' + '- 2026-10-01 · lama\n'.repeat(30) + '\n';
  const codes = Array.from({length:80}, (_, i) => 'Q' + String(i).padStart(3, '0'));
  const detail = `# Detail keterbukaan BEI · ${d}\n\nCakupan: 184 pengumuman · 153 emiten · 69 non-rutin · 46 koreksi\n\n` + codes.map(section).join('');
  const entries = [entry(d, detail, 'bei-detail', 'beidetail')];
  assert.ok(utf8(detail) > 2 * DIGEST_BUDGET.detail);
  const plan = deskDigest(entries, {budget:DIGEST_BUDGET.detail, rich:true}).get(entries[0].doc);
  const text = plan.pieces.map(p => p.text).join('');
  assert.ok(plan.sent <= DIGEST_BUDGET.detail, String(plan.sent));
  assert.match(text, /184 pengumuman · 153 emiten · 69 non-rutin · 46 koreksi/);
  for (const c of codes) assert.match(text, new RegExp(`Ringkasan: ${c} menjual aset kepada PT Pembeli ${c}`), c);
  assert.match(text, /Fakta 1: pembeli PT Pihak 1/);
  assert.doesNotMatch(text, /nilai: 1\.000\.000|2026-10-01 · lama|tidak diaudit|idx\.co\.id/);
  assert.match(text, /butir fakta lain, angka, tanggal penting, batasan, riwayat dan jadwal: rincian bagian ini tidak dikirim\)/);
  assert.equal(plan.stats.listed, 0); assert.equal(plan.stats.partial, 80);
  assert.doesNotMatch(plan.coverage, /terpotong/);
  // Without `rich` the same budget sends opening paragraphs only: no Ringkasan line of the later sections.
  const plain = deskDigest(entries, {budget:DIGEST_BUDGET.detail}).get(entries[0].doc).pieces.map(p => p.text).join('');
  assert.ok(!plain.includes('Ringkasan: Q079'));
});

test('rich digest on the real 1–6 Oct Stockbit summaries: filings with numbers from the leads and the second tier', {skip:!existsSync(new URL('../needtobeindexed/idx-signal-desk/sbringkas_2026-10-06_2026-10-06.md', import.meta.url))}, () => {
  const read = name => readFileSync(new URL('../needtobeindexed/idx-signal-desk/' + name, import.meta.url), 'utf8');
  const entries = [1, 2, 3, 4, 5, 6].map(i => entry(day(i), read(`sbringkas_${day(i)}_${day(i)}.md`)));
  const plan = deskDigest(entries, {budget:DIGEST_BUDGET.broad, rich:true});
  assert.ok([...plan.values()].reduce((n, d) => n + d.sent, 0) <= DIGEST_BUDGET.broad);
  const all = [...plan.values()].map(d => d.pieces.map(p => p.text).join('')).join('\n');
  // PACK's filing (5 Oct, a code that topped earlier days), BUMI's acquisitions, COCO, ENRG/HighPeak (6 Oct), DOOH's tender
  // period, and one-line second-tier sections: GEMS and UNTR dividends (1 Oct), MBSS 82,5%, BNBR rights issue (5 Oct).
  for (const item of ['22,8 juta saham Rp581', 'Loyal Metals', 'Rp1,28 triliun', 'HighPeak', '5 Okt s.d. 3 Nov', 'Rp611,93', 'Rp430', '82,5%', 'Rp4,76 triliun'])
    assert.ok(all.includes(item), item);
  for (const d of plan.values()) { const text = d.pieces.map(p => p.text).join(''); assert.match(text, /## Yang berubah/); assert.match(text, /## Sorotan/); }
});

test('real KI analysis next to BEI: head, update table and every heading within the KI head budget', {skip:!existsSync(new URL('../needtobeindexed/ki_07102026.md', import.meta.url))}, () => {
  const text = readFileSync(new URL('../needtobeindexed/ki_07102026.md', import.meta.url), 'utf8');
  const tickers = new Set(['SMKM', 'TCID', 'MKNT', 'REAL', 'BUVA', 'WSBP', 'EDGE', 'INET', 'ASPI', 'POOL']);
  const head = kiHead([{content:text}], tickers), sent = head.pieces.map(p => p.text).join('');
  assert.ok(head.sent <= KI_HEAD_BUDGET && head.sent < utf8(text) / 5, String(head.sent));
  for (const code of tickers) assert.match(sent, new RegExp(code), code);
  assert.match(sent, /## 1\. Update terbaru/);
  assert.match(sent, /- 2\.1 SMKM — aset telah berpindah/);
  assert.match(head.coverage, /rincian per emiten tidak dikirim/);
  // Every sent heading line is source text.
  for (const line of sent.split('\n').filter(l => /^- \d+\.\d+ /.test(l))) assert.ok(text.includes('### ' + line.slice(2)), line);
});

test('converse: explicit completeness over small material gets the 24k allowance; 31 days still fit the digest', async () => {
  const f = fixture(2), m = model(), stats = {};
  try {
    await converse(f.archive, m, 'ringkas stockbit 1-2 oktober, jangan hilangkan detail', [], () => {}, null, {cache:f.cache, metrics:stats});
    assert.equal(m.answers[0].options.maxTokens, 24000);
    assert.ok(stats.selected_source_bytes <= DIGEST_BUDGET.exhaustive);
    assert.equal(stats.exhaustive_summary, true);
  } finally { f.db.close(); }
  const g = fixture(31), n = model(), more = {};
  try {
    // 31 days fit the digest; the code-built clarification needs more than 31 documents.
    await converse(g.archive, n, 'ringkas stockbit 1-31 oktober 2026', [], () => {}, null, {cache:g.cache, metrics:more});
    assert.equal(n.answers.length, 1);
    assert.ok(more.selected_source_bytes <= DIGEST_BUDGET.normal + 25000, 'selected ' + more.selected_source_bytes);
  } finally { g.db.close(); }
});

test('converse: a range of more than 31 documents is clarified by code, without any model call', async () => {
  const docs = Array.from({length:40}, (_, i) => doc(`sbringkas_${i}.md`, 'stockbit-ringkasan', new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), undefined,
    {source_id:'D' + i, sizes:[50000]}));
  for (const d of docs) d.end = d.start, d.label = d.start;
  const index = {docs, tickers:[], commonWords:[], handles:[], postings:{}, system:'x', version:'v1', retrieval_version:'evidence-v1', asset_hashes:{}};
  const archive = {manifest:async () => index, events:async () => ({}), search:async () => [], read:async () => { throw new Error('no read expected'); }};
  const m = model(), events = [];
  const result = await converse(archive, m, 'ringkas stockbit 1 september sampai 10 oktober 2026', [], e => events.push(e), null, {metrics:{}});
  assert.equal(result.clarification, true);
  assert.equal(m.calls + m.answers.length, 0);
  assert.match(events.find(e => e.type === 'delta').text, /40 dokumen .*Persempit rentang tanggal/);
});

test('account() keeps the bridge cache-write split, thinking tokens and API iterations', () => {
  const model = new OpenRouter('x', null, async () => new Response(''));
  const response = {}, receipt = {cached_tokens:null};
  model.receipts.push(receipt); model.responses.set(response, receipt);
  model.account(response, {usage:{prompt_tokens:100, completion_tokens:20, cost:0, prompt_tokens_details:{cached_tokens:60, cache_write_tokens:30,
    cache_write_1h_tokens:0, cache_write_5m_tokens:30}, completion_tokens_details:{reasoning_tokens:12}, api_iterations:1}});
  assert.deepEqual([receipt.cache_write_1h_tokens, receipt.cache_write_5m_tokens, receipt.reasoning_tokens, receipt.api_iterations], [0, 30, 12, 1]);
  receipt.input_bytes = 10; receipt.output_token_budget = 5;
  const usage = model.usage();
  assert.equal(usage.cache_write_5m_tokens, 30); assert.equal(usage.reasoning_tokens, 12); assert.equal(usage.api_iterations, 1);
  // OpenRouter receipts without these fields stay null, not 0.
  const plain = {}; model.responses.set(response, plain);
  model.account(response, {usage:{prompt_tokens:1, completion_tokens:1}});
  assert.equal(plain.reasoning_tokens, null);
});
