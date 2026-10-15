#!/usr/bin/env python3
"""Deterministic archive tables for the chat (worker/tables.mjs). Stdlib only: no network, no model.

Called by tools/build_worker.build() after events.json and ksei_history.json exist in the output folder. Every table is
built from the archive (desk files, BEI summaries, KI reports, KSEI and DPS data) with exact matching rules.

Assets written (all JSON, compact):

- claims.json    Stockbit findings from every sbdetail_*.md, one row per finding:
                 {version, days:[iso…], topics:[name…],
                  by_ticker:{KODE:[[fid, date, kind, text, handle, accounts, celah, replies, topics, dup?]]}}
                 kind: R Rumor, K Klaim penulis, P Pertanyaan, M Mengutip keterbukaan, H Hitungan penulis, G Guyon/kode.
                 topics: bitset over TOPICS. dup: later duplicate fids.
- subjects.json  Cross-issuer mentions in BEI/KI issuer sections: {version, by_ticker:{KODE:[[date, filer, doc_name, line,
                 cls, snippet]]}}; cls kreditur|transaksi_saham|anak_usaha|afiliasi|lain.
- entities.json  Exact names (never merged on surname/prefix): {version, names:{norm:{d, k, t:{KODE:[[role, when, pct, src]]},
                 deg, issuer?}}, alias:{alias_norm:[norm…]}, alias_src:{alias_norm:[[norm, doc, line, snippet]]},
                 variants:{token:[archive_word…]}, namelike:[token…], issuer_words:[word…]}. norm = ksei_signals.tokkey.
- links.json     Rumor checks: {version, links:{KODE:{fid:[[verdict, ref, kalimat]]}}} written in Indonesian by code.
                 Keyed per ticker: a cross-issuer finding is checked against each of its tickers separately.
                 verdict: didukung|tercatat|bertentangan|lain|tidak_dapat|tanpa_dasar. A claim dated after the last KSEI
                 month is never "bertentangan" with KSEI: the line says what KSEI shows up to its last month.
- coverage.json  {stockbit:[first,last], bei:[first,last,missing[]], ksei:[first_month,last_month]}.
"""
import bisect
import collections
from datetime import date, timedelta
import json
from pathlib import Path
import re

from evidence_index import markdown_ranges, heading_ticker
from ksei_signals import tokkey, custodian, month as month_name, pct as pct_text, num

VERSION = 'archive-tables-v3'
TABLES = ('claims', 'subjects', 'entities', 'links', 'coverage')
ROOT = Path(__file__).resolve().parents[1]
DESK = ROOT / 'needtobeindexed' / 'idx-signal-desk'

KINDS = {'Rumor': 'R', 'Klaim penulis': 'K', 'Pertanyaan': 'P', 'Mengutip keterbukaan': 'M', 'Hitungan penulis': 'H',
         'Guyon/kode': 'G'}
FINDING = re.compile(r'^- \[(Rumor|Klaim penulis|Pertanyaan|Mengutip keterbukaan|Hitungan penulis|Guyon/kode)\] (.+?) — @(\S+) '
                     r'(\d\d:\d\d)(.*?)\((F\d{8}-\d{4})\)\s*$')
CROSS_PREFIX = re.compile(r'^((?:[A-Z0-9]{4}, )*[A-Z0-9]{4}): ')

# Topic dictionary (word boundaries; "tender" followed by proyek/pengadaan is a procurement tender, not a tender offer).
TOPICS = [
    ('rights_issue', re.compile(r'(?i:rights?\s*issue|\bpmhmetd\b|\bhmetd\b|penawaran umum terbatas|\bput\s+[ivx]+\b)|\b[A-Z]{4}-R\b')),
    ('private_placement', re.compile(r'(?i:private\s*placement|\bpmthmetd\b|tanpa (?:memberikan )?hmetd)|(?<![Gg]rup )(?<![Gg]roup )\bPP\b')),
    ('tender_offer', re.compile(r'(?i:tender\s*offer|penawaran tender|tender wajib|\bmto\b|\bvto\b|\btender\b(?!\s+(?:proyek|pengadaan)))|\bTO\b')),
    ('akuisisi_pengendali', re.compile(r'(?i:akuisisi|diakuisisi|mengakuisisi|pengambilalihan|ambil\s?alih|diambil\s?alih|take\s?over|'
                                       r'pengendali baru|ganti pengendali|perubahan pengendali|berganti pengendali|backdoor|cangkang|'
                                       r'\bcspa\b|term sheet|investor strategis|calon pembeli|injeksi aset|asset injection|inbreng|diambil oleh|dicaplok)')),
    ('merger', re.compile(r'(?i:\bmerger\b|penggabungan usaha|peleburan)')),
    ('buyback', re.compile(r'(?i:buy\s?back|pembelian kembali saham|saham treasuri)')),
    ('stock_split', re.compile(r'(?i:stock\s?split|reverse\s?split|pemecahan (?:nilai )?(?:nominal )?saham|\bsplit\b)')),
    ('dividen', re.compile(r'(?i:dividen|dividend)')),
    ('suspensi_uma', re.compile(r'(?i:suspen\w*|disuspen\w*|\buma\b|unusual market|cooling down|digembok)')),
    ('go_private', re.compile(r'(?i:go\s?private|delisting|\bdelist\w*|penghapusan pencatatan)')),
    ('kontrak', re.compile(r'(?i:kontrak|\bmou\b|kerja\s?sama|pengadaan|proyek baru)')),
    ('kepemilikan', re.compile(r'(?i:pemegang saham|kepemilikan|memegang saham|pemilik|\bowner\b|\bholder\b|insider|\bksei\b|'
                               r'menjual saham|membeli saham|crossing|pasar nego)')),
    # Appended topics keep the bit positions of the ones above.
    ('pailit', re.compile(r'(?i:pailit|\bpkpu\b|likuidasi|dilikuidasi|bangkrut)')),
    ('rups', re.compile(r'(?i:\brups\w*|kuorum|rapat umum)')),
]
TOPIC_NAMES = [name for name, _ in TOPICS]
TOPIC_RX = dict(TOPICS)
TOPIC_BIT = {name: 1 << i for i, name in enumerate(TOPIC_NAMES)}
# Corporate-action topics: rumors of these are checked against disclosures and listed by the rare-rumor route.
CA_TOPICS = ('rights_issue', 'private_placement', 'tender_offer', 'akuisisi_pengendali', 'merger', 'buyback', 'stock_split',
             'go_private', 'pailit')
