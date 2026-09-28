import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {Archive, CacheStore, validate} from '../worker/core.mjs';
import {AGENT, agentic, citations, compact, datacatRequest, fetchDatacat, prune, Refs, TOOLS} from '../worker/agent.mjs';

// No network: every datacat and model call below is simulated.
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Network forbidden in agent tests'); };
test.after(() => { globalThis.fetch = realFetch; });

const assets = {fetch:async r => new Response(await readFile(new URL('../worker/.assets' + new URL(r.url).pathname, import.meta.url)))};
function sqlite() {
  const db = new DatabaseSync(':memory:');
  return {db, sql:{exec(q, ...a) { const s = db.prepare(q), rows = s.columns().length ? s.all(...a) : (s.run(...a), []); return {toArray:() => rows, one:() => rows[0]}; }}};
}
const issuer = {account:{id:194, name:'SOCI', ticker:'SOCI', url:'https://quant.renr.ai/api/v1/issuers/SOCI/', html_url:'https://quant.renr.ai/issuer/SOCI/', name_normalized:'SOCI'},
  holdings_registry:[{holder:{id:3230, name:'PT Pilar Sukses Utama', html_url:'https://quant.renr.ai/account/3230/'}, pct:'35.10', date:'2026-08-31'}],
  linked_documents:Array.from({length:40}, (_, i) => ({id:i, doc_type:'RUPS_MINUTES', filename:'x'.repeat(900), extracted_at:'2026', html_url:'https://quant.renr.ai/document/' + i + '/'}))};

test('mode is the only new request field and accepts only "agentic"', () => {
  assert.equal(validate({question:'SOCI', mode:'agentic'}).mode, 'agentic');
  assert.equal(validate({question:'SOCI'}).mode, 'archive');
  assert.throws(() => validate({question:'SOCI', mode:'admin'}));
  assert.throws(() => validate({question:'SOCI', mode:'agentic', tools:[]}));
});

test('tool arguments are validated; paths are fixed and ids cannot escape them', () => {
  assert.deepEqual(datacatRequest('datacat_detail', {jenis:'emiten', id:'soci'}), {path:'/api/v1/issuers/SOCI/', params:{}});
  const list = datacatRequest('datacat_daftar', {jenis:'perubahan_kepemilikan', ticker:'BBCA', dari:'2024-01-01', sampai:'2024-12-31', limit:99});
  assert.equal(list.path, '/api/v1/movements/');
  assert.deepEqual(list.params, {limit:'25', sort:'-date', ticker:'BBCA', from:'2024-01-01', to:'2024-12-31'});
  for (const bad of [{jenis:'emiten', id:'SOCI/../../me'}, {jenis:'pihak', id:'1 OR 1'}, {jenis:'rups', id:'../analyses'},
    {jenis:'pengumuman', id:'x/../../api/v1/analyses'}, {jenis:'analyses_delete', id:'1'}])
    assert.throws(() => datacatRequest('datacat_detail', bad), bad.id);
  assert.throws(() => datacatRequest('datacat_daftar', {jenis:'perubahan_kepemilikan', ticker:'BBCA.JK'}));
  assert.throws(() => datacatRequest('datacat_daftar', {jenis:'rups', dari:'kemarin'}));
  assert.throws(() => datacatRequest('http_get', {url:'https://evil.example'}));
  // Write endpoints of the API are not reachable through any tool.
  assert.ok(!JSON.stringify(TOOLS).includes('bundle'));
});

test('datacat responses are pruned, capped, and links become citation ids', () => {
  const refs = new Refs(), text = compact(issuer, refs);
  assert.ok(text.length <= 6000, text.length);
  assert.ok(!text.includes('https://'), 'links never reach the model');
  assert.ok(text.includes('ref:K1') && text.includes('lagi'), text.slice(0, 300));
  assert.equal(refs.list()[0].url, 'https://quant.renr.ai/issuer/SOCI/');
  // Empty lists stay ("no holdings on record"); nulls, empty strings and API links are dropped.
  assert.deepEqual(prune({a:null, b:'', c:[], d:{url:'x'}}), {c:[]});
});

