// Chat scope for the BEI daily summaries (bei-ringkasan/bei-detail/bei-pekan) next to the retired KI analyses.
import test from 'node:test';
import assert from 'node:assert/strict';
import {dateQuery, requestScope, scopeDocuments, documentRequest} from '../worker/retrieval.mjs';
import {sourceLabel, screeningGroups, screeningCounts} from '../worker/screening.mjs';

const doc = (name, cat, start, end = start, extra = {}) => ({name, cat, start, end, title:name, label:end, path:`files/${cat}/${start}/${name}`, ...extra});
const bei = d => doc(`beiringkas_${d}_${d}.md`, 'bei-ringkasan', d);
const detail = d => doc(`beidetail_${d}_${d}.md`, 'bei-detail', d, d, {priority:'low'});
const names = docs => docs?.map(d => d.name).sort();
const index = {docs:[
  doc('ki_02102026.md', 'keterbukaan-informasi', '2026-10-02'),
  doc('ki_05102026.md', 'keterbukaan-informasi', '2026-10-05'),
  bei('2026-10-05'), detail('2026-10-05'), bei('2026-10-06'), detail('2026-10-06'),
  doc('sbringkas_2026-10-06_2026-10-06.md', 'stockbit-ringkasan', '2026-10-06'),
  doc('sgx_29092026.md', 'keterbukaan-singapura', '2026-09-29'),
]};
const documents = (q, archive = index) => {
  const scope = dateQuery(q, [], [2026]);
  return documentRequest(q, scope, archive, requestScope(q, archive, scope.date?.slice(0,4)));
};

test('"bei", "ki" and "keterbukaan" read the BEI daily summary; detail only when asked', () => {
  assert.deepEqual(requestScope('ringkas BEI 6 oktober', index).categories, ['bei-ringkasan']);
  assert.deepEqual(names(documents('ringkas BEI 6 oktober')), ['beiringkas_2026-10-06_2026-10-06.md']);
  assert.deepEqual(names(documents('ringkas KI 6 oktober')), ['beiringkas_2026-10-06_2026-10-06.md']);
  // Days before the BEI summaries keep their retired KI analysis; a day a BEI file covers reads the retired
  // analysis only when asked for it ("KI lama", "analisis KI").
  assert.deepEqual(names(documents('baca KI 2 oktober')), ['ki_02102026.md']);
  assert.deepEqual(names(documents('ringkas keterbukaan 5 oktober')), ['beiringkas_2026-10-05_2026-10-05.md']);
  assert.deepEqual(names(documents('ringkas KI lama 5 oktober')), ['beiringkas_2026-10-05_2026-10-05.md', 'ki_05102026.md']);
  assert.deepEqual(names(documents('ringkas analisis KI 5 oktober')), ['beiringkas_2026-10-05_2026-10-05.md', 'ki_05102026.md']);
  assert.deepEqual(names(documents('BEI 6 oktober semua detail')),
    ['beidetail_2026-10-06_2026-10-06.md', 'beiringkas_2026-10-06_2026-10-06.md']);
  // A date without a source never pulls in the low-priority detail file.
  assert.deepEqual(names(documents('ringkas semua dokumen tanggal 6 oktober 2026')),
    ['beiringkas_2026-10-06_2026-10-06.md', 'sbringkas_2026-10-06_2026-10-06.md']);
  // Other sources keep their own scope.
  assert.ok(!names(documents('ringkas dokumen SGX')).some(n => n.startsWith('bei')));
});

test('newest Indonesian snapshot is the newest BEI summary, not an older retired KI analysis', () => {
  assert.deepEqual(names(documents('baca keterbukaan terbaru')), ['beiringkas_2026-10-06_2026-10-06.md']);
  assert.deepEqual(names(documents('keterbukaan terbaru sama stockbit terbaru')),
    ['beiringkas_2026-10-06_2026-10-06.md', 'sbringkas_2026-10-06_2026-10-06.md']);
  // Without any BEI summary the retired analysis is still the newest snapshot.
  const legacy = {docs:index.docs.filter(d => !d.cat.startsWith('bei-'))};
  assert.deepEqual(names(documents('baca keterbukaan terbaru', legacy)), ['ki_05102026.md']);
  // The discovery default (core.mjs) lists bei-ringkasan first; the retired analysis drops out once BEI is newer.
  const request = {categories:['bei-ringkasan','keterbukaan-informasi','stockbit-ringkasan','stockbit'], dates:[], pairs:[], latest:true};
  assert.deepEqual(names(scopeDocuments(index.docs, request, {latest:true})),
    ['beiringkas_2026-10-06_2026-10-06.md', 'sbringkas_2026-10-06_2026-10-06.md']);
});