CA_MASK = sum(TOPIC_BIT[t] for t in CA_TOPICS)
# BEI categories that can carry each topic (bei-index rows); the row's own text must match the topic too.
TOPIC_CATEGORIES = {
    'akuisisi_pengendali': ('pengurus_pengendali', 'aksi_korporasi'),
    'rights_issue': ('struktur_modal', 'aksi_korporasi'),
    'private_placement': ('struktur_modal', 'aksi_korporasi'),
    'tender_offer': ('aksi_korporasi', 'pengurus_pengendali'),
    'merger': ('aksi_korporasi',),
    'buyback': ('aksi_korporasi', 'struktur_modal'),
    'stock_split': ('aksi_korporasi', 'struktur_modal'),
    'go_private': ('aksi_korporasi', 'regulasi_bursa'),
    'pailit': ('hukum', 'aksi_korporasi', 'lainnya'),
}
LINK_WINDOW = 45
CONTROL_MASK = sum(TOPIC_BIT[t] for t in ('akuisisi_pengendali', 'tender_offer', 'go_private', 'merger'))

STOP = set('aksi laba uang asli area daya real live kbli jaya food nice best safe home good care indo data pada naik'.split())
# A lowercase code counts only right next to one of these words ("saham grpm", "grpm tbk").
CUE = {'saham', 'emiten', 'tbk'}
# Credit wording first: a loan that funds an acquisition names the lender, not a share deal. A share transaction needs "saham".
VERB_CLASSES = [
    ('kreditur', re.compile(r'(?i:pinjaman|fasilitas kredit|kreditur|kreditor|\bbank\b|utang)')),
    ('transaksi_saham', re.compile(r'(?i:penjualan|pembelian|pengalihan|pengambilalihan|term sheet|\bcspa\b|tender|\bvto\b|\bmto\b|inbreng|'
                                   r'menjual|membeli|mengakuisisi|akuisisi|divestasi)')),
    ('anak_usaha', re.compile(r'(?i:anak usaha|entitas anak|anak perusahaan|subsidiary|entitas asosiasi)')),
    ('afiliasi', re.compile(r'(?i:afiliasi|terafiliasi|pihak berelasi|hubungan istimewa)')),
]
SUBJECT_CATS = ('bei-ringkasan', 'bei-detail', 'keterbukaan-informasi')

# Role sentences in BEI detail sections and in quoted disclosures. Person roles never take a "PT …" name.
PERSON_ROLE = re.compile(r'\b(Presiden Direktur|Direktur Utama|Direktur Independen|Direktur|Presiden Komisaris|Komisaris Utama|'
                         r'Komisaris Independen|Komisaris)\s+(?:baru\s+)?(?:(?:Drs?|Ir|H|Hj|Prof|dr)\.?\s+)?'
                         r"([A-Z][A-Za-z'-]+(?:\s+(?:[A-Z][A-Za-z'.-]+|bin|binti)){1,4})")
PARTY_ROLE = re.compile(r'\b(Pembeli|Penjual|Pengendali baru|Pengendali|Calon pengendali)\s*[:=]?\s+'
                        r"((?:PT\.?\s+)?[A-Z][A-Za-z'.&-]+(?:\s+[A-Z][A-Za-z'.&-]+){1,5})")
PARTY_AFTER = re.compile(r"((?:PT\.?\s+)?[A-Z][A-Za-z'.&-]+(?:\s+[A-Z][A-Za-z'.&-]+){1,5})\s*\((Pembeli|Penjual(?: \d)?|Pengendali)\)")
SERVICE_ROLE = re.compile(r'\b(BAE|Biro Administrasi Efek|KAP|Kantor Akuntan Publik)\s+'
                          r"((?:PT\.?\s+)?[A-Z][A-Za-z'.&,-]+(?:\s+(?:[A-Z&][A-Za-z'.&,-]*|dan)){1,6})")
