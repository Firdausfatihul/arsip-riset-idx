// DOM behavior test with mocked network responses; no real API key or paid request.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {JSDOM} = require('jsdom');
const {marked} = require('marked');
const purify = require('dompurify');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'site/index.html'), 'utf8').replace(/<style>[\s\S]*?<\/style>/g, '');
const dom = new JSDOM(html, {url: 'https://archive.test/', runScripts: 'outside-only'});
const w = dom.window, d = w.document;
const data = JSON.parse(d.querySelector('#arsip-data').textContent);
const source = data.docs.find(x => x.name === 'stockbit_19092026.md');
const record = {source_id: source.id.toUpperCase(), path: source.path, title: source.title, label: source.label};
w.marked = marked; w.DOMPurify = purify(w); w.TextDecoder = TextDecoder;
const requests = [];
let mode = 'success';
w.fetch = async (url, options) => {
  assert.equal(url, data.chatApi);
  requests.push(JSON.parse(options.body));
  assert.ok(!options.headers.Authorization);
  if (mode === 'error') return new Response(JSON.stringify({error: 'Batas sementara tercapai.'}), {status: 429});
  if (mode === 'cancel') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new w.DOMException('Aborted', 'AbortError'))));
  const payload = [
    {type: 'status', text: 'Membaca dokumen…'},
    {type: 'sources', sources: [record], batches: 1},
    {type: 'delta', text: 'Bukti SOCI 🚢 [' + record.source_id + ']. <img src="https://bad.example/pixel"><script>window.hacked=1</script>'},
    {type: 'delta', text: '\n\n[tautan palsu](https://bad.example/) <div style="position:fixed;inset:0">overlay</div><style>body{display:none}</style><form><input name=chat-question></form><svg onload=bad></svg><a href="javascript:bad()">bad</a>'},
    {type: 'progress', completed:1, total:1, text:'Selesai membaca'},
    {type: 'done', documents: 1, batches: 1, context:'a'.repeat(64)}
  ].map(e => JSON.stringify(e) + '\n').join('');
  const bytes = new TextEncoder().encode(payload);
  return new Response(new ReadableStream({start(c) {
    for (let i = 0; i < bytes.length; i += 11) c.enqueue(bytes.slice(i, i + 11));
    c.close();
  }}), {headers: {'Content-Type': 'application/x-ndjson'}});
};
w.eval(fs.readFileSync(path.join(root, 'chat.js'), 'utf8'));
const input = d.querySelector('#chat-question'), form = d.querySelector('#chat-form');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function settled() {
  for (let i = 0; i < 100 && d.querySelector('#chat-send').disabled; i++) await wait(10);
  assert.equal(d.querySelector('#chat-send').disabled, false);
}
async function submit(text) {
  input.value = text;
  form.dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true}));
  await settled();
}
(async () => {
  await submit('Analisis SOCI <img src=x onerror=bad>');
  assert.equal(requests[0].context, undefined);
  assert.equal(d.querySelectorAll('.chat-message').length, 2);
  assert.equal(d.querySelector('.chat-message.user img'), null);
  assert.equal(d.querySelector('.chat-answer img'), null);
  assert.equal(w.hacked, undefined);
  assert.equal(d.querySelector('.chat-answer [style], .chat-answer style, .chat-answer form, .chat-answer svg'), null);
  assert.equal(d.querySelector('#chat-progress').hidden, true);
  const before = requests.length; await submit('x'.repeat(601)); assert.equal(requests.length, before);
  assert.equal(d.querySelector('.chat-answer a').getAttribute('href'), '#doc=' + source.path);
  assert.equal(d.querySelector('.chat-answer a[href^="https:"]'), null);
  assert.ok(d.querySelector('.chat-answer').textContent.includes('🚢'));
  assert.ok(d.querySelector('.chat-sources summary').textContent.includes('dokumen dibaca'));
  await submit('Bagaimana risikonya?');
  assert.equal(requests[1].context, 'a'.repeat(64));
  mode = 'error'; await submit('Tolong lanjutkan');
  assert.ok(d.querySelector('.chat-error').textContent.includes('Batas sementara'));
  mode = 'success'; d.querySelector('.chat-error + button').click(); await settled();
  assert.equal(requests.at(-1).context, 'a'.repeat(64)); // Failed turns do not become model history.
  mode = 'cancel'; input.value = 'Pertanyaan yang dihentikan';
  form.dispatchEvent(new w.Event('submit', {bubbles: true, cancelable: true}));
  assert.equal(d.querySelector('#chat-progress').hidden, false);
  d.querySelector('#chat-stop').click(); await settled();
  assert.equal(d.querySelector('#chat-status').textContent, 'Proses dihentikan.');
  d.querySelector('#chat-new').click();
  assert.equal(d.querySelector('#chat-history').children.length, 0);
  mode = 'success'; await submit('SOCI');
  assert.equal(requests.at(-1).context, undefined);
  console.log('PASS: question, streamed Unicode, verified citation links, sanitization, follow-up history, error/retry, cancellation, new conversation');
  w.close();
})().catch(error => { console.error(error); w.close(); process.exitCode = 1; });
