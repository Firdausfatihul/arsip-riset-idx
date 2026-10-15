// Stockbit summaries in chat: byte budget for ticker/handle sections and code-built lines from
// stockbit.json (tools/build_worker.py). The same budget serves BEI daily files and legacy reports
// for ticker questions. Nothing here calls a model; every line is written by code.
import {headingTicker, modelText} from './retrieval.mjs';
import {clip, oneLine} from './text.mjs';

// Ticker sections of stockbit-ringkasan/detail read whole per question, newest day first.
export const STOCKBIT_TICKER_BUDGET = 90000;
// Ticker questions only, bytes of the model copy. BEI on the 13 Oct corpus (40 production questions): 1–64 KB per
// ticker (TOWR 37 KB over 11 days, SOCI 38 KB/7, FORU 64 KB/18), so 70 KB reads every day today and caps the
// growth of one more file a day; older days are listed. Legacy raw Stockbit/KI (superseded by the daily
// summaries): up to 48 KB except FORU (20 docs, 195 KB whole): the ticker's own sections of every document come
// before the rest of any document (docBudget); 60 KB reads the FORU rows of 16 of its 20 documents (50 KB still cut
// the HTML review with FORU's 49% economic share; whole documents newest first read only 3). With Stockbit's 90 KB the three
// families total about 220 KB, under RAW_LIMIT (core.mjs): one answer call, no notes pass.
export const BEI_TICKER_BUDGET = 70000;
export const LEGACY_TICKER_BUDGET = 60000;
export const PENILAIAN_LABEL = 'Penilaian otomatis atas argumen di posting, bukan atas orangnya';
const DAY_LINES = 30;

const angka = n => Number.isFinite(+n) ? (+n).toLocaleString('id-ID') : '?';

// entries: [{doc, bytes, covered?}] for one family's daily summary/detail docs whose sections matched the
// question (Stockbit: stockbit-ringkasan/detail; BEI: bei-ringkasan/detail). bytes count the model copy
// actually sent. Per day the summary section comes first (the detail section if there is no summary).
// Days are taken newest first until the budget is full; the newest day is always read. Detail sections
// are added afterwards for days already read, while they still fit; a summary's `covered` bytes (the
// ticker's own summary section, a subset of the same day's detail section) are then not sent again.
export function familyBudget(entries, budget, detailCat) {
  const byDay = new Map(), sum = list => list.reduce((n, e) => n + e.bytes, 0);
  for (const e of entries) {
    const day = byDay.get(e.doc.end) || {summary:[], detail:[]};
    day[e.doc.cat === detailCat ? 'detail' : 'summary'].push(e);
    byDay.set(e.doc.end, day);
  }
  const days = [...byDay.keys()].sort().reverse(), keep = new Set(), trimmed = new Set(), read = [], listed = [];
  let used = 0, full = false;
  for (const day of days) {
    const d = byDay.get(day), primary = d.summary.length ? d.summary : d.detail;
    const bytes = sum(primary);
    if (!full && (!read.length || used + bytes <= budget)) {
      used += bytes; read.push(day); for (const e of primary) keep.add(e.doc);
    } else {
      full = true; listed.push({day, doc:primary[0].doc, docs:[...d.summary, ...d.detail].map(e => e.doc)});
    }
  }
  for (const day of read) {
    const d = byDay.get(day);
    if (!d.summary.length || !d.detail.length) continue;
    const saved = d.summary.reduce((n, e) => n + Math.min(e.covered || 0, e.bytes), 0);
    if (used + sum(d.detail) - saved > budget) continue;
    used += sum(d.detail) - saved;
    for (const e of d.detail) keep.add(e.doc);
    for (const e of d.summary) if (e.covered) trimmed.add(e.doc);
  }
  const dropped = new Set(entries.map(e => e.doc).filter(doc => !keep.has(doc)));
  return {read, listed, dropped, trimmed, used};
}
// Retired raw Stockbit reports and manual KI analyses (no daily index). entries: [{doc, bytes, core?, own?}]: core
// counts the rows about the ticker (its own section, else the rows naming it), own marks a document with an own
// section. Pass 1 reads the core of every document that fits, documents with an own section first, each group newest
// first (the newest document is always read); a document that does not fit is listed and the next one is tried.
// Pass 2 adds the rest of each read document (neighbouring prose, other tickers), newest first, while it fits;
// a document whose rest does not fit is `trimmed` to its core. Without `core` a document is read whole or listed.
export function docBudget(entries, budget = LEGACY_TICKER_BUDGET) {
  const byDate = [...entries].sort((a, b) => b.doc.end.localeCompare(a.doc.end) || a.doc.name.localeCompare(b.doc.name));
  const order = [byDate[0], ...byDate.slice(1).filter(e => e.own), ...byDate.slice(1).filter(e => !e.own)].filter(Boolean);
  const core = e => Math.min(e.core ?? e.bytes, e.bytes), read = new Set(), trimmed = new Set();
  let used = 0;
  for (const e of order) if (!read.size || used + core(e) <= budget) { used += core(e); read.add(e); }
  for (const e of byDate) {
    if (!read.has(e) || core(e) >= e.bytes) continue;
    if (used + e.bytes - core(e) <= budget) used += e.bytes - core(e); else trimmed.add(e.doc);
  }
  const listed = byDate.filter(e => !read.has(e));
  return {read:byDate.filter(e => read.has(e)).map(e => e.doc), listed, dropped:new Set(listed.map(e => e.doc)), trimmed, used};
}

