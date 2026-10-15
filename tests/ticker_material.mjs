// Ticker/search material sent to the model: neighbour rule, list trim, model copy without links/ids,
// ringkas/detail dedupe, family budgets with listings, compact passages, name list and notes-mode caps.
import test from 'node:test';
import assert from 'node:assert/strict';
import {storage} from '../local/sqlite-storage.mjs';
import {selectRecords, modelText, modelRows, plainContext, headingTicker} from '../worker/retrieval.mjs';
import {familyBudget, docBudget, beiListing, legacyListing, sectionLine, LEGACY_TICKER_BUDGET} from '../worker/stockbit.mjs';
import {converse, CacheStore, LIMITS} from '../worker/core.mjs';

const rec = (content, extra = {}) => ({section_id:'s' + content.length, line:1, kind:'context', context:'Doc', tickers:[], event_date:null, content, ...extra});

test('neighbours are added for prose paragraphs only, not for list items or table rows', () => {
  const tickers = new Set(['TOWR', 'MDIA']);
  const rows = [rec('Paragraf pembuka.\n\n'), rec('TOWR menyatakan buyback.\n\n', {tickers:['TOWR']}), rec('Paragraf penutup.\n\n'),
    rec('- MDIA · 3 posting\n', {tickers:['MDIA']}), rec('- TOWR · 5 posting\n', {tickers:['TOWR']}), rec('- BBCA · 1 posting\n'),
    rec('| 2026-10-01 | MDIA |\n'), rec('| 2026-10-02 | TOWR |\n', {tickers:['TOWR']}), rec('| 2026-10-03 | BBCA |\n')];
  const picked = selectRecords({records:rows}, ['TOWR'], tickers).map(r => r.content);
  assert.deepEqual(picked, ['Paragraf pembuka.\n\n', 'TOWR menyatakan buyback.\n\n', 'Paragraf penutup.\n\n',
    '- TOWR · 5 posting\n', '| 2026-10-02 | TOWR |\n']);
});

test('a matched list keeps the sentence that introduces it (short unsplit list or one item of a split list)', () => {
  const tickers = new Set(['FORU', 'PIPA', 'KOIN']);
  const rows = [rec('Paragraf lain.\n\n'), rec('Nama yang paling menarik untuk penelusuran lebih lanjut dari arsip ini:\n\n'),
    rec('1. **PIPA**\n2. **KOIN**\n3. **FORU**\n\n', {tickers:['FORU', 'KOIN', 'PIPA']}), rec('- PIPA lain\n\n', {tickers:['PIPA']}),
    rec('## Lampiran\n\n'), rec('Semua pengumuman hari ini:\n', {context:'Doc\nLampiran'}),
    rec('- KOIN · 1\n', {kind:'list_item', context:'Doc\nLampiran', tickers:['KOIN']}),
    rec('- FORU · 2\n', {kind:'list_item', context:'Doc\nLampiran', tickers:['FORU']}),
    rec('- PIPA · 3\n', {kind:'list_item', context:'Doc\nLampiran', tickers:['PIPA']})];
  assert.deepEqual(selectRecords({records:rows}, ['FORU'], tickers).map(r => r.content),
    ['Nama yang paling menarik untuk penelusuran lebih lanjut dari arsip ini:\n\n', '1. **PIPA**\n2. **KOIN**\n3. **FORU**\n\n',
      'Semua pengumuman hari ini:\n', '- FORU · 2\n']);
});

