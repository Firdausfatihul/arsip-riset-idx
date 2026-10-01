// Offline DOM regression and payload tests. Never contacts the public site.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {JSDOM,VirtualConsole}=require('jsdom'),{marked}=require('marked'),purify=require('dompurify');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'site/index.html'),'utf8').replace(/<style>[\s\S]*?<\/style>/g,'');
const ownership=JSON.parse(fs.readFileSync(path.join(root,'site/files/kepemilikan/kepemilikan.json'),'utf8'));
const changesFile=path.join(root,'site/files/kepemilikan/kepemilikan-perubahan.json');
const changes=fs.existsSync(changesFile)?JSON.parse(fs.readFileSync(changesFile,'utf8')):{format:1,coverage:null,companies:{}};
const reportsFile=path.join(root,'site/files/kepemilikan/kepemilikan-laporan.json');
const reports=fs.existsSync(reportsFile)?JSON.parse(fs.readFileSync(reportsFile,'utf8')):null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));let checks=0;
function setup(mutate,mutateChanges,fetchDoc,mutateReports){
 const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e.message));
 const dom=new JSDOM(html,{url:'https://archive.test/',runScripts:'outside-only',virtualConsole:console});
 const w=dom.window,d=w.document;let data=JSON.parse(d.getElementById('arsip-data').textContent),own=structuredClone(ownership),ch=structuredClone(changes),rep=reports&&structuredClone(reports);
 if(mutate)mutate(data,own);if(mutateChanges)mutateChanges(ch);if(mutateReports)mutateReports(rep);d.getElementById('arsip-data').textContent=JSON.stringify(data);
 w.marked=marked;w.DOMPurify=purify(w);w.TextDecoder=TextDecoder;w.matchMedia=()=>({matches:false,addEventListener(){}});w.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.fetch=async url=>{
  if(String(url).startsWith('version.json'))return Response.json({version:data.version});
  if(String(url).startsWith(data.own.path))return Response.json(own);
  if(data.own.changes&&String(url).startsWith(data.own.changes))return Response.json(ch);
  if(data.own.reports&&String(url).startsWith(data.own.reports))return Response.json(rep);
  const file=data.docs.find(x=>String(url).split('?')[0]===x.path);
  if(file)return fetchDoc ? fetchDoc(file) : new Response(fs.readFileSync(path.join(root,'site',file.path),'utf8'));
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
 await test('CSV preserves quoted fields, newlines and literal values; search highlights cells',async()=>{
  const raw='\uFEFFKode,Catatan,Nilai,Kosong\r\nSOCI,"koma, dan ""kutip""\r\nbaris kedua",00123,\r\nBBCA,<img src=x onerror=bad>,=1+1,9007199254740993\r\n';
  const {dom,d,data,route,w,errors}=setup(data=>{
   const doc=data.docs.find(x=>x.kind==='md');Object.assign(doc,{kind:'csv',content:raw,delimiter:',',stats:[]});delete doc.lazy;
  });
  const doc=data.docs.find(x=>x.kind==='csv');route('#doc='+encodeURIComponent(doc.path));
  assert.deepEqual([...d.querySelectorAll('.csv th')].map(x=>x.textContent),['Kode','Catatan','Nilai','Kosong']);
  assert.deepEqual([...d.querySelectorAll('.csv tbody tr')].map(r=>[...r.cells].map(c=>c.textContent)),[
   ['SOCI','koma, dan "kutip"\nbaris kedua','00123',''],['BBCA','<img src=x onerror=bad>','=1+1','9007199254740993']]);
  assert.equal(d.querySelector('.csv img,.csv script'),null);assert.ok(d.querySelector('#reader a[download]'));
  const input=d.getElementById('cari');input.value='baris kedua';input.dispatchEvent(new w.Event('input'));await delay(170);
  assert.equal(d.querySelector('.csv mark').textContent,'baris kedua');assert.deepEqual(errors,[]);dom.window.close();
 });
 await test('CSV header click sorts numbers high-to-low, then low-to-high, then original order; empty last',async()=>{
  const raw='kode,nilai,nama\nAAA,5,beta\nBBB,,alfa\nCCC,12,Gamma\nDDD,-1,\nEEE,1.234,delta\n';
  const {dom,d,data,route,w,errors}=setup(data=>{
   const doc=data.docs.find(x=>x.kind==='md');Object.assign(doc,{kind:'csv',content:raw,delimiter:',',stats:[]});delete doc.lazy;
  });
  const doc=data.docs.find(x=>x.kind==='csv');route('#doc='+encodeURIComponent(doc.path));
  const codes=()=>[...d.querySelectorAll('.csv tbody tr')].map(r=>r.cells[0].textContent),th=i=>d.querySelectorAll('.csv th')[i];
  assert.deepEqual([...d.querySelectorAll('.csv th')].map(x=>x.textContent),['kode','nilai','nama']);
  th(1).querySelector('button').click();assert.deepEqual(codes(),['CCC','AAA','EEE','DDD','BBB']);assert.equal(th(1).getAttribute('aria-sort'),'descending');
  th(1).querySelector('button').click();assert.deepEqual(codes(),['DDD','EEE','AAA','CCC','BBB']);assert.equal(th(1).getAttribute('aria-sort'),'ascending');
  th(1).querySelector('button').click();assert.deepEqual(codes(),['AAA','BBB','CCC','DDD','EEE']);assert.equal(th(1).hasAttribute('aria-sort'),false);
  th(2).querySelector('button').click();assert.deepEqual(codes(),['BBB','AAA','EEE','CCC','DDD']);assert.equal(th(2).getAttribute('aria-sort'),'ascending');
  // Urutan bertahan saat pencarian merender ulang dokumen.
  const input=d.getElementById('cari');input.value='alfa';input.dispatchEvent(new w.Event('input'));await delay(170);
  assert.deepEqual(codes(),['BBB','AAA','EEE','CCC','DDD']);assert.equal(d.querySelector('.csv mark').textContent,'alfa');
  assert.deepEqual(errors,[]);dom.window.close();
 });
 await test('CSV semicolons, tabs, blank records and malformed quotes have usable output',async()=>{
  for(const [raw,delimiter,expected] of [
   ['Nama;Nilai\n"A;B";""\n',';',['A;B','']],['Nama\tNilai\nA\t02','\t',['A','02']],
   ['Judul\n\n""\nA,ekstra\n',',',['','A','ekstra']],
   ['',',',null],['Nama,Nilai\nA,"kutip belum ditutup',',',null]
  ]){
   const {dom,d,data,route}=setup(data=>{const doc=data.docs[0];Object.assign(doc,{kind:'csv',content:raw,delimiter,stats:[]});delete doc.lazy;});
   route('#doc='+encodeURIComponent(data.docs[0].path));
   if(expected)assert.deepEqual([...d.querySelectorAll('.csv td')].map(c=>c.textContent),expected);
   else {assert.equal(d.querySelector('.csv table'),null);assert.match(d.querySelector('.csv').textContent,/kosong|kutip/);}
   dom.window.close();
  }
 });
 await test('CSV lazy loading retries failures, renders the table and remains searchable',async()=>{
  let attempts=0;
  const {dom,d,data,route,w,errors}=setup(data=>{
   data.docs=data.docs.slice(0,1);Object.assign(data.docs[0],{kind:'csv',delimiter:',',lazy:true,stats:[]});delete data.docs[0].content;
  },null,()=>{attempts++;if(attempts===1)throw Error('Offline');return new Response('Kode,Catatan\nSOCI,unikcsv');});
  route('#doc='+encodeURIComponent(data.docs[0].path));await delay(10);assert.ok(d.querySelector('[data-retry-doc]'));
  d.querySelector('[data-retry-doc]').click();await delay(10);assert.equal(attempts,2);assert.equal(d.querySelector('.csv td').textContent,'SOCI');
  route('#');const input=d.getElementById('cari');input.value='unikcsv';input.dispatchEvent(new w.Event('input'));await delay(170);
  assert.match(d.getElementById('cari-catatan').textContent,/1 dari 1 dokumen/);assert.deepEqual(errors,[]);dom.window.close();
 });
 await test('prototype routes and hostile query/hash do not crash or inject HTML',async()=>{
  const {dom,d,route,errors,w}=setup();for(const word of ['constructor','__proto__','toString','<img src=x onerror=bad>'])route('#doc='+encodeURIComponent(word));
  const input=d.getElementById('cari');input.value='<svg onload=bad>';input.dispatchEvent(new w.Event('input'));await delay(160);
  assert.equal(d.querySelector('#cari-catatan svg'),null);assert.deepEqual(errors,[]);dom.window.close();
 });
 await test('all current ownership data passes schema, all companies render detail including charts',async()=>{
  const {dom,d,data,route,errors}=setup();route('#kepemilikan=');await delay(5);
  assert.ok(d.querySelector('#own-body table'));assert.equal(d.querySelectorAll('#own-emiten option').length,ownership.companies.length+1);
  for(const company of ownership.companies){route('#kepemilikan='+company.t);assert.ok(d.querySelector('#own-trend svg'),company.t);}
  await delay(10);assert.deepEqual(errors,[]);dom.window.close();
 });
 await test('ownership history: issuer-report months before KSEI, ≥5% series, hollow unverified points, default range',async()=>{
  const first=ownership.months.findIndex(m=>m.asOf);assert.ok(first>0,'months before the first KSEI file');
  const {dom,d,route,errors}=setup();route('#kepemilikan=ADES');await delay(10);
  assert.equal(d.getElementById('own-dari').value,String(first));assert.equal(d.getElementById('own-sampai').value,String(ownership.months.length-1));
  const legend=[...d.querySelectorAll('#own-trend text.t')].map(t=>t.textContent);assert.ok(legend.includes('Pemegang ≥5%'),legend.join());
  assert.ok(d.querySelector('#own-trend circle.own-dot.s5'));assert.ok(d.querySelector('#own-trend circle.own-dot.open'),'unverified months are hollow');
  const rows=d.querySelector('.own-twin').querySelectorAll('tbody tr');assert.ok(rows.length>first,'monthly table reaches back before KSEI');
  assert.match(rows[rows.length-1].cells[0].textContent,/Mei 2023/);
  assert.match(d.querySelector('.own-tiles').textContent,/Pemegang ≥5%91,35%/);
  assert.ok(d.querySelector('#own-reports table'),'DPS table filled from kepemilikan-laporan.json');assert.deepEqual(errors,[]);dom.window.close();
 });
 if(reports)await test('malformed or hostile issuer-report file is rejected or inert',async()=>{
  const t=Object.keys(reports.companies).find(k=>reports.companies[k].d);
  let {dom,d,route,errors}=setup(null,null,null,r=>{r.names.fill('<img src=x onerror=bad>');r.companies[t].u=r.companies[t].u.map(()=>'javascript:alert(1)');});
  route('#kepemilikan='+t);await delay(10);
  assert.equal(d.querySelector('#own-body img,#own-body a[href^="javascript:"]'),null);dom.window.close();
  for(const attack of [r=>r.format=2,r=>{r.companies[t].d[0]=5;},r=>r.companies[t].u[0]='../x?<',r=>r.months.pop(),r=>r.base='http://x/']){
   ({dom,d,route}=setup(null,null,null,attack));route('#kepemilikan='+t);await delay(10);
   assert.equal(d.querySelector('#own-reports table'),null);assert.match(d.getElementById('own-reports').textContent,/belum berhasil dimuat/);dom.window.close();
  }
 });
 const filed=Object.keys(changes.companies)[0];
 if(filed)await test('ownership-change filings render, hostile values stay inert, malformed file is rejected',async()=>{
  let {dom,d,route,errors}=setup();route('#kepemilikan='+filed);await delay(10);
  assert.equal(d.querySelectorAll('#own-changes tbody tr').length,changes.companies[filed].length);assert.deepEqual(errors,[]);dom.window.close();
  ({dom,d,route,errors}=setup(null,ch=>{const r=ch.companies[filed][0];r[1]='<img src=x onerror=bad>';r[2]='<svg onload=bad>';r[9]=['<script>bad()</script>'];r[10]='javascript:alert(1)';r[7]=[['<b>x</b>',1,1,1,null]];}));
  route('#kepemilikan='+filed);await delay(10);
  assert.equal(d.querySelector('#own-changes img,#own-changes svg,#own-changes script,#own-changes b,#own-changes a[href^="javascript:"]'),null);assert.deepEqual(errors,[]);dom.window.close();
  for(const attack of [ch=>ch.companies[filed][0][0]='2026-13-99x',ch=>ch.companies[filed][0][3]='1',ch=>ch.companies['bad key']=[],ch=>ch.format=2]){
   ({dom,d,route}=setup(null,attack));route('#kepemilikan='+filed);await delay(10);
   assert.equal(d.querySelector('#own-changes table'),null);assert.match(d.getElementById('own-changes').textContent,/belum berhasil dimuat/);dom.window.close();
  }
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
 console.log('Completed',checks,'web security scenarios (including',ownership.companies.length,'company renders).');
})().catch(e=>{console.error(e);process.exitCode=1;});