test('unsupported filters are refused instead of returning unrelated rows; ids are typed by kind', () => {
  assert.throws(() => datacatRequest('datacat_daftar', {jenis:'pemegang_saham', q:'zeinihzafahrozi'}), /q tidak didukung/);
  assert.throws(() => datacatRequest('datacat_daftar', {jenis:'transaksi'}), /memerlukan ticker/);
  assert.equal(datacatRequest('datacat_daftar', {jenis:'pengumuman', q:'rights issue'}).params.q, 'rights issue');
  const text = compact({results:[{id:5, board_role:'DIREKTUR', person:{id:12117, name:'A', html_url:'https://quant.renr.ai/account/12117/'},
    document:{id:167162, html_url:'https://quant.renr.ai/document/167162/'}}]}, new Refs());
  assert.ok(text.includes('id_baris:5') && text.includes('id_pihak:12117') && text.includes('id_dokumen:167162'), text);
});

test('grouped and ranged citations are read as separate ids', () => {
  assert.deepEqual(citations('a [K1, K2] b [D3] c [K4-K6] d [datacat_daftar]'), ['K1', 'K2', 'D3', 'K4', 'K5', 'K6']);
});

test('datacat calls use the fixed host, the server key, no redirects, and the shared cache', async () => {
  const {db, sql} = sqlite(), cache = new CacheStore(sql), seen = [];
  const fetcher = async (url, init) => { seen.push({url, init}); return Response.json(issuer); };
  const first = await fetchDatacat({key:'KEY', cache, fetcher}, datacatRequest('datacat_detail', {jenis:'emiten', id:'SOCI'}));
  const second = await fetchDatacat({key:'KEY', cache, fetcher}, datacatRequest('datacat_detail', {jenis:'emiten', id:'SOCI'}));
  assert.equal(seen.length, 1); assert.equal(first.cached, false); assert.equal(second.cached, true);
  assert.equal(new URL(seen[0].url).origin, 'https://quant.renr.ai');
  assert.equal(seen[0].init.headers.Authorization, 'Api-Key KEY'); assert.equal(seen[0].init.redirect, 'manual');
  await assert.rejects(fetchDatacat({key:'KEY', fetcher:async () => new Response(null, {status:302, headers:{Location:'https://evil.example/'}})},
    datacatRequest('datacat_cari', {q:'redirect'})), /mengalihkan/);
  db.close();
});

test('agent loop: tools run, evidence is cited, sources map to archive and datacat, quota only on a cache miss', async () => {
  const {db, sql} = sqlite(), cache = new CacheStore(sql), events = [];
  let quota = 0, steps = 0, answerInput;
  const fetcher = async () => Response.json(issuer);
  const model = {
    step:async (messages, tools) => {
      assert.equal(tools, TOOLS);
      steps++;
      if (steps === 1) return {message:{content:'', tool_calls:[
        {id:'a', type:'function', function:{name:'cari_arsip', arguments:'{"kata":["SOCI"]}'}},
        {id:'b', type:'function', function:{name:'datacat_detail', arguments:'{"jenis":"emiten","id":"SOCI"}'}},
        {id:'c', type:'function', function:{name:'datacat_detail', arguments:'{"jenis":"emiten","id":"../x"}'}}]}};
      return {message:{content:'SIAP'}};
    },
    answer:async (messages, emit) => { answerInput = messages; const text = 'Pemegang terbesar PT Pilar Sukses Utama 35,10% [K2]; diskusi [D0] dan [K99].'; await emit({type:'delta', text}); return text; }};
  const archive = new Archive(assets);
  const options = {archive, model, question:'siapa pemegang saham SOCI?', emit:async e => events.push(e), cache,
    env:{DATACAT_API_KEY:'KEY'}, reserveQuota:() => { quota++; }, fetcher, stats:{}};
  const result = await agentic(options);
  assert.equal(quota, 1); assert.equal(steps, 2);
  assert.ok(options.stats.agent_calls.some(c => c.tool === 'cari_arsip'));
  // The answer reuses the transcript (cached prefix): a rejected call stays an uncitable error, and the
  // instruction arrives as the last tool result.
  const toolMessages = answerInput.filter(m => m.role === 'tool');
  assert.ok(toolMessages.some(m => typeof m.content === 'string' && m.content.startsWith('KESALAHAN')));
  assert.ok(toolMessages.filter(m => !String(m.content).startsWith('KESALAHAN')).slice(0, -1).every(m => /^rujukan:/.test(m.content)));
  assert.match(JSON.stringify(answerInput.at(-1)), /tulis jawaban sekarang/);
  assert.ok(result.sources.some(s => s.source_id === 'K2' && s.url === 'https://quant.renr.ai/account/3230/'));
  assert.ok(!result.sources.some(s => s.source_id === 'K99'), 'uncited or unknown ids are not sources');
  const again = await agentic({...options, stats:{}});
  assert.equal(again.cache_hit, true); assert.equal(quota, 1, 'a cached answer does not use the daily quota');
  db.close();
});

