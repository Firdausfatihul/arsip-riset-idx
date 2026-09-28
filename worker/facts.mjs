// Correctness layer for agentic mode: data fields reach the model already worded, so it cannot misread them.
// The live test found five such errors: a company called "individu", a per-share price compared with a rupiah
// total, "keeps control" although the form said otherwise, and AGM attendance read as the new board.

// A legal form in the name means a body, whatever label the source gives it.
const LEGAL_FORM = /(^|[\s,.(])(PT|P\.T\.|TBK|LTD|LIMITED|PTE|INC|CORP|CORPORATION|LLC|B\.?V|N\.?V|YAYASAN|KOPERASI|FUND|CV|HOLDINGS?|SEKURITAS|ASURANSI|BANK)(?=$|[\s,.)])/i;
// datacat also lists companies without "PT" and labels them INDIVIDUAL ("WAHANA KONSTRUKSI MANDIRI"):
// one strong business word, or two common company-name words, also mark a body.
const BUSINESS = /\b(KONSTRUKSI|INVESTAMA|INVESTINDO|CAPITAL|KAPITAL|HOLDINGS?|INDUSTRI|INDUSTRIES|INTERNASIONAL|INTERNATIONAL|GROUP|GRUP|RESOURCES|ENERGI|ENERGY|MINERAL|DEVELOPMENT|PROPERTI|PROPERTY|TRADING|LOGISTIK|TEKNOLOGI|DIGITAL|FINANCE|VENTURES?|MANAGEMENT|KONSULTAN|PERKASA|KOMUNIKASI|COMMUNICATIONS?)\b/i;
const NAMEWORD = /\b(MANDIRI|SEJAHTERA|PERSADA|SENTOSA|ABADI|UTAMA|NUSANTARA|MITRA|SARANA|PRIMA|MAKMUR|KARYA|LESTARI|MULIA|BERSAMA|SUKSES|GEMILANG|INDONESIA|GLOBAL|INVESTASI)\b/gi;
export const isCompany = name => typeof name === 'string'
  && (LEGAL_FORM.test(name) || BUSINESS.test(name) || (name.match(NAMEWORD) || []).length >= 2);

export function rupiah(value) {
  if (!Number.isFinite(value)) return null;
  const [unit, size] = value >= 1e12 ? ['triliun', 1e12] : value >= 1e9 ? ['miliar', 1e9] : value >= 1e6 ? ['juta', 1e6] : ['', 1];
  const shown = (value / size).toFixed(size === 1 ? 0 : 1).replace(/\.0$/, '').replace('.', ',');
  return '±Rp' + shown + (unit ? ' ' + unit : '');
}
const grouped = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const TRANSACTION = {SELL:'Penjualan', BUY:'Pembelian', OTHER:'Lainnya', TRANSFER:'Pengalihan', GIFT:'Hibah', INHERITANCE:'Warisan'};

// One table of what each form field means; unit-tested. Form fields are the filer's statements, not findings.
export const GLOSSARY = {
  is_controller: v => 'pelapor menyatakan diri pengendali: ' + (v ? 'ya' : 'tidak'),
  retains_control: v => 'tetap mempertahankan pengendalian: ' + (v ? 'ya' : 'TIDAK') + ' (isian pelapor, bukan penetapan OJK)',
  board: (flag, position, company) => flag ? `formulir menandai pelapor/penandatangan sebagai ${position || 'Direksi/Komisaris'}`
    + (company ? '; pelapor berbentuk badan, jadi ini bukan bukti jabatan di emiten' : '') : null,
};

// Movement (ownership-change filing) as a worded card; the raw flags it replaces are removed.
export function movementCard(m) {
  if (!m || typeof m !== 'object' || !('shares_before' in m) || !Array.isArray(m.lines)) return m;
  const reporter = m.reporter?.name || '', company = isCompany(reporter) || m.reporter?.kind === 'COMPANY';
  const lines = m.lines.map(line => {
    const shares = Number(line.shares), price = Number(line.price), value = shares * price;
    const kind = line.transaction_type_raw || TRANSACTION[line.transaction_type] || line.transaction_type || 'Transaksi';
    return `${kind} ${grouped(shares)} saham` + (price > 0 ? ` @ Rp${grouped(price)} per saham (nilai ${rupiah(value)})` : ' tanpa harga tercatat')
      + (line.transaction_date ? `, tanggal transaksi ${line.transaction_date}` : '');
  });
  const last = m.lines.map(l => l.transaction_date).filter(Boolean).sort().at(-1);
  const card = {
    jenis:'laporan perubahan kepemilikan' + (m.filer_type ? ` (formulir ${m.filer_type})` : ''),
    transaksi:lines,
    sebelum:m.pct_before != null ? `${Number(m.pct_before)}% (${grouped(Number(m.shares_before))} saham)` : undefined,
    sesudah:m.pct_after != null ? `${Number(m.pct_after)}% (${grouped(Number(m.shares_after))} saham)` : undefined,
    dilaporkan:m.report_date ? m.report_date + (last ? `, ${daysBetween(last, m.report_date)} hari setelah transaksi terakhir` : '') : undefined,
    isian_formulir:[m.is_controller != null ? GLOSSARY.is_controller(m.is_controller) : null,
      m.retains_control != null ? GLOSSARY.retains_control(m.retains_control) : null,
      GLOSSARY.board(m.reporter_is_board_member, m.reporter_position, company)].filter(Boolean).join('; ') || undefined,
    lawan_transaksi:'tidak dicantumkan dalam formulir',
  };
  const out = {...m, kartu:card};
  for (const k of ['lines', 'is_controller', 'retains_control', 'reporter_is_board_member', 'reporter_position', 'shares_before', 'shares_after', 'pct_before', 'pct_after'])
    delete out[k];
  return out;
}

