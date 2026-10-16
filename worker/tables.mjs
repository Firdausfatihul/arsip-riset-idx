// Material built by code from the archive tables (tools/archive_tables.py) for questions the search path answers
// badly. Nothing here calls a model; every line comes from exact matches and document text stays data.
//   mentionsBlock  [A2] a ticker named by OTHER issuers' announcements (lowercase code, official name): ticker questions
//   relationBlock  [H] exact names shared by 2+ tickers, tiered: ticker questions with relation wording
//   entityMaterial / handleMaterial / rareRumorMaterial: single-call routes (core.mjs tableRoute)
//   claimTail      short code-written list of rumors the answer did not discuss (table routes only)
import {modelText} from './retrieval.mjs';
import {BULAN, clip, editDistance, escapeRegExp, utf8Bytes} from './text.mjs';

export const TABLE_RULES = '\nSetiap klaim Stockbit dirujuk dengan F-id; keterbukaan dengan [D..]. Status di baris CEK tidak boleh dinaikkan. '
  + 'Pisahkan: fakta resmi, data KSEI, rumor/klaim pengguna. Bila menyatakan sesuatu tidak ada, sebut cakupan tanggal sumbernya.';
export const RELATION = /\b(?:pengendali|pemilik|pemegang(?: saham)?|grup|group|orang|nama|pihak|direksi|komisaris|pengurus)\b[^?.!]{0,40}\bsama\b|\b(?:hubungan(?:nya)?|kaitan(?:nya)?|keterkaitan|afiliasi|terafiliasi|relasi|satu (?:grup|group))\b|\b(?:ter|ber)kait(?:an)?\s+antara\b|\bapakah\b[^?.!]{0,60}\b(?:terkait|berkaitan)\b/i;
export const RARE = /\b(jarang|sedikit dibahas|sedikit yang|sepi|kurang dibahas|belum banyak dibahas|tidak banyak dibahas)\b/i;
const KIND_LABEL = {R:'Rumor', K:'Klaim penulis', P:'Pertanyaan', M:'Mengutip keterbukaan', H:'Hitungan penulis', G:'Guyon/kode'};
const MENTION_BUDGET = 4000, ENTITY_BUDGET = 28000;
const monthName = m => { const [y, mo] = String(m || '').split('-'); return mo ? `${BULAN[+mo - 1]} ${y}` : String(m || ''); };
const pct = p => typeof p === 'number' ? p.toFixed(2).replace('.', ',') + '%' : '';
const VERDICT_RANK = {didukung:0, bertentangan:1, tercatat:2, tidak_dapat:3, lain:4, tanpa_dasar:5};
const CA_TOPICS = ['rights_issue','private_placement','tender_offer','akuisisi_pengendali','merger','buyback','stock_split','go_private','pailit'];

export async function loadTables(archive, names = ['claims','subjects','entities','links','coverage']) {
  const index = await archive.manifest();
  if (!index.tables) return null;
  const out = {};
  await Promise.all(names.map(async name => { try { out[name] = await archive.table(name); } catch { out[name] = null; } }));
  return out;
}

export function docLookup(index) {
  const byName = new Map((index.docs || []).map(d => [d.name, d])), byCatDate = new Map();
  for (const d of index.docs || []) byCatDate.set(d.cat + '|' + d.start, d);
  return {byName:name => byName.get(name) || null,
    sbDoc:day => byCatDate.get('stockbit-detail|' + day) || byCatDate.get('stockbit-ringkasan|' + day) || null};
}

// Documents cited by the material, in first-use order; their source_ids are the only valid [D…] references.
export class DocRefs {
  constructor() { this.docs = []; this.ids = new Set(); }
  add(doc) { if (!doc) return ''; if (!this.ids.has(doc.source_id)) { this.ids.add(doc.source_id); this.docs.push(doc); } return '[' + doc.source_id + ']'; }
  sources() { return this.docs.map(({source_id, title, path, label}) => ({source_id, title, path, label})); }
}

