const months = {januari:1,january:1,jan:1,februari:2,february:2,feb:2,maret:3,march:3,mar:3,april:4,apr:4,mei:5,may:5,juni:6,june:6,jun:6,juli:7,july:7,jul:7,agustus:8,august:8,agu:8,aug:8,september:9,sep:9,sept:9,oktober:10,october:10,okt:10,oct:10,november:11,nov:11,desember:12,december:12,des:12,dec:12};
const monthNames = Object.keys(months).join('|');
function validDate(y,m,d) {
  const date = `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const parsed = new Date(date + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === date ? date : null;
}
export function dateQuery(question, history = []) {
  const full = text => {
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
  const range = /\b(sebelum|sesudah|setelah|sampai|hingga|sejak|antara|before|after|between|until)\b/i.test(question) ||
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
  return {clarification:`Tanggal ${short[1]} bulan dan tahun berapa? Contoh: “tanggal ${short[1]} September 2026”.`, filter:false};
}

const pattern = term => new RegExp('(?<![\\p{L}\\p{N}_])' + term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replace(/\s+/g,'\\s+') + '(?![\\p{L}\\p{N}_])','iu');
export function selectRecords(data, terms) {
  const patterns = terms.map(pattern), selected = new Set(), rows = data.records;
  for (let i=0;i<rows.length;i++) {
    const row = rows[i];
    if (terms.some(t => row.tickers.includes(t.toUpperCase())) || patterns.some(p => p.test(row.content))) {
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
