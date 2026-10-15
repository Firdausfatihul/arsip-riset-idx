// Archive tables in the chat (worker/tables.mjs, tools/archive_tables.py): unit tests on small fixtures, plus
// integration through converse() on the built worker/.assets (python3 -B build.py && python3 -B tools/build_worker.py).
// No network; the model is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {assets, readAsset} from './helpers/archive.mjs';
import {Archive, converse, rememberTurn} from '../worker/core.mjs';
import {claimLine, claimTail, relationBlock, entityLookup, rareRumorMaterial, mentionsBlock, RELATION} from '../worker/tables.mjs';

const TOPICS = ['rights_issue','private_placement','tender_offer','akuisisi_pengendali','merger','buyback','stock_split','dividen','suspensi_uma','go_private','kontrak','kepemilikan','pailit','rups'];
const bit = name => 1 << TOPICS.indexOf(name);
const row = (fid, day, kind, text, handle = 'a', accounts = 1, topics = 0, replies = 0) => [fid, day, kind, text, handle, accounts, '', replies, topics];
const index = {commonWords:['ada','apa','yang'], postings:{tanoko:['D1'], gede:['D2'], transaksi:Array(90).fill('D'), nego:['D1'], tanoto:['D3'], foundation:['D3']},
  tickers:['HELI','MERI','BIKE','MENN','AVIA','UNIT','GRPM','PMUI','EMAS'],
  docs:[{source_id:'D8', name:'beidetail_2026-08-19_2026-08-19.md', cat:'bei-detail', start:'2026-08-19', end:'2026-08-19', title:'BEI', path:'p', label:'19 Agu'},
    {source_id:'D9', name:'sbdetail_2026-10-07_2026-10-07.md', cat:'stockbit-detail', start:'2026-10-07', end:'2026-10-07', title:'SB', path:'q', label:'7 Okt'},
    {source_id:'D21', name:'beidetail_2026-09-06_2026-09-06.md', cat:'bei-detail', start:'2026-09-06', end:'2026-09-06', title:'BEI', path:'r', label:'6 Sep'}]};