test('the agent stops at the round and call limits', async () => {
  let steps = 0;
  const model = {step:async () => { steps++; return {message:{tool_calls:Array.from({length:5}, (_, i) =>
      ({id:String(steps * 10 + i), type:'function', function:{name:'datacat_cari', arguments:JSON.stringify({q:'nama ' + steps + i})}}))}}; },
    answer:async (m, emit) => { await emit({type:'delta', text:'ok'}); return 'ok'; }};
  const stats = {};
  await agentic({archive:new Archive(assets), model, question:'x', emit:async () => {}, env:{DATACAT_API_KEY:'KEY'},
    fetcher:async () => Response.json({sections:[]}), stats});
  assert.ok(steps <= AGENT.rounds); assert.ok(stats.agent_tool_calls <= AGENT.calls, stats.agent_tool_calls);
});

test('a provider rate limit is retried; an unrecoverable step still answers from gathered evidence', async () => {
  const {OpenRouter, ChatError} = await import('../worker/core.mjs');
  let sent = 0;
  const fetcher = async () => ++sent < 3
    ? new Response('busy', {status:429, headers:{'Retry-After':'0.01'}})
    : Response.json({choices:[{finish_reason:'stop', message:{content:'SIAP'}}]});
  const model = new OpenRouter('KEY', null, fetcher);
  assert.equal((await model.step([{role:'user', content:'x'}], TOOLS, 50)).message.content, 'SIAP');
  assert.equal(sent, 3); assert.equal(model.usage().calls, 1, 'retries share one reservation');

  let steps = 0;
  const flaky = {step:async () => {
      if (++steps === 1) return {message:{tool_calls:[{id:'a', type:'function', function:{name:'datacat_cari', arguments:'{"q":"Soechi"}'}}]}};
      throw new ChatError('Layanan AI sedang membatasi permintaan. Coba beberapa saat lagi.');
    },
    answer:async (m, emit) => { await emit({type:'delta', text:'ok'}); return 'ok'; }};
  const stats = {};
  const result = await agentic({archive:new Archive(assets), model:flaky, question:'Soechi', emit:async () => {}, env:{DATACAT_API_KEY:'KEY'},
    fetcher:async () => Response.json({sections:[]}), stats});
  assert.equal(result.answer, 'ok'); assert.match(stats.step_failed, /membatasi/);
});

test('relationship tools: ownership name search across issuers, user terms first, person trail from filings', async () => {
  const {ownershipTool, userTerms} = await import('../worker/agent.mjs');
  const manifest = JSON.parse(await readFile(new URL('../worker/.assets/manifest.json', import.meta.url), 'utf8'));
  const data = JSON.parse(await readFile(new URL('../worker/.assets/ownership.json', import.meta.url), 'utf8'));
  const refs = new Refs(), found = ownershipTool(data, {nama:'Tancorp'}, refs);
  for (const code of ['MERI', 'BLES', 'RISE', 'CLEO']) assert.ok(found.includes('ticker:' + code), code);
  assert.ok(refs.list().every(r => /^O\d+$/.test(r.source_id) && /^#kepemilikan=[A-Z0-9]+$/.test(r.url)));
  assert.ok(ownershipTool(data, {ticker:'MERI'}, refs).includes('19.32'));
  assert.deepEqual(userTerms('apakah yoel bagian tancorp?', manifest).map(t => t.toLowerCase()), ['yoel', 'tancorp']);

  const person = {account:{id:4813, name:'Yoel Alex Santoso', html_url:'https://quant.renr.ai/account/4813/'}, seats:[],
    mentions:[{document_id:43583, page_no:4, role_raw:''}, {document_id:4927, page_no:3, role_raw:'Komisaris'}]};
  const docs = {43583:{announcement:{emiten_key:'HELI', tgl_date:'2026-06-19', judul:'Penyampaian Materi Public Expose - Tahunan'}},
    4927:{announcement:{emiten_key:'MERI', tgl_date:'2026-09-10', judul:'Laporan Bulanan Registrasi Pemegang Efek'}}};
  const fetcher = async url => Response.json(url.includes('/accounts/') ? person : docs[url.match(/documents\/(\d+)/)[1]]);
  let seen;
  const model = {step:async m => { if (!seen) { seen = true; return {message:{tool_calls:[{id:'p', type:'function', function:{name:'datacat_detail', arguments:'{"jenis":"pihak","id":"4813"}'}}]}}; }
      return {message:{content:'SIAP'}}; },
    answer:async (m, emit) => { const text = JSON.stringify(m.filter(x => x.role === 'tool').map(x => x.content)); await emit({type:'delta', text:'ok'}); return 'Yoel tidak terkait [K1].' + text; }};
  const stats = {};
  const result = await agentic({archive:new Archive(assets), model, question:'apakah yoel bagian tancorp?', emit:async () => {}, env:{DATACAT_API_KEY:'KEY'}, fetcher, stats});
  assert.ok(stats.agent_calls[0].auto && stats.agent_calls[0].tool === 'cari_arsip', 'archive searched by code first');
  assert.match(result.answer, /emiten:HELI[^}]*bio:1/, 'biography page flagged in the trail');
  assert.match(result.answer, /emiten:MERI[^}]*peran:Komisaris/);
  assert.ok(stats.absence_claim, 'absence stated as disproof gets a note');
});

