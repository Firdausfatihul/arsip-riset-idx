// Offline DOM regressions for the merged #emiten= page (Keterbukaan resmi BEI above Diskusi Stockbit), the BEI source
// button, retired KI/digest lists and hostile bei-index.json strings. NODE_PATH must provide jsdom (marked and dompurify
// are used when present). Builds a tiny fixture via tests/helpers/bei_fixture.py into a temporary folder; never touches
// the real archive or network.
// Run: NODE_PATH=/path/to/test-deps/node_modules node tests/bei_viewer.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {JSDOM, VirtualConsole} = require('jsdom');
const optional = name => { try { return require(name); } catch { return null; } };
const markedLib = optional('marked'), purify = optional('dompurify');
const root = path.resolve(__dirname, '..');
const EVIL = '<img src=x onerror="window.pwned=1">';
const BEI_NOTE = 'Ringkasan otomatis dari pengumuman resmi di idx.co.id; bukan rekomendasi.';
const SB_NOTE = 'Klaim pengguna Stockbit, belum diverifikasi, bukan keterbukaan resmi.';
const tmps = [];
let checks = 0;

function fixture(extra = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bei-viewer-'));
  tmps.push(tmp);
  execFileSync('python3', ['-B', path.join(root, 'tests/helpers/bei_fixture.py'), tmp, ...extra], {cwd: root, encoding: 'utf8'});
  const site = path.join(tmp, 'site');
  return {site, html: fs.readFileSync(path.join(site, 'index.html'), 'utf8').replace(/<style>[\s\S]*?<\/style>/g, '')};
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function setup({site, html}, {fail = []} = {}) {
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
    if (fail.includes(p)) return new Response('nope', {status: 500});
    const file = path.join(site, p);
    if (!file.startsWith(site + path.sep) || !fs.existsSync(file)) throw new Error('Network forbidden in bei test: ' + url);
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
  const docs = Object.fromEntries(data.docs.map(x => [x.name, x]));
  return {w, d, data, docs, reader, go, safe, fetched, close: () => w.close()};
}
const text = el => el.textContent.replace(/\s+/g, ' ');
const sec = (s, cls) => s.reader.querySelector('.em-sec.' + cls);

(async () => {
  const both = fixture();
  async function test(name, opts, fn, fx = both) {
    const s = setup(fx, opts);
    try { await fn(s); checks++; console.log('PASS', name); } finally { s.close(); }
  }

  await test('emiten page: BEI section above Stockbit, separate disclaimers, newest-first rows, section links', {}, async s => {
    await s.go('#emiten=bbca', () => sec(s, 'em-bei')?.querySelector('table') && sec(s, 'em-stockbit')?.querySelector('table'));
    assert.equal(s.reader.querySelector('h1').textContent, 'BBCA');
    assert.ok(s.reader.querySelector('.em-name').textContent.startsWith('Bank Central Asia Tbk<img'));
    const sections = [...s.reader.querySelectorAll('.em-sec')];
    assert.deepEqual(sections.map(x => x.querySelector('h2').textContent), ['Keterbukaan resmi BEI', 'Diskusi Stockbit']);
    const bei = sections[0], sb = sections[1];
    assert.match(text(bei), new RegExp(BEI_NOTE.replace(/[.;]/g, '\\$&')));
    assert.ok(!text(bei).includes(SB_NOTE), 'Stockbit disclaimer only in the Stockbit section');
    assert.ok(text(sb).includes(SB_NOTE));
    assert.ok(!text(sb).includes('pengumuman resmi di idx.co.id'), 'BEI disclaimer only in the BEI section');
    assert.ok(!text(s.reader.querySelector('.doc-head')).includes(SB_NOTE), 'no Stockbit disclaimer in the page header');
    assert.deepEqual([...bei.querySelectorAll('th')].map(th => th.textContent), ['Tanggal', 'Pengumuman', 'Status/Tahap', 'Yang berubah', 'Kategori']);
    const rows = [...bei.querySelectorAll('tbody tr')];
    assert.equal(rows.length, 2);
    assert.match(rows[0].cells[0].textContent, /^6 Oktober 2026/);
    assert.match(rows[1].cells[0].textContent, /^5 Oktober 2026/);
    const links = [...rows[1].cells[0].querySelectorAll('a')].map(a => a.getAttribute('href'));
    assert.deepEqual(links, ['#doc=' + s.docs['beiringkas_2026-10-05_2026-10-05.md'].path + '&s=bbca',
      '#doc=' + s.docs['beidetail_2026-10-05_2026-10-05.md'].path + '&s=bbca']);
    // Hostile strings stay literal text (status, stage, delta, category keys, day state, ids in the title attribute).
    assert.ok(rows[0].cells[0].textContent.includes('sementara<img src'));
    assert.equal(rows[0].cells[1].textContent, '3 · 2 non-rutin');
    assert.ok(rows[0].cells[1].getAttribute('title').includes(EVIL));
    assert.ok(rows[0].cells[2].textContent.includes('lanjutan' + EVIL + ' · panggilan RUPS' + EVIL));
    assert.ok(rows[0].cells[3].textContent.startsWith('Sebelumnya rencana rights issue (05/10); hari ini panggilan RUPS.<img'));
    assert.ok(rows[0].cells[4].textContent.includes('Aksi korporasi 2'));
    assert.ok(rows[0].cells[4].textContent.includes(EVIL + ' 4'));
    assert.equal(sb.querySelectorAll('tbody tr').length, 2);
    s.safe();
    assert.equal(s.fetched.filter(p => p === s.data.bei.path).length, 1);
    assert.equal(s.fetched.filter(p => p === s.data.stockbit.path).length, 1);
  });

  await test('code only in BEI, only in Stockbit, routine-only rows, malformed rows and prototype keys', {}, async s => {
    await s.go('#emiten=BREN', () => sec(s, 'em-bei')?.querySelector('table'));
    assert.equal(sec(s, 'em-bei').querySelectorAll('tbody tr').length, 1);
    assert.match(text(sec(s, 'em-stockbit')), /BREN belum muncul di ringkasan Stockbit/);
    await s.go('#emiten=TLKM', () => s.reader.querySelector('h1')?.textContent === 'TLKM' && sec(s, 'em-stockbit')?.querySelector('table'));
    assert.match(text(sec(s, 'em-bei')), /TLKM belum muncul di ringkasan keterbukaan BEI/);
    await s.go('#emiten=ASII', () => s.reader.querySelector('h1')?.textContent === 'ASII' && sec(s, 'em-bei')?.querySelector('table'));
    const routine = sec(s, 'em-bei').querySelector('tbody tr');
    assert.equal(routine.cells[0].querySelector('a').getAttribute('href'),
      '#doc=' + s.docs['beiringkas_2026-10-06_2026-10-06.md'].path + '&s=laporan-rutin');
    assert.equal(routine.cells[0].querySelectorAll('a').length, 1, 'no detail link for routine-only days');
    await s.go('#emiten=ZZZZ', () => s.reader.querySelector('h1')?.textContent === 'ZZZZ' && sec(s, 'em-bei'));
    assert.match(text(sec(s, 'em-bei')), /ZZZZ belum muncul/);
    for (const name of ['constructor', '__proto__', 'toString']) {
      await s.go('#emiten=' + name, () => s.reader.querySelector('h1')?.textContent === name.toUpperCase() && sec(s, 'em-bei'));
      assert.match(text(sec(s, 'em-bei')), /belum muncul di ringkasan keterbukaan BEI/);
      s.safe();
    }
  });

  await test('a failed BEI index offers retry without hiding the Stockbit section', {fail: ['files/bei-index/bei-index.json']}, async s => {
    await s.go('#emiten=BBCA', () => sec(s, 'em-bei')?.querySelector('[data-sb-retry]'));
    assert.match(text(sec(s, 'em-bei')), /Indeks keterbukaan BEI gagal dimuat/);
    assert.equal(sec(s, 'em-stockbit').querySelectorAll('tbody tr').length, 2);
    s.safe();
  });

  await test('source buttons, retired lists, digest via old link, search hints and bulk preload', {}, async s => {
    const nav = [...s.d.querySelectorAll('.category-nav a')].map(a => [a.getAttribute('data-cat'), a.textContent]);
    assert.ok(nav.some(([cat, label]) => cat === 'bei-ringkasan' && label === 'Indonesia (BEI)'));
    assert.ok(!nav.some(([cat]) => cat === 'keterbukaan-informasi' || cat === 'digest-emiten'));
    assert.equal(nav.filter(([, label]) => label === 'Indonesia (BEI)').length, 1);
    await s.go('#bei-ringkasan', () => !s.d.getElementById('overview').hidden);
    const visible = [...s.d.querySelectorAll('#overview li.doc')].filter(li => !li.hidden).map(li => li.closest('.cat').id);
    assert.ok(visible.length && visible.every(id => id === 'bei-ringkasan'));
    assert.equal(s.d.querySelector('.cat-legacy a').getAttribute('href'), '#keterbukaan-informasi');
    await s.go('#keterbukaan-informasi', () => [...s.d.querySelectorAll('#keterbukaan-informasi li.doc')].some(li => !li.hidden));
    // The retired digest is not listed or counted, but its old #doc= link still opens it.
    const digest = s.docs['digest_2026-10-01_2026-10-02.md'];
    assert.equal(s.d.querySelector('[data-id="' + digest.id + '"]'), null);
    await s.go('#doc=' + digest.path, () => /Digestkhusus/.test(s.reader.textContent));
    assert.equal(s.reader.hidden, false);
    // '← Daftar' from the retired digest returns to the source the reader came from, never an empty overview.
    assert.equal(s.reader.querySelector('.crumbs a').getAttribute('href'), '#');
    await s.go('#', () => !s.d.getElementById('overview').hidden);
    assert.ok([...s.d.querySelectorAll('#keterbukaan-informasi li.doc')].some(li => !li.hidden));
    assert.equal(s.d.getElementById('kosong').hidden, true);
    await s.go('#doc=' + digest.path, () => !s.reader.hidden && /Digestkhusus/.test(s.reader.textContent));
    const input = s.d.getElementById('cari');
    input.value = 'Digestkhusus'; input.dispatchEvent(new s.w.Event('input'));
    await delay(200);
    assert.match(s.d.getElementById('cari-catatan').textContent, /^0 dari \d+ dokumen/);
    const listed = s.data.docs.filter(x => !x.unlisted).length;
    assert.ok(s.d.getElementById('cari-catatan').textContent.includes(' dari ' + listed + ' dokumen'));
    input.value = 'BBCA'; input.dispatchEvent(new s.w.Event('input'));
    await delay(200);
    const hint = [...s.d.querySelectorAll('#cari-catatan a')].find(a => a.getAttribute('href') === '#emiten=BBCA');
    assert.ok(hint && /keterbukaan BEI dan ringkasan Stockbit/.test(hint.textContent), 'merged ticker hint');
    input.value = 'BREN'; input.dispatchEvent(new s.w.Event('input'));
    await delay(200);
    const bren = [...s.d.querySelectorAll('#cari-catatan a')].find(a => a.getAttribute('href') === '#emiten=BREN');
    assert.ok(bren && /di keterbukaan BEI →/.test(bren.textContent));
    await delay(100);
    assert.ok(!s.fetched.some(p => /beidetail_|sbdetail_|digest_/.test(p)), 'detail and retired docs not preloaded');
    assert.ok(s.fetched.some(p => /beiringkas_2026-09-20/.test(p)), 'old BEI ringkasan still searchable');
    const form = s.d.querySelector('[data-bei-find]');
    form.querySelector('input').value = 'bren';
    form.dispatchEvent(new s.w.Event('submit', {cancelable: true}));
    assert.equal(s.w.location.hash, '#emiten=BREN');
    form.querySelector('input').value = '<img>';
    form.dispatchEvent(new s.w.Event('submit', {cancelable: true}));
    assert.equal(s.w.location.hash, '#emiten=BREN', 'invalid code is ignored');
  });

  await test('opening the BEI day from the emiten page jumps to the issuer and links back', {}, async s => {
    await s.go('#emiten=BBCA', () => sec(s, 'em-bei')?.querySelector('table'));
    const href = sec(s, 'em-bei').querySelector('tbody tr a').getAttribute('href');
    await s.go(href, () => s.reader.querySelector('.prose h2, .prose pre'));
    assert.match(s.reader.querySelector('h1').textContent, /Ringkasan keterbukaan BEI · 6 Oktober 2026/);
    if (s.w.DOMPurify) {
      const hist = s.reader.querySelector('#bbca a.sb-hist');
      assert.ok(hist, 'issuer heading gets the cross-day link');
      assert.equal(hist.getAttribute('href'), '#emiten=BBCA');
    }
    s.safe();
  });

  await test('an old digest link opened directly goes back to a listed source, not an empty archive', {}, async s => {
    const digest = s.docs['digest_2026-10-01_2026-10-02.md'];
    await s.go('#doc=' + digest.path, () => /Digestkhusus/.test(s.reader.textContent));
    await s.go('#', () => !s.d.getElementById('overview').hidden);
    const current = s.d.querySelector('.category-nav a[aria-current="true"]');
    assert.ok(current, 'a source button is selected');
    const visible = [...s.d.querySelectorAll('#overview li.doc')].filter(li => !li.hidden).map(li => li.closest('.cat').id);
    assert.ok(visible.length, 'documents are listed');
    assert.ok(visible.every(id => id === current.getAttribute('data-cat')));
    assert.equal(s.d.getElementById('kosong').hidden, true);
    // Back from the digest after an emiten page: the BEI list.
    await s.go('#emiten=BBCA', () => sec(s, 'em-bei')?.querySelector('table'));
    await s.go('#doc=' + digest.path, () => /Digestkhusus/.test(s.reader.textContent));
    await s.go('#', () => !s.d.getElementById('overview').hidden);
    const bei = [...s.d.querySelectorAll('#overview li.doc')].filter(li => !li.hidden).map(li => li.closest('.cat').id);
    assert.ok(bei.length && bei.every(id => id === 'bei-ringkasan'));
  });

  await test('issuers without their own ringkasan block link to the section the desk names, or to the detail', {}, async s => {
    const jumped = [];
    s.w.HTMLElement.prototype.scrollIntoView = function(){ jumped.push(this.id); };
    const ring = '#doc=' + s.docs['beiringkas_2026-10-06_2026-10-06.md'].path, det = '#doc=' + s.docs['beidetail_2026-10-06_2026-10-06.md'].path;
    const dateLinks = async code => {
      await s.go('#emiten=' + code, () => s.reader.querySelector('h1')?.textContent === code && sec(s, 'em-bei')?.querySelector('table'));
      s.safe();
      return [...sec(s, 'em-bei').querySelector('tbody tr').cells[0].querySelectorAll('a')].map(a => [a.textContent, a.getAttribute('href')]);
    };
    // Hint false: only a line under "## Emiten lain".
    const toba = await dateLinks('TOBA');
    assert.deepEqual(toba.map(l => l[1]), [ring + '&s=emiten-lain', det + '&s=toba']);
    // No hint (older desk index) or a hostile hint: the date opens the detail, which always has ## KODE.
    for (const code of ['BREN', 'MEJA']) {
      const links = await dateLinks(code);
      assert.deepEqual(links, [[links[0][0], det + '&s=' + code.toLowerCase()], ['ringkasan', ring]]);
    }
    if (s.w.DOMPurify) {
      await s.go(toba[0][1], () => s.reader.querySelector('.prose h2'));
      assert.equal(jumped.at(-1), 'emiten-lain', 'lands on the Emiten lain section, not the top');
      jumped.length = 0;
      await s.go(det + '&s=bren', () => s.reader.querySelector('.prose h2') && /Detail keterbukaan/.test(s.reader.textContent));
      assert.equal(jumped.at(-1), 'bren');
    }
  });

  // "selengkapnya": shortened index cells fetch the full text from that day's detail document on demand.
  const EPAC_BEI = 'Sebelumnya (28/09): rencana PMHMETD I hingga 2.000.000.000 saham dan buyback maksimum Rp20.000.000.000, ' +
    'RUPSLB 3 November 2026; hari ini: pemanggilan RUPSLB 3 November 2026 pukul 10.00 WIB [agenda 1-5] dan bukti iklan panggilan, mitra bbca disebut.';
  const EPAC_SB = 'Diskusi EPAC berpusat pada rights issue (rasio 1:2, harga Rp100 menurut brief), harga turun ke 4830, dan ' +
    'perdebatan dividend trap. Juga dibahas buyback Rp8 triliun serta klaim akumulasi asing.';
  const more = (row) => row.querySelector('button.sb-more');
  const settle = async (ready) => { for (let i = 0; i < 200 && !ready(); i++) await delay(5); };

  await test('selengkapnya: flagged and old "…" cells get the button; full text from the detail, fetched once', {}, async s => {
    await s.go('#emiten=EPAC', () => sec(s, 'em-bei')?.querySelector('table') && sec(s, 'em-stockbit')?.querySelector('table'));
    const bei = [...sec(s, 'em-bei').querySelectorAll('tbody tr')], sb = [...sec(s, 'em-stockbit').querySelectorAll('tbody tr')];
    assert.equal(bei.length, 2); assert.equal(sb.length, 2);
    assert.ok(more(bei[0]) && more(bei[1]) && more(sb[0]) && more(sb[1]), 'flag 1 and an unflagged trailing "…" both offer it');
    assert.equal(more(bei[0]).textContent, 'selengkapnya');
    const detailDoc = s.docs['beidetail_2026-10-06_2026-10-06.md'].path, sbDetail = s.docs['sbdetail_2026-10-05_2026-10-05.md'].path;
    assert.ok(!s.fetched.includes(detailDoc) && !s.fetched.includes(sbDetail), 'nothing fetched before a click');
    more(bei[0]).click();
    await settle(() => !more(bei[0]));
    const cell = bei[0].cells[3];
    assert.ok(cell.hasAttribute('data-full'));
    assert.equal(cell.querySelector('span').textContent, EPAC_BEI + '<img src=x onerror="window.pwned=1">', 'markdown escapes removed, HTML stays text');
    assert.ok(!/…/.test(cell.textContent) && !cell.querySelector('.sb-more-note'));
    more(sb[0]).click();
    await settle(() => !more(sb[0]));
    assert.equal(sb[0].cells[4].querySelector('span').textContent, EPAC_SB + '<img src=x onerror="window.pwned=1">');
    s.safe();
    // Re-rendering the page and clicking again reuses the in-memory document.
    await s.go('#emiten=BBCA', () => s.reader.querySelector('h1')?.textContent === 'BBCA');
    await s.go('#emiten=EPAC', () => s.reader.querySelector('h1')?.textContent === 'EPAC' && sec(s, 'em-bei')?.querySelector('button.sb-more'));
    const again = sec(s, 'em-bei').querySelector('tbody tr');
    more(again).click();
    await settle(() => !more(again));
    assert.equal(again.cells[3].querySelector('span').textContent, EPAC_BEI + '<img src=x onerror="window.pwned=1">');
    assert.equal(s.fetched.filter(p => p === detailDoc).length, 1, 'detail fetched once');
    assert.equal(s.fetched.filter(p => p === sbDetail).length, 1);
    s.safe();
  });

  await test('selengkapnya: section missing in the detail falls back to a detail link; unshortened rows have no button', {}, async s => {
    await s.go('#emiten=EPAC', () => sec(s, 'em-bei')?.querySelector('table') && sec(s, 'em-stockbit')?.querySelector('table'));
    const old = sec(s, 'em-bei').querySelectorAll('tbody tr')[1];
    const shortText = old.cells[3].querySelector('span').textContent;
    more(old).click();
    await settle(() => old.querySelector('.sb-more-note'));
    const note = old.querySelector('.sb-more-note');
    assert.match(note.textContent, /^teks lengkap ada di halaman detail/);
    assert.equal(note.querySelector('a').getAttribute('href'), '#doc=' + s.docs['beidetail_2026-10-05_2026-10-05.md'].path + '&s=epac');
    assert.equal(old.cells[3].querySelector('span').textContent, shortText, 'short text kept');
    assert.equal(more(old), null);
    const oldSb = sec(s, 'em-stockbit').querySelectorAll('tbody tr')[1];
    more(oldSb).click();
    await settle(() => oldSb.querySelector('.sb-more-note'));
    assert.equal(oldSb.querySelector('.sb-more-note a').getAttribute('href'), '#doc=' + s.docs['sbdetail_2026-09-20_2026-09-20.md'].path + '&s=epac');
    s.safe();
    // Old index rows without the flag and without "…" (BBCA, BREN, routine ASII) render exactly as before.
    for (const code of ['BBCA', 'BREN', 'ASII']) {
      await s.go('#emiten=' + code, () => s.reader.querySelector('h1')?.textContent === code && sec(s, 'em-bei')?.querySelector('table'));
      assert.equal(s.reader.querySelectorAll('button.sb-more').length, 0, code);
    }
  });

  await test('selengkapnya: a failed detail fetch shows the link instead of an error', {}, async s => {
    const failing = s.docs['beidetail_2026-10-06_2026-10-06.md'].path, real = s.w.fetch;
    s.w.fetch = async url => decodeURIComponent(String(url).split('?')[0]) === failing ? new Response('nope', {status: 500}) : real(url);
    await s.go('#emiten=EPAC', () => sec(s, 'em-bei')?.querySelector('table'));
    const row = sec(s, 'em-bei').querySelector('tbody tr');
    more(row).click();
    assert.equal(more(row).disabled, true, 'busy while loading');
    await settle(() => row.querySelector('.sb-more-note'));
    assert.equal(row.querySelector('.sb-more-note a').getAttribute('href'), '#doc=' + failing + '&s=epac');
    assert.ok(row.cells[3].querySelector('span').textContent.endsWith('…<img src=x onerror="window.pwned=1">'));
    s.safe();
  });

  const beiOnly = fixture(['--no-stockbit']);
  await test('archive without Stockbit index still renders BEI-only emiten pages', {}, async s => {
    assert.equal(s.data.stockbit, null);
    await s.go('#emiten=BBCA', () => sec(s, 'em-bei')?.querySelector('table'));
    assert.equal(sec(s, 'em-stockbit'), null);
    assert.ok(!text(s.reader).includes(SB_NOTE));
    s.safe();
  }, beiOnly);

  console.log(`${checks} BEI viewer checks passed` + (markedLib && purify ? '' : ' (marked/dompurify absent: doc markdown checks reduced)'));
})().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => tmps.forEach(t => fs.rmSync(t, {recursive: true, force: true})));
