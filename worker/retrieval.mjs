const months = {januari:1,january:1,jan:1,februari:2,february:2,feb:2,maret:3,march:3,mar:3,april:4,apr:4,mei:5,may:5,juni:6,june:6,jun:6,juli:7,july:7,jul:7,agustus:8,august:8,agu:8,aug:8,september:9,sep:9,sept:9,oktober:10,october:10,okt:10,oct:10,november:11,nov:11,desember:12,december:12,des:12,dec:12};
const monthNames = Object.keys(months).join('|');
// A short correction such as "september 22" carries the same date as "22 september".
const dateOrder = text => text.replace(new RegExp('\\b(' + monthNames + ')\\s+(\\d{1,2})(?!\\d)\\b,?','gi'), '$2 $1');
function validDate(y,m,d) {
  const date = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const parsed = new Date(date + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === date ? date : null;
}
// Keep complete endpoints together: "3 October 2026 sampai tanggal 5 October 2026"
// is one inclusive range, while "3 October dan 5 October" is still a date list.
function dateRanges(question, year) {
  const endpoint = '(?:20\\d{2}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/-]\\d{1,2}(?:[/-]20\\d{2})?|\\d{1,2}\\s+(?:' + monthNames + ')(?:\\s+20\\d{2})?)';
  const range = new RegExp('\\b(' + endpoint + ')\\s*(?:sampai|hingga|s/d|[–—-])\\s*(?:(?:tanggal|tgl|tggl)\\s*)?(' + endpoint + ')\\b', 'gi');
  const parts = text => {
    let m = text.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
    if (m) return {year:m[1], month:m[2], day:m[3]};
    m = text.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?$/);
    if (m) return {year:m[3], month:m[2], day:m[1]};
    m = text.match(new RegExp('^(\\d{1,2})\\s+(' + monthNames + ')(?:\\s+(20\\d{2}))?$', 'i'));
    return {year:m[3], month:months[m[2].toLowerCase()], day:m[1]};
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
    m = text.match(new RegExp('\\b(\\d{1,2})\\s+(' + monthNames + ')\\s+(20\\d{2})\\b','i'));
    return m ? validDate(+m[3],months[m[2].toLowerCase()],+m[1]) : null;
  };
  let date = full(question);
  const previous = [...history].reverse().find(t => t.role === 'user');
  const previousDay = previous?.content.match(/\b(?:tanggal|tgl|tggl)\s*(\d{1,2})(?!\d)/i);
  const suppliedMonth = question.match(new RegExp('\\b(' + monthNames + ')\\s+(20\\d{2})\\b','i'));
  if (!date && previousDay && suppliedMonth) date=validDate(+suppliedMonth[2],months[suppliedMonth[1].toLowerCase()],+previousDay[1]);
  const range = ranges.dates.length > 0 || /\b(sebelum|sesudah|setelah|sampai|hingga|sejak|antara|before|after|between|until)\b/i.test(question) ||
    new RegExp('\\b\\d{1,2}\\s*[–-]\\s*\\d{1,2}\\s+(?:'+monthNames+')\\b','i').test(question) ||
    (question.match(/\b20\d{2}-\d{1,2}-\d{1,2}\b/g) || []).length > 1;
  if (date) return {date, filter:!range};
  if (/\b20\d{2}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[\/-]\d{1,2}[\/-]20\d{2}\b/.test(question))
    return {clarification:'Tanggal tersebut tidak valid. Tuliskan tanggal lengkap yang benar, misalnya 17 September 2026.',filter:false};
  const short = question.match(/\b(?:tanggal|tgl|tggl|pada)\s*(\d{1,2})(?!\d)/i) ||
    question.match(new RegExp('\\b(\\d{1,2})\\s+(?:' + monthNames + ')\\b','i'));
  if (!short) return {date:null, filter:false};
  // Inherit only a fully specified date from the preceding user turn, never from file dates.
  const inherited = previous && full(previous.content);
  if (inherited && !new RegExp(monthNames,'i').test(question)) {
    const value = validDate(+inherited.slice(0,4),+inherited.slice(5,7),+short[1]);
    if (value) return {date:value, filter:!range, inherited:true};
  }
  // Day and month without a year are unambiguous when the whole archive lies in one year.
  const dayMonth = question.match(new RegExp('\\b(\\d{1,2})\\s+(' + monthNames + ')\\b(?!\\s+20\\d{2})','i'));
  if (dayMonth && years.length === 1) {
    const value = validDate(years[0],months[dayMonth[2].toLowerCase()],+dayMonth[1]);
    if (value) return {date:value, filter:!range, inferredYear:true};
  }
  return {clarification:`Tanggal ${short[1]} bulan dan tahun berapa? Contoh: “tanggal ${short[1]} September 2026”.`, filter:false};
}