test('a biography is cut at section headers, so a neighbour in the same PDF column is not attributed', async () => {
  const {biography} = await import('../worker/agent.mjs');
  const page = 'Pengalaman Kerja: Jan 2022 – Des 2023 Direktur PT Jaya Trishindo Tbk Des 2015 – Okt 2019 Direktur MNC Asuransi Indonesia '
    + 'Andre Franklin Sahelangi Jan 2008 – Des 2011 Head of Finance- Accounting Allianz Utama Indonesia 10 Daftar Riwayat Hidup '
    + 'Tempat / Tanggal Lahir: Surabaya, 25 Juli 1988 Pengalaman Kerja: 2026 – sekarang Direktur PT Alta Internasional Indonesia '
    + '2025 – sekarang Komisaris PT Merry Riana Edukasi Tbk 2023 – sekarang General Manager Finance Accounting Tax Yoel Alex Santoso '
    + 'PT Tancorp Abadi Nusantara 2016 – 2019 Finance Accounting Tax Manager PT Tancorp Abadi Nusantara 11 LAYANAN JASA PERSEROAN';
  const yoel = biography(page, 'Yoel Alex Santoso');
  assert.match(yoel, /Tancorp Abadi Nusantara/); assert.match(yoel, /Alta Internasional/);
  assert.doesNotMatch(yoel, /MNC|Allianz/);
  assert.doesNotMatch(biography(page, 'Andre Franklin Sahelangi'), /Tancorp/);
});