NAME_STOP = set('''Perseroan Keuangan Kepatuhan Bisnis Niaga Operasional Non No Nomor Independen TI Finance Armada Pemasaran
Manajemen Siaga Periode Oleh Baru Perusahaan Utama Tbk Rapat Umum Pemegang Saham Dewan Direksi Komisaris Direktur Sekretaris
Teknik Produksi Investasi Hukum Sumber Daya Manusia Risiko Kredit Ritel Korporasi Usaha Syariah Digital Teknologi Informasi
Pengembangan Strategi Komersial Umum Lama Sebelumnya Semua Seluruh Para Yang Dan Atas Untuk Dalam Pada Sebagai Selaku
Indonesia Jakarta Laporan Anggaran Dasar Akta Surat Berdasarkan Sesuai Tanggal Bapak Ibu Sdr Sdri Tuan Nyonya'''.split())
TITLE = re.compile(r'^(?:Drs?|Ir|H|Hj|Prof|dr|Bapak|Ibu|Tuan|Nyonya)\.?\s+')
GROUP_PATTERNS = [
    # "PT Tunas Binatama Lestari, disebut bagian Rimau Group" / "PT X bagian dari Y Group"
    (re.compile(r"PT\.? ([A-Z][\w ]+?),? (?:disebut |merupakan )?bagian (?:dari )?(?:[Gg]rup |[Gg]roup )?([A-Z]\w+)(?: Group| Grup)?\b"), 'member'),
    # "Rimau Group melalui PT X"
    (re.compile(r"\b([A-Z]\w+) Group melalui PT\.? ([A-Z][\w ]+?)(?=[,.;)]|\s(?:yang|dan|sebagai)\b|$)"), 'group_first'),
    # "NFT (Grup Arsari)" / "Nusantara Fiber Teknologi (Group Arsari)"
    (re.compile(r"((?:PT\.? )?[A-Z][\w]+(?: [A-Z][\w]+){0,4}) \((?:[Gg]rup|[Gg]roup) ([A-Z]\w+)\)"), 'member'),
    # "grup Arsari milik Hasyim" (owner named in text)
    (re.compile(r"\b(?:[Gg]rup|[Gg]roup) ([A-Z]\w+) milik '?([A-Z][a-z]+(?: [A-Z][a-z]+){0,3})"), 'group_owner'),
]
# Explicit group text is read from reports, disclosures and (as retrieval aliases only, source line kept) Stockbit details.
GROUP_CATS = ('bei-detail', 'bei-ringkasan', 'keterbukaan-informasi', 'stockbit', 'keterbukaan-australia', 'keterbukaan-singapura',
              'stockbit-detail')
ROLE_BITS = [(1, '>=5%'), (2, 'pengendali'), (4, 'afiliasi'), (8, 'direksi'), (16, 'komisaris')]
SERVICE_ROLES = {'BAE', 'KAP'}
FIRM = re.compile(r'\b(PT|TBK|LTD|LIMITED|PTE|INC|CORP|CORPORATION|LLC|B\.?V|N\.?V|HOLDINGS?|GROUP|CAPITAL|FUND|BANK|'
                  r'INVESTAMA|INVESTMENT|SEKURITAS|ASURANSI|KOPERASI|YAYASAN|DANA PENSIUN|PERSERO|SA|AG)\b', re.I)


def _json(path):
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _clip(text, n=240):
    text = ' '.join(str(text).split())
    return text if len(text) <= n else text[:n - 1] + '…'


def _norm_text(text):
    return ' '.join(re.sub(r'\W+', ' ', text.lower()).split())


def topics_of(text):
    """Topic bitset of a claim or sentence."""
    bits = 0
    for name, rx in TOPICS:
        if rx.search(text):
            bits |= TOPIC_BIT[name]
    return bits


def topic_names(bits):
    return [name for name in TOPIC_NAMES if bits & TOPIC_BIT[name]]


class Lines:
    """Line number (1-based) for a character offset."""
    def __init__(self, text):
        self.starts = [0] + [m.end() for m in re.finditer('\n', text)]

    def at(self, offset):
        return bisect.bisect_right(self.starts, offset)


# ---------------------------------------------------------------------------------------------------------------
# 1. Claims
def parse_claims(detail_docs, tickers):
    """detail_docs: [{name, start, body}] of sbdetail_*.md. Returns the claims.json dict."""
    by_ticker, seen_text, days = {}, {}, set()
    for doc in sorted(detail_docs, key=lambda d: (d['start'], d['name'])):
        day, section = doc['start'], None
        days.add(day)
        for line in doc['body'].split('\n'):
            if line.startswith('## '):
                title = line[3:].strip()
                section = title if title in tickers else ('*' if title == 'Lintas emiten' else None)
                continue
            m = FINDING.match(line) if section and line.startswith('- [') else None
            if not m:
                continue
            label, text, handle, _time, tail, fid = m.groups()
            text = text.strip()
            codes = [section]
            if section == '*':
                p = CROSS_PREFIX.match(text)
                codes = [c for c in p[1].split(', ') if c in tickers] if p else []
            extra = re.search(r'\+(\d+) akun', tail)
            total = re.search(r'dari (\d+) akun', tail)
            accounts = 1 + int(extra[1]) if extra else int(total[1]) if total else 1
            celah = re.search(r'celah: ([^·(]+)', tail)
            replies = re.search(r'(\d+) balasan', tail)
            row = [fid, day, KINDS[label], text, handle.lower(), accounts, celah[1].strip() if celah else '',
                   int(replies[1]) if replies else 0, topics_of(text)]
            for code in codes:
                rows = by_ticker.setdefault(code, [])
                first = seen_text.get((code, _norm_text(text)))
                if first is None:
                    seen_text[(code, _norm_text(text))] = len(rows)
                    rows.append(list(row))
                elif fid != rows[first][0]:
                    # A later finding with the same text folds into the first row as a duplicate fid.
                    target = rows[first]
                    if len(target) < 10:
                        target.append([])
                    if fid not in target[9]:
                        target[9].append(fid)
    return {'version': VERSION, 'days': sorted(days), 'topics': TOPIC_NAMES, 'by_ticker': dict(sorted(by_ticker.items()))}


