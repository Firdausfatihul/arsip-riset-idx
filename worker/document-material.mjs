// Whole-document prompts retain every source character without repeating the
// retrieval index's headings and table headers for every paragraph/table row.
// Offsets count Unicode code points, matching tools/evidence_index.py.
import {modelText} from './retrieval.mjs';
const encoder = new TextEncoder();
const bytes = value => encoder.encode(JSON.stringify(value)).length;
const UNIT_LIMIT = 220000;
const PART_LENGTH = 22000;

// transform (the model copy, e.g. modelText) rewrites each record before it is sent; the parts then carry no source
// offsets (they would not match the original) and `checked` keeps the original text for the post-answer number check.
export function documentUnits(doc, records, {transform = null} = {}) {
  const original = transform ? records.map(row => row.content).join('') : null;
  if (transform) records = records.map(row => ({...row, content:transform(row.content)}));
  const text = records.map(row => row.content).join('');
  const units = [];
  let parts = [], unitBytes = 2, rowIndex = 0, rowEnd = records[0]?.content.length || 0;
  let sourceLine = 1, sourceOffset = 0, part = 0;
  for (let start = 0; start < text.length;) {
    while (rowEnd <= start && rowIndex < records.length - 1) {
      rowEnd += records[++rowIndex].content.length;
    }
    const row = records[rowIndex];
    let end = Math.min(start + PART_LENGTH, text.length);
    // Never separate the two UTF-16 code units of a source character.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    const content = text.slice(start, end);
    const nextOffset = sourceOffset + Array.from(content).length;
    const value = {
      source_id: 'D1', section_id: row.section_id, source_line: sourceLine,
      ...(transform ? {} : {source_start: sourceOffset, source_end: nextOffset}),
      // Context is needed when a chunk starts inside a section or table. Other
      // headings and headers are already present in the unmodified source text.
      context: row.context || '', part: ++part, text: content
    };
    const partBytes = bytes(value);
    if (partBytes + 2 > UNIT_LIMIT) throw new Error('Document source context exceeds the material limit.');
    if (parts.length && unitBytes + 1 + partBytes > UNIT_LIMIT) {
      units.push({doc, parts, ...(transform ? {checked:''} : {})});
      parts = []; unitBytes = 2;
    }
    unitBytes += partBytes + (parts.length ? 1 : 0);
    parts.push(value);
    sourceLine += (content.match(/\n/g) || []).length;
    sourceOffset = nextOffset;
    start = end;
  }
  if (parts.length) units.push({doc, parts, ...(transform ? {checked:''} : {})});
  // The whole original is checked once (on the first unit), not per transformed chunk.
  if (transform && units.length) units[0].checked = original;
  return units;
}

