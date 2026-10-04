// Offline ownership DOM regressions. NODE_PATH must provide jsdom, marked and dompurify.
// Default: test generated site. --source: render current build.py in memory, read synced source JSON.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {JSDOM, VirtualConsole} = require('jsdom');
const {marked} = require('marked');
const purify = require('dompurify');
const root = path.resolve(__dirname, '..');
const source = process.argv.includes('--source');
const base = path.join(root, source ? 'needtobeindexed/idx-signal-desk' : 'site/files/kepemilikan');
const read = name => JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
const ownership = read('kepemilikan.json');
const reports = read('kepemilikan-laporan.json');
const changes = read('kepemilikan-perubahan.json');
// Keep real rows and name tables; limit each isolated DOM to the issuers under test.
const tickers = new Set(['BBCA', 'ABMM', 'ATIC', 'CNTX']);
ownership.companies = ownership.companies.filter(c => tickers.has(c.t));
for (const dataset of [reports, changes]) dataset.companies = Object.fromEntries(Object.entries(dataset.companies).filter(([ticker]) => tickers.has(ticker)));
const html = (source ? execFileSync('python3', ['-B', '-c',
  'import build; h,b=build.build_page([], {}, build.ownership_meta()); print("<!doctype html><html><head>"+h+"</head><body>"+b+"</body></html>")'
], {cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024}) : fs.readFileSync(path.join(root, 'site/index.html'), 'utf8')).replace(/<style>[\s\S]*?<\/style>/g, '');
const index = month => ownership.months.findIndex(m => m.p === month);
const f = index('2026-07'), t = index('2026-08');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let checks = 0;

function setup(mutate) {
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {url: 'https://archive.test/', runScripts: 'outside-only', virtualConsole: vc});
  const w = dom.window, d = w.document;
  const data = JSON.parse(d.getElementById('arsip-data').textContent);
  const own = structuredClone(ownership), rep = structuredClone(reports), ch = structuredClone(changes);
  if (mutate) mutate(own, rep, ch);
  w.marked = marked; w.DOMPurify = purify(w); w.TextDecoder = TextDecoder;
  w.matchMedia = () => ({matches: false, addEventListener() {}});
  w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = async url => {
    const p = String(url).split('?')[0];
    if (p === 'version.json') return Response.json({version: data.version});
    if (p === data.own.path) return Response.json(own);
    if (p === data.own.reports) return Response.json(rep);
    if (p === data.own.changes) return Response.json(ch);
    throw new Error('Network forbidden in ownership test: ' + url);
  };
  w.eval([...d.querySelectorAll('script')].at(-1).textContent);
  async function route(ticker, from, to) {
    const hash = '#kepemilikan=' + ticker + '&dari=' + from + '&sampai=' + to;
    w.history.replaceState(null, '', hash); w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    for (let i = 0; i < 100; i++) {
      await delay(5);
      if (d.querySelector('.own-card') && !d.querySelector('#own-body').textContent.includes('Memuat laporan')) break;
    }
    assert.deepEqual(errors, []);
    assert.doesNotMatch(d.querySelector('#own-body').textContent, /belum berhasil dimuat/);
  }
  const card = title => [...d.querySelectorAll('.own-card')].find(el => el.querySelector('h3')?.textContent === title);
  return {w, d, own, rep, ch, route, card, close: () => w.close()};
}
async function test(name, fn) {
  const s = setup(fn.mutate);
  try { await fn(s); checks++; console.log('PASS', name); } finally { s.close(); }
}
function fixture(mutate, run) { run.mutate = mutate; return run; }
const company = (own, ticker = 'BBCA') => own.companies.find(c => c.t === ticker);
const section = s => s.card('Siapa menambah, siapa mengurangi');
const bar = (s, name) => [...section(s).querySelectorAll('.own-bar-row')].find(el => el.textContent.includes(name));
const newName = (own, name) => own.names.push(name) - 1;
const row = (id, name, pct, shares) => [id, name, 0, 'L', pct, shares, 1];