# ---------------------------------------------------------------------------------------------------------------
# 2. BEI index rows per ticker (input of the rumor checks; not written as an asset)
def bei_table(path):
    """{days:set(iso), tickers:{KODE:[[date, status, delta, {kategori:n}]]}, names:{KODE:name}} from bei-index.json."""
    data = _json(path)
    if not data:
        return None
    days = data.get('days') or []
    out = {'days': {d['d'] for d in days if d.get('d')}, 'tickers': {}, 'names': data.get('names') or {}}
    for code, rows in sorted((data.get('tickers') or {}).items()):
        trimmed = [[days[r[0]]['d'], r[3], r[5], r[6]] for r in rows
                   if isinstance(r, list) and len(r) >= 7 and isinstance(r[0], int) and 0 <= r[0] < len(days)]
        if trimmed:
            out['tickers'][code] = sorted(trimmed, key=lambda x: x[0])
    return out


# ---------------------------------------------------------------------------------------------------------------
# 3. Subjects: other issuers named in an issuer section
def core_name(name):
    words = re.sub(r'\((?:Persero)\)|\b(?:PT|Tbk|TBK|Persero|d/h)\b|[^\w\s&-]', ' ', name).split()
    return [w.lower() for w in words]


def name_index(official):
    """official: {KODE: [names]} -> {first word: [(tuple words, KODE)]} for core names of >=2 words and >=8 chars."""
    index = collections.defaultdict(list)
    for code, names in official.items():
        for name in names:
            words = core_name(name)
            if len(words) >= 2 and len(' '.join(words)) >= 8:
                index[words[0]].append((tuple(words), code))
    for k in index:
        index[k].sort(key=lambda x: -len(x[0]))
    return index


def classify(sentence):
    for cls, rx in VERB_CLASSES:
        if rx.search(sentence) and (cls != 'transaksi_saham' or re.search(r'(?i)\bsaham\b', sentence)):
            return cls
    return 'lain'


def _sentence(text, pos):
    starts = [0] + [m.end() for m in re.finditer(r'(?<=[.;!?])\s+', text)]
    i = bisect.bisect_right(starts, pos) - 1
    end = starts[i + 1] if i + 1 < len(starts) else len(text)
    return text[starts[i]:end].strip()


def clean_line(line):
    line = re.sub(r'\]\([^)]*\)', ']', line)
    line = re.sub(r'https?://\S+', ' ', line)
    # snake_case identifiers ("realisasi_pembelian_CPO_dari_PT_BUMI_AGRO_PRIMA") are not prose mentions.
    line = re.sub(r'\w*_\w*', ' ', line)
    return re.sub(r'(?<![\w@])@\w+', ' ', line)


def issuer_sections(body, tickers):
    """[(owner, start, end)] for Markdown issuer sections (same rule as evidence_index)."""
    out = []
    for start, end, _ in markdown_ranges(body, tickers):
        title = re.match(r'#{1,6}\s+([^\n]+)', body[start:end])
        owner = heading_ticker(title[1], tickers) if title else None
        if owner:
            out.append((owner, start, end))
    return out


def scan_subjects(docs, tickers, official, plain_words=()):
    """Cross-issuer mentions. docs: [{name, cat, start, body}]. Returns {KODE: [[date, filer, doc, line, cls, snippet]]}."""
    names = name_index(official)
    blocked = set(plain_words) | STOP
    out, seen = collections.defaultdict(list), set()
    for doc in docs:
        if doc['cat'] not in SUBJECT_CATS or not doc['name'].endswith('.md'):
            continue
        body, lines = doc['body'], Lines(doc['body'])
        official_doc = doc['cat'].startswith('bei-')
        for owner, start, end in issuer_sections(body, tickers):
            offset = start
            for raw in body[start:end].split('\n'):
                line_no = lines.at(offset)
                offset += len(raw) + 1
                if raw.lstrip().startswith('#') or not raw.strip() or re.search(r'(?i)^\s*(?:[-*]\s*)?lampiran\b|\.pdf\b', raw):
                    continue
                text = clean_line(raw)
                toks = list(re.finditer(r'[A-Za-z0-9]+', text))
                low = [t.group().lower() for t in toks]
                found = {}
                for m in re.finditer(r'\(([A-Za-z]{4})\)', text):
                    code = m[1].upper()
                    before = text[:m.start()].rstrip()
                    if code in tickers and code != owner and re.search(r'(?:[A-Z][\w.]*|Tbk)$', before):
                        found.setdefault(code, m.start())
                for i, t in enumerate(toks):
                    w = t.group()
                    code = w.upper()
                    if code == owner or code not in tickers:
                        continue
                    if w.islower() and len(w) == 4 and w not in blocked:
                        if {low[i - 1] if i else '', low[i + 1] if i + 1 < len(low) else ''} & CUE:
                            found.setdefault(code, t.start())
                    elif w.isupper() and official_doc and code not in found:
                        if classify(_sentence(text, t.start())) != 'lain':
                            found.setdefault(code, t.start())
                for i, w in enumerate(low):
                    # Longest official name first; the filer's own longer name ("Wijaya Karya Beton" in WTON's section)
                    # is not a mention of the shorter one (WIKA).
                    for words, code in names.get(w, ()):
                        if tuple(low[i:i + len(words)]) == words:
                            if code != owner:
                                found.setdefault(code, toks[i].start())
                            break
                for code, pos in found.items():
                    key = (code, doc['name'], line_no)
                    if key in seen:
                        continue
                    seen.add(key)
                    sentence = _sentence(text, pos)
                    out[code].append([doc['start'], owner, doc['name'], line_no, classify(sentence),
                                      _clip(sentence.lstrip('-* |'), 240)])
    return {code: sorted(rows, key=lambda r: (r[0], r[2], r[3])) for code, rows in sorted(out.items())}


