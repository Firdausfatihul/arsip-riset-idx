#!/usr/bin/env python3
"""Bangun viewer Markdown statis dari folder needtobeindexed/.

Tidak ada konversi: berkas .md disalin apa adanya ke site/files/ dan dirender
langsung di browser. Script ini hanya membuat daftar isinya (static host tidak
bisa membaca isi folder sendiri), dikelompokkan per sumber (Stockbit, Keterbukaan
Informasi, Digest Emiten) dan tanggal yang dibaca dari nama berkas.
Kalau ada needtobeindexed/idx-signal-desk/kepemilikan.json (dari tools/sync_idx.py), halaman juga
mendapat tab Kepemilikan Saham berisi grafik per emiten.

Pemakaian:
    python3 build.py                                  # hasil ke ./site
    BASE_URL=https://domain.kamu python3 build.py     # + canonical dan sitemap.xml

Tambah berkas ke needtobeindexed/, jalankan ulang, lalu upload folder site/.
"""
import argparse
import html
import json
import os
import re
import shutil
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "needtobeindexed"
OUT = ROOT / "site"
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")
SITE_NAME = "Arsip Riset IDX"
BUILD_ID = datetime.now().strftime("%Y%m%d%H%M%S")

# Urutan di sini = urutan tampil. Konvensi nama: stockbit_YYYYMMDD.md dan ki_YYYYMMDD.md.
# "prefixes" dicocokkan dengan kata pertama nama berkas, "keywords" dengan bagian mana pun.
CATEGORIES = {
    "stockbit": {
        "name": "Stockbit",
        "blurb": "Penelusuran postingan Stockbit Ideas: aksi korporasi, hubungan orang–perusahaan, kode, dan rumor.",
        "prefixes": ("stockbit",),
        "keywords": ("stockbit",),
    },
    "keterbukaan-informasi": {
        "name": "Keterbukaan Informasi",
        "blurb": "Pemeriksaan pengumuman keterbukaan informasi emiten Bursa Efek Indonesia.",
        "prefixes": ("ki", "idx"),
        "keywords": ("keterbukaan", "pemeriksaan", "emiten", "digest", "disclosure"),
    },
    "keterbukaan-australia": {
        "name": "Keterbukaan Informasi Australia",
        "blurb": "Kronologi dan kesimpulan riset dari pengumuman emiten Bursa Efek Australia.",
        "prefixes": ("asx",),
        "keywords": (),
    },
    # Diisi otomatis oleh tools/sync_idx.py dari IDX Signal Desk (kepemilikan saham punya tab sendiri, bukan kategori).
    "digest-emiten": {
        "name": "Digest Emiten",
        "blurb": "Ringkasan per emiten dari IDX Signal Desk, satu berkas per jendela tanggal yang tersimpan.",
        "prefixes": ("digest",),
        "keywords": (),
    },
    "lainnya": {
        "name": "Lainnya",
        "blurb": "Berkas yang namanya belum cocok dengan sumber mana pun.",
        "prefixes": (),
        "keywords": (),
    },
}

BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli",
         "Agustus", "September", "Oktober", "November", "Desember"]
HARI = ["Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu", "Minggu"]
MONTHS = {}
for _i, _name in enumerate(BULAN):
    MONTHS[_name.lower()] = MONTHS[_name.lower()[:3]] = _i + 1
for _i, _name in enumerate(["january", "february", "march", "april", "may", "june", "july",
                            "august", "september", "october", "november", "december"]):
    MONTHS[_name] = MONTHS[_name[:3]] = _i + 1

TICKER = re.compile(r"\b[A-Z]{4}\b")
EMITEN_H3 = re.compile(r"^(?:(\d+)\.\s+)?([A-Z]{4})(?:\s+[—–-]\s+(.+))?$")
FONTS = ("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600"
         "&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap")
LIBS = ("https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.7/marked.min.js",
        "https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.4/purify.min.js")
# Markdown di atas batas ini tidak ditanam di index.html; viewer mengambilnya dari files/… saat dibuka atau dicari.
EMBED_LIMIT = 256 * 1024
EXPLICIT_RANGE = re.compile(r"\d{4}-\d{2}-\d{2}[_\-\s]+(?:to[_\-\s]+)?\d{4}-\d{2}-\d{2}")
# Data tab Kepemilikan Saham: disalin apa adanya, viewer mengambilnya saat tab dibuka.
OWN_SRC = SRC / "idx-signal-desk" / "kepemilikan.json"
OWN_PATH = "files/kepemilikan/kepemilikan.json"


# ---------------------------------------------------------------- helpers

def esc(text):
    return html.escape(str(text), quote=True)


def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "bagian"


def angka(n):
    return f"{n:,}".replace(",", ".")


def squash(text):
    return re.sub(r"\s+", " ", text).strip()


def strip_tags(fragment):
    return html.unescape(re.sub(r"<[^>]+>", " ", fragment))


def html_text(raw):
    """Teks yang bisa dicari dari laporan HTML: isi yang tampil + nilai data JSON di <script>."""
    scripts = re.findall(r"<script\b[^>]*>(.*?)</script>", raw, re.S | re.I)
    body = re.sub(r"<(script|style|template|svg)\b[^>]*>.*?</\1\s*>|<!--.*?-->", " ", raw, flags=re.S | re.I)
    parts = [strip_tags(body)]
    # Beberapa laporan merender isinya dari data (mis. const records=[{"summary": "..."}]).
    for literal in re.findall(r':\s*("(?:[^"\\\n]|\\.)*")', "\n".join(scripts)):
        try:
            value = json.loads(literal)
        except ValueError:
            continue
        if re.search(r"[A-Za-z]", value):
            parts.append(value)
    return squash(" ".join(parts))


def plain_md(text):
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"(?<!\w)_(\S.*?\S|\S)_(?!\w)", r"\1", text)
    return re.sub(r"[*`]", "", text)


def truncate(text, limit=220):
    if len(text) <= limit:
        return text
    return text[:limit].rsplit(" ", 1)[0].rstrip(",;:.") + "…"


def doc_link(path, section=None):
    return "#doc=" + quote(path, safe="/") + (f"&s={quote(section)}" if section else "")


MONTH_RE = "|".join(sorted(MONTHS, key=len, reverse=True))
DATE_RANGE_TEXT = re.compile(
    rf"(\d{{1,2}})\s+({MONTH_RE})(?:\s+(\d{{4}}))?\s*[–-]\s*(\d{{1,2}})\s+({MONTH_RE})\s+(\d{{4}})", re.I)
DATE_RANGE_SAME_MONTH = re.compile(rf"(?<!\d)(\d{{1,2}})\s*[–-]\s*(\d{{1,2}})\s+({MONTH_RE})\s+(\d{{4}})", re.I)


def _date(y, m, d):
    try:
        return date(int(y), int(m), int(d))
    except ValueError:
        return None


def month_end(y, m):
    return (date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1))


def parse_dates(stem):
    """Tanggal dari nama berkas -> (awal, akhir, presisi) atau None. Presisi: "day" / "month"."""
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})[_\-\s]+(?:to[_\-\s]+)?(\d{4})-(\d{2})-(\d{2})", stem)
    if m and _date(*m.groups()[:3]) and _date(*m.groups()[3:]):
        return _date(*m.groups()[:3]), _date(*m.groups()[3:]), "day"
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})(?:_(\d{1,2})(?!\d))?", stem)
    if m and _date(m[1], m[2], m[3]):
        start = _date(m[1], m[2], m[3])
        end = _date(m[1], m[2], m[4]) if m[4] else start
        return start, max(start, end or start), "day"
    m = re.search(rf"(?<!\d)(\d{{1,2}})(?:[_\-–](\d{{1,2}}))?[_\- ]({MONTH_RE})[_\- ](\d{{4}})", stem, re.I)
    if m:
        month = MONTHS[m[3].lower()]
        start, end = _date(m[4], month, m[1]), _date(m[4], month, m[2] or m[1])
        if start and end:
            return start, max(start, end), "day"
    m = re.search(rf"(?<![A-Za-z])({MONTH_RE})[_\- ]+(?:({MONTH_RE})[_\- ]+)?(\d{{4}})", stem, re.I)
    if m:
        year, first = int(m[3]), MONTHS[m[1].lower()]
        last = MONTHS[m[2].lower()] if m[2] else first
        if last >= first:
            return date(year, first, 1), month_end(year, last), "month"
    # 8 digit: YYYYMMDD (ki_20260915) atau DDMMYYYY (stockbit_01092026)
    for m in re.finditer(r"(?<!\d)(\d{2})(\d{2})(\d{2})(\d{2})(?!\d)", stem):
        d = _date(m[1] + m[2], m[3], m[4]) if m[1] == "20" else None
        d = d or (_date(m[3] + m[4], m[2], m[1]) if m[3] == "20" else None)
        if d:
            return d, d, "day"
    return None


def text_ranges(text):
    """Semua rentang tanggal tertulis di ±5.000 karakter awal dokumen."""
    head = squash(strip_tags(text[:30000]))[:5000]
    for m in DATE_RANGE_TEXT.finditer(head):
        s = _date(m[3] or m[6], MONTHS[m[2].lower()], m[1])
        e = _date(m[6], MONTHS[m[5].lower()], m[4])
        if s and e and s <= e:
            yield s, e
    for m in DATE_RANGE_SAME_MONTH.finditer(head):
        month = MONTHS[m[3].lower()]
        s, e = _date(m[4], month, m[1]), _date(m[4], month, m[2])
        if s and e and s <= e:
            yield s, e


def refine_from_text(text, start, end, precision):
    """Lengkapi tanggal dari nama berkas memakai rentang yang tertulis di awal dokumen.

    - Nama hanya menyebut bulan: pakai rentang yang jatuh di dalam bulan-bulan itu.
    - Nama hanya menyebut satu tanggal: pakai rentang yang dimulai tepat di tanggal itu.
    """
    for s, e in text_ranges(text):
        if precision == "month" and start <= s <= e <= end:
            return s, e
        if precision == "day" and start == end == s and s < e and (e - s).days <= 62:
            return s, e
    return None


def date_label(start, end, precision="day"):
    if precision == "month":
        first, last = BULAN[start.month - 1], BULAN[end.month - 1]
        return f"{first} {start.year}" if first == last else f"{first}–{last} {end.year}"
    if start == end:
        return f"{start.day} {BULAN[start.month - 1]} {start.year}"
    if (start.year, start.month) == (end.year, end.month):
        return f"{start.day}–{end.day} {BULAN[start.month - 1]} {start.year}"
    if start.year == end.year:
        return f"{start.day} {BULAN[start.month - 1]}–{end.day} {BULAN[end.month - 1]} {end.year}"
    return f"{date_label(start, start)} – {date_label(end, end)}"


def day_parts(start, end, precision="day"):
    """Kolom tanggal: angka hari, bulan-tahun, keterangan (nama hari atau lama rentang)."""
    mon = lambda d: BULAN[d.month - 1][:3]
    if precision == "month":
        return (mon(start) if start.month == end.month else f"{mon(start)}–{mon(end)}"), str(end.year), "sebulan penuh" if start.month == end.month else "beberapa bulan"
    span = (end - start).days + 1
    wd = HARI[start.weekday()] if span == 1 else (f"{HARI[start.weekday()]}–{HARI[end.weekday()]}" if span == 2 else f"{span} hari")
    if (start.year, start.month) == (end.year, end.month):
        num = str(start.day) if start == end else f"{start.day}–{end.day}"
        return num, f"{mon(start)} {start.year}", wd
    return f"{start.day} {mon(start)}–{end.day} {mon(end)}", str(end.year), wd


def categorize(stem):
    low = stem.lower()
    first = re.split(r"[_\-\s.]+", low)[0]
    for key, cat in CATEGORIES.items():
        if first in cat["prefixes"]:
            return key
    for key, cat in CATEGORIES.items():
        if any(k in low for k in cat["keywords"]):
            return key
    return "lainnya"


# ---------------------------------------------------------------- reading files

def md_info(text):
    """Judul, ringkasan, dan daftar emiten dari Markdown.

    Kode emiten ditautkan sebagai `&s=<kode kecil>`; viewer mencocokkannya ke bagian yang benar.
    """
    title, desc, codes, sections = "", "", [], []
    headings, in_code = [], False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        h = re.match(r"^(#{1,3})\s+(.*?)\s*#*\s*$", line)
        if h:
            headings.append((len(h[1]), plain_md(h[2])))
    # Sama dengan viewer: tanpa H1 selain judul, bagian dokumen memakai H2, dan "## KODE" dihitung sebagai emiten.
    toc_level = 1 if sum(level == 1 for level, _ in headings) > 1 else 2
    for level, heading in headings:
        if level == 1 and not title:
            title = heading
            continue
        if level <= 2:
            sections.append(heading)
        m = EMITEN_H3.match(heading)
        if m and (level == 3 or (level == toc_level and (m[1] or level == 2))) and m[2] not in [c for c, _ in codes]:
            codes.append((m[2], m[2].lower()))
    # Ringkasan: paragraf prosa pertama di bawah judul atau bagian pertama (bukan kalimat pengantar daftar).
    top_sections = 0
    for block in re.split(r"\n\s*\n", text):
        b = block.strip()
        h = re.match(r"^(#{1,6})\s", b)
        if h:
            if len(h[1]) <= 2:
                top_sections += 1
            if top_sections > 3:
                break
            continue
        if not b or re.match(r"^([-*+]\s|\d+[.)]\s|>|\||```|-{3,})", b):
            continue
        b = re.split(r"\n\s*(?:[-*+]|\d+[.)])\s", b)[0].strip()
        if b.endswith(":") or len(b) < 40:
            continue
        desc = b
        break
    desc = desc or " · ".join(dict.fromkeys(sections[:5]))
    return title, truncate(squash(plain_md(desc))), codes


def html_info(raw):
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", raw, re.S | re.I) or re.search(r"<title[^>]*>(.*?)</title>", raw, re.S | re.I)
    title = squash(strip_tags(h1[1])) if h1 else ""
    header = re.search(r"<header[^>]*>(.*?)</header>", raw, re.S | re.I)
    p = re.search(r"<p[^>]*>(.*?)</p>", header[1] if header else raw, re.S | re.I)
    codes = []
    for table in re.findall(r"<table[^>]*>(.*?)</table>", raw, re.S | re.I):
        first_th = re.search(r"<th[^>]*>(.*?)</th>", table, re.S | re.I)
        if not first_th or squash(strip_tags(first_th[1])) != "Kode":
            continue
        for cell in re.findall(r"<tr[^>]*>\s*<td[^>]*>(.*?)</td>", table, re.S | re.I):
            for code in squash(strip_tags(cell)).split(" / "):
                if TICKER.fullmatch(code) and code not in [c for c, _ in codes]:
                    codes.append((code, None))
    return title, truncate(squash(strip_tags(p[1]))) if p else "", codes


def load_doc(path, index):
    stem = path.stem
    text = path.read_text(encoding="utf-8", errors="replace")
    modified = datetime.fromtimestamp(path.stat().st_mtime).date()
    start, end, precision = parse_dates(stem) or (modified, modified, "day")
    # Nama yang sudah menulis dua tanggal lengkap tidak ditafsir ulang dari isi dokumen.
    exact = None if EXPLICIT_RANGE.search(stem) else refine_from_text(text, start, end, precision)
    if exact:
        (start, end), precision = exact, "day"
    elif precision == "month":
        end = max(start, min(end, modified))
    category = categorize(stem)
    kind = "md" if path.suffix.lower() == ".md" else "html"
    title, desc, codes = md_info(text) if kind == "md" else html_info(text)
    doc = {
        "id": f"d{index}",
        # Kunci stabil untuk statistik pengunjung (tidak berubah walau urutan file berubah).
        "key": re.sub(r"[^a-z0-9_-]+", "-", path.name.lower()).strip("-"),
        "path": f"files/{category}/{start.isoformat()}/{path.name}",
        "name": path.name,
        "kind": kind,
        "cat": category,
        "catName": CATEGORIES[category]["name"],
        "start": start.isoformat(),
        "end": end.isoformat(),
        "label": date_label(start, end, precision),
        "title": title or stem.replace("_", " "),
        "desc": desc,
        "size": path.stat().st_size,
        "codes": codes,
        "tickers": sorted(set(TICKER.findall(text if kind == "md" else strip_tags(text)))),
    }
    if kind == "md":
        doc["words"] = len(re.findall(r"\S+", text))
        doc["content"] = text
    else:
        cards = re.findall(r'<div class="card"><strong>([^<]+)</strong><span>([^<]+)</span>', text)
        doc["stats"] = [f"{squash(n)} {squash(lbl)}" for n, lbl in cards[:3]]
        doc["text"] = html_text(text)
        doc["raw"] = text
    doc["_start"], doc["_end"], doc["_precision"] = start, end, precision
    return doc