const ref = doc => doc ? ' [' + doc.source_id + ']' : '';

// One line per day not read whole: date, posts, accounts, findings, inti (from stockbit.json), doc ref.
export function stockbitListing(listed, tickers, handles, table) {
  if (!listed.length) return null;
  const lines = listed.map(({day, doc}) => {
    const parts = [];
    for (const code of tickers) {
      const row = table?.tickers?.[code]?.find(r => r[0] === day);
      if (row) parts.push(`${code} ${angka(row[2])} posting / ${angka(row[3])} akun · ${angka(row[4])} temuan`
        + (row[5] ? ' · inti (diskusi pengguna, belum diverifikasi): ' + clip(modelText(row[5]), 220) : ''));
    }
    for (const handle of handles) {
      const row = table?.users?.[handle]?.find(r => r[0] === day);
      if (row) parts.push(`@${handle} ${angka(row[2])} posting · ${(row[3] || []).join(', ') || 'tanpa emiten'} · ${(row[4] || []).length} temuan`);
    }
    if (!parts.length) {
      const info = table?.days?.[day];
      parts.push(info ? `${angka(info.n)} posting hari itu · ${angka(info.findings)} temuan` : clip(doc.title, 120));
    }
    return `- ${day} · ${parts.join(' · ')}${ref(doc)}`;
  });
  return listingText('INDEKS STOCKBIT', 'hari lain', lines,
    'Disusun sistem dari indeks Stockbit tanpa AI; buka dokumennya untuk rincian. Isi adalah klaim pengguna yang belum diverifikasi.',
    'satu baris per hari dari indeks, bukan isi dokumen');
}

