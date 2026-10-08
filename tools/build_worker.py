#!/usr/bin/env python3
"""Prepare immutable search postings and full document parts for Cloudflare Assets."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

from datetime import date
import sys

from build_safety import check_output
from chat_archive import read_archive, ROOT, SYSTEM, COMMON_WORDS, WORD_TICKERS, split_text
import ksei_signals
from evidence_index import make_evidence, VERSION
from event_index import make_events, term_tickers

sys.path.insert(0, str(ROOT))
from build import text_ranges, EXPLICIT_RANGE  # noqa: E402  (rentang tanggal yang sama dengan katalog situs)


def covers(doc):
    """Periode yang dibahas dokumen satu tanggal, untuk permintaan per tanggal di chat.

    Katalog situs memakai tanggal laporan (stockbit_24092026 = 24 Sep), tetapi awal dokumen
    sering menulis periode yang berakhir di tanggal itu ("periode 23–24 September 2026").
    Path dan tanggal situs tidak diubah; hanya chat yang memakai rentang ini.
    Nama dengan dua tanggal ISO lengkap (sbringkas_2026-10-05_2026-10-05.md) tidak pernah dilebarkan
    dari isi, sama seperti build.py: judul "naik 1-5 Oktober" bukan periode berkas.
    """
    if doc['start'] != doc['end'] or EXPLICIT_RANGE.search(doc.get('name', '')):
        return [doc['start'], doc['end']]
    day = date.fromisoformat(doc['end'])
    for s, e in text_ranges(doc['body']):
        if e == day and s < e and (e - s).days <= 31:
            return [s.isoformat(), e.isoformat()]
    return [doc['start'], doc['end']]


# Kategori Stockbit dari IDX Signal Desk (build.py): ringkasan harian, detail per emiten, dan rekap mingguan.
STOCKBIT_SUMMARY = 'stockbit-ringkasan'
STOCKBIT_DETAIL = 'stockbit-detail'
STOCKBIT_RAW = 'stockbit'
STOCKBIT_INDEX = ROOT / 'needtobeindexed' / 'idx-signal-desk' / 'stockbit-index.json'
STOCKBIT_RULE = ('Konten Stockbit (ringkasan, detail, rekap pekan, laporan mentah) adalah klaim pengguna yang belum '
                 'diverifikasi, bukan keterbukaan resmi atau rekomendasi; balasan (reply) posting tidak dikumpulkan. '
                 'Baris "penilaian" adalah penilaian otomatis atas argumen di posting, bukan atas orangnya.\n')
# Stockbit post IDs and other long numbers inflate manifest postings; the SQLite FTS index still finds them.
LONG_NUMBER = re.compile(r'\d{7,}')


def _days(first, last):
    day, end = date.fromisoformat(first), date.fromisoformat(last)
    while day <= end:
        yield day.isoformat()
        day = date.fromordinal(day.toordinal() + 1)


def worker_docs(docs):
    """Documents the chat indexes, plus raw Stockbit reports left out because summaries cover them.

    A raw 'stockbit' report is excluded only when EVERY day it covers has a stockbit-ringkasan
    document. It stays on the static site as proof; chat reads the bounded summary instead.
    """
    summarized = {day for d in docs if d['cat'] == STOCKBIT_SUMMARY for day in _days(*covers(d))}
    kept, excluded = [], []
    for doc in docs:
        if doc['cat'] == STOCKBIT_RAW and summarized and set(_days(*covers(doc))) <= summarized:
            excluded.append(doc)
        else:
            kept.append(doc)
    return kept, excluded


def posting_words(text):
    """Lowercase manifest words; digit-only words of 7+ characters are left to full-text search."""
    return {w for w in re.findall(r'\w+', text.lower()) if not LONG_NUMBER.fullmatch(w)}


def stockbit_index(path):
    """Trim the desk's stockbit-index.json to what the Worker reads: day indexes become dates
    and file names (never D-numbers, which shift), handles become lowercase keys.
    {tickers:{KODE:[[date,file,posts,accounts,findings,inti]]}, users:{handle:[[date,file,posts,tickers,findings]]},
     user_notes:{handle:{...}}, days:{date:{file,n,findings,k}}}"""
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding='utf-8'))
    days = data.get('days') or []

    def day(i):
        return days[i] if isinstance(i, int) and 0 <= i < len(days) else None

    out = {'days': {d['d']: {'file': d.get('f'), 'n': d.get('n'), 'findings': d.get('findings'), 'k': d.get('k')}
                    for d in days if d.get('d')},
           'tickers': {}, 'users': {}, 'user_notes': {}}
    for code, rows in sorted((data.get('tickers') or {}).items()):
        trimmed = [[day(r[0])['d'], day(r[0]).get('f'), r[1], r[2], r[3], r[4] if len(r) > 4 else '']
                   for r in rows if isinstance(r, list) and len(r) >= 4 and day(r[0])]
        if trimmed:
            out['tickers'][code] = sorted(trimmed, key=lambda r: r[0])
    for handle, rows in sorted((data.get('users') or {}).items()):
        trimmed = [[day(r[0])['d'], day(r[0]).get('f'), r[1], list(r[2] or []), list(r[3] or [])]
                   for r in rows if isinstance(r, list) and len(r) >= 4 and day(r[0])]
        if trimmed:
            out['users'][handle.lstrip('@').lower()] = sorted(trimmed, key=lambda r: r[0])
    for handle, note in sorted((data.get('user_notes') or {}).items()):
        penilaian = (note or {}).get('penilaian') or {}
        if handle.lstrip('@').lower() in out['users'] and penilaian.get('text'):
            # Whitelisted fields only: the automatic argument assessment and its supporting finding ids.
            out['user_notes'][handle.lstrip('@').lower()] = {
                'penilaian': {'text': str(penilaian['text']), 'finding_ids': list(penilaian.get('finding_ids') or [])},
                **({'window': note['window']} if note.get('window') else {})}
    return out


ROLE_NAMES = [(1, '>=5%'), (2, 'pengendali'), (4, 'afiliasi'), (8, 'direksi'), (16, 'komisaris')]


def latest_report(entries):
    """Newest readable holder list in kepemilikan-laporan.json; an integer entry repeats that month's list."""
    for entry in reversed(entries or []):
        entry = entries[entry] if isinstance(entry, int) else entry
        if entry and entry.get('h'):
            return entry
    return None


