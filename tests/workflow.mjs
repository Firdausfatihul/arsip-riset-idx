// Offline behavioral regressions: source boundaries, actual selected content and continuation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {converse, rememberTurn, modelQuery, directTickers} from '../worker/core.mjs';

function fixture({large=false}={}) {
  const defs = [
    ['sgx_old.md','keterbukaan-singapura','2026-09-19','delisting lama'],
    ['sgx_new.md','keterbukaan-singapura','2026-09-20','delisting baru'],
    ['sgx_new.csv','keterbukaan-singapura','2026-09-20','delisting baru'],
    ['stockbit_25.md','stockbit','2026-09-25','HELI rumor lama'],
    ['stockbit_28.md','stockbit','2026-09-28','HELI rumor terbaru delisting'],
    ['ki_26.md','keterbukaan-informasi','2026-09-26','HELI rights issue delisting'],
    ['ki_20.md','keterbukaan-informasi','2026-09-20','ENRG rights issue']
  ];
  const bodies = new Map(), reads=[], searches=[];
  const docs=defs.map(([name,cat,date,body],i)=>{
    const d={source_id:'D'+(i+1),document_id:'stable-'+name,document_hash:'hash-'+name,asset:name+'.json',
      evidence_asset:name+'.evidence.json',name,title:name,label:date,start:date,end:date,cat,path:'files/'+name,sizes:[body.length]};
    if(name==='stockbit_28.md')d.covers=['2026-09-26','2026-09-28'];
    bodies.set(d.asset,body+(large ? ('\n'+body).repeat(70000) : ''));
    return d;
  });
  const index={docs,tickers:['HELI','ENRG','INDO'],wordTickers:['INDO'],commonWords:['jelaskan','apa','yang'],
    postings:{},handles:[],retrieval_version:'test-v1',version:'test',system:'Gunakan sumber.'};
  const archive={manifest:async()=>index,search:async terms=>{
    searches.push(terms);
    return docs.filter(d=>terms.some(t=>bodies.get(d.asset).toLowerCase().includes(t.toLowerCase())));
  },read:async name=>{
    reads.push(name); const d=docs.find(d=>d.asset===name || d.evidence_asset===name);
    assert.ok(d,'only known assets are read');
    const text=bodies.get(d.asset);
    return name===d.asset ? {parts:[{source_id:d.source_id,part:1,text}]} :
      {version:'test-v1',document_hash:d.document_hash,coverage:'full-source-partition',records:[{
        section_id:'s1',line:1,kind:'context',context:'',content:text,tickers:text.includes('HELI')?['HELI']:[],event_date:null}]};
  },events:async()=>({types:[{id:'delisting',label:'delisting',pattern:'delisting'}],names:{},events:docs.map(d=>({
    source_id:d.source_id,ticker:d.cat==='keterbukaan-singapura'?'SGX1':'HELI',type:'delisting',kind:'ki',
    start:d.start,end:d.end,line:1,text:'delisting '+d.name}))})};
  return {archive,index,docs,reads,searches};
}
function model(replies=[{intent:'search',terms:['delisting']}]) {
  const m={termCalls:0,notes:0,answers:[],complete:async messages=>{
    if(messages.at(-1).content.includes('Buat catatan')){m.notes++;return 'Bukti [D1].';}
    m.termCalls++;return JSON.stringify(replies[Math.min(m.termCalls-1,replies.length-1)]);
  },answer:async(messages,emit)=>{m.answers.push(messages);await emit({type:'delta',text:'Temuan tersedia.'});return 'Temuan tersedia.';}};
  return m;
}
const ask=(f,m,q,h=[],stats={})=>converse(f.archive,m,q,h,()=>{},null,{metrics:stats});
const paths=r=>r.sources.map(d=>d.path).sort();

