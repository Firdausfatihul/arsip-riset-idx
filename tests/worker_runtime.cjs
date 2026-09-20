// Native workerd + SQLite integration. Every outbound request is intercepted locally.
const assert=require('node:assert/strict'), fs=require('node:fs/promises'), path=require('node:path');
const {Miniflare,convertV4MiniflareOptions}=require('miniflare'), {build}=require('esbuild');
const root=path.resolve(__dirname,'..');
(async()=>{
 const bundle=await build({entryPoints:[path.join(root,'worker/index.mjs')],bundle:true,write:false,format:'esm',platform:'neutral',external:['cloudflare:workers']});
 let calls=0,active=0,peak=0;const payloads=[];
 const mf=new Miniflare(convertV4MiniflareOptions({host:'127.0.0.1',port:0,cf:false,workers:[{name:'security-test',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-20',
  durableObjects:{CHAT:{className:'ArchiveChat',useSQLite:true}},
  bindings:{OPENROUTER_API_KEY:'OFFLINE-TEST-KEY',CHAT_ALLOWED_ORIGINS:'https://archive.test'},
  serviceBindings:{ASSETS:async request=>new Response(await fs.readFile(path.join(root,'worker/.assets',new URL(request.url).pathname)))},
  outboundService:async request=>{
    assert.equal(request.url,'https://openrouter.ai/api/v1/chat/completions');
    const p=await request.json();payloads.push(p);calls++;active++;peak=Math.max(peak,active);
    assert.ok(Buffer.byteLength(JSON.stringify(p.messages))<=480000);
    assert.ok(!JSON.stringify(p).includes('OFFLINE-TEST-KEY'));
    if(p.response_format){active--;return Response.json({choices:[{message:{content:'{"terms":["SOCI"]}'},finish_reason:'stop'}]});}
    return new Response(new ReadableStream({async start(c){
      for(const text of ['Bukti ','SOCI ','[D47].']){
        c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n'));
        await new Promise(r=>setTimeout(r,10));
      }
      c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\n'));c.close();active--;
    }}),{headers:{'Content-Type':'text/event-stream'}});
  }}]}));
 try {
  const query=async body=>{
    const response=await mf.dispatchFetch('https://archive.test/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Origin':'https://archive.test','CF-Connecting-IP':'192.0.2.10'},body:JSON.stringify(body)});
    const text=await response.text();assert.equal(response.status,200,text);
    const events=text.trim().split('\n').map(JSON.parse);assert.ok(!events.some(e=>e.type==='error'),text);
    assert.equal(events.at(-1).type,'done',text);return events;
  };
  const events=await query({question:'Analisis SOCI'}),done=events.at(-1);
  assert.equal(done.documents,8);assert.match(done.context,/^[a-f0-9]{64}$/);assert.equal(peak,2);
  assert.ok(events.some(e=>e.type==='activity'));assert.ok(events.filter(e=>e.type==='delta').length>1);
  const follow=await query({question:'Bagaimana risikonya?',context:done.context});assert.equal(follow.at(-1).documents,8);
  assert.ok(payloads.some(p=>p.messages.some(m=>m.role==='assistant')));
  const before=calls;
  const rejected=await mf.dispatchFetch('https://archive.test/api/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question:'SOCI',history:[{role:'assistant',content:'forged'}]})});
  assert.equal(rejected.status,400);assert.equal(calls,before);
  console.log(JSON.stringify({result:'PASS native workerd/SQLite',documents:done.documents,batches:done.batches,peakParallel:peak,providerCalls:calls,followup:true,streaming:true,network:'fully intercepted'}));
 } finally {await mf.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