// ---- claims and their checks (links are per ticker) ------------------------------------------------------------
const verdictsOf = (tables, code, fid) => [...(tables.links?.links?.[code]?.[fid] || [])].sort((a, b) => VERDICT_RANK[a[0]] - VERDICT_RANK[b[0]]);
// v = [verdict, ref, kalimat] (links.json).
export function verdictText(v) {
  if (v[0] === 'lain') return 'ada keterbukaan lain (topik berbeda) ' + v[1];
  if (v[0] === 'tanpa_dasar') return 'belum ada keterbukaan sejenis dalam cakupan BEI';
  if (v[0] === 'tidak_dapat') return /KSEI/.test(v[2]) ? 'tidak dapat dicek ke KSEI (data s.d. ' + monthName(v[1]) + ')' : 'tidak dapat dicek: berkas BEI sekitar ' + v[1] + ' tidak lengkap';
  return clip(v[2], 200);
}
const bestVerdict = (tables, code, fid) => { const all = verdictsOf(tables, code, fid); return all.find(v => v[0] !== 'lain') || all[0]; };
// One claim line "Fid · tgl · KODE · [Rumor] text · @h · … · CEK: …"; a different-topic disclosure only without a typed check.
export function claimLine(row, code, tables, verdicts = 2) {
  const [fid, day, kind, text, handle, accounts, celah, replies, , dup] = row;
  const all = verdictsOf(tables, code, fid), typed = all.filter(v => v[0] !== 'lain');
  const cek = (typed.length ? typed : all).slice(0, verdicts).map(verdictText);
  return [fid, day, code + ' · [' + (KIND_LABEL[kind] || kind) + '] ' + modelText(text), '@' + handle,
    accounts > 1 ? accounts + ' akun' : '', replies ? replies + ' balasan' : '', celah ? 'celah: ' + celah : '',
    dup?.length ? '+' + dup.length + ' duplikat' : '', cek.length ? 'CEK: ' + cek.join('; ') : ''].filter(Boolean).join(' · ');
}

// ---- [A2] mentions in other issuers' announcements ------------------------------------------------------------
// Only rows the case-sensitive ticker search cannot find: the sentence does not contain the code in capitals
// (lowercase "grpm", the official name). Share transactions first, then newest; creditor rows only for credit questions.
export function mentionsBlock(codes, tables, index, question, {rows = 8, budget = MENTION_BUDGET} = {}) {
  const lookup = docLookup(index), refs = new DocRefs(), credit = /utang|pinjam|kredit/i.test(question), lines = [];
  let used = 0;
  for (const code of codes) {
    const upper = new RegExp('(?<![A-Za-z0-9])' + code + '(?![A-Za-z0-9])');
    // A filer the question names is read by the search path already.
    const list = (tables.subjects?.by_ticker?.[code] || []).filter(s => !upper.test(s[5]) && !codes.includes(s[1]) && (credit || s[4] !== 'kreditur'))
      .sort((a, b) => (a[4] === 'transaksi_saham' ? 0 : 1) - (b[4] === 'transaksi_saham' ? 0 : 1) || b[0].localeCompare(a[0]));
    const seen = new Set();
    let n = 0;
    for (const s of list) {
      const key = s[1] + s[5].slice(0, 80), doc = lookup.byName(s[2]);
      if (seen.has(key) || !doc || n >= rows) continue;
      const line = `- ${code} ← ${s[0]} · pengumuman ${s[1]} · ${s[4]}: "${modelText(s[5])}" [${doc.source_id}] baris ${s[3]}`;
      if (used + utf8Bytes(line) > budget) break;
      seen.add(key); n++; used += utf8Bytes(line) + 1; refs.add(doc); lines.push(line);
    }
  }
  return lines.length ? {text:'[A2] KODE DISEBUT DI PENGUMUMAN EMITEN LAIN (huruf kecil atau nama resmi, tidak ditemukan pencarian kode; kutipan persis):\n'
    + lines.join('\n'), refs, rows:lines.length} : null;
}

// ---- entities ----------------------------------------------------------------------------------------------------
const indexCache = new WeakMap();
// token (lowercase, 4+ chars) -> [norm]; ticker -> [norm].
export function entityIndex(entities) {
  if (!entities) return null;
  if (indexCache.has(entities)) return indexCache.get(entities);
  const tokens = new Map(), byTicker = new Map();
  for (const [norm, e] of Object.entries(entities.names || {})) {
    for (const w of norm.toLowerCase().split(' ')) if (w.length >= 4) { if (!tokens.has(w)) tokens.set(w, []); tokens.get(w).push(norm); }
    for (const code of Object.keys(e.t || {})) { if (!byTicker.has(code)) byTicker.set(code, []); byTicker.get(code).push(norm); }
  }
  const value = {tokens, byTicker, namelike:new Set(entities.namelike || []), issuerWords:new Set(entities.issuer_words || [])};
  indexCache.set(entities, value);
  return value;
}
const QUESTION_WORDS = new Set(('analisa analisis analisakan bagaimana gimana masuk apakah siapa kenapa mengapa tolong dong sih dengan semua dokumen saham emiten '
  + 'grup group keluarga family punya milik pemilik nama sama hubungan kaitan terkait apa aja saja yang ini itu ada tidak belum sudah akan mau jadi '
  + 'arsip postingan stockbit rumor info berita terbaru terakhir pernah tentang soal bahas dibahas banyak ngomongin cerita').split(' '));