test('model copy drops links, post/finding/announcement ids; keeps labels and status words', () => {
  const text = '- 13:57 · Tambah Kapal · [pengumuman](https://www.idx.co.id/StaticData/a/b.pdf) · 20261013135714-072/CORSEC-SOCI/X/2026_id-id · koreksi\n'
    + 'Status: koreksi (juga: lanjutan) · 2 pengumuman\n'
    + '- [Klaim] TOWR buyback Rp500 miliar. — @a 09:58 [pos](https://stockbit.com/post/36541277) · (juga: 36541391) · dari 1 akun (F20261012-0369)\n'
    + '- klaim lain @b [balasan](https://stockbit.com/post/1) · +1 akun (juga: 1, 2, 3, +2 lagi) · celah (F20261012-0001, F20261012-0002)\n'
    + 'Lampiran: https://www.idx.co.id/x/y.pdf dan (https://idx.co.id/z.pdf)\n';
  assert.equal(modelText(text), '- 13:57 · Tambah Kapal · pengumuman · koreksi\n'
    + 'Status: koreksi (juga: lanjutan) · 2 pengumuman\n'
    + '- [Klaim] TOWR buyback Rp500 miliar. — @a 09:58 pos · dari 1 akun\n'
    + '- klaim lain @b balasan · +1 akun · celah\n'
    + 'Lampiran:  dan\n');
  // A bare IDX URL in HTML or CSV ends at the quote/bracket/comma: the anchor text and the following cells stay.
  assert.equal(modelText('<a href="https://www.idx.co.id/StaticData/x/4bf.pdf">Buka dokumen</a>'), '<a href="">Buka dokumen</a>');
  assert.equal(modelText('https://www.idx.co.id/a.pdf,2026-09-01,TOWR,Rp500'), ',2026-09-01,TOWR,Rp500');
  assert.equal(plainContext('Judul\n<tr><th>Tanggal</th><th>A &amp; B</th></tr>'), 'Judul\nTanggal | A & B');
  assert.equal(headingTicker('### 01. TOWR — Menara'), 'TOWR');
  assert.equal(headingTicker('## **SOCI** — PT Soechi', new Set(['SOCI'])), 'SOCI');
  assert.equal(headingTicker('## Ikhtisar emiten'), null);
});

test('a long desk list that tags the ticker keeps only its items; other sources and short lists stay whole', () => {
  const tickers = new Set(['TOWR', 'MDIA', 'BBCA']);
  const list = '## Ikhtisar emiten\n' + Array.from({length:60}, (_, i) => `- ${i === 30 ? 'TOWR' : 'MDIA'} · ${i} posting / 3 akun\n  - rincian ${i}\n`).join('');
  const row = rec(list, {tickers:['MDIA', 'TOWR']});
  const [trimmed] = modelRows({cat:'stockbit-detail'}, [row], ['TOWR'], tickers);
  assert.equal(trimmed.content, '## Ikhtisar emiten\n- TOWR · 30 posting / 3 akun\n  - rincian 30\n(59 butir lain dalam daftar ini tidak dikirim)\n');
  assert.equal(trimmed.original, list);
  assert.equal(modelRows({cat:'keterbukaan-informasi'}, [row], ['TOWR'], tickers)[0].content, list);
  const short = rec('- TOWR · 1\n- MDIA · 2\n', {tickers:['MDIA', 'TOWR']});
  assert.equal(modelRows({cat:'bei-detail'}, [short], ['TOWR'], tickers)[0], short);
});

const day = (cat, d) => ({cat, end:d, name:`${cat}_${d}`, title:`${cat} ${d}`, label:d, source_id:'D' + cat.length + d.slice(-2)});
test('a covered summary section is sent once when the same day detail is read; kept when the detail does not fit', () => {
  const entries = ['2026-10-05', '2026-10-06'].flatMap(d => [{doc:day('bei-ringkasan', d), bytes:3000, covered:2500},
    {doc:day('bei-detail', d), bytes:20000}]);
  const plan = familyBudget(entries, 30000, 'bei-detail');
  assert.deepEqual(plan.read, ['2026-10-06', '2026-10-05']);
  // 6000 summaries, then 06: +20000-2500 = 23500 fits; 05: +17500 does not.
  assert.equal(plan.used, 23500);
  assert.deepEqual([...plan.trimmed].map(d => d.end), ['2026-10-06']);
  assert.deepEqual([...plan.dropped].map(d => d.name), ['bei-detail_2026-10-05']);
  const legacy = docBudget(['2026-09-01', '2026-09-20', '2026-09-10'].map(d => ({doc:day('stockbit', d), bytes:30000})), 50000);
  assert.deepEqual(legacy.read.map(d => d.end), ['2026-09-20']);
  assert.deepEqual(legacy.listed.map(e => e.doc.end), ['2026-09-10', '2026-09-01']);
});

