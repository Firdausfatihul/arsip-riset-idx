// Precomputed KSEI signals (tools/ksei_signals.py) at request time. Code did the joins at build time; here it
// picks what matters for the question, hands it to the model with worded sentences, and checks the answer
// covered it. Signals are holding patterns from month-end KSEI lists, never proof of intent.

let loaded = null;
// Generated data has a content fingerprint; older fixtures also retain metadata in their identity.
export const dataVersion = index => index.data_version || JSON.stringify([index.version, index.signals || null, index.ownership || null]);
export async function loadSignals(archive, index) {
  if (!index.signals?.asset) return null;
  const version = dataVersion(index);
  if (loaded?.version !== version) {
    loaded = {version, data:Promise.all([archive.read(index.signals.asset), archive.read(index.signals.history)])
      .then(([signals, history]) => ({signals, history, known:knownNames(signals)}))
      .catch(error => { loaded = null; throw error; })};
  }
  return loaded.data;
}

// Same folding as tools/ksei_signals.py tokkey(): legal forms dropped, word order ignored.
const LEGAL = /\b(PT|TBK|PERSEROAN TERBATAS|THE|LTD|LIMITED|INC|CORP|CORPORATION|PTE|CO|LLC|SA|AG|BV|NV|PERSERO)\b/g;
export const tokkey = name => String(name).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(LEGAL, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
function knownNames(signals) {
  const known = new Set(Object.keys(signals.parties || {}));
  for (const issuer of Object.values(signals.issuers || {})) known.add(tokkey(issuer.n));
  return known;
}

// The longest run of words in a phrase that is a known holder or issuer name ("PT Triple Berkah Bersama
// menjual" -> "Triple Berkah Bersama"); null when nothing in it is known.
export function knownPart(phrase, known) {
  if (!known) return null;
  const words = phrase.split(/\s+/);
  for (let size = words.length; size >= 1; size--)
    for (let i = 0; i + size <= words.length; i++) {
      const part = words.slice(i, i + size).join(' '), key = tokkey(part);
      if (key && key.replace(/ /g, '').length >= 4 && known.has(key)) return part;
    }
  return null;
}

const oref = (refs, t, name, dari, sampai, month) =>
  refs.add(`#kepemilikan=${t}` + (dari ? `&dari=${dari}` : '') + (sampai && sampai !== dari ? `&sampai=${sampai}` : ''), `Kepemilikan ${t} · ${name || t}`, month, 'O');
const RANK = {split:6, transfer:5, cluster:4, rename:4, issuer_holder:3, exit:2, new:2, near5:1};
const TIER = {kuat:3, sedang:2, fakta:1, lemah:0};
// Must-cover items: the strongest inferred links for an issuer (not plain facts), at most six.
export function mustCover(issuer) {
  return (issuer?.signals || []).filter(s => s.tier === 'kuat' || s.tier === 'sedang')
    .sort((a, b) => (TIER[b.tier] - TIER[a.tier]) || (RANK[b.k] - RANK[a.k]) || ((b.pp || b.total || 0) - (a.pp || a.total || 0))).slice(0, 6);
}

// data_kepemilikan views over the signal assets. Output uses the same terse form as the other tools.
export function signalView(data, args, refs, terse) {
  const {signals, history} = data;
  const code = typeof args.ticker === 'string' ? args.ticker.trim().toUpperCase() : '';
  const part = args.bagian || (code ? 'sinyal' : 'pihak');
  if (code) {
    const issuer = signals.issuers[code], holders = history.issuers[code];
    if (!issuer && !holders) return terse({ticker:code, hasil:'tidak ada sinyal KSEI untuk emiten ini (data >1% ' + signals.months[0] + '..' + signals.asof + ')'});
    const name = issuer?.n || holders?.n || code;
    if (part === 'riwayat') {
      const rows = (holders?.holders || []).filter(h => h.pct.some(p => p != null))
        .sort((a, b) => (b.pct.at(-1) ?? 0) - (a.pct.at(-1) ?? 0)).slice(0, 15)
        .map(h => ({nama:h.name, ...(h.names.length > 1 ? {varian:h.names.slice(0, -1)} : {}), pct:h.pct.map(p => p ?? '-').join(' ')}));
      return terse({ref:oref(refs, code, name, signals.months[0], signals.asof, signals.asof), emiten:name, bulan:signals.months.join(' '), pemegang:rows});
    }
    if (part === 'kelompok') {
      const rows = (issuer?.signals || []).filter(s => s.k === 'cluster')
        .map(s => ({ref:oref(refs, code, name, s.dari, s.sampai, s.m), tier:s.tier, kalimat:s.kalimat}));
      return terse({emiten:name, kelompok:rows.length ? rows : 'tidak ada pola pemegang bersama lintas emiten'});
    }
    const wajib = new Set(mustCover(issuer).map(s => s.id));
    const rows = (issuer?.signals || []).slice().sort((a, b) => wajib.has(b.id) - wajib.has(a.id)).slice(0, 12)
      .map(s => ({ref:oref(refs, code, name, s.dari, s.sampai, s.m), ...(wajib.has(s.id) ? {wajib:1} : {}), tier:s.tier, kalimat:s.kalimat}));
    return terse({emiten:name, data:`KSEI >1% akhir bulan ${signals.months[0]}..${signals.asof}`, pemegang_terbesar:issuer?.top,
      sinyal:rows.length ? rows : 'tidak ada', catatan:'sinyal dihitung kode; wajib:1 = harus dibahas; kelompok bukan bukti bertindak bersama'});
  }
  const words = tokkey(args.nama || '').split(' ').filter(w => w.length >= 2);
  if (!words.length) return null;
  const rows = [];
  for (const [key, party] of Object.entries(signals.parties)) {
    if (!words.every(w => key.split(' ').some(k => k === w || (w.length >= 5 && k.startsWith(w))))) continue;
    for (const [t, first, last, pFirst, pLast, pMax] of party.series) {
      rows.push({ref:oref(refs, t, signals.issuers[t]?.n || history.issuers[t]?.n, first, last, last), ticker:t, nama:party.name,
        ...(party.variants.length > 1 ? {varian:party.variants.filter(v => v !== party.name).slice(0, 3)} : {}),
        dari:`${first} ${pFirst}%`, sampai:`${last} ${pLast}%`, maks:pMax});
      if (rows.length >= 30) break;
    }
    if (rows.length >= 30) break;
  }
  const renames = signals.renames.filter(r => words.every(w => tokkey(r.old + ' ' + r.new).includes(w))).map(r => r.kalimat);
  return terse({nama:args.nama, data:`KSEI >1% ${signals.months[0]}..${signals.asof}`, emiten:rows.length ? rows : 'tidak ditemukan di data KSEI >1%',
    ...(renames.length ? {ganti_nama:renames} : {})});
}

// Parties named in must-cover signals, for the automatic second hop (their holdings elsewhere).
export function hopParties(issuers) {
  const out = [];
  for (const issuer of issuers)
    for (const s of mustCover(issuer)) {
      const names = s.k === 'transfer' ? [s.to] : s.k === 'split' ? s.to.map(x => x[0]) : s.k === 'cluster' ? s.members.map(x => x[0]) : s.parties || [];
      for (const name of names) if (name && !out.includes(name)) out.push(name);
    }
  return out.slice(0, 3);
}

// Question with no named entity asking for hidden patterns: the untuned leaderboard is its evidence.
export const SCREENING = /hidden\s*gems?|permata|akumulasi|backdoor|pemecahan blok|terselubung|diam-diam|tersembunyi|pola kepemilikan|screening|saham (apa|mana) yang menarik/i;
export function screeningView(data, refs, terse) {
  const {signals} = data;
  return terse({data:`peringkat otomatis dari sinyal KSEI ${signals.months[0]}..${signals.asof}, belum disetel`,
    emiten:signals.leaderboard.slice(0, 8).map(r => ({ref:oref(refs, r.t, signals.issuers[r.t]?.n, signals.months[0], signals.asof, signals.asof),
      ticker:r.t, skor:r.score, alasan:r.reason}))});
}

// After the answer: must-cover items the answer did not address are appended, worded by code, and an
// absence claim about entities a must-cover signal links gets a note.
const ABSENCE = /\b(tidak (ada |memiliki |terdapat |ditemukan )?(hubungan|keterkaitan|afiliasi)|tidak terkait|bukan bagian|pembeli(nya)? tidak diketahui|tidak diketahui (siapa )?pembeli)/i;
const distinctive = name => tokkey(name).split(' ').filter(w => w.length >= 4 && !/^(INDONESIA|INVESTAMA|NUSANTARA|SEJAHTERA|MANDIRI|INTERNASIONAL|UTAMA|PERSADA|SENTOSA|ABADI)$/.test(w));
export function coverage(answer, items, refs, tickerName) {
  const text = answer.toUpperCase().replace(/[.,]/g, ''), notes = [], missing = [];
  for (const {t, s} of items) {
    // A split lists its buyers as [name, shares]; a transfer names one buyer.
    const shares = [s.shares, s.gain, ...(Array.isArray(s.to) ? s.to.map(x => x[1]) : [])].filter(Number.isFinite).map(String);
    const names = (s.k === 'cluster' ? s.members.map(x => x[0]) : s.parties || []).flatMap(distinctive);
    const covered = shares.some(n => text.includes(n)) || (names.length && names.filter(w => text.includes(w)).length >= Math.min(2, names.length));
    if (!covered) missing.push(`- ${s.kalimat} [${oref(refs, t, tickerName(t), s.dari, s.sampai, s.m)}]`);
  }
  if (missing.length) notes.push('\n\n**Data terhitung sistem yang belum dibahas di atas** (KSEI >1%, dihitung kode):\n' + missing.join('\n'));
  const links = items.filter(({s}) => ['transfer', 'split', 'cluster', 'rename'].includes(s.k));
  if (links.length && ABSENCE.test(answer))
    notes.push(`\n\n*Pemeriksaan kode: data KSEI memuat pola yang menghubungkan pihak terkait (${links.slice(0, 2).map(({s}) => s.kalimat.slice(0, 120)).join(' | ')}); `
      + 'jangan dibaca sebagai "tidak terkait".*');
  return notes.join('');
}