test('SGX topic and retry keep SGX boundaries and do not read its CSV twin',async()=>{
  const f=fixture(),m=model([{terms:['absent']},{terms:['SGX','delisting']}]);
  const r=await ask(f,m,'keterbukaan singapura soal delisting apa aja');
  assert.deepEqual(paths(r),['files/sgx_new.md','files/sgx_old.md']);
  assert.ok(f.reads.every(x=>x.startsWith('sgx_')&&!x.includes('.csv')));
  assert.equal(m.termCalls,2);
});
test('broad screening also keeps source scope instead of using the global event table',async()=>{
  const f=fixture({large:true}),m=model(),stats={};
  const r=await ask(f,m,'SGX soal delisting',[],stats);
  assert.equal(r.screening,true);
  assert.ok(r.sources.every(x=>x.path.startsWith('files/sgx_')));
  assert.equal(stats.screening.issuers,1);
});
test('ticker queries respect the named source',async()=>{
  const f=fixture(),m=model();
  const r=await ask(f,m,'HELI di stockbit');
  assert.deepEqual(paths(r),['files/stockbit_25.md','files/stockbit_28.md']);
  assert.equal(m.termCalls,0);
});
test('SGX summary defaults to latest snapshot and follows stable document IDs',async()=>{
  const f=fixture(),m=model();
  const first=await ask(f,m,'baca SGX intinya apa');
  assert.deepEqual(paths(first),['files/sgx_new.md']);
  const history=rememberTurn([],'baca SGX intinya apa',first);
  f.index.docs.find(d=>d.name==='sgx_new.md').source_id='D99';
  const second=await ask(f,m,'jelaskan lebih dalam',history);
  assert.deepEqual(paths(second),['files/sgx_new.md']);
  assert.equal(second.sources[0].source_id,'D99');
  assert.equal(m.termCalls,0); assert.equal(f.searches.length,0);
});
test('follow-up on HELI retains entity; a new explicit ticker replaces it',async()=>{
  const f=fixture(),m=model();
  const first=await ask(f,m,'analisis HELI');
  const history=rememberTurn([],'analisis HELI',first);
  const follow=await ask(f,m,'Periksa dokumen diatas',history);
  assert.deepEqual(paths(follow),paths(first));
  assert.deepEqual(follow.terms,['HELI']);
  const next=await ask(f,m,'analisis ENRG',history);
  assert.deepEqual(paths(next),['files/ki_20.md']);
});
test('follow-up topic retains the SGX constraint',async()=>{
  const f=fixture(),m=model();
  const first=await ask(f,m,'SGX soal delisting');
  const second=await ask(f,m,'jelaskan lebih dalam',rememberTurn([],'SGX soal delisting',first));
  assert.deepEqual(paths(second),paths(first));
  assert.equal(m.termCalls,1);
});
test('explicit all expands a previous source summary without crossing source boundaries',async()=>{
  const f=fixture(),m=model();
  const first=await ask(f,m,'ringkas SGX');
  const next=await ask(f,m,'baca semua dokumen',rememberTurn([],'ringkas SGX',first));
  assert.deepEqual(paths(next),['files/sgx_new.md','files/sgx_old.md']);
});
test('a rumor-discovery request reads a bounded latest source even with empty model terms',async()=>{
  const f=fixture(),m=model([{terms:[]}]),stats={};
  const r=await ask(f,m,'dari arsip postingan stockbit, apakah ada rumor aksi korporasi tapi hanya sedikit dibahas?',[],stats);
  assert.deepEqual(paths(r),['files/stockbit_28.md']);assert.equal(stats.intent,'discover');
  assert.equal(m.termCalls,1);
});
test('model-selected discovery defaults visibly to latest IDX and Stockbit documents',async()=>{
  const f=fixture(),m=model([{intent:'discover',terms:[]}]),stats={};
  const r=await ask(f,m,'carikan peluang tersembunyi',[],stats);
  assert.deepEqual(paths(r),['files/ki_26.md','files/stockbit_28.md']);
  assert.equal(stats.default_scope,'latest-idx-stockbit');assert.equal(m.termCalls,1);
  assert.match(m.answers[0].at(-1).content,/bukan screening seluruh pasar/);
});
test('topic terms override an erroneous summary intent and preserve explicit dates',async()=>{
  const f=fixture(),m=model([{intent:'summary',terms:['SGX','delisting']}]);
  const r=await ask(f,m,'ringkas delisting SGX 20 September');
  assert.deepEqual(paths(r),['files/sgx_new.md']);assert.equal(r.context.intent,'search');
});
test('mixed source dates remain paired through the complete normal workflow',async()=>{
  const f=fixture(),m=model();
  const r=await ask(f,m,'baca 25 September di Stockbit dan 26 September di keterbukaan');
  assert.deepEqual(paths(r),['files/ki_26.md','files/stockbit_25.md']);assert.equal(m.termCalls,0);
});
test('model query parser is bounded and geographic indo is not ticker INDO',async()=>{
  const m=model([{intent:'invented',terms:['x','delisting','delisting']}]);
  assert.deepEqual(await modelQuery('q',[],m),{intent:'search',terms:['delisting']});
  assert.deepEqual(directTickers('Singapore backdoor di indo',fixture().index),[]);
  assert.deepEqual(directTickers('analisis saham INDO',fixture().index),['INDO']);
});
test('a new follow-up date selects that date in the inherited source, not old document IDs',async()=>{
  const f=fixture(),m=model();
  const first=await ask(f,m,'ringkas Stockbit 25 September');
  const history=rememberTurn([],'ringkas Stockbit 25 September',first);
  for(const q of ['dokumen tadi 28 September','September 28','kenapa ga ambil dokumen september 28?','yang terbaru']){
    const r=await ask(f,m,q,history);
    assert.deepEqual(paths(r),['files/stockbit_28.md'],q);
  }
});
test('latest source plus a topic never silently falls back to older matching documents',async()=>{
  const f=fixture(),m=model([{terms:['lama']},{terms:['lama']}]);
  await assert.rejects(ask(f,m,'stockbit terbaru soal lama'),/Belum ditemukan/);
  assert.equal(m.answers.length,0);
});
test('a new named subject with a date does not inherit the previous document request',async()=>{
  const f=fixture(),m=model([{terms:['rumor']}]);
  const first=await ask(f,m,'ringkas SGX');
  const next=await ask(f,m,'Rumor tanggal 25 September',rememberTurn([],'ringkas SGX',first));
  assert.ok(next.sources.every(d=>d.path.includes('stockbit')));
  assert.equal(next.context.intent,'search');assert.equal(m.termCalls,1);
});
test('a retry containing only the source name cannot satisfy a missing topic',async()=>{
  const f=fixture(),m=model([{terms:['missing-topic']},{terms:['SGX']}]);
  await assert.rejects(ask(f,m,'SGX soal missing-topic'),/Belum ditemukan/);
  assert.equal(m.answers.length,0);
});
test('the existing model call can refine a previous source to a new topic without widening sources',async()=>{
  const f=fixture(),m=model([{intent:'search',terms:['delisting'],followup:true}]);
  const first=await ask(f,m,'ringkas SGX');
  const next=await ask(f,m,'hanya soal delisting yang penting',rememberTurn([],'ringkas SGX',first));
  assert.ok(next.sources.every(d=>d.path.startsWith('files/sgx_')));
  assert.equal(next.context.intent,'search');assert.equal(m.termCalls,1);
});

