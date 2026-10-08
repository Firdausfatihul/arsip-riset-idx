// Stockbit summaries in chat: byte budget for ticker/handle sections and code-built lines from
// stockbit.json (tools/build_worker.py). Nothing here calls a model; every line is written by code.

// Ticker sections of stockbit-ringkasan/detail read whole per question, newest day first.
export const STOCKBIT_TICKER_BUDGET = 90000;
export const PENILAIAN_LABEL = 'Penilaian otomatis atas argumen di posting, bukan atas orangnya';
const DAY_LINES = 30;

const cell = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, n = 220) => { const t = cell(text); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const angka = n => Number.isFinite(+n) ? (+n).toLocaleString('id-ID') : '?';

// entries: [{doc, bytes}] for stockbit-ringkasan/detail docs whose sections matched the question.
// Per day the summary section comes first (the detail section if there is no summary). Days are
// taken newest first until the budget is full; the newest day is always read. Detail sections are
// added afterwards for days already read, while they still fit.
export function stockbitBudget(entries, budget = STOCKBIT_TICKER_BUDGET) {
  const byDay = new Map();
  for (const e of entries) {
    const day = byDay.get(e.doc.end) || {summary:[], detail:[]};
    day[e.doc.cat === 'stockbit-detail' ? 'detail' : 'summary'].push(e);
    byDay.set(e.doc.end, day);
  }
  const days = [...byDay.keys()].sort().reverse(), keep = new Set(), read = [], listed = [];
  let used = 0, full = false;
  for (const day of days) {
    const d = byDay.get(day), primary = d.summary.length ? d.summary : d.detail;
    const bytes = primary.reduce((n, e) => n + e.bytes, 0);
    if (!full && (!read.length || used + bytes <= budget)) {
      used += bytes; read.push(day); for (const e of primary) keep.add(e.doc);
    } else {
      full = true; listed.push({day, doc:primary[0].doc});
    }
  }
  for (const day of read) {
    const d = byDay.get(day);
    if (!d.summary.length) continue;
    for (const e of d.detail) if (used + e.bytes <= budget) { used += e.bytes; keep.add(e.doc); }
  }
  const dropped = new Set(entries.map(e => e.doc).filter(doc => !keep.has(doc)));
  return {read, listed, dropped, used};
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
        + (row[5] ? ' · inti (diskusi pengguna, belum diverifikasi): ' + clip(row[5]) : ''));
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
  const head = `**${listed.length} hari lain (tidak dibaca utuh)**`;
  const note = 'Disusun sistem dari indeks Stockbit tanpa AI; buka dokumennya untuk rincian. Isi adalah klaim pengguna yang belum diverifikasi.';
  const text = head + '\n\n' + note + '\n\n' + lines.join('\n');
  return {material:'INDEKS STOCKBIT, ' + listed.length + ' hari lain (tidak dibaca utuh; satu baris per hari dari indeks, bukan isi dokumen):\n' + lines.join('\n'),
    tail:text, lines:lines.length};
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