const fixture = () => ({
  claims:{topics:TOPICS, by_ticker:{
    HELI:[row('F1', '2026-10-01', 'K', 'Pemegang saham 8% HELI sedang menjual', 'zein', 1, bit('kepemilikan'), 10),
      row('F2', '2026-10-07', 'R', 'HELI didukung oleh Tanoko melalui Alta', 'mif')],
    MERI:[row('F5', '2026-10-05', 'R', 'Ada pihak di balik MERI yang berpotensi mengakuisisi emiten', 'laz', 1, bit('akuisisi_pengendali'))],
    FORU:[...Array.from({length:6}, (_, i) => row('F9' + i, '2026-10-0' + (i + 1), 'R', 'FORU akan diakuisisi ' + i, 'u' + i, 1, bit('akuisisi_pengendali')))]}},
  links:{links:{HELI:{F1:[['tercatat','2026-08','KSEI s.d. Agustus 2026 mencatat PT. AVIA NUSANTARA KHATULISTIWA 8,43%; belum ada data KSEI untuk Oktober 2026'], ['lain','2026-08-29','ada keterbukaan lain …']],
    F2:[['tercatat','2026-08','pihak tercatat di KSEI (Agustus 2026, 16,00%): PT. ALTA INTERNASIONAL INDONESIA']]},
    MERI:{F5:[['tanpa_dasar','2026-10-05','belum ada keterbukaan sejenis']]},
    // A check filed under another ticker never reaches HELI rows.
    VKTR:{F2:[['didukung','2026-09-29','didukung keterbukaan 2026-09-29: PMHMETD I VKTR']]}}},
  coverage:{stockbit:['2026-10-01','2026-10-12'], bei:['2026-08-10','2026-10-13',[]], ksei:['2026-02','2026-08']},
  entities:{names:{
    'JAYA MAKMUR PENAJAM':{d:'PT PENAJAM MAKMUR JAYA', k:'firm', t:{BIKE:[['ksei','2026-08',74.9,'KSEI']], MENN:[['pengendali','2026-01',0.16,'DPS']]}, deg:2},
    'JORA JUDGE NILAM':{d:'JORA NILAM JUDGE', k:'person', t:{BIKE:[['ksei','2026-08',2.68,'KSEI']], MENN:[['ksei','2026-08',18.37,'KSEI']]}, deg:2},
    'ADIMITRA JASA KORPORA':{d:'PT Adimitra Jasa Korpora', k:'service', t:{BIKE:[['BAE','2026-09-01',null,'x.md#1']], MENN:[['BAE','2026-09-02',null,'y.md#2']]}, deg:11},
    'HERMANTO TANOKO':{d:'HERMANTO TANOKO', k:'person', t:{AVIA:[['komisaris','2026-08',0.18,'DPS']]}, deg:1},
    'ATMODJO MULYO TANOKO':{d:'TANOKO MULYO ATMODJO', k:'person', t:{UNIT:[['ksei','2026-08',3.05,'KSEI']]}, deg:1},
    'AGUNG ANAK GEDE SUMADI':{d:'ANAK AGUNG GEDE SUMADI', k:'person', t:{BALI:[['ksei','2026-08',2,'KSEI']]}, deg:1},
    'HONG KHENG LO':{d:'LO KHENG HONG', k:'person', t:{GJTL:[['ksei','2026-08',1.2,'KSEI']]}, deg:1},
    ...Object.fromEntries(Array.from({length:8}, (_, i) => ['HONG KONG X' + i, {d:'X' + i + ' (HONG KONG)', k:'firm', t:{}, deg:0}])),
    'FOUNDATION GOLDEN':{d:'GOLDEN CAPITAL FOUNDATION', k:'firm', t:{CITY:[['ksei','2026-08',9.44,'KSEI']]}, deg:1},
    'EMAS DELTA FORTUNA':{d:'PT DELTA EMAS FORTUNA', k:'firm', t:{NICE:[['ksei','2026-08',5,'KSEI']]}, deg:1},
    'INDONESIA PERSERO TELKOM':{d:'TELKOM INDONESIA (PERSERO) TBK', k:'firm', t:{MTEL:[['ksei','2026-08',71,'KSEI']]}, deg:1}},
    alias:{}, alias_src:{}, variants:{tanoko:['tanoto']}, namelike:['tanoko','hermanto','penajam','kheng','hong','emas','telkom'],
    issuer_words:['telkom','indonesia','graha','prima','mentari']},
  subjects:{by_ticker:{
    MENN:[['2026-08-19','BIKE','beidetail_2026-08-19_2026-08-19.md',915,'transaksi_saham','Struktur pemegang saham setelah akuisisi untuk MENN: BIKE 59.84%']],
    GRPM:[['2026-09-06','PMUI','beidetail_2026-09-06_2026-09-06.md',166,'transaksi_saham','rencana penjualan saham grpm oleh PMUI kepada PT Tunas Binatama Lestari'],
      ['2026-09-06','PMUI','beidetail_2026-09-06_2026-09-06.md',173,'transaksi_saham','PMUI berencana menjual saham PT Graha Prima Mentari Tbk (GRPM)'],
      ['2026-09-06','BBRI','beidetail_2026-09-06_2026-09-06.md',200,'kreditur','pinjaman kepada PT Graha Prima Mentari Tbk'],
      ...Array.from({length:12}, (_, i) => ['2026-09-0' + (i % 9 + 1), 'X' + i, 'beidetail_2026-09-06_2026-09-06.md', 300 + i, 'lain', 'PT Graha Prima Mentari Tbk disebut ' + i])]}},
});

test('claim lines use the check of their own ticker only; other-topic disclosures stay brief', () => {
  const t = fixture(), line = claimLine(t.claims.by_ticker.HELI[0], 'HELI', t);
  assert.match(line, /^F1 · 2026-10-01 · HELI · \[Klaim penulis\] Pemegang saham 8% HELI sedang menjual · @zein · 10 balasan · CEK: KSEI s\.d\. Agustus 2026 mencatat/);
  assert.doesNotMatch(line, /ada keterbukaan lain|bertentangan/);
  assert.doesNotMatch(claimLine(t.claims.by_ticker.HELI[1], 'HELI', t), /CEK: didukung|VKTR/);
});