test('single-source note placeholders map in every format without altering ticker text or final citations',async()=>{
  const f=fixture({large:true}),stats={};let notes=0;
  const m={complete:async()=>{notes++;return 'Bukti [D1], D1:s1, (D1), [D1:s1]; kode 1D1, D10, AD1 dan D1A.';},
    answer:async(messages,emit)=>{
      const context=JSON.parse(messages[1].content.split('\n')[1]);
      assert.ok(context.length>0&&context.every(c=>c.source_id==='D2'&&c.notes));
      for(const item of context)assert.equal(item.notes,'Bukti [D2], D2:s1, (D2), [D2:s1]; kode 1D1, D10, AD1 dan D1A.');
      const answer='Jawaban model masih salah rujukan [D1].';await emit({type:'delta',text:answer});return answer;
    }};
  const result=await ask(f,m,'baca SGX intinya apa',[],stats);
  assert.ok(notes>0);assert.deepEqual(stats.invalid_citations,['D1']);
  assert.match(result.answer,/salah rujukan \[D1\]/);
  assert.match(result.answer,/Rujukan D1 tidak termasuk sumber/);
});

test('compact answers receive one final reminder while explicit user lengths are preserved',async()=>{
  for(const question of ['ringkas SGX singkat padat','ringkas SGX singkat dalam 400 kata','ringkas SGX padat dalam dua paragraf']){
    const f=fixture(),m=model();await ask(f,m,question);
    const last=m.answers[0].at(-1).content;
    const reminders=last.match(/Jawab maksimal 250 kata total/g)||[];
    assert.equal(reminders.length,question==='ringkas SGX singkat padat'?1:0,question);
    assert.ok(last.startsWith(question));
  }
});

test('normal and screening answers validate grouped citations with the shared parser',async()=>{
  for(const screening of [false,true]){
    const f=fixture({large:screening}),m=model();
    m.answer=async(messages,emit)=>{const text='Bukti [D2;D99].';await emit({type:'delta',text});return text;};
    const result=await ask(f,m,screening?'SGX soal delisting':'ringkas SGX');
    assert.match(result.answer,/Rujukan D99 tidak termasuk sumber/);
    assert.match(result.answer,/\[D2;D99\]/);
  }
});