// Exact distinctive tokens of the question that name a person, firm or group (no surname/prefix merging). A lowercase
// word counts as a name only when the archive writes it mostly capitalised (entities.namelike); the capital of the
// question's first word does not count. Ticker codes ("emas") and words of issuers' official names ("telkom", "adaro")
// are never name tokens: those questions go to the ticker search. Null too when a capitalised word next to a matched
// name is a rare archive word that names nothing ("Sukanto Tanoto", "Tanoto Foundation"): the full name is unknown.
// A token shared by many names ("hong") is only a content word next to a rarer one ("kheng"). Spelling variants only
// for a word that is no archive word at all (edit distance 1, same first letter, 5+ characters).
export function entityLookup(question, entities, index) {
  const ix = entityIndex(entities);
  if (!ix) return null;
  const common = new Set(index.commonWords || []), postings = index.postings || {}, tickers = new Set(index.tickers || []);
  const docs = w => Array.isArray(postings[w]) ? postings[w].length : 0;
  const seq = question.match(/[\p{L}\p{N}]+/gu) || [];
  const original = new Map(seq.filter(w => w.length >= 4).map(w => [w.toLowerCase(), w]));
  const words = [...original.keys()].filter(w => !common.has(w) && !QUESTION_WORDS.has(w) && !/^\d+$/.test(w) && !tickers.has(w.toUpperCase()));
  const capital = w => /^\p{Lu}/u.test(original.get(w));
  const nameish = w => ix.namelike.has(w) || (capital(w) && original.get(w) !== seq[0]);
  let matched = [], content = [];
  const fuzzy = {}, unknown = new Set();
  for (const w of words) {
    const exact = ix.tokens.get(w);
    if (!ix.issuerWords.has(w)) {
      if (exact && docs(w) <= 60 && exact.length <= 60 && nameish(w)) { matched.push({word:original.get(w), token:w, names:exact}); continue; }
      if (!exact && w.length >= 5 && !Object.hasOwn(postings, w)) {
        const token = [...ix.tokens.keys()].find(t => t[0] === w[0] && t.length >= 5 && editDistance(t, w, 1) <= 1 && ix.tokens.get(t).length <= 60 && ix.namelike.has(t));
        if (token) { matched.push({word:original.get(w), token, names:ix.tokens.get(token)}); fuzzy[w] = token; continue; }
      }
    }
    if (capital(w) && docs(w) >= 1 && docs(w) <= 10) unknown.add(w);
    content.push(w);
  }
  if (!matched.length) return null;
  const tokens = new Set(matched.map(m => m.word.toLowerCase()));
  if (seq.some((w, i) => unknown.has(w.toLowerCase()) && [seq[i - 1], seq[i + 1]].some(n => n && tokens.has(n.toLowerCase())))) return null;
  const rarest = Math.min(...matched.map(m => m.names.length));
  if (rarest <= 5) { content.push(...matched.filter(m => m.names.length > 5).map(m => m.token)); matched = matched.filter(m => m.names.length <= 5); }
  return {matched, content, fuzzy};
}

const ROLE_CLASS = role => /^(bae|kap|notaris|auditor|kustodian)$/i.test(role) ? 'layanan'
  : /direktur|direksi|komisaris/i.test(role) ? 'pengurus' : 'pemegang';
