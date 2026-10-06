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
// KSEI bars/threshold only; the issuer-report fallback (#own-moves-dps) is checked separately.
const kseiMoves = s => [...section(s).querySelectorAll('.own-bar-row,.own-threshold')].filter(el => !el.closest('#own-moves-dps'));
const bar = (s, name) => [...section(s).querySelectorAll('.own-bar-row')].find(el => el.textContent.includes(name));
const newName = (own, name) => own.names.push(name) - 1;
const row = (id, name, pct, shares) => [id, name, 0, 'L', pct, shares, 1];

(async () => {
  assert.equal(ownership.format, 6, 'Regenerate ownership with identity/validation format 6 before this test.');
  await test('BBCA January–August cannot infer new holders from missing baseline', async s => {
    await s.route('BBCA', '2026-01', '2026-08');
    assert.match(section(s).textContent, /KSEI >1% tidak dibandingkan/);
    assert.match(section(s).textContent, /Januari 2026: snapshot KSEI >1% belum tersedia/);
    assert.equal(kseiMoves(s).length, 0);
    const table = s.card('Pemegang saham di atas 1%');
    assert.ok(table.querySelector('tbody tr'));
    assert.doesNotMatch(table.textContent, /baru tercatat|tidak lagi tercatat/);
    for (const tr of table.querySelectorAll('tbody tr')) {
      assert.equal(tr.cells[3].textContent, '—'); assert.equal(tr.cells[5].textContent, '—');
    }
  });
  await test('two pre-KSEI months show unavailable, never no-change', async s => {
    await s.route('BBCA', '2025-01', '2025-12');
    assert.match(section(s).textContent, /KSEI >1% tidak dibandingkan/);
    assert.doesNotMatch(section(s).textContent, /Tidak ada perubahan/);
  });
  await test('CNTX empty July snapshot is not a mass exit', async s => {
    await s.route('CNTX', '2026-06', '2026-07');
    assert.match(section(s).textContent, /KSEI >1% tidak dibandingkan/);
    assert.equal(kseiMoves(s).length, 0);
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
    assert.match(s.d.querySelector('#own-body tbody tr').cells[3].textContent, /tidak dibandingkan/);
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
    assert.match(text, /lembar investor tidak valid/); assert.match(text, /identitas investor berulang/);
    assert.equal(kseiMoves(s).length, 0);
  }));
  await test('unverified report metrics retain value but no comparative delta', fixture(own => {
    const c = company(own); c.p[f] = [50, 0, 'R']; c.p[t] = [40, 1, 'R'];
    c.c[f] = [100, 0]; c.c[t] = [200, 1]; c.f[f] = [20, 0, []]; c.f[t] = [30, 1, []];
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    for (const title of ['Pemegang ≥5%', 'Free float resmi', 'Jumlah pemegang saham']) {
      const tile = [...s.d.querySelectorAll('.own-tile')].find(el => el.querySelector('.own-tile-label').textContent === title);
      assert.match(tile.textContent, /tidak dibandingkan/);
      assert.equal(tile.querySelector('.own-tile-delta .up,.own-tile-delta .down'), null);
    }
  }));
  await test('verified five-percent values from different sources do not produce a delta or connected trend', fixture(own => {
    const c = company(own); c.p = c.p.map(() => null); c.p[f] = [50, 1, 'R']; c.p[t] = [40, 1, 'K'];
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    const tile = [...s.d.querySelectorAll('.own-tile')].find(el => el.querySelector('.own-tile-label').textContent === 'Pemegang ≥5%');
    assert.match(tile.textContent, /sumber beda, tidak dibandingkan/);
    assert.equal(tile.querySelector('.own-tile-delta .up,.own-tile-delta .down'), null);
    const line = s.d.querySelector('.own-line.s5:not(.est)'); assert.ok(line);
    assert.doesNotMatch(line.getAttribute('d'), /L/);
  }));
  // Format 2 marks each report v (trusted or derivable) and each row r[5] (derivable); pad untouched rows for fixtures.
  const v2 = rep => {
    rep.format = 2;
    for (const c of Object.values(rep.companies)) for (const x of c.d || []) if (x && typeof x === 'object') {
      if (x.v === undefined) x.v = 1;
      x.h = x.h.map(r => r.length === 5 ? [...r, 1] : r);
    }
  };
  const dpsCells = s => [...s.card('Daftar pemegang saham (laporan emiten)').querySelectorAll('tbody tr')]
    .map(tr => [tr.querySelector('th').firstChild.textContent, tr.cells[4].textContent, tr.cells[6].textContent]);
  await test('format 1 reports never derive unverified changes', fixture((own, rep) => {
    rep.format = 1;
    for (const c of Object.values(rep.companies)) for (const x of c.d || []) if (x && typeof x === 'object') { delete x.v; x.h = x.h.map(r => r.slice(0, 5)); }
    const v = rep.names.push('Invalid Holder') - 1;
    rep.companies.BBCA.d[f] = {h: [[v, 1, 1000, 20, 0]], s: 5000};
    rep.companies.BBCA.d[t] = {h: [[v, 1, 1500, 30, 0]], s: 5000};
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    assert.deepEqual(dpsCells(s), [['Invalid Holder', '—', '—']]);
    assert.match(s.card('Daftar pemegang saham (laporan emiten)').textContent, /perlu dicek/);
  }));
  await test('duplicate DPS identity and unverified rows only derive deltas when shares match total', fixture((own, rep) => {
    const n = rep.names.push('Ambiguous Holder') - 1, v = rep.names.push('Invalid Holder') - 1;
    const raw = rep.companies.BBCA;
    raw.d[f] = {h: [[n, 1, 100, 2, 1, 0], [n, 1, 200, 4, 1, 0], [v, 1, 100, 2, 0, 1]], s: 5000, v: 1};
    raw.d[t] = {h: [[n, 1, 400, 8, 1, 1], [v, 1, 200, 4, 1, 1]], s: 5000, v: 1};
    v2(rep);
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    const c = s.card('Daftar pemegang saham (laporan emiten)');
    assert.match(c.textContent, /nama dan peran berulang/);
    assert.equal(c.querySelectorAll('tbody tr').length, 4, 'all raw rows remain visible without reusing an ambiguous baseline');
    for (const [name, dp, ds] of dpsCells(s)) {
      if (name === 'Invalid Holder') { assert.equal(dp, '+2 poin'); assert.equal(ds, '+100'); }
      else { assert.equal(dp, '—'); assert.equal(ds, '—'); }
    }
    assert.match(c.textContent, /belum terverifikasi; cocok dengan total saham/);
  }));
  await test('unverified DPS rows stay uncounted without source trust, row eligibility, matching totals or checkable size', fixture((own, rep) => {
    const nm = x => rep.names.push(x) - 1;
    const k = nm('Anchor Holder'), a = nm('Mismatch Holder'), b = nm('Tiny Holder'), g = nm('Masyarakat'), d = nm('Duplicate Signature');
    const raw = rep.companies.BBCA;
    raw.d[f] = {h: [[k, 1, 1000, 20, 0, 1], [a, 1, 300, 6, 0, 1], [b, 8, 2, 0.04, 0, 1], [g, 1, 1500, 30, 0, 2], [d, 1, 500, 10, 0, 0]], s: 5000, v: 1};
    raw.d[t] = {h: [[k, 1, 1000, 20, 0, 1], [a, 1, 900, 6, 0, 1], [b, 8, 4, 0.08, 0, 1], [g, 1, 1000, 20, 0, 2], [d, 1, 750, 15, 0, 0]], s: 5000, v: 1};
    v2(rep);
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    // Mismatch Holder breaks reportFits for both reports, so even Anchor Holder stays uncounted.
    for (const [, dp, ds] of dpsCells(s)) { assert.equal(dp, '—'); assert.equal(ds, '—'); }
  }));
  await test('untrusted report or changed total shares blocks derived changes', fixture((own, rep) => {
    const k = rep.names.push('Anchor Holder') - 1, raw = rep.companies.BBCA, j = own.months.findIndex(x => x.p === '2026-06');
    raw.d = raw.d.map(() => null);
    raw.d[j] = {h: [[k, 1, 1000, 20, 0, 1]], s: null, v: 0};
    raw.d[f] = {h: [[k, 1, 1000, 20, 0, 1]], s: null, v: 1};
    raw.d[t] = {h: [[k, 1, 5000, 20, 0, 1]], s: 25000, v: 1};
    v2(rep);
  }, async s => {
    await s.route('BBCA', '2026-06', '2026-07');
    assert.deepEqual(dpsCells(s), [['Anchor Holder', '—', '—']], 'v=0 report');
    await s.route('BBCA', '2026-07', '2026-08');
    assert.deepEqual(dpsCells(s), [['Anchor Holder', '—', '—']], 'Jul borrows Aug total 25000: 1000 shares no longer fit 20%');
  }));
  // Each guard alone decides: a base pair where every gate passes, then one gate broken per case.
  const gate = (name, mutate, expectDerived) => test('derive gate: ' + name, fixture((own, rep) => {
    const nm = x => rep.names.push(x) - 1, k = nm('Anchor Holder'), z = nm('Probe Holder'), raw = rep.companies.BBCA;
    raw.d = raw.d.map(() => null);
    const a = {h: [[k, 1, 1000, 20, 0, 1], [z, 1, 500, 10, 0, 1]], s: 5000, v: 1};
    const b = {h: [[k, 1, 1000, 20, 0, 1], [z, 1, 750, 15, 0, 1]], s: 5000, v: 1};
    mutate(a, b, nm, raw);
    raw.d[f] = a; raw.d[t] = b;
    v2(rep);
  }, async s => {
    await s.route('BBCA', '2026-07', '2026-08');
    const probe = dpsCells(s).find(r => r[0] === 'Probe Holder');
    assert.deepEqual(probe.slice(1), expectDerived ? ['+5 poin', '+250'] : ['—', '—']);
  }));
  await gate('all gates pass', () => {}, true);
  await gate('Dari report not derivable (v=0)', a => { a.v = 0; }, false);
  await gate('row flagged non-derivable', (a, b) => { b.h[1][5] = 0; }, false);
  await gate('aggregate row code 2', (a, b) => { a.h[1][5] = 2; b.h[1][5] = 2; }, false);
  await gate('row without role bits', (a, b) => { a.h[1][1] = 0; b.h[1][1] = 0; }, false);
  await gate('different explicit totals, each self-consistent', (a, b) => {
    a.s = 2500; a.h[0][2] = 500; a.h[1][2] = 250;
  }, false);
  await gate('within 0.01 but outside half a unit', (a, b) => { a.h[1][2] = 504; a.h[1][3] = 10.09; }, false);
  await gate('exactly half a unit is rejected', (a, b) => { a.s = b.s = 8000; a.h[0][2] = b.h[0][2] = 1600; a.h[1][2] = 750; a.h[1][3] = 9.37; b.h[1][2] = 1200; }, false);
  await gate('row under 0.1% cannot be checked', (a, b) => { a.s = b.s = 5000000; a.h[0][2] = b.h[0][2] = 1000000; a.h[1] = [a.h[1][0], 1, 2000, 0.04, 0, 1]; b.h[1] = [b.h[1][0], 1, 3000, 0.06, 0, 1]; }, false);
  await test('derive gate: total change inside the span shows a split warning in the fallback', fixture((own, rep) => {
    const k = rep.names.push('Anchor Holder') - 1, raw = rep.companies.BBCA, j = own.months.findIndex(x => x.p === '2025-06'), m = own.months.findIndex(x => x.p === '2026-01');
    raw.d = raw.d.map(() => null);
    raw.d[j] = {h: [[k, 1, 1000, 20, 0, 1]], s: null, v: 1};
    raw.d[m] = {h: [[k, 1, 1000, 20, 0, 1]], s: 5000, v: 1};
    raw.d[t] = {h: [[k, 1, 5000, 20, 0, 1]], s: 25000, v: 1};
    v2(rep);
  }, async s => {
    await s.route('BBCA', '2025-06', '2026-08');
    const fb = section(s).querySelector('#own-moves-dps');
    assert.equal(fb.querySelectorAll('.own-bar-row').length, 0);
    assert.match(fb.textContent, /Total saham berubah di rentang ini \(5\.000 → 25\.000\)/);
  }));
  await test('fallback lists: duplicate names are not new holders; untrusted pairs show no membership lists', fixture((own, rep) => {
    const nm = x => rep.names.push(x) - 1, k = nm('Anchor Holder'), d = nm('Twice Holder'), raw = rep.companies.BBCA;
    const j = own.months.findIndex(x => x.p === '2025-06'), m = own.months.findIndex(x => x.p === '2025-01');
    raw.d = raw.d.map(() => null);
    raw.d[m] = {h: [[k, 1, 1000, 20, 0, 1], [d, 1, 300, 6, 0, 0], [d, 8, 300, 6, 0, 0]], s: 5000, v: 0};
    raw.d[j] = {h: [[k, 1, 1000, 20, 0, 1], [d, 1, 300, 6, 0, 0], [d, 8, 300, 6, 0, 0]], s: 5000, v: 1};
    raw.d[t] = {h: [[k, 1, 1000, 20, 0, 1], [d, 16, 300, 6, 0, 1]], s: 5000, v: 1};
    v2(rep);
  }, async s => {
    await s.route('BBCA', '2025-06', '2026-08');
    let fb = section(s).querySelector('#own-moves-dps');
    assert.doesNotMatch(fb.textContent, /Baru tercantum|Tidak tercantum lagi/);
    assert.match(fb.textContent, /Belum dihitung[^:]*: Twice Holder/);
    await s.route('BBCA', '2025-01', '2026-08');
    fb = section(s).querySelector('#own-moves-dps');
    assert.match(fb.textContent, /Daftar nama antarlaporan tidak dibandingkan/);
    assert.equal(fb.querySelectorAll('.own-bar-row').length, 0);
  }));
  await test('chart range: drag, two clicks, keyboard with Escape, and quick presets', async s => {
    const {w, d} = s;
    await s.route('BBCA', '2026-03', '2026-07');
    const idx = p => s.own.months.findIndex(m => m.p === p);
    const hit = i => d.querySelector('.own-hit[data-i="' + i + '"]');
    const mid = i => +hit(i).getAttribute('x') + +hit(i).getAttribute('width') / 2;
    const fire = (el, type, x) => el.dispatchEvent(new w.MouseEvent(type, {bubbles: true, button: 0, clientX: x}));
    const settle = async () => { for (let k = 0; k < 40 && d.querySelector('#own-body .own-card') == null; k++) await delay(5); await delay(30); };
    // Drag Apr → Jun.
    fire(hit(idx('2026-04')), 'pointerdown', mid(idx('2026-04')));
    fire(d.querySelector('#own-trend svg'), 'pointermove', mid(idx('2026-06')));
    assert.ok(d.querySelector('.own-pick.on'), 'live preview while dragging');
    fire(d.querySelector('#own-trend svg'), 'pointerup', mid(idx('2026-06')));
    await settle();
    assert.equal(w.location.hash, '#kepemilikan=BBCA&dari=2026-04&sampai=2026-06');
    // Two clicks in reverse order: end first, then start.
    fire(hit(idx('2026-07')), 'pointerdown', mid(idx('2026-07'))); fire(d.querySelector('#own-trend svg'), 'pointerup', mid(idx('2026-07')));
    assert.match(d.querySelector('.own-pick-msg').textContent, /pilih bulan akhir/);
    assert.equal(w.location.hash, '#kepemilikan=BBCA&dari=2026-04&sampai=2026-06', 'first click only sets the anchor');
    fire(hit(idx('2026-05')), 'pointerdown', mid(idx('2026-05'))); fire(d.querySelector('#own-trend svg'), 'pointerup', mid(idx('2026-05')));
    await settle();
    assert.equal(w.location.hash, '#kepemilikan=BBCA&dari=2026-05&sampai=2026-07');
    // Keyboard: Enter sets anchor, Escape cancels, Enter twice applies.
    const key = (i, k) => hit(i).dispatchEvent(new w.KeyboardEvent('keydown', {key: k, bubbles: true}));
    key(idx('2026-06'), 'Enter'); key(idx('2026-06'), 'Escape');
    assert.equal(d.querySelector('.own-pick-msg').textContent, '');
    key(idx('2026-06'), 'Enter'); key(idx('2026-07'), 'Enter');
    await settle();
    assert.equal(w.location.hash, '#kepemilikan=BBCA&dari=2026-06&sampai=2026-07');
    const presets = [...d.querySelectorAll('#own-presets a')];
    assert.deepEqual(presets.map(a => a.textContent).slice(0, 2), ['1 bln', '3 bln']);
    assert.equal(presets.find(a => a.textContent === '1 bln').getAttribute('aria-current'), 'true');
    assert.equal(presets.find(a => a.textContent === '3 bln').getAttribute('href'), '#kepemilikan=BBCA&dari=2026-04&sampai=2026-07');
  });
  await test('pre-KSEI Dari falls back to issuer-report changes and links the first KSEI snapshot', fixture((own, rep) => {
    const nm = x => rep.names.push(x) - 1;
    const k = nm('Seller Holder'), m = nm('Buyer Holder'), z = nm('Same Holder'), p1 = nm('PT Alpha Beta'), p2 = nm('Beta Alpha Tbk'), q = nm('Masyarakat');
    const i23 = own.months.findIndex(x => x.p === '2025-06'), raw = rep.companies.BBCA;
    raw.d = raw.d.map(() => null);
    raw.d[i23] = {h: [[k, 1, 1500, 30, 0, 1], [m, 3, 500, 10, 0, 1], [z, 1, 400, 8, 0, 1], [p1, 1, 300, 6, 0, 1], [q, 1, 900, 18, 0, 2]], s: null, v: 1};
    raw.d[t] = {h: [[k, 1, 1000, 20, 1, 1], [m, 3, 1000, 20, 1, 1], [z, 1, 400, 8, 1, 1], [p2, 1, 300, 6, 1, 1], [q, 1, 900, 18, 0, 2]], s: 5000, v: 1};
    v2(rep);
  }, async s => {
    await s.route('BBCA', '2025-06', '2026-08');
    assert.equal(kseiMoves(s).length, 0);
    const fb = section(s).querySelector('#own-moves-dps');
    assert.match(fb.textContent, /Juni 2025 → Agustus 2026/);
    const rows = [...fb.querySelectorAll('.own-bar-row')].map(el => el.textContent);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /Buyer Holder\+500 lembar/); assert.match(rows[1], /Seller Holder−500 lembar/);
    assert.equal(fb.querySelectorAll('i.approx').length, 0, 'unverified bars are not styled differently');
    assert.equal([...fb.querySelectorAll('.own-bar-val')].filter(el => /belum terverifikasi/.test(el.textContent)).length, 2);
    assert.match(fb.textContent, /Tetap \(belum terverifikasi[^)]*\): Same Holder/);
    assert.match(fb.textContent, /Ejaan nama berbeda[^:]*: Beta Alpha Tbk \/ PT Alpha Beta/);
    assert.doesNotMatch(fb.textContent, /Baru tercantum|Tidak tercantum lagi|Masyarakat/);
    // Feb 2026 is the default Dari, so ownHref leaves dari out.
    const link = [...section(s).querySelectorAll('a')].find(el => /Bandingkan KSEI 27 Februari 2026/.test(el.textContent));
    assert.ok(link, 'links the first valid KSEI snapshot inside the range');
    assert.equal(link.getAttribute('href'), '#kepemilikan=BBCA');
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
