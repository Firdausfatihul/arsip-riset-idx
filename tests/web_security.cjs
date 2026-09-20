// Offline DOM regression and payload tests. Never contacts the public site.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM,VirtualConsole}=require('jsdom'),{marked}=require('marked'),purify=require('dompurify');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'site/index.html'),'utf8').replace(/<style>[\s\S]*?<\/style>/g,'');
const ownership=JSON.parse(fs.readFileSync(path.join(root,'site/files/kepemilikan/kepemilikan.json'),'utf8'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));let checks=0;
function setup(mutate){
 const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{url:'https://archive.test/',runScripts:'outside-only',virtualConsole:console});
 const w=dom.window,d=w.document;let data=JSON.parse(d.getElementById('arsip-data').textContent),own=structuredClone(ownership);
 if(mutate)mutate(data,own);d.getElementById('arsip-data').textContent=JSON.stringify(data);
 w.marked=marked;w.DOMPurify=purify(w);w.TextDecoder=TextDecoder;w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.fetch=async url=>{
  if(String(url).startsWith('version.json'))return Response.json({version:data.version});
  if(String(url).startsWith(data.own.path))return Response.json(own);
  const file=data.docs.find(x=>String(url).split('?')[0]===x.path);
  if(file)return new Response(fs.readFileSync(path.join(root,'site',file.path),'utf8'));
  throw Error('Network forbidden: '+url);
 };
 w.eval([...d.querySelectorAll('script')].at(-1).textContent);
 const route=hash=>{w.history.replaceState(null,'',hash);w.dispatchEvent(new w.HashChangeEvent('hashchange'));};
 return {w,d,data,dom,errors,route};
}
async function test(name,fn){await fn();checks++;console.log('PASS',name);}
(async()=>{
 await test('script data and CSP include only intended executable script',async()=>{
  const {dom,d}=setup();assert.equal(d.querySelectorAll('script:not([src]):not([type="application/json"])').length,1);
  const policy=d.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
  assert.ok(policy.includes("base-uri 'none'")&&policy.includes("form-action 'none'"));assert.ok(!/script-src[^;]*unsafe-inline/.test(policy));dom.window.close();
 });
 await test('Markdown blocks overlay CSS, form, media, clobbering, script and unsafe URLs',async()=>{
  const {dom,d,data,route,w}=setup(data=>{const doc=data.docs.find(d=>d.kind==='md');delete doc.lazy;doc.content='# '+doc.title+'\n\n<div style="position:fixed;inset:0" id="chat-form">overlay</div><form action="https://canary.invalid"><input name="location"></form><svg onload="alert(1)"></svg><img src="https://canary.invalid/pixel"><script>window.hacked=1</script>\n\n[bad](javascript:alert(1)) [data](data:text/html,x) [file](file:///tmp/canary) [relative](//canary.invalid) [source](https://www.idx.co.id/)\n\n## 1. SOCI — Test';});
  route('#doc='+encodeURIComponent(data.docs.find(d=>d.kind==='md').path));
  const prose=d.querySelector('.prose');assert.ok(prose);assert.equal(prose.querySelector('script,style,form,img,svg,[style],[id="chat-form"]'),null);
  assert.equal(w.hacked,undefined);assert.ok(prose.querySelector('a[href="https://www.idx.co.id/"]'));assert.equal(prose.querySelector('a[href^="javascript:"],a[href^="data:"],a[href^="file:"],a[href^="//"]'),null);dom.window.close();
 });
 await test('prototype routes and hostile query/hash do not crash or inject HTML',async()=>{
  const {dom,d,route,errors,w}=setup();for(const word of ['constructor','__proto__','toString','<img src=x onerror=bad>'])route('#doc='+encodeURIComponent(word));
  const input=d.getElementById('cari');input.value='<svg onload=bad>';input.dispatchEvent(new w.Event('input'));await delay(160);
  assert.equal(d.querySelector('#cari-catatan svg'),null);assert.deepEqual(errors,[]);dom.window.close();
 });
 await test('all current ownership data passes schema, all companies render detail including charts',async()=>{
  const {dom,d,data,route,errors}=setup();route('#kepemilikan=');await delay(5);
  assert.ok(d.querySelector('#own-body table'));assert.equal(d.querySelectorAll('#own-emiten option').length,964);
  for(const company of ownership.companies){route('#kepemilikan='+company.t);assert.ok(d.querySelector('#own-trend svg'),company.t);}
  assert.deepEqual(errors,[]);dom.window.close();
 });
 await test('hostile names and URLs in ownership stay inert',async()=>{
  const {dom,d,route,errors}=setup((data,own)=>{own.companies[0].n='<img src=x onerror=bad>';own.names.fill('<svg onload=bad>');own.months.forEach(m=>m.url='javascript:alert(1)');});
  route('#kepemilikan='+ownership.companies[0].t);await delay(5);
  assert.equal(d.querySelector('#own-body img,#own-body svg[onload],#own-body a[href^="javascript:"]'),null);assert.deepEqual(errors,[]);dom.window.close();
 });
 await test('bad numeric cells, duplicate company, malformed row and prototype investor rejected',async()=>{
  for(const attack of [own=>own.companies[0].k.find(Boolean).h[0][0]='__proto__',own=>own.companies[0].k.find(Boolean).h[0][4]='<img src=x>',own=>own.companies.push(own.companies[0]),own=>own.companies[0].c=[]]){
   const {dom,d,route}=setup((data,own)=>attack(own));route('#kepemilikan=');await delay(5);assert.ok(d.getElementById('own-retry'));assert.equal(d.querySelector('#own-body table'),null);dom.window.close();
  }
 });
 await test('six HTML report URLs contain opaque sandboxes and unmodified source',async()=>{
  const {dom,data}=setup();const bridge=fs.readFileSync(path.join(root,'report-frame.js'),'utf8');
  for(const doc of data.docs.filter(d=>d.kind==='html')){
   const report=new JSDOM(fs.readFileSync(path.join(root,'site',doc.path),'utf8'));
   const frame=report.window.document.getElementById('report-content');assert.equal(frame.getAttribute('sandbox'),'allow-scripts allow-popups');assert.ok(!frame.sandbox?.contains('allow-same-origin'));
   const original=fs.readFileSync(path.join(root,'needtobeindexed',doc.name),'utf8');assert.equal(frame.getAttribute('srcdoc'),original+'<script>'+bridge+'</script>');
   assert.equal(report.window.document.querySelectorAll('script').length,1);
   if(doc.name.startsWith('Laporan_Arsip_')) assert.ok(report.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("'unsafe-hashes'"));
   report.window.close();
  }dom.window.close();
 });
 await test('report search bridge bounds inputs, counts and jump; shell ignores forged sender',async()=>{
  const dom=new JSDOM('<body><p>SOCI SOCI kapal</p></body>',{runScripts:'outside-only'}),w=dom.window;let replies=[];
  w.postMessage=m=>replies.push(m);w.HTMLElement.prototype.scrollIntoView=()=>{};w.eval(fs.readFileSync(path.join(root,'report-frame.js'),'utf8'));
  const send=(data,source=w)=>w.dispatchEvent(new w.MessageEvent('message',{data,source}));
  send({type:'archive:find',id:1,query:'SOCI'},null);assert.equal(replies.length,0);
  send({type:'archive:find',id:1,query:'SOCI'});assert.equal(replies.at(-1).total,2);assert.equal(w.document.querySelectorAll('mark').length,2);
  send({type:'archive:find',id:2,query:'x'.repeat(129)});assert.equal(replies.length,1);
  send({type:'archive:find',id:3,query:'<img src=x>'});assert.equal(w.document.querySelector('img'),null);
  const copy=w.document.createElement('button');copy.setAttribute('data-copy','12345678');w.document.body.appendChild(copy);copy.click();assert.equal(w.document.querySelector('input[readonly]').value,'12345678');w.close();
  const shell=new JSDOM('<nav id="report-nav"></nav><iframe id="report-content"></iframe>',{url:'https://archive.test',runScripts:'outside-only'}),sw=shell.window;
  sw.eval(fs.readFileSync(path.join(root,'report-shell.js'),'utf8'));let resolved=false;const result=sw.archiveFind('SOCI').then(x=>{resolved=true;return x;});
  sw.dispatchEvent(new sw.MessageEvent('message',{source:null,origin:'null',data:{type:'archive:found',id:1,total:1}}));await delay(5);assert.equal(resolved,false);
  sw.dispatchEvent(new sw.MessageEvent('message',{source:sw.document.querySelector('iframe').contentWindow,origin:'null',data:{type:'archive:found',id:1,total:2}}));assert.equal(await result,2);sw.close();
 });
 console.log('Completed',checks,'web security scenarios (including 963 company renders).');
})().catch(e=>{console.error(e);process.exitCode=1;});
