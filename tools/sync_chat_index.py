#!/usr/bin/env python3
"""Import new source documents into the existing private SQLite index; no model calls."""
import json
from pathlib import Path
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def main():
    token = (ROOT / '.env.chat.metrics').read_text().strip().removeprefix('CHAT_METRICS_TOKEN=').strip().strip('\"\'')
    endpoint = json.loads((ROOT / 'chat.config.json').read_text())['api_url'] + '/index'

    def request(body=None):
        req = urllib.request.Request(endpoint, data=None if body is None else json.dumps(body).encode(), headers={
            'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Arsip index sync)'})
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise SystemExit(f'Index sync HTTP {error.code}; rerun to resume. No completed document is reimported.') from None

    status = request()
    print(f"Index: {status['ready']}/{status['documents']} documents, {status['records']} records")
    for i, document_id in enumerate(status['pending'], 1):
        result = request({'document_id': document_id})
        print(f"Imported {i}/{len(status['pending'])}: {result.get('records', 0)} records", flush=True)
    done = request()
    print(json.dumps(done, ensure_ascii=False))
    if done['pending']:
        raise SystemExit('Archive changed during import. Run sync again.')


if __name__ == '__main__':
    main()