def with_nav_bar(doc):
    """HTML lama tetap disajikan apa adanya, hanya diberi bar kembali ke arsip."""
    raw = doc["raw"]
    # Saat dibuka di dalam viewer (iframe dari halaman yang sama), bar disembunyikan.
    bar = ('<div id="arsip-bar" role="navigation" aria-label="Arsip" style="display:flex;flex-wrap:wrap;gap:4px 10px;'
           "align-items:center;margin:0;padding:10px max(16px,calc((100% - 1260px)/2));background:#0b1620;"
           'color:#b9c8d4;font:500 13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">'
           f'<a href="../../../index.html" style="color:#ffffff;text-decoration:none;font-weight:600">← {SITE_NAME}</a>'
           f'<span style="opacity:.5">/</span><span>{esc(doc["catName"])}</span>'
           f'<span style="opacity:.5">/</span><span>{esc(doc["label"])}</span></div>'
           '<script>try{if(window.frameElement){document.getElementById("arsip-bar").remove()}}catch(e){}</script>')
    m = re.search(r"<body[^>]*>", raw, re.I)
    return raw[:m.end()] + bar + raw[m.end():] if m else bar + raw


# ---------------------------------------------------------------- styles

CSS = """
:root{
  --ground:#f2f5f3;--surface:#ffffff;--ink:#15201c;--muted:#56645e;--faint:#7c8983;
  --line:#d7dfdb;--line-strong:#b5c1bb;--focus:#1f5fcc;--mark:#ffe27a;--mark-ink:#15201c;--live:#138a52;
  --sb:#08744f;--sb-soft:#e0f0e8;--kip:#a3372a;--kip-soft:#f6e5e1;--etc:#56645e;--etc-soft:#e6ebe8;
  --dg:#1f5a96;--dg-soft:#e1ebf6;--asx:#6849a3;--asx-soft:#eee8f8;--own:#7a4f0d;--own-soft:#f5ead8;--up:#12804c;--down:#b3321f;
  --tabs-h:50px;
  --sans:"IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --cond:"IBM Plex Sans Condensed","IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --ground:#0d1311;--surface:#131a17;--ink:#e1e8e4;--muted:#9eaca6;--faint:#75837d;
  --line:#243029;--line-strong:#3a4842;--focus:#86adff;--mark:#6b5715;--mark-ink:#fff6d6;--live:#46d18a;
  --sb:#4cc496;--sb-soft:#132a20;--kip:#ee8b7d;--kip-soft:#301b17;--etc:#9eaca6;--etc-soft:#1d2622;
  --dg:#7fb2ec;--dg-soft:#16222f;--asx:#c7a9f5;--asx-soft:#2a2139;--own:#e0b25c;--own-soft:#2c2213;--up:#4fd394;--down:#f08a7a;
}}
:root[data-theme="dark"]{
  --ground:#0d1311;--surface:#131a17;--ink:#e1e8e4;--muted:#9eaca6;--faint:#75837d;
  --line:#243029;--line-strong:#3a4842;--focus:#86adff;--mark:#6b5715;--mark-ink:#fff6d6;--live:#46d18a;
  --sb:#4cc496;--sb-soft:#132a20;--kip:#ee8b7d;--kip-soft:#301b17;--etc:#9eaca6;--etc-soft:#1d2622;
  --dg:#7fb2ec;--dg-soft:#16222f;--asx:#c7a9f5;--asx-soft:#2a2139;--own:#e0b25c;--own-soft:#2c2213;--up:#4fd394;--down:#f08a7a;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--ground);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit}
a:focus-visible,input:focus-visible,select:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
mark{background:var(--mark);color:var(--mark-ink);border-radius:2px;padding:0 1px}
[data-cat="stockbit"]{--c:var(--sb);--c-soft:var(--sb-soft)}
[data-cat="keterbukaan-informasi"]{--c:var(--kip);--c-soft:var(--kip-soft)}
[data-cat="digest-emiten"]{--c:var(--dg);--c-soft:var(--dg-soft)}
[data-cat="keterbukaan-australia"]{--c:var(--asx);--c-soft:var(--asx-soft)}
[data-cat="kepemilikan"]{--c:var(--own);--c-soft:var(--own-soft)}
.doc-loading{color:var(--muted);font:500 14px/1.5 var(--mono)}
[data-cat="lainnya"]{--c:var(--etc);--c-soft:var(--etc-soft)}
.swatch{display:inline-block;width:.7em;height:.7em;background:var(--c);flex:none}
.ticker,.chip{font:600 12px/1 var(--mono);letter-spacing:.02em;color:var(--c);background:var(--c-soft);padding:4px 6px;border-radius:2px;text-decoration:none;white-space:nowrap}
a.chip:hover{outline:1px solid var(--c)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}

/* tab atas */
.tabs{position:sticky;top:env(safe-area-inset-top,0px);z-index:20;display:flex;align-items:stretch;gap:2px;height:var(--tabs-h);
  padding-inline:clamp(12px,2.4vw,24px);overflow-x:auto;background:var(--surface);border-bottom:1px solid var(--line-strong)}
.wordmark{font:600 12px/1 var(--mono);letter-spacing:.16em;text-transform:uppercase;text-decoration:none;color:var(--ink)}
.tabs .wordmark{align-self:center;margin-right:clamp(8px,2.6vw,30px);white-space:nowrap}
.tab{display:flex;align-items:center;gap:8px;padding:3px 12px 0;font:600 14.5px/1 var(--sans);color:var(--muted);text-decoration:none;white-space:nowrap;border-bottom:3px solid transparent}
.tab .n{font:500 12px/1 var(--mono);color:var(--faint)}
.tab:hover{color:var(--ink)}
.tab[aria-current="page"]{color:var(--ink);border-bottom-color:var(--ink)}
@media (max-width:520px){.tabs .wordmark{display:none}.tab{padding-inline:10px}}

/* kerangka */
.app{display:grid;grid-template-columns:300px minmax(0,1fr);min-height:calc(100vh - var(--tabs-h))}
.rail{position:sticky;top:calc(env(safe-area-inset-top,0px) + var(--tabs-h));height:calc(100vh - var(--tabs-h));overflow:auto;display:flex;flex-direction:column;gap:18px;
  padding:22px 18px 40px;background:var(--surface);border-right:1px solid var(--line)}
.rail .tally{margin:0;font:12.5px/1.5 var(--mono);color:var(--faint)}
.search{display:grid;gap:6px}
.search input{width:100%;padding:9px 11px;font:15px var(--mono);color:var(--ink);background:var(--ground);border:1px solid var(--line-strong);border-radius:3px}
.search input::placeholder{color:var(--faint)}
.search-note{min-height:1.2em;margin:0;font:12.5px/1.4 var(--mono);color:var(--muted)}
.tree{display:grid;gap:22px}
.tree-cat h2{display:flex;align-items:center;gap:8px;margin:0 0 8px;font:600 11.5px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase}
.tree-cat h2 .n{margin-left:auto;font-weight:500;color:var(--faint)}
.tree-day{display:grid;gap:1px;margin-bottom:8px;padding-left:12px;border-left:2px solid var(--c)}
.tree-day time{margin-bottom:2px;font:500 12px/1.5 var(--mono);color:var(--muted)}
.tree-doc{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;margin-left:-6px;padding:6px;border-radius:3px;font-size:14px;line-height:1.35;text-decoration:none}
.tree-doc:hover{background:var(--c-soft)}
.tree-doc[aria-current="page"]{background:var(--c-soft);color:var(--c);font-weight:600}
.tree-doc .fmt{align-self:start;padding-top:2px;font:500 10.5px/1.3 var(--mono);color:var(--faint)}
.tree-doc .hits{grid-column:1/-1;font:500 11.5px/1.2 var(--mono);color:var(--c)}
.tree-doc .hits:empty{display:none}
.stat{display:inline-flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;font:12.5px/1.5 var(--mono);color:var(--faint);font-variant-numeric:tabular-nums}
.stat .sep{opacity:.6}
.stat .live{color:var(--live)}
.stat .live::before{content:"";display:inline-block;width:6px;height:6px;margin:0 5px 1px 0;border-radius:50%;background:var(--live);vertical-align:middle}
.tree-doc .tree-stat{grid-column:1/-1;font-size:11px;font-weight:400}
.doc-frame{display:block;width:100%;height:calc(100vh - 230px);min-height:560px;margin-top:24px;border:1px solid var(--line);border-radius:4px;background:#fff}
.stage{min-width:0;padding-inline:clamp(16px,4.5vw,56px);padding-block:28px 72px}
.foot{margin-top:56px;padding-top:16px;border-top:1px solid var(--line);font-size:13px;color:var(--faint);display:flex;flex-wrap:wrap;gap:4px 18px}

/* ringkasan */
.masthead{display:grid;gap:12px;padding-bottom:26px;border-bottom:1px solid var(--line-strong)}
.masthead h1{margin:0;max-width:22ch;font:600 clamp(30px,4.4vw,46px)/1.05 var(--cond);letter-spacing:-.012em;text-wrap:balance}
.lede{margin:0;max-width:62ch;color:var(--muted)}
.masthead .tally{display:flex;flex-wrap:wrap;gap:4px 20px;margin:0;font:13px/1.5 var(--mono);color:var(--muted)}
.masthead .tally b{font-weight:600;color:var(--ink)}
/* Tiga sumber utama sejajar; layar kecil punya pintasan kategori di atas. */
#overview{container-type:inline-size}
.category-nav{display:flex;flex-wrap:wrap;gap:8px;padding-bottom:20px}
.category-nav a{display:flex;align-items:center;gap:7px;max-width:100%;padding:8px 10px;
  border:1px solid var(--c);border-radius:3px;color:var(--c);background:var(--c-soft);font:500 14px/1.4 var(--sans);text-decoration:none}
.category-nav a:hover{text-decoration:underline;text-underline-offset:3px}
.cats{display:grid;grid-template-columns:minmax(0,1fr);gap:0 44px;align-items:start}
@container (min-width:760px){
  .cats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .cat-blurb{min-height:3.2em}
}
@container (min-width:840px){
  .cats{grid-template-columns:repeat(3,minmax(0,1fr));column-gap:24px}
  .category-nav{display:none}
}
.cat{min-width:0;padding-top:40px;container-type:inline-size;scroll-margin-top:calc(env(safe-area-inset-top,0px) + var(--tabs-h))}
.cat-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px}
.cat-head h2{display:flex;align-items:center;gap:10px;margin:0;font:600 28px/1.2 var(--cond)}
.cat-count{font:13px var(--mono);color:var(--faint)}
.cat-blurb{margin:4px 0 16px;max-width:62ch;color:var(--muted)}
.ledger{border-top:2px solid var(--c)}
.day{display:grid;grid-template-columns:140px minmax(0,1fr);gap:0 28px;padding-block:20px;border-bottom:1px solid var(--line)}
.day-date{display:flex;flex-direction:column;gap:6px;font-family:var(--mono);font-variant-numeric:tabular-nums}
.day-date .d{font:500 30px/1 var(--mono)}
.day-date .d.long{font-size:19px;line-height:1.2}
.day-date .my{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.day-date .wd{font-size:12px;color:var(--faint)}
.docs{display:grid;gap:22px;margin:0;padding:0;list-style:none}
.doc{display:grid;gap:6px;min-width:0}
.doc-title{font:600 21px/1.25 var(--cond);text-decoration:none;text-wrap:balance}
.doc-title:hover{text-decoration:underline;text-decoration-color:var(--c);text-underline-offset:4px}
.doc-desc{margin:0;max-width:66ch;font-size:15px;color:var(--muted)}
.doc-meta{display:flex;flex-wrap:wrap;gap:2px 14px;margin:0;font:12.5px/1.5 var(--mono);color:var(--faint)}
.doc-meta .fmt{font-weight:600;color:var(--c)}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.chip-more{padding:4px 2px;font:12px/1 var(--mono);color:var(--faint)}
.empty{max-width:900px;margin:32px 0 0;padding:20px;border:1px dashed var(--line-strong);color:var(--muted)}
/* Kolom sumber yang sempit: tanggal pindah ke atas judul. */
@container (max-width:600px){
  .day{grid-template-columns:minmax(0,1fr);gap:10px}
  .day-date{flex-direction:row;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
  .day-date .d,.day-date .d.long{font-size:22px;line-height:1.1}
  .cat-head h2{font-size:25px}
  .doc-title{font-size:19px}
}

/* pembaca */
.crumbs{display:flex;flex-wrap:wrap;gap:4px 8px;margin:0 0 18px;font:500 13px/1.5 var(--mono);color:var(--faint)}
.crumbs a{color:var(--muted);text-decoration:none}
.crumbs a:hover{color:var(--ink);text-decoration:underline}
.doc-head{display:grid;gap:12px;max-width:980px;padding-bottom:22px;border-bottom:2px solid var(--c)}
.kicker{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin:0;font:500 13px/1.4 var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--c)}
.doc-head h1{margin:0;max-width:28ch;font:600 clamp(28px,4vw,42px)/1.08 var(--cond);letter-spacing:-.01em;text-wrap:balance}
.doc-head .meta{display:flex;flex-wrap:wrap;gap:2px 16px;margin:0;font:12.5px/1.5 var(--mono);color:var(--faint)}
.doc-head .meta a{color:var(--c)}
.hit-note{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;margin:0;font:13px/1.4 var(--mono);color:var(--muted)}
.hit-note button{font:500 13px var(--mono);color:var(--c);background:none;border:1px solid var(--c);border-radius:3px;padding:3px 8px;cursor:pointer}
.doc-grid{display:grid;gap:28px;padding-top:28px}
.toc{font-size:14px}
.toc h2{margin:0 0 10px;font:600 11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.toc ol{display:grid;gap:7px;margin:0 0 22px;padding:0;list-style:none;line-height:1.35}
.toc ol a{text-decoration:none;color:var(--muted)}
.toc ol a:hover{color:var(--ink);text-decoration:underline}
.toc summary{cursor:pointer;margin-bottom:10px;font:600 11px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.tick-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(50px,1fr));gap:4px}
.tick-grid .chip{text-align:center;padding:6px 0}
.prose{max-width:72ch;min-width:0}
.prose h1,.prose h2{margin:44px 0 14px;padding-top:14px;border-top:1px solid var(--line-strong);font:600 25px/1.2 var(--cond);text-wrap:balance;scroll-margin-top:calc(var(--tabs-h) + 16px)}
.prose h1 ~ h2{margin-top:30px;padding-top:0;border-top:0;font-size:21px}
.prose>h1:first-child,.prose>h2:first-child{margin-top:0;padding-top:0;border-top:0}
.prose .emiten-top{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
.prose .emiten-top .ticker{font-size:15px;padding:5px 8px}
.prose hr:has(+ h1){display:none}
.prose h3,.prose h4{margin:28px 0 10px;font:600 20px/1.3 var(--cond);scroll-margin-top:calc(var(--tabs-h) + 16px)}
.prose p{margin:0 0 14px}
.prose ul,.prose ol:not(.schedule){margin:0 0 18px;padding-left:20px}
.prose li{margin-bottom:9px}
.prose a{color:var(--c)}
.prose code{font:14px var(--mono);background:var(--c-soft);padding:1px 4px;border-radius:2px}
.prose pre{overflow-x:auto;padding:14px;background:var(--surface);border:1px solid var(--line);font:13px/1.55 var(--mono)}
.prose pre code{background:none;padding:0}
.prose blockquote{margin:0 0 16px;padding-left:14px;border-left:3px solid var(--line-strong);color:var(--muted)}
.prose table{display:block;overflow-x:auto;border-collapse:collapse;margin:0 0 18px;font-size:14px}
.prose th,.prose td{padding:7px 10px;border:1px solid var(--line);text-align:left;vertical-align:top}
.prose th{background:var(--c-soft)}
.prose img{max-width:100%}
.prose hr{border:0;border-top:1px solid var(--line-strong);margin:28px 0}
.prose hr:has(+ h2){display:none}
.prose pre.raw{white-space:pre-wrap}
.facts{display:grid;margin:0 0 18px;border-top:1px solid var(--line)}
.facts>div{display:grid;grid-template-columns:168px minmax(0,1fr);gap:4px 20px;padding-block:10px;border-bottom:1px solid var(--line)}
.facts dt{padding-top:4px;font:500 11.5px/1.45 var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.facts dd{margin:0}
.facts dd.ref{font:13px/1.65 var(--mono);color:var(--muted)}
.emiten{padding-top:26px;scroll-margin-top:calc(var(--tabs-h) + 16px)}
.prose .emiten h3{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin:0 0 12px}
.emiten-no{font:500 13px var(--mono);color:var(--faint);font-variant-numeric:tabular-nums}
.emiten h3 .ticker{font-size:14px;padding:5px 7px}
.schedule{margin:0 0 18px;padding:0;list-style:none;border-left:2px solid var(--c)}
.schedule li{display:grid;grid-template-columns:170px minmax(0,1fr);gap:2px 16px;margin:0;padding:9px 0 9px 16px;border-bottom:1px solid var(--line)}
.schedule time{font:500 13px/1.6 var(--mono);color:var(--c)}
@media (min-width:1240px){
  .doc-grid{grid-template-columns:minmax(0,72ch) 220px;gap:56px}
  .doc-grid .prose{grid-column:1;grid-row:1}
  .doc-grid .toc{grid-column:2;grid-row:1;position:sticky;top:calc(env(safe-area-inset-top,0px) + var(--tabs-h) + 20px);align-self:start;max-height:calc(100vh - var(--tabs-h) - 40px);overflow:auto}
}
@media (max-width:1239px){
  .toc{padding:16px;background:var(--surface);border:1px solid var(--line)}
  .toc ol{margin-bottom:14px}
}
@media (max-width:900px){
  .app{grid-template-columns:1fr}
  .rail{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding-bottom:16px;gap:14px}
  .rail .tree{display:none}
  .app.is-reading .rail .search{display:none}
  .stage{padding-top:24px}
}
@media (max-width:640px){
  .day{grid-template-columns:1fr;gap:12px}
  .day-date{flex-direction:row;align-items:baseline;gap:10px}
  .day-date .d{font-size:20px}
  .facts>div,.schedule li{grid-template-columns:1fr}
}

/* kepemilikan saham */
.own{--s1:var(--own);--s2:var(--dg);--s3:var(--sb);--s4:var(--kip);max-width:1320px;padding-inline:clamp(16px,4.5vw,56px);padding-block:28px 72px}
.own-hero{display:grid;gap:10px;padding-bottom:22px;border-bottom:1px solid var(--line-strong)}
.own-hero h1{margin:0;font:600 clamp(30px,4.4vw,46px)/1.05 var(--cond);letter-spacing:-.012em}
.own-hero .tally{display:flex;flex-wrap:wrap;gap:4px 20px;margin:0;font:13px/1.5 var(--mono);color:var(--muted)}
.own-hero .tally b{font-weight:600;color:var(--ink)}
.own-bar{display:flex;flex-wrap:wrap;align-items:end;gap:12px 14px;padding-block:18px 6px}
.own-field{display:grid;gap:5px;min-width:0;font:500 11.5px/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.own-field input,.own-field select{width:100%;min-width:0;padding:8px 10px;font:14px/1.3 var(--mono);letter-spacing:0;text-transform:none;color:var(--ink);background:var(--surface);border:1px solid var(--line-strong);border-radius:3px}
.own-field input::placeholder{color:var(--faint)}
.own-search{flex:1 1 200px}
.own-pick{flex:2 1 260px}
.own-month{flex:1 1 150px}
.own-inline{grid-auto-flow:column;align-items:center;gap:8px}
.own-inline select{width:auto}
.own-head{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:end;gap:10px 20px;padding:18px 0 14px;border-bottom:2px solid var(--own)}
.own-back{font:500 13px/1.5 var(--mono);color:var(--muted)}
.own-head h2{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:4px 0 0;font:600 clamp(24px,3.4vw,34px)/1.12 var(--cond);text-wrap:balance}
.own-head h2 .ticker{font-size:17px;padding:6px 9px}
.own-pills{display:flex;flex-wrap:wrap;gap:6px}
.own-pill{padding:6px 8px;border-radius:2px;font:500 12px/1 var(--mono);color:var(--muted);background:var(--etc-soft)}
.own-pill.ok{color:var(--sb);background:var(--sb-soft)}
.own-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(172px,1fr));gap:1px;margin:20px 1px 0}
.own-tile{display:grid;align-content:start;gap:4px;padding:14px 16px;background:var(--surface);outline:1px solid var(--line)}
.own-tile-label{display:flex;align-items:center;gap:7px;font:500 11.5px/1.3 var(--mono);letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
.own-tile-value{font:600 30px/1.1 var(--cond);font-variant-numeric:tabular-nums}
.own-tile-delta{font:12.5px/1.45 var(--mono);color:var(--faint)}
.own-key{display:inline-block;flex:none;width:14px;height:3px;border-radius:2px;background:var(--own)}
.own-key.s1{background:var(--s1)}.own-key.s2{background:var(--s2)}.own-key.s3{background:var(--s3)}.own-key.s4{background:var(--s4)}
.up{color:var(--up)}.down{color:var(--down)}
.own-note{max-width:82ch;margin:10px 0 0;font-size:13.5px;line-height:1.55;color:var(--muted)}
.own-card{margin-top:34px}
.own-card-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:6px 16px;margin-bottom:10px}
.own-card-head h3{margin:0;font:600 22px/1.2 var(--cond)}
.own-card-head>span{font:12.5px/1.4 var(--mono);color:var(--faint)}
.own-chart{position:relative;padding-block:10px 2px;background:var(--surface);border:1px solid var(--line)}
.own-chart svg{display:block;max-width:100%;height:auto}
.own-chart text{font:11.5px var(--mono);fill:var(--muted)}
.own-chart text.t{font:500 12.5px var(--sans);fill:var(--ink)}
.own-chart text.v{font:600 12px var(--mono);fill:var(--ink);paint-order:stroke;stroke:var(--surface);stroke-width:4px;stroke-linejoin:round}
.own-chart text.sel{font-weight:600;fill:var(--ink)}
.own-range{fill:var(--own-soft)}
.own-grid{stroke:var(--line);stroke-width:1}
.own-axis{stroke:var(--line-strong);stroke-width:1}
.own-leg{stroke-width:3;stroke-linecap:round}
.own-line{fill:none;stroke-width:2.2;stroke-linejoin:round;stroke-linecap:round}
.own-dot{stroke:var(--surface);stroke-width:2}
.own-leg.s1,.own-line.s1{stroke:var(--s1)}.own-leg.s2,.own-line.s2{stroke:var(--s2)}.own-leg.s3,.own-line.s3{stroke:var(--s3)}.own-leg.s4,.own-line.s4{stroke:var(--s4)}
.own-dot.s1{fill:var(--s1)}.own-dot.s2{fill:var(--s2)}.own-dot.s3{fill:var(--s3)}.own-dot.s4{fill:var(--s4)}
.own-hit{fill:transparent;cursor:pointer;outline:none}
.own-hit:hover{fill:var(--ink);fill-opacity:.04}
.own-hit:focus-visible{stroke:var(--focus);stroke-width:2}
.own-tip{position:absolute;z-index:2;top:8px;display:grid;gap:3px;min-width:190px;padding:9px 11px;font:12.5px/1.45 var(--mono);color:var(--ink);background:var(--surface);border:1px solid var(--line-strong);border-radius:3px;box-shadow:0 6px 18px rgb(0 0 0 / .14);pointer-events:none}
.own-tip span{display:flex;align-items:center;gap:7px;white-space:nowrap}
.own-tip em{margin-top:3px;font-style:normal;color:var(--faint)}
.own-twin{margin-top:10px}
.own-twin summary{cursor:pointer;font:500 13px var(--mono);color:var(--muted)}
.own-twin .own-scroll{margin-top:8px}
.own-scroll{overflow-x:auto;background:var(--surface);border:1px solid var(--line)}
.own-table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}
.own-table th,.own-table td{padding:8px 12px;border-bottom:1px solid var(--line);text-align:right;vertical-align:middle;white-space:nowrap}
.own-table th:first-child,.own-table td:first-child{text-align:left;white-space:normal;min-width:210px}
.own-table thead th{font:500 11.5px/1.35 var(--mono);letter-spacing:.04em;text-transform:uppercase;color:var(--muted);background:var(--ground)}
.own-table tbody th{font-weight:500}
.own-table tbody tr:hover{background:var(--own-soft)}
.own-table tr.gone{color:var(--faint)}
.own-table tr.in-range th{font-weight:600}
.own-tags{display:block;margin-top:1px;font:12px/1.4 var(--mono);color:var(--faint)}
.own-code{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 10px;text-decoration:none}
.own-code:hover .own-name{text-decoration:underline}
.own-name{font-size:13.5px;color:var(--muted)}
.own-share{display:flex;align-items:center;justify-content:flex-end;gap:8px}
.own-meter{width:60px;height:6px;overflow:hidden;border-radius:3px;background:var(--line)}
.own-meter i{display:block;height:100%;background:var(--own)}
.own-spark{display:block;margin-left:auto}
.own-spark path{fill:none;stroke:var(--own);stroke-width:1.6;stroke-linejoin:round}
.own-spark circle{fill:var(--own)}
.own-more{margin:12px 0 0}
.own-more button{font:500 13px var(--mono);color:var(--own);background:none;border:1px solid var(--own);border-radius:3px;padding:6px 10px;cursor:pointer}
.own-bars{display:grid;gap:1px;padding:10px 14px;background:var(--surface);border:1px solid var(--line)}
.own-bar-row{display:grid;grid-template-columns:minmax(120px,34%) minmax(90px,1fr) 150px;align-items:center;gap:12px;min-height:30px;font-size:13.5px}
.own-bar-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.own-bar-track{position:relative;height:16px;background:linear-gradient(var(--line-strong),var(--line-strong)) 50% 0/1px 100% no-repeat}
.own-bar-track i{position:absolute;top:2px;bottom:2px;min-width:2px;border-radius:2px}
.own-bar-track i.up{left:50%;background:var(--up)}
.own-bar-track i.down{right:50%;background:var(--down)}
.own-bar-track i.approx{opacity:.4}
.own-bar-val{font:12.5px/1.3 var(--mono);text-align:right;white-space:nowrap}
.own-sources{display:grid;gap:6px;margin:0;padding-left:18px;font-size:14px}
.own-facts{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;margin:0 0 10px;font:13.5px/1.5 var(--mono);color:var(--muted)}
.own-facts b{font-weight:600;color:var(--ink)}
.own-facts .sep{opacity:.5}
.own-facts a,.own-note a{color:var(--own)}
.own-table td.own-role{text-align:left;font:12.5px var(--mono);color:var(--muted)}
.own-sources a{color:var(--own)}
@media (max-width:640px){
  .own-bar-row{grid-template-columns:minmax(0,1fr) 120px;gap:2px 10px;padding-block:4px}
  .own-bar-name{grid-column:1/-1}
  .own-tile-value{font-size:26px}
}
@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
"""

