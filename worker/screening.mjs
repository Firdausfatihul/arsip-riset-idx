// Answers that need counting or listing across many issuers. Lists and totals are built by code
// from the archive; the model only summarises. Nothing here calls a model directly.

const KIND_LABEL = {digest:'digest keterbukaan', ki:'analisis keterbukaan', stockbit:'diskusi Stockbit', other:'arsip lain'};
const OFFICIAL = new Set(['digest', 'ki']);
const TABLE_ROWS = 80, ITEMS = 4, EXCERPT = 170;
const monthNames = 'Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember';

const cell = text => String(text).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const excerpt = text => { const t = cell(text); return t.length > EXCERPT ? t.slice(0, EXCERPT - 1) + '…' : t; };

// Corporate-action types named by the question (or by the search terms chosen for it).
export function questionTypes(question, terms, types) {
  return types.filter(t => {
    const doc = new RegExp(t.pattern, 'iu');
    return doc.test(question) || terms.some(term => doc.test(term)) ||
      (t.ask && new RegExp(t.ask, 'iu').test(question)) || (t.abbr && new RegExp(t.abbr, 'u').test(question));
  });
}

// Groups table events by issuer: official sources first, newest first, duplicates removed.
export function screeningGroups(events, typeIds, scope) {
  const wanted = new Set(typeIds), byTicker = new Map();
  for (const e of events) {
    if (!wanted.has(e.type)) continue;
    if (scope?.date && scope.filter && !(e.start <= scope.date && scope.date <= e.end)) continue;
    const g = byTicker.get(e.ticker) || {ticker:e.ticker, types:new Set(), kinds:new Set(), last:'', items:[]};
    g.types.add(e.type); g.kinds.add(e.kind); if (e.end > g.last) g.last = e.end;
    if (!g.items.some(i => i.text === e.text)) g.items.push(e);
    byTicker.set(e.ticker, g);
  }
  const rank = e => (OFFICIAL.has(e.kind) ? 0 : 1);
  const groups = [...byTicker.values()];
  for (const g of groups) g.items.sort((a, b) => rank(a) - rank(b) || b.end.localeCompare(a.end));
  groups.sort((a, b) => (a.kinds.has('digest') || a.kinds.has('ki') ? 0 : 1) - (b.kinds.has('digest') || b.kinds.has('ki') ? 0 : 1)
    || b.last.localeCompare(a.last) || a.ticker.localeCompare(b.ticker));
  return groups;
}

export function screeningCounts(groups) {
  const official = groups.filter(g => [...g.kinds].some(k => OFFICIAL.has(k))).length;
  return {issuers:groups.length, official, discussionOnly:groups.length - official};
}

// Compact evidence for the model; items per issuer shrink until it fits the byte budget.
export function screeningMaterial(groups, labels, budget, names = {}) {
  for (const items of [ITEMS, 2, 1]) {
    const text = groups.map(g => g.ticker + (names[g.ticker] ? ' (' + names[g.ticker] + ')' : ' (nama tidak tercantum)') + ' — ' + [...g.types].map(t => labels[t]).join(', ') + ' — terakhir ' + g.last + '\n'
      + g.items.slice(0, items).map(i => `  - [${i.source_id}] ${i.end} · ${KIND_LABEL[i.kind] || i.kind} · baris ${i.line}: ${i.text}`).join('\n')).join('\n');
    if (new TextEncoder().encode(text).length <= budget) return text;
  }
  return null;
}

// Complete list rendered by code, so no issuer is dropped or miscounted by the model.
export function screeningTable(groups, labels, names = {}) {
  const rows = groups.slice(0, TABLE_ROWS).map(g => {
    const best = g.items[0];
    return `| ${g.ticker}${names[g.ticker] ? ' · ' + cell(names[g.ticker]) : ''} | ${[...g.types].map(t => labels[t]).join(', ')} | ${[...g.kinds].map(k => KIND_LABEL[k] || k).join(', ')} | ${g.last} | ${excerpt(best.text)} [${best.source_id}] |`;
  });
  const rest = groups.slice(TABLE_ROWS).map(g => g.ticker);
  return '| Emiten | Jenis | Sumber | Terakhir | Bukti terbaru |\n|---|---|---|---|---|\n' + rows.join('\n')
    + (rest.length ? `\n\n${rest.length} emiten lain (bukti di dokumen yang sama): ${rest.join(', ')}.` : '');
}

