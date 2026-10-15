// The archive viewer (a built index.html) in jsdom, for the DOM tests: no CSS, marked/DOMPurify when NODE_PATH has
// them, the browser APIs jsdom lacks stubbed, jsdom script errors collected in `errors`. The app script runs on
// start(), so a test can set w.fetch or change the page first. Never uses the network.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {JSDOM, VirtualConsole} = require('jsdom');
const optional = name => { try { return require(name); } catch { return null; } };
const markedLib = optional('marked'), purify = optional('dompurify');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const pageHtml = file => fs.readFileSync(file, 'utf8').replace(/<style>[\s\S]*?<\/style>/g, '');

// With `site`, fetch answers from that built folder: version.json is this build, a path where fail(path) is true gets
// HTTP 500, anything outside the folder throws. Every fetched path is recorded in `fetched`.
function viewer(html, {site, fail = () => false} = {}) {
  const errors = [], vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {url: 'https://archive.test/', runScripts: 'outside-only', virtualConsole: vc});
  const w = dom.window, d = w.document, fetched = [];
  const data = JSON.parse(d.getElementById('arsip-data').textContent);
  if (markedLib && purify) { w.marked = markedLib.marked; w.DOMPurify = purify(w); }
  w.TextDecoder = TextDecoder;
  w.matchMedia = () => ({matches: false, addEventListener() {}});
  w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
  if (site) w.fetch = async url => {
    const p = decodeURIComponent(String(url).split('?')[0]);
    fetched.push(p);
    if (p === 'version.json') return Response.json({version: data.version});
    if (fail(p)) return new Response('nope', {status: 500});
    const file = path.join(site, p);
    if (!file.startsWith(site + path.sep) || !fs.existsSync(file)) throw new Error('Network forbidden in DOM test: ' + url);
    return new Response(fs.readFileSync(file));
  };
  const start = () => w.eval([...d.querySelectorAll('script')].at(-1).textContent);
  // Opens a hash route and waits up to a second for ready(); the app must not have thrown.
  async function go(hash, ready = () => true) {
    w.history.replaceState(null, '', hash); w.dispatchEvent(new w.HashChangeEvent('hashchange'));
    for (let i = 0; i < 200; i++) { await delay(5); if (ready()) break; }
    assert.deepEqual(errors, []);
  }
  return {dom, w, d, data, errors, fetched, start, go};
}

// Hostile strings from an index or document reached the page only as text: no element, handler or other link scheme.
function assertSafe(w, root) {
  assert.equal(root.querySelectorAll('img,script,iframe,svg').length, 0, 'no injected elements');
  for (const el of root.querySelectorAll('*'))
    for (const a of el.attributes) assert.ok(!/^on/i.test(a.name), 'no event handler attribute ' + a.name);
  for (const a of root.querySelectorAll('a[href]')) assert.match(a.getAttribute('href'), /^(#|https:\/\/|files\/)/);
  assert.equal(w.pwned, undefined);
}

module.exports = {viewer, pageHtml, delay, assertSafe, withMarkdown: !!(markedLib && purify)};