# ---------------------------------------------------------------------------------------------------------------
# 4. Entities
def _kind(name, cls=''):
    return 'firm' if FIRM.search(name) or cls in ('Corporate',) else 'person'


def _clean_name(name):
    name = TITLE.sub('', name.strip().rstrip('.,;'))
    words = name.split()
    while words and words[-1] in NAME_STOP:
        words.pop()
    return ' '.join(words)


def _valid_person(name):
    words = name.split()
    return len(words) >= 2 and words[0] not in NAME_STOP and not any(w in ('PT', 'PT.', 'Tbk') for w in words) \
        and sum(w in NAME_STOP for w in words) == 0


def role_mentions(text):
    """Exact role sentences: [(role, name, kind, offset)]. Person roles never take a "PT" name; titles are stripped."""
    out = []
    for m in PERSON_ROLE.finditer(text):
        name = _clean_name(m[2])
        if _valid_person(name):
            out.append((m[1].lower(), name, 'person', m.start()))
    for rx in (PARTY_ROLE, PARTY_AFTER):
        for m in rx.finditer(text):
            role, name = (m[1], m[2]) if rx is PARTY_ROLE else (m[2], m[1])
            name = _clean_name(name)
            words = [w for w in name.split() if w not in ('PT', 'PT.')]
            if len(words) >= 2 and words[0] not in NAME_STOP:
                out.append((re.sub(r' \d$', '', role.lower()), name, _kind(name), m.start()))
    for m in SERVICE_ROLE.finditer(text):
        name = _clean_name(m[2].rstrip(','))
        if len(name.split()) >= 1 and name.split()[0] not in NAME_STOP:
            role = 'BAE' if m[1] in ('BAE', 'Biro Administrasi Efek') else 'KAP'
            out.append((role, name, 'firm', m.start()))
    return out


def group_mentions(text):
    """Explicit group text: [(group, member, kind, offset)]; kind member|group_owner."""
    out = []
    for rx, kind in GROUP_PATTERNS:
        for m in rx.finditer(text):
            member, group = (m[1], m[2]) if kind == 'member' else (m[2], m[1])
            member = _clean_name(member)
            if group in NAME_STOP or not member or len(member) < 3:
                continue
            out.append((group, member, kind, m.start()))
    return out


def _edits1(word):
    return {word[:i] + word[i + 1:] for i in range(len(word))}


def edit_distance_le1(a, b):
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    if len(a) > len(b):
        a, b = b, a
    return a in _edits1(b)


def spelling_variants(tokens, vocabulary):
    """{token: [archive words within edit distance 1, same first letter, >=5 chars]} (deletion-neighbourhood index)."""
    index = collections.defaultdict(set)
    vocab = {w for w in vocabulary if len(w) >= 5 and w.isalpha()}
    for w in vocab:
        index[w].add(w)
        for d in _edits1(w):
            index[d].add(w)
    out = {}
    for token in tokens:
        if len(token) < 5 or not token.isalpha():
            continue
        cands = set(index.get(token, ()))
        for d in _edits1(token):
            cands |= index.get(d, set())
        found = sorted(w for w in cands if w != token and w[0] == token[0] and edit_distance_le1(w, token))
        if found:
            out[token] = found
    return out


def name_like(tokens, texts):
    """Tokens the archive text writes capitalised at least twice and mostly so ("Tanoko", "Rimau"): names, not ordinary
    words ("gede" is one Balinese name in the indexed text and slang in questions)."""
    wanted, counts = set(tokens), collections.defaultdict(lambda: [0, 0])
    for text in texts:
        for w in re.findall(r'[A-Za-z]{4,}', text):
            low = w.lower()
            if low in wanted:
                counts[low][0 if w[0].isupper() else 1] += 1
    return sorted(t for t, (cap, low) in counts.items() if cap >= 2 and cap >= low)