test('legacy reports: the ticker sections of every document come before the rest of any document', () => {
  // Newest first, whole documents would read only 09-20 (30 KB) and 09-10 (15 KB) and list 09-05 and 09-01.
  const e = (d, bytes, core, own = true) => ({doc:day('stockbit', d), bytes, core, own});
  const plan = docBudget([e('2026-09-20', 30000, 4000), e('2026-09-10', 15000, 3000), e('2026-09-05', 12000, 5000),
    e('2026-09-01', 20000, 20000, false), e('2026-08-25', 9000, 6000, false)], 50000);
  // Pass 1: cores 4000 + 3000 + 5000 (own sections), then named-only 20000 and 6000 = 38000.
  // Pass 2 (newest first): 09-20 +26000 does not fit (64000), 09-10 +12000 fits (50000), the rest does not.
  assert.deepEqual(plan.read.map(d => d.end), ['2026-09-20', '2026-09-10', '2026-09-05', '2026-09-01', '2026-08-25']);
  assert.deepEqual([...plan.trimmed].map(d => d.end), ['2026-09-20', '2026-09-05', '2026-08-25']);
  assert.equal(plan.used, 50000);
  assert.equal(plan.listed.length, 0);
  // A core that does not fit is listed and the next document is still tried; the newest is always read.
  const tight = docBudget([e('2026-09-20', 30000, 30000), e('2026-09-10', 40000, 25000), e('2026-09-05', 9000, 9000)], 40000);
  assert.deepEqual(tight.read.map(d => d.end), ['2026-09-20', '2026-09-05']);
  assert.deepEqual(tight.listed.map(x => x.doc.end), ['2026-09-10']);
});

test('model copy of Stockbit files: co-mention sections keep only the ticker findings the own section lacks', () => {
  const tickers = new Set(['GRPM', 'PMUI', 'SQMI', 'BULL']);
  const q = '- [Pertanyaan] PMUI dipertanyakan untung dari penjualan GRPM — @a 10:48 pos · 1 sumber';
  const own = rec(`## GRPM\n\nGRPM · 21 posting · inti: PMUI dipertanyakan untung dari penjualan GRPM\n\n${q}\n\nTerkait: PMUI\n`, {kind:'issuer_section'});
  const dup = rec(`## PMUI\n\nPMUI · 21 posting · inti: ikut bandar.\n\n- [Klaim penulis] PMUI pelan-pelan. — @b 10:43\n${q}\n\nTerkait: BIPI, GRPM\n`, {kind:'issuer_section'});
  const novel = rec('## SQMI\n\nSQMI · 5 posting\n\n- [Klaim penulis] SQMI lain. — @c\n- [Rumor] GRPM akan diakuisisi SQMI senilai Rp1 T. — @d 11:00\n', {kind:'issuer_section'});
  const out = modelRows({cat:'stockbit-detail'}, [dup, own, novel], ['GRPM'], tickers);
  assert.deepEqual(out.map(r => headingTicker(r.content)), ['GRPM', 'SQMI'], 'the PMUI copy is not sent');
  assert.equal(out[1].content, '## SQMI\n\n- [Rumor] GRPM akan diakuisisi SQMI senilai Rp1 T. — @d 11:00\n(bagian SQMI lain tidak dikirim)\n\n');
  assert.equal(out[1].original, novel.content);
  // Without an own section the co-mention keeps its heading, opening line and the naming findings.
  const [alone] = modelRows({cat:'stockbit-ringkasan'}, [dup], ['GRPM'], tickers);
  assert.equal(alone.content, `## PMUI\n\nPMUI · 21 posting · inti: ikut bandar.\n${q}\n(bagian PMUI lain tidak dikirim)\n\n`);
  // BEI files and other sources keep co-mention sections whole.
  assert.equal(modelRows({cat:'bei-detail'}, [dup, own], ['GRPM'], tickers).length, 2);
});

