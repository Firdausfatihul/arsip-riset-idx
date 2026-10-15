import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceStore} from '../worker/source-store.mjs';
import {Archive,converse,OpenRouter,CacheStore} from '../worker/core.mjs';
import {jsonBytes} from '../worker/text.mjs';
import {tickerDocuments} from './helpers/archive-expectations.mjs';
import {readAsset} from './helpers/archive.mjs';
import {hash} from '../worker/cache.mjs';
import {storage} from '../local/sqlite-storage.mjs';
const manifest=await readAsset('manifest.json');
function fixture(){
 const {db,storage:s}=storage();
 return {db,store:new SourceStore({storage:s})};
}
const evidence=doc=>readAsset(doc.evidence_asset);
test('source import verifies hashes, is atomic/idempotent, and only trusts active document versions',async()=>{
 const {store,db}=fixture(),doc=manifest.docs[0],data=await evidence(doc);
 const bad=structuredClone(data);bad.records[0].content+='changed';
 await assert.rejects(store.importDocument(manifest,doc,bad),/integrity/);
 assert.equal(store.status(manifest).ready,0);
 db.exec("CREATE TRIGGER fail_import BEFORE INSERT ON source_passages WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'simulated storage failure'); END");
 await assert.rejects(store.importDocument(manifest,doc,data),/storage failure/);
 assert.equal(store.status(manifest).ready,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM source_passages').get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM source_fts').get().n,0);
 db.exec('DROP TRIGGER fail_import');
 await store.importDocument(manifest,doc,data);
 const before=db.prepare('SELECT COUNT(*) n FROM source_passages').get().n;
 assert.equal((await store.importDocument(manifest,doc,data)).skipped,true);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM source_passages').get().n,before);
 assert.deepEqual(store.read(doc,manifest).records,data.records);
 assert.equal(store.read({...doc,document_hash:'new'},manifest),null);
 assert.equal(store.status(manifest).ready,1);db.close();
});
test('full archive queries use SQLite, retain known evidence and finish cross-market screening without asset reads',async()=>{
 const {store,db}=fixture();
 await store.importPending(manifest,evidence);
 assert.equal(store.status(manifest).ready,manifest.docs.length);
 const archive=new Archive({fetch:()=>{throw Error('No per-query asset fetch allowed');}},store);archive.index=Promise.resolve(manifest);
 const expected=await tickerDocuments(manifest,'SOCI');assert.ok(expected.length>0);
 assert.deepEqual((await archive.search(['SOCI'])).map(d=>d.source_id).sort(),expected.map(d=>d.source_id).sort());
 assert.deepEqual(await archive.search(['" OR *; DROP TABLE source_passages; --']),[]);
 const terms=['ASX','Australia','SGX','Singapore','Singapura'];
 // Source IDs and reports change; use an active SGX research document, not the removed chronology.
 const SGX=manifest.docs.find(d=>d.cat==='keterbukaan-singapura' && /temuan_utama\.md$/.test(d.name)).source_id;
 const docs=await archive.search(terms);assert.ok(docs.some(d=>d.source_id==='D3'));assert.ok(docs.some(d=>d.source_id===SGX));
 let messages,notes=0;const calls=[];const stats={};const cache=new CacheStore(store.sql);
 const model={complete:async(m,options)=>{calls.push(m);if(options?.jsonMode){const rows=JSON.parse(m[1].content);return JSON.stringify({ids:rows.filter(r=>['D3',SGX].includes(r.source)).map(r=>r.id)});}notes++;return 'Catatan sumber [D1].';},answer:async(m,emit)=>{messages=m;await emit({type:'delta',text:`Hubungan yang perlu diverifikasi [${SGX}].`});return `Hubungan yang perlu diverifikasi [${SGX}].`;}};
 const result=await converse(archive,model,'simpulkan emiten indonesia yg berhubungan atau baru akuisisi dari asx / singapur',[],async()=>{},new AbortController().signal,{metrics:stats,cache});
 assert.ok(result.documents>2);assert.equal(notes,0);assert.ok(stats.candidates_selected<stats.candidates_found);
 const payload=JSON.stringify([...calls,messages]);
 for(const anchor of ['Orbit Marketing','ERA Graharealty','Marco Polo','KORIKA','Bintan Investment Management'])assert.ok(payload.includes(anchor),anchor);
 assert.ok(jsonBytes(messages)<350000);assert.ok(stats.database_source_reads>0);
 console.log(JSON.stringify({thematicBytes:jsonBytes(messages),documents:result.documents,sourceReads:stats.database_source_reads,modelCalls:calls.length+1}));
 const second={};const before=calls.length;
 await converse(archive,model,'Jelaskan hubungan emiten Indonesia dengan ASX dan Singapura',[],async()=>{},new AbortController().signal,{metrics:second,cache});
 assert.equal(second.candidate_cache_hit,true);assert.equal(calls.length,before);assert.equal(second.source_cache_hits,second.documents_checked);
 db.close();
});