def build_entities(history, reports, docs, claims, official, vocabulary, texts=()):
    """history: ksei_history.json; reports: kepemilikan-laporan.json; docs: BEI/KI/Stockbit docs with body;
    claims: claims.json; official: {KODE:[names]}. Exact names only; no surname or prefix merging."""
    names = {}

    def add(name, kind, code, role, when, pct, src):
        key = tokkey(name)
        if not key or len(key.replace(' ', '')) < 4:
            return None
        entry = names.setdefault(key, {'d': name.strip(), 'k': kind, 't': {}})
        if kind == 'group' or (entry['k'] == 'person' and kind == 'firm'):
            entry['k'] = kind
        if code:
            rows = entry['t'].setdefault(code, [])
            row = [role, when, pct, src]
            if row not in rows and len(rows) < 8:
                rows.append(row)
        return key

    if history:
        months = history.get('months') or []
        for code, issuer in (history.get('issuers') or {}).items():
            usable = issuer.get('usable') or [True] * len(months)
            for h in issuer.get('holders') or []:
                if custodian(h.get('name', ''), h.get('cls', '')):
                    continue
                idx = [i for i, p in enumerate(h.get('pct') or []) if p is not None and (i >= len(usable) or usable[i])]
                if not idx:
                    continue
                kind = 'person' if h.get('cls') == 'Individual' else _kind(h['name'], h.get('cls', ''))
                for i in sorted({idx[0], idx[-1]}):
                    add(h['name'], kind, code, 'ksei', months[i], h['pct'][i], 'KSEI')
    if reports:
        rmonths, rnames = reports.get('months') or [], reports.get('names') or []
        for code, company in (reports.get('companies') or {}).items():
            entries = company.get('d') or []
            latest, when = None, None
            for i in range(len(entries) - 1, -1, -1):
                e = entries[i]
                e = entries[e] if isinstance(e, int) and 0 <= e < len(entries) else e
                if isinstance(e, dict) and e.get('h'):
                    latest, when = e, rmonths[i] if i < len(rmonths) else None
                    break
            for h in (latest or {}).get('h') or []:
                if not isinstance(h, list) or not h or not isinstance(h[0], int) or h[0] >= len(rnames):
                    continue
                name, bits = rnames[h[0]], h[1] or 0
                roles = [label for bit, label in ROLE_BITS if bits & bit] or ['pemegang']
                if re.search(r'(?i)masyarakat|publik|lainnya|treasur|saham treasuri|jumlah|total', name):
                    continue
                for role in roles:
                    add(name, _kind(name), code, role, when, h[3] if len(h) > 3 else None, 'DPS')
    alias, alias_src = collections.defaultdict(list), collections.defaultdict(list)
    for doc in docs:
        body, lines = doc['body'], Lines(doc['body'])
        ranges = issuer_sections(body, set(official)) if doc['cat'] == 'bei-detail' else []
        for owner, start, end in ranges:
            section = body[start:end]
            for role, name, kind, off in role_mentions(section):
                line = lines.at(start + off)
                add(name, kind, owner, role, doc['start'], None, f'{doc["name"]}#{line}')
        if doc['cat'] in GROUP_CATS:
            text = re.sub(r'<[^>]+>', ' ', body) if doc.get('kind') == 'html' else body
            tl = Lines(text)
            for group, member, kind, off in group_mentions(text):
                gkey = add(group, 'group', None, None, None, None, None)
                mkey = add(member, 'person' if kind == 'group_owner' else _kind(member), None, None, None, None, None)
                if not gkey or not mkey or gkey == mkey:
                    continue
                line = tl.at(off)
                snippet = _clip(text[max(0, text.rfind('\n', 0, off) + 1):text.find('\n', off) if text.find('\n', off) > 0 else None], 220)
                for a, b in ((gkey, mkey), (mkey, gkey)):
                    if b not in alias[a]:
                        alias[a].append(b)
                if len(alias_src[gkey]) < 6:
                    alias_src[gkey].append([mkey, doc['name'], line, snippet])
    # Quoted disclosures in Stockbit findings ("Komisaris Utama Hashim Djojohadikusumo mundur"): role sentences only.
    for code, rows in (claims or {}).get('by_ticker', {}).items():
        for row in rows:
            if row[2] != 'M':
                continue
            for role, name, kind, _off in role_mentions(row[3]):
                add(name, kind, code, role, row[1], None, row[0])
    for key, entry in names.items():
        entry['deg'] = len(entry['t'])
        roles = {r[0] for rows in entry['t'].values() for r in rows}
        if entry['deg'] > 5 and roles & (SERVICE_ROLES | {'kustodian'}):
            entry['k'] = 'service'
    issuer_keys = {tokkey(n): code for code, ns in official.items() for n in ns}
    for key, entry in names.items():
        if key in issuer_keys:
            entry['issuer'] = issuer_keys[key]
    person_tokens = {w.lower() for key, e in names.items() if e['k'] in ('person', 'group') for w in key.split() if len(w) >= 5}
    all_tokens = {w.lower() for key in names for w in key.split() if len(w) >= 4 and w.isalpha()}
    return {'version': VERSION, 'names': dict(sorted(names.items())), 'alias': dict(sorted(alias.items())),
            'alias_src': dict(sorted(alias_src.items())), 'variants': spelling_variants(sorted(person_tokens), vocabulary),
            'namelike': name_like(all_tokens, texts),
            # Words of issuers' official names ("telkom", "adaro"): such questions go to the ticker search, not name cards.
            'issuer_words': sorted({w for ns in official.values() for n in ns for w in core_name(n) if len(w) >= 4 and w.isalpha()})}


# ---------------------------------------------------------------------------------------------------------------
# 5. Rumor ledger
SELL = re.compile(r'(?i:menjual|jual|melepas|lepas|distribusi|buang|keluar|mengurangi|dilepas|guyur)')
BUY = re.compile(r'(?i:membeli|beli|akumulasi|menambah|nampung|menampung|borong|serok)')
GENERIC_TOKENS = {'INDONESIA', 'INVESTAMA', 'NUSANTARA', 'SEJAHTERA', 'MANDIRI', 'INTERNASIONAL', 'INTERNATIONAL', 'UTAMA', 'PERSADA',
                  'SENTOSA', 'ABADI', 'GROUP', 'GLOBAL', 'CAPITAL', 'ASIA', 'PRIMA', 'JAYA', 'MAKMUR', 'BANK', 'INVESTMENT',
                  'INVESTMENTS', 'HOLDINGS', 'HOLDING', 'PERKASA', 'LESTARI', 'MULIA', 'SUKSES', 'TRADING', 'KARYA', 'BERSAMA',
                  'SEKURITAS', 'SECURITIES', 'ASURANSI', 'LIMITED', 'PRIVATE', 'MITRA', 'DANA', 'INVESTINDO', 'SARANA', 'CIPTA'}


