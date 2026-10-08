// Offline DOM regressions for the Stockbit #emiten= / #pengguna= routes. NODE_PATH must provide jsdom
// (marked and dompurify are used when present). Builds a tiny fixture with a hostile stockbit-index.json via
// tests/helpers/stockbit_fixture.py into a temporary folder; never touches the real archive or network.
// Run: NODE_PATH=/path/to/test-deps/node_modules node tests/stockbit_viewer.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {JSDOM, VirtualConsole} = require('jsdom');
const optional = name => { try { return require(name); } catch { return null; } };
const markedLib = optional('marked'), purify = optional('dompurify');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-viewer-'));
const EVIL = '<img src=x onerror="window.pwned=1">';
let checks = 0;

try {
  execFileSync('python3', ['-B', path.join(root, 'tests/helpers/stockbit_fixture.py'), tmp], {cwd: root, encoding: 'utf8'});
  const site = path.join(tmp, 'site');
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8').replace(/<style>[\s\S]*?<\/style>/g, '');
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function setup({failIndex = false} = {}) {
    const errors = [], vc = new VirtualConsole();
    vc.on('jsdomError', error => errors.push(error.message));
    const dom = new JSDOM(html, {url: 'https://archive.test/', runScripts: 'outside-only', virtualConsole: vc});
    const w = dom.window, d = w.document;
    const data = JSON.parse(d.getElementById('arsip-data').textContent);
    if (markedLib && purify) { w.marked = markedLib.marked; w.DOMPurify = purify(w); }
    w.matchMedia = () => ({matches: false, addEventListener() {}});
    w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
    const fetched = [];
    w.fetch = async url => {
      const p = decodeURIComponent(String(url).split('?')[0]);
      fetched.push(p);
      if (p === 'version.json') return Response.json({version: data.version});
      if (p === data.stockbit.path && failIndex) return new Response('nope', {status: 500});
      const file = path.join(site, p);
      if (!file.startsWith(site + path.sep) || !fs.existsSync(file)) throw new Error('Network forbidden in stockbit test: ' + url);
      return new Response(fs.readFileSync(file));
    };
    w.eval([...d.querySelectorAll('script')].at(-1).textContent);
    async function go(hash, ready) {
      w.history.replaceState(null, '', hash); w.dispatchEvent(new w.HashChangeEvent('hashchange'));
      for (let i = 0; i < 200; i++) { await delay(5); if (ready()) break; }
      assert.deepEqual(errors, []);
    }
    const reader = d.getElementById('reader');
    const safe = () => {
      assert.equal(reader.querySelectorAll('img,script,iframe,svg').length, 0, 'no injected elements');
      for (const el of reader.querySelectorAll('*'))
        for (const a of el.attributes) assert.ok(!/^on/i.test(a.name), 'no event handler attribute ' + a.name);
      for (const a of reader.querySelectorAll('a[href]')) assert.match(a.getAttribute('href'), /^(#|https:\/\/|files\/)/);
      assert.equal(w.pwned, undefined);
    };
    return {w, d, data, reader, go, safe, fetched, close: () => w.close()};
  }
  async function test(name, opts, fn) {
    const s = setup(opts);
    try { await fn(s); checks++; console.log('PASS', name); } finally { s.close(); }
  }
  const text = el => el.textContent.replace(/\s+/g, ' ');

  (async () => {
    await test('emiten page renders newest-first rows with doc links and escapes hostile strings', {}, async s => {
      await s.go('#emiten=bbca', () => s.reader.querySelector('table'));
      const docs = Object.fromEntries(s.data.docs.map(x => [x.name, x]));
      assert.equal(s.reader.hidden, false);
      assert.equal(s.d.getElementById('overview').hidden, true);
      assert.equal(s.reader.querySelector('h1').textContent, 'BBCA');
      assert.match(text(s.reader), /Klaim pengguna Stockbit, belum diverifikasi/);
      const rows = [...s.reader.querySelectorAll('tbody tr')];
      assert.equal(rows.length, 2);
      assert.match(rows[0].cells[0].textContent, /^5 Oktober 2026/);
      assert.match(rows[1].cells[0].textContent, /^20 September 2026/);
      const first = rows[0].cells[0].querySelector('a');
      assert.equal(first.getAttribute('href'), '#doc=' + docs['sbringkas_2026-10-05_2026-10-05.md'].path + '&s=bbca');
      assert.equal(rows[0].cells[0].querySelectorAll('a')[1].getAttribute('href'),
        '#doc=' + docs['sbdetail_2026-10-05_2026-10-05.md'].path + '&s=bbca');
      // Hostile strings stay literal text.
      assert.ok(rows[0].cells[4].textContent.includes('inti BBCA' + EVIL));
      assert.ok(rows[0].cells[0].textContent.includes('sementara<img src'));
      assert.ok(rows[0].cells[5].textContent.includes('2 rumor'));
      assert.ok(rows[0].cells[5].textContent.includes('4 <img src=x onerror'));
      assert.deepEqual([...rows[0].cells].slice(1, 4).map(c => c.textContent), ['14', '9', '3']);
      s.safe();
      assert.equal(s.fetched.filter(p => p === s.data.stockbit.path).length, 1);
      // Cached: another route does not refetch.
      await s.go('#emiten=TLKM', () => s.reader.querySelector('h1')?.textContent === 'TLKM' && s.reader.querySelector('table'));
      const tlkm = s.reader.querySelector('tbody tr a');
      assert.equal(tlkm.getAttribute('href'), '#doc=' + docs['sbringkas_2026-10-05_2026-10-05.md'].path + '&s=disebut-tanpa-temuan');
      assert.equal(s.fetched.filter(p => p === s.data.stockbit.path).length, 1);
    });

    await test('opening the day doc from the emiten page jumps to the ticker section', {}, async s => {
      await s.go('#emiten=BBCA', () => s.reader.querySelector('table'));
      const href = s.reader.querySelector('tbody tr a').getAttribute('href');
      await s.go(href, () => s.reader.querySelector('.prose h2, .prose pre'));
      assert.match(s.reader.querySelector('h1').textContent, /Ringkasan Stockbit Ideas · 5 Oktober 2026/);
      if (s.w.DOMPurify) {
        assert.ok(s.reader.querySelector('#bbca'));
        const hist = s.reader.querySelector('#bbca a.sb-hist');
        assert.equal(hist.getAttribute('href'), '#emiten=BBCA');
        const handle = [...s.reader.querySelectorAll('.prose a')].find(a => a.textContent === '@GoldenDirt');
        assert.equal(handle.getAttribute('href'), '#pengguna=GoldenDirt');
        assert.ok([...s.reader.querySelectorAll('.prose a')].some(a => a.getAttribute('href') === '#pengguna=Evil_Handle'));
      }
      s.safe();
    });

    await test('pengguna page shows rows, finding links and the labelled judgement without HTML injection', {}, async s => {
      await s.go('#pengguna=@goldendirt', () => s.reader.querySelector('table'));
      const docs = Object.fromEntries(s.data.docs.map(x => [x.name, x]));
      assert.equal(s.reader.querySelector('h1').textContent, '@GoldenDirt');
      assert.match(text(s.reader), /Klaim pengguna Stockbit, belum diverifikasi/);
      const box = s.reader.querySelector('.sb-judgement');
      assert.equal(box.querySelector('h2').textContent, 'Penilaian otomatis atas argumen di posting, bukan atas orangnya');
      assert.ok(box.textContent.includes('Argumen bersandar pada satu sumber tanpa dokumen.' + EVIL));
      const refs = [...box.querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')]);
      assert.deepEqual(refs.slice(0, 2), [
        ['F20261005-0001', '#doc=' + docs['sbdetail_2026-10-05_2026-10-05.md'].path],
        ['F20260920-0003', '#doc=' + docs['sbdetail_2026-09-20_2026-09-20.md'].path]]);
      const rows = [...s.reader.querySelectorAll('tbody tr')];
      assert.equal(rows.length, 2);
      assert.match(rows[0].cells[0].textContent, /^5 Oktober 2026/);
      assert.equal(rows[0].cells[1].textContent, '11');
      const chips = [...rows[0].cells[2].querySelectorAll('.chip')];
      assert.equal(chips[0].getAttribute('href'), '#doc=' + docs['sbringkas_2026-10-05_2026-10-05.md'].path + '&s=bbca');
      assert.ok(chips.some(c => c.textContent === EVIL.slice(0, 12)));
      assert.ok(rows[0].cells[3].textContent.includes('F20261005-0001'));
      assert.ok(rows[0].cells[3].textContent.includes(EVIL));
      s.safe();
    });

    await test('hostile handle key and prototype names render as text or not-found', {}, async s => {
      await s.go('#pengguna=' + encodeURIComponent(EVIL), () => s.reader.querySelector('table'));
      assert.equal(s.reader.querySelector('h1').textContent, '@' + EVIL);
      s.safe();
      for (const name of ['constructor', '__proto__', 'toString']) {
        await s.go('#pengguna=' + name, () => /tidak ada di indeks/.test(s.reader.textContent));
        assert.match(s.reader.textContent, /tidak ada di indeks ringkasan Stockbit/);
        s.safe();
      }
      await s.go('#emiten=ZZZZ', () => /belum muncul/.test(s.reader.textContent));
      s.safe();
    });

    await test('search box routes ticker and @handle; failed index load offers retry', {failIndex: true}, async s => {
      const form = s.d.querySelector('[data-sb-find]');
      assert.ok(form);
      form.querySelector('input').value = 'bbca';
      form.dispatchEvent(new s.w.Event('submit', {cancelable: true}));
      assert.equal(s.w.location.hash, '#emiten=BBCA');
      form.querySelector('input').value = '@Golden Dirt';
      form.dispatchEvent(new s.w.Event('submit', {cancelable: true}));
      assert.equal(s.w.location.hash, '#pengguna=Golden%20Dirt');
      await s.go('#emiten=BBCA', () => s.reader.querySelector('[data-sb-retry]'));
      assert.match(s.reader.textContent, /gagal dimuat/);
      s.safe();
    });

    await test('global search hints the Stockbit routes', {}, async s => {
      const input = s.d.getElementById('cari');
      input.value = 'BBCA'; input.dispatchEvent(new s.w.Event('input'));
      await delay(200);
      const hint = [...s.d.querySelectorAll('#cari-catatan a')].find(a => a.getAttribute('href') === '#emiten=BBCA');
      assert.ok(hint, 'ticker hint');
      input.value = '@GoldenDirt'; input.dispatchEvent(new s.w.Event('input'));
      await delay(200);
      assert.ok([...s.d.querySelectorAll('#cari-catatan a')].some(a => a.getAttribute('href') === '#pengguna=GoldenDirt'));
      // Bulk search preload never fetches the detail files.
      await delay(100);
      assert.ok(!s.fetched.some(p => /sbdetail_/.test(p)), 'detail docs not preloaded');
      assert.ok(s.fetched.some(p => /sbringkas_2026-09-20/.test(p)), 'old ringkasan still searchable');
    });

    console.log(`${checks} Stockbit viewer checks passed` + (markedLib && purify ? '' : ' (marked/dompurify absent: doc markdown checks reduced)'));
  })().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(tmp, {recursive: true, force: true}));
} catch (error) {
  fs.rmSync(tmp, {recursive: true, force: true});
  throw error;
}