// ---- v5: correctness layer and precomputed KSEI signals ----
test('fact cards word form fields as the filer\'s statements, with units and the filing lag', async () => {
  const {GLOSSARY, movementCard, worded, rupiah} = await import('../worker/facts.mjs');
  assert.match(GLOSSARY.retains_control(false), /tetap mempertahankan pengendalian: TIDAK \(isian pelapor/);
  assert.equal(rupiah(1650000 * 350), '±Rp577,5 juta');
  const movement = {report_number:'LK/1', report_date:'2026-09-17', filer_type:'KSEI', reporter:{name:'PT Graha Inti Guna Persada', kind:'INDIVIDUAL'},
    reporter_is_board_member:true, reporter_position:'Direksi', shares_before:'443543000.00', pct_before:'68.2300', shares_after:'441893000.00',
    pct_after:'67.9800', is_controller:true, retains_control:false,
    lines:[{transaction_type:'SELL', transaction_type_raw:'Penjualan', shares:'1650000.00', price:'350.0000', transaction_date:'2026-09-16'}]};
  const card = movementCard(movement).kartu;
  assert.match(card.transaksi[0], /Penjualan 1\.650\.000 saham @ Rp350 per saham \(nilai ±Rp577,5 juta\)/);
  assert.match(card.dilaporkan, /1 hari setelah transaksi/);
  assert.match(card.isian_formulir, /bukan bukti jabatan di emiten/);
  assert.equal(card.lawan_transaksi, 'tidak dicantumkan dalam formulir');
  const found = [], out = worded({results:[movement]}, found);
  assert.equal(out.results[0].reporter.kind, 'COMPANY', 'a PT is never an individual');
  assert.equal(found[0].reporter, 'PT Graha Inti Guna Persada');
  assert.ok(!('retains_control' in out.results[0]), 'raw flags replaced by the card');
});

test('minutes: resolutions and attendance are typed; checks after the answer', async () => {
  const {typedMinutes, answerChecks, ExternalBudget} = await import('../worker/facts.mjs');
  const text = typedMinutes('Rapat dihadiri oleh Paulinus dan Yoel. Rapat memutuskan mengangkat Budi sebagai Direktur.', 'RUPS_MINUTES');
  assert.match(text, /\[KEHADIRAN\] Rapat dihadiri/); assert.match(text, /\[KEPUTUSAN\] Rapat memutuskan/);
  assert.equal(typedMinutes('Laporan biasa.', 'OTHER'), 'Laporan biasa.');
  const notes = answerChecks('Pengendali tetap mempertahankan pengendalian. PT Alta Internasional Indonesia (individu) membeli 16%.',
    {retains:[{reporter:'PT Graha', date:'2026-09-17', report:'LK/1'}]});
  assert.equal(notes.length, 2);
  assert.equal(answerChecks('Formulir berisi "tetap mempertahankan pengendalian: TIDAK" [K1].', {retains:[{reporter:'A', date:'x'}]}).length, 0,
    'an answer that reports the TIDAK is not flagged');
  assert.equal(answerChecks('PT Wahana Konstruksi Mandiri adalah pihak (individu) pengendali ASLI.').length, 1);
  const {isCompany} = await import('../worker/facts.mjs');
  assert.ok(isCompany('WAHANA KONSTRUKSI MANDIRI') && isCompany('SENTOSA BERSAMA MITRA') && !isCompany('Yoel Alex Santoso') && !isCompany('Hans Saputra'));
  const budget = new ExternalBudget(44, 8);
  let tools = 0; while (budget.take()) tools++;
  assert.equal(tools, 36, 'tools stop while 8 remain for the model');
});

test('names: verbs, months and glued words are dropped; known names are kept whole', async () => {
  const {entityTerms} = await import('../worker/agent.mjs');
  const {loadSignals} = await import('../worker/signals.mjs');
  const manifest = JSON.parse(await readFile(new URL('../worker/.assets/manifest.json', import.meta.url), 'utf8'));
  const sig = await loadSignals(new Archive(assets), manifest);
  const t = q => entityTerms(q, manifest, sig.known);
  assert.ok(t('EPAC diambil alih PT Triple Berkah Bersama. Siapa pemilik sebenarnya, di harga berapa ia membeli?').phrases.includes('Triple Berkah Bersama'));
  const mglv = t('MGLV: pengendali PT Nextier Datamate Center menjual banyak saham sejak Juli 2026. Siapa pembelinya?');
  assert.deepEqual(mglv.tickers, ['MGLV']);
  assert.ok(!mglv.phrases.some(p => /menjual|sejak|juli|pembelinya/i.test(p)), JSON.stringify(mglv.phrases));
});

test('signals: pack with must-cover items, O links with the months, coverage appendix, screening route', async () => {
  const {loadSignals, signalView, coverage, mustCover} = await import('../worker/signals.mjs');
  const {terse} = await import('../worker/agent.mjs');
  const manifest = JSON.parse(await readFile(new URL('../worker/.assets/manifest.json', import.meta.url), 'utf8'));
  const sig = await loadSignals(new Archive(assets), manifest), refs = new Refs();
  const pack = signalView(sig, {ticker:'LUCY', bagian:'sinyal'}, refs, terse);
  assert.match(pack, /wajib:1/); assert.match(pack, /378\.693\.473/);
  assert.ok(refs.list().some(r => r.url === '#kepemilikan=LUCY&dari=2026-05&sampai=2026-06'), refs.list().map(r => r.url).join());
  const items = mustCover(sig.signals.issuers.LUCY).map(s => ({t:'LUCY', s}));
  assert.match(coverage('LUCY tidak punya catatan penting.', items, refs, () => 'LUCY'), /belum dibahas/);
  assert.equal(coverage('Delta Wibawa melepas 378.693.473 saham ke SENTOSA BERSAMA MITRA dan PIJAR.', items.slice(0, 1), refs, () => 'LUCY'), '');
  const asli = mustCover(sig.signals.issuers.ASLI).filter(s => s.k === 'transfer').map(s => ({t:'ASLI', s}));
  assert.ok(asli.length, 'ASLI transfer is a must-cover item');
  assert.match(coverage('Tidak ada catatan.', asli, refs, () => 'ASLI'), /732\.500\.000/);
  assert.equal(coverage('Wahana melepas 732.500.000 saham ke Cakrawala Multi Mineral.', asli, refs, () => 'ASLI'), '');
  const calls = [];
  const model = {step:async m => { calls.push(m); return {message:{content:'SIAP'}}; },
    answer:async (m, emit) => { await emit({type:'delta', text:'ok'}); return 'ok'; }};
  const stats = {};
  await agentic({archive:new Archive(assets), model, question:'cari hidden gems dari pola kepemilikan', emit:async () => {}, env:{DATACAT_API_KEY:'KEY'},
    fetcher:async () => Response.json({sections:[]}), stats});
  assert.ok(stats.agent_calls.some(c => c.tool === 'data_kepemilikan' && c.args.bagian === 'peringkat' && c.auto));
  assert.match(AGENT.version, /^agent-v5/);
});

test('full-text search: exact phrase on the public site, no API key, fail-closed parser; unknown name words kept together', async () => {
  const {searchText, parseSearch, entityTerms} = await import('../worker/agent.mjs');
  const {ExternalBudget} = await import('../worker/facts.mjs');
  const page = '<table class="t-table t-table--linked"><tbody><tr><td><a href="/issuer/BULL/" class="chip-ticker">BULL</a></td><td>'
    + '<a href="/document/100219/" class="row-link" title="Risalah RUPS.pdf">Risalah</a><p class="t-caption mt-0.5 truncate">Menyetujui pengangkatan Ibu '
    + '<mark class="hl">Ferita Lie</mark> sebagai Komisaris Independen</p></td><td class="whitespace-nowrap tabular">27 Apr 2026</td></tr></tbody></table>';
  const seen = [], budget = new ExternalBudget(44, 8);
  const rows = await searchText({budget, fetcher:async (url, init) => { seen.push({url, init}); return new Response(page); }}, {q:'Ferita Lie', ticker:'BULL'});
  const url = new URL(seen[0].url);
  assert.equal(url.origin + url.pathname, 'https://quant.renr.ai/explore/documents/');
  assert.equal(url.searchParams.get('q'), '"Ferita Lie"'); assert.equal(url.searchParams.get('ticker'), 'BULL');
  assert.ok(!('Authorization' in seen[0].init.headers), 'the API key never goes to the website');
  assert.equal(seen[0].init.redirect, 'manual'); assert.equal(budget.used, 1);
  assert.deepEqual([rows[0].emiten, rows[0].tanggal], ['BULL', '27 Apr 2026']);
  assert.match(rows[0].kutipan, /Ferita Lie sebagai Komisaris Independen/);
  assert.equal(parseSearch('<html>new layout</html>'), null, 'an unreadable page is an error, not "no results"');
  const manifest = JSON.parse(await readFile(new URL('../worker/.assets/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(entityTerms('kenapa bu ferita lie suka ngibul', manifest).phrases, ['ferita lie']);
  assert.deepEqual(entityTerms('kenapa bu ferita liee itu suka banget ngibul', manifest).phrases, ['ferita liee'], 'banget is not @BangGent');
  assert.deepEqual(entityTerms('user zeinfahrozi suka ngomgin apa sih?', manifest).phrases, ['zeinihzafahrozi']);
  assert.deepEqual(entityTerms('saham yg dipegang zein fahrozi apa aja?', manifest).phrases, ['zein fahrozi', 'zeinihzafahrozi'], 'a name in parts reaches the username');
  assert.deepEqual(entityTerms('siapa Ferita Lie', manifest).phrases, ['Ferita Lie']);
  const asked = [];
  const typo = await searchText({fetcher:async url => { const q = new URL(url).searchParams.get('q'); asked.push(q);
    return new Response(q === '"ferita lie"' ? page : '<table class="t-table"><tbody></tbody></table>'); }}, {q:'ferita liee'});
  assert.deepEqual(asked, ['"ferita liee"', '"ferita lie"']);
  assert.equal(typo[0].ejaan_dicari, 'ferita lie');
});

test('a Stockbit username gets the stocks it posts about, counted by code', async () => {
  const root = new URL('../worker/.assets/', import.meta.url);
  const archive = new Archive({fetch:async r => new Response(await readFile(new URL(new URL(r.url).pathname.slice(1), root)))});
  const {archiveTool} = await import('../worker/agent.mjs');
  const out = await archiveTool(archive, await archive.manifest(), {kata:['zeinihzafahrozi']}, new Map());
  assert.match(out, /saham_dibahas_pengguna:\[\{pengguna:"@zeinihzafahrozi",saham:"PACK \d+x/);
  assert.match(out, /bukan bukti dimiliki/);
});
