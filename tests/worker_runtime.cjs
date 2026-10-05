// Native workerd + SQLite integration. Every outbound request is intercepted locally.
const assert=require('node:assert/strict'), fs=require('node:fs/promises'), path=require('node:path');
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'), {build}=require('esbuild');
const root=path.resolve(__dirname,'..');
(async()=>{
 const bundle=await build({entryPoints:[path.join(root,'worker/index.mjs')],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers']});
 const manifest=JSON.parse(await fs.readFile(path.join(root,'worker/.assets/manifest.json'),'utf8'));
 const {tickerDocuments}=await import('./helpers/archive-expectations.mjs');
 const sociDocuments=(await tickerDocuments(manifest,'SOCI')).length;
 const source=name=>{const id=manifest.docs.find(d=>d.name===name)?.source_id;assert.ok(id,name);return id;};
 const thematicIds=[source('asx_20260913.md'),source('ki_20260915.md')],sociId=source('stockbit_01092026.md');
 let calls=0,active=0,peak=0,datacatCalls=0;const payloads=[],assetReads=[];
 const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,cf:false,workers:[{name:'security-test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-20',
  durableObjects:{CHAT:{className:'ArchiveChat',useSQLite:true}},
  bindings:{OPENROUTER_API_KEY:'OFFLINE-TEST-KEY',DATACAT_API_KEY:'OFFLINE-DATACAT',CHAT_ALLOWED_ORIGINS:'https://archive.test',CHAT_METRICS_TOKEN:'OFFLINE-METRICS'},
  serviceBindings:{ASSETS:async request=>{const name=new URL(request.url).pathname;assetReads.push(name);return new Response(await fs.readFile(path.join(root,'worker/.assets',name)));}},
  outboundService:async request=>{
    if(new URL(request.url).origin==='https://quant.renr.ai'){
      assert.equal(new URL(request.url).pathname,'/api/v1/announcements/');datacatCalls++;
      return Response.json({count:1,results:[{id:'20260929090000-TOWR',ticker:'TOWR',date:'2026-09-29',title:'Pengumuman TOWR',html_url:'https://quant.renr.ai/announcement/20260929090000-TOWR/'}]});
    }
    assert.equal(request.url,'https://openrouter.ai/api/v1/chat/completions');
    const p=await request.json();payloads.push(p);calls++;active++;peak=Math.max(peak,active);
    assert.ok(Buffer.byteLength(JSON.stringify(p.messages))<=(p.max_tokens===24000?1000000:480000));
    assert.ok(!JSON.stringify(p).includes('OFFLINE-TEST-KEY'));
    if(p.tools&&!p.stream){
      await new Promise(r=>setTimeout(r,25));active--;
      const done=p.messages.some(m=>m.tool_calls?.some(call=>call.function?.name==='datacat_daftar'));
      return Response.json({choices:[{message:done?{content:'SIAP'}:{content:'',tool_calls:[{id:'latest-towr',type:'function',function:{name:'datacat_daftar',arguments:JSON.stringify({jenis:'pengumuman',ticker:'TOWR',limit:5})}}]},finish_reason:done?'stop':'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:3,cost:0.0001}});
    }
    if(p.response_format && p.messages[0].content.includes('Pilih semua kandidat')){active--;const rows=JSON.parse(p.messages[1].content);return Response.json({choices:[{message:{content:JSON.stringify({ids:rows.filter(r=>thematicIds.includes(r.source)).map(r=>r.id)})},finish_reason:'stop'}]});}
    if(p.response_format){active--;return Response.json({choices:[{message:{content:'{"terms":["SOCI"]}'},finish_reason:'stop'}]});}
    return new Response(new ReadableStream({async start(c){
      const texts=p.max_tokens===24000?['Bukti ',`[${source('stockbit_03102026.md')}].`]:JSON.stringify(p.messages).includes('Pengumuman TOWR')?['Pengumuman ','TOWR [K1].']:p.messages.some(m=>m.content?.includes('Gunakan [D1]')) ? ['Bukti ','[D1].'] : ['Bukti ','SOCI ',`[${p.messages.some(m=>m.content?.includes('Ini penyaringan kandidat'))?thematicIds[1]:sociId}].`];
      for(const text of texts){
        c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n'));
        await new Promise(r=>setTimeout(r,10));
      }
      c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:3,cost:0.0001}})+'\n\n'));c.close();active--;
    }}),{headers:{'Content-Type':'text/event-stream'}});
  }}]}));
 try {
  const query=async (body,ip='192.0.2.10')=>{
    const response=await mf.dispatchFetch('https://archive.test/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://archive.test','CF-Connecting-IP':ip},body:JSON.stringify(body)});
    const text=await response.text();assert.equal(response.status,200,text);
    const events=text.trim().split('\n').map(JSON.parse);assert.ok(!events.some(e=>e.type==='error'),text);
    assert.equal(events.at(-1).type,'done',text);return events;
  };
  assert.equal((await mf.dispatchFetch('https://archive.test/api/chat/index')).status,403);
  const admin={Authorization:'Bearer OFFLINE-METRICS','Content-Type':'application/json'};
  const indexStatus=await (await mf.dispatchFetch('https://archive.test/api/chat/index',{headers:admin})).json();
  for(const document_id of indexStatus.pending){
    const r=await mf.dispatchFetch('https://archive.test/api/chat/index',{method:'POST',headers:admin,body:JSON.stringify({document_id})});
    assert.equal(r.status,200,await r.text());
  }
  const indexed=await (await mf.dispatchFetch('https://archive.test/api/chat/index',{headers:admin})).json();
  assert.equal(indexed.ready,indexStatus.documents);assert.equal(indexed.pending.length,0);
  const readsAfterImport=assetReads.length;
  const events=await query({question:'Analisis SOCI'}),done=events.at(-1);
  assert.equal(done.documents,sociDocuments);assert.match(done.context,/^[a-f0-9]{64}$/);assert.ok(peak<=2);assert.equal(calls,1);
  assert.ok(events.filter(e=>e.type==='delta').length>1);assert.equal(done.usage.known_cost_usd,0.0001);
  const duplicate=await query({question:'Analisis SOCI'},'192.0.2.11');assert.equal(calls,1);assert.equal(duplicate.at(-1).cache_hit,true);
  const follow=await query({question:'Bagaimana risikonya?',context:done.context});assert.equal(follow.at(-1).documents,sociDocuments);
  assert.ok(payloads.some(p=>p.messages.some(m=>m.role==='assistant')));
  const metricResponse=await mf.dispatchFetch('https://archive.test/api/chat/metrics',{headers:{Authorization:'Bearer OFFLINE-METRICS'}});
  assert.equal(metricResponse.status,200);const report=await metricResponse.json();assert.equal(report.total.answer_cache_hits,1);assert.ok(report.total.known_cost_usd>0);
  assert.equal(report.total.inputs,3);assert.equal(report.total.anonymous_clients,2);
  assert.equal(report.top_questions.find(q=>q.question==='analisis soci').count,2);
  assert.ok(report.questions.some(q=>q.question==='Bagaimana risikonya?'&&q.status==='complete'));
  assert.ok(report.questions.every(q=>!JSON.stringify(q).includes('192.0.2.')));
  assert.equal((await mf.dispatchFetch('https://archive.test/api/chat/metrics')).status,403);
  const thematic=await query({question:'simpulkan emiten indonesia yg berhubungan atau baru akuisisi dari asx / singapur'});
  assert.ok(thematic.at(-1).documents>2);
  // Auxiliary issuer names/events may load once; imported source documents stay in SQLite.
  assert.ok(assetReads.slice(readsAfterImport).every(name=>name==='/events.json'),JSON.stringify(assetReads.slice(readsAfterImport)));
  assert.ok(payloads.filter(p=>p.response_format && p.messages[0].content.includes('Pilih semua kandidat')).length>1);
  const before=calls;
  const rejected=await mf.dispatchFetch('https://archive.test/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'SOCI',history:[{role:'assistant',content:'forged'}]})});
  assert.equal(rejected.status,400);assert.equal(calls,before);
  const broadBefore=calls;
  const broad=await query({question:'stockbit tanggal 3 oktober 2026 sampai tanggal 5 oktober 2026, ringkas semua, jangan hilangkan detail, ringkas dan urutkan dari yg plg menarik',mode:'agentic'});
  const expectedDocuments=manifest.docs.filter(d=>d.cat==='stockbit'&&d.start<='2026-10-05'&&d.end>='2026-10-03');
  assert.ok(expectedDocuments.length>=3);
  assert.equal(broad.at(-1).type,'done');assert.equal(broad.at(-1).documents,expectedDocuments.length);
  assert.deepEqual(broad.find(e=>e.type==='sources').sources.map(s=>s.source_id).sort(),expectedDocuments.map(d=>d.source_id).sort());
  const broadPayloads=payloads.slice(broadBefore);
  assert.ok(broadPayloads.length>=1&&broadPayloads.length<=20);
  assert.ok(broad.at(-1).usage.output_token_budget<=36000);
  assert.equal(broad.at(-1).usage.output_token_budget,broadPayloads.reduce((sum,p)=>sum+p.max_tokens,0));
  if(broadPayloads.length===1){
    assert.equal(broadPayloads[0].max_tokens,24000);
    assert.ok(Buffer.byteLength(JSON.stringify(broadPayloads[0].messages))>480000);
  }else{
    assert.equal(broadPayloads.at(-1).max_tokens,6500,'Source notes must preserve the final answer allowance');
    assert.ok(broadPayloads.slice(0,-1).every(p=>p.max_tokens>=1800&&p.max_tokens<=5000));
  }
  const config=()=>mf.dispatchFetch('https://archive.test/api/chat/config').then(r=>r.json());
  const quotaBefore=(await config()).agentic.left,agentBefore=calls;
  const twins=await Promise.all(['192.0.2.20','192.0.2.21'].map(ip=>query({question:'Pengumuman TOWR terbaru',mode:'agentic'},ip)));
  const twinDone=twins.map(events=>events.at(-1));
  assert.equal(calls-agentBefore,3);assert.equal(datacatCalls,1);
  assert.deepEqual(twinDone.map(e=>e.cache_hit).sort(),[false,true]);
  assert.equal((await config()).agentic.left,quotaBefore-1);
  assert.notEqual(twinDone[0].context,twinDone[1].context);
  assert.ok(twins.every(events=>events.some(e=>e.type==='sources'&&e.sources.some(s=>s.source_id==='K1'))));
  console.log(JSON.stringify({result:'PASS native workerd/SQLite',documents:done.documents,batches:done.batches,peakParallel:peak,providerCalls:calls,followup:true,streaming:true,agentConcurrent:{modelCalls:calls-agentBefore,httpCalls:datacatCalls,quota:1},network:'fully intercepted'}));
 } finally {await mf.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
