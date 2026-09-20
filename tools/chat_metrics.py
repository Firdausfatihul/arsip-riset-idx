#!/usr/bin/env python3
"""Read private aggregate chat cost metrics; never print the admin token."""
import argparse
import html
from datetime import datetime, timezone
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--days', type=int, default=7)
parser.add_argument('--out', type=Path)
parser.add_argument('--html', type=Path, help='Private HTML report; keep it in reports/private/')
parser.add_argument('--limit', type=int, default=100)
parser.add_argument('--offset', type=int, default=0)
args = parser.parse_args()
if not 1 <= args.days <= 365:
    parser.error('--days must be between 1 and 365')
secret = ROOT / '.env.chat.metrics'
if not secret.exists():
    raise SystemExit('Private metrics token has not been installed; see README.')
token = secret.read_text().strip().removeprefix('CHAT_METRICS_TOKEN=').strip().strip('\"\'')
endpoint = json.loads((ROOT / 'chat.config.json').read_text())['api_url']
request = urllib.request.Request(endpoint + f'/metrics?days={args.days}&limit={min(500,max(1,args.limit))}&offset={max(0,args.offset)}', headers={'Authorization': 'Bearer ' + token, 'User-Agent':'Mozilla/5.0 (Arsip operator metrics)'})
with urllib.request.urlopen(request, timeout=30) as response:
    data = json.load(response)
if args.out:
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
if args.html:
    esc=lambda x: html.escape(str(x))
    def table(headers, rows):
        return '<table><thead><tr>'+''.join('<th>'+esc(h)+'</th>' for h in headers)+'</tr></thead><tbody>'+''.join('<tr>'+''.join('<td>'+esc(c)+'</td>' for c in row)+'</tr>' for row in rows)+'</tbody></table>'
    total=data['total']
    top=table(['Pertanyaan','Jumlah','Biaya diketahui USD'],[(q['question'],q['count'],f"{q['known_cost_usd']:.6f}") for q in data['top_questions']])
    expensive=table(['Pertanyaan','Jumlah','Biaya diketahui USD'],[(q['question'],q['count'],f"{q['known_cost_usd']:.6f}") for q in data.get('expensive_questions',[])])
    rows=[]
    for q in data['questions']:
        metrics=q['metrics'] or {};usage=metrics.get('usage') or {};retrieval=metrics.get('retrieval') or {}
        rows.append([datetime.fromtimestamp(q['stamp']/1000,timezone.utc).isoformat(timespec='seconds'),q['question'],q['status'],q['user_key'][:12],', '.join(q['terms']),usage.get('prompt_tokens',0),usage.get('completion_tokens',0),f"{usage.get('known_cost_usd',0):.6f}"+(' (belum lengkap)' if usage.get('missing_usage_calls') else ''),'Ya' if retrieval.get('answer_cache_hit') else 'Tidak'])
    detail=table(['Waktu UTC','Pertanyaan asli','Status','Klien anonim','Topik','Input token','Output token','USD diketahui','Cache jawaban'],rows)
    body=f'''<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Statistik pertanyaan arsip</title>
<style>body{{font:16px/1.55 system-ui;margin:40px auto;padding:0 24px;max-width:1400px;color:#172637}}h1{{font-size:30px}}.cards{{display:flex;gap:16px;flex-wrap:wrap}}.card{{padding:20px;background:#eef4f8;border-radius:10px}}strong{{display:block;font-size:24px}}table{{border-collapse:collapse;width:100%;font-size:14px}}th,td{{border:1px solid #d5dce2;padding:10px;text-align:left;vertical-align:top}}th{{background:#eef4f8}}.scroll{{overflow-x:auto}}small{{color:#556}}</style>
<h1>Statistik pertanyaan arsip</h1><p>Periode {args.days} hari · laporan privat · dibuat {esc(datetime.now(timezone.utc).isoformat(timespec='seconds'))}</p>
<div class="cards"><div class="card">Input tercatat<strong>{total['inputs']}</strong></div><div class="card">Klien anonim<strong>{total['anonymous_clients']}</strong></div><div class="card">Biaya diketahui<strong>US${total['known_cost_usd']:.6f}</strong></div><div class="card">Jawaban dari cache<strong>{total['answer_cache_hits']}</strong></div></div>
<p>Klien anonim dihitung dari koneksi/IP yang diberi hash; satu klien tidak selalu sama dengan satu orang. {total['missing_usage_calls']} panggilan belum memiliki rincian biaya lengkap. Input yang ditolak sebelum validasi isi tidak mempunyai teks pertanyaan tersimpan.</p>
<h2>Pertanyaan yang berulang</h2><div class="scroll">{top}</div><h2>Topik yang sering ditanyakan</h2>{table(['Topik','Jumlah'],[(t['term'],t['count']) for t in data['top_terms']])}
<h2>Pertanyaan dengan biaya tertinggi</h2><div class="scroll">{expensive}</div><h2>Tren harian dan hasil proses</h2>{table(['Tanggal UTC','Input','Biaya diketahui USD'],[(t['day'],t['inputs'],f"{t['known_cost_usd']:.6f}") for t in data['daily']])}{table(['Status','Jumlah'],[(t['status'],t['count']) for t in data['outcomes']])}
<h2>Input pengguna</h2><p>Menampilkan {len(rows)} dari {data['pagination']['total']} input, mulai offset {data['pagination']['offset']}. Gunakan --offset/--limit untuk halaman lain.</p><div class="scroll">{detail}</div>
<p><small>Prioritaskan topik yang sering ditanyakan dan mahal, periksa cache miss serta pertanyaan gagal/ambigu sebelum menambah mekanisme penghematan.</small></p></html>'''
    args.html.parent.mkdir(parents=True,exist_ok=True)
    args.html.write_text(body)
print(json.dumps({'days':data['days'], **data['total']}, ensure_ascii=False, indent=2))
