"""Corporate-action table for screening questions ("siapa aja yang mau rights issue").

Built without a model from text already in the archive:
- Signal Desk digests: bullets under the factual headings of each `## KODE` section.
- Other documents (KI analyses, Stockbit, ASX/SGX): sentences or table rows that name a
  ticker in capitals and a corporate-action term.
Statements such as "Tidak ada aksi korporasi seperti rights issue" are negations, not events.
The same TYPES patterns are used by the Worker to recognise screening questions.
"""
import html
import re

VERSION = 'events-v1'

# id, label, pattern in documents, extra pattern for questions only, case-sensitive abbreviation
# in questions ("TO", not the English "to"). Patterns must be valid in both Python `re` and
# JavaScript (flags i and u): alternations, \b, groups, ? only.
TYPES = [
    ('rights_issue', 'Rights issue / HMETD', r'rights? issue|\bPMHMETD\b|penawaran umum terbatas|\bHMETD\b', r'\bright\b', r''),
    ('private_placement', 'Private placement / tanpa HMETD', r'private placement|\bPMTHMETD\b|tanpa (memberikan )?(HMETD|hak memesan)', r'\bpp\b', r''),
    ('stock_split', 'Stock split / reverse split', r'stock split|reverse (stock )?split|pemecahan (nilai nominal )?saham|penggabungan nilai nominal', r'\bsplit\b', r''),
    ('buyback', 'Buyback / saham treasuri', r'buy ?back|pembelian kembali saham|(pengalihan|penjualan|pelepasan) (kembali )?saham treasuri', r'', r''),
    ('tender_offer', 'Tender offer', r'tender offer|penawaran tender', r'', r'\bTO\b'),
    ('go_private', 'Go private / delisting', r'go[ -]private|delisting|penghapusan pencatatan|perusahaan tertutup', r'\bdelist|cabut dari bursa|keluar dari bursa', r''),
    ('acquisition', 'Akuisisi / pengambilalihan', r'akuisisi|mengakuisisi|pengambilalihan|mengambil alih|\bacquisition\b|\btakeover\b', r'anorganik|caplok', r''),
    ('control_change', 'Perubahan pengendali / backdoor', r'perubahan pengendali|pengendali baru|backdoor|reverse takeover', r'ganti pengendali|ganti pemilik', r''),
    ('business_change', 'Perubahan kegiatan usaha / KBLI', r'\bKBLI\b|(perubahan|penambahan|perluasan) (maksud dan tujuan serta )?kegiatan usaha', r'ekspansi|bisnis baru|ganti bisnis|\bpivot\b', r''),
    ('merger', 'Merger / penggabungan usaha', r'\bmerger\b|penggabungan usaha|peleburan', r'', r''),
    ('dividend', 'Dividen', r'dividen (tunai|interim|final)|cash dividend|pembagian dividen', r'\bdivi\b|dividen', r''),
    ('bonus_shares', 'Saham bonus', r'saham bonus|bonus shares', r'', r''),
]
# Only factual digest headings; "Analytical scenarios", "Risks" and "Items to monitor" are speculation.
DIGEST_HEADINGS = {'Corporate actions', 'Capital structure', 'Material changes',
                   'Management / control changes', 'Listing / regulatory'}
NEGATION = re.compile(r'\b(tidak ada|tidak terdapat|belum ada|tanpa adanya|tidak mengindikasikan|tidak menunjukkan|'
                      r'tidak mengungkapkan|tidak disebutkan|tidak dilaporkan|tidak diumumkan|belum merencanakan|tidak merencanakan|'
                      r'tidak berencana|belum berencana|none)\b', re.I)  # keep in sync with NEGATION in worker/retrieval.mjs
COMPILED = [(t, re.compile(p, re.I)) for t, _, p, _, _ in TYPES]
MAX_TEXT = 500


def negated(sentence, match):
    """A term is negated when a negation opens its clause ("Tidak ada ... rights issue")."""
    clause = re.split(r'[;:.]\s', sentence[:match.start()])[-1]
    return bool(NEGATION.search(clause))


def classify(sentence, terms=None):
    """Types named in the sentence; `terms` collects the matched words (KBLI is also a ticker)."""
    found = []
    for type_id, pattern in COMPILED:
        for m in pattern.finditer(sentence):
            if not negated(sentence, m):
                found.append(type_id)
                if terms is not None:
                    terms.add(m[0].upper())
                break
    # "tanpa HMETD" is a private placement, not a rights issue.
    if 'private_placement' in found and 'rights_issue' in found and not re.search(
            r'rights? issue|\bPMHMETD\b|penawaran umum terbatas', sentence, re.I):
        found.remove('rights_issue')
    return found


def plain(text):
    text = re.sub(r'<(script|style)\b.*?</\1>', ' ', text, flags=re.S | re.I)
    return html.unescape(re.sub(r'<[^>]+>', ' ', text))


def trim(text):
    text = re.sub(r'\s+', ' ', text).strip()
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT - 1] + '…'