// Without a matching action type: which issuers mention the topic, from word matching only.
export function overviewTable(docRows, tickers) {
  const byTicker = new Map();
  for (const {doc, rows} of docRows) for (const row of rows) {
    const head = (row.context || '').split('\n')[0].match(/\b([A-Z0-9]{4})\b/) || row.content.match(/^\s*#{1,6}\s+(?:\d+(?:\.\d+)*\.?\s+)?([A-Z0-9]{4})\b/);
    const code = head && tickers.has(head[1]) ? head[1] : row.tickers?.length === 1 ? row.tickers[0] : null;
    if (!code) continue;
    const g = byTicker.get(code) || {ticker:code, docs:new Map()};
    g.docs.set(doc.source_id, doc);
    byTicker.set(code, g);
  }
  const groups = [...byTicker.values()].map(g => ({...g, last:[...g.docs.values()].reduce((m, d) => d.end > m ? d.end : m, '')}))
    .sort((a, b) => b.docs.size - a.docs.size || b.last.localeCompare(a.last) || a.ticker.localeCompare(b.ticker));
  const rows = groups.slice(0, TABLE_ROWS).map(g => `| ${g.ticker} | ${g.docs.size} | ${g.last} | ${[...g.docs.keys()].slice(0, 3).map(id => '[' + id + ']').join(' ')} |`);
  const rest = groups.slice(TABLE_ROWS).map(g => g.ticker);
  return {count:groups.length, table:'| Emiten | Dokumen | Terakhir | Sumber |\n|---|---|---|---|\n' + rows.join('\n')
    + (rest.length ? `\n\n${rest.length} emiten lain: ${rest.join(', ')}.` : '')};
}

// Counts the model tends to get wrong, computed from the requested documents.
export function documentFacts(doc, records, tickers) {
  const sections = [], dated = new Map();
  for (const r of records) {
    const head = r.content.match(/^\s*#{1,6}\s+(?:\d+(?:\.\d+)*\.?\s+)?([A-Z0-9]{4})\b/);
    if (head && tickers.has(head[1]) && !sections.includes(head[1])) sections.push(head[1]);
    for (const line of r.content.split('\n')) {
      const m = line.match(new RegExp('^\\|\\s*\\**\\s*(\\d{1,2} (?:' + monthNames + ')|20\\d\\d-\\d\\d-\\d\\d)', 'i'));
      if (!m) continue;
      const code = (line.match(/\b[A-Z0-9]{4}\b/g) || []).find(c => tickers.has(c));
      const d = dated.get(m[1]) || {rows:0, codes:new Set()};
      d.rows++; if (code) d.codes.add(code); dated.set(m[1], d);
    }
  }
  const parts = [];
  if (sections.length) parts.push(`${sections.length} bagian berjudul kode emiten (${sections.join(', ')})`);
  for (const [date, d] of dated) parts.push(`${d.rows} baris tabel bertanggal ${date}, ${d.codes.size} emiten berbeda (${[...d.codes].join(', ')})`);
  return parts.length ? `[${doc.source_id}] ${doc.label}: ` + parts.join('; ') : '';
}

// Numbers in the answer that the material does not support. Values are compared, not digits:
// "Rp372,6 miliar" is supported by "Rp372.605.750.000". Counts ("18 emiten") must appear as written
// or as a table cell ("| 18 |"); a total the model counted itself is exactly what this should catch.
const COUNT = /\b(\d{1,4})[ \t]+(emiten|perusahaan|pengumuman|kasus|dokumen|postingan|transaksi|entri|baris)\b/gi;
const NUMBER = /(?:(~|±|>|<|≥|≤|sekitar|hampir|lebih dari|kurang dari)\s*)?(?:Rp|USD|US\$)?\s?(\d[\d.,]*\d|\d)(\s?%|\s*(?:ribu|juta|miliar|milyar|triliun|thousand|million|billion|trillion|tn|bn|mn|jt|rb|t|b|m|k)\b)?/gi;
// Sources mix Indonesian words and English abbreviations ("Rp20,817tn", "215,096bn", "465,224m");
// a single letter is ambiguous (M = miliar or million), so every reading is tried.
const SCALE = {ribu:[1e3], juta:[1e6], miliar:[1e9], milyar:[1e9], triliun:[1e12], thousand:[1e3], million:[1e6], billion:[1e9],
  trillion:[1e12], tn:[1e12], bn:[1e9], mn:[1e6], jt:[1e6], rb:[1e3], t:[1e12, 1], b:[1e9, 1], m:[1e9, 1e6, 1], k:[1e3, 1]};
const scales = unit => SCALE[unit] || [1];
// Indonesian and English separators both occur; each reading is a candidate value.
function readings(raw) {
  const out = new Set(), plain = raw.replace(/[.,]/g, '');
  out.add(Number(plain));
  if (/,/.test(raw) && !/,\d{3}(?!\d)/.test(raw.slice(raw.lastIndexOf(',')))) out.add(Number(raw.replace(/\./g, '').replace(',', '.')));
  if (/,\d+$/.test(raw)) out.add(Number(raw.replace(/\./g, '').replace(/,(?=\d+$)/, '.')));
  if (/\.\d+$/.test(raw) && !/,/.test(raw)) out.add(Number(raw.replace(/,/g, '')));
  return [...out].filter(Number.isFinite);
}
const decimals = raw => { const m = raw.match(/[.,](\d{1,2})$/); return m && !/^\d{1,3}([.,]\d{3})+$/.test(raw) ? m[1].length : 0; };
function values(text) {
  const list = [];
  for (const m of text.matchAll(NUMBER)) {
    const unit = (m[3] || '').trim().toLowerCase();
    for (const v of readings(m[2])) { list.push(v); for (const scale of scales(unit)) list.push(v * scale); }
  }
  return list.sort((a, b) => a - b);
}
function supported(sorted, value, tolerance) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < value - tolerance) lo = mid + 1; else hi = mid; }
  return lo < sorted.length && sorted[lo] <= value + tolerance;
}
export function unverifiedNumbers(answer, material, question = '') {
  const text = answer.replace(/\[D[^\]]*\]/g, ' ').replace(/[*_`]/g, '');
  const sourceText = (material + '\n' + question).replace(/[*_`]/g, '');
  const source = sourceText.replace(/\s+/g, ' ').toLowerCase(), known = values(sourceText);
  const found = new Set();
  for (const m of text.matchAll(COUNT)) {
    if (/^20\d\d$/.test(m[1])) continue;
    if (source.includes((m[1] + ' ' + m[2]).toLowerCase()) || new RegExp('\\|\\s*' + m[1] + '\\s*\\|').test(sourceText)) continue;
    // A table value next to the issuer it describes ("GTSI 124 98", "<td>GTSI</td><td>124</td>").
    const codes = text.slice(Math.max(0, m.index - 200), m.index).match(/\b[A-Z][A-Z0-9]{3}\b/g) || [];
    if (codes.some(c => new RegExp('\\b' + c + '\\b[^\\n]{0,80}?(?<![\\d.,])' + m[1] + '(?![\\d.,])').test(sourceText))) continue;
    found.add(m[0].trim());
  }
  for (const m of text.matchAll(NUMBER)) {
    const raw = m[2], unit = (m[3] || '').trim().toLowerCase();
    // Plain small integers and years are dates, ordinals or list numbers, not checkable amounts.
    if ((!unit || unit.length === 1) && !/[.,]/.test(raw) && !/^(Rp|USD|US\$)/i.test(m[0].replace(/^[^R U]*/, '').trim())) continue;
    if (!unit && /^(19|20)\d\d$/.test(raw)) continue;
    const approx = !!m[1];
    const ok = readings(raw).some(v => scales(unit).some(scale => {
      const value = v * scale, step = Math.pow(10, -decimals(raw)) * scale;
      // One unit of the last shown digit: models truncate as often as they round (62.376.682.265 -> 62,37 miliar).
      return supported(known, value, approx ? Math.max(step, Math.abs(value) * 0.05) : step + 1e-9 * Math.max(1, value));
    }));
    if (!ok) found.add(m[0].trim());
  }
  return [...found].slice(0, 8);
}