// Ticker codes match case-sensitively: "naik" in prose is not the ticker NAIK.
export const pattern = (term, tickers = new Set()) => new RegExp('(?<![\\p{L}\\p{N}_])' + term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+') + '(?![\\p{L}\\p{N}_])',
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
export function selectRecords(data, terms, tickers = new Set(), {keepNegated = false} = {}) {
  const patterns = terms.map(t => [pattern(t,tickers), tickers.has(t)]), selected = new Set(), rows = data.records;
  for (let i=0;i<rows.length;i++) {
    const row = rows[i];
    // Topic words must appear at least once outside a negation; ticker codes match as written.
    if (terms.some(t => tickers.has(t) && row.tickers.includes(t)) ||
        patterns.some(([p, code]) => code || keepNegated ? p.test(row.content) : affirmed(row.content, p))) {
      selected.add(i);
      // Untitled prose can carry supporting detail into the adjacent paragraph.
      if (row.kind === 'context' && !row.content.trim().startsWith('|')) {
        for (const j of [i-1,i+1]) if (rows[j]?.kind === 'context' && rows[j].context === row.context) selected.add(j);
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
  [/\b(keterbukaan|ki)\b/i,'keterbukaan-informasi'], [/\bstockbit\b/i,'stockbit'], [/\bdigest\b/i,'digest-emiten']];
// "stockbit" names the Stockbit source family, not one file kind. It reads the daily summaries
// (stockbit-ringkasan), weekly recaps for ranges of more than two days (stockbit-pekan), and old raw
// reports only where no summary covers the day. Raw reports are read alone only on request; the per-ticker
// detail files only for "detail"/"semua temuan" (core adds them for explicit ticker/handle questions).
export const STOCKBIT_CATEGORIES = ['stockbit-ringkasan','stockbit-pekan','stockbit-detail','stockbit'];
const STOCKBIT_FAMILY = new Set(STOCKBIT_CATEGORIES);
// Only explicit phrases: "posting asli" is an ordinary request for post links, not for the raw reports.
const STOCKBIT_RAW = /\b(stockbit\s+mentah|laporan\s+(?:mentah|lama|asli)|raw)\b/i;
const STOCKBIT_DETAIL = /\bsemua temuan\b|(?<!\b(?:hilang|hilangkan|lewatkan)\s+)\bdetail\b/i;
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
  return CATEGORY_WORDS.filter(([re,cat]) => re.test(cat === 'keterbukaan-informasi' ? domestic : text)).map(([,cat]) => cat);
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
  const list = new RegExp('\\b(\\d{1,2})((?:\\s*(?:,|&|dan|-|–|sampai|hingga|s/d)\\s*\\d{1,2})*)\\s+(' + monthNames + ')\\b(?:\\s+(20\\d{2}))?','gi');
  for (const m of question.matchAll(list)) {
    const y = m[4] || year, mo = months[m[3].toLowerCase()];
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
  if (!out.length && categories(question).includes('stockbit') && !new RegExp('\\b\\d{1,2}\\s+(?:' + monthNames + ')\\b|\\b\\d{1,2}[/-]\\d{1,2}\\b','i').test(question))
    for (const m of question.matchAll(MONTH_ONLY)) {
      const y = m[2] || year, mo = months[m[1].toLowerCase()];
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
    ...(STOCKBIT_DETAIL.test(question) ? {stockbitDetail:true} : {})};
  return {categories:cats, dates, pairs, latest, all, explicit:!!(cats.length || dates.length || latest || all), ...stockbit};
}

// Which Stockbit file kinds a request may read before date and dominance rules.
function stockbitKind(d, request, cats) {
  if (cats.includes(d.cat) && d.cat !== 'stockbit') return true;
  if (cats.length && !cats.includes('stockbit')) return false;
  if (request.stockbitRaw) return d.cat === 'stockbit';
  return d.cat !== 'stockbit-detail' || !!request.stockbitDetail;
}
const family = cat => STOCKBIT_FAMILY.has(cat) ? 'stockbit' : cat;
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
  let selected = docs.filter(d => STOCKBIT_FAMILY.has(d.cat) ? stockbitKind(d, request, cats) : !cats.length || cats.includes(d.cat));
  if (dates && request.dates?.length) selected = selected.filter(d => {
    const paired = (request.pairs || []).filter(p => p.category === d.cat || p.category === family(d.cat)).flatMap(p => p.dates);
    const ranges = paired.length ? paired : request.dates, [start,end] = span(d);
    return start && ranges.some(r => start <= r.to && r.from <= end);
  });
  if (latest) {
    const newest = {};
    // The newest day is one summary, never a weekly recap of earlier days.
    selected = selected.filter(d => d.cat !== 'stockbit-pekan');
    for (const d of selected) if (!newest[d.cat] || d.end > newest[d.cat]) newest[d.cat] = d.end;
    const last = Object.values(newest).sort().at(-1);
    selected = selected.filter(d => d.end === newest[d.cat] && (cats.length || d.end === last));
  }
  return preferSummaries(selected, docs, request, {dates:dates && !!request.dates?.length, latest});
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
  // Daily summaries (≤60 KB) and weekly recaps are small: a month is about four recaps plus edge days.
  const cap = docs.every(d => d.cat === 'stockbit-ringkasan' || d.cat === 'stockbit-pekan') ? 10 : 6;
  return docs.length && docs.length <= cap ? docs : null;
}
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