def _days_between(a, b):
    return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)


def _holder_tokens(history):
    freq = collections.Counter()
    for issuer in (history or {}).get('issuers', {}).values():
        for h in issuer.get('holders') or []:
            freq.update(set(tokkey(h.get('name', '')).split()))
    return freq


def build_links(claims, bei, subjects, history, cov):
    """claims.json, bei_table(), subjects, ksei_history.json, coverage -> {KODE: {fid: [[verdict, ref, kalimat]]}}.
    Only same-type (topic and category/text) or same-party (holder named in the claim) links count as support; time
    proximity or a similar percentage is never support. Checks are per ticker: a finding filed under several tickers gets
    each ticker's own disclosures, never another ticker's; a finding whose text names another ticker first is not checked."""
    months = (history or {}).get('months') or []
    freq = _holder_tokens(history)
    known = set(claims.get('by_ticker', {})) | set((bei or {}).get('tickers', {}))
    bei_first, bei_last = (cov.get('bei') or [None, None])[:2]
    ksei_last = (cov.get('ksei') or [None, None])[1]
    links = {}
    for code, rows in claims.get('by_ticker', {}).items():
        issuer = (history or {}).get('issuers', {}).get(code) or {}
        usable = issuer.get('usable') or [True] * len(months)
        ok = [i for i in range(len(months)) if i >= len(usable) or usable[i]]
        issuer_last = months[ok[-1]] if ok else None
        holders = [h for h in issuer.get('holders') or [] if not custodian(h.get('name', ''), h.get('cls', ''))]
        bei_rows = (bei or {}).get('tickers', {}).get(code, [])
        subj_rows = [s for s in subjects.get(code, []) if s[4] == 'transaksi_saham']
        for row in rows:
            fid, day, kind, text, bits = row[0], row[1], row[2], row[3], row[8]
            if kind not in ('R', 'M', 'H') and not (kind == 'K' and bits):
                continue
            # "FORU diduga akan right issue seperti BABY" filed under BABY is about FORU.
            if next((w for w in re.findall(r'\b[A-Z]{4}\b', text) if w in known), code) != code:
                continue
            out = []
            ca = [t for t in CA_TOPICS if bits & TOPIC_BIT[t]]
            # (a) BEI rows of the same ticker within the window whose category and own change text match the topic.
            other = None
            for r in sorted(bei_rows, key=lambda r: _days_between(r[0], day)):
                if _days_between(r[0], day) > LINK_WINDOW or r[1] == 'rutin':
                    continue
                cats = set((r[3] or {}).keys())
                if any(cats & set(TOPIC_CATEGORIES.get(t, ())) and TOPIC_RX[t].search(r[2] or '') for t in ca):
                    out.append(['didukung', 'bei', r[0], f'didukung keterbukaan {r[0]} ({r[1]}; {", ".join(sorted(cats))}): {_clip(r[2], 160)}'])
                    break
                if other is None and cats - {'rutin'}:
                    other = r
            # (b) Another issuer's announcement of a share transaction naming this ticker (control/tender topics only),
            # the one closest in date.
            near_subj = [s for s in subj_rows if _days_between(s[0], day) <= LINK_WINDOW * 4]
            if bits & CONTROL_MASK and near_subj:
                s = min(near_subj, key=lambda s: _days_between(s[0], day))
                out.append(['didukung', 'subjek', f'{s[2]}#{s[3]}',
                            f'didukung keterbukaan {s[0]} (pengumuman {s[1]} menyebut {code}): {_clip(s[5], 160)}'])
            # (c) KSEI holders named by a distinctive token of their name (verified months only).
            words = set(re.findall(r'[A-Z0-9]+', text.upper()))
            for h in holders:
                sh = h.get('sh') or [None] * len(months)
                series = [(months[i], p, sh[i] if i < len(sh) else None) for i, p in enumerate(h.get('pct') or [])
                          if p is not None and i < len(months) and i in ok]
                # The ticker itself is in most claims about it: "PT AVIA AVIAN Tbk" is not named by an AVIA claim.
                toks = [t for t in tokkey(h['name']).split() if len(t) >= 4 and t != code and t not in GENERIC_TOKENS and freq[t] <= 10]
                if not series or not any(t in words for t in toks):
                    continue
                last_m, last_p, _ = series[-1]
                recent = series[-3:]
                trend = ''
                if len(recent) >= 2 and recent[0][2] and recent[-1][2] and recent[0][2] != recent[-1][2]:
                    up = recent[-1][2] > recent[0][2]
                    trend = (f'{"naik" if up else "turun"} {num(recent[0][2])}→{num(recent[-1][2])} lembar '
                             f'{month_name(recent[0][0])}–{month_name(recent[-1][0])}')
                    sells, buys = bool(SELL.search(text)), bool(BUY.search(text))
                    # A claim made after the last KSEI month cannot be contradicted by it: KSEI is stated neutrally below.
                    if day[:7] <= last_m and ((sells and not buys and up) or (buys and not sells and not up)):
                        out.append(['bertentangan', 'ksei', last_m,
                                    f'bertentangan dengan KSEI s.d. {month_name(last_m)}: {h["name"]} {trend}'])
                        continue
                if last_m < issuer_last:
                    line = (f'{h["name"]} terakhir tercatat >1% di KSEI {month_name(last_m)} ({pct_text(last_p)}%); '
                            f'tidak lagi >1% s.d. {month_name(issuer_last)}')
                elif day[:7] > last_m:
                    line = (f'KSEI s.d. {month_name(last_m)} mencatat {h["name"]} {pct_text(last_p)}%' + (f' ({trend})' if trend else '')
                            + f'; belum ada data KSEI untuk {month_name(day[:7])}')
                else:
                    line = f'pihak tercatat di KSEI ({month_name(last_m)}, {pct_text(last_p)}%): {h["name"]}' + (f'; {trend}' if trend else '')
                out.append(['tercatat', 'ksei', last_m, line])
                if len([o for o in out if o[1] == 'ksei']) >= 2:
                    break
            if not any(o[0] == 'didukung' for o in out):
                if other is not None:
                    out.append(['lain', 'bei', other[0], f'ada keterbukaan lain, topik berbeda: {other[0]} ({other[1]}; '
                                f'{", ".join(sorted((other[3] or {}).keys()))})'])
                if ca:
                    gaps = [d for d in (cov.get('bei') or [None, None, []])[2] if _days_between(d, day) <= 7]
                    if bei_last and day > bei_last or len(gaps) >= 2:
                        out.append(['tidak_dapat', 'cakupan', day, f'tidak dapat diperiksa: cakupan BEI tidak mencakup sekitar {day}'])
                    elif other is None:
                        out.append(['tanpa_dasar', 'cakupan', day,
                                    f'belum ada keterbukaan sejenis dalam cakupan BEI {bei_first}..{bei_last}'])
                if bits & TOPIC_BIT['kepemilikan'] and not any(o[1] == 'ksei' for o in out) and ksei_last and day[:7] > ksei_last:
                    out.append(['tidak_dapat', 'cakupan', ksei_last, f'tidak dapat diperiksa ke KSEI: data KSEI hanya s.d. {month_name(ksei_last)}'])
            if out:
                # The kind column (o[1]) is only used above; the written row is [verdict, ref, kalimat].
                links.setdefault(code, {})[fid] = [[o[0], o[2], o[3]] for o in out[:4]]
    return {'version': VERSION, 'links': links}


