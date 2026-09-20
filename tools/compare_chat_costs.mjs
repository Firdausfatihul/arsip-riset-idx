#!/usr/bin/env node
// Same local corpus, same model; live mode has an explicit conservative spend ceiling.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {Archive,CacheStore,OpenRouter,converse,converseLegacy,size,MODEL} from '../worker/core.mjs';
const live=process.argv.includes('--live');
const refresh=process.argv.includes('--refresh-indexed');
const root=new URL('../',import.meta.url),out=new URL('reports/cache-comparison/',root);
await mkdir(out,{recursive:true});
const archive=new Archive({fetch:async r=>new Response(await readFile(new URL('worker/.assets'+new URL(r.url).pathname,root)))});
const index=await archive.manifest();
const db=new DatabaseSync(':memory:');
const sql={exec(q,...args){const s=db.prepare(q),rows=s.columns().length?s.all(...args):(s.run(...args),[]);return {toArray:()=>rows};}};
const cache=new CacheStore(sql);
let key,ceiling=0;
const maxUsd=1;
if(live){
 const env=await readFile(new URL('.env.chat',root),'utf8');
 key=env.match(/^OPENROUTER_API_KEY\s*=\s*["']?([^\s"']+)/m)?.[1];
 if(!key)throw Error('Dedicated OPENROUTER_API_KEY missing');
}
class OfflineModel{
 constructor(){this.receipts=[];}
 async complete(messages,o={}){this.receipts.push({input_bytes:size(messages),output_token_budget:o.maxTokens||1800});return o.jsonMode?'{"terms":["SOCI"]}':'Bukti SOCI [D1].';}
 async answer(messages,emit){this.receipts.push({input_bytes:size(messages),output_token_budget:5000});await emit({type:'delta',text:'Bukti SOCI [D47].'});return 'Bukti SOCI [D47].';}
 usage(){return {calls:this.receipts.length,input_bytes:this.receipts.reduce((n,r)=>n+r.input_bytes,0),known_cost_usd:null,note:'offline simulation; no token or cost estimate'};}
}
const cases=[
 ['legacy','di soci ada apa ya?'],
 ['indexed_first','di soci ada apa ya?'],
 ['indexed_other_question','SOCI tanggal 17 September 2026'],
 ['indexed_same_question_other_user','di soci ada apa ya?'],
 ['ambiguous_date','coba cek soci tggl 17']
];
const records=[];let baselineReusedFrom=null;
if(refresh){
 if(!live)throw Error('--refresh-indexed requires --live');
 const previous=JSON.parse(await readFile(new URL('live.json',out),'utf8'));
 if(previous.archive_version!==index.version || previous.records[0]?.result!=='complete')throw Error('Baseline source version differs or is incomplete');
 records.push(previous.records[0]);baselineReusedFrom=previous.created_at;
}
for(const [name,question]of cases){
 if(refresh&&name==='legacy')continue;
 const reserve=(bytes,tokens)=>{
  // Conservative UTF-8-byte upper proxy at the endpoint's highest listed input/output tier.
  // Reserve the full amount even when a call later reports cached input or lower actual cost.
  const bound=bytes*0.00000025+tokens*0.0000008;
  if(ceiling+bound>maxUsd)throw Error('Benchmark conservative USD ceiling reached');ceiling+=bound;
 };
 const model=live?new OpenRouter(key,null,undefined,reserve,{responseCache:name!=='legacy'}):new OfflineModel();
 const metrics={},start=Date.now();let result,error;
 try {result=await(name==='legacy'?converseLegacy:converse)(archive,model,question,[],()=>{},null,{cache,metrics,client:name});}
 catch(e){error=e.message;}
 const row={case:name,question,elapsed_ms:Date.now()-start,result:error?'error':'complete',error,documents:result?.documents,
  retrieval:metrics,usage:model.usage(),calls:model.receipts,answer:result?.answer};records.push(row);
 await writeFile(new URL((live?'live':'offline')+'.json',out),JSON.stringify({mode:live?'actual OpenRouter receipts':'offline simulation',model:MODEL,archive_version:index.version,created_at:new Date().toISOString(),baseline_reused_from:baselineReusedFrom,max_usd:live?maxUsd:null,conservative_reserved_usd:ceiling,records},null,2)+'\n');
 console.log(JSON.stringify({case:name,result:row.result,usage:row.usage,error}));
 if(error && name==='legacy')break;
}
if(live){
 const pricing=await fetch('https://openrouter.ai/api/v1/models/qwen/qwen3.7-flash/endpoints');
 if(pricing.ok)await writeFile(new URL('provider-pricing.json',out),JSON.stringify(await pricing.json(),null,2)+'\n');
}
const lines=['# Perbandingan biaya chat arsip','',`Mode: ${live?'API nyata, berdasarkan usage OpenRouter':'simulasi tanpa API berbayar'}. Model: ${MODEL}. Versi arsip: ${index.version}.`,'',
 '| Kasus | Status | Dokumen | Panggilan | Input token | Output token | Token cache provider | Biaya tercatat USD | Input pesan byte |',
 '|---|---|---:|---:|---:|---:|---:|---:|---:|',
 ...records.map(r=>`| ${r.case} | ${r.result} | ${r.documents??'—'} | ${r.usage.calls} | ${r.usage.prompt_tokens??'—'} | ${r.usage.completion_tokens??'—'} | ${r.usage.cached_tokens??'—'} | ${r.usage.known_cost_usd??'—'} | ${r.usage.input_bytes} |`),
 '', 'Cache aplikasi dimulai kosong; cache provider tidak dapat dipastikan kosong. Pertanyaan berbeda tetap menghasilkan jawaban baru. Baris pengulangan menggunakan cache aplikasi lintas pengguna. Angka biaya adalah biaya API model; bukan biaya hosting atau jaminan tarif pada masa depan. Jika missing_usage_calls > 0, biaya yang diketahui belum merupakan total lengkap.',
 '', 'Pengujian mempertahankan sumber asli. Pemeriksaan kualitas jawaban dilakukan terpisah dari penghitungan penghematan.'
];
await writeFile(new URL((live?'live':'offline')+'.md',out),lines.join('\n')+'\n');db.close();
