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

test('full date endpoints form an inclusive range across text, numeric and ISO dates', () => {
  const days = ['2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05','2026-10-06'];
  const archive = {docs:days.map(day => doc(day,'stockbit',day))};
  const question = 'stockbit tanggal 3 oktober 2026 sampai tanggal 5 oktober 2026, ringkas semua, jangan hilangkan detail, ringkas dan urutkan dari yg plg menarik';
  const scope = dateQuery(question,[],[2026]);
  assert.equal(scope.filter,false);
  assert.deepEqual(requestScope(question,archive).dates,[{from:'2026-10-03',to:'2026-10-05'}]);
  assert.deepEqual(names(documentRequest(question,scope,archive)),['2026-10-03','2026-10-04','2026-10-05']);
  const ranges = [
    '30 september 2026 hingga 2 oktober 2026',
    '30 September sampai tanggal 2 October 2026',
    '30/9/2026 s/d 2/10/2026',
    '30/9 s/d tanggal 2/10',
    '30-9-2026 - 2-10-2026',
    '2026-09-30–2026-10-02',
    '2026-09-30—2026-10-02',
    '2026-09-30-2026-10-02',
    'September 30, 2026 sampai October 2, 2026',
  ];
  for (const range of ranges) {
    const q = 'ringkas Stockbit ' + range, request = requestScope(q,archive);
    assert.deepEqual(request.dates,[{from:'2026-09-30',to:'2026-10-02'}],range);
    assert.deepEqual(names(scopeDocuments(archive.docs,request,{dates:true})),days.slice(0,3),range);
    assert.equal(dateQuery(q,[],[2026]).filter,false,range);
  }
});

test('full ranges preserve separate date lists and source-specific periods', () => {
  const days = ['2026-09-30','2026-10-01','2026-10-02','2026-10-03','2026-10-04','2026-10-05'];
  const archive = {docs:['stockbit','keterbukaan-informasi'].flatMap(cat => days.map(day => doc(cat+' '+day,cat,day)))};
  for (const connector of ['dan',',','&']) {
    assert.deepEqual(requestScope('Stockbit 3 Oktober 2026 ' + connector + ' 5 Oktober 2026',archive).dates,
      [{from:'2026-10-03',to:'2026-10-03'},{from:'2026-10-05',to:'2026-10-05'}],connector);
  }
  const request = requestScope('Stockbit 30 September 2026 sampai tanggal 2 Oktober 2026 dan KI 3 Oktober 2026 hingga 5 Oktober 2026',archive);
  assert.deepEqual(request.pairs,[
    {category:'stockbit',dates:[{from:'2026-09-30',to:'2026-10-02'}]},
    {category:'keterbukaan-informasi',dates:[{from:'2026-10-03',to:'2026-10-05'}]},
  ]);
  assert.deepEqual(names(scopeDocuments(archive.docs,request,{dates:true})),[
    ...days.slice(3).map(day=>'keterbukaan-informasi '+day),...days.slice(0,3).map(day=>'stockbit '+day),
  ]);
  assert.deepEqual(requestScope('Stockbit 31 Desember 2026 sampai 2 Januari 2027',archive).dates,
    [{from:'2026-12-31',to:'2027-01-02'}]);
});

test('invalid or reversed complete ranges ask for correction without falling back to all documents', async () => {
  const {agentic} = await import('../worker/agent.mjs');
  const archive = {manifest:async () => ({...index,retrieval_version:'test'})};
  const forbidden = () => { throw Error('Invalid dates must not call the model or outside sources'); };
  for (const range of ['31 September 2026 sampai 2 Oktober 2026','3 Oktober 2026 hingga 32 Oktober 2026',
    '5 Oktober 2026 sampai tanggal 3 Oktober 2026','2026-10-05-2026-10-03','31/9/2026 s/d 2/10/2026']) {
    const question = 'ringkas semua Stockbit ' + range, scope = dateQuery(question,[],[2026]);
    assert.ok(scope.clarification,range);
    assert.deepEqual(documentRequest(question,scope,index),[],range);
    const stats = {};
    const result = await agentic({archive,question,model:{complete:forbidden,answer:forbidden,step:forbidden},
      env:{DATACAT_API_KEY:'test'},stats,emit:async()=>{},fetcher:forbidden,reserveQuota:forbidden});
    assert.equal(result.clarification,true,range);
    assert.equal(stats.agent_redirect,'document_request',range);
  }
  const history = [{role:'user',content:'ringkas Stockbit',context:{intent:'summary',
    scope:{categories:['stockbit'],dates:[],pairs:[],latest:true,all:false},date_scope:{date:null,filter:false}}}];
  for (const prefix of ['ringkas semua dokumen','dokumen terbaru']) {
    const result = await agentic({archive,history,question:prefix+' 5 Oktober 2026 sampai 3 Oktober 2026',
      model:{complete:forbidden,answer:forbidden,step:forbidden},env:{DATACAT_API_KEY:'test'},
      emit:async()=>{},fetcher:forbidden,reserveQuota:forbidden});
    assert.equal(result.clarification,true,prefix+' must retain invalid-date clarification in follow-up scope');
  }
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