test('[A2]: lowercase/name mentions by other issuers, no capitalised code rows, no creditors, capped', () => {
  const t = fixture(), a2 = mentionsBlock(['GRPM'], t, index, 'analisa saham grpm');
  assert.match(a2.text, /^\[A2\] KODE DISEBUT DI PENGUMUMAN EMITEN LAIN/);
  assert.match(a2.text, /GRPM ← 2026-09-06 · pengumuman PMUI · transaksi_saham: "rencana penjualan saham grpm oleh PMUI.*" \[D21\] baris 166/);
  assert.doesNotMatch(a2.text, /\(GRPM\)/); // found by the case-sensitive search already
  assert.doesNotMatch(a2.text, /pinjaman/);
  assert.equal(a2.rows, 8);
  assert.ok(Buffer.byteLength(a2.text) <= 4200);
  assert.deepEqual(a2.refs.docs.map(d => d.source_id), ['D21']);
  assert.match(mentionsBlock(['GRPM'], t, index, 'utang grpm ke bank?').text, /pinjaman/);
  assert.equal(mentionsBlock(['MENN', 'BIKE'], t, index, 'x'), null); // filer named in the question, capitalised code
});

test('[H] tiers exact shared names and announcements; service providers are weak; wording gates it', () => {
  const t = fixture(), {text, refs} = relationBlock(['BIKE','MENN'], t, index);
  assert.match(text, /\(kuat\) PT PENAJAM MAKMUR JAYA/);
  assert.match(text, /\(kuat\) JORA NILAM JUDGE/);
  assert.match(text, /\(lemah\) PT Adimitra Jasa Korpora/);
  assert.match(text, /pengumuman BIKE 2026-08-19 menyebut MENN \(transaksi_saham\).*\[D8\] baris 915/);
  assert.deepEqual(refs.docs.map(d => d.source_id), ['D8']);
  assert.match(relationBlock(['HELI','MERI'], t, index).text, /tidak ada pihak sama yang tercatat/);
  assert.ok(RELATION.test('ada nama pengendali yang sama di BIKE dan MENN ?'));
  assert.ok(RELATION.test('apa hubungan BIKE dan MENN'));
  assert.ok(!RELATION.test('analisa BIKE dan MENN'));
  assert.ok(!RELATION.test('BBRI sama BMRI mana yang lebih bagus'));
  // "terkait" as "about" is not relation wording.
  assert.ok(!RELATION.test('rangkum berita terkait BUMI dan BRMS'));
  assert.ok(!RELATION.test('bandingkan BBRI dan BMRI terkait dividen'));
  assert.ok(RELATION.test('apakah BUMI terkait dengan BRMS?'));
  assert.ok(RELATION.test('kaitan antara BUMI dan BRMS'));
});

test('entity lookup: exact name tokens, no surname merge, ordinary words are not names', () => {
  const t = fixture();
  const tanoko = entityLookup('Tanoko?', t.entities, index);
  assert.deepEqual(tanoko.matched[0].names.sort(), ['ATMODJO MULYO TANOKO', 'HERMANTO TANOKO']);
  assert.equal(entityLookup('apakah ada transaksi nego gede?', t.entities, index), null);
  assert.ok(entityLookup('Anak Agung Gede siapa', t.entities, index));
  assert.deepEqual(entityLookup('hermantoo punya apa', t.entities, index).fuzzy, {hermantoo:'hermanto'});
  // Issuer names and ticker words go to the ticker search; a sentence-initial capital is not a name.
  assert.equal(entityLookup('gimana saham telkom', t.entities, index), null);
  assert.equal(entityLookup('emiten tambang emas', t.entities, index), null);
  // A rare capitalised word glued to the matched name: the full name is not in the tables.
  assert.equal(entityLookup('Tanoto Foundation punya saham apa', t.entities, index), null);
  // A token shared by many names is a content word next to a rarer one.
  const lkh = entityLookup('Lo Kheng Hong beli apa', t.entities, index);
  assert.deepEqual(lkh.matched.map(m => m.token), ['kheng']);
  assert.ok(lkh.content.includes('hong'));
});

