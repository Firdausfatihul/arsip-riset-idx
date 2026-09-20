#!/usr/bin/env python3
"""Prepare immutable search postings and full document parts for Cloudflare Assets."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil

from build_safety import check_output
from chat_archive import read_archive, ROOT, SYSTEM, COMMON_WORDS, split_text


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
        metadata.append({**{k: doc[k] for k in ('source_id', 'title', 'path', 'label', 'end', 'name')},
                         'asset': asset, 'sizes': [len(json.dumps(p, ensure_ascii=False, separators=(',', ':')).encode()) for p in parts]})
        for word in set(re.findall(r'\w+', (doc['title'] + '\n' + doc['search_body']).lower())):
            postings.setdefault(word, []).append(source_id)
    manifest = {'version': digest.hexdigest()[:16], 'docs': metadata, 'tickers': sorted(tickers),
                'postings': postings, 'system': SYSTEM, 'commonWords': sorted(COMMON_WORDS)}
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Worker: {len(docs)} dokumen lengkap, {sum(len(d["sizes"]) for d in metadata)} bagian, '
          f'{len(postings)} kata indeks -> {out}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'site')
    parser.add_argument('--out', type=Path, default=ROOT / 'worker/.assets')
    args = parser.parse_args()
    build(args.directory, args.out)
