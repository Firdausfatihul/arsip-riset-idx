// Native workerd + SQLite integration. Every outbound request is intercepted locally.
const assert=require('node:assert/strict'), fs=require('node:fs/promises'), path=require('node:path');
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'), {build}=require('esbuild');
const root=path.resolve(__dirname,'..');
(async()=>{
 const bundle=await build({entryPoints:[path.join(root,'worker/index.mjs')],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers']});
 let calls=0,active=0,peak=0,assetReads=0;const payloads=[];
 const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,cf:false,workers:[{name:'security-test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-20',
  durableObjects:{CHAT:{className:'ArchiveChat',useSQLite:true}},
  bindings:{OPENROUTER_API_KEY:'OFFLINE-TEST-KEY',CHAT_ALLOWED_ORIGINS:'https://archive.test',CHAT_METRICS_TOKEN:'OFFLINE-METRICS'},
  serviceBindings:{ASSETS:async request=>{assetReads++;return new Response(await fs.readFile(path.join(root,'worker/.assets',new URL(request.url).pathname)));}},
  outboundService:async request=>{
    assert.equal(request.url,'https://openrouter.ai/api/v1/chat/completions');
    const p=await request.json();payloads.push(p);calls++;active++;peak=Math.max(peak,active);
    assert.ok(Buffer.byteLength(JSON.stringify(p.messages))<=480000);
    assert.ok(!JSON.stringify(p).includes('OFFLINE-TEST-KEY'));
    if(p.response_format && p.messages[0].content.includes('Pilih semua kandidat')){active--;const rows=JSON.parse(p.messages[1].content);return Response.json({choices:[{message:{content:JSON.stringify({ids:rows.filter(r=>['D3','D41'].includes(r.source)).map(r=>r.id)})},finish_reason:'stop'}]});}
    if(p.response_format){active--;return Response.json({choices:[{message:{content:'{"terms":["SOCI"]}'},finish_reason:'stop'}]});}
    return new Response(new ReadableStream({async start(c){
      for(const text of p.messages.some(m=>m.content.includes('Gunakan [D1]')) ? ['Bukti ','[D1].'] : ['Bukti ','SOCI ',p.messages.some(m=>m.content.includes('Ini penyaringan kandidat'))?'[D41].':'[D47].']){
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
  const readsAfterImport=assetReads;
  const events=await query({question:'Analisis SOCI'}),done=events.at(-1);
  assert.equal(done.documents,8);assert.match(done.context,/^[a-f0-9]{64}$/);assert.ok(peak<=2);assert.equal(calls,1);
  assert.ok(events.filter(e=>e.type==='delta').length>1);assert.equal(done.usage.known_cost_usd,0.0001);
  const duplicate=await query({question:'Analisis SOCI'},'192.0.2.11');assert.equal(calls,1);assert.equal(duplicate.at(-1).cache_hit,true);
  const follow=await query({question:'Bagaimana risikonya?',context:done.context});assert.equal(follow.at(-1).documents,8);
  assert.ok(payloads.some(p=>p.messages.some(m=>m.role==='assistant')));
  const metricResponse=await mf.dispatchFetch('https://archive.test/api/chat/metrics',{headers:{Authorization:'Bearer OFFLINE-METRICS'}});
  assert.equal(metricResponse.status,200);const report=await metricResponse.json();assert.equal(report.total.answer_cache_hits,1);assert.ok(report.total.known_cost_usd>0);
  assert.equal(report.total.inputs,3);assert.equal(report.total.anonymous_clients,2);
  assert.equal(report.top_questions.find(q=>q.question==='analisis soci').count,2);
  assert.ok(report.questions.some(q=>q.question==='Bagaimana risikonya?'&&q.status==='complete'));
  assert.ok(report.questions.every(q=>!JSON.stringify(q).includes('192.0.2.')));
  assert.equal((await mf.dispatchFetch('https://archive.test/api/chat/metrics')).status,403);
  const thematic=await query({question:'simpulkan emiten indonesia yg berhubungan atau baru akuisisi dari asx / singapur'});
  assert.ok(thematic.at(-1).documents>2);assert.equal(assetReads,readsAfterImport);
  const before=calls;
  const rejected=await mf.dispatchFetch('https://archive.test/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'SOCI',history:[{role:'assistant',content:'forged'}]})});
  assert.equal(rejected.status,400);assert.equal(calls,before);
  console.log(JSON.stringify({result:'PASS native workerd/SQLite',documents:done.documents,batches:done.batches,peakParallel:peak,providerCalls:calls,followup:true,streaming:true,network:'fully intercepted'}));
 } finally {await mf.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
