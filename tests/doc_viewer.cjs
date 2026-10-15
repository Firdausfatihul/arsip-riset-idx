// Offline DOM regressions for the Markdown document viewer (APP_JS in build.py): #doc= routing and &s= jumps,
// contents from H2 or H1, issuer badges and the Emiten grid, "Label: isi" facts, schedules, lazy documents with
// "Coba lagi", search counts and <mark>, and the source buttons. Builds tests/helpers/doc_fixture.py into a temp
// folder; never the real archive or network. Run: NODE_PATH=/path/to/test-deps/node_modules node tests/doc_viewer.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {JSDOM, VirtualConsole} = require('jsdom');
const {marked} = require('marked');
const purify = require('dompurify');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-viewer-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const KI = 'files/keterbukaan-informasi/2026-09-22/ki_22092026.md', LAZY = 'files/keterbukaan-informasi/2026-09-15/ki_20260915.md';
let checks = 0;

function setup(site, {failing = new Set()} = {}) {
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8').replace(/<style>[\s\S]*?<\/style>/g, '');
  const dom = new JSDOM(html, {url: 'https://archive.test/', runScripts: 'outside-only', virtualConsole: vc});
  const w = dom.window, d = w.document, scrolled = [];
  const data = JSON.parse(d.getElementById('arsip-data').textContent);
  w.marked = marked; w.DOMPurify = purify(w);
  w.matchMedia = () => ({matches: false, addEventListener() {}});
  w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };
  w.fetch = async url => {
    const p = decodeURIComponent(String(url).split('?')[0]);
    if (p === 'version.json') return Response.json({version: data.version});
    if (failing.has(p)) return new Response('nope', {status: 500});
    const file = path.join(site, p);
    if (!file.startsWith(site + path.sep) || !fs.existsSync(file)) throw new Error('Network forbidden in doc test: ' + url);
    return new Response(fs.readFileSync(file));
  };
  w.eval([...d.querySelectorAll('script')].at(-1).textContent);
  const reader = d.getElementById('reader');
  async function until(ready) {
    for (let i = 0; i < 200 && !ready(); i++) await delay(5);
    assert.ok(ready(), 'timed out');
    assert.deepEqual(errors, []);
  }
  async function go(hash, ready = () => true) {
    w.history.replaceState(null, '', hash); w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    await until(ready);
  }
  async function search(q) {
    const input = d.getElementById('cari');
    input.value = q; input.dispatchEvent(new w.Event('input'));
    await delay(200);
  }
  const texts = selector => [...reader.querySelectorAll(selector)].map(el => el.textContent.trim());
  return {w, d, data, reader, go, until, search, texts, scrolled};
}
async function test(name, fn) { await fn(); checks++; console.log('PASS', name); }

(async () => {
  const site = execFileSync('python3', ['-B', path.join(root, 'tests/helpers/doc_fixture.py'), tmp], {cwd: root, encoding: 'utf8'}).trim();

  await test('#doc= renders H2 contents, numbered issuer sections, facts and a schedule; &s= jumps to the issuer', async () => {
    const {reader, go, texts, scrolled} = setup(site);
    await go('#doc=' + KI + '&s=esta', () => reader.querySelector('.toc'));
    assert.equal(reader.hidden, false);
    assert.equal(reader.querySelector('.doc-head h1').textContent, 'KI scan');
    assert.deepEqual(texts('.toc-panel > ol a'), ['Temuan utama', 'Batas bukti']);
    assert.deepEqual(texts('.tick-grid a'), ['FORU', 'ESTA']);
    assert.match(reader.querySelector('.tick-grid a').getAttribute('href'), /^#doc=.*&s=foru$/);
    assert.deepEqual(texts('section.emiten .ticker'), ['FORU', 'ESTA']);
    assert.deepEqual(texts('section.emiten .emiten-no'), ['1', '2.1']);
    assert.deepEqual(texts('#foru dl.facts dt'), ['Status', 'Nilai']);
    assert.deepEqual(texts('#foru ol.schedule time'), ['15 Oktober 2026', '17 Oktober 2026', '20 Oktober 2026']);
    assert.equal(scrolled.at(-1), 'esta');
  });

  await test('documents divided by "#" take their contents from H1; "## KODE" only joins the Emiten grid', async () => {
    const {reader, go, texts} = setup(site);
    await go('#doc=files/keterbukaan-australia/2026-09-13/asx_20260913.md', () => reader.querySelector('.toc'));
    assert.equal(texts('.toc-panel > ol a').length, 2);
    assert.deepEqual(texts('.tick-grid a'), ['DOOH']);
    await go('#doc=files/digest-emiten/2026-10-01/digest_2026-10-01_2026-10-02.md', () => /Digest/.test(texts('.doc-head h1')[0]));
    assert.deepEqual(texts('.tick-grid a'), ['BAJA']);
    assert.equal(reader.querySelector('.toc-panel > ol'), null);
  });

  await test('a document over EMBED_LIMIT loads lazily; a failed load offers "Coba lagi", which renders it', async () => {
    const failing = new Set([LAZY]);
    const {data, reader, go, until, texts} = setup(site, {failing});
    assert.equal(data.docs.find(doc => doc.path === LAZY).lazy, true);
    await go('#doc=' + LAZY, () => reader.querySelector('[data-retry-doc]'));
    assert.match(reader.textContent, /Gagal memuat dokumen/);
    failing.clear();
    reader.querySelector('[data-retry-doc]').click();
    await until(() => reader.querySelector('.tick-grid'));
    assert.deepEqual(texts('.tick-grid a'), ['MNCN']);
  });

  await test('search counts matches across sources, marks them in the open document, and keeps the source buttons', async () => {
    const {d, reader, go, search, texts} = setup(site);
    await go('#');
    await search('rights issue');
    assert.match(d.getElementById('cari-catatan').textContent, /^\d+ dari \d+ dokumen \(semua sumber\) memuat “rights issue”/);
    const card = d.querySelector('[data-id] .hits:not(:empty)');
    assert.match(card.textContent, /^\d+× di teks$/);
    await go('#doc=' + KI, () => reader.querySelector('mark.arsip-hit'));
    assert.deepEqual(texts('mark.arsip-hit'), ['rights issue']);
    assert.match(reader.querySelector('.hit-note').textContent, /“rights issue” muncul 1× di dokumen ini/);
    assert.ok(d.querySelectorAll('.category-nav a').length > 0);
  });

  await test('source buttons in order; #keterbukaan-singapura opens the SGX list and clears the search', async () => {
    const {d, go, search} = setup(site);
    assert.deepEqual([...d.querySelectorAll('.category-nav a')].map(a => a.getAttribute('data-cat')),
      ['stockbit', 'stockbit-ringkasan', 'stockbit-detail', 'stockbit-pekan', 'bei-ringkasan', 'bei-detail', 'bei-pekan',
        'keterbukaan-australia', 'keterbukaan-singapura', 'lainnya']);
    await search('SOCI');
    await go('#keterbukaan-singapura');
    assert.equal(d.getElementById('cari').value, '');
    assert.equal(d.querySelector('.category-nav a[aria-current]').getAttribute('data-cat'), 'keterbukaan-singapura');
    const visible = [...d.querySelectorAll('#overview .cat')].filter(cat => !cat.hidden).map(cat => cat.id);
    assert.deepEqual(visible, ['keterbukaan-singapura']);
  });

  console.log(`${checks} document viewer checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, {recursive: true, force: true}));