test('claim tail: only undiscussed rumors, at most 8 one-line rows with the check', () => {
  const t = fixture(), claims = [{row:t.claims.by_ticker.HELI[1], code:'HELI'}, {row:t.claims.by_ticker.MERI[0], code:'MERI'}];
  assert.equal(claimTail('Rumor F2 dan F5 dibahas.', claims, t), '');
  const tail = claimTail('Ada pihak di balik MERI yang berpotensi mengakuisisi emiten, belum terbukti.', claims, t);
  assert.match(tail, /^\*\*Klaim tercatat lain \(1, belum diverifikasi; daftar sistem\):\*\*/);
  assert.match(tail, /- F2 · HELI · HELI didukung oleh Tanoko melalui Alta — CEK: pihak tercatat di KSEI/);
  assert.doesNotMatch(tail, /F5/);
  const many = claimTail('-', t.claims.by_ticker.FORU.concat(t.claims.by_ticker.FORU).map((r, i) => ({row:[r[0] + i, ...r.slice(1)], code:'FORU'})), t);
  assert.equal(many.split('\n').filter(l => /^- F/.test(l)).length, 8);
  assert.match(many, /… dan 4 klaim lain/);
});

test('rare rumors: corporate-action rumors of thinly discussed issuers, one per issuer first', async () => {
  const t = fixture(), m = await rareRumorMaterial({index, tables:t, archive:{read:async () => ({records:[]})}});
  assert.match(m.text, /MERI · \[Rumor\] Ada pihak di balik MERI/);
  assert.doesNotMatch(m.text, /FORU akan diakuisisi/); // six accounts on six days: not rare
  assert.equal(m.stats.issuers, 1);
});

// ---- integration on the built assets ------------------------------------------------------------------------------
let manifest = {};
try { manifest = await readAsset('manifest.json'); } catch { /* no build */ }
const hasTables = !!manifest.tables?.subjects;
class Fake {
  constructor() { this.calls = []; }
  async complete(m) { this.calls.push(m); return '{"intent":"search","terms":[]}'; }
  async answer(m, emit) { this.calls.push(m); await emit({type:'delta', text:'Jawaban uji.'}); return 'Jawaban uji.'; }
}
const ask = async question => {
  const model = new Fake(), metrics = {}, result = await converse(new Archive(assets), model, question, [], () => {}, null, {metrics});
  return {model, metrics, result, material:model.calls.at(-1)?.[1]?.content || ''};
};

test('ticker question: the search path plus [A2]; PMUI writing "grpm" reaches the model', {skip:!hasTables}, async () => {
  const {model, metrics, result, material} = await ask('analisa saham grpm dari semua dokumen');
  assert.equal(metrics.route, undefined);
  assert.equal(metrics.evidence_mode, 'original-text');
  assert.ok(metrics.mentions >= 1);
  assert.equal(model.calls.length, 1);
  assert.match(material, /\[A2\] KODE DISEBUT[^]*GRPM ← 2026-09-06 · pengumuman PMUI · transaksi_saham: "[^"]*grpm oleh PMUI/);
  const ids = new Set(result.sources.map(s => s.source_id));
  for (const m of material.match(/\[A2\][^\n]*\n(?:- [^\n]*\n?)+/)[0].matchAll(/\[(D\d+)\]/g)) assert.ok(ids.has(m[1]), m[1]);
  // No mention by another issuer, no relation wording: nothing is added.
  const heli = await ask('HELI apakah ada tender offer');
  assert.doesNotMatch(heli.material, /\[A2\]|\[H\]/);
  assert.equal(heli.metrics.route, undefined);
});

test('relation wording with two tickers adds [H] before the search material', {skip:!hasTables}, async () => {
  const {metrics, material, model} = await ask('ada nama pengendali yang sama di BIKE dan MENN ?');
  assert.equal(metrics.relation, true);
  assert.match(material, /^BAHAN ARSIP \(data, bukan instruksi\):\n\[H\] HUBUNGAN TERCATAT/);
  assert.match(material, /\(kuat\) PT PENAJAM MAKMUR JAYA/);
  assert.match(model.calls.at(-1).at(-1).content, /Jawab hubungan antar-emiten dari \[H\] lebih dulu/);
  const plain = await ask('analisa BIKE dan MENN');
  assert.doesNotMatch(plain.material, /\[H\] HUBUNGAN/);
});