(async () => {
  assert.equal(ownership.format, 6, 'Regenerate ownership with identity/validation format 6 before this test.');
  await test('BBCA January–August cannot infer new holders from missing baseline', async s => {
    await s.route('BBCA', '2026-01', '2026-08');
    assert.match(section(s).textContent, /Perubahan belum dapat dibandingkan/);
    assert.match(section(s).textContent, /Januari 2026: snapshot KSEI >1% belum tersedia/);
    assert.equal(section(s).querySelectorAll('.own-bar-row,.own-threshold').length, 0);
    const table = s.card('Pemegang saham di atas 1%');
    assert.ok(table.querySelector('tbody tr'));
    assert.doesNotMatch(table.textContent, /baru tercatat|tidak lagi tercatat/);
    for (const tr of table.querySelectorAll('tbody tr')) {
      assert.equal(tr.cells[3].textContent, '—'); assert.equal(tr.cells[5].textContent, '—');
    }
  });
  await test('two pre-KSEI months show unavailable, never no-change', async s => {
    await s.route('BBCA', '2025-01', '2025-12');
    assert.match(section(s).textContent, /Perubahan belum dapat dibandingkan/);
    assert.doesNotMatch(section(s).textContent, /Tidak ada perubahan/);
  });
  await test('CNTX empty July snapshot is not a mass exit', async s => {
    await s.route('CNTX', '2026-06', '2026-07');
    assert.match(section(s).textContent, /Perubahan belum dapat dibandingkan/);
    assert.equal(section(s).querySelectorAll('.own-bar-row,.own-threshold').length, 0);
    assert.equal(s.card('Pemegang saham di atas 1%').querySelectorAll('tr.gone').length, 0);
  });
  await test('ABMM small share increase survives unchanged rounded percentage and canonical names', async s => {
    await s.route('ABMM', '2026-07', '2026-08');
    const r = bar(s, 'KHENG HONG');
    assert.ok(r); assert.match(r.textContent, /\+47\.500 lembar/); assert.match(r.textContent, /Porsi: tetap/);
    assert.equal([...section(s).querySelectorAll('.own-bar-row')].filter(el => el.textContent.includes('KHENG HONG')).length, 1);
    assert.doesNotMatch(section(s).querySelector('.own-threshold')?.textContent || '', /KHENG HONG/);
  });
  await test('ATIC distinguishes shares added from falling percentage and unchanged shares', async s => {
    await s.route('ATIC', '2026-06', '2026-07');
    const handoko = bar(s, 'HANDOKO ANINDYA TANUADJI'), tis = bar(s, 'TIS INC');
    assert.match(handoko.textContent, /\+20\.000\.000 lembar/); assert.match(handoko.textContent, /Porsi: −1,37 poin/);
    assert.ok(handoko.querySelector('.own-bar-track i.up'));
    assert.match(tis.textContent, /Lembar tetap/); assert.match(tis.textContent, /−7,46 poin/);
    assert.equal(tis.querySelector('.own-bar-track i'), null);
  });
  await test('both flagged endpoints block table, bars and aggregate deltas with both reasons', fixture(own => {
    const c = company(own); c.k[f].i = ['masalah awal']; c.k[t].i = ['masalah akhir'];
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    assert.match(section(s).textContent, /masalah awal/); assert.match(section(s).textContent, /masalah akhir/);
    assert.equal(section(s).querySelectorAll('.own-bar-row').length, 0);
    const sources = s.card('Sumber dan catatan').textContent;
    assert.match(sources, /masalah awal/); assert.match(sources, /masalah akhir/);
    for (const tr of s.card('Pemegang saham di atas 1%').querySelectorAll('tbody tr')) {
      assert.equal(tr.cells[3].textContent, '—'); assert.equal(tr.cells[5].textContent, '—');
    }
    await s.route('', '2026-07', '2026-08');
    const input = s.d.getElementById('own-cari'); input.value = 'BBCA'; input.dispatchEvent(new s.w.Event('input')); await delay(170);
    assert.match(s.d.querySelector('#own-body tbody tr').cells[3].textContent, /belum dapat dibandingkan/);
  }));
  await test('threshold appearance/absence stays separate from measured share changes', fixture(own => {
    const c = company(own), a = newName(own, 'Threshold A'), b = newName(own, 'Threshold B');
    c.k[f] = {tp: 2, h: [row(100, a, 2, 200)]}; c.k[t] = {tp: 3, h: [row(101, b, 3, 300)]};
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    assert.equal(section(s).querySelectorAll('.own-bar-row').length, 0);
    assert.match(section(s).querySelector('.own-threshold').textContent, /baru tercatat >1%/);
    assert.match(section(s).querySelector('.own-threshold').textContent, /tidak lagi tercatat >1%/);
    for (const tr of s.card('Pemegang saham di atas 1%').querySelectorAll('tbody tr')) assert.equal(tr.cells[5].textContent, '—');
  }));
  await test('null shares never become a zero baseline', fixture(own => {
    const c = company(own), n = newName(own, 'Missing Shares');
    c.k[f] = {tp: 2, h: [row(100, n, 2, null)]}; c.k[t] = {tp: 3, h: [row(100, n, 3, 300)]};
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    assert.match(bar(s, 'Missing Shares').textContent, /Lembar belum terbaca/);
    assert.equal(bar(s, 'Missing Shares').querySelector('.own-bar-track i'), null);
    assert.equal(s.card('Pemegang saham di atas 1%').querySelector('tbody tr').cells[5].textContent, '—');
  }));
  await test('impossible percentages, negative shares and duplicate investor IDs suppress inference', fixture(own => {
    const c = company(own), n = newName(own, 'Invalid Numeric Holder');
    c.k[f] = {tp: 150, h: [row(100, n, 120, 100)]};
    c.k[t] = {tp: 3, h: [row(100, n, 3, -1), row(100, n, 0, 0)]};
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    const text = section(s).textContent;
    assert.match(text, /akumulasi KSEI di luar/); assert.match(text, /porsi investor di luar/);
    assert.match(text, /jumlah lembar investor tidak valid/); assert.match(text, /identitas investor berulang/);
    assert.equal(section(s).querySelectorAll('.own-bar-row,.own-threshold').length, 0);
  }));
  await test('unverified report metrics retain value but no comparative delta', fixture(own => {
    const c = company(own); c.p[f] = [50, 0, 'R']; c.p[t] = [40, 1, 'R'];
    c.c[f] = [100, 0]; c.c[t] = [200, 1]; c.f[f] = [20, 0, []]; c.f[t] = [30, 1, []];
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    for (const title of ['Pemegang ≥5%', 'Free float resmi IDX', 'Jumlah pemegang saham']) {
      const tile = [...s.d.querySelectorAll('.own-tile')].find(el => el.querySelector('.own-tile-label').textContent === title);
      assert.match(tile.textContent, /perubahan belum dapat dibandingkan/);
      assert.equal(tile.querySelector('.own-tile-delta .up,.own-tile-delta .down'), null);
    }
  }));
  await test('verified five-percent values from different sources do not produce a delta or connected trend', fixture(own => {
    const c = company(own); c.p = c.p.map(() => null); c.p[f] = [50, 1, 'R']; c.p[t] = [40, 1, 'K'];
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    const tile = [...s.d.querySelectorAll('.own-tile')].find(el => el.querySelector('.own-tile-label').textContent === 'Pemegang ≥5%');
    assert.match(tile.textContent, /sumber berbeda; perubahan tidak dibandingkan/);
    assert.equal(tile.querySelector('.own-tile-delta .up,.own-tile-delta .down'), null);
    const line = s.d.querySelector('.own-line.s5:not(.est)'); assert.ok(line);
    assert.doesNotMatch(line.getAttribute('d'), /L/);
  }));
  await test('duplicate DPS identity and invalid matched rows do not manufacture deltas', fixture((own, rep) => {
    const n = rep.names.push('Ambiguous Holder') - 1, v = rep.names.push('Invalid Holder') - 1;
    const raw = rep.companies.BBCA;
    raw.d[f] = {h: [[n, 1, 100, 2, 1], [n, 1, 200, 4, 1], [v, 1, 100, 2, 0]], s: 5000};
    raw.d[t] = {h: [[n, 1, 400, 8, 1], [v, 1, 200, 4, 1]], s: 5000};
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    const c = s.card('Daftar pemegang saham (laporan emiten)');
    assert.match(c.textContent, /nama dan peran berulang/); assert.match(c.textContent, /angka perlu dicek/);
    assert.equal(c.querySelectorAll('tbody tr').length, 4, 'all raw rows remain visible without reusing an ambiguous baseline');
    for (const tr of c.querySelectorAll('tbody tr')) { assert.equal(tr.cells[4].textContent, '—'); assert.equal(tr.cells[6].textContent, '—'); }
  }));
  const filings = dates => dates.map(([date, name]) => [date, name, '', 100, 200, 1, 2, [], 1, [], null]);
  await test('filings use (Dari snapshot, Sampai snapshot], including final available month', fixture((own, rep, ch) => {
    ch.companies.BBCA = filings([['2026-07-30', 'Before'], ['2026-07-31', 'At Start'], ['2026-08-01', 'Inside'], ['2026-08-31', 'At End'], ['2026-09-01', 'After']]);
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    const c = s.card('Laporan perubahan kepemilikan'), visible = c.querySelector(':scope > .own-scroll');
    assert.match(visible.textContent, /Inside/); assert.match(visible.textContent, /At End/);
    assert.doesNotMatch(visible.textContent, /Before|At Start|After/);
    assert.match(c.querySelector('details').textContent, /Before/); assert.match(c.querySelector('details').textContent, /After/);
  }));
  await test('filings month-only selection uses full calendar month with finite end', fixture((own, rep, ch) => {
    ch.companies.BBCA = filings([['2024-12-31', 'Before'], ['2025-01-01', 'First Day'], ['2025-01-31', 'Last Day'], ['2025-02-01', 'After']]);
  }, async s => {
    await s.route('BBCA', '2025-01', '2025-01');
    const c = s.card('Laporan perubahan kepemilikan'), visible = c.querySelector(':scope > .own-scroll');
    assert.match(visible.textContent, /First Day/); assert.match(visible.textContent, /Last Day/);
    assert.doesNotMatch(visible.textContent, /Before|After/);
  }));
  console.log(`PASS: ${checks} ownership DOM regressions (${source ? 'current source' : 'generated site'}).`);
})().catch(error => { console.error(error); process.exitCode = 1; });
