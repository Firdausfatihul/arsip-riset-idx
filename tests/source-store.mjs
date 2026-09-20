import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {SourceStore} from '../worker/source-store.mjs';
import {Archive,converse,size,OpenRouter,CacheStore} from '../worker/core.mjs';
const manifest=JSON.parse(await readFile(new URL('../worker/.assets/manifest.json',import.meta.url),'utf8'));
function fixture(){
 const db=new DatabaseSync(':memory:');
 const sql={exec(q,...args){const s=db.prepare(q),rows=s.columns().length?s.all(...args):(s.run(...args),[]);return {toArray:()=>rows};}};
 const ctx={storage:{sql,transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 return {db,store:new SourceStore(ctx)};
}
const evidence=async doc=>JSON.parse(await readFile(new URL('../worker/.assets/'+doc.evidence_asset,import.meta.url),'utf8'));
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
 for(const doc of manifest.docs)await store.importDocument(manifest,doc,await evidence(doc));
 assert.equal(store.status(manifest).ready,manifest.docs.length);
 const archive=new Archive({fetch:()=>{throw Error('No per-query asset fetch allowed');}},store);archive.index=Promise.resolve(manifest);
 assert.equal((await archive.search(['SOCI'])).length,8);
 assert.deepEqual(await archive.search(['" OR *; DROP TABLE source_passages; --']),[]);
 const terms=['ASX','Australia','SGX','Singapore','Singapura'];
 const docs=await archive.search(terms);assert.ok(docs.some(d=>d.source_id==='D3'));assert.ok(docs.some(d=>d.source_id==='D41'));
 let messages,notes=0;const calls=[];const stats={};const cache=new CacheStore(store.sql);
 const model={complete:async(m,options)=>{calls.push(m);if(options?.jsonMode){const rows=JSON.parse(m[1].content);return JSON.stringify({ids:rows.filter(r=>['D3','D41'].includes(r.source)).map(r=>r.id)});}notes++;return 'Catatan sumber [D1].';},answer:async(m,emit)=>{messages=m;await emit({type:'delta',text:'Hubungan yang perlu diverifikasi [D41].'});return 'Hubungan yang perlu diverifikasi [D41].';}};
 const result=await converse(archive,model,'simpulkan emiten indonesia yg berhubungan atau baru akuisisi dari asx / singapur',[],async()=>{},new AbortController().signal,{metrics:stats,cache});
 assert.ok(result.documents>2);assert.equal(notes,0);assert.ok(stats.candidates_selected<stats.candidates_found);
 const payload=JSON.stringify([...calls,messages]);
 for(const anchor of ['Orbit Marketing','ERA Graharealty','Marco Polo','KORIKA','Bintan Investment Management'])assert.ok(payload.includes(anchor),anchor);
 assert.ok(size(messages)<350000);assert.ok(stats.database_source_reads>0);
 console.log(JSON.stringify({thematicBytes:size(messages),documents:result.documents,sourceReads:stats.database_source_reads,modelCalls:calls.length+1}));
 const second={};const before=calls.length;
 await converse(archive,model,'Jelaskan hubungan emiten Indonesia dengan ASX dan Singapura',[],async()=>{},new AbortController().signal,{metrics:second,cache});
 assert.equal(second.candidate_cache_hit,true);assert.equal(calls.length,before);assert.equal(second.source_cache_hits,result.documents);
 db.close();
});

test('truncated streams retain trailing usage before reporting incomplete output',async()=>{
 const chunks=[{id:'test',choices:[{delta:{content:'partial'},finish_reason:'length'}]},
  {choices:[],usage:{prompt_tokens:100,completion_tokens:10,cost:0.001}}];
 const model=new OpenRouter('offline',null,async()=>new Response(chunks.map(c=>'data: '+JSON.stringify(c)+'\n\n').join('')+'data: [DONE]\n\n'));
 await assert.rejects(model.stream([],{},()=>{}),e=>e.code==='length');
 assert.equal(model.usage().missing_usage_calls,0);assert.equal(model.usage().known_cost_usd,0.001);
});
