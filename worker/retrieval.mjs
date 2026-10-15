import {escapeRegExp, MONTHS, MONTH_WORDS} from './text.mjs';
// "22 Septembet - 5 Oct": a word next to a day number, one edit away from a full month name with the same first three
// letters, is that month. Without this the range silently shrank to "5 Oct". Only clear misspellings count: the word
// and the month both have six or more letters (so "market" ~ maret and "marsh" ~ march stay words), and a few real
// words one edit away from a month are listed (NOT_MONTHS; a scan of an English word list finds no other).
const FULL_MONTHS = Object.keys(MONTHS).filter(m => m.length >= 6);
const NOT_MONTHS = new Set(['market', 'markets', 'marah', 'marsh', 'marco', 'marek', 'augusta', 'augusti', 'augustus']);
function oneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
const monthFix = word => {
  const w = word.toLowerCase();
  if (Object.hasOwn(MONTHS, w) || NOT_MONTHS.has(w)) return word;
  return FULL_MONTHS.find(m => m.slice(0,3) === w.slice(0,3) &&
    Math.min(w.length, m.length) >= 6 && oneEdit(w, m)) || word;
};
export const fixMonths = text => String(text)
  .replace(/(\b\d{1,2}\s+)([A-Za-z]{5,})\b/g, (m, day, word) => day + monthFix(word))
  .replace(/\b([A-Za-z]{5,})(\s+\d{1,2})(?!\d)/g, (m, word, day) => monthFix(word) + day);
// A short correction such as "september 22" carries the same date as "22 september".
const dateOrder = text => fixMonths(text).replace(new RegExp('\\b(' + MONTH_WORDS + ')\\s+(\\d{1,2})(?!\\d)\\b,?','gi'), '$2 $1');
function validDate(y,m,d) {
  const date = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const parsed = new Date(date + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === date ? date : null;
}
// Keep complete endpoints together: "3 October 2026 sampai tanggal 5 October 2026"
// is one inclusive range, while "3 October dan 5 October" is still a date list.
function dateRanges(question, year) {
  const endpoint = '(?:20\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/-]\\d{1,2}(?:[/-]20\\d{2})?|\\d{1,2}\\s+(?:' + MONTH_WORDS + ')(?:\\s+20\\d{2})?)';
  const range = new RegExp('\\b(' + endpoint + ')\\s*(?:sampai|hingga|s/d|[–—-])\\s*(?:(?:tanggal|tgl|tggl)\\s*)?(' + endpoint + ')\\b', 'gi');
  const parts = text => {
    let m = text.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
    if (m) return {year:m[1], month:m[2], day:m[3]};
    m = text.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?$/);
    if (m) return {year:m[3], month:m[2], day:m[1]};
    m = text.match(new RegExp('^(\\d{1,2})\\s+(' + MONTH_WORDS + ')(?:\\s+(20\\d{2}))?$', 'i'));
    return {year:m[3], month:MONTHS[m[2].toLowerCase()], day:m[1]};
  };
  const dates = [];
  let invalid = false;
  const rest = question.replace(range, (text, first, last) => {
    const a = parts(first), b = parts(last), fromYear = a.year || b.year || year, toYear = b.year || a.year || year;
    if (fromYear && toYear) {
      const from = validDate(+fromYear,+a.month,+a.day), to = validDate(+toYear,+b.month,+b.day);
      if (from && to && from <= to) dates.push({from,to});
      else invalid = true;
    }
    return ' '.repeat(text.length);
  });
  return {dates, rest, invalid};
}
export function dateQuery(question, history = [], years = []) {
  question = dateOrder(question);
  const ranges = dateRanges(question, years.length === 1 ? years[0] : undefined);
  if (ranges.invalid) return {clarification:'Rentang tanggal tidak valid. Pastikan kedua tanggal benar dan tanggal awal tidak melewati tanggal akhir.', filter:false};
  const full = text => {
    text = dateOrder(text);
    let m = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
    if (m) return validDate(+m[1],+m[2],+m[3]);
    m = text.match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](20\d{2})\b/);
    if (m) return validDate(+m[3],+m[2],+m[1]);
    m = text.match(new RegExp('\\b(\\d{1,2})\\s+(' + MONTH_WORDS + ')\\s+(20\\d{2})\\b','i'));
    return m ? validDate(+m[3],MONTHS[m[2].toLowerCase()],+m[1]) : null;
  };
  let date = full(question);
  const previous = [...history].reverse().find(t => t.role === 'user');
  const previousDay = previous?.content.match(/\b(?:tanggal|tgl|tggl)\s*(\d{1,2})(?!\d)/i);
  const suppliedMonth = question.match(new RegExp('\\b(' + MONTH_WORDS + ')\\s+(20\\d{2})\\b','i'));
  if (!date && previousDay && suppliedMonth) date=validDate(+suppliedMonth[2],MONTHS[suppliedMonth[1].toLowerCase()],+previousDay[1]);
  const range = ranges.dates.length > 0 || /\b(sebelum|sesudah|setelah|sampai|hingga|sejak|antara|before|after|between|until)\b/i.test(question) ||
    new RegExp('\\b\\d{1,2}\\s*[–-]\\s*\\d{1,2}\\s+(?:'+MONTH_WORDS+')\\b','i').test(question) ||
    (question.match(/\b20\d{2}-\d{1,2}-\d{1,2}\b/g) || []).length > 1;
  if (date) return {date, filter:!range};
  if (/\b20\d{2}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[\/-]\d{1,2}[\/-]20\d{2}\b/.test(question))
    return {clarification:'Tanggal tersebut tidak valid. Tuliskan tanggal lengkap yang benar, misalnya 17 September 2026.',filter:false};
  const short = question.match(/\b(?:tanggal|tgl|tggl|pada)\s*(\d{1,2})(?!\d)/i) ||
    question.match(new RegExp('\\b(\\d{1,2})\\s+(?:' + MONTH_WORDS + ')\\b','i'));
  if (!short) return {date:null, filter:false};
  // Inherit only a fully specified date from the preceding user turn, never from file dates.
  const inherited = previous && full(previous.content);
  if (inherited && !new RegExp(MONTH_WORDS,'i').test(question)) {
    const value = validDate(+inherited.slice(0,4),+inherited.slice(5,7),+short[1]);
    if (value) return {date:value, filter:!range, inherited:true};
  }
  // Day and month without a year are unambiguous when the whole archive lies in one year.
  const dayMonth = question.match(new RegExp('\\b(\\d{1,2})\\s+(' + MONTH_WORDS + ')\\b(?!\\s+20\\d{2})','i'));
  if (dayMonth && years.length === 1) {
    const value = validDate(years[0],MONTHS[dayMonth[2].toLowerCase()],+dayMonth[1]);
    if (value) return {date:value, filter:!range, inferredYear:true};
  }
  return {clarification:`Tanggal ${short[1]} bulan dan tahun berapa? Contoh: “tanggal ${short[1]} September 2026”.`, filter:false};
}