test('ticker searches may read BEI detail; topic searches do not', () => {
  const request = {...requestScope('BBCA', index), stockbitDetail:true};
  assert.ok(scopeDocuments(index.docs, request).some(d => d.cat === 'bei-detail'));
  assert.ok(!scopeDocuments(index.docs, requestScope('rights issue', index)).some(d => d.cat === 'bei-detail'));
});

test('weekly BEI recaps replace daily summaries for ranges of more than two days', () => {
  const days = Array.from({length:9}, (_, i) => `2026-10-${String(5 + i).padStart(2,'0')}`);
  const archive = {docs:[...days.map(bei), doc('beipekan_2026-10-05_2026-10-11.md', 'bei-pekan', '2026-10-05', '2026-10-11')]};
  assert.deepEqual(names(documents('ringkas BEI 5 sampai 13 oktober 2026', archive)),
    ['beipekan_2026-10-05_2026-10-11.md', 'beiringkas_2026-10-12_2026-10-12.md', 'beiringkas_2026-10-13_2026-10-13.md']);
  assert.deepEqual(names(documents('ringkas BEI 6 dan 7 oktober', archive)),
    ['beiringkas_2026-10-06_2026-10-06.md', 'beiringkas_2026-10-07_2026-10-07.md']);
  assert.deepEqual(names(documents('baca BEI terbaru', archive)), ['beiringkas_2026-10-13_2026-10-13.md']);
});

test('paired source dates bind BEI and Stockbit separately', () => {
  const request = requestScope('BEI 5 oktober dan Stockbit 6 oktober', index);
  assert.deepEqual(request.pairs, [{category:'bei-ringkasan', dates:[{from:'2026-10-05', to:'2026-10-05'}]},
    {category:'stockbit', dates:[{from:'2026-10-06', to:'2026-10-06'}]}]);
  // The BEI file covers that day, so the retired KI analysis is not read next to it; Stockbit keeps its own date.
  assert.deepEqual(names(scopeDocuments(index.docs, request, {dates:true})),
    ['beiringkas_2026-10-05_2026-10-05.md', 'sbringkas_2026-10-06_2026-10-06.md']);
});

test('BEI summaries are labelled official summaries and rank with official screening sources', () => {
  assert.match(sourceLabel('bei-ringkasan'), /pengumuman resmi BEI/);
  assert.match(sourceLabel('bei-detail'), /bukan rekomendasi/);
  assert.equal(sourceLabel('keterbukaan-informasi'), null);
  const events = [
    {ticker:'ZZZZ', type:'rights_issue', kind:'stockbit', start:'2026-10-07', end:'2026-10-07', text:'rumor', source_id:'D1', line:1},
    {ticker:'BBCA', type:'rights_issue', kind:'bei', start:'2026-10-05', end:'2026-10-05', text:'HMETD', source_id:'D2', line:3}];
  const groups = screeningGroups(events, ['rights_issue']);
  assert.deepEqual(groups.map(g => g.ticker), ['BBCA', 'ZZZZ']);
  assert.deepEqual(screeningCounts(groups), {issuers:2, official:1, discussionOnly:1});
});

test('"digest" (the retired Digest Emiten) reads the BEI summaries instead of an empty category', () => {
  for (const q of ['digest BBCA terbaru', 'ringkas digest 6 oktober', 'digest emiten terbaru', 'ada apa di digest terbaru?'])
    assert.deepEqual(requestScope(q, index).categories, ['bei-ringkasan'], q);
  assert.deepEqual(names(documents('ringkas digest 6 oktober')), ['beiringkas_2026-10-06_2026-10-06.md']);
  assert.deepEqual(names(documents('digest emiten terbaru')), ['beiringkas_2026-10-06_2026-10-06.md']);
  assert.deepEqual(requestScope('digest BEI terbaru', index).categories, ['bei-ringkasan'], 'no duplicate category');
  // An explicit ticker may still read that day's BEI detail.
  const request = {...requestScope('digest BBCA terbaru', index), stockbitDetail:true};
  assert.ok(scopeDocuments(index.docs, request).some(d => d.cat === 'bei-detail'));
});