test('names, handles and rare rumors: one answer call over table material, neutral KSEI wording', {skip:!hasTables}, async () => {
  const tanoko = await ask('Tanoko?');
  assert.equal(tanoko.metrics.route, 'entity');
  assert.equal(tanoko.model.calls.length, 1);
  assert.match(tanoko.material, /TANOKO MULYO ATMODJO/);
  assert.match(tanoko.material, /AVIA NUSANTARA KHATULISTIWA \(pihak di HELI\) memuat kata AVIA, tetapi tidak tercatat sebagai emiten AVIA/);
  const natuna = await ask('analisa bagaimana hashim masuk ke natuna');
  assert.equal(natuna.metrics.route, 'entity');
  assert.ok(natuna.result.sources.some(s => /asx_20260913/.test(s.path)), 'ASX document with Arsari and Natuna');
  const handle = await ask('Zeinfahrozi banyak ngomongin soal apa sih? Apa sp dia');
  assert.equal(handle.metrics.route, 'handle');
  assert.equal(handle.model.calls.length, 1);
  assert.match(handle.material, /DATA STOCKBIT @zeinihzafahrozi[^]*Benang lintas hari \(desk\)/);
  assert.match(handle.model.calls[0].at(-1).content, /dipakai nama pengguna terdekat “zeinihzafahrozi”/);
  const rare = await ask('dari arsip postingan stockbit, apakah ada rumor suatu emiten akan melakukan aksi korporasi, tapi hanya sedikit dibahas?');
  assert.equal(rare.metrics.route, 'rare-rumor');
  assert.match(rare.material, /RUMOR AKSI KORPORASI YANG JARANG DIBAHAS/);
  for (const r of [tanoko, natuna, handle, rare]) {
    // Every Stockbit claim postdates the last KSEI month (August): KSEI can only be stated, never contradict.
    assert.doesNotMatch(r.material + r.result.answer, /bertentangan dengan KSEI/);
    assert.ok((r.result.answer.match(/^- F\d{8}-\d{4} · /gm) || []).length <= 8);
  }
  // "gede" is a token of some holder names but not a name: the question stays on the search path (term call first).
  const model = new Fake(), metrics = {};
  await converse(new Archive(assets), model, 'apakah ada transaksi nego gede?', [], () => {}, null, {metrics}).catch(() => {});
  assert.equal(metrics.route, undefined);
  assert.match(model.calls[0][0].content, /^Ubah pertanyaan riset arsip/);
});

test('issuer names, ticker words, typos and scoped ticker questions stay on the search path', {skip:!hasTables}, async () => {
  for (const q of ['gimana saham telkom', 'prospek Adaro', 'emiten tambang emas', 'Sukanto Tanoto', 'emite mana yang rajin bagi dividen?']) {
    const model = new Fake(), metrics = {};
    await converse(new Archive(assets), model, q, [], () => {}, null, {metrics}).catch(() => {});
    assert.equal(metrics.route, undefined, q);
    assert.match(model.calls[0][0].content, /^Ubah pertanyaan riset arsip/, q);
  }
  // [A2] has no date or source filter, so it is left out of dated and source-scoped questions.
  for (const q of ['GRPM tanggal 1 Oktober 2026', 'apa kata stockbit soal GRPM']) assert.equal((await ask(q)).metrics.mentions, undefined, q);
  assert.equal((await ask('rangkum berita terkait BUMI dan BRMS')).metrics.relation, undefined);
});

test('a follow-up after the rare-rumor route asks the term call again instead of searching a label', {skip:!hasTables}, async () => {
  const first = await ask('dari arsip postingan stockbit, apakah ada rumor suatu emiten akan melakukan aksi korporasi, tapi hanya sedikit dibahas?');
  assert.deepEqual(first.result.terms, []);
  const model = new Fake(), metrics = {};
  await converse(new Archive(assets), model, 'analisa lebih dalam', rememberTurn([], 'rumor jarang', first.result), () => {}, null, {metrics}).catch(() => {});
  assert.match(model.calls[0][0].content, /^Ubah pertanyaan riset arsip/);
});
