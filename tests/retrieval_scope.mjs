import test from 'node:test';
import assert from 'node:assert/strict';
import {dateQuery, requestScope, scopeDocuments, documentRequest, crossMarketQuery} from '../worker/retrieval.mjs';

const doc = (name,cat,end,covers) => ({name,cat,start:end,end,title:name,label:end,...(covers ? {covers} : {})});
const index = {docs:[
  doc('stockbit_25092026.md','stockbit','2026-09-25'),
  doc('stockbit_28092026.md','stockbit','2026-09-28',['2026-09-26','2026-09-28']),
  doc('ki_26092026.md','keterbukaan-informasi','2026-09-26'),
  doc('sgx_older.md','keterbukaan-singapura','2026-09-10'),
  doc('sgx_all.csv','keterbukaan-singapura','2026-09-20'),
  doc('sgx_all.md','keterbukaan-singapura','2026-09-20'),
  doc('sgx_findings.md','keterbukaan-singapura','2026-09-20'),
  doc('asx_older.md','keterbukaan-australia','2026-09-01'),
  doc('asx_latest.md','keterbukaan-australia','2026-09-13'),
]};
const names = docs => docs?.map(d => d.name).sort();
const documents = q => documentRequest(q,dateQuery(q,[],[2026]),index);

test('separate source clauses bind dates; a shared range still covers both sources', () => {
  const q = 'coba baca arsip 25 september di stream stockbit dan 26 september di keterbukaan indonesia, apa yg plg hidden gems';
  assert.deepEqual(names(documents(q)), ['ki_26092026.md','stockbit_25092026.md']);
  assert.equal(requestScope(q,index).pairs.length,2);
  assert.deepEqual(names(documents('baca stockbit 25/9 sama KI 26/9')), ['ki_26092026.md','stockbit_25092026.md']);
  assert.deepEqual(names(documents('baca 25-26 september di stockbit dan keterbukaan indonesia')),
    ['ki_26092026.md','stockbit_25092026.md','stockbit_28092026.md']);
  assert.deepEqual(requestScope('stockbit 22 dan 25 september',index).dates,
    [{from:'2026-09-22',to:'2026-09-22'},{from:'2026-09-25',to:'2026-09-25'}]);
});

test('named source summaries choose newest snapshot and avoid CSV twins; all is explicit', () => {
  assert.deepEqual(names(documents('baca dokumen keterbukaan singapura / sgx, intinya apa?')),
    ['sgx_all.md','sgx_findings.md']);
  assert.deepEqual(names(documents('ringkas seluruh dokumen SGX')),
    ['sgx_all.md','sgx_findings.md','sgx_older.md']);
  assert.deepEqual(names(documents('ringkas dokumen asx')), ['asx_latest.md']);
  assert.deepEqual(names(documents('keterbukaan terbaru sama stockbit terbaru')),
    ['ki_26092026.md','stockbit_28092026.md']);
  assert.deepEqual(names(documents('ringkas SGX dan keterbukaan indonesia')),
    ['ki_26092026.md','sgx_all.md','sgx_findings.md']);
});

test('topics keep source scope without becoming whole-source summaries or imposing catalog dates', () => {
  for (const q of ['keterbukaan singapura soal delisting apa aja','ringkas SGX delisting',
    'ringkas SGX tentang delisting','ringkas delisting SGX 20 September']) {
    assert.equal(documents(q),null,q);
    const request = requestScope(q,index);
    assert.deepEqual(request.categories,['keterbukaan-singapura']);
    assert.ok(scopeDocuments(index.docs,request).every(d => d.cat === 'keterbukaan-singapura'));
    assert.ok(scopeDocuments(index.docs,request).some(d => d.name === 'sgx_older.md'));
  }
  assert.equal(documents('rights issue september siapa aja'),null);
  assert.deepEqual(requestScope('SGX dan KI',index).categories,
    ['keterbukaan-singapura','keterbukaan-informasi']);
});

test('latest topic scope and geographic indo require no model to interpret source', () => {
  const request = requestScope('stockbit terbaru soal delisting',index);
  assert.deepEqual(names(scopeDocuments(index.docs,request,{latest:request.latest})), ['stockbit_28092026.md']);
  assert.deepEqual(crossMarketQuery('emiten indo yang berhubungan dengan asx / singapur')?.terms,
    ['ASX','Australia','Australian','SGX','Singapura','Singapore','Singapur']);
  assert.equal(crossMarketQuery('analisis saham INDO'),null);
  assert.equal(crossMarketQuery('saham INDO terkait SGX'),null);
  assert.deepEqual(crossMarketQuery('SGX backdoor di indo')?.terms,
    ['SGX','Singapura','Singapore','Singapur']);
});

test('month-first correction uses the existing date scope and empty index fixtures remain valid', () => {
  assert.equal(dateQuery('september 22',[],[2026]).date,'2026-09-22');
  assert.equal(dateQuery('September 22 2026').date,'2026-09-22');
  assert.equal(dateQuery('September 22, 2026').date,'2026-09-22');
  assert.deepEqual(requestScope('baca KI september 26',index).dates,
    [{from:'2026-09-26',to:'2026-09-26'}]);
  assert.deepEqual(names(documents('baca KI september 26')),['ki_26092026.md']);
  assert.deepEqual(requestScope('jelaskan lagi',{}).categories,[]);
});