APP_JS = r"""
(function(){
  var data = JSON.parse(document.getElementById('arsip-data').textContent);

  var BUILD_VERSION = data.version || '';

  fetch('version.json?t=' + Date.now(), {cache: 'no-store'})
    .then(function(r){ return r.json(); })
    .then(function(v){
      if (v.version && BUILD_VERSION && v.version !== BUILD_VERSION) {
        var url = new URL(location.href);
        url.searchParams.set('v', v.version);
        location.replace(url.toString());
      }
    })
    .catch(function(){});

  var docs = data.docs, byPath = {};
  docs.forEach(function(d){
    byPath[d.path] = d;
    d.hay = [d.title, d.desc, d.label, d.catName, d.name].concat(d.tickers).join(' ').toLowerCase();
    d.body = (d.content || d.text || '').toLowerCase();
  });
  // Markdown besar tidak ditanam di halaman: ambil dari files/… saat dibuka atau saat pencarian pertama.
  var lazyDocs = docs.filter(function(d){ return d.lazy; }), bulk = null;
  function loadDoc(d){
    if (d.content != null) return Promise.resolve(d);
    if (!d.loading){
      d.loading = fetch(d.path + '?v=' + encodeURIComponent(BUILD_VERSION), {
      cache: 'no-store'
      }).then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(function(t){
        d.content = t; d.body = t.toLowerCase(); d.failed = false; d.loading = null;
        return d;
      }, function(e){ d.failed = true; d.failedAt = Date.now(); d.loading = null; throw e; });
    }
    return d.loading;
  }
  function loadForSearch(){
    if (bulk) return;
    // Yang gagal dicoba lagi paling cepat 30 detik kemudian (dari file:// tiap percobaan pasti gagal).
    var queue = lazyDocs.filter(function(d){ return d.content == null && (!d.failed || Date.now() - d.failedAt > 30000); });
    if (!queue.length) return;
    function worker(){
      var d = queue.shift();
      return d ? loadDoc(d).catch(function(){}).then(worker) : null;
    }
    bulk = Promise.all([worker(), worker(), worker()]).then(function(){ bulk = null; filter(); });
  }
  var app = document.querySelector('.app'), overview = document.getElementById('overview'),
      reader = document.getElementById('reader'), input = document.getElementById('cari'),
      note = document.getElementById('cari-catatan'), empty = document.getElementById('kosong');
  var current = null, renderedQuery = null, siteTitle = document.title;
  var DATE = '\\d{1,2}(?: [A-Z][a-z]+)?(?: \\d{4})?(?:–\\d{1,2}(?: [A-Z][a-z]+)?(?: \\d{4})?)?';
  var LABEL = /^([^:.<]{2,48}):\s+/, TICK = /^[A-Z]{4}$/, EMITEN = /^(?:(\d+)\.\s+)?([A-Z]{4})(?:\s+[—–-]\s+(.+))?$/;

  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function slug(s){ return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bagian'; }
  function link(path, s){ return '#doc=' + encodeURIComponent(path).replace(/%2F/g, '/') + (s ? '&s=' + encodeURIComponent(s) : ''); }
  function kb(n){ return Math.round(n / 1024).toLocaleString('id-ID') + ' KB'; }
  function count(hay, q){ var n = 0, i = hay.indexOf(q); while (i !== -1 && n < 999){ n++; i = hay.indexOf(q, i + q.length); } return n; }

  function toHtml(md){
    if (window.marked && window.DOMPurify) return window.DOMPurify.sanitize(window.marked.parse(md, {gfm: true}));
    return null;
  }

  function schedule(text){
    var parts = text.split(new RegExp('(?<=\\.)\\s+(?=' + DATE + ':\\s)'));
    if (parts.length < 3) return null;
    var rows = [];
    for (var i = 0; i < parts.length; i++){
      var m = parts[i].match(new RegExp('^(' + DATE + '):\\s+([\\s\\S]*)$'));
      if (!m) return null;
      rows.push('<li><time>' + esc(m[1]) + '</time><span>' + esc(m[2]) + '</span></li>');
    }
    return rows.join('');
  }

  // Rapikan hasil Markdown: bagian emiten, baris "Label: isi", jadwal, dan id untuk daftar isi.
  function enhance(root, doc){
    var used = {}, toc = [], emiten = [], section = null, dl = null;
    function uid(base){ var c = base, n = 2; while (used[c]){ c = base + '-' + n; n++; } used[c] = 1; return c; }
    function addEmiten(id, code){ if (!emiten.some(function(e){ return e[1] === code; })) emiten.push([id, code]); }
    var h1 = root.querySelector('h1');
    if (h1 && h1.textContent.trim() === doc.title) h1.remove();
    // Dokumen yang membagi bagian dengan "#" memakai H1 sebagai daftar isi; selain itu H2.
    var tocTag = root.querySelector('h1') ? 'H1' : 'H2';
    Array.prototype.slice.call(root.children).forEach(function(el){
      var tag = el.tagName;
      if (tag !== 'P') dl = null;
      if (tag === tocTag){
        section = null;
        var mt = el.textContent.trim().match(EMITEN);
        if (mt && !mt[1] && tag === 'H2'){
          // "## KODE" (digest per emiten): cukup masuk grid Emiten, tidak memenuhi daftar isi.
          el.id = uid(mt[2].toLowerCase());
          el.classList.add('emiten-top');
          el.innerHTML = '<span class="ticker">' + esc(mt[2]) + '</span>' + (mt[3] ? '<span>' + esc(mt[3]) + '</span>' : '');
          addEmiten(el.id, mt[2]);
          return;
        }
        if (mt && mt[1]){
          el.id = uid(mt[2].toLowerCase());
          el.classList.add('emiten-top');
          el.innerHTML = '<span class="emiten-no">' + esc(mt[1]) + '</span><span class="ticker">' + esc(mt[2]) + '</span>' + (mt[3] ? '<span>' + esc(mt[3]) + '</span>' : '');
          addEmiten(el.id, mt[2]);
        } else {
          el.id = uid(slug(el.textContent));
        }
        toc.push([el.id, el.textContent.trim()]);
        return;
      }
      if (/^H[1-6]$/.test(tag) && tag !== 'H3'){ section = null; el.id = uid(slug(el.textContent)); return; }
      if (tag === 'H3'){
        var m = el.textContent.trim().match(EMITEN);
        if (m){
          section = document.createElement('section');
          section.className = 'emiten';
          section.id = uid(m[2].toLowerCase());
          el.parentNode.insertBefore(section, el);
          el.innerHTML = (m[1] ? '<span class="emiten-no">' + esc(m[1]) + '</span>' : '') +
            '<span class="ticker">' + esc(m[2]) + '</span>' + (m[3] ? '<span>' + esc(m[3]) + '</span>' : '');
          section.appendChild(el);
          addEmiten(section.id, m[2]);
          return;
        }
        section = null; el.id = uid(slug(el.textContent)); return;
      }
      if (section) section.appendChild(el);
      if (tag === 'P'){
        var rows = schedule(el.textContent.trim());
        if (rows){ var ol = document.createElement('ol'); ol.className = 'schedule'; ol.innerHTML = rows; el.replaceWith(ol); dl = null; return; }
        var lm = el.innerHTML.match(LABEL);
        if (lm && (section || TICK.test(lm[1]))){
          if (!dl){ dl = document.createElement('dl'); dl.className = 'facts'; el.parentNode.insertBefore(dl, el); }
          var row = document.createElement('div');
          row.innerHTML = '<dt>' + (TICK.test(lm[1]) ? '<span class="ticker">' + lm[1] + '</span>' : lm[1]) + '</dt>' +
            '<dd' + (/^rujukan/i.test(lm[1]) ? ' class="ref"' : '') + '>' + el.innerHTML.slice(lm[0].length) + '</dd>';
          dl.appendChild(row); el.remove(); return;
        }
        dl = null;
      }
      if (tag === 'UL' || tag === 'OL'){
        Array.prototype.forEach.call(el.children, function(li){
          var m2 = li.innerHTML.match(LABEL);
          if (m2 && m2[1].length <= 40) li.innerHTML = '<strong>' + m2[1] + ':</strong> ' + li.innerHTML.slice(m2[0].length);
        });
      }
    });
    root.querySelectorAll('td').forEach(function(td){
      var t = td.textContent.trim();
      if (!td.children.length && TICK.test(t)) td.innerHTML = '<span class="ticker">' + t + '</span>';
    });
    root.querySelectorAll('a[href^="http"]').forEach(function(a){ a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    return {toc: toc, emiten: emiten};
  }

  function highlight(root, q){
    var doc = root.ownerDocument, walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [], node, total = 0, first = null;
    while ((node = walker.nextNode())){
      if (!/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(node.parentNode.nodeName)) nodes.push(node);
    }
    var ql = q.toLowerCase();
    nodes.forEach(function(n){
      if (total >= 500) return;
      var text = n.nodeValue, low = text.toLowerCase(), i = low.indexOf(ql);
      if (i === -1) return;
      var frag = doc.createDocumentFragment(), pos = 0;
      while (i !== -1 && total < 500){
        frag.appendChild(doc.createTextNode(text.slice(pos, i)));
        var mk = doc.createElement('mark'); mk.className = 'arsip-hit'; mk.textContent = text.slice(i, i + q.length);
        frag.appendChild(mk); if (!first) first = mk; total++;
        pos = i + q.length; i = low.indexOf(ql, pos);
      }
      frag.appendChild(doc.createTextNode(text.slice(pos)));
      n.parentNode.replaceChild(frag, n);
    });
    return {total: total, first: first};
  }

  function hitNote(q, res){
    var hit = reader.querySelector('.hit-note');
    if (!hit) return;
    hit.hidden = q.length < 2;
    if (hit.hidden) return;
    if (res.total){
      hit.innerHTML = '<span>“' + esc(q) + '” muncul ' + (res.total >= 500 ? '500+' : res.total) + '× di dokumen ini</span>' +
        (res.first ? '<button type="button">Lompat ke temuan pertama</button>' : '');
      if (res.first) hit.querySelector('button').addEventListener('click', function(){ res.first.scrollIntoView({behavior: 'instant', block: 'center'}); });
    } else {
      hit.textContent = '“' + q + '” tidak muncul di isi dokumen ini';
    }
  }

  // Laporan HTML di iframe: tandai temuan di dalamnya kalau satu origin; kalau tidak, cukup hitung dari teks indeks.
  function markFrame(frame, doc, q){
    var root = null;
    try { root = frame.contentDocument && frame.contentDocument.body; } catch (e){}
    if (root){
      root.querySelectorAll('mark.arsip-hit').forEach(function(m){ m.replaceWith(m.textContent); });
      root.normalize();
    }
    var res = {total: 0, first: null};
    if (q.length >= 2){
      if (root) res = highlight(root, q);
      if (!res.total) res = {total: count(doc.body, q.toLowerCase()), first: null};
    }
    hitNote(q, res);
    renderedQuery = q;
  }

  function tocHtml(info, doc){
    if (!info.toc.length && !info.emiten.length) return '';
    var h = '<nav class="toc" aria-label="Daftar isi">';
    if (info.toc.length) h += '<h2>Isi</h2><ol>' + info.toc.map(function(t){ return '<li><a href="' + link(doc.path, t[0]) + '">' + esc(t[1]) + '</a></li>'; }).join('') + '</ol>';
    if (info.emiten.length) h += '<details class="tick-wrap"><summary>Emiten (' + info.emiten.length + ')</summary><div class="tick-grid">' +
      info.emiten.map(function(e){ return '<a class="chip" href="' + link(doc.path, e[0]) + '">' + esc(e[1]) + '</a>'; }).join('') + '</div></details>';
    return h + '</nav>';
  }

  function renderDoc(doc, q){
    var meta = ['<span>' + esc(doc.name) + '</span>', '<span>' + kb(doc.size) + '</span>'];
    if (doc.kind === 'md'){
      meta.push('<span>' + doc.words.toLocaleString('id-ID') + ' kata</span>');
      if (doc.codes.length) meta.push('<span>' + doc.codes.length + ' emiten</span>');
    } else {
      (doc.stats || []).forEach(function(s){ meta.push('<span>' + esc(s) + '</span>'); });
    }
    meta.push('<span class="stat always-live" data-stat-key="' + esc(doc.key) + '" data-live-label="sedang membaca" hidden></span>');
    meta.push('<a href="' + esc(doc.path) + '">' + (doc.kind === 'md' ? 'Buka .md mentah' : 'Buka halaman penuh') + '</a>');
    reader.setAttribute('data-cat', doc.cat);
    var head =
      '<nav class="crumbs" aria-label="Lokasi"><a href="#">← Semua dokumen</a><span>/</span><span>' + esc(doc.catName) + '</span><span>/</span><span>' + esc(doc.label) + '</span></nav>' +
      '<header class="doc-head"><p class="kicker"><span class="swatch"></span>' + esc(doc.catName) + '<span>·</span><time datetime="' + doc.end + '">' + esc(doc.label) + '</time></p>' +
      '<h1>' + esc(doc.title) + '</h1><p class="meta">' + meta.join('') + '</p><p class="hit-note" hidden></p></header>';
    if (doc.kind !== 'md'){
      // Laporan HTML ditampilkan utuh di dalam viewer, apa adanya.
      reader.innerHTML = head + '<iframe class="doc-frame" src="' + esc(doc.path) + '" title="' + esc(doc.title) + '"></iframe>';
      var frame = reader.querySelector('.doc-frame');
      frame.addEventListener('load', function(){ if (current === doc) markFrame(frame, doc, input.value.trim()); });
      current = doc; renderedQuery = q; paintStats();
      return;
    }
    if (doc.content == null){
      reader.innerHTML = head + '<div class="doc-grid"><div class="prose"><p class="doc-loading">Memuat dokumen…</p></div></div>';
      current = doc; renderedQuery = q; paintStats();
      if (doc.waiting) return;
      doc.waiting = true;
      loadDoc(doc).then(function(){
        doc.waiting = false;
        if (current !== doc || reader.hidden) return;
        renderDoc(doc, input.value.trim());
        jumpTo(doc, new URLSearchParams(location.hash.slice(1)).get('s'));
      }, function(){
        doc.waiting = false;
        if (current !== doc) return;
        reader.querySelector('.prose').innerHTML = '<p class="doc-loading">Dokumen ini tidak bisa dimuat di halaman ini. ' +
          '<a href="' + esc(doc.path) + '">Buka .md mentah</a>, atau buka arsip lewat server: python3 -m http.server -d site</p>';
      });
      return;
    }
    reader.innerHTML = head + '<div class="doc-grid"><div class="prose"></div></div>';
    // HTML hasil Markdown disimpan supaya mengetik di kotak cari tidak mengurai ulang dokumen besar.
    if (doc.html === undefined) doc.html = toHtml(doc.content);
    var prose = reader.querySelector('.prose'), html = doc.html;
    if (html === null){
      prose.innerHTML = '<pre class="raw"></pre>';
      prose.firstChild.textContent = doc.content;
    } else {
      prose.innerHTML = html;
      var info = enhance(prose, doc);
      doc.codeMap = {};
      info.emiten.forEach(function(e){ doc.codeMap[e[1].toLowerCase()] = e[0]; });
      prose.insertAdjacentHTML('beforebegin', tocHtml(info, doc));
      var wrap = reader.querySelector('.tick-wrap');
      if (wrap) wrap.open = window.matchMedia('(min-width: 1240px)').matches;
    }
    if (q.length >= 2) hitNote(q, highlight(prose, q));
    current = doc; renderedQuery = q; paintStats();
  }

  function show(doc, section){
    var q = input.value.trim(), fresh = current !== doc;
    // .doc-loading masih tampil = dokumen besar belum/tidak jadi dirender (mis. ditinggal saat memuat): render ulang.
    if (fresh || (doc.kind === 'md' && (renderedQuery !== q || reader.querySelector('.doc-loading')))) renderDoc(doc, q);
    overview.hidden = true; reader.hidden = false; app.classList.add('is-reading');
    track(doc.key);
    document.title = doc.title + ' · ' + siteTitle;
    document.querySelectorAll('.tree-doc').forEach(function(a){
      if (a.getAttribute('data-id') === doc.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    if (!jumpTo(doc, section) && fresh) window.scrollTo(0, 0);
  }

  function jumpTo(doc, section){
    if (!section) return false;
    var id = (doc.codeMap && doc.codeMap[section.toLowerCase()]) || section;
    var target = reader.querySelector('[id="' + id.replace(/"/g, '') + '"]');
    // Instan: animasi halus di dokumen sangat panjang bisa berhenti sebelum sampai.
    if (target) target.scrollIntoView({behavior: 'instant', block: 'start'});
    return !!target;
  }

  function showOverview(){
    reader.hidden = true; overview.hidden = false; app.classList.remove('is-reading');
    document.title = siteTitle;
    document.querySelectorAll('.tree-doc[aria-current]').forEach(function(a){ a.removeAttribute('aria-current'); });
    track('home');
  }

  function setTab(name){
    document.querySelectorAll('.tabs [data-tab]').forEach(function(t){
      if (t.getAttribute('data-tab') === name) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
    });
  }

  function route(){
    var p = new URLSearchParams(location.hash.slice(1));
    if (own && p.has('kepemilikan')){ showOwn(p); return; }
    var fromOwn = ownView && !ownView.hidden;
    if (ownView) ownView.hidden = true;
    app.hidden = false; setTab('docs');
    var doc = byPath[p.get('doc') || ''];
    if (doc) show(doc, p.get('s')); else showOverview();
    var category = !doc && document.getElementById(location.hash.slice(1));
    if (category && category.classList.contains('cat')) category.scrollIntoView({block: 'start'});
    else if (fromOwn && !p.get('s')) window.scrollTo(0, 0);
  }

  // ---- pengunjung -------------------------------------------------------
  // Pengunjung lalu: db, satu dokumen per browser di "visitors/<id>" berisi halaman yang pernah dibuka.
  // Pengunjung aktif: room presence {page: <kunci halaman>}. Keduanya opsional; tanpa itu angka tidak tampil.
  var stats = {db: null, room: null, key: null, counts: {}, views: {}, active: {}, online: 0, recorded: {}, full: false};
  var writeChain = Promise.resolve(), tempVisitor = null;

  function visitorId(){
    try {
      var v = localStorage.getItem('arsip-visitor');
      if (!v || !/^[a-z0-9]{8,40}$/.test(v)){
        v = 'v' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
        localStorage.setItem('arsip-visitor', v);
      }
      return v;
    } catch (e){
      tempVisitor = tempVisitor || 't' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
      return tempVisitor;
    }
  }

  function fmtNum(n){ return Number(n || 0).toLocaleString('id-ID'); }

  function paintStats(){
    document.querySelectorAll('[data-stat-key]').forEach(function(el){
      var k = el.getAttribute('data-stat-key'), parts = [];
      if (stats.db){
        var c = stats.counts[k] || 0;
        parts.push('<span class="past" title="' + fmtNum(stats.views[k]) + ' kali dibuka">' + fmtNum(c) + ' pengunjung</span>');
      }
      if (stats.room){
        var a = stats.active[k] || 0;
        if (a || el.classList.contains('always-live'))
          parts.push('<span class="live">' + fmtNum(a) + ' ' + esc(el.getAttribute('data-live-label') || 'aktif') + '</span>');
      }
      el.innerHTML = parts.join('<span class="sep">·</span>');
      el.hidden = !parts.length;
    });
    var online = document.querySelector('.stat-online');
    if (online){
      online.hidden = !stats.room;
      online.innerHTML = stats.room ? '<span class="live">' + fmtNum(stats.online) + ' online di arsip</span>' : '';
    }
  }

  function recordVisit(key){
    if (!stats.db || stats.full || stats.recorded[key]) return;
    stats.recorded[key] = true;
    var ref = stats.db.doc('visitors/' + visitorId());
    writeChain = writeChain.then(function(){ return ref.get(); }).then(function(snap){
      var now = new Date().toISOString(), entry = {}, data = snap.exists ? (snap.data() || {}) : {};
      var old = (data.pages && typeof data.pages === 'object' && data.pages[key]) || {};
      entry[key] = {count: (Number(old.count) || 0) + 1, first: old.first || now, last: now};
      if (!snap.exists) return ref.set({first: now, last: now, pages: entry});
      return ref.update({last: now, pages: entry});
    }).catch(function(e){
      if (e && e.code === 'quota_exceeded') stats.full = true;
      else stats.recorded[key] = false;
    });
  }

  function track(key){
    stats.key = key;
    if (stats.room) stats.room.presence({page: key}).catch(function(){});
    recordVisit(key);
  }

  if (window.claude && typeof window.claude.use === 'function'){
    window.claude.use('db').then(function(db){
      if (!db) return;
      stats.db = db;
      db.collection('visitors').onSnapshot(function(snap){
        var counts = {}, views = {};
        snap.docs.forEach(function(d){
          var pages = (d.data() || {}).pages;
          if (!pages || typeof pages !== 'object') return;
          Object.keys(pages).forEach(function(k){
            counts[k] = (counts[k] || 0) + 1;
            views[k] = (views[k] || 0) + (Number(pages[k] && pages[k].count) || 0);
          });
        });
        stats.counts = counts; stats.views = views; paintStats();
      }, function(){ stats.db = null; paintStats(); });
      if (stats.key) recordVisit(stats.key);
      paintStats();
    }).catch(function(){});

    window.claude.use('room').then(function(room){
      if (!room) return;
      stats.room = room;
      room.onPeers(function(change){
        var active = {};
        change.peers.forEach(function(p){
          var page = p.presence && typeof p.presence.page === 'string' ? p.presence.page : null;
          if (page) active[page] = (active[page] || 0) + 1;
        });
        stats.active = active; stats.online = change.peers.length; paintStats();
      }, function(){ stats.room = null; paintStats(); });
      if (stats.key) room.presence({page: stats.key}).catch(function(){});
      paintStats();
    }).catch(function(){});
  }

  // ---- kepemilikan saham ---------------------------------------------------
  // Tab sendiri. Datanya (files/kepemilikan/kepemilikan.json dari tools/sync_idx.py) diambil saat tab pertama dibuka.
  // Hash: #kepemilikan=KODE&dari=YYYY-MM&sampai=YYYY-MM (tanpa dari/sampai = bulan pertama dan terakhir).
  var own = data.own, ownView = document.getElementById('own'), ownBody = document.getElementById('own-body'),
      ownSearch = document.getElementById('own-cari'), ownPick = document.getElementById('own-emiten'),
      ownFrom = document.getElementById('own-dari'), ownTo = document.getElementById('own-sampai');
  var ownData = null, ownLoading = null, ownState = {t: '', from: 0, to: 0, sort: 'besar', all: false, refocus: null};
  var BULAN = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  var ORIGIN = {L: 'Lokal', D: 'Lokal', F: 'Asing'};

  function num(v, digits){ return Number(v).toLocaleString('id-ID', {maximumFractionDigits: digits == null ? 2 : digits}); }
  function r2(v){ return Math.round(v * 100) / 100; }
  function pctText(v){ return v == null ? '—' : num(v) + '%'; }
  function countText(v){ return v == null ? '—' : num(v, 0); }
  function signed(d, digits, unit){ return (d > 0 ? '+' : '−') + num(Math.abs(d), digits) + (unit ? ' ' + unit : ''); }
  function poinText(d){ if (d == null) return '—'; d = r2(d); return d ? signed(d, 2, 'poin') : 'tetap'; }
  function tone(d){ return d == null || !r2(d) ? '' : (d > 0 ? 'up' : 'down'); }
  function monthName(i){ var p = own.months[i].p; return BULAN[+p.slice(5, 7) - 1] + ' ' + p.slice(0, 4); }
  // Tanggal data KSEI ("31 Agustus 2026"); short: "31 Agu 2026".
  function monthText(i, short){
    var d = own.months[i].asOf;
    if (!d) return monthName(i);
    var b = BULAN[+d.slice(5, 7) - 1];
    return +d.slice(8, 10) + ' ' + (short ? b.slice(0, 3) : b) + ' ' + d.slice(0, 4);
  }
  function safeUrl(u){ return /^https:\/\//.test(u || '') ? u : ''; }
  function ownHref(t, from, to){
    var h = '#kepemilikan=' + encodeURIComponent(t || '');
    if (from !== 0) h += '&dari=' + own.months[from].p;
    if (to !== own.months.length - 1) h += '&sampai=' + own.months[to].p;
    return h;
  }
  function monthIdx(p, fallback){
    for (var i = 0; i < own.months.length; i++) if (own.months[i].p === p) return i;
    return fallback;
  }

  function loadOwn(){
    if (ownData) return Promise.resolve(ownData);
    if (!ownLoading){
      ownLoading = fetch(own.path + '?v=' + encodeURIComponent(BUILD_VERSION), {
        cache: 'no-store'
      }).then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function(d){
        d.byT = {};
        d.companies.forEach(function(c){ d.byT[c.t] = c; c.hay = (c.t + ' ' + c.n).toLowerCase(); c.g = []; });
        ownPick.innerHTML = '<option value="">Semua emiten</option>' + d.companies.map(function(c){
          return '<option value="' + esc(c.t) + '">' + esc(c.t + (c.n ? ' · ' + c.n : '')) + '</option>';
        }).join('');
        ownData = d; ownLoading = null;
        return d;
      }, function(e){ ownLoading = null; throw e; });
    }
    return ownLoading;
  }

  // Pemegang satu emiten di satu bulan, dijumlahkan per investor (nomor investor sama lintas bulan).
  function groupsAt(c, i){
    if (c.g[i] !== undefined) return c.g[i];
    var k = c.k[i], g = null;
    if (k){
      g = {};
      k.h.forEach(function(r){
        var x = g[r[0]];
        if (!x){ g[r[0]] = {name: ownData.names[r[1]], cls: ownData.classes[r[2]], lf: r[3], pct: r[4], total: r[5], rows: r[6]}; return; }
        x.pct = x.pct == null || r[4] == null ? null : x.pct + r[4];
        x.total = x.total == null || r[5] == null ? null : x.total + r[5];
        x.rows += r[6];
      });
    }
    return (c.g[i] = g);
  }
  function tpAt(c, i){ return c.k[i] && c.k[i].tp != null ? c.k[i].tp : null; }
  function restAt(c, i){ var t = tpAt(c, i); return t == null ? null : r2(100 - t); }
  function ffAt(c, i){ return c.f[i] ? c.f[i][0] : null; }
  function countAt(c, i){ return c.c[i] ? c.c[i][0] : null; }
  function holdersAt(c, i){ var g = groupsAt(c, i); return g ? Object.keys(g).length : null; }
  var ROLES = [[1, '≥5%'], [2, 'Pengendali'], [4, 'Afiliasi'], [8, 'Direksi'], [16, 'Komisaris']];
  function roleText(mask){ return ROLES.filter(function(r){ return mask & r[0]; }).map(function(r){ return r[1]; }).join(' · ') || '—'; }
  function shortMonth(i){ var p = own.months[i].p; return BULAN[+p.slice(5, 7) - 1].slice(0, 3) + ' ' + p.slice(0, 4); }
  function link(url, text){ return safeUrl(url) ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>' : ''; }
  // Laporan emiten sering terbit sebulan setelah data KSEI: pakai laporan terakhir sampai bulan i.
  function latestAt(list, i){ if (!list) return null; for (; i >= 0; i--) if (list[i]) return i; return null; }
  // Pasangan laporan untuk rentang Dari–Sampai: terakhir sampai Sampai, dibanding terakhir sampai Dari
  // (atau laporan paling awal di dalam rentang kalau sebelum Dari belum ada).
  function reportPair(list, from, to){
    var cur = latestAt(list, to), cmp = cur == null ? null : latestAt(list, from);
    if (cur != null && cmp == null) for (var i = from + 1; i < cur; i++) if (list[i]){ cmp = i; break; }
    return {cur: cur, cmp: cmp === cur ? null : cmp};
  }
  function lastCell(list, i, fmt){
    var j = latestAt(list, i);
    return j == null ? '—' : fmt(list[j][0]) + (j === i ? '' : ' <span class="own-tags">' + esc(shortMonth(j)) + '</span>');
  }
  // Jumlah pemegang saham (laporan emiten) di rentang: {cur, cmp, d (selisih), pct (persen perubahan)}.
  function countChange(c, from, to){
    var pr = reportPair(c.c, from, to), cur = pr.cur == null ? null : c.c[pr.cur][0], cmp = pr.cmp == null ? null : c.c[pr.cmp][0];
    // Jumlah 0 berarti angkanya salah baca, bukan emiten tanpa pemegang: tidak dihitung sebagai perubahan.
    return {pair: pr, cur: cur, cmp: cmp, d: cur && cmp ? cur - cmp : null, pct: cur && cmp ? (cur - cmp) / cmp * 100 : null};
  }
  function series(fn, from, to){ var v = []; for (var i = from; i <= to; i++) v.push(fn(i)); return v; }

  function spark(vals){
    var w = 96, h = 26, nums = vals.filter(function(v){ return v != null; });
    if (vals.length < 2 || !nums.length) return '';
    var lo = Math.min.apply(null, nums), hi = Math.max.apply(null, nums), d = '', dots = '', pen = false;
    if (hi - lo < 0.02){ lo -= 1; hi += 1; }
    vals.forEach(function(v, i){
      if (v == null){ pen = false; return; }
      var x = (3 + i * (w - 6) / (vals.length - 1)).toFixed(1), y = (h - 3 - (v - lo) / (hi - lo) * (h - 6)).toFixed(1);
      d += (pen ? 'L' : 'M') + x + ' ' + y; pen = true;
      if (i === 0 || i === vals.length - 1 || (vals[i - 1] == null && vals[i + 1] == null)) dots += '<circle cx="' + x + '" cy="' + y + '" r="2"/>';
    });
    return '<svg class="own-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" aria-hidden="true"><path d="' + d + '"/>' + dots + '</svg>';
  }

  function showOwn(p){
    var st = ownState, last = own.months.length - 1, prevT = st.t, wasHidden = ownView.hidden;
    st.t = (p.get('kepemilikan') || '').trim().toUpperCase();
    st.from = monthIdx(p.get('dari'), 0); st.to = monthIdx(p.get('sampai'), last);
    if (st.from > st.to){ var swap = st.from; st.from = st.to; st.to = swap; }
    app.hidden = true; ownView.hidden = false; setTab('own');
    ownFrom.value = String(st.from); ownTo.value = String(st.to);
    document.title = (st.t ? st.t + ' · ' : '') + 'Kepemilikan saham · ' + siteTitle;
    track('kepemilikan');
    if (wasHidden || prevT !== st.t) window.scrollTo(0, 0);
    if (ownData){ renderOwn(); return; }
    ownBody.innerHTML = '<p class="doc-loading">Memuat data kepemilikan…</p>';
    loadOwn().then(renderOwn, function(){
      if (ownView.hidden) return;
      ownBody.innerHTML = '<p class="doc-loading">Data kepemilikan tidak bisa dimuat di halaman ini. ' +
        'Buka arsip lewat server: python3 -m http.server -d site</p>';
    });
  }

  function renderOwn(){
    if (ownView.hidden || !ownData) return;
    var st = ownState, c = st.t ? ownData.byT[st.t] : null;
    ownPick.value = c ? c.t : '';
    if (c){
      ownBody.innerHTML = detailHtml(c);
      trendChart(document.getElementById('own-trend'), c);
    } else {
      ownBody.innerHTML = (st.t ? '<p class="own-note">Kode ' + esc(st.t) + ' tidak ada di data kepemilikan. Pilih dari daftar di bawah.</p>' : '') + listHtml();
    }
  }

  function listHtml(){
    var st = ownState, raw = ownSearch.value.trim(), q = raw.toLowerCase(), same = st.from === st.to, rows = [];
    ownData.companies.forEach(function(c){
      if (q && c.hay.indexOf(q) === -1) return;
      var a = tpAt(c, st.from), b = tpAt(c, st.to);
      rows.push({c: c, a: a, b: b, d: a != null && b != null ? r2(b - a) : null, hc: countChange(c, st.from, st.to)});
    });
    var score = {
      besar: function(r){ return r.d == null ? -1 : Math.abs(r.d); },
      naik: function(r){ return r.d == null ? -1e9 : r.d; },
      turun: function(r){ return r.d == null ? -1e9 : -r.d; },
      'pemegang-naik': function(r){ return r.hc.pct == null ? -1e9 : r.hc.pct; },
      'pemegang-turun': function(r){ return r.hc.pct == null ? -1e9 : -r.hc.pct; }
    }[st.sort === 'kode' || (same && st.sort.indexOf('pemegang') !== 0) ? 'kode' : st.sort];
    rows.sort(function(x, y){ return (score ? score(y) - score(x) : 0) || (x.c.t < y.c.t ? -1 : 1); });
    var sorts = [['besar', 'Akumulasi >1%: perubahan terbesar'], ['naik', 'Akumulasi >1%: naik paling banyak'], ['turun', 'Akumulasi >1%: turun paling banyak'],
                 ['pemegang-naik', 'Jumlah pemegang: bertambah (%)'], ['pemegang-turun', 'Jumlah pemegang: berkurang (%)'], ['kode', 'Kode']];
    var h = '<section class="own-card"><div class="own-card-head"><h3>' +
      (same ? 'Akumulasi di atas 1% per ' + esc(monthText(st.to)) : 'Perubahan akumulasi di atas 1%, ' + esc(monthText(st.from)) + ' → ' + esc(monthText(st.to))) + '</h3>' +
      '<label class="own-field own-inline">Urutkan<select id="own-urut">' + sorts.map(function(o){
        return '<option value="' + o[0] + '"' + (o[0] === st.sort ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
      }).join('') + '</select></label></div>';
    if (!rows.length) return h + '<p class="empty">Tidak ada emiten yang cocok dengan “' + esc(raw) + '”.</p></section>';
    var shown = st.all || q ? rows : rows.slice(0, 100);
    h += '<div class="own-scroll"><table class="own-table"><thead><tr><th scope="col">Emiten</th>' +
      (same ? '' : '<th scope="col">' + esc(monthText(st.from, true)) + '</th>') + '<th scope="col">' + esc(monthText(st.to, true)) + '</th>' +
      (same ? '' : '<th scope="col">Perubahan</th>') + '<th scope="col">Pemegang &gt;1%</th><th scope="col">Jumlah pemegang saham</th><th scope="col">Free float resmi</th>' +
      (same ? '' : '<th scope="col">Tren</th>') + '</tr></thead><tbody>' +
      shown.map(function(r){
        var c = r.c;
        return '<tr><th scope="row"><a class="own-code" href="' + ownHref(c.t, st.from, st.to) + '"><span class="ticker">' + esc(c.t) + '</span>' +
          (c.n ? '<span class="own-name">' + esc(c.n) + '</span>' : '') + '</a></th>' +
          (same ? '' : '<td>' + pctText(r.a) + '</td>') + '<td><strong>' + pctText(r.b) + '</strong></td>' +
          (same ? '' : '<td class="' + tone(r.d) + '">' + poinText(r.d) + '</td>') +
          '<td>' + countText(holdersAt(c, st.to)) + '</td><td>' + lastCell(c.c, st.to, countText) +
          (r.hc.pct != null ? '<span class="own-tags ' + tone(r.hc.d) + '">' + (r.hc.d ? signed(r.hc.pct, 1) + '% vs ' + esc(shortMonth(r.hc.pair.cmp)) : 'tetap vs ' + esc(shortMonth(r.hc.pair.cmp))) + '</span>' : '') +
          '</td><td>' + lastCell(c.f, st.to, pctText) + '</td>' +
          (same ? '' : '<td>' + spark(series(function(i){ return tpAt(c, i); }, st.from, st.to)) + '</td>') + '</tr>';
      }).join('') + '</tbody></table></div>';
    if (shown.length < rows.length) h += '<p class="own-more"><button type="button" id="own-semua">Tampilkan semua ' + rows.length + ' emiten</button></p>';
    return h + '<p class="own-note">' + rows.length + ' emiten' + (q ? ' cocok' : '') + '. Klik kode untuk grafik, perubahan per pemegang, dan daftar pemegang. ' +
      'Akumulasi &gt;1% = jumlah persen semua pemegang di atas 1% menurut KSEI. Jumlah pemegang saham dan free float resmi dari laporan bulanan emiten ' + esc(monthName(st.to)) +
      ', atau laporan terakhir sebelumnya (bulannya ditulis di bawah angka); perubahan jumlah pemegang dibanding laporan terakhir sampai ' + esc(monthName(st.from)) + '.</p></section>';
  }

  function investors(c, from, to){
    var gf = groupsAt(c, from) || {}, gt = groupsAt(c, to) || {}, seen = {}, rows = [];
    Object.keys(gt).concat(Object.keys(gf)).forEach(function(inv){
      if (seen[inv]) return;
      seen[inv] = true;
      var a = gf[inv], b = gt[inv], d = a && b && a.pct != null && b.pct != null ? r2(b.pct - a.pct) : null;
      // Baru/keluar dibandingkan dengan 0: porsinya di bawah 1% tidak diketahui, jadi batangnya perkiraan.
      rows.push({inv: inv, a: a, b: b, cur: b || a, d: d, status: from === to ? '' : (!a ? 'baru' : (!b ? 'keluar' : '')),
                 bar: a && b ? d : (b ? b.pct : (a.pct == null ? null : -a.pct))});
    });
    return rows;
  }

  function tile(key, label, value, sub){
    return '<div class="own-tile"><div class="own-tile-label">' + (key ? '<span class="own-key ' + key + '"></span>' : '') + label + '</div>' +
      '<div class="own-tile-value">' + value + '</div><div class="own-tile-delta">' + sub + '</div></div>';
  }

  function detailHtml(c){
    var st = ownState, from = st.from, to = st.to, same = from === to, vs = ' vs ' + esc(monthText(from, true));
    function delta(a, b, fmt){
      if (same) return 'per ' + esc(monthText(to));
      if (a == null || b == null) return 'tidak ada pembanding per ' + esc(monthText(from, true));
      return '<span class="' + tone(b - a) + '">' + fmt(b - a) + '</span>' + vs;
    }
    function countDelta(d){ return d ? signed(d, 0) : 'tetap'; }
    // Angka laporan emiten: laporan terakhir sampai Sampai, selisih dengan laporan pembanding (lihat reportPair).
    function reportTile(key, label, list, fmt, fmtDelta){
      var pr = reportPair(list, from, to);
      if (pr.cur == null) return tile(key, label, '—', 'laporan emiten sampai ' + esc(monthName(to)) + ' belum terbaca');
      var a = pr.cmp == null ? null : list[pr.cmp][0], b = list[pr.cur][0];
      return tile(key, label, fmt(b), 'laporan ' + esc(monthName(pr.cur)) +
        (a == null ? '' : ' · <span class="' + tone(b - a) + '">' + fmtDelta(b - a) + '</span> vs ' + esc(shortMonth(pr.cmp))) +
        (list[pr.cur][1] ? '' : ' · angka belum terverifikasi'));
    }
    var ff = c.f[latestAt(c.f, to)] || null;
    var rep = c.d && c.d[to];
    var pills = '<span class="own-pill' + (c.k[to] ? ' ok">KSEI ✓ per ' + esc(monthText(to)) : '">KSEI ○ tidak ada data per ' + esc(monthText(to))) + '</span>' +
      '<span class="own-pill' + (rep && rep.h.length ? ' ok">Laporan emiten ✓ ' + esc(monthName(to)) : rep ? '">Laporan emiten ◐ ' + esc(monthName(to)) + ' belum terbaca' :
        '">Laporan emiten ○ ' + esc(monthName(to)) + ' belum ada') + '</span>';

    var h = '<div class="own-head"><div><a class="own-back" href="' + ownHref('', from, to) + '">← Semua emiten</a>' +
      '<h2><span class="ticker">' + esc(c.t) + '</span>' + esc(c.n) + '</h2></div><div class="own-pills">' + pills + '</div></div>' +
      '<div class="own-tiles">' +
      tile('s1', 'Akumulasi &gt;1%', pctText(tpAt(c, to)), delta(tpAt(c, from), tpAt(c, to), poinText)) +
      tile('s2', 'Sisa &lt;1% (perkiraan)', pctText(restAt(c, to)), delta(restAt(c, from), restAt(c, to), poinText)) +
      reportTile('s3', 'Free float resmi IDX', c.f, pctText, poinText) +
      tile('', 'Pemegang &gt;1%', countText(holdersAt(c, to)), delta(holdersAt(c, from), holdersAt(c, to), countDelta)) +
      reportTile('s4', 'Jumlah pemegang saham', c.c, countText, countDelta) + '</div>' +
      '<p class="own-note">Akumulasi &gt;1% = jumlah persen semua pemegang di atas 1% menurut KSEI. Sisa &lt;1% = 100 − akumulasi, perkiraan kasar porsi pemegang kecil. ' +
      'Free float resmi dan jumlah pemegang berasal dari laporan bulanan emiten; free float resmi memakai definisi lain (mengecualikan pengendali, afiliasi, direksi/komisaris, treasuri), jadi angkanya berbeda dari sisa &lt;1%.</p>';

    h += '<section class="own-card"><div class="own-card-head"><h3>Tren bulanan</h3><span>Rentang terpilih diarsir · klik bulan untuk mengubah rentang</span></div>' +
      '<div class="own-chart" id="own-trend"></div><details class="own-twin"><summary>Lihat angka per bulan</summary><div class="own-scroll"><table class="own-table"><thead><tr>' +
      '<th scope="col">Per tanggal KSEI</th><th scope="col">Akumulasi &gt;1%</th><th scope="col">Sisa &lt;1%</th><th scope="col">Free float resmi</th><th scope="col">Pemegang &gt;1%</th><th scope="col">Jumlah pemegang</th></tr></thead><tbody>' +
      series(function(i){ return i; }, 0, own.months.length - 1).reverse().map(function(i){
        return '<tr' + (i >= from && i <= to ? ' class="in-range"' : '') + '><th scope="row">' + esc(monthText(i)) + '</th><td>' + pctText(tpAt(c, i)) + '</td><td>' + pctText(restAt(c, i)) +
          '</td><td>' + pctText(ffAt(c, i)) + '</td><td>' + countText(holdersAt(c, i)) + '</td><td>' + countText(countAt(c, i)) + '</td></tr>';
      }).join('') + '</tbody></table></div></details></section>';

    var rows = investors(c, from, to);
    h += '<section class="own-card"><div class="own-card-head"><h3>Siapa menambah, siapa mengurangi</h3><span>' + esc(monthText(from)) + ' → ' + esc(monthText(to)) + ' · poin persen</span></div>';
    if (same){
      h += '<p class="own-note">Pilih tanggal Dari yang berbeda dari Sampai untuk melihat perubahan per pemegang.</p>';
    } else {
      var moved = rows.filter(function(r){ return r.status || r.d; }).sort(function(x, y){ return (y.bar || 0) - (x.bar || 0); });
      var max = Math.max.apply(null, moved.map(function(r){ return Math.abs(r.bar || 0); }).concat([0.01]));
      h += !moved.length ? '<p class="own-note">Tidak ada perubahan porsi di antara pemegang di atas 1%.</p>' :
        '<div class="own-bars">' + moved.map(function(r){
          var up = (r.bar || 0) > 0, width = Math.min(50, Math.abs(r.bar || 0) / max * 50);
          var label = r.status === 'baru' ? 'baru · ' + pctText(r.b.pct) : r.status === 'keluar' ? 'keluar · ' + pctText(r.a.pct) : poinText(r.d);
          return '<div class="own-bar-row"><span class="own-bar-name" title="' + esc(r.cur.name) + '">' + esc(r.cur.name) + '</span>' +
            '<span class="own-bar-track" aria-hidden="true"><i class="' + (up ? 'up' : 'down') + (r.status ? ' approx' : '') + '" style="width:' + width.toFixed(2) + '%"></i></span>' +
            '<span class="own-bar-val ' + (up ? 'up' : 'down') + '">' + label + '</span></div>';
        }).join('') + '</div><p class="own-note">Baru = belum tercantum di atas 1% per ' + esc(monthText(from)) + '; keluar = tidak lagi tercantum per ' + esc(monthText(to)) +
        '. Porsi di bawah 1% tidak dilaporkan KSEI, jadi batang pucat hanya perkiraan.</p>';
    }
    h += '</section>';

    var list = rows.slice().sort(function(x, y){ return (x.b ? 0 : 1) - (y.b ? 0 : 1) || (y.cur.pct || 0) - (x.cur.pct || 0); });
    h += '<section class="own-card"><div class="own-card-head"><h3>Pemegang saham di atas 1%</h3><span>per ' + esc(monthText(to)) + (same ? '' : ' · dibanding ' + esc(monthText(from))) + '</span></div>';
    h += !list.length ? '<p class="own-note">Tidak ada baris pemegang di file KSEI per ' + esc(monthText(to)) + '.</p>' :
      '<div class="own-scroll"><table class="own-table"><thead><tr><th scope="col">Pemegang</th>' +
      (same ? '' : '<th scope="col">' + esc(monthText(from, true)) + '</th>') + '<th scope="col">' + esc(monthText(to, true)) + '</th>' +
      (same ? '' : '<th scope="col">Perubahan</th>') + '<th scope="col">Lembar saham</th>' + (same ? '' : '<th scope="col">Perubahan lembar</th><th scope="col">Tren</th>') +
      '</tr></thead><tbody>' + list.map(function(r){
        var cur = r.cur, notes = [cur.cls, ORIGIN[cur.lf] || cur.lf].filter(Boolean);
        if (r.a && r.b && r.a.name !== r.b.name) notes.push(monthText(from, true) + ' tertulis ' + r.a.name);
        if (cur.rows > 1) notes.push('jumlah dari ' + cur.rows + ' baris KSEI');
        var dl = r.a && r.b && r.a.total != null && r.b.total != null ? r.b.total - r.a.total : null;
        return '<tr' + (r.b ? '' : ' class="gone"') + '><th scope="row">' + esc(cur.name) + '<span class="own-tags">' + esc(notes.join(' · ')) + '</span></th>' +
          (same ? '' : '<td>' + (r.a ? pctText(r.a.pct) : '—') + '</td>') +
          '<td>' + (r.b ? '<div class="own-share"><span class="own-meter" aria-hidden="true"><i style="width:' + Math.max(0, Math.min(100, r.b.pct || 0)) + '%"></i></span><strong>' + pctText(r.b.pct) + '</strong></div>' : '—') + '</td>' +
          (same ? '' : '<td class="' + (r.status ? '' : tone(r.d)) + '">' + (r.status === 'baru' ? 'baru di atas 1%' : r.status === 'keluar' ? 'tidak lagi di atas 1%' : poinText(r.d)) + '</td>') +
          '<td>' + (r.b && r.b.total != null ? num(r.b.total, 0) : '—') + '</td>' +
          (same ? '' : '<td class="' + tone(dl) + '">' + (dl == null ? '—' : dl ? signed(dl, 0) : 'tetap') + '</td>' +
            '<td>' + spark(series(function(i){ var g = groupsAt(c, i); return g && g[r.inv] ? g[r.inv].pct : null; }, from, to)) + '</td>') + '</tr>';
      }).join('') + '</tbody></table></div><p class="own-note">Baris dengan nama investor sama dijumlahkan. Nama yang ejaannya mirip dengan jumlah lembar persis sama pada bulan data sebelumnya dianggap investor yang sama.</p>';
    h += '</section>';

    h += dpsHtml(c) + baeHtml(c);

    var notes = [];
    (same ? [to] : [from, to]).forEach(function(i){
      var m = ownData.months[i], url = safeUrl(m.url);
      if (url) notes.push('<li>KSEI: <a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(m.desc || 'Pemegang Saham di Atas 1% per ' + monthText(i)) + '</a></li>');
    });
    if (ff) notes.push('<li>Free float resmi ' + esc(monthName(latestAt(c.f, to))) + ': ' + pctText(ff[0]) + (ff[1] ? '' : ' (angka belum terverifikasi)') +
      (ff[3] && ff[3].length ? ' · versi laporan lain: ' + ff[3].map(pctText).join(', ') : '') +
      (safeUrl(ff[2]) ? ' · <a href="' + esc(ff[2]) + '" target="_blank" rel="noopener noreferrer">laporan emiten di IDX</a>' : '') + '</li>');
    ((c.k[to] && c.k[to].i) || []).forEach(function(x){ notes.push('<li>Catatan data KSEI per ' + esc(monthText(to, true)) + ': ' + esc(x) + '</li>'); });
    h += '<section class="own-card"><div class="own-card-head"><h3>Sumber dan catatan</h3></div><ul class="own-sources">' + notes.join('') +
      '<li>Disalin dari IDX Signal Desk.</li></ul></section>';
    return h;
  }

  // Daftar pemegang saham dari laporan bulanan emiten (pemegang >=5%, pengendali, afiliasi, direksi, komisaris).
  function dpsHtml(c){
    var st = ownState, list = c.d || [], readable = list.map(function(x){ return x && x.h.length ? x : null; });
    var pr = reportPair(readable, st.from, st.to), newest = latestAt(list, st.to);
    var h = '<section class="own-card"><div class="own-card-head"><h3>Daftar pemegang saham (laporan emiten)</h3>';
    if (pr.cur == null){
      return h + '</div><p class="own-note">' + (newest != null ?
        'Laporan bulanan emiten ' + esc(monthName(newest)) + ' ada, tetapi tabel pemegangnya belum terbaca oleh Signal Desk. ' + link(list[newest].u, 'Buka laporannya di IDX') + '.' :
        'Belum ada laporan bulanan registrasi pemegang efek sampai ' + esc(monthName(st.to)) + ' untuk emiten ini di Signal Desk.') + '</p></section>';
    }
    var cur = readable[pr.cur], cmp = pr.cmp == null ? null : readable[pr.cmp], hc = countChange(c, st.from, st.to);
    h += '<span>laporan ' + esc(monthName(pr.cur)) + (cmp ? ' · dibanding ' + esc(monthName(pr.cmp)) : '') + '</span></div>';
    var facts = [];
    if (hc.cur != null) facts.push('Jumlah pemegang saham: <b>' + countText(hc.cur) + '</b>' +
      (hc.d != null ? ' <span class="' + tone(hc.d) + '">(' + (hc.d ? signed(hc.d, 0) + ' · ' + signed(hc.pct, 1) + '%' : 'tetap') + ' vs ' + esc(shortMonth(hc.pair.cmp)) + ')</span>' : '') +
      (hc.pair.cur !== pr.cur ? ' <span class="own-tags">' + esc(monthName(hc.pair.cur)) + '</span>' : ''));
    if (cur.s != null) facts.push('Total saham: <b>' + countText(cur.s) + '</b>');
    if (safeUrl(cur.u)) facts.push(link(cur.u, 'laporan di IDX'));
    if (facts.length) h += '<p class="own-facts">' + facts.join('<span class="sep">·</span>') + '</p>';
    // Cocokkan baris antarlaporan per nama + peran; kalau peran berubah, per nama selama nama itu hanya sekali muncul.
    function index(rep){
      var byKey = {}, byName = {};
      (rep ? rep.h : []).forEach(function(r){ byKey[r[0] + '#' + r[1]] = r; (byName[r[0]] = byName[r[0]] || []).push(r); });
      return {key: byKey, name: byName};
    }
    var ic = index(cur), ip = index(cmp), used = [], rows = [];
    cur.h.forEach(function(r){
      var old = ip.key[r[0] + '#' + r[1]] || (ip.name[r[0]] && ip.name[r[0]].length === 1 && ic.name[r[0]].length === 1 ? ip.name[r[0]][0] : null);
      if (old) used.push(old);
      rows.push({r: r, old: old});
    });
    if (cmp) cmp.h.forEach(function(r){ if (used.indexOf(r) === -1) rows.push({r: null, old: r}); });
    function pct4(v){ return v == null ? '—' : num(v, 4) + '%'; }
    h += '<div class="own-scroll"><table class="own-table"><thead><tr><th scope="col">Nama</th><th scope="col">Peran</th>' +
      (cmp ? '<th scope="col">' + esc(shortMonth(pr.cmp)) + '</th>' : '') + '<th scope="col">' + esc(shortMonth(pr.cur)) + '</th>' +
      (cmp ? '<th scope="col">Perubahan</th>' : '') + '<th scope="col">Lembar saham</th>' + (cmp ? '<th scope="col">Perubahan lembar</th>' : '') + '</tr></thead><tbody>' +
      rows.map(function(x){
        var r = x.r || x.old, dp = x.r && x.old && x.r[3] != null && x.old[3] != null ? Math.round((x.r[3] - x.old[3]) * 1e4) / 1e4 : null;
        var ds = x.r && x.old && x.r[2] != null && x.old[2] != null ? x.r[2] - x.old[2] : null;
        var tags = [];
        if (x.r && x.old && x.r[1] !== x.old[1]) tags.push(shortMonth(pr.cmp) + ': ' + roleText(x.old[1]));
        if (!r[4]) tags.push('angka perlu dicek di laporan');
        if (cmp && !x.old) tags.push('tidak disebut di laporan ' + monthName(pr.cmp));
        if (!x.r) tags.push('tidak disebut di laporan ' + monthName(pr.cur));
        return '<tr' + (x.r ? '' : ' class="gone"') + '><th scope="row">' + esc(ownData.names[r[0]]) + (tags.length ? '<span class="own-tags">' + esc(tags.join(' · ')) + '</span>' : '') + '</th>' +
          '<td class="own-role">' + esc(roleText(r[1])) + '</td>' +
          (cmp ? '<td>' + (x.old ? pct4(x.old[3]) : '—') + '</td>' : '') +
          '<td>' + (x.r ? '<strong>' + pct4(x.r[3]) + '</strong>' : '—') + '</td>' +
          (cmp ? '<td class="' + tone(dp) + '">' + (dp == null ? '—' : dp ? signed(dp, 4, 'poin') : 'tetap') + '</td>' : '') +
          '<td>' + (x.r && x.r[2] != null ? num(x.r[2], 0) : (x.old && x.old[2] != null ? '<span class="own-tags">' + num(x.old[2], 0) + '</span>' : '—')) + '</td>' +
          (cmp ? '<td class="' + tone(ds) + '">' + (ds == null ? '—' : ds ? signed(ds, 0) : 'tetap') + '</td>' : '') + '</tr>';
      }).join('') + '</tbody></table></div>';
    var note = 'Sesuai laporan bulanan registrasi pemegang efek: pemegang saham ≥5% (termasuk pengendali dan afiliasi), lalu direksi dan komisaris beserta sahamnya. ' +
      'Peran menurut laporan, bukan riwayat jabatan. Nama yang tidak disebut di salah satu laporan berarti tidak tercantum di laporan itu, bukan nol.';
    if (newest != null && newest > pr.cur) note += ' Laporan ' + monthName(newest) + ' ada tetapi tabelnya belum terbaca oleh Signal Desk' + (safeUrl(list[newest].u) ? ' (' + link(list[newest].u, 'buka di IDX') + ')' : '') + '.';
    return h + '<p class="own-note">' + note + '</p></section>';
  }

  // Jenis pemilik dari laporan BAE (hanya sebagian emiten punya tabel ini yang terbaca).
  function baeHtml(c){
    var st = ownState, list = c.b, pr = reportPair(list, st.from, st.to);
    if (pr.cur == null) return '';
    var cur = list[pr.cur], cmp = pr.cmp == null ? null : list[pr.cmp], DOM = {L: 'Lokal', F: 'Asing', A: 'Semua'};
    var old = {};
    if (cmp){ cmp.r.forEach(function(r){ old['r' + r[0] + r[1]] = r; }); cmp.t.forEach(function(r){ old['t' + r[0]] = r; }); }
    function row(label, dom, r, prev, total){
      var d = prev && r[0] != null && prev[0] != null ? r[0] - prev[0] : null;
      return '<tr' + (total ? ' class="in-range"' : '') + '><th scope="row">' + esc(label) + '<span class="own-tags">' + esc(DOM[dom] || dom) + '</span></th>' +
        (cmp ? '<td>' + (prev ? countText(prev[0]) : '—') + '</td>' : '') + '<td><strong>' + countText(r[0]) + '</strong></td>' +
        (cmp ? '<td class="' + tone(d) + '">' + (d == null ? '—' : d ? signed(d, 0) : 'tetap') + '</td>' : '') +
        '<td>' + countText(r[1]) + '</td><td>' + (r[2] == null ? '—' : num(r[2], 5) + '%') + '</td></tr>';
    }
    return '<section class="own-card"><div class="own-card-head"><h3>Jenis pemilik (laporan BAE)</h3><span>laporan ' + esc(monthName(pr.cur)) + (cmp ? ' · dibanding ' + esc(monthName(pr.cmp)) : '') + '</span></div>' +
      '<div class="own-scroll"><table class="own-table"><thead><tr><th scope="col">Jenis pemilik</th>' + (cmp ? '<th scope="col">Pemegang ' + esc(shortMonth(pr.cmp)) + '</th>' : '') +
      '<th scope="col">Pemegang ' + esc(shortMonth(pr.cur)) + '</th>' + (cmp ? '<th scope="col">Perubahan</th>' : '') + '<th scope="col">Lembar saham</th><th scope="col">Porsi</th></tr></thead><tbody>' +
      cur.r.map(function(r){ return row(ownData.categories[r[1]], r[0], r.slice(2), old['r' + r[0] + r[1]] && old['r' + r[0] + r[1]].slice(2)); }).join('') +
      cur.t.map(function(r){ return row({L: 'Total lokal', F: 'Total asing', A: 'Total'}[r[0]] || 'Total', r[0], r.slice(1), old['t' + r[0]] && old['t' + r[0]].slice(1), true); }).join('') +
      '</tbody></table></div><p class="own-note">Label dan persentase persis dari laporan BAE. Jumlah pemegang adalah hitungan registrasi BAE, bukan jumlah investor unik. ' +
      link(cur.u, 'Buka laporan di IDX') + '</p></section>';
  }

  function niceTicks(lo, hi){
    if (hi - lo < 1e-9){ lo -= 1; hi += 1; }
    var raw = (hi - lo) / 3, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), step = 10 * mag;
    [1, 2, 2.5, 5, 10].some(function(s){ if (s * mag >= raw){ step = s * mag; return true; } return false; });
    var ticks = [], top = Math.ceil(hi / step - 1e-9) * step;
    for (var v = Math.floor(lo / step + 1e-9) * step; v <= top + step * 1e-6 && ticks.length < 9; v += step) ticks.push(Math.round(v / step) * step);
    return ticks;
  }

  function trendChart(el, c){
    var st = ownState, ms = own.months, n = ms.length, W = Math.max(300, Math.floor(el.clientWidth || 720)), narrow = W < 560;
    var panes = [
      {fmt: pctText, series: [{cls: 's1', label: 'Akumulasi >1% (KSEI)', v: series(function(i){ return tpAt(c, i); }, 0, n - 1)}]},
      {fmt: pctText, series: [{cls: 's2', label: 'Sisa <1% (perkiraan)', v: series(function(i){ return restAt(c, i); }, 0, n - 1)},
                              {cls: 's3', label: 'Free float resmi IDX', v: series(function(i){ return ffAt(c, i); }, 0, n - 1)}]}];
    var counts = series(function(i){ return countAt(c, i); }, 0, n - 1);
    if (counts.some(function(v){ return v != null; })) panes.push({fmt: countText, series: [{cls: 's4', label: 'Jumlah pemegang saham (laporan emiten)', v: counts}]});
    var padL = narrow ? 58 : 70, padR = narrow ? 12 : 24, paneH = narrow ? 100 : 120, gap = 16, axisH = 38, band = (W - padL - padR) / n;
    function X(i){ return padL + band * (i + 0.5); }
    // Legenda turun ke baris berikutnya kalau tidak muat.
    panes.forEach(function(p){
      var x = 12, y = 14;
      p.series.forEach(function(se){
        var w = 26 + se.label.length * 7.2 + 18;
        if (x > 12 && x + w > W - padR){ x = 12; y += 20; }
        se.lx = x; se.ly = y; x += w;
      });
      p.legendH = y + 14;
    });
    var H = axisH, y0 = 0, s = '';
    panes.forEach(function(p, pi){ H += p.legendH + paneH + (pi ? gap : 0); });
    var axY = H - axisH;
    s += '<rect class="own-range" x="' + (X(st.from) - band / 2).toFixed(1) + '" y="0" width="' + (band * (st.to - st.from + 1)).toFixed(1) + '" height="' + axY + '"/>';
    panes.forEach(function(p){
      p.series.forEach(function(se){
        s += '<line class="own-leg ' + se.cls + '" x1="' + se.lx + '" x2="' + (se.lx + 18) + '" y1="' + (y0 + se.ly - 4) + '" y2="' + (y0 + se.ly - 4) + '"/>' +
          '<text class="t" x="' + (se.lx + 26) + '" y="' + (y0 + se.ly) + '">' + esc(se.label) + '</text>';
      });
      var top = y0 + p.legendH, bottom = top + paneH, vals = [];
      p.series.forEach(function(se){ se.v.forEach(function(v){ if (v != null) vals.push(v); }); });
      if (!vals.length){
        s += '<text x="' + (padL + (W - padL - padR) / 2) + '" y="' + (top + paneH / 2) + '" text-anchor="middle">belum ada data</text>';
        y0 = bottom + gap; return;
      }
      var ticks = niceTicks(Math.min.apply(null, vals), Math.max.apply(null, vals)), lo = ticks[0], hi = ticks[ticks.length - 1];
      function Y(v){ return bottom - 4 - (v - lo) / ((hi - lo) || 1) * (paneH - 12); }
      ticks.forEach(function(t){
        var y = Y(t).toFixed(1);
        s += '<line class="own-grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y + '" y2="' + y + '"/>' +
          '<text x="' + (padL - 8) + '" y="' + (+y + 4) + '" text-anchor="end">' + esc(p.fmt(t)) + '</text>';
      });
      p.series.forEach(function(se){
        var d = '', pen = false;
        se.v.forEach(function(v, i){ if (v == null){ pen = false; return; } d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true; });
        s += '<path class="own-line ' + se.cls + '" d="' + d + '"/>';
      });
      var labels = {};  // label angka di awal/akhir rentang, dikumpulkan per bulan supaya dua seri tidak bertumpuk
      p.series.forEach(function(se){
        se.v.forEach(function(v, i){
          if (v == null) return;
          var edge = i === st.from || i === st.to, x = X(i), y = Y(v);
          s += '<circle class="own-dot ' + se.cls + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (edge ? 4.5 : 3) + '"/>';
          if (edge) (labels[i] = labels[i] || []).push({x: x, y: y, text: p.fmt(v)});
        });
      });
      Object.keys(labels).forEach(function(k){
        var i = +k, anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'), last = null;
        // Titik tertinggi diberi label di atas; titik di bawahnya yang labelnya akan menabrak diberi label di bawah titik.
        labels[k].sort(function(a, b){ return a.y - b.y; }).forEach(function(l){
          var ly = l.y - 10 < top + 4 ? l.y + 19 : l.y - 10;
          if (last != null && ly - last < 15) ly = l.y + 19;
          if (last != null && ly - last < 15) return;
          last = ly;
          s += '<text class="v" x="' + (l.x + (anchor === 'start' ? -6 : anchor === 'end' ? 6 : 0)).toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="' + anchor + '">' + esc(l.text) + '</text>';
        });
      });
      y0 = bottom + gap;
    });
    s += '<line class="own-axis" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + axY + '" y2="' + axY + '"/>';
    ms.forEach(function(m, i){
      var label = narrow ? BULAN[+m.p.slice(5, 7) - 1].slice(0, 3) : monthText(i, true).replace(/ \d{4}$/, '');
      s += '<text class="' + (i === st.from || i === st.to ? 'sel' : '') + '" x="' + X(i).toFixed(1) + '" y="' + (axY + 16) + '" text-anchor="middle">' + esc(label) + '</text>';
      if (!i || m.p.slice(0, 4) !== ms[i - 1].p.slice(0, 4)) s += '<text x="' + X(i).toFixed(1) + '" y="' + (axY + 31) + '" text-anchor="middle">' + m.p.slice(0, 4) + '</text>';
    });
    function tipLines(i){
      return panes.map(function(p){ return p.series.map(function(se){ return [se, p.fmt(se.v[i])]; }); }).reduce(function(a, b){ return a.concat(b); }, []);
    }
    ms.forEach(function(m, i){
      s += '<rect class="own-hit" data-i="' + i + '" x="' + (X(i) - band / 2).toFixed(1) + '" y="0" width="' + band.toFixed(1) + '" height="' + axY + '" tabindex="' + (i === st.to ? 0 : -1) + '" role="button" aria-label="' +
        esc(monthText(i) + ': ' + tipLines(i).map(function(l){ return l[0].label + ' ' + l[1]; }).join(', ')) + '"/>';
    });
    el.setAttribute('data-w', W);
    el.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-label="Grafik bulanan ' + esc(c.t) +
      '. Panah kiri/kanan untuk berpindah bulan, Enter untuk mengubah rentang.">' + s + '</svg><div class="own-tip" hidden></div>';

    var svg = el.querySelector('svg'), tip = el.querySelector('.own-tip');
    function showTip(rect){
      var i = +rect.getAttribute('data-i');
      tip.innerHTML = '<strong>' + esc(monthText(i)) + '</strong>' + tipLines(i).map(function(l){
        return '<span><i class="own-key ' + l[0].cls + '"></i>' + esc(l[0].label) + ': ' + esc(l[1]) + '</span>';
      }).join('') + '<em>' + (i === st.from && i === st.to ? 'rentang satu bulan' : i === st.from ? 'awal rentang (Dari)' : i === st.to ? 'akhir rentang (Sampai)' :
        'klik untuk menjadikan ' + (i < st.from ? 'Dari' : 'Sampai')) + '</em>';
      tip.hidden = false;
      var left = X(i) + band / 2 + 6;
      if (left + tip.offsetWidth > el.clientWidth) left = X(i) - band / 2 - 6 - tip.offsetWidth;
      tip.style.left = Math.max(4, left) + 'px';
    }
    function pick(i){
      var from = st.from, to = st.to;
      if (i < from) from = i; else to = i;
      if (from === st.from && to === st.to) return;
      location.hash = ownHref(st.t, from, to);
    }
    svg.addEventListener('pointermove', function(e){ var r = e.target.closest('.own-hit'); if (r) showTip(r); });
    svg.addEventListener('pointerleave', function(){ tip.hidden = true; });
    svg.addEventListener('focusin', function(e){ if (e.target.classList.contains('own-hit')) showTip(e.target); });
    svg.addEventListener('focusout', function(){ tip.hidden = true; });
    svg.addEventListener('click', function(e){ var r = e.target.closest('.own-hit'); if (r) pick(+r.getAttribute('data-i')); });
    svg.addEventListener('keydown', function(e){
      var r = e.target.closest('.own-hit');
      if (!r) return;
      var i = +r.getAttribute('data-i');
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
        var next = svg.querySelector('.own-hit[data-i="' + (i + (e.key === 'ArrowLeft' ? -1 : 1)) + '"]');
        if (next){ r.setAttribute('tabindex', '-1'); next.setAttribute('tabindex', '0'); next.focus(); }
        e.preventDefault();
      } else if (e.key === 'Enter' || e.key === ' '){
        st.refocus = i; pick(i); e.preventDefault();
      }
    });
    if (st.refocus != null){
      var again = svg.querySelector('.own-hit[data-i="' + st.refocus + '"]');
      st.refocus = null;
      if (again){ svg.querySelectorAll('.own-hit').forEach(function(x){ x.setAttribute('tabindex', '-1'); }); again.setAttribute('tabindex', '0'); again.focus({preventScroll: true}); }
    }
  }

  if (own){
    var monthOptions = own.months.map(function(m, i){ return '<option value="' + i + '">' + esc(monthText(i)) + '</option>'; }).join('');
    ownFrom.innerHTML = monthOptions; ownTo.innerHTML = monthOptions;
    ownFrom.addEventListener('change', function(){ var f = +ownFrom.value; location.hash = ownHref(ownState.t, f, Math.max(f, ownState.to)); });
    ownTo.addEventListener('change', function(){ var t = +ownTo.value; location.hash = ownHref(ownState.t, Math.min(t, ownState.from), t); });
    ownPick.addEventListener('change', function(){ ownSearch.value = ''; location.hash = ownHref(ownPick.value, ownState.from, ownState.to); });
    var ownTimer;
    ownSearch.addEventListener('input', function(){
      clearTimeout(ownTimer);
      ownTimer = setTimeout(function(){
        ownState.all = false;
        // Mengetik saat membuka satu emiten kembali ke daftar yang tersaring.
        if (ownState.t) location.hash = ownHref('', ownState.from, ownState.to); else renderOwn();
      }, 140);
    });
    ownSearch.addEventListener('keydown', function(e){
      if (e.key !== 'Enter' || !ownData) return;
      var v = ownSearch.value.trim(), q = v.toLowerCase(), hit = ownData.byT[v.toUpperCase()];
      if (!hit){
        var matches = ownData.companies.filter(function(c){ return c.hay.indexOf(q) !== -1; });
        if (matches.length === 1) hit = matches[0];
      }
      if (hit){ ownSearch.value = ''; location.hash = ownHref(hit.t, ownState.from, ownState.to); }
    });
    ownBody.addEventListener('change', function(e){
      if (e.target.id !== 'own-urut') return;
      ownState.sort = e.target.value; ownState.all = false; renderOwn();
      var sel = document.getElementById('own-urut');
      if (sel) sel.focus();
    });
    ownBody.addEventListener('click', function(e){ if (e.target.id === 'own-semua'){ ownState.all = true; renderOwn(); } });
    var ownResize;
    window.addEventListener('resize', function(){
      clearTimeout(ownResize);
      ownResize = setTimeout(function(){
        var el = document.getElementById('own-trend'), c = ownData && ownData.byT[ownState.t];
        if (el && c && !ownView.hidden && +el.getAttribute('data-w') !== Math.max(300, Math.floor(el.clientWidth))) trendChart(el, c);
      }, 150);
    });
  }

  function filter(){
    var raw = input.value.trim(), q = raw.toLowerCase(), shown = 0;
    docs.forEach(function(d){
      var hits = q ? count(d.body, q) : 0, hit = !q || hits > 0 || d.hay.indexOf(q) !== -1;
      if (hit) shown++;
      document.querySelectorAll('[data-id="' + d.id + '"]').forEach(function(el){
        el.hidden = !hit;
        var h = el.querySelector('.hits');
        if (h) h.textContent = hits ? hits + '× di teks' : '';
      });
    });
    document.querySelectorAll('.cat,.day,.tree-cat,.tree-day').forEach(function(g){
      g.hidden = !g.querySelector('[data-id]:not([hidden])');
    });
    document.querySelectorAll('.category-nav a').forEach(function(a){
      a.hidden = document.getElementById(a.getAttribute('href').slice(1)).hidden;
    });
    if (raw.length >= 2) loadForSearch();
    var waiting = 0, failed = 0;
    lazyDocs.forEach(function(d){ if (d.content == null){ if (d.failed) failed++; else waiting++; } });
    var code = raw.toUpperCase(), ownHint = own && own.tickers.indexOf(code) !== -1 ?
      ' · <a href="#kepemilikan=' + encodeURIComponent(code) + '">Kepemilikan saham ' + esc(code) + ' →</a>' : '';
    note.innerHTML = q ? esc(shown + ' dari ' + docs.length + ' dokumen memuat “' + raw + '”' +
      (raw.length >= 2 && waiting ? ' · memuat isi ' + waiting + ' dokumen besar…' : '') +
      (raw.length >= 2 && failed ? ' · isi ' + failed + ' dokumen besar belum ikut dicari' : '')) + ownHint : '';
    empty.hidden = shown > 0;
    if (current && !reader.hidden && renderedQuery !== raw){
      var frame = reader.querySelector('.doc-frame');
      if (current.kind === 'md') renderDoc(current, raw); else if (frame) markFrame(frame, current, raw);
    }
  }

  var timer;
  input.addEventListener('input', function(){ clearTimeout(timer); timer = setTimeout(filter, 140); });
  window.addEventListener('hashchange', route);
  route();
})();
"""