def ownership_index(path, reports_path=None):
    """Latest KSEI >1% holders and the issuer's own holder list (holders, controllers, directors,
    commissioners) per company, for the agent's cross-company name search. No addresses: the source omits them.
    {m: month, c: {TICKER: {n: name, k: [[holder, pct]], d: [[person, roles, pct]]}}}"""
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding='utf-8'))
    reports = json.loads(reports_path.read_text(encoding='utf-8')) if reports_path and reports_path.exists() else {}
    names, months, out = data['names'], data['months'], {}
    for company in data['companies']:
        ksei = next((m for m in reversed(company.get('k') or []) if m), None)
        report = latest_report((reports.get('companies') or {}).get(company['t'], {}).get('d'))
        entry = {'n': company.get('n') or ''}
        if ksei:
            entry['k'] = [[names[h[1]], h[4]] for h in ksei.get('h') or []]
        if report:
            entry['d'] = [[reports['names'][h[0]], ','.join(label for bit, label in ROLE_NAMES if (h[1] or 0) & bit), h[3]] for h in report['h']]
        if len(entry) > 1:
            out[company['t']] = entry
    return {'m': months[-1]['p'] if months else '', 'c': out}


def stockbit_handles(docs):
    """Stockbit usernames ("@primestockid"), so a question naming one is always searched.
    A name counts only when the archive mostly writes it with @: "media" and "stockbit" are words."""
    at, plain = {}, {}
    for doc in docs:
        text = doc['search_body']
        for h in re.findall(r'(?<![\w@])@([A-Za-z][A-Za-z0-9_]{3,29})\b', text):
            at[h.lower()] = at.get(h.lower(), 0) + 1
        for w in re.findall(r'\w+', text.lower()):
            if w in at or len(w) >= 4:
                plain[w] = plain.get(w, 0) + 1
    return sorted(h for h, n in at.items() if n * 2 >= plain.get(h, 0) and h not in COMMON_WORDS)