// Issuer names the answer attaches to a code ("BAJA (Barata Indonesia)") that differ from the name
// the archive gives ("PT Saranacentral Bajatama Tbk"). Parentheses only count as a name when they
// read like one (PT/Tbk, or two or more capitalised words), not a description ("VICI (Akuisisi …)").
const nameWords = s => s.toLowerCase().replace(/\bpt\b|\btbk\b|[^a-z0-9& ]/g, ' ').split(/\s+/).filter(Boolean);
const looksLikeName = s => /\bPT\b|\bTbk\b/.test(s) || /^(\p{Lu}[\p{L}\d&.'’-]*\s+){1,}\p{Lu}[\p{L}\d&.'’-]*$/u.test(s.trim());
function sameName(written, official) {
  const a = nameWords(written), b = nameWords(official);
  if (!a.length) return true;
  const joinedA = a.join(''), joinedB = b.join('');
  if (joinedB.includes(joinedA) || joinedA.includes(joinedB)) return true;
  const shared = a.filter(w => b.includes(w)).length;
  return shared / new Set([...a, ...b]).size >= 0.6; // word order may differ ("IMC Pelita" / "Pelita IMC")
}
export function wrongNames(answer, names, aliases = {}, plainWords = []) {
  const found = new Map(), plain = new Set(plainWords);
  const check = (code, name) => {
    if (!names[code] || !looksLikeName(name) || found.has(code)) return;
    if (!/\bPT\b|\bTbk\b/.test(name) && nameWords(name).every(w => plain.has(w))) return; // a description
    if ((aliases[code] || [names[code]]).some(official => sameName(name.replace(/\s+Tbk\.?$/, ''), official))) return;
    found.set(code, {code, written:name.trim(), official:names[code]});
  };
  for (const m of answer.matchAll(/(PT\.?\s+\p{Lu}[\p{L}\d&.,'’\- ]{1,70}?\s+Tbk\.?)\s*\(\**([A-Z0-9]{4})\**\)/gu)) check(m[2], m[1]);
  for (const m of answer.matchAll(/\**\b([A-Z0-9]{4})\b\**\s*\(([^()\n]{3,70})\)/g)) check(m[1], m[2]);
  return [...found.values()].slice(0, 8);
}
export const nameNotice = list => 'Pemeriksaan nama otomatis: ' + list.map(n => `${n.code} ditulis “${n.written}”, di arsip ${n.official}`).join('; ')
  + '. Pakai nama menurut arsip.';