// ---- Desk documents: code-built digest ------------------------------------------------------------------------------
// The Signal Desk files (sbringkas_/sbdetail_/beiringkas_/beidetail_, and the weekly recaps) share a fixed layout: a
// preamble (title, coverage line, disclaimer, period), head sections ("Yang berubah", "Sorotan", "Jarang disebut tapi
// material"), issuer sections ("## FORU", "### APEX — PT …", already ranked by the desk) and appendices ("Emiten lain",
// "Laporan rutin", "Jadwal 30 hari", "Lampiran: semua pengumuman", "Tanpa emiten" …). A request that does not fit its
// budget reads the head of every day, then issuer sections in document order shared fairly across the days, and lists
// the remaining sections in one line each. Nothing is invented: every sent character is source text (model copy without
// links/ids) or a marked system note. Counts (documentFacts) and the number check keep using the full original records.
export const DESK_CATS = new Set(['stockbit-ringkasan', 'stockbit-detail', 'stockbit-pekan', 'bei-ringkasan', 'bei-detail', 'bei-pekan']);
// Byte budgets of the desk material (Claude reads this archive at ~1.8 bytes per token).
// The exhaustive budget stays below the 180 KB answer threshold (EXHAUSTIVE_MATERIAL in core.mjs), which counts the
// JSON-wrapped parts (~1–2% larger than the digest text).
// broad: "ringkas semua yang penting" over several days; detail: a single day asked "detail"/"rinci" (both read rich leads,
// see deskDigest `rich`).
export const DIGEST_BUDGET = Object.freeze({normal:72000, exhaustive:165000, compact:27000, broad:120000, detail:120000});
const HEAD = /^(?:sorotan|yang berubah|jarang disebut)/i;
const APPENDIX = /^lampiran\b/i;
const LEAD = 1100;
const DEFER = 10;
const utf8 = text => encoder.encode(text).length;
// In-page anchors ("[ABMM](#kepemilikan=ABMM)") carry no evidence either.
export const deskText = text => modelText(text).replace(/\[([^\[\]\n]{1,120})\]\(#[^)\s]*\)/g, '$1');
const RINGKAS = {'stockbit-ringkasan':'stockbit-detail', 'bei-ringkasan':'bei-detail'};
const span = d => d.covers || [d.start, d.end];

function codeOf(heading, tickers) {
  const code = String(heading).replace(/[*`]/g, '').replace(/^[\d.()\s]+/, '').match(/^([A-Z0-9]{2,8})(?![A-Za-z0-9_])/)?.[1];
  return code && (!tickers || tickers.has(code)) ? code : null;
}
// Segments at H2 level; an H2 without a code that holds H3 issuer sections ("Emiten material", "Emiten lain dengan
// temuan material") is split into its intro and one segment per H3 issuer.
export function deskSegments(text, tickers) {
  const lines = text.split(/(?<=\n)/), segs = [];
  let seg = {kind:'pre', heading:'', line:1, text:''}, container = null;
  lines.forEach((line, i) => {
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m && m[1].length === 2) {
      segs.push(seg);
      const code = codeOf(m[2], tickers);
      seg = {kind:code ? 'issuer' : APPENDIX.test(m[2]) ? 'appendix' : HEAD.test(m[2]) ? 'head' : 'aux', code, heading:m[2], line:i + 1, text:''};
      container = seg.kind === 'aux' ? seg : null;
    } else if (m && container && codeOf(m[2], tickers)) {
      container.kind = 'intro';
      segs.push(seg);
      seg = {kind:'issuer', code:codeOf(m[2], tickers), heading:m[2], line:i + 1, text:'', parent:container};
    }
    seg.text += line;
  });
  segs.push(seg);
  const out = segs.filter(s => s.text);
  // Children of a container are the top tier only when the document has no H2 issuer sections (BEI daily summary).
  const top = out.some(s => s.kind === 'issuer' && !s.parent);
  for (const s of out) if (s.kind === 'issuer') s.tier = !s.parent || !top ? 1 : 2;
  return out;
}
// Cut at a line boundary within `limit` bytes; the cut is marked.
function cut(text, limit, note = 'sisa bagian ini tidak dikirim') {
  if (utf8(text) <= limit) return text;
  const lines = text.split(/(?<=\n)/);
  let out = '', n = 0;
  for (const line of lines) {
    if (out && utf8(out + line) > limit - 80) break;
    out += utf8(line) > limit ? [...line].slice(0, Math.max(100, limit - 120)).join('') + '…\n' : line;
    n++;
  }
  const rest = lines.slice(n).filter(l => l.trim()).length;
  return out.replace(/\n*$/, '\n') + `(… ${rest ? rest + ' baris lain: ' : ''}${note})\n\n`;
}
// Heading plus the opening paragraphs up to LEAD bytes (at least the first paragraph). A section cut short is always
// marked, so the model can tell a partial section from a complete one.
const LEAD_NOTE = 'rincian bagian ini tidak dikirim';
// A Stockbit issuer section's findings are one paragraph (the bullet list), so a paragraph lead would never carry a
// finding: up to LEAD_QUOTES lines quoting an official disclosure ("- [Mengutip keterbukaan] …", at most 400 bytes
// each) follow the opening paragraphs.
const LEAD_QUOTES = 2;
const QUOTE = /^- \[Mengutip keterbukaan/, QUOTE_LINE = /^- \[Mengutip keterbukaan/m;
function lead(text) {
  const paras = text.split(/(?<=\n\s*\n)/);
  let out = '';
  for (const p of paras) {
    if (out && utf8(out + p) > LEAD && /\S/.test(out.replace(/^#.*\n/, ''))) break;
    out += p;
  }
  if (out.length >= text.length) return text;
  if (utf8(out) > LEAD + 600) out = cut(out, LEAD + 600, LEAD_NOTE).replace(/\(… [^\n]*\)\n\n$/, '');
  const quotes = text.slice(out.length).split(/(?<=\n)/).filter(l => QUOTE.test(l)).slice(0, LEAD_QUOTES)
    .map(l => utf8(l) > 400 ? [...l].slice(0, 380).join('').replace(/\n$/, '') + '…\n' : l);
  return out.replace(/\n*$/, quotes.length ? '\n\n' : '\n') + quotes.join('') + `(… ${LEAD_NOTE})\n\n`;
}
// Rich leads (broad and detail requests). A Stockbit section's lead carries up to RICH_QUOTES finding lines, those quoting
// an official disclosure with a number first, then other findings with a number, then other disclosure quotes. A BEI detail
// section ("**Hari ini**" with per-announcement "Ringkasan:"/"Fakta:" bullets) is sent as its brief: status, continuity
// line and, per announcement of the day, its title, Ringkasan, Mengoreksi and Fakta bullets up to `facts` bytes; the
// Angka/Aksi korporasi/Tanggal penting/Batasan/Lampiran bullets and the later blocks (Baru vs sebelumnya, Riwayat, Jadwal)
// are left out and marked.
const RICH_QUOTES = 3, LATE_QUOTES = 2, LEAD_FACTS = 320, GROW_FACTS = 1400;
const NUMBER = /(?:Rp|US\$|A\$|S\$|USD|IDR)\s?\d|\d[\d.,]*\s?(?:%|(?:persen|juta|jt|miliar|triliun)\b)|\d[\d.,]*\s?[MT]\b/i;
const FINDING = /^- \[/;
export const hasNumber = text => NUMBER.test(text);
const isBrief = text => /^\*\*Hari ini\*\*/m.test(text) && /^ {2}- Ringkasan:/m.test(text);
function brief(text, facts) {
  let out = '', keep = true, inFacts = false, factBytes = 0, dropped = 0, left = false;
  for (const line of text.split(/(?<=\n)/)) {
    if (/^\*\*/.test(line) && !/^\*\*Hari ini\*\*/.test(line)) { left = true; break; }
    if (/^- \d\d:\d\d · /.test(line)) { keep = true; inFacts = false; out += line; continue; }
    const label = line.match(/^ {2}- ([^:\n]+):/);
    if (label) {
      keep = /^(?:Ringkasan|Mengoreksi|Fakta)$/.test(label[1]); inFacts = label[1] === 'Fakta'; factBytes = 0;
      if (!keep) left = true; else out += line;
      continue;
    }
    if (!keep) continue;
    if (inFacts && /^ {4}- /.test(line)) {
      if (factBytes + utf8(line) > facts) { dropped++; continue; }
      factBytes += utf8(line);
    }
    out += line;
  }
  if (!left && !dropped) return text;
  return out.replace(/\n*$/, '\n') + `(… ${dropped ? dropped + ' butir fakta lain, ' : ''}angka, tanggal penting, batasan, riwayat dan jadwal: ${LEAD_NOTE})\n\n`;
}
function richLead(text, quotes = RICH_QUOTES) {
  if (isBrief(text)) return brief(text, LEAD_FACTS);
  const paras = text.split(/(?<=\n\s*\n)/);
  let out = '';
  for (const p of paras) {
    if (out && (FINDING.test(p) || utf8(out + p) > LEAD) && /\S/.test(out.replace(/^#.*\n/, ''))) break;
    out += p;
  }
  if (out.length >= text.length) return text;
  if (utf8(out) > LEAD + 600) out = cut(out, LEAD + 600, LEAD_NOTE).replace(/\(… [^\n]*\)\n\n$/, '');
  const lines = text.slice(out.length).split(/(?<=\n)/).filter(l => FINDING.test(l));
  const rank = l => /^- \[Pertanyaan/.test(l) ? 3 : QUOTE.test(l) && NUMBER.test(l) ? 0 : NUMBER.test(l) ? 1 : QUOTE.test(l) ? 2 : 3;
  const picked = lines.map((l, i) => [l, i]).filter(([l]) => rank(l) < 3).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .slice(0, quotes).sort((a, b) => a[1] - b[1])
    .map(([l]) => utf8(l) > 400 ? [...l].slice(0, 380).join('').replace(/\n$/, '') + '…\n' : l);
  return out.replace(/\n*$/, picked.length ? '\n\n' : '\n') + picked.join('') + `(… ${LEAD_NOTE})\n\n`;
}
// Growth of a rich lead: a BEI detail brief with more Fakta bullets (cut at `cap` bytes); another section whole when it
// fits `cap`, else it keeps its lead (a cut would drop the finding lines the lead picked from further down).
const richGrow = (text, cap, current) => isBrief(text) ? (b => utf8(b) <= cap ? b : cut(b, cap, LEAD_NOTE))(brief(text, GROW_FACTS))
  : utf8(text) <= cap ? text : current;
// One line for a section that is not sent: heading and the opening clause ("inti: …" for Stockbit).
function listLine(seg) {
  const body = (seg.text.split('\n').slice(1).map(l => l.trim()).find(l => l && !/^#/.test(l)) || '').replace(/^[-*]\s+/, '').replace(/^\|.*/, '');
  let clause = body.includes('inti') ? body.replace(/^.*?\binti\b[^:]*:\s*/, '') : body.replace(new RegExp('^' + (seg.code || '\\0') + '\\s*·\\s*'), '');
  clause = deskText(clause).replace(/\s+/g, ' ').trim();
  if (clause.length > 110) clause = [...clause].slice(0, 110).join('').replace(/\s+\S*$/, '') + '…';
  return '- ' + seg.heading.replace(/\s+/g, ' ') + (clause ? ' — ' + clause : '');
}
// Round robin over the days: each pass takes the next item of every day in turn while it fits the remaining budget.
function roundRobin(queues, left, cost, take) {
  const pos = queues.map(() => 0), stuck = queues.map(q => !q.length);
  while (stuck.some(s => !s)) {
    queues.forEach((q, d) => {
      if (stuck[d]) return;
      const item = q[pos[d]], c = cost(item);
      if (c > left) { stuck[d] = true; return; }
      left -= c; take(item); if (++pos[d] >= q.length) stuck[d] = true;
    });
  }
  return left;
}

// entries: [{doc, rows}] (full original records). Returns Map doc -> {whole, pieces:[{text, line, heading}], coverage, codes, sent}.
// headOnly: a daily summary read next to the same day's detail file contributes only its preamble and head
// sections; its issuer sections are contained in the detail file. prefer: codes that a co-selected non-desk document
// (a KI analysis to cross-check) has its own section for; their issuer sections are read first, as top tier.
// rich (broad and detail requests): every top-tier issuer gets a rich lead first (richLead), then the second-tier sections
// that carry a number, then the leads grow (richGrow), then the other second-tier sections and the appendices.
export function deskDigest(entries, {budget = DIGEST_BUDGET.normal, exhaustive = false, tickers = null, prefer = new Set(), rich = false} = {}) {
  const docs = [...entries].sort((a, b) => String(span(a.doc)[0]).localeCompare(String(span(b.doc)[0])) || String(a.doc.cat).localeCompare(String(b.doc.cat)));
  const days = new Set(docs.filter(e => /-detail$/.test(e.doc.cat)).map(e => e.doc.cat + ':' + span(e.doc).join('/')));
  const plans = docs.map(e => {
    // Segments are annotated in place: issuer segments keep a reference to their container.
    const segs = deskSegments(e.rows.map(r => r.content).join(''), tickers);
    for (const s of segs) {
      s.model = deskText(s.text);
      if (s.kind === 'appendix' && !exhaustive) {
        const items = (s.text.match(/^[-*] /gm) || []).length;
        s.model = `## ${s.heading}\n\n(Lampiran tidak dikirim: ${items} butir; daftar lengkapnya ada di dokumen sumber.)\n\n`;
        s.kind = 'note';
      } else if (s.kind === 'appendix') s.kind = 'aux';
      s.size = utf8(s.model); s.taken = null;
      if (s.kind === 'issuer' && prefer.has(s.code)) { s.tier = 1; s.preferred = true; }
    }
    return {...e, segs, headOnly:!!RINGKAS[e.doc.cat] && days.has(RINGKAS[e.doc.cat] + ':' + span(e.doc).join('/'))};
  });
  const always = s => ['pre', 'head', 'note'].includes(s.kind);
  // A head-only summary still has sections the detail file lacks ("Baru muncul", "Emiten lain", "Laporan rutin",
  // "Jadwal 30 hari", "Cakupan"): only its issuer sections and their containers are left to the detail file.
  const own = (p, s) => !p.headOnly || always(s) || s.kind === 'aux';
  const full = plans.reduce((n, p) => n + p.segs.filter(s => own(p, s)).reduce((m, s) => m + s.size, 0), 0);
  const whole = full <= budget;
  let used = 0;
  if (whole) for (const p of plans) for (const s of p.segs) if (own(p, s)) { s.taken = s.model; used += s.size; }
  if (!whole) {
    // 1. Preamble and head sections of every day, each day within its share; all heads together stay within 60% of
    // the budget so that issuer sections and the listing keep room when many days are read.
    // Heads are sent whole whenever all of them fit 60% of the budget (6 days of Stockbit summaries: ~23 KB of 72 KB).
    const n = Math.max(1, plans.length);
    const heads = plans.reduce((m, p) => m + p.segs.filter(always).reduce((k, s) => k + s.size, 0), 0);
    const headCap = heads <= budget * 0.6 ? Infinity : Math.floor(budget * 0.6 / n);
    for (const p of plans) {
      let own = 0;
      for (const s of p.segs.filter(always)) {
        const room = headCap - own;
        if (s.size <= room) s.taken = s.model;
        else if (room >= 600) s.taken = cut(s.model, room, 'butir lain bagian ini tidak dikirim');
        else continue;
        own += utf8(s.taken);
      }
      used += own;
    }
    // 2. Issuer sections: reserve room for the listing, then opening paragraphs of the top tier, the top tier in full
    // (capped per section), the second tier, and the remaining appendices, each pass shared across the days.
    const open = plans.map(p => p.segs.filter(s => !always(s) && s.kind !== 'intro' && own(p, s))
      .sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0)));
    // The desk ranks a day's issuers by post volume, so the same codes (FORU, GOTO …) top every day. From the second
    // day on, a top-tier code that was among the first DEFER top-tier sections of an earlier day moves to the end of
    // the day's top tier: its earlier day was read, and that day's lower-ranked material sections are reached instead.
    const seen = new Set();
    for (const q of open) {
      const tier = q.filter(s => s.kind === 'issuer' && s.tier === 1);
      const late = tier.filter(s => !s.preferred && seen.has(s.code)), rest = q.filter(s => !tier.includes(s));
      for (const s of late) s.late = true;
      tier.slice(0, DEFER).forEach(s => seen.add(s.code));
      // Within each group, sections quoting an official disclosure come before rumour-only sections (desk order kept).
      const quoted = list => [...list.filter(s => s.preferred || QUOTE_LINE.test(s.text)), ...list.filter(s => !s.preferred && !QUOTE_LINE.test(s.text))];
      q.splice(0, q.length, ...quoted(tier.filter(s => !late.includes(s))), ...quoted(late), ...rest);
    }
    const listingSize = open.flat().reduce((n, s) => n + Math.min(160, listLine(s).length + 1), 0);
    // A rich digest lists most of what it leaves out by code only: a smaller reserve.
    const reserve = Math.min(Math.floor(budget * (rich ? 0.06 : 0.15)), listingSize);
    let left = Math.max(0, budget - used - reserve);
    const intro = s => s.parent && !s.parent.taken ? s.parent.size : 0;
    const takeIntro = s => { if (s.parent && !s.parent.taken) { s.parent.taken = s.parent.model; used += s.parent.size; } };
    const tier1 = open.map(q => q.filter(s => s.kind === 'issuer' && s.tier === 1));
    // Rich leads of codes that topped an earlier day (late) carry LATE_QUOTES finding lines.
    const first = rich ? (m, s) => richLead(m, s?.late ? LATE_QUOTES : RICH_QUOTES) : lead;
    const leadBudget = rich ? left : Math.floor(left * (exhaustive ? 0.4 : 0.55));
    const leadCost = s => utf8(first(s.model, s)) + intro(s);
    const takeLead = s => { used += intro(s); takeIntro(s); s.taken = first(s.model, s); used += utf8(s.taken); };
    const wholeCost = s => s.size + intro(s), takeWhole = s => { used += intro(s); takeIntro(s); s.taken = s.model; used += s.size; };
    const numbered = () => open.map(q => q.filter(s => s.kind === 'issuer' && s.tier === 2 && !s.taken && NUMBER.test(s.model)));
    // Rich: the leads of every day's codes that are new, then the late codes' leads (the same hot stories carry each
    // day's new filings), then the second-tier sections with a number (one line each in a Stockbit summary); only then
    // do the leads grow.
    const leadLeft = roundRobin(rich ? tier1.map(q => q.filter(s => !s.late)) : tier1, leadBudget, leadCost, takeLead);
    left -= leadBudget - leadLeft;
    if (rich) {
      left = roundRobin(tier1.map(q => q.filter(s => !s.taken)), left, leadCost, takeLead);
      left = roundRobin(numbered(), left, wholeCost, takeWhole);
    }
    const cap = Math.max(6000, Math.floor(left / Math.max(1, plans.length * 3)));
    const grown = s => rich ? richGrow(s.model, cap, s.taken) : cut(s.model, cap);
    const grow = s => utf8(grown(s)) - utf8(s.taken || '');
    left = roundRobin(tier1.map(q => q.filter(s => s.taken && s.taken !== s.model)), left, s => Math.max(0, grow(s)), s => {
      if (grow(s) > 0) { used += grow(s); s.taken = grown(s); }
    });
    // Top-tier issuers the lead pass did not reach come before the second tier and the appendices.
    left = roundRobin(tier1.map(q => q.filter(s => !s.taken)), left, leadCost, takeLead);
    left = roundRobin(open.map(q => q.filter(s => s.kind === 'issuer' && s.tier === 2 && !s.taken)), left, wholeCost, takeWhole);
    left = roundRobin(open.map(q => q.filter(s => s.kind === 'aux')), left, s => s.size, s => { s.taken = s.model; used += s.size; });
    // 3. The listing reserve was an estimate over every open section: what the remaining listing does not need goes to
    // the sections still missing, in the same order (top-tier leads, second tier, appendices).
    const missingNow = () => open.flat().filter(s => !s.taken);
    const need = () => missingNow().reduce((n, s) => n + Math.min(160, listLine(s).length + 1), 0) + 120 * plans.length;
    let spare = budget - used - need();
    if (spare > 0) spare = roundRobin(tier1.map(q => q.filter(s => !s.taken)), spare, leadCost, takeLead);
    if (rich && spare > 0) spare = roundRobin(numbered(), spare, wholeCost, takeWhole);
    if (spare > 0) spare = roundRobin(open.map(q => q.filter(s => !s.taken && s.kind === 'issuer' && s.tier === 2)), spare,
      s => s.size + intro(s), s => { used += intro(s); takeIntro(s); s.taken = s.model; used += s.size; });
    if (spare > 0) roundRobin(open.map(q => q.filter(s => !s.taken && s.kind === 'aux')), spare, s => s.size, s => { s.taken = s.model; used += s.size; });
  }
  // 4. Listing of what was not sent, within what is left of the budget, shared across the days.
  const result = new Map();
  let listLeft = Math.max(0, budget - used);
  const LISTING = 'DAFTAR BAGIAN YANG TIDAK DIKIRIM (isinya tidak dibaca; hanya judul dan kalimat awal):\n';
  plans.forEach((p, i) => {
    // The share counts the header line too, in bytes, so the listings never push the material over the budget.
    const share = Math.floor(listLeft / (plans.length - i)) - utf8(LISTING);
    const missing = p.segs.filter(s => !s.taken && s.kind !== 'intro' && own(p, s));
    const issuers = p.segs.filter(s => s.kind === 'issuer'), partial = issuers.filter(s => s.taken && s.taken !== s.model);
    let listing = '';
    // Issuer sections named in the listing (a line or a code); the rest are only counted.
    let named = 0;
    if (missing.length) {
      const lines = [];
      let n = 0;
      for (const s of missing) {
        const line = listLine(s) + '\n';
        if (n + utf8(line) > share * 0.8) break;
        lines.push(line); n += utf8(line);
        if (s.kind === 'issuer') named++;
      }
      const rest = missing.slice(lines.length);
      let tail = '';
      if (rest.length) {
        const shown = [...rest.filter(s => s.code), ...rest.filter(s => !s.code)];
        tail = `- dan ${rest.length} bagian lain`;
        let list = '', k = 0;
        for (const s of shown) {
          const c = s.code || s.heading;
          if (n + utf8(tail) + utf8(list) + utf8(c) + 40 > share) break;
          list += (list ? ', ' : '') + c; k++;
          if (s.kind === 'issuer') named++;
        }
        const more = shown.length - k;
        tail += list ? `: ${list}${more ? `, dan ${more} lainnya` : ''}` : '';
        tail += '\n';
      }
      listing = LISTING + lines.join('') + tail;
      listLeft -= utf8(listing);
    }
    const sent = p.segs.filter(s => s.taken);
    const pieces = sent.map(s => ({text:s.taken, line:s.line, heading:s.heading}));
    if (listing) pieces.push({text:listing, line:null, heading:'Daftar bagian tidak dikirim'});
    const listed = missing.filter(s => s.kind === 'issuer').length, counted = listed - named;
    const others = missing.filter(s => s.kind !== 'issuer').map(s => s.heading);
    const otherNote = others.length ? ' Bagian lain yang tidak dikirim (hanya tercantum di daftar): ' + others.join('; ') + '.' : '';
    let coverage = null;
    if (p.headOnly) {
      const sentAux = p.segs.filter(s => s.kind === 'aux' && s.taken).map(s => s.heading);
      coverage = 'Bagian per emiten dibaca dari dokumen detail tanggal yang sama; dari dokumen ini dikirim bagian pembuka dan sorotan'
        + (sentAux.length ? ', serta ' + sentAux.join('; ') : '') + '.' + otherNote;
    } else if (!whole || listing || partial.length) {
      const full = issuers.filter(s => s.taken === s.model).length;
      coverage = `Dipadatkan sistem: bagian pembuka (dan sorotan bila ada) dikirim; dari ${issuers.length} bagian emiten, ${full} utuh, `
        + `${partial.length} hanya bagian awal, ${named} hanya tercantum di DAFTAR BAGIAN YANG TIDAK DIKIRIM`
        + (counted ? `, ${counted} hanya dihitung di daftar itu (tanpa judul)` : '') + '.' + otherNote;
    }
    result.set(p.doc, {whole:whole && !p.headOnly, headOnly:p.headOnly, pieces, coverage,
      codes:issuers.filter(s => s.taken).map(s => s.code), sent:pieces.reduce((n, x) => n + utf8(x.text), 0),
      stats:{issuers:issuers.length, full:issuers.filter(s => s.taken === s.model).length, partial:partial.length, listed}});
  });
  return result;
}
// ---- Retired manual KI analyses next to a BEI daily summary or weekly recap -----------------------------------------
// A KI file is named for the day its digest ran and mostly covers the evening before, with its own analysis on top
// (backdoor chains, buyer identity) that the BEI files do not have. Read next to BEI, it is sent as a code-built head:
// everything before the first issuer heading (title, coverage, conclusions, the "Update terbaru" table) and then one
// line per remaining heading (KI headings are one-line conclusions: "2.1 SMKM — aset telah berpindah …"), within
// KI_HEAD_BUDGET bytes. Every sent character is source text (model copy) or a marked system note.
export const KI_HEAD_BUDGET = 14000;
const KI_LINES = 6000;
export function kiHead(rows, tickers) {
  const lines = deskText(rows.map(r => r.content).join('')).split(/(?<=\n)/);
  const heading = l => l.match(/^(#{1,3})\s+(.+?)\s*$/);
  let first = lines.findIndex(l => { const m = heading(l); return m && codeOf(m[2], tickers); });
  if (first < 0) first = lines.length;
  const items = [];
  for (const l of lines.slice(first)) {
    const m = heading(l);
    if (!m) continue;
    const text = m[2].replace(/\s+/g, ' ');
    items.push((m[1].length < 3 ? '\n## ' : '- ') + text + '\n');
  }
  let list = '', n = 0;
  for (const item of items) { if (utf8(list + item) > KI_LINES) break; list += item; n++; }
  const rest = items.length - n;
  list = list.replace(/^\n/, '') + (rest ? `- (… ${rest} judul lain tidak dikirim)\n` : '');
  const tail = items.length ? '\n\nJUDUL PEMBAHASAN LAIN DALAM ANALISIS INI (isinya tidak dikirim; judul ditulis penyusun KI):\n' + list : '';
  const head = cut(lines.slice(0, first).join(''), KI_HEAD_BUDGET - utf8(tail), 'sisa bagian pembuka tidak dikirim');
  const pieces = [{text:head, line:1, heading:''}];
  if (tail) pieces.push({text:tail, line:null, heading:'Judul pembahasan lain'});
  return {whole:false, pieces, codes:[],
    coverage:'Analisis KI lama dipadatkan sistem: bagian pembuka, tabel update dan judul tiap pembahasan dikirim; rincian per emiten tidak dikirim. Isinya analisis penyusun KI atas pengumuman pada tanggal yang dicakupnya.',
    sent:pieces.reduce((k, x) => k + utf8(x.text), 0)};
}
// Units of a digest: parts of up to PART_LENGTH characters that start at a section (a longer section continues with its
// heading as context). `checked` is the full original text (number check); `digest` keeps the unit out of the notes path.
export function digestUnits(doc, digest, original) {
  const parts = [];
  for (const piece of digest.pieces) {
    for (let start = 0, n = 0; start < piece.text.length; n++) {
      let end = Math.min(start + PART_LENGTH, piece.text.length);
      if (end < piece.text.length && /[\uD800-\uDBFF]/.test(piece.text[end - 1])) end--;
      parts.push({source_id:'D1', ...(piece.line ? {source_line:piece.line} : {}), ...(n ? {context:piece.heading} : {}), text:piece.text.slice(start, end)});
      start = end;
    }
  }
  // Consecutive small parts are merged so the JSON envelope is not repeated per section.
  const merged = [];
  for (const p of parts) {
    const last = merged.at(-1);
    if (last && !p.context && last.text.length + p.text.length <= PART_LENGTH) last.text += p.text;
    else merged.push({...p});
  }
  const units = []; let current = [], size = 2;
  for (const p of merged) {
    const n = bytes(p) + 1;
    if (current.length && size + n > UNIT_LIMIT) { units.push(current); current = []; size = 2; }
    current.push(p); size += n;
  }
  if (current.length) units.push(current);
  return units.map((parts, i) => ({doc, parts, digest:true, checked:i ? '' : original, ...(i || !digest.coverage ? {} : {coverage:digest.coverage})}));
}