# ---------------------------------------------------------------------------------------------------------------
# 6. Coverage
def _calendar(first, last):
    d, end = date.fromisoformat(first), date.fromisoformat(last)
    while d <= end:
        yield d
        d += timedelta(days=1)


def coverage(stockbit_days, bei_days, ksei_months):
    out = {}
    if stockbit_days:
        have = set(stockbit_days)
        first, last = min(have), max(have)
        out['stockbit'] = [first, last]
    if bei_days:
        have = set(bei_days)
        first, last = min(have), max(have)
        out['bei'] = [first, last, [d.isoformat() for d in _calendar(first, last) if d.isoformat() not in have and d.weekday() < 5]]
    if ksei_months:
        out['ksei'] = [ksei_months[0], ksei_months[-1]]
    return out


# ---------------------------------------------------------------------------------------------------------------
def official_names(events, bei):
    official = collections.defaultdict(list)
    for code, name in ((bei or {}).get('names') or {}).items():
        official[code].append(name)
    for code, name in ((events or {}).get('names') or {}).items():
        if name not in official[code]:
            official[code].append(name)
    for code, names in ((events or {}).get('aliases') or {}).items():
        for name in names:
            if name not in official[code]:
                official[code].append(name)
    return dict(official)


def write(out, docs, tickers, vocabulary, desk=DESK):
    """Write every table into `out`; returns {table: asset name} for manifest['tables']."""
    out = Path(out)
    events = _json(out / 'events.json') or {}
    history = _json(out / 'ksei_history.json')
    bei = bei_table(desk / 'bei-index.json')
    official = official_names(events, bei)
    detail = [d for d in docs if d['cat'] == 'stockbit-detail' and d['name'].endswith('.md')]
    claims = parse_claims(detail, tickers)
    subjects = scan_subjects(docs, tickers, official, events.get('plainWords') or ())
    texts = [re.sub(r'<[^>]+>', ' ', d['body']) if d.get('kind') == 'html' else d['body'] for d in docs] + \
            [r[3] for rows in claims['by_ticker'].values() for r in rows]
    entities = build_entities(history, _json(desk / 'kepemilikan-laporan.json'), [d for d in docs if d['cat'] in GROUP_CATS],
                              claims, official, vocabulary, texts=texts)
    sb_index = _json(desk / 'stockbit-index.json') or {}
    sb_days = [d['d'] for d in sb_index.get('days') or [] if d.get('d')] or claims['days']
    # BEI coverage from the files actually built (the desk index can omit a day that has files) plus the index days.
    bei_days = sorted(set((bei or {}).get('days', ())) | {d['start'] for d in docs if d['cat'] in ('bei-ringkasan', 'bei-detail')})
    cov = coverage(sb_days, bei_days, (history or {}).get('months') or [])
    links = build_links(claims, bei, subjects, history, cov)
    tables = {'claims': claims, 'subjects': {'version': VERSION, 'by_ticker': subjects}, 'entities': entities,
              'links': links, 'coverage': {'version': VERSION, **cov}}
    assert tuple(tables) == TABLES
    names = {}
    for name, value in tables.items():
        (out / (name + '.json')).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        names[name] = name + '.json'
    print(f'Tabel arsip: {sum(len(r) for r in claims["by_ticker"].values())} klaim, {sum(len(r) for r in subjects.values())} '
          f'subjek, {len(entities["names"])} nama, {sum(len(v) for v in links["links"].values())} cek rumor -> {out}')
    return names