// Ticker codes match case-sensitively: "naik" in prose is not the ticker NAIK.
export const pattern = (term, tickers = new Set()) => new RegExp('(?<![\\p{L}\\p{N}_])' + escapeRegExp(term).replace(/\s+/g,'\\s+') + '(?![\\p{L}\\p{N}_])',
  tickers.has(term) ? 'u' : 'iu');
// "Tidak ada aksi korporasi seperti rights issue" mentions a topic without it happening.
// Keep in sync with NEGATION in tools/event_index.py.
export const NEGATION = /\b(tidak ada|tidak terdapat|belum ada|tanpa adanya|tidak mengindikasikan|tidak menunjukkan|tidak mengungkapkan|tidak disebutkan|tidak dilaporkan|tidak diumumkan|belum merencanakan|tidak merencanakan|tidak berencana|belum berencana|none)\b/i;
export function affirmed(text, re) {
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
    const clause = text.slice(Math.max(0, m.index - 400), m.index).split(/[;:.]\s|\n/).pop();
    if (!NEGATION.test(clause)) return true;
  }
  return false;
}
const LISTISH = /^\s*(?:[-*+]\s|\d{1,3}[.)]\s|\|)/;
export function selectRecords(data, terms, tickers = new Set(), {keepNegated = false} = {}) {
  const patterns = terms.map(t => [pattern(t,tickers), tickers.has(t)]), selected = new Set(), rows = data.records;
  for (let i=0;i<rows.length;i++) {
    const row = rows[i];
    // Topic words must appear at least once outside a negation; ticker codes match as written.
    if (terms.some(t => tickers.has(t) && row.tickers.includes(t)) ||
        patterns.some(([p, code]) => code || keepNegated ? p.test(row.content) : affirmed(row.content, p))) {
      selected.add(i);
      // Untitled prose can carry supporting detail into the adjacent paragraph. A list (a short unsplit list
      // record or one item of a long split list) keeps only its intro sentence ("Nama yang paling menarik …:"),
      // which says what the list ranks; the records after it are other bullets, usually about other issuers.
      // Table rows stand alone.
      if (row.kind === 'context' && !LISTISH.test(row.content)) {
        for (const j of [i-1,i+1]) if (rows[j]?.kind === 'context' && rows[j].context === row.context) selected.add(j);
      } else if (row.kind === 'context' || row.kind === 'list_item') {
        let j = i - 1;
        while (rows[j]?.kind === 'list_item' && rows[j].context === row.context) j--;
        const intro = rows[j];
        if (intro?.kind === 'context' && intro.context === row.context && !LISTISH.test(intro.content) &&
            !/^\s*#{1,6}\s/.test(intro.content)) selected.add(j);
      }
    }
  }
  // Preserve internally linked evidence, e.g. a summary row linking to a source post.
  const refs = new Set([...selected].flatMap(i => [...rows[i].content.matchAll(/href=["']#([^"']+)/g)].map(m=>m[1])));
  if (refs.size) for (let i=0;i<rows.length;i++) {
    if ([...rows[i].content.matchAll(/id=["']([^"']+)/g)].some(m=>refs.has(m[1]))) selected.add(i);
  }
  return [...selected].sort((a,b)=>a-b).map(i=>rows[i]);
}

// ---- Model copy of search material ------------------------------------------------------------
// Stored sources, the source cache and the number check keep the original text; only the copy sent
// to the model drops what an answer never needs (it cites [D…], the site links every document).
// Code of an issuer section heading ("## TOWR — PT …", "### 01. TOWR"), as heading_ticker in tools/evidence_index.py.
export function headingTicker(content, tickers) {
  const m = String(content || '').match(/^\s*#{1,6}\s+([^\n]+)/);
  if (!m) return null;
  const code = m[1].replace(/[*`]/g, '').replace(/^[\d.()\s]+/, '').match(/^([A-Z0-9]{2,8})(?![A-Za-z0-9_])/)?.[1];
  return code && (!tickers || tickers.has(code)) ? code : null;
}
// [pos](url) -> pos; IDX PDF links, "(juga: 365…)" post ids, "(F20261012-0371)" finding ids and
// " · 20261013135714-072/CORSEC-SOCI/X/2026_id-id" announcement ids carry no evidence.
export const modelText = text => String(text)
  .replace(/\[([^\[\]\n]{1,300})\]\((?:https?:\/\/|www\.)[^\s)]*\)/g, '$1')
  // A bare URL ends at a quote, angle bracket or comma too: HTML attributes and CSV cells keep their neighbours.
  .replace(/\s?\(https?:\/\/(?:www\.)?idx\.co\.id\/[^\s)]*\)|https?:\/\/(?:www\.)?idx\.co\.id\/[^\s)\]"'<>,]*/g, '')
  .replace(/(?: ·)? ?\(juga: \d+(?:, \d+)*(?:, \+\d+ lagi)?\)/g, '')
  .replace(/\s?\(F20\d{6}-\d+(?:, F20\d{6}-\d+)*\)/g, '')
  .replace(/ · 20\d{12}-[^\s·]*?_[a-z]{2}-[a-z]{2}(?=[\s·]|$)/g, '');
// Context headers repeat for every passage: plain text, no table markup.
export const plainContext = text => String(text || '').replace(/<\/t[hd]>/gi, ' | ').replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
  .split('\n').map(l => l.replace(/\s+/g, ' ').replace(/(?:\s*\|\s*)+$/, '').trim()).filter(Boolean).join('\n');
const LIST_TRIM = 2000;
// A long list outside the issuer's own section (sbdetail "Ikhtisar emiten", beidetail "Lampiran") that tags
// the ticker once: keep its headings and the items naming a searched term (an item is a line plus its
// indented continuation lines), not the bullets for every other issuer.
function trimList(content, patterns) {
  const items = [];
  for (const line of content.split(/(?<=\n)/)) {
    if (items.length && /^[ \t]+\S/.test(line)) items.at(-1).push(line); else items.push([line]);
  }
  let matched = 0, dropped = 0;
  const kept = items.filter(item => {
    const text = item.join('');
    if (/^\s*#{1,6}\s/.test(text)) return true;
    if (patterns.some(p => p.test(text))) { matched++; return true; }
    if (text.trim()) dropped++;
    return false;
  });
  if (!matched || !dropped) return content;
  const out = kept.map(i => i.join('')).join('');
  return out + (out.endsWith('\n') ? '' : '\n') + `(${dropped} butir lain dalam daftar ini tidak dikirim)\n`;
}
// Another issuer's Stockbit section that names the searched ticker ("## PMUI … [Pertanyaan] PMUI dipertanyakan untung
// dari penjualan GRPM"): its GRPM findings are copies of the ticker's own section's findings (same text before " — ").
// Only the finding lines naming the ticker that the own section lacks are sent, with the heading; without any, the
// section is not sent. A document without an own section keeps the heading, the opening line and every naming finding.
function comention(text, code, patterns, own) {
  const lines = text.split('\n'), kept = [];
  for (const line of lines.slice(1)) {
    if (!/^- \[/.test(line) || !patterns.some(p => p.test(line))) continue;
    const key = line.split(' — ')[0];
    if (own && key.length >= 20 && own.includes(key)) continue;
    kept.push(line);
  }
  if (own && !kept.length) return null;
  const opening = own ? [] : [lines.slice(1).find(l => l.trim() && !/^- \[/.test(l)) || ''].filter(Boolean);
  const body = [...opening, ...kept];
  return lines[0] + '\n\n' + body.join('\n') + (body.length ? '\n' : '') + `(bagian ${code} lain tidak dikirim)\n\n`;
}
// Rows as sent to the model; `original` keeps the source text for the post-answer number check. A row the model copy
// does not need (a co-mention section whose findings the own section already has) is left out.
export function modelRows(doc, rows, terms, tickers = new Set()) {
  const codes = terms.filter(t => tickers.has(t)), patterns = terms.map(t => pattern(t, tickers));
  const desk = /^(bei|stockbit)-/.test(doc?.cat || '');
  const ownText = /^stockbit-/.test(doc?.cat || '') && codes.length
    ? rows.filter(r => r.kind === 'issuer_section' && codes.includes(headingTicker(r.content, tickers))).map(r => r.content).join('\n') : null;
  return rows.flatMap(row => {
    let text = row.content;
    const other = ownText !== null && row.kind === 'issuer_section' ? headingTicker(text, tickers) : null;
    if (other && !codes.includes(other)) {
      text = comention(text, other, patterns, ownText);
      if (text === null) return [];
    }
    if (desk && codes.length && row.kind === 'context' && text.length > LIST_TRIM && codes.some(c => row.tickers?.includes(c)))
      text = trimList(text, patterns);
    text = modelText(text);
    return [text === row.content ? row : {...row, content:text, original:row.content}];
  });
}

export function filterRecords(rows, scope) {
  if (!scope.date || !scope.filter) return {rows, excluded:0};
  // Unknown dates and multi-date evidence stay available. Only clearly dated records can be excluded.
  const kept = rows.filter(r => !r.event_date || r.event_date === scope.date || r.dates_mentioned?.includes(scope.date));
  return {rows:kept, excluded:rows.length-kept.length};
}

// "Ringkas keterbukaan informasi 22 September" names a document, not a topic inside documents.
// Category words plus a date (or "terbaru") select whole documents by their catalog date.
const CATEGORY_WORDS = [
  [/\b(asx|australia)\b/i,'keterbukaan-australia'], [/\b(sgx|singapur[ae]?|singapore)\b/i,'keterbukaan-singapura'],
  [/\b(keterbukaan|ki)\b/i,'keterbukaan-informasi'], [/\bbei\b/i,'bei-ringkasan'], [/\bstockbit\b/i,'stockbit'],
  // Digest Emiten is retired from chat (build_worker RETIRED); its successor is the BEI daily summary family.
  [/\bdigest\b/i,'bei-ringkasan']];
// "keterbukaan", "ki" and "bei" name the Indonesian disclosure family: the daily BEI summaries (bei-ringkasan), weekly
// recaps (bei-pekan) for ranges of more than two days, and the retired manual KI analyses (keterbukaan-informasi) for
// the days and snapshots they cover. Per-issuer BEI detail files are read only for "detail"/explicit tickers, like Stockbit.
export const IDX_CATEGORIES = ['bei-ringkasan','bei-pekan','bei-detail','keterbukaan-informasi'];
const IDX_FAMILY = new Set(IDX_CATEGORIES);
// "stockbit" names the Stockbit source family, not one file kind. It reads the daily summaries
// (stockbit-ringkasan), weekly recaps for ranges of more than two days (stockbit-pekan), and old raw
// reports only where no summary covers the day. Raw reports are read alone only on request; the per-ticker
// detail files only for "detail"/"semua temuan" (core adds them for explicit ticker/handle questions).
export const STOCKBIT_CATEGORIES = ['stockbit-ringkasan','stockbit-pekan','stockbit-detail','stockbit'];
const STOCKBIT_FAMILY = new Set(STOCKBIT_CATEGORIES);
// Only explicit phrases: "posting asli" is an ordinary request for post links, not for the raw reports.
const STOCKBIT_RAW = /\b(stockbit\s+mentah|laporan\s+(?:mentah|lama|asli)|raw)\b/i;
// "semua temuan" / "jangan lewatkan detail" ask for completeness (core.mjs EXHAUSTIVE), not for the detail files.
const STOCKBIT_DETAIL = /(?<!\b(?:hilang|hilangkan|menghilangkan|lewat|lewatkan|melewatkan)\s+)\bdetail\b/i;
// The retired manual KI analyses are read next to a BEI daily summary of the same day only on request.
const KI_LEGACY = /\b(?:ki|keterbukaan(?:\s+informasi)?)\s+lama\b|\banalis[ia]s?\s+(?:ki|keterbukaan)\b|\bki_/i;
const DAY_MS = 86400000;
const dayList = (from, to) => {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'), end = Date.parse(to + 'T00:00:00Z'); t <= end && out.length < 400; t += DAY_MS)
    out.push(new Date(t).toISOString().slice(0,10));
  return out;
};
function categories(text) {
  // A qualified foreign disclosure label is one source, but "SGX dan KI" names two.
  const domestic = text.replace(/\b(?:keterbukaan(?:\s+informasi)?|ki)\s+(?:sgx|singapur[ae]?|singapore|asx|australia)\b/gi, '');
  return [...new Set(CATEGORY_WORDS.filter(([re,cat]) => re.test(cat === 'keterbukaan-informasi' ? domestic : text)).map(([,cat]) => cat))];
}
const span = d => d.covers || [d.start,d.end];
// Every date the user wrote: "25 september", "22 dan 25 sept", "23-24 sept" (range), "26/9", "2026-09-26".
// "Hari ini" for relative ranges, in WIB (UTC+7) like the archive's file dates.
export const todayWIB = () => new Date(Date.now() + 7 * 3600000).toISOString().slice(0,10);
function weekRange(question, today) {
  const m = question.match(/\b(?:minggu|pekan)\s+(ini|lalu|kemarin)\b/i);
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(today || '')) return null;
  const t = Date.parse(today + 'T00:00:00Z'), monday = t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS;
  const start = monday - (/ini/i.test(m[1]) ? 0 : 7 * DAY_MS), iso = v => new Date(v).toISOString().slice(0,10);
  return {from:iso(start), to:iso(start + 6 * DAY_MS)};
}
// Full month names only: "may", "mar", "des" and "jun" are ordinary words or too ambiguous alone.
const MONTH_ONLY = /\b(januari|january|februari|february|maret|march|april|mei|juni|june|juli|july|agustus|august|september|oktober|october|november|desember|december)\b(?:\s+(20\d{2}))?/gi;
export function requestedDates(question, year, today = todayWIB()) {
  const week = weekRange(question, today);
  question = dateOrder(question);
  const ranges = dateRanges(question, year);
  question = ranges.rest;
  const out = [...ranges.dates], add = (y,m,d) => { const v = validDate(+y,+m,+d); if (v) out.push({from:v, to:v}); };
  for (const m of question.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) add(m[1],m[2],m[3]);
  for (const m of question.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/g)) if (m[3] || year) add(m[3] || year,m[2],m[1]);
  const list = new RegExp('\\b(\\d{1,2})((?:\\s*(?:,|&|dan|-|–|sampai|hingga|s/d)\\s*\\d{1,2})*)\\s+(' + MONTH_WORDS + ')\\b(?:\\s+(20\\d{2}))?','gi');
  for (const m of question.matchAll(list)) {
    const y = m[4] || year, mo = MONTHS[m[3].toLowerCase()];
    if (!y) continue;
    const rest = [...m[2].matchAll(/(,|&|dan|-|–|sampai|hingga|s\/d)\s*(\d{1,2})/gi)];
    if (rest.length === 1 && /^(-|–|sampai|hingga|s\/d)$/i.test(rest[0][1])) {
      const from = validDate(+y,mo,+m[1]), to = validDate(+y,mo,+rest[0][2]);
      if (from && to && from <= to) out.push({from, to});
    } else for (const d of [m[1], ...rest.map(r => r[2])]) add(y,mo,d);
  }
  if (week) out.push(week);
  // "stockbit oktober" is the whole month. Only for Stockbit questions (other sources keep their old
  // scoping), and only when no day of any month was written, so a day list or range
  // ("3 dan 5 oktober", "30 september sampai 2 oktober") is never widened.
  if (!out.length && categories(question).includes('stockbit') && !new RegExp('\\b\\d{1,2}\\s+(?:' + MONTH_WORDS + ')\\b|\\b\\d{1,2}[/-]\\d{1,2}\\b','i').test(question))
    for (const m of question.matchAll(MONTH_ONLY)) {
      const y = m[2] || year, mo = MONTHS[m[1].toLowerCase()];
      if (!y) continue;
      const from = validDate(+y,mo,1), to = new Date(Date.UTC(+y,mo,0)).toISOString().slice(0,10);
      if (from && !out.some(r => r.from === from && r.to === to)) out.push({from, to});
    }
  return out;
}

// Source scope survives topic search as well as whole-document requests. Dates here describe
// catalog coverage; callers handling event dates can apply categories alone.
export function requestScope(question, index, year, today = todayWIB()) {
  const years = [...new Set((index.docs || []).map(d => d.end?.slice(0,4)).filter(Boolean))];
  year ||= years.length === 1 ? years[0] : undefined;
  const cats = categories(question), dates = requestedDates(question, year, today);
  const clauses = question.split(/\s+\b(?:dan|dengan|sama|serta|versus|vs)\b\s+|\s*[;]\s*/i);
  const dated = clauses.map(text => ({categories:categories(text), dates:requestedDates(text, year, today)}))
    .filter(c => c.categories.length && c.dates.length);
  // "Stockbit 25 Sep dan KI 26 Sep" binds each date; "25–26 Sep Stockbit dan KI"
  // shares the single range. Splitting a date list (22 dan 25 Sep) must not lose day 22.
  const pairs = dated.length > 1 ? dated.flatMap(c => c.categories.map(category => ({category, dates:c.dates}))) : [];
  const latest = /\b(terbaru|terakhir|latest|paling baru)\b/i.test(question);
  const all = /\b(semua|seluruh|selengkapnya|all)\b/i.test(question);
  // Flags are added only when set, so scopes stored in earlier conversation turns stay comparable.
  const stockbit = {...(cats.includes('stockbit') && STOCKBIT_RAW.test(question) ? {stockbitRaw:true} : {}),
    ...(STOCKBIT_DETAIL.test(question) ? {stockbitDetail:true} : {}), ...(KI_LEGACY.test(question) ? {kiLegacy:true} : {})};
  return {categories:cats, dates, pairs, latest, all, explicit:!!(cats.length || dates.length || latest || all), ...stockbit};
}

// Which Stockbit file kinds a request may read before date and dominance rules.
function stockbitKind(d, request, cats) {
  if (cats.includes(d.cat) && d.cat !== 'stockbit') return true;
  if (cats.length && !cats.includes('stockbit')) return false;
  if (request.stockbitRaw) return d.cat === 'stockbit';
  return d.cat !== 'stockbit-detail' || !!request.stockbitDetail;
}
const family = cat => STOCKBIT_FAMILY.has(cat) ? 'stockbit' : IDX_FAMILY.has(cat) ? 'idx' : cat;
// Which Indonesian disclosure kinds a request may read: a family word reads all of them except per-issuer detail.
function idxKind(d, request, cats) {
  if (cats.includes(d.cat)) return true;
  if (cats.length && !cats.some(c => IDX_FAMILY.has(c))) return false;
  return d.cat !== 'bei-detail' || !!request.stockbitDetail;
}
// Weekly BEI recaps answer ranges of more than two days (three asked-for days inside the recap); the newest snapshot
// is a daily summary, and a retired KI analysis is not the newest Indonesian snapshot once a BEI summary is as new.
function preferBei(selected, request, {dates, latest}) {
  if (!selected.some(d => IDX_FAMILY.has(d.cat))) return selected;
  const paired = (request.pairs || []).filter(p => family(p.category) === 'idx').flatMap(p => p.dates);
  const ranges = dates ? (paired.length ? paired : request.dates || []) : [];
  const wanted = new Set(ranges.flatMap(r => dayList(r.from, r.to)));
  const inRange = d => { const [s,e] = span(d); return dayList(s,e).filter(day => !wanted.size || wanted.has(day)); };
  const weekly = wanted.size > 2 && !latest ? selected.filter(d => d.cat === 'bei-pekan' && inRange(d).length >= 3) : [];
  let out = selected.filter(d => d.cat !== 'bei-pekan' || weekly.includes(d));
  out = out.filter(d => d.cat !== 'bei-ringkasan' || !weekly.some(w => span(w)[0] <= span(d)[0] && span(d)[1] <= span(w)[1]));
  if (latest) {
    const newestBei = out.filter(d => d.cat === 'bei-ringkasan').map(d => d.end).sort().at(-1);
    if (newestBei) out = out.filter(d => d.cat !== 'keterbukaan-informasi' || d.end > newestBei);
  } else if (dates && !request.kiLegacy) {
    // With dates, a retired KI analysis is dropped only when the selected BEI files cover every day it covers. A KI
    // file is named for the day its digest ran and mostly holds the evening before (ki_07102026 covers 6–7 Oct), so
    // "KI 7 Oktober" next to BEI 7 Oktober still adds 6 October and its own analysis (core.mjs sends it as a head).
    // "KI lama"/"analisis KI" keeps it whole. Like raw Stockbit reports under preferSummaries.
    const covered = new Set(out.filter(d => ['bei-ringkasan','bei-pekan','bei-detail'].includes(d.cat)).flatMap(d => dayList(...span(d))));
    out = out.filter(d => d.cat !== 'keterbukaan-informasi' || !inRange(d).length || !dayList(...span(d)).every(day => covered.has(day)));
  }
  return out;
}
// Summaries replace what they cover: weekly recaps for ranges of more than two days, daily
// summaries instead of raw reports. Raw reports stay for days no summary covers.
function preferSummaries(selected, candidates, request, {dates, latest}) {
  if (!selected.some(d => STOCKBIT_FAMILY.has(d.cat))) return selected;
  const paired = (request.pairs || []).filter(p => p.category === 'stockbit').flatMap(p => p.dates);
  const ranges = dates ? (paired.length ? paired : request.dates || []) : [];
  const wanted = new Set(ranges.flatMap(r => dayList(r.from, r.to)));
  const inRange = d => { const [s,e] = span(d); return dayList(s,e).filter(day => !wanted.size || wanted.has(day)); };
  let out = selected;
  // Weekly recaps answer ranges of more than two days; a recap is used only when at least three of
  // its days were asked for, and then the daily summaries inside it are not read again.
  const weekly = wanted.size > 2 && !latest ? out.filter(d => d.cat === 'stockbit-pekan' && inRange(d).length >= 3) : [];
  out = out.filter(d => d.cat !== 'stockbit-pekan' || weekly.includes(d));
  out = out.filter(d => d.cat !== 'stockbit-ringkasan' || !weekly.some(w => span(w)[0] <= span(d)[0] && span(d)[1] <= span(w)[1]));
  if (!request.stockbitRaw) {
    const summarized = new Set(candidates.filter(d => d.cat === 'stockbit-ringkasan').flatMap(d => dayList(...span(d))));
    const newestSummary = out.filter(d => d.cat === 'stockbit-ringkasan').map(d => d.end).sort().at(-1);
    out = out.filter(d => {
      if (d.cat !== 'stockbit') return true;
      if (latest && newestSummary && newestSummary >= d.end) return false;
      const days = inRange(d);
      return !days.length || !days.every(day => summarized.has(day));
    });
  }
  return out;
}

export function scopeDocuments(docs, request, options = {}) {
  const out = scopeOnce(docs, request, options);
  // A raw-report request for days that only have summaries (raw reports of summarized days are not
  // indexed) falls back to the summaries instead of an empty set.
  if (request.stockbitRaw && !out.some(d => STOCKBIT_FAMILY.has(d.cat))) {
    const {stockbitRaw, ...rest} = request;
    return scopeOnce(docs, rest, options);
  }
  return out;
}

function scopeOnce(docs, request, {dates = false, latest = false} = {}) {
  const cats = request.categories || [];
  let selected = docs.filter(d => STOCKBIT_FAMILY.has(d.cat) ? stockbitKind(d, request, cats)
    : IDX_FAMILY.has(d.cat) ? idxKind(d, request, cats) : !cats.length || cats.includes(d.cat));
  if (dates && request.dates?.length) selected = selected.filter(d => {
    const paired = (request.pairs || []).filter(p => p.category === d.cat || family(p.category) === family(d.cat)).flatMap(p => p.dates);
    const ranges = paired.length ? paired : request.dates, [start,end] = span(d);
    return start && ranges.some(r => start <= r.to && r.from <= end);
  });
  if (latest) {
    const newest = {};
    // The newest day is one summary, never a weekly recap of earlier days.
    selected = selected.filter(d => d.cat !== 'stockbit-pekan' && d.cat !== 'bei-pekan');
    for (const d of selected) if (!newest[d.cat] || d.end > newest[d.cat]) newest[d.cat] = d.end;
    const last = Object.values(newest).sort().at(-1);
    selected = selected.filter(d => d.end === newest[d.cat] && (cats.length || d.end === last));
  }
  const options = {dates:dates && !!request.dates?.length, latest};
  return preferBei(preferSummaries(selected, docs, request, options), request, options);
}

export function dedupeDocuments(docs) {
  const key = d => [d.cat,d.end,d.name.replace(/\.[^.]+$/, '')].join(':');
  const markdown = new Set(docs.filter(d => /\.md$/i.test(d.name)).map(key));
  return docs.filter(d => !/\.csv$/i.test(d.name) || !markdown.has(key(d)));
}
// A pasted document title ("Stockbit — 20–22 September 2026 jelaskan") names that document.
const fold = t => t.toLowerCase().replace(/[–—-]/g,'-').replace(/\s+/g,' ').trim();
function titledDocuments(question, index) {
  const q = fold(question);
  return index.docs.filter(d => d.title.length >= 12 && q.includes(fold(d.title)));
}
const SUMMARY_WORDS = /\b(dokumen|laporan|ringkas|ringkasan|rangkum|rangkuman|summary|summarize|isi|simpulkan|kesimpulan|baca|keterbukaan|stockbit|digest)\b/i;
export function documentRequest(question, scope, index, request = requestScope(question, index, scope.date?.slice(0,4))) {
  // An empty selection still routes agent mode to the archive's zero-call date clarification.
  if (scope.clarification) return [];
  const titled = dedupeDocuments(titledDocuments(question, index));
  if (titled.length && titled.length <= 6) return titled;
  const cats = request.categories;
  // Naming a source ("ki 18 september", "KI 26/9") asks for its document, like a summary verb does.
  if (!cats.length && !SUMMARY_WORDS.test(question)) return null;
  if (TOPIC_WORDS.test(question)) return null;
  let docs;
  if (request.dates.length) {
    docs = scopeDocuments(index.docs, request, {dates:true});
    // Without a category, a date alone is a document request only with a summary verb.
    if (!cats.length && !READ_VERBS.test(question)) return null;
  } else if (request.latest || (cats.length && (READ_VERBS.test(question) || (request.all && SUMMARY_WORDS.test(question))))) {
    // No date means the newest snapshot; historical documents require an explicit "semua".
    docs = scopeDocuments(index.docs, request, {latest:request.latest || !request.all});
  } else return null;
  docs = dedupeDocuments(docs);
  if (!docs.length) return null;
  // Daily summaries (≤60 KB) and weekly recaps are small: a month is about four recaps plus edge days.
  const cap = docs.every(d => ['stockbit-ringkasan','stockbit-pekan','bei-ringkasan','bei-pekan'].includes(d.cat)) ? 10 : 6;
  if (docs.length <= cap) return docs;
  // An explicit date range over the cap is still a document request: desk files are read as a code-built digest
  // (core.mjs), other files whole or as notes. Beyond that, a code-built clarification without any model call
  // (it used to fall through to term extraction and fail with "Sebutkan saham").
  if (!request.dates.length) return null;
  const other = docs.filter(d => !DESK_DOCS.has(d.cat)), otherBytes = other.reduce((n, d) => n + (d.sizes || []).reduce((a, b) => a + b, 0), 0);
  if (docs.length <= DIGEST_MAX_DOCS && other.length <= 8 && otherBytes <= 1500000) return docs;
  const kinds = [...new Set(docs.map(d => sourceName(d.cat)))].join(', ');
  return Object.assign([], {clarification:`Rentang ini mencakup ${docs.length} dokumen (${kinds}), terlalu banyak untuk dibaca dalam satu jawaban. `
    + 'Persempit rentang tanggal (misalnya satu pekan) atau pilih satu sumber, misalnya “ringkas stockbit 1–7 oktober” atau “ringkas BEI 6–9 oktober”. Belum ada bahan yang dikirim ke layanan AI.'});
}
const DESK_DOCS = new Set(['stockbit-ringkasan','stockbit-detail','stockbit-pekan','bei-ringkasan','bei-detail','bei-pekan']);
const DIGEST_MAX_DOCS = 31;
const sourceName = cat => /^stockbit/.test(cat) ? 'Stockbit' : /^bei-|keterbukaan-informasi/.test(cat) ? 'keterbukaan BEI/KI'
  : cat === 'keterbukaan-singapura' ? 'SGX' : cat === 'keterbukaan-australia' ? 'ASX' : cat;
const READ_VERBS = /\b(baca|bacakan|ringkas|ringkasan|rangkum|rangkuman|summary|summarize|simpulkan|kesimpulan|inti|intinya|isi|isinya|garis besar|highlight|menarik)\b/i;
// Common action names are topics even without "soal": "ringkas SGX delisting".
const TOPIC_WORDS = /\b(soal|tentang|mengenai|terkait|perihal|yang menyebut|delisting|go private|rights? issue|hmetd|private placement|tender offer|akuisisi|acquisition|buyback|dividen|dividend|merger|stock split|kepemilikan|pengendali)\b/i;

// A small explicit vocabulary handles the current cross-market screening use case.
// These are search candidates, never inferred ownership relationships.
export function crossMarketQuery(question) {
  const indonesia = /\b(indonesia|bei|idx)\b/i.test(question) ||
    (/\bindo\b/i.test(question) && !/\b(?:saham|ticker|kode)\s+indo\b/i.test(question));
  if(!indonesia || !/\b(hubungan|berhubungan|terkait|kaitan|akuisisi|acquisition|kepemilikan|pengendali|investasi|backdoor)\b/i.test(question))return null;
  const terms=[];
  if(/\b(asx|australia)\b/i.test(question))terms.push('ASX','Australia','Australian');
  if(/\b(sgx|singapur[ae]?|singapore)\b/i.test(question))terms.push('SGX','Singapura','Singapore','Singapur');
  return terms.length?{terms,version:'cross-market-v3'}:null;
}

export function thematicPassages(data, terms) {
  const selected=selectRecords(data,terms), patterns=terms.map(t=>pattern(t)), output=[];
  // Keep whole small records. Large issuer sections retain matching paragraphs, neighbors,
  // headings and explicit caveats. Every retained character is original source text.
  for(const row of selected) {
    if(row.content.length<=5000) {output.push(row);continue;}
    const chunks=[...row.content.matchAll(/[^\n]*(?:\n(?!\s*\n)[^\n]*)*(?:\n\s*\n|$)/g)].filter(m=>m[0]);
    const chosen=new Set();
    for(let i=0;i<chunks.length;i++) {
      if(patterns.some(p=>p.test(chunks[i][0])))for(const j of [i-1,i,i+1])if(chunks[j])chosen.add(j);
      if(/^\s*#{1,6}\s/m.test(chunks[i][0]) || /\b(belum terbukti|belum selesai|dibatalkan|tidak terbukti|batas bukti)\b/i.test(chunks[i][0]))chosen.add(i);
    }
    for(const i of [...chosen].sort((a,b)=>a-b)) {
      const m=chunks[i];output.push({...row,section_id:row.section_id+':'+m.index,
        line:row.line+(row.content.slice(0,m.index).match(/\n/g)||[]).length,content:m[0]});
    }
  }
  return output;
}