def auxiliary_versions(directory):
    """Hash the exact generated bytes the agent reads, independently of document assets."""
    hashes = {}
    for name in ('events.json', 'ownership.json', 'signals.json', 'ksei_history.json', 'stockbit.json'):
        path = directory / name
        if path.exists():
            hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    raw = json.dumps(hashes, sort_keys=True, separators=(',', ':')).encode()
    return {'asset_hashes': hashes, 'data_version': hashlib.sha256(raw).hexdigest()}


def build(directory, out):
    docs, tickers = read_archive(directory)
    docs, excluded = worker_docs(docs)
    for doc in excluded:
        print(f'Worker: {doc["name"]} ({doc["cat"]}, {"–".join(covers(doc))}) tidak diindeks chat; '
              f'harinya tercakup ringkasan Stockbit (tetap di situs).')
    out = check_output(out, ROOT, [ROOT / "needtobeindexed", directory], kind="worker")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    postings, metadata, evidences = {}, [], {}
    digest = hashlib.sha256()
    for doc in docs:
        source_id = doc['source_id']
        parts = [{'source_id': source_id, 'title': doc['title'], 'date': doc['label'],
                  'part': i, 'text': text}
                 for i, text in enumerate(split_text(doc['body'], 93750), 1)]
        value = {'parts': parts, 'search': doc['search_body']}
        raw = json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
        asset = source_id + '.json'
        (out / asset).write_bytes(raw)
        digest.update(raw)
        evidence = make_evidence(doc, tickers)
        evidences[source_id] = evidence
        evidence_asset = source_id + '.evidence.json'
        (out / evidence_asset).write_text(json.dumps(evidence, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        metadata.append({**{k: doc[k] for k in ('source_id', 'title', 'path', 'label', 'start', 'end', 'name', 'cat')},
                         'covers': covers(doc), 'asset': asset, 'evidence_asset': evidence_asset,
                         'document_id': evidence['document_id'], 'document_hash': evidence['document_hash'],
                         'sizes': [len(json.dumps(p, ensure_ascii=False, separators=(',', ':')).encode()) for p in parts],
                         # Per-ticker detail: read for ticker/handle or "detail" questions, never for date summaries.
                         **({'priority': 'low'} if doc['cat'] == STOCKBIT_DETAIL else {})})
        for word in posting_words(doc['title'] + '\n' + doc['search_body']):
            postings.setdefault(word, []).append(source_id)
    manifest = {'version': digest.hexdigest()[:16], 'retrieval_version': VERSION, 'docs': metadata, 'tickers': sorted(tickers),
                'handles': stockbit_handles(docs),
                'postings': postings, 'system': SYSTEM + STOCKBIT_RULE, 'commonWords': sorted(COMMON_WORDS),
                'wordTickers': sorted(t for t in tickers if t.lower() in WORD_TICKERS),
                'termTickers': term_tickers(tickers)}
    # Month-over-month and cross-issuer KSEI joins for the agentic engine (tools/ksei_signals.py).
    signals = ksei_signals.write(ROOT / 'needtobeindexed' / 'idx-signal-desk' / 'kepemilikan.json', out)
    if signals:
        manifest['signals'] = signals
    ownership = ownership_index(ROOT / 'needtobeindexed' / 'idx-signal-desk' / 'kepemilikan.json',
                                ROOT / 'needtobeindexed' / 'idx-signal-desk' / 'kepemilikan-laporan.json')
    if ownership:
        (out / 'ownership.json').write_text(json.dumps(ownership, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        manifest['ownership'] = {'asset': 'ownership.json', 'companies': len(ownership['c']), 'month': ownership['m']}
    stockbit = stockbit_index(STOCKBIT_INDEX)
    if stockbit:
        (out / 'stockbit.json').write_text(json.dumps(stockbit, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        manifest['stockbit'] = {'asset': 'stockbit.json', 'tickers': len(stockbit['tickers']),
                                'users': len(stockbit['users']), 'days': len(stockbit['days'])}
    events = make_events(docs, tickers, evidences)
    (out / 'events.json').write_text(json.dumps(events, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    manifest.update(auxiliary_versions(out))
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Worker: {len(docs)} dokumen lengkap, {sum(len(d["sizes"]) for d in metadata)} bagian, '
          f'{len(postings)} kata indeks, {len(events["events"])} aksi korporasi -> {out}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'site')
    parser.add_argument('--out', type=Path, default=ROOT / 'worker/.assets')
    args = parser.parse_args()
    build(args.directory, args.out)
