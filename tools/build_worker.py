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
from evidence_index import make_evidence, VERSION

sys.path.insert(0, str(ROOT))
from build import text_ranges  # noqa: E402  (rentang tanggal yang sama dengan katalog situs)


def covers(doc):
    """Periode yang dibahas dokumen satu tanggal, untuk permintaan per tanggal di chat.

    Katalog situs memakai tanggal laporan (stockbit_24092026 = 24 Sep), tetapi awal dokumen
    sering menulis periode yang berakhir di tanggal itu ("periode 23–24 September 2026").
    Path dan tanggal situs tidak diubah; hanya chat yang memakai rentang ini.
    """
    if doc['start'] != doc['end']:
        return [doc['start'], doc['end']]
    day = date.fromisoformat(doc['end'])
    for s, e in text_ranges(doc['body']):
        if e == day and s < e and (e - s).days <= 31:
            return [s.isoformat(), e.isoformat()]
    return [doc['start'], doc['end']]


def build(directory, out):
    docs, tickers = read_archive(directory)
    out = check_output(out, ROOT, [ROOT / "needtobeindexed", directory], kind="worker")
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    postings, metadata = {}, []
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
        evidence_asset = source_id + '.evidence.json'
        (out / evidence_asset).write_text(json.dumps(evidence, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        metadata.append({**{k: doc[k] for k in ('source_id', 'title', 'path', 'label', 'start', 'end', 'name', 'cat')},
                         'covers': covers(doc), 'asset': asset, 'evidence_asset': evidence_asset,
                         'document_id': evidence['document_id'], 'document_hash': evidence['document_hash'],
                         'sizes': [len(json.dumps(p, ensure_ascii=False, separators=(',', ':')).encode()) for p in parts]})
        for word in set(re.findall(r'\w+', (doc['title'] + '\n' + doc['search_body']).lower())):
            postings.setdefault(word, []).append(source_id)
    manifest = {'version': digest.hexdigest()[:16], 'retrieval_version': VERSION, 'docs': metadata, 'tickers': sorted(tickers),
                'postings': postings, 'system': SYSTEM, 'commonWords': sorted(COMMON_WORDS),
                'wordTickers': sorted(t for t in tickers if t.lower() in WORD_TICKERS)}
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Worker: {len(docs)} dokumen lengkap, {sum(len(d["sizes"]) for d in metadata)} bagian, '
          f'{len(postings)} kata indeks -> {out}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'site')
    parser.add_argument('--out', type=Path, default=ROOT / 'worker/.assets')
    args = parser.parse_args()
    build(args.directory, args.out)