test('listing lines are built by code from the ticker section or the first line naming it', () => {
  const rows = [{kind:'issuer_section', content:'## SOCI — PT Soechi\n\nStatus: koreksi · [pengumuman](https://www.idx.co.id/a.pdf) · 2 pengumuman\n'}];
  assert.equal(sectionLine(rows, ['SOCI']), 'Status: koreksi · pengumuman · 2 pengumuman');
  const bei = beiListing([{day:'2026-09-01', doc:day('bei-ringkasan', '2026-09-01')}], ['SOCI'], () => rows);
  assert.match(bei.material, /^INDEKS BEI, 1 hari keterbukaan BEI lain \(tidak dibaca utuh;/);
  assert.match(bei.tail, /^\*\*1 hari keterbukaan BEI lain \(tidak dibaca utuh\)\*\*/);
  assert.match(bei.material, /- 2026-09-01 · SOCI: Status: koreksi · pengumuman · 2 pengumuman \[D\d+\]$/);
  const legacy = legacyListing([{doc:day('stockbit', '2026-09-02')}], ['SOCI'],
    () => [{kind:'issuer_section', content:'## SOCI\n\nSource: baris 1–9.\nSOCI menambah kapal.\n'}]);
  assert.match(legacy.material, /^ARSIP LAMA, 1 dokumen lama lain/);
  assert.match(legacy.material, /· SOCI menambah kapal\. \[D\d+\]$/);
});

test('notes mode: size-based note allowances are scaled to fit the analysis output limit next to the answer', async () => {
  // 14 SGX documents of about 72 KB (no family budget): 14 × 2400 + 6500 would exceed the 36,000-token limit.
  const extra = Array.from({length:14}, (_, i) => [`sgx_${10 + i}092026.md`, 'keterbukaan-singapura', `2026-09-${10 + i}`,
    [{kind:'issuer_section', context:'ALFA', tickers:['ALFA'], content:`## ALFA\n\n${('ALFA bukti panjang ' + i + '. ').repeat(3600)}\n`}]]);
  const f = archive({extra}), stats = {}, m = model('ALFA [D3].');
  let planned = null;
  m.planReading = budget => { planned = budget; if (budget.output > LIMITS.output || budget.calls > LIMITS.calls) throw new Error('over limit ' + budget.output); };
  try {
    await converse(f.archive, m, 'ALFA', [], () => {}, null, {cache:f.cache, metrics:stats});
    assert.equal(stats.evidence_mode, 'source-notes');
    assert.ok(planned.output <= LIMITS.output, 'reserved ' + planned.output);
    assert.ok(m.notes.length >= 14 && m.notes.every(n => n.options.maxTokens >= 1800));
  } finally { f.db.close(); }
});
// ---- converse with a small BEI/Stockbit archive -------------------------------------------
function archive({extra = []} = {}) {
  const {db, storage:{sql}} = storage();
  const docs = [], evidence = new Map();
  const add = (name, cat, d, records) => {
    const doc = {name, cat, start:d, end:d, covers:[d, d], title:name, label:d, path:`files/${cat}/${d}/${name}`,
      source_id:'D' + (docs.length + 1), document_id:'id-' + name, document_hash:'h-' + name};
    doc.asset = doc.source_id + '.json'; doc.evidence_asset = doc.source_id + '.evidence.json';
    let start = 0;
    records = records.map((r, i) => { const row = {section_id:name + i, line:i + 1, kind:'context', context:name, tickers:[], event_date:null,
      ...r, start, end:start + r.content.length}; start = row.end; return row; });
    doc.sizes = [start + 50]; docs.push(doc); evidence.set(doc.source_id, records);
  };
  const section = (code, body) => ({kind:'issuer_section', context:'x\n' + code, tickers:[code], content:`## ${code} — PT ${code}\n\n${body}`});
  const ikhtisar = '## Ikhtisar emiten\n' + Array.from({length:150}, (_, i) => `- ${i === 40 ? 'TOWR · Rp 7.777 miliar disebut' : 'MDIA · lanjutan · ' + i}\n`).join('');
  for (const d of ['2026-10-05', '2026-10-06']) {
    add(`beiringkas_${d}_${d}.md`, 'bei-ringkasan', d, [section('TOWR', 'Status: lanjutan · 1 pengumuman\n\n- 10:45 · Tender sukarela Rp5.400 per saham\n')]);
    add(`beidetail_${d}_${d}.md`, 'bei-detail', d, [{content:ikhtisar, tickers:['MDIA', 'TOWR']},
      section('TOWR', 'Status: lanjutan · 1 pengumuman\n\n- 10:45 · Tender sukarela Rp5.400 per saham · [pengumuman](https://www.idx.co.id/a.pdf) · 20261005104500-01/X/2026_id-id\n'
        + '  - Ringkasan: harga Rp5.400 per saham, 480.110 saham ditenderkan.\n'.repeat(4) + '  - Fakta: '.padEnd(200, 'x') + '\n')]);
  }
  for (const [name, cat, d, records] of extra) add(name, cat, d, records);
  const index = {docs, tickers:['TOWR', 'MDIA', 'ALFA'], commonWords:[], handles:[], postings:{}, system:'Gunakan bukti.',
    version:'v1', retrieval_version:'ev-v1', asset_hashes:{'events.json':'e1'}};
  const names = {TOWR:'PT Sarana Menara Nusantara Tbk', MDIA:'PT Intermedia Capital Tbk', ALFA:'PT Alfa Tbk'};
  return {db, cache:new CacheStore(sql), docs, archive:{manifest:async () => index, events:async () => ({names, types:[], events:[]}),
    search:async terms => docs.filter(d => evidence.get(d.source_id).some(r => terms.some(t => r.content.includes(t)))).sort((a, b) => b.end.localeCompare(a.end)),
    read:async asset => { const d = docs.find(x => x.asset === asset || x.evidence_asset === asset), rows = evidence.get(d.source_id);
      return asset === d.asset ? {parts:[{source_id:d.source_id, part:1, text:rows.map(r => r.content).join('')}]}
        : {version:index.retrieval_version, document_hash:d.document_hash, coverage:'full-source-partition', records:rows}; }}};
}
function model(answer = 'TOWR tender Rp5.400 per saham dan Rp 7.777 miliar [D2]; juga Rp 9.999 miliar [D2].') {
  const m = {answers:[], notes:[], complete:async (messages, options) => {
    if (options?.jsonMode) return JSON.stringify({terms:[]});
    m.notes.push({options, bytes:JSON.stringify(messages).length}); return 'Catatan [D1].';
  }, answer:async (messages, emit) => { m.answers.push(messages); await emit({type:'delta', text:answer}); return answer; }};
  return m;
}
const material = m => m.answers[0][1].content;
const entries = m => JSON.parse(material(m).slice(material(m).indexOf('['), material(m).search(/\n\n(?:NAMA EMITEN|INDEKS|ARSIP LAMA)|$/)));

test('ticker answer: compact passages, no links, ringkas section sent once, short name list, numbers checked on the original', async () => {
  const f = archive(), m = model(), stats = {};
  try {
    const result = await converse(f.archive, m, 'analisis TOWR', [], () => {}, null, {cache:f.cache, metrics:stats});
    const text = material(m), list = entries(m);
    assert.ok(!/https?:|_id-id/.test(text), 'links and announcement ids are not sent');
    // Detail sections cover the ringkas sections of the same days: the ringkas docs are not sent at all.
    assert.deepEqual(list.map(e => e.title).sort(), ['beidetail_2026-10-05_2026-10-05.md', 'beidetail_2026-10-06_2026-10-06.md']);
    assert.equal(stats.family_budgets.bei.read, 2);
    for (const e of list) for (const p of e.raw) {
      assert.deepEqual(Object.keys(p).filter(k => !['line', 'context', 'text'].includes(k)), [], 'no section_id/event_date/part');
      assert.ok(!(p.context || '').startsWith(e.title));
    }
    // The Ikhtisar list is trimmed to the TOWR item in the model copy.
    assert.ok(!text.includes('MDIA · lanjutan'));
    assert.match(text, /TOWR · Rp 7\.777 miliar disebut[\s\S]*149 butir lain/);
    // Only the asked code and codes with their own section get a name.
    assert.match(text, /NAMA EMITEN MENURUT ARSIP[^\n]*: TOWR = PT Sarana Menara Nusantara Tbk$/);
    // Rp 7.777 is in the source; Rp 9.999 is not.
    assert.deepEqual(stats.unverified_numbers, ['Rp 9.999 miliar']);
    assert.ok(result.answer.includes('Pemeriksaan angka otomatis'));
  } finally { f.db.close(); }
});

test('ticker answer: official disclosures open the material, Stockbit files follow; the answer keeps official classifications', async () => {
  const extra = [['sbringkas_2026-10-07_2026-10-07.md', 'stockbit-ringkasan', '2026-10-07',
    [{kind:'issuer_section', context:'x\nTOWR', tickers:['TOWR'], content:'## TOWR\n\nTOWR · 9 posting · inti: buyback dibahas.\n\n- [Klaim penulis] TOWR buyback. — @a\n'}]]];
  const f = archive({extra}), m = model(), stats = {};
  try {
    await converse(f.archive, m, 'analisis TOWR', [], () => {}, null, {cache:f.cache, metrics:stats});
    const titles = entries(m).map(e => e.title);
    assert.deepEqual(titles.at(-1), 'sbringkas_2026-10-07_2026-10-07.md', titles.join(', '));
    assert.ok(titles.slice(0, -1).every(t => t.startsWith('beidetail_')));
    const question = m.answers[0].at(-1).content;
    assert.match(question, /dahulukan keterbukaan resmi \(BEI\/KI\) sebelum klaim Stockbit/);
    assert.match(question, /tanggung renteng/);
    assert.match(question, /satu baris/);
  } finally { f.db.close(); }
});

test('same material for the same question: deterministic prompt for provider caching', async () => {
  const a = archive(), b = archive(), m1 = model(), m2 = model();
  try {
    await converse(a.archive, m1, 'analisis TOWR', [], () => {}, null, {cache:a.cache});
    await converse(b.archive, m2, 'analisis TOWR', [], () => {}, null, {cache:b.cache});
    assert.equal(material(m1), material(m2));
  } finally { a.db.close(); b.db.close(); }
});

test('legacy reports beyond their budget are listed with links and told to the model as not read', async () => {
  const extra = Array.from({length:6}, (_, i) => [`stockbit_0${i + 1}092026.md`, 'stockbit', `2026-09-0${i + 1}`,
    [{kind:'issuer_section', context:'TOWR', tickers:['TOWR'], content:`## TOWR\n\nTOWR diskusi hari ${i + 1}. ${'isi '.repeat(4000)}\n`}]]);
  const f = archive({extra}), m = model('Ringkas [D2].'), stats = {};
  try {
    const result = await converse(f.archive, m, 'analisis TOWR', [], () => {}, null, {cache:f.cache, metrics:stats});
    assert.equal(stats.family_budgets.legacy.read + stats.family_budgets.legacy.listed, 6);
    assert.ok(stats.family_budgets.legacy.listed > 0 && stats.family_budgets.legacy.bytes <= LEGACY_TICKER_BUDGET);
    assert.match(material(m), /ARSIP LAMA, \d dokumen lama lain \(tidak dibaca utuh;[^\n]*\n- 2026-09-0\d · stockbit_0\d092026\.md · TOWR diskusi hari/);
    assert.match(result.answer, /\*\*\d dokumen lama lain \(tidak dibaca utuh\)\*\*/);
    // Listed documents stay linkable sources; the newest legacy report is the one read.
    assert.ok(result.sources.some(s => s.title === 'stockbit_01092026.md'));
    assert.ok(entries(m).some(e => e.title === 'stockbit_06092026.md'));
  } finally { f.db.close(); }
});

test('notes mode: small raw units become notes until the answer fits; note size follows the unit; no resend on truncation', async () => {
  // SGX documents have no family budget: 13 units of about 21 KB stay under the 24 KB note threshold.
  const extra = Array.from({length:13}, (_, i) => [`sgx_${10 + i}092026.md`, 'keterbukaan-singapura', `2026-09-${10 + i}`,
    [{kind:'issuer_section', context:'ALFA', tickers:['ALFA'], content:`## ALFA\n\n${'ALFA bukti. '.repeat(1800)}\n`}]]);
  extra.push(['sgx_30092026.md', 'keterbukaan-singapura', '2026-09-30',
    [{kind:'issuer_section', context:'ALFA', tickers:['ALFA'], content:`## ALFA\n\n${'ALFA bukti panjang. '.repeat(4000)}\n`}]]);
  const f = archive({extra}), stats = {}, m = model('ALFA [D3].');
  try {
    await converse(f.archive, m, 'ALFA', [], () => {}, null, {cache:f.cache, metrics:stats});
    assert.equal(stats.evidence_mode, 'source-notes');
    assert.ok(stats.raw_units_noted > 0, 'small raw units were converted');
    assert.ok(m.notes.every(n => n.options.retry === false), 'a cut note is kept, not resent');
    const big = m.notes.find(n => n.bytes > 60000);
    // About 1 output token per 30 input bytes, between 1800 and 4000.
    assert.ok(big.options.maxTokens > 1800 && big.options.maxTokens <= 4000 && Math.abs(big.options.maxTokens - big.bytes / 30) < 400);
    assert.ok(m.notes.filter(n => n.bytes < 60000).every(n => n.options.maxTokens === 1800));
    assert.ok(JSON.stringify(m.answers[0]).length < 240000 + 20000, 'final answer message stays near RAW_LIMIT');
  } finally { f.db.close(); }
});
