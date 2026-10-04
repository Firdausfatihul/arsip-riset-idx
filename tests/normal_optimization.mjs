import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {converse,CacheStore,hash} from '../worker/core.mjs';

function fixture() {
  const db=new DatabaseSync(':memory:');
  const sql={exec(q,...args){const s=db.prepare(q),rows=s.columns().length?s.all(...args):(s.run(...args),[]);return {toArray:()=>rows};}};
  const cache=new CacheStore(sql),bodies=['ALFA alpha beta. '.repeat(22500),'SGX temuan singkat.','Stockbit tambahan.'];
  const docs=bodies.map((body,i)=>({source_id:'D'+(i+2),document_id:'stable-'+i,document_hash:'hash-'+i,
    name:'document-'+i+'.md',title:'Document '+i,cat:i===2?'stockbit':'keterbukaan-singapura',
    path:'files/document-'+i+'.md',start:'2026-09-20',end:'2026-09-20',label:'20 September 2026',
    asset:'raw-'+i,evidence_asset:'evidence-'+i,sizes:[body.length]}));
  const index={docs,tickers:['ALFA'],commonWords:[],handles:[],postings:{},system:'Gunakan bukti.',
    version:'archive-v1',retrieval_version:'evidence-v1',asset_hashes:{'events.json':'events-v1'}};
  const archive={manifest:async()=>index,search:async terms=>docs.filter((d,i)=>terms.some(t=>bodies[i].includes(t))),
    read:async asset=>{const i=docs.findIndex(d=>d.asset===asset||d.evidence_asset===asset),d=docs[i];assert.ok(d);
      return asset===d.asset?{parts:[{source_id:d.source_id,part:1,text:bodies[i]}]}:
        {version:index.retrieval_version,document_hash:d.document_hash,coverage:'full-source-partition',records:[{
          section_id:'section',line:1,kind:'context',context:'',content:bodies[i],tickers:['ALFA'],event_date:null}]};},
    events:async()=>({names:{},types:[],events:[]})};
  return {db,cache,archive,index,docs,bodies};
}
function model() {
  const result={notes:[],termCalls:0,answers:0,complete:async(messages,options)=>{
    if(options?.jsonMode){result.termCalls++;return JSON.stringify({terms:[messages.at(-1).content.includes('beta')?'beta':'alpha']});}
    result.notes.push({raw:await hash(messages[1].content),instruction:messages.at(-1).content});return 'Catatan [D1].';
  },answer:async()=>{result.answers++;return 'Temuan [D2].';}};
  return result;
}
const ask=(f,m,q,stats={})=>converse(f.archive,m,q,[],()=>{},null,{cache:f.cache,metrics:stats});

test('whole-document notes reuse the same focus; companion sources only reuse unchanged evidence',async()=>{
  const f=fixture(),m=model();try {
    const first={};await ask(f,m,'ringkas SGX',first);const before=m.notes.length;
    assert.ok(before>0);const second={};await ask(f,m,'baca SGX',second);
    assert.equal(m.notes.length,before);assert.equal(second.note_reads,0);
    assert.equal(second.note_cache_hits,first.note_reads);assert.equal(second.source_cache_hits,2);
    const added={};const result=await ask(f,m,'ringkas SGX dan Stockbit',added);
    assert.equal(m.notes.length,before*2);assert.equal(added.note_reads,before);
    assert.equal(added.note_cache_hits,0);assert.equal(added.source_cache_hits,2);
    assert.deepEqual(result.sources.map(d=>d.source_id),['D2','D3','D4']);
    assert.ok(m.notes.every(n=>n.instruction.includes('Document 0')&&n.instruction.includes('Document 1')));
    assert.ok(m.notes.slice(0,before).every(n=>!n.instruction.includes('Document 2')));
    assert.ok(m.notes.slice(before).every(n=>n.instruction.includes('Document 2')));
  } finally {f.db.close();}
});

test('topic focuses remain distinct even when their selected raw evidence is identical',async()=>{
  const f=fixture(),m=model();try {
    await ask(f,m,'SGX soal alpha');const before=m.notes.length;assert.ok(before>0);
    const stats={};await ask(f,m,'SGX soal beta',stats);assert.equal(stats.note_cache_hits,0);
    assert.equal(m.notes.length,before*2);
    // Concurrent note readers may finish in a different order; compare the complete
    // multiset of evidence hashes while retaining the focus/cache assertions above.
    assert.deepEqual(m.notes.slice(0,before).map(n=>n.raw).sort(),m.notes.slice(before).map(n=>n.raw).sort());
    assert.ok(m.notes.slice(before).every(n=>n.instruction.includes('tentang beta.')));
  } finally {f.db.close();}
});

test('actual note instructions invalidate notes; auxiliary event changes invalidate answers only',async()=>{
  const f=fixture(),m=model();try {
    await ask(f,m,'ringkas SGX');const notes=m.notes.length;
    f.index.asset_hashes['ownership.json']='ownership-v2';
    const ownership={};await ask(f,m,'ringkas SGX',ownership);assert.equal(ownership.answer_cache_hit,true);
    f.index.asset_hashes['events.json']='events-v2';
    const events={};await ask(f,m,'ringkas SGX',events);assert.equal(events.answer_cache_hit,false);
    assert.equal(events.note_cache_hits,notes);assert.equal(m.notes.length,notes);
    f.index.system+=' Pertahankan tanggal.';
    const changed={};await ask(f,m,'ringkas SGX',changed);assert.equal(changed.note_cache_hits,0);
    assert.equal(m.notes.length,notes*2);
  } finally {f.db.close();}
});

test('whole-document expansion uses already selected documents without another term model call',async()=>{
  const f=fixture(),m=model();try {
    m.answer=async(messages,emit)=>{m.answers++;const text=m.answers===1?'[[SUMBER:D2]]':'Sumber lengkap [D2].';await emit({type:'delta',text});return text;};
    const stats={};const result=await ask(f,m,'ringkas SGX',stats);
    assert.equal(m.termCalls,0);assert.equal(stats.original_document_reads,1);assert.equal(m.answers,2);
    assert.match(result.answer,/Sumber lengkap/);
  } finally {f.db.close();}
});