const roleText = rows => rows.slice(0, 3).map(r => [r[0], /^\d{4}-\d{2}$/.test(r[1] || '') ? monthName(r[1]) : r[1], typeof r[2] === 'number' ? pct(r[2]) : '',
  r[3] && !/^F\d/.test(r[3]) ? r[3].replace(/#\d+$/, '') : r[3] || ''].filter(Boolean).join(' ')).join('; ');

// [H] HUBUNGAN TERCATAT between 2+ tickers: exact names in both (KSEI/DPS/BEI roles) and announcements linking them.
export function relationBlock(codes, tables, index) {
  const ix = entityIndex(tables.entities), lookup = docLookup(index), refs = new DocRefs(), lines = [];
  for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) {
    const [a, b] = [codes[i], codes[j]], rows = [];
    for (const norm of (ix?.byTicker.get(a) || []).filter(n => (tables.entities.names[n].t || {})[b])) {
      const e = tables.entities.names[norm], ra = e.t[a], rb = e.t[b];
      const ca = new Set(ra.map(r => ROLE_CLASS(r[0]))), cb = new Set(rb.map(r => ROLE_CLASS(r[0])));
      const tier = e.k === 'service' || ca.has('layanan') || cb.has('layanan') ? 'lemah' : [...ca].some(c => cb.has(c)) ? 'kuat' : 'sedang';
      rows.push({tier, text:`- (${tier}) ${e.d}: ${a} ${roleText(ra)} | ${b} ${roleText(rb)}`});
    }
    for (const [x, y] of [[a, b], [b, a]]) for (const s of (tables.subjects?.by_ticker?.[x] || []).filter(s => s[1] === y && s[4] !== 'kreditur').slice(0, 4)) {
      const tier = s[4] === 'transaksi_saham' ? 'kuat' : 'sedang', doc = lookup.byName(s[2]);
      rows.push({tier, text:`- (${tier}) pengumuman ${y} ${s[0]} menyebut ${x} (${s[4]}): "${modelText(s[5])}" ${refs.add(doc)}${doc ? ' baris ' + s[3] : ''}`});
    }
    const order = {kuat:0, sedang:1, lemah:2};
    rows.sort((p, q) => order[p.tier] - order[q.tier]);
    lines.push(`Pasangan ${a}–${b}:`, ...(rows.length ? rows.slice(0, 14).map(r => r.text) : ['- tidak ada pihak sama yang tercatat dalam data KSEI/DPS/BEI yang tersedia.']),
      ...(rows.length > 14 ? [`- ${rows.length - 14} nama/baris lain tidak dicantumkan.`] : []));
  }
  lines.push('Tier: kuat = nama persis sama dengan peran pemegang/pengurus sejenis di kedua emiten atau baris transaksi; sedang = nama sama, peran berbeda; lemah = penyedia jasa (BAE/KAP). Kesamaan nama belum membuktikan pengendali yang sama.');
  return {text:'[H] HUBUNGAN TERCATAT (disusun sistem dari nama persis KSEI/DPS/BEI):\n' + lines.join('\n'), refs};
}

// ---- entity route --------------------------------------------------------------------------------------------------
const plainHtml = text => String(text).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");
const tidy = text => modelText(plainHtml(text)).replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
const wordRx = words => new RegExp('(?<![\\p{L}\\p{N}_])(?:' + words.map(escapeRegExp).join('|') + ')(?![\\p{L}\\p{N}_])', 'iu');
const recordsOf = async (archive, index, doc) => { try { return (archive.store?.read?.(doc, index) || await archive.read(doc.evidence_asset))?.records || []; } catch { return []; } };
const coverageHead = cov => `cakupan Stockbit ${cov.stockbit?.[0] || '?'}..${cov.stockbit?.[1] || '?'}; BEI ${cov.bei?.[0] || '?'}..${cov.bei?.[1] || '?'}; KSEI s.d. ${monthName(cov.ksei?.[1]) || '?'}`;

// ctx: {archive, index, tables, ksei}. Null when the question names no entity of entities.json.
export async function entityMaterial(question, ctx) {
  const {index, tables, archive} = ctx, ents = tables.entities, found = entityLookup(question, ents, index);
  if (!found) return null;
  const lookup = docLookup(index), refs = new DocRefs(), ix = entityIndex(ents);
  const norms = [...new Set(found.matched.flatMap(m => m.names))];
  const aliasOf = n => [...(ents.alias?.[n] || [])];
  // Explicit aliases ("PT X, bagian Rimau Group") are always followed; spelling variants only as a fallback.
  const exactWords = [...new Set(found.matched.map(m => m.token))];
  const aliasNames = [...new Set(norms.flatMap(aliasOf))].filter(n => ents.names[n]);
  const aliasWords = aliasNames.map(n => ents.names[n].d.replace(/^PT\.?\s+/i, '').replace(/,?\s*(Tbk|PT)\.?$/i, '').trim()).filter(w => w.length >= 4);
  const variantWords = [...new Set(exactWords.flatMap(w => ents.variants?.[w] || []))];
  const variantAliases = [...new Set(variantWords.flatMap(w => aliasOf(w.toUpperCase())))].filter(n => ents.names[n]);
  const content = found.content.filter(w => w.length >= 4);
  const lines = [], card = norms.map(n => ents.names[n]).sort((a, b) => (b.deg || 0) - (a.deg || 0)).slice(0, 12);
  lines.push('KARTU NAMA (nama persis dari KSEI, daftar pemegang laporan emiten, keterbukaan BEI dan kutipan keterbukaan; nama berbeda tidak digabung):');
  for (const e of card) lines.push(`- ${e.d} (${e.k}${e.issuer ? ', nama emiten ' + e.issuer : ''})`
    + (Object.keys(e.t || {}).length ? ' · ' + Object.entries(e.t).map(([code, rows]) => code + ': ' + roleText(rows)).join(' | ') : ' · tanpa emiten tercatat'));
  const aliasLine = (n, prefix) => (ents.alias_src?.[n] || []).map(([member, docName, line, snippet]) =>
    `- ${prefix}: ${ents.names[n]?.d || n} ↔ ${ents.names[member]?.d || member} — ${docName} baris ${line}: "${modelText(snippet)}" ${refs.add(lookup.byName(docName))}`);
  for (const n of [...norms, ...aliasNames]) lines.push(...aliasLine(n, 'Alias tertulis'));
  if (Object.keys(found.fuzzy).length) lines.push('- Ejaan pertanyaan dicocokkan ke nama terdekat: ' + Object.entries(found.fuzzy).map(([a, b]) => `“${a}” → ${b}`).join(', ') + '.');
  if (variantWords.length) lines.push(`- Ejaan mirip di arsip (bisa orang/badan berbeda; tidak digabung): ${variantWords.join(', ')}.`);
  // Name collisions: a holder whose name contains another card ticker's code is not that issuer.
  const cardCodes = new Set(card.flatMap(e => Object.keys(e.t || {})));
  const claimRx = wordRx(exactWords), claimHits = [];
  for (const [code, rows] of Object.entries(tables.claims?.by_ticker || {})) for (const r of rows) if (claimRx.test(r[3])) { claimHits.push({code, row:r}); cardCodes.add(code); }
  const notes = new Set();
  for (const code of cardCodes) for (const n of ix.byTicker.get(code) || []) for (const w of n.split(' '))
    if (w !== code && cardCodes.has(w) && w.length === 4 && !ents.names[n].issuer) notes.add(`- ${ents.names[n].d} (pihak di ${code}) memuat kata ${w}, tetapi tidak tercatat sebagai emiten ${w}; tidak digabung.`);
  lines.push(...[...notes].slice(0, 6));
  // Context: other >1% holders of the card's issuers (each issuer's last verified KSEI month). Holding the same issuer
  // is not a relation.
  const months = ctx.ksei?.history?.months || [], holderCodes = [...new Set(card.flatMap(e => Object.keys(e.t || {})))].slice(0, 8);
  const holderLines = [];
  for (const code of months.length ? holderCodes : []) {
    const issuer = ctx.ksei.history.issuers?.[code], usable = issuer?.usable || [];
    let i = months.length - 1;
    while (i >= 0 && usable[i] === false) i--;
    const holders = (issuer?.holders || []).filter(h => h.pct?.[i] != null).sort((a, b) => b.pct[i] - a.pct[i]).slice(0, 6);
    if (i >= 0 && holders.length) holderLines.push(`- ${code} (${monthName(months[i])}): ` + holders.map(h => `${h.name} ${pct(h.pct[i])}`).join('; '));
  }
  if (holderLines.length) lines.push('PEMEGANG >1% LAIN DI EMITEN TERSEBUT (KSEI, bulan terverifikasi terakhir; konteks, bukan bukti hubungan):', ...holderLines);
  // Passages: entity words AND the question's remaining content words; then with spelling variants; then entity words alone.
  const pool = (index.docs || []).filter(d => !/^stockbit-(?:detail|ringkasan)$/.test(d.cat)).sort((a, b) => b.end.localeCompare(a.end) || a.name.localeCompare(b.name));
  const collect = async (words, needContent) => {
    const rx = wordRx(words), crx = content.map(w => wordRx([w])), out = [];
    for (const doc of pool) {
      const recs = await recordsOf(archive, index, doc), taken = new Set(), textOf = r => doc.name.endsWith('.html') ? plainHtml(r.content) : r.content;
      recs.forEach((r, i) => {
        if (r.kind === 'script') return;
        const text = textOf(r);
        if (!rx.test(text) || (needContent && !crx.every(c => c.test(text)))) return;
        // Neighbouring prose of the same section carries the facts the matching sentence refers to.
        for (const j of [i - 2, i - 1, i, i + 1]) {
          const n = recs[j];
          if (!n || taken.has(j) || n.kind === 'script' || (j !== i && (n.context !== r.context || n.kind === 'issuer_section'))) continue;
          taken.add(j); out.push({doc, r:n, text:textOf(n)});
        }
      });
    }
    return out;
  };
  let passages = [], mode = 'and';
  if (content.length) {
    passages = await collect([...exactWords, ...aliasWords], true);
    if (!passages.length) { passages = await collect([...exactWords, ...aliasWords, ...variantWords, ...variantAliases.map(n => ents.names[n].d)], true); mode = 'and+ejaan'; }
  }
  if (!passages.length) { passages = await collect([...exactWords, ...aliasWords], false); mode = 'or'; }
  if (mode === 'and+ejaan') for (const n of variantAliases) lines.push(...aliasLine(n, 'Alias tertulis untuk ejaan mirip (bukan bukti orang yang sama)'));
  const pLines = []; let used = 0;
  for (const {doc, r, text} of passages) {
    const ctxLine = String(r.context || '').split('\n').filter(Boolean).pop() || '';
    const line = `- ${refs.add(doc)} ${doc.name} (${doc.label})${ctxLine ? ' · ' + clip(plainHtml(ctxLine), 80) : ''}: ${clip(tidy(text), 1500)}`;
    if (used + utf8Bytes(line) > ENTITY_BUDGET) break;
    pLines.push(line); used += utf8Bytes(line) + 1;
  }
  // Claims naming the entity: content words first, then rumors/quotes, newest first.
  const crx = content.map(w => wordRx([w]));
  if (mode === 'and+ejaan' && variantWords.length) { const vrx = wordRx(variantWords);
    for (const [code, rows] of Object.entries(tables.claims?.by_ticker || {})) for (const r of rows) if (vrx.test(r[3]) && !claimHits.some(h => h.row === r)) claimHits.push({code, row:r}); }
  const rank = h => (crx.length && crx.every(c => c.test(h.row[3])) ? 0 : 2) + ('RM'.includes(h.row[2]) ? 0 : 1);
  const seenFid = new Set(), cLines = [], cRows = [];
  for (const h of claimHits.sort((a, b) => rank(a) - rank(b) || b.row[1].localeCompare(a.row[1]))) {
    if (seenFid.has(h.row[0]) || cLines.length >= 40) continue;
    seenFid.add(h.row[0]);
    cLines.push(`- ${claimLine(h.row, h.code, tables)} ${refs.add(lookup.sbDoc(h.row[1]))}`);
    if ('RM'.includes(h.row[2])) cRows.push({row:h.row, code:h.code});
  }
  const text = [`=== NAMA: ${found.matched.map(m => m.word).join(', ')} | ${coverageHead(tables.coverage || {})} ===`, lines.join('\n'),
    `KUTIPAN ARSIP (${mode === 'or' ? 'menyebut nama' : 'menyebut nama dan ' + content.join(', ')}${mode === 'and+ejaan' ? '; termasuk ejaan mirip/alias' : ''}; terbaru dulu):\n`
      + (pLines.join('\n') || '- tidak ada kutipan yang cocok.'),
    cLines.length ? 'KLAIM STOCKBIT YANG MENYEBUT NAMA (belum diverifikasi):\n' + cLines.join('\n') : ''].filter(Boolean).join('\n\n');
  // Only the matched names are search terms for a follow-up; the question's other words are not.
  return {text, refs, claims:cRows, terms:found.matched.map(m => m.word),
    stats:{matched:found.matched.map(m => m.word + '→' + m.token), names:norms.length, mode, passages:pLines.length, claims:cLines.length},
    instruction:'\nBahan berupa kartu nama dan kutipan yang disusun sistem dari nama persis. Nama yang mirip atau ejaan berbeda bisa orang/badan berbeda; '
      + 'jangan menggabungkan atau menyimpulkan kepemilikan dari kemiripan nama. Bedakan fakta dokumen, kutipan keterbukaan di Stockbit, dan rumor.'};
}

// ---- rare rumors ---------------------------------------------------------------------------------------------------
// Corporate-action rumors/jokes-with-a-code/quoted disclosures of issuers whose such rumors come from ≤maxAccounts accounts on ≤maxDays days,
// plus the desk's own "Jarang disebut tapi material" lists.
export async function rareRumorMaterial(ctx, {maxAccounts = 3, maxDays = 2, limit = 60, deskBudget = 12000} = {}) {
  const {index, tables, archive} = ctx, lookup = docLookup(index), refs = new DocRefs();
  const topics = tables.claims?.topics || [], ca = CA_TOPICS.reduce((m, t) => topics.includes(t) ? m | (1 << topics.indexOf(t)) : m, 0);
  const found = [], issuers = new Set();
  for (const [code, rows] of Object.entries(tables.claims?.by_ticker || {})) {
    const hits = rows.filter(r => 'RMG'.includes(r[2]) && (r[8] & ca));
    if (!hits.length) continue;
    const accounts = new Set(hits.map(r => r[4])).size + hits.reduce((n, r) => n + Math.max(0, r[5] - 1), 0), days = new Set(hits.map(r => r[1])).size;
    if (accounts > maxAccounts || days > maxDays) continue;
    for (const r of hits) {
      const v = verdictsOf(tables, code, r[0]).filter(v => v[0] !== 'lain')[0];
      found.push({code, row:r, rank:!v ? 2 : v[0] === 'didukung' ? 0 : v[0] === 'tanpa_dasar' ? 2 : 1, accounts, days});
    }
  }
  // One row per issuer first (best check, then newest), then further rows of the same issuers; a finding filed under
  // several tickers is listed once.
  found.sort((a, b) => a.rank - b.rank || b.row[1].localeCompare(a.row[1]));
  const first = [], rest = [], fids = new Set();
  for (const t of found) {
    if (fids.has(t.row[0])) continue;
    fids.add(t.row[0]);
    (issuers.has(t.code) ? rest : (issuers.add(t.code), first)).push(t);
  }
  const chosen = [...first, ...rest].slice(0, limit), cov = tables.coverage || {};
  const lines = chosen.map(t => `- ${claimLine(t.row, t.code, tables)} · emiten ini: ${t.accounts} akun/${t.days} hari ${refs.add(lookup.sbDoc(t.row[1]))}`);
  const desk = []; let used = 0;
  for (const doc of (index.docs || []).filter(d => d.cat === 'stockbit-ringkasan').sort((a, b) => b.end.localeCompare(a.end))) {
    for (const r of (await recordsOf(archive, index, doc)).filter(r => /(^|\n)Jarang disebut tapi material\s*$/.test(r.context || '')))
      for (const item of r.content.split('\n').filter(l => /^- /.test(l))) {
        const line = `${modelText(item).trim()} ${refs.add(doc)}`;
        if (used + utf8Bytes(line) > deskBudget) break;
        desk.push(line); used += utf8Bytes(line) + 1;
      }
  }
  const text = `=== RUMOR AKSI KORPORASI YANG JARANG DIBAHAS (disusun sistem dari indeks temuan Stockbit ${cov.stockbit?.[0]}..${cov.stockbit?.[1]}) ===\n`
    + `Kriteria: temuan Rumor, Guyon/kode atau Mengutip keterbukaan bertopik aksi korporasi (rights issue, private placement, tender offer, akuisisi/pengendali, merger, buyback, stock split, go private, pailit) `
    + `pada emiten yang rumor sejenisnya hanya dari ≤${maxAccounts} akun dan ≤${maxDays} hari. ${found.length} temuan dari ${issuers.size} emiten memenuhi, ${chosen.length} dicantumkan (satu per emiten dulu). `
    + `CEK membandingkan dengan keterbukaan BEI emiten itu sendiri (${cov.bei?.[0]}..${cov.bei?.[1]}) dan KSEI s.d. ${monthName(cov.ksei?.[1])}; ini bukan screening seluruh pasar.\n` + lines.join('\n')
    + (desk.length ? '\n\nDAFTAR DESK "JARANG DISEBUT TAPI MATERIAL" (ringkasan harian Stockbit, terbaru dulu; klaim pengguna):\n' + desk.join('\n') : '');
  // No search terms: a follow-up asks the term call again with the conversation history.
  return {text, refs, claims:chosen.map(t => ({row:t.row, code:t.code})), terms:[],
    stats:{eligible:found.length, issuers:issuers.size, listed:chosen.length, desk:desk.length},
    instruction:'\nSusun daftar pendek berperingkat dari bahan: emiten, klaim (F-id), status CEK apa adanya, mengapa menarik, dan apa yang perlu dicek. Jangan menaikkan status CEK; rumor tanpa dasar tetap disebut rumor.'};
}

// ---- Stockbit handle ------------------------------------------------------------------------------------------------
// Extras next to stockbit.mjs stockbitHandleBlock: the handle's findings with checks, topic counts and the desk's thread.
export function handleMaterial(handle, ctx, {limit = 60} = {}) {
  const {index, tables, sbTable} = ctx, lookup = docLookup(index), refs = new DocRefs();
  const rows = [], seen = new Set();
  for (const [code, list] of Object.entries(tables.claims?.by_ticker || {})) for (const row of list)
    if (row[4] === handle && !seen.has(row[0])) { seen.add(row[0]); rows.push({code, row}); }
  const topics = tables.claims?.topics || [], hist = {}, kinds = {};
  for (const {row} of rows) {
    kinds[row[2]] = (kinds[row[2]] || 0) + 1;
    topics.forEach((t, i) => { if (row[8] & (1 << i)) hist[t] = (hist[t] || 0) + 1; });
  }
  const note = sbTable?.user_notes?.[handle] || {};
  const lines = [`TEMUAN @${handle} DI INDEKS TEMUAN (dihitung sistem): ${rows.length} temuan; jenis: ${Object.entries(kinds).map(([k, n]) => (KIND_LABEL[k] || k) + ' ' + n).join(', ') || '-'}.`,
    `- Topik (pencocokan kata, satu temuan bisa lebih dari satu topik): ${Object.entries(hist).sort((a, b) => b[1] - a[1]).map(([t, n]) => t + ' ' + n).join(', ') || 'tidak ada topik khusus'}.`];
  if (note.benang?.text) lines.push(`- Benang lintas hari (desk): ${modelText(note.benang.text)} (${(note.benang.finding_ids || []).join(', ')})`);
  if (note.based_on?.last_day) lines.push(`- Penilaian desk berdasarkan ${note.based_on.findings} temuan s.d. ${note.based_on.last_day}.`);
  const chosen = [...rows].sort((a, b) => ('RMH'.includes(b.row[2]) - 'RMH'.includes(a.row[2])) || b.row[1].localeCompare(a.row[1])).slice(0, limit)
    .sort((a, b) => a.row[1].localeCompare(b.row[1]));
  lines.push('Temuan (terlama dulu):', ...chosen.map(x => `- ${claimLine(x.row, x.code, tables, 1)} ${refs.add(lookup.sbDoc(x.row[1]))}`));
  if (rows.length > chosen.length) lines.push(`- ${rows.length - chosen.length} temuan lain tidak dicantumkan.`);
  return {text:lines.join('\n'), refs, claims:chosen.filter(x => 'RM'.includes(x.row[2])).map(x => ({row:x.row, code:x.code})), stats:{findings:rows.length, listed:chosen.length}};
}

// ---- claim tail ----------------------------------------------------------------------------------------------------
const STOPWORDS = new Set('yang dengan untuk dari pada dalam akan sudah belum tidak juga atau karena oleh sebagai bahwa saham emiten penulis pengguna disebut menyebut adalah'.split(' '));
const keyTokens = text => new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || []).filter(w => !STOPWORDS.has(w)));
// Rumors/quotes of the material the answer neither cites by F-id nor paraphrases (token overlap >= 0.6): at most
// `limit` one-line rows.
export function claimTail(answer, claims, tables, {limit = 8, overlap = 0.6} = {}) {
  if (!claims?.length) return '';
  const sentences = String(answer).split(/(?<=[.!?\n])\s+/).map(keyTokens);
  const missing = claims.filter(({row}) => {
    if (answer.includes(row[0]) || (row[9] || []).some(f => answer.includes(f))) return false;
    const key = keyTokens(row[3]);
    return !key.size || !sentences.some(s => { let n = 0; for (const w of key) if (s.has(w)) n++; return n / key.size >= overlap; });
  });
  if (!missing.length) return '';
  const lines = missing.slice(0, limit).map(({row, code}) => {
    const v = bestVerdict(tables, code, row[0]);
    return `- ${row[0]} · ${code} · ${clip(modelText(row[3]), 140)}${v ? ' — CEK: ' + clip(verdictText(v), 120) : ''}`;
  });
  return `**Klaim tercatat lain (${missing.length}, belum diverifikasi; daftar sistem):**\n\n` + lines.join('\n')
    + (missing.length > limit ? `\n- … dan ${missing.length - limit} klaim lain.` : '');
}
