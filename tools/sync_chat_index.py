#!/usr/bin/env python3
"""Import new source documents into the existing private SQLite index; no model calls."""
import json
from pathlib import Path
import socket
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def bypass_dns_block(host):
    """Some ISPs (e.g. XL) answer *.workers.dev with a block page, even for queries to 1.1.1.1.
    If a direct connection fails, resolve the host via Cloudflare DNS-over-HTTPS and connect to that IP;
    TLS still verifies the original host name."""
    try:
        socket.create_connection((host, 443), timeout=8).close()
        return
    except OSError:
        pass
    query = urllib.request.Request(f'https://cloudflare-dns.com/dns-query?name={host}&type=A', headers={'accept': 'application/dns-json'})
    with urllib.request.urlopen(query, timeout=10) as response:
        ips = [a['data'] for a in json.load(response).get('Answer', []) if a.get('type') == 1]
    if not ips:
        raise SystemExit(f'{host} tidak bisa dihubungi dan DNS-over-HTTPS tidak memberi alamat.')
    print(f'{host} diblokir DNS jaringan ini; memakai {ips[0]} dari DNS-over-HTTPS.', flush=True)
    resolve = socket.getaddrinfo
    socket.getaddrinfo = lambda name, *args, **kw: resolve(ips[0] if name == host else name, *args, **kw)


def main():
    token = (ROOT / '.env.chat.metrics').read_text().strip().removeprefix('CHAT_METRICS_TOKEN=').strip().strip('\"\'')
    endpoint = json.loads((ROOT / 'chat.config.json').read_text())['api_url'] + '/index'
    bypass_dns_block(urllib.parse.urlsplit(endpoint).hostname)

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