# ---------------------------------------------------------------- page

def doc_href(doc):
    # Semua dokumen (MD dan HTML) dibuka di dalam viewer supaya pengunjungnya terhitung.
    return doc_link(doc["path"])


def stat_span(key, cls="stat", live_label="aktif", always_live=False):
    """Tempat angka pengunjung; diisi JS saat kemampuan db/room tersedia."""
    extra = " always-live" if always_live else ""
    return f'<span class="{cls}{extra}" data-stat-key="{esc(key)}" data-live-label="{esc(live_label)}" hidden></span>'


def overview_item(doc):
    meta = [f'<span class="fmt">{"Markdown" if doc["kind"] == "md" else "HTML"}</span>',
            f'<span>{angka(round(doc["size"] / 1024))} KB</span>']
    if doc["kind"] == "md":
        if doc["codes"]:
            meta.append(f'<span>{len(doc["codes"])} emiten</span>')
        meta.append(f'<span>{angka(doc["words"])} kata</span>')
    else:
        meta += [f"<span>{esc(s)}</span>" for s in doc["stats"]]
    meta.append(stat_span(doc["key"], live_label="sedang membaca"))
    limit, chips = 12, []
    for code, section in doc["codes"][:limit]:
        chips.append(f'<a class="chip" href="{esc(doc_link(doc["path"], section))}">{esc(code)}</a>' if section
                     else f'<span class="chip">{esc(code)}</span>')
    if len(doc["codes"]) > limit:
        chips.append(f'<span class="chip-more">+{len(doc["codes"]) - limit} kode</span>')
    return (f'<li class="doc" data-id="{doc["id"]}">'
            f'<a class="doc-title" href="{esc(doc_href(doc))}">{esc(doc["title"])}</a>'
            + (f'<p class="doc-desc">{esc(doc["desc"])}</p>' if doc["desc"] else "")
            + f'<p class="doc-meta">{"".join(meta)}</p>'
            + (f'<div class="chips">{"".join(chips)}</div>' if chips else "") + "</li>")


