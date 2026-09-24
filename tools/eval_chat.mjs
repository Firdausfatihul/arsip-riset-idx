#!/usr/bin/env node
// Accuracy evaluation for the archive chat, using real OpenRouter calls and the same
// SQLite FTS5 source store as production. Each case starts with an empty app cache and
// provider response caching disabled, so runs of different implementations are comparable.
//   node tools/eval_chat.mjs --label improved [--impl worker] [--assets worker/.assets] [--only id,id] [--max-usd 2]
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i>0?process.argv[i+1]:fallback;};
const root=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const impl=path.resolve(arg('impl',path.join(root,'worker')));
const assets=path.resolve(arg('assets',path.join(impl,'.assets')));
const label=arg('label','run'),maxUsd=Number(arg('max-usd','2')),concurrency=Number(arg('concurrency','3'));
const only=arg('only','')?new Set(arg('only').split(',')):null;
const core=await import(pathToFileURL(path.join(impl,'core.mjs')));
const {SourceStore}=await import(pathToFileURL(path.join(impl,'source-store.mjs')));
const {Archive,CacheStore,OpenRouter,converse}=core;

const env=await readFile(path.join(root,'.env.chat'),'utf8');
const key=env.match(/^OPENROUTER_API_KEY\s*=\s*["']?([^\s"']+)/m)?.[1];
if(!key)throw Error('OPENROUTER_API_KEY missing in .env.chat');
const {cases}=JSON.parse(await readFile(path.join(root,'tests/eval/cases.json'),'utf8'));
const manifest=JSON.parse(await readFile(path.join(assets,'manifest.json'),'utf8'));
const readAsset=async name=>readFile(path.join(assets,name));
// Cases name documents by file name; source IDs (D12…) shift whenever documents are added.
const idOf=Object.fromEntries(manifest.docs.map(d=>[d.name,d.source_id]));
const ids=list=>list?.map(n=>{if(!idOf[n])throw Error('Unknown document in case: '+n);return idOf[n];});

function sqlite(){
  const db=new DatabaseSync(':memory:');
  const sql={exec(q,...args){const s=db.prepare(q),rows=s.columns().length?s.all(...args):(s.run(...args),[]);
    return {toArray:()=>rows,one:()=>rows[0]};}};
  const ctx={storage:{sql,transactionSync(fn){db.exec('BEGIN');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};
  return {db,sql,ctx};
}
// One shared, fully imported source store (production state after sync_chat_index.py).
const shared=sqlite(),store=new SourceStore(shared.ctx);
for(const doc of manifest.docs)await store.importDocument(manifest,doc,JSON.parse(await readAsset(doc.evidence_asset)));

let spent=0;
// Provider rate limits (429) say nothing about accuracy; wait and repeat the whole case.
async function run(question,history,client){
  for(let attempt=1;;attempt++){
    const r=await runOnce(question,history,client);
    if(!/membatasi permintaan/.test(r.error||'') || attempt===4)return {...r,attempts:attempt};
    await new Promise(ok=>setTimeout(ok,20000*attempt));
  }
}
async function runOnce(question,history,client){
  const {db,sql}=sqlite(),cache=new CacheStore(sql);
  const archive=new Archive({fetch:async r=>new Response(await readAsset(new URL(r.url).pathname.slice(1)))},store);
  const model=new OpenRouter(key,null,undefined,()=>{if(spent>maxUsd)throw Error('Eval USD ceiling reached');},{responseCache:false});
  const events=[],metrics={},start=Date.now();let result,error;
  try{result=await converse(archive,model,question,history,async e=>{events.push(e);},null,{cache,metrics,client});}
  catch(e){error=e.message;}
  const usage=model.usage();spent+=usage.known_cost_usd;db.close();
  const sources=events.filter(e=>e.type==='sources').at(-1)?.sources||[];
  return {result,error,usage,metrics,sources,events,elapsed_ms:Date.now()-start};
}
const remember=(history,question,result)=>core.rememberTurn?core.rememberTurn(history,question,result)
  :[...history,{role:'user',content:question},{role:'assistant',content:result.answer.slice(0,1500)}].slice(-6);

async function evaluate(c){
  let history=[];
  if(c.prime){
    const p=await run(c.prime,[],c.id);
    if(!p.result)return {id:c.id,question:c.question,status:'error',error:'prime failed: '+p.error,pass:false,usage:p.usage};
    history=remember(history,c.prime,p.result);
  }
  const r=await run(c.question,history,c.id);
  const answer=r.result?.answer||'',terms=(r.result?.terms||r.metrics.terms||[]).map(String);
  const status=r.result?(r.result.clarification?'clarification':'complete'):'error';
  const found=r.sources.map(s=>s.source_id),termsUpper=terms.map(t=>t.toUpperCase());
  const gold=ids(c.gold),docsAll=ids(c.docs_all),docsAny=ids(c.docs_any);
  const checks={};
  checks.status=c.status==='any'||status==='complete';
  if(c.terms_include)checks.terms_include=c.terms_include.every(t=>termsUpper.includes(t));
  if(c.terms_exclude)checks.terms_exclude=!c.terms_exclude.some(t=>termsUpper.includes(t));
  if(docsAll)checks.docs_all=docsAll.every(d=>found.includes(d));
  if(docsAny)checks.docs_any=docsAny.some(d=>found.includes(d));
  const facts=(c.facts||[]).map(f=>({fact:f,hit:new RegExp(f,'i').test(answer)}));
  if(facts.length)checks.facts=facts.every(f=>f.hit);
  const refs=[...new Set([...answer.matchAll(/\[(D\d+)\]/g)].map(m=>m[1]))];
  const precision=gold&&found.length?found.filter(d=>gold.includes(d)).length/found.length:null;
  return {id:c.id,question:c.question,status,error:r.error,pass:Object.values(checks).every(Boolean),checks,facts,
    terms,sources:found,source_precision:precision,citations:refs,invalid_citations:refs.filter(d=>!found.includes(d)),
    incomplete:!!r.result?.incomplete,answer,usage:r.usage,elapsed_ms:r.elapsed_ms,attempts:r.attempts,
    retrieval:Object.fromEntries(Object.entries(r.metrics).filter(([k])=>!['date_scope'].includes(k)))};
}

const selected=cases.filter(c=>!only||only.has(c.id)),results=new Array(selected.length);
let next=0;
await Promise.all(Array.from({length:concurrency},async()=>{
  while(next<selected.length){
    const i=next++;results[i]=await evaluate(selected[i]);
    const r=results[i];
    console.log(`${r.pass?'PASS':'FAIL'} ${r.id.padEnd(14)} ${r.status.padEnd(13)} docs=${r.sources?.length??0} $${(r.usage?.known_cost_usd||0).toFixed(4)} ${r.error||''}`);
  }
}));
const sum=(f)=>results.reduce((n,r)=>n+(f(r)||0),0),prec=results.filter(r=>r.source_precision!==null&&r.source_precision!==undefined);
const summary={label,impl,archive_version:manifest.version,created_at:new Date().toISOString(),cases:results.length,
  passed:sum(r=>r.pass),completed:sum(r=>r.status==='complete'),errors:sum(r=>r.status==='error'),
  facts_hit:sum(r=>r.facts?.filter(f=>f.hit).length),facts_total:sum(r=>r.facts?.length),
  mean_source_precision:prec.length?prec.reduce((n,r)=>n+r.source_precision,0)/prec.length:null,
  invalid_citations:sum(r=>r.invalid_citations?.length),cost_usd:sum(r=>r.usage?.known_cost_usd),
  provider_calls:sum(r=>r.usage?.calls)};
const out=path.join(root,'reports/eval');await mkdir(out,{recursive:true});
await writeFile(path.join(out,label+'.json'),JSON.stringify({summary,results},null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