// One code-built line for a day or document that is listed, not read. Daily files: the ticker's own section's
// first line (BEI "Status: …", Stockbit "KODE · n posting …"). mention: the first line naming the ticker (own
// section first), for free-form legacy reports whose sections open with source notes.
export function sectionLine(rows, codes, {mention = false} = {}) {
  const re = codes.map(c => new RegExp('(?<![\\p{L}\\p{N}_])' + c + '(?![\\p{L}\\p{N}_])', 'u'));
  const own = rows.filter(r => r.kind === 'issuer_section' && codes.includes(headingTicker(r.content)));
  const clean = text => text.split('\n').map(l => oneLine(modelText(l).replace(/<[^>]+>/g, ' ').replace(/^\s*(?:[-*+>]|\|)\s*/, '').replace(/[*`]/g, '')))
    .filter(l => l && !/^#{1,6}\s/.test(l));
  const ownLines = own.flatMap(r => clean(r.content.replace(/^[^\n]*\n?/, '')));
  const named = [...ownLines, ...rows.filter(r => !own.includes(r)).flatMap(r => clean(r.content))].filter(l => re.some(r => r.test(l)));
  const line = mention ? named[0] || ownLines[0] : ownLines[0] || named[0];
  return line ? clip(line, 200) : '';
}
// Days/documents listed, not read: `material` for the model, `tail` shown under the answer.
// `how` says what each line is; by default a line written by code from the document text.
function listingText(kind, label, lines, note, how) {
  const unit = label.split(' ')[0];
  how ||= `satu baris per ${unit} disusun sistem dari teks dokumen, bukan isi lengkap. Bila relevan, sebutkan bahwa ${unit} ini hanya terdaftar, bukan dibaca`;
  return {material:`${kind}, ${lines.length} ${label} (tidak dibaca utuh; ${how}):\n` + lines.join('\n'),
    tail:`**${lines.length} ${label} (tidak dibaca utuh)**\n\n${note}\n\n` + lines.join('\n'), lines:lines.length};
}
// BEI days over the budget: listed: [{day, docs}] from familyBudget; rowsOf(doc) gives that doc's selected rows.
export function beiListing(listed, codes, rowsOf) {
  if (!listed.length) return null;
  const lines = listed.map(({day, doc, docs}) => {
    const text = (docs || [doc]).map(d => sectionLine(rowsOf(d) || [], codes)).find(Boolean);
    return `- ${day} · ${codes.join(', ') || 'pengumuman'}${text ? ': ' + text : ''}${ref(doc)}`;
  });
  return listingText('INDEKS BEI', 'hari keterbukaan BEI lain', lines,
    'Disusun sistem dari ringkasan BEI tanpa AI; buka dokumennya untuk rincian.');
}
// Legacy documents over the budget: listed: [{doc}] from docBudget.
export function legacyListing(listed, codes, rowsOf) {
  if (!listed.length) return null;
  const lines = listed.map(({doc}) => {
    const text = sectionLine(rowsOf(doc) || [], codes, {mention:true});
    return `- ${doc.label} · ${clip(doc.title, 90)}${text ? ' · ' + text : ''}${ref(doc)}`;
  });
  return listingText('ARSIP LAMA', 'dokumen lama lain', lines,
    'Laporan Stockbit mentah dan analisis KI lama, disusun sistem tanpa AI; buka dokumennya untuk rincian.');
}

// @handles named in the question that stockbit.json knows. A bare word counts only when the
// archive treats it as a username (manifest.handles), so "media" or "saham" never match.
export function stockbitHandles(question, table, knownHandles = new Set()) {
  if (!table?.users) return [];
  const found = [];
  for (const m of question.matchAll(/(^|[^\p{L}\p{N}_@])(@?)([A-Za-z][A-Za-z0-9_]{3,29})(?![\p{L}\p{N}_])/gu)) {
    const handle = m[3].toLowerCase();
    if (!Object.hasOwn(table.users, handle) || found.includes(handle)) continue;
    if (m[2] === '@' || knownHandles.has(handle)) found.push(handle);
  }
  return found.slice(0, 4);
}

const docByFile = (docs, file) => file ? docs.find(d => d.name === file) : null;
export function stockbitHandleDocs(handles, table, docs = []) {
  return [...new Set(handles.flatMap(h => (table?.users?.[h] || []).slice(-DAY_LINES).map(r => docByFile(docs, r[1])).filter(Boolean)))];
}
const windowText = w => !w ? '' : typeof w === 'string' ? w
  : [w.from || w.start || w[0], w.to || w.end || w[1]].filter(Boolean).join(' s.d. ');

// Factual block for one handle, read before any document section.
export function stockbitHandleBlock(handle, table, docs = []) {
  const rows = table?.users?.[handle];
  if (!rows?.length) return '';
  const posts = rows.reduce((n, r) => n + (+r[2] || 0), 0);
  const findings = new Set(rows.flatMap(r => (r[4] || []).map(id => r[0] + ':' + id)));
  const tickers = {};
  for (const r of rows) for (const code of r[3] || []) tickers[code] = (tickers[code] || 0) + 1;
  const topTickers = Object.entries(tickers).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 25);
  const recent = rows.slice(-DAY_LINES).reverse();
  const lines = [`DATA STOCKBIT @${handle} (dihitung sistem dari indeks Stockbit, tanpa AI; hanya posting dengan temuan publik):`,
    `- ${rows.length} hari aktif (${rows[0][0]} s.d. ${rows.at(-1)[0]}), ${angka(posts)} posting, ${findings.size} temuan publik.`,
    `- Saham dibahas: ${topTickers.map(([c, n]) => `${c} (${n} hari)`).join(', ') || 'tidak ada'}.`,
    ...recent.map(r => `- ${r[0]} · ${angka(r[2])} posting · ${(r[3] || []).join(', ') || 'tanpa emiten'}`
      + ((r[4] || []).length ? ' · temuan ' + r[4].join(', ') : '') + ref(docByFile(docs, r[1])))];
  if (rows.length > DAY_LINES) lines.push(`- ${rows.length - DAY_LINES} hari lebih lama tidak dirinci.`);
  const note = table.user_notes?.[handle]?.penilaian;
  if (note?.text) lines.push(`- ${PENILAIAN_LABEL}: ${clip(note.text, 400)}`
    + ((note.finding_ids || []).length ? ` (temuan ${note.finding_ids.join(', ')})` : '')
    + (windowText(table.user_notes[handle].window) ? ` · jendela ${windowText(table.user_notes[handle].window)}` : ''));
  lines.push('Isi Stockbit adalah klaim pengguna yang belum diverifikasi; balasan tidak dikumpulkan.');
  return lines.join('\n');
}

// The automatic assessment is shown with its label exactly, below the model's answer.
export function stockbitPenilaianTail(handles, table) {
  const lines = handles.map(h => {
    const note = table?.user_notes?.[h]?.penilaian;
    return note?.text ? `- @${h}: ${clip(note.text, 400)}` + ((note.finding_ids || []).length ? ` (temuan ${note.finding_ids.join(', ')})` : '') : '';
  }).filter(Boolean);
  return lines.length ? `**${PENILAIAN_LABEL}**\n\n${lines.join('\n')}` : '';
}