def groups_by_day(docs):
    groups = {}
    for d in docs:
        groups.setdefault((d["_start"], d["_end"], d["_precision"]), []).append(d)
    return [(k, sorted(groups[k], key=lambda d: d["title"]))
            for k in sorted(groups, key=lambda k: (k[1], k[0]), reverse=True)]


def build_page(docs, by_cat, own=None):
    first = min((d["_start"] for d in docs), default=None)
    last = max((d["_end"] for d in docs), default=None)
    span = date_label(first, last) if docs else "belum ada dokumen"
    counts = f'<b>{len(docs)}</b> dokumen · {esc(span)}'

    tree, sections, category_links = [], [], []
    for key, cdocs in by_cat.items():
        cat = CATEGORIES[key]
        category_links.append(f'<a href="#{key}" data-cat="{key}"><span class="swatch" aria-hidden="true"></span>{esc(cat["name"])}</a>')
        days_tree, days_main = [], []
        for (start, end, precision), items in groups_by_day(cdocs):
            links = "".join(
                f'<a class="tree-doc" data-id="{d["id"]}" href="{esc(doc_href(d))}"><span>{esc(d["title"])}</span>'
                f'<span class="fmt">{"MD" if d["kind"] == "md" else "HTML"}</span><span class="hits"></span>'
                f'{stat_span(d["key"], cls="stat tree-stat")}</a>'
                for d in items)
            days_tree.append(f'<div class="tree-day"><time datetime="{start.isoformat()}">{esc(date_label(start, end, precision))}</time>{links}</div>')
            num, my, wd = day_parts(start, end, precision)
            long = " long" if len(num) > 6 else ""
            days_main.append(f'<div class="day"><time class="day-date" datetime="{start.isoformat()}">'
                             f'<span class="d{long}">{esc(num)}</span><span class="my">{esc(my)}</span><span class="wd">{esc(wd)}</span>'
                             f'</time><ul class="docs">{"".join(overview_item(d) for d in items)}</ul></div>')
        tree.append(f'<section class="tree-cat" data-cat="{key}"><h2><span class="swatch"></span>{esc(cat["name"])}'
                    f'<span class="n">{len(cdocs)}</span></h2>{"".join(days_tree)}</section>')
        sections.append(f'<section class="cat" data-cat="{key}" id="{key}"><div class="cat-head">'
                        f'<h2><span class="swatch"></span>{esc(cat["name"])}</h2>'
                        f'<span class="cat-count">{len(cdocs)} dokumen</span></div>'
                        f'<p class="cat-blurb">{esc(cat["blurb"])}</p><div class="ledger">{"".join(days_main)}</div></section>')

    raw_links = "".join(f'<li><a href="{esc(d["path"])}">{esc(d["title"])}</a> ({esc(d["label"])})</li>' for d in docs)
    entries = []
    for d in docs:
        entry = {k: v for k, v in d.items() if not k.startswith("_") and k != "raw"}
        if d["kind"] == "md" and d["size"] > EMBED_LIMIT:
            del entry["content"]
            entry["lazy"] = True
        entries.append(entry)
    payload = {
    "version": BUILD_ID,
    "docs": entries,
    "own": own and {k: own[k] for k in ("path", "months", "count", "tickers")}
    }
    data_json = json.dumps(payload, ensure_ascii=False).replace("</", "<\\/")
    desc = ("Arsip riset pasar modal: laporan Stockbit, keterbukaan informasi Indonesia dan Australia, serta digest per emiten, dikelompokkan per sumber "
            "dan tanggal, plus grafik kepemilikan saham KSEI per emiten.")
    canonical = f'<link rel="canonical" href="{esc(BASE_URL)}/">' if BASE_URL else ""

    head = (f"<title>{SITE_NAME}</title>"
            f'<meta name="description" content="{esc(desc)}">{canonical}'
            '<link rel="preconnect" href="https://fonts.googleapis.com">'
            '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
            f'<link rel="stylesheet" href="{FONTS}"><style>{CSS}</style>')
    tabs = ('<nav class="tabs" aria-label="Tampilan">'
            f'<a class="wordmark" href="#">{SITE_NAME}</a>'
            f'<a class="tab" data-tab="docs" href="#" aria-current="page">Dokumen <span class="n">{len(docs)}</span></a>'
            + (f'<a class="tab" data-tab="own" href="#kepemilikan=">Kepemilikan Saham <span class="n">{angka(own["count"])} emiten</span></a>' if own else "")
            + "</nav>")
    own_view = ""
    if own:
        first_m, last_m = own["months"][0], own["months"][-1]
        span_own = (date_label(date.fromisoformat(first_m["asOf"]), date.fromisoformat(last_m["asOf"]))
                    if first_m.get("asOf") and last_m.get("asOf") else f'{first_m["p"]} – {last_m["p"]}')
        own_view = ('<section class="own" id="own" data-cat="kepemilikan" aria-labelledby="own-title" hidden>'
                    '<header class="own-hero"><h1 id="own-title">Kepemilikan saham</h1>'
                    '<p class="lede">Siapa memegang saham emiten dan bagaimana porsinya bergeser dari satu tanggal ke tanggal lain. '
                    "Pemegang di atas 1% dari KSEI; free float resmi dan jumlah pemegang dari laporan bulanan emiten. Disalin dari IDX Signal Desk.</p>"
                    f'<p class="tally"><span><b>{angka(own["count"])}</b> emiten</span><span><b>{len(own["months"])}</b> bulan data KSEI</span>'
                    f"<span>{esc(span_own)}</span>" + stat_span("kepemilikan", live_label="melihat", always_live=True) + "</p></header>"
                    '<div class="own-bar">'
                    '<label class="own-field own-search">Cari<input id="own-cari" type="search" placeholder="Kode atau nama, mis. BBCA" autocomplete="off" spellcheck="false"></label>'
                    '<label class="own-field own-pick">Emiten<select id="own-emiten"><option value="">Semua emiten</option></select></label>'
                    '<label class="own-field own-month">Dari<select id="own-dari"></select></label>'
                    '<label class="own-field own-month">Sampai<select id="own-sampai"></select></label></div>'
                    '<div id="own-body" aria-live="polite"></div></section>')
    body = (tabs + '<div class="app">'
            f'<aside class="rail"><p class="tally">{counts}</p>'
            '<div class="search"><label class="sr" for="cari">Cari di semua dokumen</label>'
            '<input id="cari" type="search" autocomplete="off" placeholder="Cari kode, kata, tanggal…">'
            '<p class="search-note" id="cari-catatan" aria-live="polite"></p></div>'
            f'<nav class="tree" aria-label="Dokumen">{"".join(tree)}</nav></aside>'
            '<main class="stage"><div id="overview">'
            f'<nav class="category-nav" aria-label="Sumber dokumen">{"".join(category_links)}</nav>'
            '<header class="masthead">'
            "<h1>Laporan riset pasar modal, per sumber dan tanggal</h1>"
            '<p class="lede">Penelusuran Stockbit, pemeriksaan keterbukaan informasi Indonesia dan Australia, serta digest per emiten BEI. '
            "Dokumen Markdown dibaca langsung di halaman ini; pencarian ikut membaca isi teksnya."
            + (" Grafik pemegang saham per emiten ada di tab Kepemilikan Saham." if own else "") + "</p>"
            f'<p class="tally"><span><b>{len(docs)}</b> dokumen</span><span><b>{len(by_cat)}</b> sumber</span>'
            f"<span>{esc(span)}</span>"
            + stat_span("home", live_label="di beranda", always_live=True)
            + '<span class="stat stat-online" hidden></span></p></header>'
            + f'<div class="cats">{"".join(sections)}</div>'
            + '<p class="empty" id="kosong" hidden>Tidak ada dokumen yang cocok. Coba kode saham 4 huruf, nama orang, atau nama bulan.</p>'
            f'<noscript><p class="empty">JavaScript mati. Buka berkas mentahnya:</p><ul>{raw_links}</ul></noscript>'
            f'<footer class="foot"><span>{SITE_NAME}</span><span>dibangun {esc(date_label(date.today(), date.today()))}</span>'
            + (f"<span>data terbaru {esc(date_label(last, last))}</span>" if last else "") + "</footer></div>"
            '<article id="reader" hidden></article></main></div>' + own_view +
            f'<script type="application/json" id="arsip-data">{data_json}</script>'
            + "".join(f'<script src="{src}"></script>' for src in LIBS)
            + f"<script>{APP_JS}</script>")
    return head, body