// Walks a datacat result: companies labelled INDIVIDUAL are relabelled, movements become cards,
// and every retains_control=false statement is collected for the check after the answer.
export function worded(value, found = []) {
  if (Array.isArray(value)) return value.map(v => worded(v, found));
  if (!value || typeof value !== 'object') return value;
  if ('shares_before' in value && Array.isArray(value.lines)) {
    if (value.retains_control === false)
      found.push({reporter:value.reporter?.name || '', date:value.report_date || '', report:value.report_number || ''});
    value = movementCard(value);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = worded(v, found);
  if (out.kind === 'INDIVIDUAL' && isCompany(out.name)) { out.kind = 'COMPANY'; out.catatan_jenis = 'label datacat INDIVIDUAL dikoreksi: nama berbentuk badan'; }
  return out;
}

// Minutes: resolutions are the new board, attendance is not (the g13 error).
const RESOLUTION = /\b(menyetujui|mengangkat|memberhentikan|menetapkan|memutuskan|mengesahkan|approved?|appoint(?:ed|ing)?)\b/i;
const ATTENDANCE = /\b(hadir|kehadiran|dihadiri|present|attendance)\b/i;
export function typedMinutes(text, docType) {
  if (typeof text !== 'string' || !(docType === 'RUPS_MINUTES' || /risalah/i.test(text.slice(0, 600)))) return text;
  const marked = text.split(/(?<=[.;])\s+/).map(s => RESOLUTION.test(s) ? '[KEPUTUSAN] ' + s : ATTENDANCE.test(s) ? '[KEHADIRAN] ' + s : s).join(' ');
  return 'CATATAN KODE: risalah RUPS. Daftar hadir bukan susunan pengurus baru; susunan baru hanya dari kalimat [KEPUTUSAN].\n' + marked;
}

// Workers Free allows 50 external subrequests per request. Every OpenRouter request (including retries) and
// every live datacat call is counted; tools stop early so the answer still has room.
export class ExternalBudget {
  constructor(cap = 44, reserve = 8) { this.cap = cap; this.reserve = reserve; this.used = 0; this.max = 0; }
  remaining() { return this.cap - this.used; }
  count() { this.used++; this.max = Math.max(this.max, this.used); }
  take() {   // tools: refuse when only the model reserve is left
    if (this.remaining() <= this.reserve) return false;
    this.count();
    return true;
  }
}

// One datacat key serves every analysis in the Durable Object; the API allows 60 requests per minute.
const recent = [];
export async function datacatSlot(perMinute = 45, wait = 2500) {
  for (let waited = 0; ; waited += 250) {
    const now = Date.now();
    while (recent.length && now - recent[0] > 60000) recent.shift();
    if (recent.length < perMinute) { recent.push(now); return true; }
    if (waited >= wait) return false;
    await new Promise(ok => setTimeout(ok, 250));
  }
}

// Checks after the answer, worded by code.
const KEEPS_CONTROL = /\b(tetap|masih)\s+(akan\s+)?(mempertahankan|memegang|menjadi|sebagai)?\s*(pengendali(an)?|kendali)|tidak\s+(akan\s+)?melepas(kan)?\s+(kendali|pengendalian)/i;
export function answerChecks(answer, {retains = []} = {}) {
  const notices = [];
  // An answer that already reports the form's TIDAK is right; only a bare "keeps control" is flagged.
  const reportsNo = /mempertahankan pengendalian[^.\n]{0,40}\bTIDAK\b|\bTIDAK\b[^.\n]{0,80}mempertahankan pengendalian/i.test(answer);
  if (retains.length && KEEPS_CONTROL.test(answer) && !reportsNo) {
    const r = retains[0];
    notices.push(`Pemeriksaan kode: formulir ${r.report || ''} dari ${r.reporter} (${r.date}) berisi "tetap mempertahankan pengendalian: TIDAK" (isian pelapor); `
      + 'pernyataan bahwa pengendalian dipertahankan bertentangan dengan isian itu kecuali ada pernyataan yang lebih baru.');
  }
  // A company name and "individu/perorangan" in the same sentence, within 60 characters.
  const misKind = [...answer.matchAll(/((?:PT\.?|P\.T\.)\s+[\p{Lu}][\p{L}\p{N}&.' -]{2,50}?)(?=[\s,(]|$)[^.\n]{0,60}?\b(individu|perorangan)\b/gu)]
    .map(m => m[1].trim()).filter(isCompany);
  if (misKind.length) notices.push(`Pemeriksaan kode: ${[...new Set(misKind)].slice(0, 3).join(', ')} berbentuk badan usaha, bukan individu.`);
  return notices;
}