def digest_events(doc, tickers):
    raw, events = doc['body'], []
    starts = [m.start() for m in re.finditer(r'^## ', raw, re.M)] + [len(raw)]
    for start, end in zip(starts, starts[1:]):
        section = raw[start:end]
        code = section[3:].split('\n', 1)[0].strip()
        if code not in tickers:
            continue
        window = re.search(r'\*\*Window:\*\*\s*(20\d\d-\d\d-\d\d)\s*→\s*(20\d\d-\d\d-\d\d)', section)
        first, last = (window[1], window[2]) if window else (doc['start'], doc['end'])
        heading = None
        for m in re.finditer(r'^(### (.+)|- (.+))$', section, re.M):
            if m[2]:
                heading = m[2].strip()
                continue
            if heading not in DIGEST_HEADINGS:
                continue
            # The section's own code is a name, not a term: "(KBLI)" is PT KMI Wire and Cable.
            for type_id in classify(re.sub(r'\b' + code + r'\b', '', m[3])):
                events.append({'ticker': code, 'type': type_id, 'start': first, 'end': last, 'kind': 'digest',
                               'text': trim(m[3]), 'source_id': doc['source_id'],
                               'line': raw[:start + m.start()].count('\n') + 1})
    return events


def text_events(doc, tickers, records):
    """Sentences/rows naming a capitalised ticker; a KI heading ticker also counts for its prose."""
    kind = {'keterbukaan-informasi': 'ki', 'stockbit': 'stockbit'}.get(doc['cat'], 'other')
    events = []
    for record in records:
        text = plain(record['content']) if doc['kind'] == 'html' else record['content']
        if len(text) > 200000:  # embedded data blobs, not prose
            continue
        heading = re.match(r'\s*#{1,6}\s+(?:\d+(?:\.\d+)*\.?\s+)?([A-Z0-9]{4})\b', record['content'])
        owner = heading[1] if heading and heading[1] in tickers and kind == 'ki' else None
        for sentence in re.split(r'(?<=[.!?])\s+|\n+', text):
            if sentence.lstrip().startswith('[^'):  # footnote definitions point to lines, not events
                continue
            matched = set()
            # A code written as an issuer name ("Tbk (KBLI)") is not a corporate-action term.
            types = classify(re.sub(r'(?<=Tbk )\(([A-Z0-9]{4})\)|\(([A-Z0-9]{4})\)', '', sentence), matched)
            if not types:
                continue
            named = [w for w in dict.fromkeys(re.findall(r'\b[A-Z0-9]{4}\b', sentence))
                     if w in tickers and not any(w in term for term in matched)]
            for code in named or ([owner] if owner else []):
                for type_id in types:
                    events.append({'ticker': code, 'type': type_id, 'start': doc['start'], 'end': doc['end'],
                                   'kind': kind, 'text': trim(sentence), 'source_id': doc['source_id'],
                                   'line': record['line']})
    return events


NAME = re.compile(r"\b(PT\.?\s+[A-Z][A-Za-z0-9&.,'’\- ]{1,80}?\s+Tbk\.?)\s*\(\s*([A-Z0-9]{4})\s*\)")


def issuer_names(docs, tickers):
    """Official names as the archive writes them ("PT Fortune Indonesia Tbk (FORU)").

    Without them the model fills in names from memory and gets them wrong.
    """
    counts = {}
    for doc in docs:
        text = plain(doc['body']) if doc['kind'] == 'html' else doc['body']
        for m in NAME.finditer(text):
            if m[2] in tickers:
                name = re.sub(r'\s+', ' ', m[1]).strip().rstrip('.')
                counts.setdefault(m[2], {}).setdefault(name, 0)
                counts[m[2]][name] += 1
    return counts


def primary_names(counts):
    return {code: max(found, key=found.get) for code, found in sorted(counts.items())}


def make_events(docs, tickers, evidence):
    """evidence: {source_id: make_evidence(...) result} for the non-digest documents."""
    events, seen = [], set()
    for doc in docs:
        found = (digest_events(doc, tickers) if doc['cat'] == 'digest-emiten'
                 else text_events(doc, tickers, evidence[doc['source_id']]['records']))
        for event in found:
            key = (event['ticker'], event['type'], event['source_id'], event['text'])
            if key not in seen:
                seen.add(key)
                events.append(event)
    counts = issuer_names(docs, tickers)
    # Words the archive writes in lowercase often: "(Pergantian Pengurus)" is a description, not a name.
    lower = {}
    for doc in docs:
        for w in re.findall(r'\b[a-z]{3,}\b', plain(doc['body']) if doc['kind'] == 'html' else doc['body']):
            lower[w] = lower.get(w, 0) + 1
    # A renamed issuer keeps every name the archive used (IPAC: APAC Inti Corpora, Era Graharealty).
    return {'version': VERSION, 'negation': NEGATION.pattern, 'names': primary_names(counts),
            'aliases': {code: sorted(found, key=found.get, reverse=True) for code, found in sorted(counts.items()) if len(found) > 1},
            'plainWords': sorted(w for w, n in lower.items() if n >= 20),
            'types': [{'id': t, 'label': label, 'pattern': p, 'ask': ask, 'abbr': abbr} for t, label, p, ask, abbr in TYPES],
            'events': events}


def term_tickers(tickers):
    """Tickers that are themselves corporate-action words (KBLI): a cue is needed to read them as a code."""
    return sorted(t for t in tickers if any(re.fullmatch('(?:' + p + ')', t, re.I) for _, p in COMPILED_SOURCES))


COMPILED_SOURCES = [(t, p) for t, _, p, _, _ in TYPES]