test('truncated streams retain trailing usage before reporting incomplete output',async()=>{
 const chunks=[{id:'test',choices:[{delta:{content:'partial'},finish_reason:'length'}]},
  {choices:[],usage:{prompt_tokens:100,completion_tokens:10,cost:0.001}}];
 const model=new OpenRouter('offline',null,async()=>new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n'));
 await assert.rejects(model.stream([],{},()=>{}),e=>e.code==='length');
 assert.equal(model.usage().missing_usage_calls,0);assert.equal(model.usage().known_cost_usd,0.001);
});

// Synthetic manifest: independent of worker/.assets, so the cleanup rules are tested on their own.
async function synthetic(version,docs){
 const out={version:'m-'+version,retrieval_version:version,tickers:['SOCI'],docs:[]},data={};
 for(const [id,texts] of Object.entries(docs)){
  const records=texts.map((content,i)=>({content,context:'ctx '+i,line:i+1})),document_hash=await hash(texts.join(''));
  const doc={document_id:id,document_hash,title:'Judul '+id,name:id+'.md',end:'2026-10-01'};
  out.docs.push(doc);data[id]={version,document_id:id,document_hash,coverage:'full-source-partition',records};
 }
 return {index:out,data};
}
const counts=db=>Object.fromEntries(['source_documents','source_passages','source_fts'].map(t=>[t,db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]));
const load=(store,{index,data})=>store.importPending(index,doc=>data[doc.document_id]);

test('prune removes documents of an older evidence version or hash, idempotently, and keeps every active key',async()=>{
 const {db,store}=fixture();
 const old=await synthetic('issuer-passages-v2',{a:['SOCI kapal ','tanker'],b:['Rights issue SOCI']});
 const now=await synthetic('issuer-passages-v3',{a:['SOCI kapal ','tanker'],b:['Rights issue SOCI ','HMETD'],c:['dokumen baru']});
 await load(store,old);
 // An empty or version-less manifest (failed load) never removes anything.
 for(const bad of [{docs:[],retrieval_version:'issuer-passages-v3'},{docs:now.index.docs},null])
  assert.deepEqual(store.prune(bad),{removed:0,records:0});
 assert.deepEqual(counts(db),{source_documents:2,source_passages:3,source_fts:3});
 await load(store,now);
 // Active a under v2 is unchanged text but a different key (version is part of it): both copies exist until pruned.
 assert.deepEqual(counts(db),{source_documents:5,source_passages:8,source_fts:8});
 const before=JSON.stringify(now.index.docs.map(d=>store.read(d,now.index)));
 assert.deepEqual(store.prune(now.index),{removed:2,records:3});
 assert.deepEqual(counts(db),{source_documents:3,source_passages:5,source_fts:5});
 assert.equal(JSON.stringify(now.index.docs.map(d=>store.read(d,now.index))),before);
 assert.equal(store.status(now.index).ready,3);assert.deepEqual(store.status(now.index).pending,[]);
 for(const d of old.index.docs)assert.equal(store.read(d,old.index),null);
 // FTS rows of removed passages are gone; active ones are still found.
 assert.deepEqual(store.search(now.index,['HMETD']).map(d=>d.document_id),['b']);
 assert.deepEqual(store.search(now.index,['SOCI']).map(d=>d.document_id).sort(),['a','b']);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM source_fts WHERE source_fts MATCH 'tanker'").get().n,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM source_fts WHERE rowid NOT IN (SELECT id FROM source_passages)').get().n,0);
 // Idempotent.
 assert.deepEqual(store.prune(now.index),{removed:0,records:0});
 assert.deepEqual(counts(db),{source_documents:3,source_passages:5,source_fts:5});
 // A changed hash for one document removes only that document's previous copy.
 const next=await synthetic('issuer-passages-v3',{a:['SOCI kapal ','tanker'],b:['Rights issue SOCI ','HMETD'],c:['dokumen baru, revisi']});
 await load(store,next);
 assert.deepEqual(store.prune(next.index),{removed:1,records:1});
 assert.deepEqual(counts(db),{source_documents:3,source_passages:5,source_fts:5});
 assert.equal(store.read(now.index.docs[2],now.index),null);assert.ok(store.read(next.index.docs[2],next.index));
 db.close();
});

test('prune waits until the active version is fully imported (a half-done start keeps both versions)',async()=>{
 const {db,store}=fixture();
 const old=await synthetic('issuer-passages-v2',{a:['satu ','dua'],b:['tiga']}),now=await synthetic('issuer-passages-v3',{a:['satu ','dua'],b:['tiga']});
 await load(store,old);
 await store.importDocument(now.index,now.index.docs[0],now.data.a);
 assert.deepEqual(store.prune(now.index),{removed:0,records:0,deferred:true});
 assert.deepEqual(counts(db),{source_documents:3,source_passages:5,source_fts:5});
 // The rolled-back copy (old manifest, complete) keeps the partial rows of the newer version for the next push.
 assert.deepEqual(store.prune(old.index),{removed:0,records:0});
 await load(store,now);
 assert.equal(store.status(now.index).pending.length,0);
 assert.deepEqual(store.prune(now.index),{removed:2,records:3});
 assert.deepEqual(counts(db),{source_documents:2,source_passages:3,source_fts:3});db.close();
});

test('prune is transactional per document: a failure leaves the document whole and a rerun finishes it',async()=>{
 const {db,store}=fixture();
 const old=await synthetic('issuer-passages-v2',{a:['satu ','dua'],b:['tiga']}),now=await synthetic('issuer-passages-v3',{c:['empat']});
 await load(store,old);await load(store,now);
 db.exec("CREATE TRIGGER fail_prune BEFORE DELETE ON source_documents WHEN OLD.doc_key LIKE '%:a:%' BEGIN SELECT RAISE(ABORT,'simulated prune failure'); END");
 assert.throws(()=>store.prune(now.index),/prune failure/);
 const a=old.index.docs[0];
 assert.ok(store.read(a,old.index),'failed document still complete');
 assert.equal(store.read(a,old.index).records.length,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM source_fts WHERE rowid NOT IN (SELECT id FROM source_passages)').get().n,0);
 db.exec('DROP TRIGGER fail_prune');
 const rest=store.prune(now.index);assert.ok(rest.removed>=1);
 assert.deepEqual(counts(db),{source_documents:1,source_passages:1,source_fts:1});
 assert.ok(store.read(now.index.docs[0],now.index));db.close();
});