# ---------------------------------------------------------------- main

def ownership_meta():
    """Ringkasan kepemilikan.json untuk tab Kepemilikan Saham, atau None kalau belum disinkron."""
    if not OWN_SRC.is_file():
        return None
    raw = json.loads(OWN_SRC.read_text(encoding="utf-8"))
    months = [{"p": m["p"], "asOf": m.get("asOf")} for m in raw.get("months") or []]
    companies = raw.get("companies") or []
    if not months or not companies:
        return None
    return {"path": OWN_PATH, "months": months, "count": len(companies), "tickers": [c["t"] for c in companies]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--fragment-index", type=Path,
                    help="tulis juga versi index tanpa <html>/<head>/<body> (untuk Claude Artifact)")
    args = ap.parse_args()

    # Termasuk subfolder (mis. idx-signal-desk/ hasil tools/sync_idx.py); berkas dan folder berawalan titik dilewati.
    files = sorted((p for p in SRC.rglob("*")
                    if p.is_file() and p.suffix.lower() in (".md", ".html", ".htm")
                    and not any(part.startswith(".") for part in p.relative_to(SRC).parts)),
                   key=lambda p: p.relative_to(SRC).as_posix())
    docs = [load_doc(p, i) for i, p in enumerate(files)]
    # Kunci statistik dan nama di files/ harus unik (tanpa beda huruf besar-kecil, karena disk macOS juga begitu).
    seen = {}
    for doc, src in zip(docs, files):
        if doc["key"] in seen:
            raise SystemExit(f"Nama berkas ganda di {SRC.name}/: {seen[doc['key']]} dan {src.relative_to(SRC)}")
        seen[doc["key"]] = src.relative_to(SRC)
    by_cat = {k: [d for d in docs if d["cat"] == k] for k in CATEGORIES}
    by_cat = {k: v for k, v in by_cat.items() if v}

    out = args.out
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    (out / "version.json").write_text(
      json.dumps({"version": BUILD_ID}),
      encoding="utf-8"
    )
    for doc, src in zip(docs, files):
        target = out / doc["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if doc["kind"] == "md":
            shutil.copy2(src, target)
        else:
            target.write_text(with_nav_bar(doc), encoding="utf-8")

    own = ownership_meta()
    if own:
        (out / OWN_PATH).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(OWN_SRC, out / OWN_PATH)
    head, body = build_page(docs, by_cat, own)
    (out / "index.html").write_text(
        '<!doctype html>\n<html lang="id"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        f"{head}</head><body>{body}</body></html>\n", encoding="utf-8")
    if args.fragment_index:
        args.fragment_index.parent.mkdir(parents=True, exist_ok=True)
        args.fragment_index.write_text(head + body, encoding="utf-8")

    robots = "User-agent: *\nAllow: /\n"
    if BASE_URL:
        latest = max((d["end"] for d in docs), default=date.today().isoformat())
        urls = [(f"{BASE_URL}/", latest)] + [(f"{BASE_URL}/{quote(d['path'])}", d["end"]) for d in docs]
        (out / "sitemap.xml").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            + "".join(f"<url><loc>{esc(u)}</loc><lastmod>{m}</lastmod></url>" for u, m in urls)
            + "</urlset>\n", encoding="utf-8")
        robots += f"Sitemap: {BASE_URL}/sitemap.xml\n"
    (out / "robots.txt").write_text(robots, encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")

    for d in docs:
        print(f"{d['catName']:<22} {d['label']:<24} {d['name']} -> {d['path']}")
    if own:
        print(f"{'Kepemilikan Saham':<22} {own['months'][0]['p']} s/d {own['months'][-1]['p']:<12} {OWN_SRC.name} -> {OWN_PATH} "
              f"({own['count']} emiten, {len(own['months'])} bulan)")
    print(f"{len(docs)} dokumen" + (" + tab Kepemilikan Saham" if own else "") + f" -> {out}")


if __name__ == "__main__":
    main()
