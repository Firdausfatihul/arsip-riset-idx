import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {Archive, CacheStore, OpenRouter, converse, size} from '../worker/core.mjs';
import {dateQuery,filterRecords,selectRecords} from '../worker/retrieval.mjs';

function cacheFixture() {
 const db=new DatabaseSync(':memory:');
 const sql={exec(query,...args){const stmt=db.prepare(query);const rows=stmt.columns().length?stmt.all(...args):(stmt.run(...args),[]);return {toArray:()=>rows};}};
 return {db,sql,cache:new CacheStore(sql)};
}
const archive=new Archive({fetch:async r=>new Response(await readFile(new URL('../worker/.assets'+new URL(r.url).pathname,import.meta.url)))});
class Fake {
 constructor(){this.calls=[];}
 async complete(m,o){this.calls.push(m);if(o.jsonMode)return '{"terms":["SOCI"]}';await o.onActivity?.();return 'Bukti [D1].';}
 async answer(m,emit){this.calls.push(m);await emit({type:'delta',text:'Bukti SOCI [D47].'});return 'Bukti SOCI [D47].';}
}
test('all source partitions reconstruct originals, including scripts, tables and every ticker occurrence',async()=>{
 const index=await archive.manifest();
 for(const doc of index.docs){
  const d=await archive.read(doc.evidence_asset),raw=(await archive.read(doc.asset)).parts.map(p=>p.text).join('');
  assert.equal(d.records.map(r=>r.content).join(''),raw,doc.name);
  let end=0;for(const r of d.records){assert.equal(r.start,end);assert.equal(raw.slice(r.start,r.end),r.content);end=r.end;}
  assert.equal(end,raw.length);
  for(const r of d.records) if(/\bSOCI\b/i.test(r.content))assert.ok(r.tickers.includes('SOCI'));
 }
});
test('SOCI uses all eight sources and raw issuer text with >95% lower model input; exact answer reuses across clients',async()=>{
 const {db,cache}=cacheFixture();const metrics={},model=new Fake();
 const first=await converse(archive,model,'di soci ada apa ya?',[],()=>{},null,{cache,metrics,client:'a'});
 assert.equal(first.documents,8);assert.equal(model.calls.length,1);assert.equal(metrics.fallback_documents,0);
 assert.ok(size(model.calls[0])<metrics.baseline_source_bytes*0.05);
 const prompt=JSON.stringify(model.calls[0]);assert.match(prompt,/7\.059\.000\.000/);assert.match(prompt,/14,09%/);
 const next=new Fake(),repeat={};await converse(archive,next,'di soci ada apa ya?',[],()=>{},null,{cache,metrics:repeat,client:'b'});
 assert.equal(next.calls.length,0);assert.equal(repeat.answer_cache_hit,true);
 const different=new Fake(),stats={};await converse(archive,different,'SOCI tanggal 17 September 2026',[],()=>{},null,{cache,metrics:stats,client:'b'});
 assert.equal(different.calls.length,1);assert.equal(stats.source_cache_hits,8);assert.ok(stats.excluded_dated_records>0);
 db.close();
});
test('dates: full/ISO, unknown, invalid, ranges, and short followup; unknown source dates are retained',()=>{
 assert.ok(dateQuery('SOCI tggl 17').clarification);
 assert.equal(dateQuery('SOCI 2026-09-17').filter,true);
 assert.ok(dateQuery('SOCI 2026-02-31').clarification);
 assert.equal(dateQuery('SOCI sejak 17 September 2026').filter,false);
 assert.equal(dateQuery('SOCI 17-19 September 2026').filter,false);
 assert.equal(dateQuery('SOCI tgl 17',[{role:'user',content:'SOCI 19 September 2026'}]).date,'2026-09-17');
 assert.equal(dateQuery('September 2026',[{role:'user',content:'SOCI tgl 17'}]).date,'2026-09-17');
 const rows=[{event_date:null},{event_date:'2026-09-16'},{event_date:'2026-09-17'},{event_date:'2026-09-16',dates_mentioned:['2026-09-17']}];
 assert.deepEqual(filterRecords(rows,dateQuery('SOCI 2026-09-17')).rows,[rows[0],rows[2],rows[3]]);
});
test('ambiguous date costs zero model calls and leaves cache untouched',async()=>{
 const m=new Fake(),r=await converse(archive,m,'SOCI tgl 17',[],()=>{});
 assert.equal(m.calls.length,0);assert.ok(r.clarification);
});
test('shared notes are question independent; failed notes are not cached; concurrent work joins; persisted cache survives restart',async()=>{
 const {db,sql,cache}=cacheFixture();let calls=0;
 const compute=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return {notes:'public evidence'};};
 const values=await Promise.all([cache.once('notes','k',compute),cache.once('notes','k',compute)]);
 assert.equal(calls,1);assert.equal(values[1].shared,true);
 assert.deepEqual(new CacheStore(sql).get('notes','k'),{notes:'public evidence'});
 await assert.rejects(cache.once('notes','bad',async()=>{throw Error('truncated');}));assert.equal(cache.get('notes','bad'),null);
 db.prepare('UPDATE evidence_cache SET expires=0').run();assert.equal(cache.get('notes','k'),null);
 db.close();
});
test('question changes reuse expensive source notes; document hash and client history invalidate correctly',async()=>{
 const {db,cache}=cacheFixture();let hash='h1';
 const doc={source_id:'D47',asset:'raw',evidence_asset:'evidence',title:'SOCI',path:'files/soci.md',label:'2026',name:'soci',end:'2026',sizes:[95000],document_id:'stable'};
 const large={manifest:async()=>({retrieval_version:'v1',version:hash,system:'Data only.',tickers:['SOCI'],commonWords:[]}),
  search:async()=>[{...doc,document_hash:hash}],read:async()=>({version:'v1',document_hash:hash,coverage:'full-source-partition',records:[{section_id:'s',kind:'issuer_section',context:'SOCI',tickers:['SOCI'],content:'SOCI '+'Bukti tentang kapal. '.repeat(20000)}]})};
 const m1=new Fake(),stats={};await converse(large,m1,'SOCI',[],()=>{},null,{cache,metrics:stats});assert.ok(stats.note_reads>0);
 const m2=new Fake(),stats2={};await converse(large,m2,'SOCI risikonya?',[],()=>{},null,{cache,metrics:stats2});assert.equal(stats2.note_reads,0);assert.ok(stats2.note_cache_hits>0);
 const noteRequests=m1.calls.filter(m=>m.at(-1).content.includes('Buat catatan'));assert.ok(noteRequests.every(m=>!m.some(v=>v.role==='assistant')));
 hash='h2';const stats3={};await converse(large,new Fake(),'SOCI',[],()=>{},null,{cache,metrics:stats3});assert.ok(stats3.note_reads>0);
 const history=[{role:'user',content:'SOCI'},{role:'assistant',content:'Private conversation context.'}];
 await converse(archive,new Fake(),'SOCI laba?',history,()=>{},null,{cache,client:'client-a'});
 const other=new Fake();await converse(archive,other,'SOCI laba?',history,()=>{},null,{cache,client:'client-b'});assert.ok(other.calls.length>0);
 db.close();
});
test('missing evidence index falls back to full original for that source',async()=>{
 const index=await archive.manifest();const one=index.docs.find(d=>d.source_id==='D47');
 const missing={manifest:async()=>index,search:async()=>[one],read:async path=>{if(path.endsWith('.evidence.json'))throw Error('missing');return archive.read(path);}};
 const stats={};await converse(missing,new Fake(),'SOCI',[],()=>{},null,{metrics:stats});assert.equal(stats.fallback_documents,1);
});
test('actual provider usage, cached tokens and cost are captured; missing usage never counts as confirmed free',async()=>{
 const model=new OpenRouter('test',null,async()=>new Response([
  {id:'g1',choices:[{delta:{content:'ok'}}]},
  {choices:[{finish_reason:'stop'}]},
  {usage:{prompt_tokens:2000,completion_tokens:10,cost:0.0001,prompt_tokens_details:{cached_tokens:1500,cache_write_tokens:0}}}
 ].map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')));
 await model.answer([],()=>{});assert.equal(model.usage().prompt_tokens,2000);assert.equal(model.usage().cached_tokens,1500);assert.equal(model.usage().known_cost_usd,0.0001);assert.equal(model.usage().missing_usage_calls,0);
 const unknown=new OpenRouter('test',null,async()=>Response.json({choices:[{message:{content:'ok'},finish_reason:'stop'}]}));
 await unknown.complete([]);assert.equal(unknown.usage().missing_usage_calls,1);
});
test('insufficient shared notes trigger one bounded original-document check without exposing internal marker',async()=>{
 const doc={source_id:'D47',asset:'raw',evidence_asset:'evidence',title:'SOCI',path:'files/soci.md',label:'2026',name:'soci',end:'2026',sizes:[95000],document_id:'d',document_hash:'h'};
 const a={manifest:async()=>({retrieval_version:'v',version:'v',system:'Data only.',tickers:['SOCI'],commonWords:[]}),search:async()=>[doc],
 read:async name=>name==='raw'?{parts:[{source_id:'D47',part:1,text:'SOCI: exact detail retained in original.'}]}:
 {version:'v',document_hash:'h',coverage:'full-source-partition',records:[{section_id:'s',kind:'issuer_section',context:'SOCI',tickers:['SOCI'],content:'SOCI '+'Bukti tentang kapal. '.repeat(20000)}]}};
 let answers=0;const events=[],stats={};
 const m={complete:async()=> 'Catatan [D1].',answer:async(messages,emit)=>{
  answers++;const text=answers===1?'[[SUMBER:D47]]':'Exact detail from original [D47].';
  if(answers===2)assert.match(JSON.stringify(messages),/exact detail retained in original/);
  await emit({type:'delta',text});return text;
 }};
 const result=await converse(a,m,'SOCI apa yang berubah?',[],e=>events.push(e),null,{metrics:stats});
 assert.equal(answers,2);assert.equal(stats.original_document_reads,1);assert.match(result.answer,/Exact detail/);
 assert.ok(!events.some(e=>e.type==='delta'&&e.text.includes('[[SUMBER:')));
});
test('question analytics retain actual inputs and outcomes, aggregate repeated topics, and paginate without exposing raw IP',()=>{
 const {db,cache}=cacheFixture();
 cache.question('a','anonymous-a',"SOCI <script>alert('x')</script>");
 cache.question('b','anonymous-b','SOCI ada apa?');
 cache.question('c','anonymous-b','SOCI ada apa?');
 cache.finishQuestion('a','quota');
 const usage={calls:1,input_bytes:100,known_cost_usd:0.01,prompt_tokens:20,completion_tokens:5,cached_tokens:0,missing_usage_calls:0};
 cache.record('b','complete',{usage,retrieval:{terms:['SOCI']}});
 cache.record('c','complete',{usage:{...usage,calls:0,known_cost_usd:0},retrieval:{terms:['SOCI'],answer_cache_hit:true}});
 const report=cache.report(7,2,0);
 assert.equal(report.total.inputs,3);assert.equal(report.top_questions[0].count,2);assert.equal(report.questions.length,2);
 assert.equal(report.top_terms[0].term,'SOCI');assert.equal(report.outcomes.find(x=>x.status==='quota').count,1);
 assert.equal(cache.report(7,2,2).questions.length,1);
 assert.equal(db.prepare('SELECT question FROM question_events WHERE id=?').get('a').question,"SOCI <script>alert('x')</script>");
 cache.put('source','immutable',{rows:[]});assert.ok(db.prepare('SELECT expires FROM evidence_cache WHERE cache_key=?').get('immutable').expires>Date.now()+365*86400000);
 db.close();
});
