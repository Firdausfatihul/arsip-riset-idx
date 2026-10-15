#!/usr/bin/env python3
"""Bangun viewer Markdown, HTML, dan CSV statis dari folder needtobeindexed/ ke site/ (atau --out docs).

Berkas .md dan .csv disalin apa adanya ke files/ dan dirender di browser; HTML lama dibungkus
iframe terisolasi. Script ini membuat daftar dokumen (kategori + tanggal dari nama berkas, lihat
CATEGORIES) dan index.html: app.css, app.js + chat.js (satu skrip inline, hash-nya masuk CSP).
Data idx-signal-desk/ (kepemilikan, indeks Stockbit/BEI) dan harga/ disalin ke files/.

Pemakaian:
    python3 build.py                                  # hasil ke ./site
    BASE_URL=https://domain.kamu python3 build.py     # + canonical dan sitemap.xml
"""
import argparse
import base64
import hashlib
import html
import json
import os
import re
import shutil
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import quote, urlsplit

from tools.build_safety import check_output, check_source
from tools.evidence_index import csv_delimiter
from tools.ksei_signals import CUSTODIANS, NOMINEE

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "needtobeindexed"
OUT = ROOT / "site"
BASE_URL = os.environ.get("BASE_URL", "").rstrip("/")
CHAT_API_URL = os.environ.get("CHAT_API_URL", "/api/chat").rstrip("/")
SITE_NAME = "Arsip Riset IDX"
# BUILD_ID (YYYYMMDDhhmmss) juga tanggal "dibangun" di kaki halaman. Ditetapkan lewat env, dua build dari sumber
# yang sama identik byte per byte.
BUILD_ID = os.environ.get("BUILD_ID") or datetime.now().strftime("%Y%m%d%H%M%S")

# Urutan di sini = urutan tampil. Konvensi nama: stockbit_YYYYMMDD.md dan ki_YYYYMMDD.md.
# "prefixes" dicocokkan dengan kata pertama nama berkas, "keywords" dengan bagian mana pun.
CATEGORIES = {
    "stockbit": {
        "name": "Stockbit",
        "nav": "Stockbit",
        "blurb": ("Penelusuran postingan Stockbit Ideas: aksi korporasi, hubungan orang–perusahaan, kode, dan rumor. "
                  "Laporan lama ini dikumpulkan dengan kursor lama sebelum 7 Oktober 2026 dan tidak lengkap; "
                  "isinya diskusi pengguna Stockbit, belum diverifikasi, bukan keterbukaan resmi."),
        "prefixes": ("stockbit",),
        "keywords": ("stockbit",),
    },
    # Diisi tools/sync_idx.py --stockbit-only dari ekspor IDX Signal Desk (sbringkas_/sbdetail_/sbpekan_).
    "stockbit-ringkasan": {
        "name": "Ringkasan Stockbit",
        "nav": "Stockbit harian",
        "blurb": ("Ringkasan harian otomatis Stockbit Ideas, satu bagian per emiten, tiap klaim bertaut ke posting aslinya. "
                  "Isinya diskusi pengguna Stockbit, belum diverifikasi, bukan keterbukaan resmi."),
        "prefixes": ("sbringkas",),
        "keywords": (),
    },
    "stockbit-detail": {
        "name": "Detail Stockbit",
        "blurb": ("Semua temuan harian per emiten, lebih lengkap dari ringkasan harian. "
                  "Isinya diskusi pengguna Stockbit, belum diverifikasi, bukan keterbukaan resmi."),
        "prefixes": ("sbdetail",),
        "keywords": (),
    },
    "stockbit-pekan": {
        "name": "Stockbit mingguan",
        "blurb": ("Rekap Senin–Minggu dari ringkasan harian, disusun tanpa LLM. "
                  "Isinya diskusi pengguna Stockbit, belum diverifikasi, bukan keterbukaan resmi."),
        "prefixes": ("sbpekan",),
        "keywords": (),
    },
    # Diisi tools/sync_idx.py --bei-only dari ekspor IDX Signal Desk (beiringkas_/beidetail_/beipekan_). Awalan ini
    # dicocokkan sebelum kata kunci KI di bawah, jadi "beiringkas_..." tidak pernah jatuh ke Analisis KI (legacy).
    "bei-ringkasan": {
        "name": "Ringkasan keterbukaan BEI",
        "nav": "Indonesia (BEI)",
        "blurb": ("Ringkasan harian otomatis dari pengumuman resmi di idx.co.id: apa yang baru hari ini dibanding progres "
                  "pengumuman emiten itu sebelumnya. Bukan rekomendasi; angka dikutip dari dokumen emiten dan belum diaudit ulang."),
        "prefixes": ("beiringkas",),
        "keywords": (),
    },
    "bei-detail": {
        "name": "Detail BEI",
        "blurb": ("Semua pengumuman harian per emiten, lengkap dengan fakta, angka, riwayat, dan jadwal. "
                  "Ringkasan otomatis dari pengumuman resmi di idx.co.id; bukan rekomendasi."),
        "prefixes": ("beidetail",),
        "keywords": (),
    },
    "bei-pekan": {
        "name": "BEI mingguan",
        "blurb": ("Rekap Senin–Minggu dari ringkasan keterbukaan BEI harian, disusun tanpa LLM. "
                  "Bukan rekomendasi; angka dikutip dari dokumen emiten dan belum diaudit ulang."),
        "prefixes": ("beipekan",),
        "keywords": (),
    },
    # Analisis KI buatan tangan (ki_*.md) dipensiunkan: tanpa tombol sumber (nav None), tetap dibangun dan bisa dicari
    # supaya tautan #doc= lama tetap jalan. Selama belum ada ringkasan BEI, tombol "Indonesia (BEI)" tetap menunjuk ke sini.
    "keterbukaan-informasi": {
        "name": "Analisis KI (legacy)",
        "nav": None,
        "blurb": ("Arsip lama: pemeriksaan pengumuman keterbukaan informasi emiten BEI yang disusun manual sampai Oktober 2026. "
                  "Tidak diperbarui lagi; ringkasan harian baru ada di Indonesia (BEI)."),
        "prefixes": ("ki", "idx"),
        "keywords": ("keterbukaan", "pemeriksaan", "emiten", "digest", "disclosure"),
    },
    "keterbukaan-australia": {
        "name": "Keterbukaan Informasi Australia",
        "nav": "Australia (ASX)",
        "blurb": "Kronologi dan kesimpulan riset dari pengumuman emiten Bursa Efek Australia.",
        "prefixes": ("asx",),
        "keywords": (),
    },
    "keterbukaan-singapura": {
        "name": "Keterbukaan Informasi Singapura (SGX)",
        "nav": "Singapura (SGX)",
        "blurb": "Kronologi dan kesimpulan riset dari pengumuman emiten Bursa Singapura (SGX).",
        "prefixes": ("sgx",),
        "keywords": (),
    },
    # Diisi otomatis oleh tools/sync_idx.py dari IDX Signal Desk (kepemilikan saham punya tab sendiri, bukan kategori).
    # Dipensiunkan: tanpa tombol sumber dan tidak tampil di daftar utama ("unlisted"), tetapi berkasnya tetap dibangun
    # sehingga tautan #doc= lama tetap jalan. Sinkronnya mati kecuali tools/sync_idx.py --with-digests.
    "digest-emiten": {
        "name": "Digest Emiten",
        "nav": None,
        "unlisted": True,
        "blurb": "Arsip lama: ringkasan per emiten dari IDX Signal Desk, satu berkas per jendela tanggal yang tersimpan.",
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
EMITEN_H3 = re.compile(r"^(?:(\d+(?:\.\d+)*)\.?\s+)?([A-Z]{4})(?:\s+[—–-]\s+(.+))?$")
FONTS = ("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600"
         "&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap")
LIBS = (
    ("https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.7/marked.min.js", "sha384-H+hy9ULve6xfxRkWIh/YOtvDdpXgV2fmAGQkIDTxIgZwNoaoBal14Di2YTMR6MzR"),
    ("https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.4.15/purify.min.js", "sha384-uUMu9JDY09vBzRf9SPcK2VgUj+W/70J6Soc+Dded5P474ElQ63iv9j5N3DE7Kp3N"),
)
# Markdown/CSV di atas batas ini diambil dari files/… saat dibuka atau dicari.
EMBED_LIMIT = 256 * 1024
EXPLICIT_RANGE = re.compile(r"\d{4}-\d{2}-\d{2}[_\-\s]+(?:to[_\-\s]+)?\d{4}-\d{2}-\d{2}")
# Berkas *_SRC di bawah ini relatif terhadap SRC (tes cukup mengganti SRC); *_PATH = lokasinya di situs.
# Data tab Kepemilikan Saham: disalin apa adanya, viewer mengambilnya saat tab dibuka.
OWN_SRC = "idx-signal-desk/kepemilikan.json"
OWN_PATH = "files/kepemilikan/kepemilikan.json"
# Laporan perubahan kepemilikan (tools/sync_idx.py), diambil viewer saat satu emiten dibuka.
CHANGES_SRC = "idx-signal-desk/kepemilikan-perubahan.json"
CHANGES_PATH = "files/kepemilikan/kepemilikan-perubahan.json"
# Daftar pemegang saham, jenis pemilik BAE, dan tautan laporan bulanan emiten; diambil saat satu emiten dibuka.
REPORTS_SRC = "idx-signal-desk/kepemilikan-laporan.json"
REPORTS_PATH = "files/kepemilikan/kepemilikan-laporan.json"
# Harga penutupan per tanggal snapshot KSEI (tools/sync_prices.py), dimuat bersama data kepemilikan.
PRICES_SRC = "harga/harga.json"
PRICES_PATH = "files/kepemilikan/harga.json"
# Indeks lintas hari ringkasan Stockbit (tools/sync_idx.py --stockbit-only); viewer mengambilnya untuk #emiten= / #pengguna=.
SB_INDEX_SRC = "idx-signal-desk/stockbit-index.json"
SB_INDEX_PATH = "files/stockbit-index/stockbit-index.json"
# Indeks lintas hari ringkasan keterbukaan BEI (tools/sync_idx.py --bei-only); bagian BEI di halaman #emiten=.
BEI_INDEX_SRC = "idx-signal-desk/bei-index.json"
BEI_INDEX_PATH = "files/bei-index/bei-index.json"
# Ringkasan Stockbit/BEI yang lebih tua dari ini (dihitung dari hari ringkasan terbaru sumbernya) diambil saat dibuka, tidak di-embed.
SB_EMBED_DAYS = 7
# Peringatan build kalau index.html melewati ukuran ini (konten di-embed bisa membengkak tanpa terasa).
PAGE_WARN_BYTES = 15 * 1024 * 1024
# Semua berkas Stockbit (files/stockbit/, files/stockbit-ringkasan/, files/stockbit-index/, …) keluar dari mesin pencari.
ROBOTS_DISALLOW = ("/files/stockbit",)


# ---------------------------------------------------------------- helpers

def esc(text):
    return html.escape(str(text), quote=True)


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
    # Tanggal rapat di akhir nama, mis. sgx_january-20september2026:
    # 20 September adalah tanggal penyusunan, bukan rentang cakupan arsip.
    m = re.search(rf"(?<!\d)(\d{{1,2}})({MONTH_RE})(\d{{4}})$", stem, re.I)
    if m:
        d = _date(m[3], MONTHS[m[2].lower()], m[1])
        if d:
            return d, d, "day"
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
    if low.startswith("keterbukaan_sg_"):
        return "keterbukaan-singapura"
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
    check_source(path, SRC)
    stem = path.stem
    text = path.read_text(encoding="utf-8", errors="replace")
    kind = {".md": "md", ".csv": "csv"}.get(path.suffix.lower(), "html")
    modified = datetime.fromtimestamp(path.stat().st_mtime).date()
    start, end, precision = parse_dates(stem) or (modified, modified, "day")
    # Nama yang sudah menulis dua tanggal lengkap tidak ditafsir ulang dari isi dokumen.
    exact = None if kind == "csv" or EXPLICIT_RANGE.search(stem) else refine_from_text(text, start, end, precision)
    if exact:
        (start, end), precision = exact, "day"
    elif precision == "month":
        end = max(start, min(end, modified))
    category = categorize(stem)
    if kind == "csv":
        title, desc, codes = "", "Tabel CSV · baris pertama sebagai judul kolom.", []
    else:
        title, desc, codes = md_info(text) if kind == "md" else html_info(text)
    doc = {
        "id": f"d{index}",
        # Nama di files/ tanpa beda huruf besar-kecil; harus unik (disk macOS tidak membedakannya). Tidak masuk payload.
        "_key": re.sub(r"[^a-z0-9_-]+", "-", path.name.lower()).strip("-"),
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
        "tickers": sorted(set(TICKER.findall(strip_tags(text) if kind == "html" else text))),
    }
    if kind == "md":
        doc["words"] = len(re.findall(r"\S+", text))
        doc["content"] = text
    elif kind == "csv":
        doc["content"], doc["stats"], doc["delimiter"] = text, [], csv_delimiter(text)
    else:
        cards = re.findall(r'<div class="card"><strong>([^<]+)</strong><span>([^<]+)</span>', text)
        doc["stats"] = [f"{squash(n)} {squash(lbl)}" for n, lbl in cards[:3]]
        doc["text"] = html_text(text)
        doc["raw"] = text
    doc["_start"], doc["_end"], doc["_precision"] = start, end, precision
    return doc


def script_hash(script):
    return "'sha256-" + base64.b64encode(hashlib.sha256(script.encode()).digest()).decode() + "'"


def report_scripts(raw):
    # Only hashes of inline report scripts are allowed; no remote scripts, handlers, or eval.
    return re.findall(r"<script\b[^>]*>(.*?)</script\s*>", raw, re.S | re.I)


class ReportHandlers(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values = set()

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if name.startswith("on") and value:
                self.values.add(value)


def with_nav_bar(doc):
    """Keep original report intact inside an opaque sandbox, including on direct URLs."""
    raw = doc["raw"]
    bridge = (ROOT / "report-frame.js").read_text()
    shell = (ROOT / "report-shell.js").read_text()
    scripts = [shell, bridge] + report_scripts(raw)
    handlers = ReportHandlers()
    handlers.feed(raw)
    handler_policy = " 'unsafe-hashes' " + " ".join(script_hash(v) for v in sorted(handlers.values)) if handlers.values else ""
    policy = ("default-src 'none'; script-src " + " ".join(script_hash(x) for x in scripts) + handler_policy +
              "; style-src 'unsafe-inline'; img-src data:; frame-src 'self'; base-uri 'none'; form-action 'none'")
    content = raw + '<script>' + bridge + '</script>'
    return ('<!doctype html><html lang="id"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<meta name="referrer" content="no-referrer">'
            f'<meta http-equiv="Content-Security-Policy" content="{esc(policy)}">'
            f'<title>{esc(doc["title"])}</title>'
            '<style>html,body{margin:0;height:100%;font:16px system-ui}body{display:flex;flex-direction:column}'
            'nav{padding:12px;background:#0b1620}nav a{color:white}iframe{border:0;width:100%;flex:1;min-height:0}[hidden]{display:none}</style>'
            '</head><body><nav id="report-nav"><a href="../../../index.html">← Arsip Riset IDX</a></nav>'
            f'<iframe id="report-content" title="{esc(doc["title"])}" sandbox="allow-scripts allow-popups" '
            f'referrerpolicy="no-referrer" srcdoc="{esc(content)}"></iframe>'
            f'<script>{shell}</script></body></html>')


# ---------------------------------------------------------------- viewer (app.css, app.js + chat.js)

CSS = (ROOT / "app.css").read_text(encoding="utf-8")
# The ownership tab pools the same custodian/nominee accounts as the chat signals (tools/ksei_signals.py).
APP_JS = ((ROOT / "app.js").read_text(encoding="utf-8")
          .replace("__NOMINEE_RE__", "/" + NOMINEE.pattern.replace("/", "\\/") + "/")
          .replace("__CUSTODIAN_RE__", "/\\b(" + "|".join(CUSTODIANS + ("BANK OF SINGAPORE",)) + ")\\b/"))
PAGE_JS = APP_JS + "\n" + (ROOT / "chat.js").read_text(encoding="utf-8")   # one inline script; its hash goes in the CSP


# ---------------------------------------------------------------- page

def doc_href(doc):
    # Semua dokumen dibuka di dalam viewer.
    return doc_link(doc["path"])


def overview_item(doc):
    label = {"md": "Markdown", "html": "HTML", "csv": "CSV"}[doc["kind"]]
    meta = [f'<span class="fmt">{label}</span>',
            f'<span>{angka(round(doc["size"] / 1024))} KB</span>']
    if doc["kind"] == "md":
        if doc["codes"]:
            meta.append(f'<span>{len(doc["codes"])} emiten</span>')
        meta.append(f'<span>{angka(doc["words"])} kata</span>')
    else:
        meta += [f"<span>{esc(s)}</span>" for s in doc["stats"]]
    limit, chips = 12, []
    for code, section in doc["codes"][:limit]:
        chips.append(f'<a class="chip" href="{esc(doc_link(doc["path"], section))}">{esc(code)}</a>' if section
                     else f'<span class="chip">{esc(code)}</span>')
    if len(doc["codes"]) > limit:
        chips.append(f'<span class="chip-more">+{len(doc["codes"]) - limit} kode</span>')
    desc = f'<p class="doc-desc">{esc(doc["desc"])}</p>' if doc["desc"] else ""
    cov = re.match(r"Cakupan:\s*(.+)", doc["desc"]) if doc["cat"] == "stockbit-ringkasan" else None
    if cov:
        # Paragraf "Cakupan: …" dari DESK jadi lencana cakupan di kartu ringkasan harian.
        desc = f'<p class="doc-desc sb-cov"><span class="sb-badge">Cakupan</span> {esc(cov[1])}</p>'
    return (f'<li class="doc" data-id="{doc["id"]}">'
            f'<a class="doc-title" href="{esc(doc_href(doc))}">{esc(doc["title"])}</a>'
            + desc
            + f'<p class="doc-meta">{"".join(meta)}</p><span class="hits"></span>'
            + (f'<div class="chips">{"".join(chips)}</div>' if chips else "") + "</li>")


def groups_by_day(docs):
    groups = {}
    for d in docs:
        groups.setdefault((d["_start"], d["_end"], d["_precision"]), []).append(d)
    return [(k, sorted(groups[k], key=lambda d: d["title"]))
            for k in sorted(groups, key=lambda k: (k[1], k[0]), reverse=True)]


# Detail harian selalu diambil saat dibuka; ringkasan harian lama juga (lihat SB_EMBED_DAYS).
ALWAYS_LAZY = ("stockbit-detail", "bei-detail")
DAILY_SUMMARIES = ("stockbit-ringkasan", "bei-ringkasan")


def unlisted(cat):
    """Kategori yang dipensiunkan dari daftar utama (berkas tetap dibangun untuk tautan #doc= lama)."""
    return bool(CATEGORIES.get(cat, {}).get("unlisted"))


def embed_entries(docs):
    """Rekaman dokumen untuk payload halaman; isi besar dan Stockbit/BEI lama/detail diambil saat dibuka (lazy).

    Dokumen kategori unlisted (Digest Emiten) ditandai "unlisted": viewer tidak menghitung atau mengambilnya saat mencari.
    """
    newest = {cat: max((d["_end"] for d in docs if d["cat"] == cat), default=None) for cat in DAILY_SUMMARIES}
    entries = []
    for d in docs:
        entry = {k: v for k, v in d.items() if not k.startswith("_") and k != "raw"}
        lazy = d["kind"] != "html" and (
            d["size"] > EMBED_LIMIT
            or d["cat"] in ALWAYS_LAZY
            or (d["cat"] in DAILY_SUMMARIES and d["_end"] < newest[d["cat"]] - timedelta(days=SB_EMBED_DAYS)))
        if lazy:
            del entry["content"]
            entry["lazy"] = True
        if unlisted(d["cat"]):
            entry["unlisted"] = True
        entries.append(entry)
    return entries


def bei_find_form(key):
    return (f'<form class="sb-find" data-bei-find role="search"><label for="bei-cari-{key}">Cari emiten di ringkasan keterbukaan BEI</label>'
            f'<div class="sb-find-row"><input id="bei-cari-{key}" type="search" maxlength="12" autocomplete="off" spellcheck="false" '
            'placeholder="Mis. BBCA"><button type="submit">Buka</button></div></form>')


def legacy_link():
    return ('<p class="cat-legacy"><a href="#keterbukaan-informasi">'
            f'{esc(CATEGORIES["keterbukaan-informasi"]["name"])}: analisis manual lama →</a></p>')


def sb_find_form(key):
    return (f'<form class="sb-find" data-sb-find role="search"><label for="sb-cari-{key}">Cari emiten atau @pengguna di ringkasan Stockbit</label>'
            f'<div class="sb-find-row"><input id="sb-cari-{key}" type="search" maxlength="64" autocomplete="off" spellcheck="false" '
            'placeholder="Mis. BBCA atau @nama"><button type="submit">Buka</button></div></form>')


def nav_label(key, by_cat):
    """Label tombol sumber, atau None (tanpa tombol). nav None = kategori dipensiunkan dari navigasi; Analisis KI (legacy)
    tetap memakai tombol "Indonesia (BEI)" selama arsip belum punya ringkasan BEI, supaya daftarnya tidak hilang dari navigasi."""
    cat = CATEGORIES[key]
    if key == "keterbukaan-informasi" and "bei-ringkasan" not in by_cat:
        return CATEGORIES["bei-ringkasan"]["nav"]
    return cat.get("nav", cat["name"])


def build_page(docs, by_cat, own=None, sb=None, bei=None):
    listed_docs = [d for d in docs if not unlisted(d["cat"])]
    first = min((d["_start"] for d in listed_docs), default=None)
    last = max((d["_end"] for d in listed_docs), default=None)
    span = date_label(first, last) if listed_docs else "belum ada dokumen"
    sections, category_links = [], []
    for key, cdocs in by_cat.items():
        cat = CATEGORIES[key]
        if unlisted(key):
            continue  # tanpa tombol dan tanpa daftar; dokumennya tetap ada di payload untuk #doc=
        label = nav_label(key, by_cat)
        if label:
            category_links.append(f'<a href="#{key}" data-cat="{key}"><span class="swatch" aria-hidden="true"></span>{esc(label)}</a>')
        days_main = []
        for (start, end, precision), items in groups_by_day(cdocs):
            num, my, wd = day_parts(start, end, precision)
            long = " long" if len(num) > 6 else ""
            days_main.append(f'<div class="day"><time class="day-date" datetime="{start.isoformat()}">'
                             f'<span class="d{long}">{esc(num)}</span><span class="my">{esc(my)}</span><span class="wd">{esc(wd)}</span>'
                             f'</time><ul class="docs">{"".join(overview_item(d) for d in items)}</ul></div>')
        sections.append(f'<section class="cat" data-cat="{key}" id="{key}"><div class="cat-head">'
                        f'<h2><span class="swatch"></span>{esc(cat["name"])}</h2>'
                        f'<span class="cat-count">{len(cdocs)} dokumen</span></div>'
                        f'<p class="cat-blurb">{esc(cat["blurb"])}</p>'
                        + (sb_find_form(key) if sb and key in ("stockbit", "stockbit-ringkasan") else "")
                        + (bei_find_form(key) if bei and key == "bei-ringkasan" else "")
                        + (legacy_link() if key == "bei-ringkasan" and "keterbukaan-informasi" in by_cat else "")
                        + f'<div class="ledger">{"".join(days_main)}</div></section>')

    built = datetime.strptime(BUILD_ID[:8], "%Y%m%d").date()
    raw_links = "".join(f'<li><a href="{esc(d["path"])}">{esc(d["title"])}</a> ({esc(d["label"])})</li>' for d in docs)
    entries = embed_entries(docs)
    payload = {
    "version": BUILD_ID,
    "chatApi": CHAT_API_URL,
    "docs": entries,
    "own": own and {k: own[k] for k in ("path", "changes", "reports", "prices", "months", "count", "tickers")},
    "stockbit": sb and {k: sb[k] for k in ("path", "days", "tickers", "users")},
    "bei": bei and {k: bei[k] for k in ("path", "days", "tickers")},
    }
    data_json = json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    desc = ("Arsip riset pasar modal: Stockbit, keterbukaan informasi Indonesia, Australia, Singapura, "
            "dan kepemilikan saham KSEI.")
    canonical = f'<link rel="canonical" href="{esc(BASE_URL)}/">' if BASE_URL else ""

    head = (f"<title>{SITE_NAME}</title>"
            f'<meta name="description" content="{esc(desc)}">{canonical}'
            '<link rel="preconnect" href="https://fonts.googleapis.com">'
            '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
            f'<link rel="stylesheet" href="{FONTS}"><style>{CSS}</style>')
    tabs = ('<nav class="tabs" aria-label="Tampilan">'
            f'<a class="wordmark" href="#">{SITE_NAME}</a>'
            f'<a class="tab" data-tab="docs" href="#" aria-current="page">Dokumen <span class="n">{len(listed_docs)}</span></a>'
            + (f'<a class="tab" data-tab="own" href="#kepemilikan=">Kepemilikan Saham <span class="n">{angka(own["count"])} emiten</span></a>' if own else "")
            + "</nav>")
    own_view = ""
    if own:
        ksei_m = [m for m in own["months"] if m.get("asOf")]
        first_m, last_m = (ksei_m[0], ksei_m[-1]) if ksei_m else (own["months"][0], own["months"][-1])
        span_own = (date_label(date.fromisoformat(first_m["asOf"]), date.fromisoformat(last_m["asOf"]))
                    if first_m.get("asOf") and last_m.get("asOf") else f'{first_m["p"]} – {last_m["p"]}')
        first_p = own["months"][0]["p"]
        report_span = f'laporan emiten sejak {BULAN[int(first_p[5:7]) - 1]} {first_p[:4]}' if len(own["months"]) > len(ksei_m) else ""
        own_view = ('<section class="own" id="own" data-cat="kepemilikan" aria-labelledby="own-title" hidden>'
                    '<header class="own-hero"><h1 id="own-title">Kepemilikan saham</h1>'
                    '<p class="lede">'
                    "KSEI: pemegang &gt;1%. Laporan bulanan emiten: pemegang ≥5%, free float resmi, jumlah pemegang. Data: IDX Signal Desk.</p>"
                    f'<p class="tally"><span><b>{angka(own["count"])}</b> emiten</span><span><b>{len(ksei_m)}</b> bulan data KSEI</span>'
                    f"<span>{esc(span_own)}</span>" + (f'<span><b>{len(own["months"])}</b> bulan {esc(report_span)}</span>' if report_span else "") + "</p></header>"
                    '<div class="own-bar">'
                    '<label class="own-field own-search">Cari<input id="own-cari" type="search" maxlength="128" placeholder="Kode atau nama, mis. BBCA" autocomplete="off" spellcheck="false"></label>'
                    '<label class="own-field own-pick">Emiten<select id="own-emiten"><option value="">Semua emiten</option></select></label>'
                    '<label class="own-field own-month">Dari<select id="own-dari"></select></label>'
                    '<label class="own-field own-month">Sampai<select id="own-sampai"></select></label></div>'
                    '<div id="own-body" aria-live="polite"></div></section>')
    body = (tabs + '<div class="app"><main class="stage">'
            f'<nav class="category-nav" aria-label="Sumber dokumen">{"".join(category_links)}</nav>'
            '<div class="search"><label for="cari">Cari arsip</label>'
            '<div class="search-controls"><input id="cari" type="search" maxlength="128" autocomplete="off" placeholder="Kode, nama, kata, atau tanggal…" aria-describedby="cari-catatan">'
            '<button id="hapus-cari" type="button" hidden>Hapus pencarian</button></div>'
            '<p class="search-note" id="cari-catatan" aria-live="polite"></p></div>'
            '<section class="chat" aria-labelledby="chat-title">'
            '<header class="chat-head"><h2 id="chat-title">Tanya arsip</h2><button id="chat-new" type="button" hidden>Percakapan baru</button></header>'
            '<p class="chat-intro">Tanya saham atau topik; jawaban menyertakan sumber dari arsip.</p>'
            '<div id="chat-history" role="log" aria-label="Percakapan tentang arsip" aria-live="polite"></div>'
            '<form id="chat-form" class="chat-form"><textarea id="chat-question" rows="2" maxlength="600" aria-describedby="chat-count" required aria-label="Pertanyaan tentang arsip" placeholder="Contoh: analisis SOCI"></textarea>'
            '<div class="chat-actions"><button id="chat-send" type="submit">Tanyakan</button><button id="chat-stop" type="button" hidden>Hentikan</button></div></form>'
            '<label id="chat-mode" class="chat-mode" hidden><input id="chat-agentic" type="checkbox"> <span><strong>Mode agen</strong>: tambah data BEI dari datacat. '
            '<span id="chat-agentic-left"></span></span></label>'
            '<p id="chat-count" class="chat-count">0 / 600 karakter</p>'
            '<p class="chat-count">Pertanyaan dan pemakaian dicatat privat oleh pengelola.</p>'
            '<div id="chat-progress" class="chat-progress" hidden><div class="chat-working"><span class="chat-dots" aria-hidden="true"><i></i><i></i><i></i></span><span id="chat-activity">Memulai…</span><span id="chat-elapsed"></span></div><progress id="chat-meter" aria-label="Progres pembacaan dokumen"></progress></div>'
            '<p id="chat-status" class="chat-status" role="status"></p></section>'
            '<div id="overview">'
            '<header class="masthead">'
            "<h1>Arsip riset pasar modal</h1>"
            '<p class="lede">Stockbit dan keterbukaan informasi Indonesia, Australia, Singapura.</p>'
            f'<p class="tally"><span><b>{len(listed_docs)}</b> dokumen</span><span><b>{len(category_links)}</b> sumber</span>'
            f"<span>{esc(span)}</span></p></header>"
            + f'<div class="cats">{"".join(sections)}</div>'
            + '<p class="empty" id="kosong" hidden>Tidak ada yang cocok. Coba kode 4 huruf, nama, atau bulan.</p>'
            f'<noscript><p class="empty">JavaScript mati. Buka berkas mentahnya:</p><ul>{raw_links}</ul></noscript>'
            f'<footer class="foot"><span>{SITE_NAME}</span><span>dibangun {esc(date_label(built, built))}</span>'
            + (f"<span>data terbaru {esc(date_label(last, last))}</span>" if last else "") + "</footer></div>"
            '<article id="reader" hidden></article></main></div>' + own_view +
            f'<script type="application/json" id="arsip-data">{data_json}</script>'
            + "".join(f'<script src="{src}" integrity="{integrity}" crossorigin="anonymous"></script>' for src, integrity in LIBS)
            + f"<script>{PAGE_JS}</script>")
    return head, body


# ---------------------------------------------------------------- main

def ownership_meta():
    """Ringkasan kepemilikan.json untuk tab Kepemilikan Saham, atau None kalau belum disinkron."""
    if not (SRC / OWN_SRC).is_file():
        return None
    check_source(SRC / OWN_SRC, SRC)
    raw = json.loads((SRC / OWN_SRC).read_text(encoding="utf-8"))
    months = [{"p": m["p"], "asOf": m.get("asOf")} for m in raw.get("months") or []]
    companies = raw.get("companies") or []
    if len(months) > 240 or any(not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", m["p"]) or
                               (m["asOf"] is not None and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", m["asOf"])) for m in months):
        raise ValueError("Tanggal metadata kepemilikan tidak valid.")
    if not months or not companies:
        return None
    changes = reports = prices = None
    if (SRC / PRICES_SRC).is_file():
        check_source(SRC / PRICES_SRC, SRC)
        prices = PRICES_PATH
    if (SRC / CHANGES_SRC).is_file():
        check_source(SRC / CHANGES_SRC, SRC)
        changes = CHANGES_PATH
    if (SRC / REPORTS_SRC).is_file():
        check_source(SRC / REPORTS_SRC, SRC)
        reports = REPORTS_PATH
    return {"path": OWN_PATH, "changes": changes, "reports": reports, "prices": prices, "months": months, "count": len(companies),
            "tickers": [c["t"] for c in companies]}


def index_meta(src, path, counted, other=()):
    """Ringkasan indeks harian Signal Desk (stockbit-index.json, bei-index.json) untuk payload halaman, atau None kalau
    belum disinkron. Hanya bentuk luar yang diperiksa (format 1, tanggal, map `counted` dan `other`); viewer memvalidasi
    ulang setiap baris saat dimuat. Jumlah entri tiap map `counted` ikut ringkasan."""
    file = SRC / src
    if not file.is_file():
        return None
    check_source(file, SRC)
    raw = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or raw.get("format") != 1:
        raise ValueError(f"Format {file.name} tidak dikenal.")
    days = raw.get("days") or []
    if (not isinstance(days, list) or any(not isinstance(raw.get(k) or {}, dict) for k in counted + other)
            or any(not isinstance(d, dict) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(d.get("d", ""))) for d in days)):
        raise ValueError(f"Struktur {file.name} tidak valid.")
    return {"path": path, "days": len(days), **{k: len(raw.get(k) or {}) for k in counted}}


def robots_txt(base_url=""):
    rules = "".join(f"Disallow: {p}\n" for p in ROBOTS_DISALLOW)
    return "User-agent: *\n" + rules + "Allow: /\n" + (f"Sitemap: {base_url}/sitemap.xml\n" if base_url else "")


def sitemap_xml(docs, base_url):
    """Sitemap tanpa dokumen Stockbit (tetap terbaca di situs dan chat, tetapi tidak diumumkan ke mesin pencari)."""
    listed = [d for d in docs if not d["cat"].startswith("stockbit")]
    latest = max((d["end"] for d in docs), default=date.today().isoformat())
    urls = [(f"{base_url}/", latest)] + [(f"{base_url}/{quote(d['path'])}", d["end"]) for d in listed]
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            + "".join(f"<url><loc>{esc(u)}</loc><lastmod>{m}</lastmod></url>" for u, m in urls)
            + "</urlset>\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()

    # Termasuk subfolder (mis. idx-signal-desk/ hasil tools/sync_idx.py); berkas dan folder berawalan titik dilewati.
    files = sorted((p for p in SRC.rglob("*")
                    if p.is_file() and p.suffix.lower() in (".md", ".html", ".htm", ".csv")
                    and not any(part.startswith(".") for part in p.relative_to(SRC).parts)),
                   key=lambda p: p.relative_to(SRC).as_posix())
    docs = [load_doc(p, i) for i, p in enumerate(files)]
    # Nama di files/ harus unik (tanpa beda huruf besar-kecil, karena disk macOS juga begitu).
    seen = {}
    for doc, src in zip(docs, files):
        if doc["_key"] in seen:
            raise SystemExit(f"Nama berkas ganda di {SRC.name}/: {seen[doc['_key']]} dan {src.relative_to(SRC)}")
        seen[doc["_key"]] = src.relative_to(SRC)
    by_cat = {k: [d for d in docs if d["cat"] == k] for k in CATEGORIES}
    by_cat = {k: v for k, v in by_cat.items() if v}

    out = check_output(args.out, ROOT, [SRC], kind="site")
    # GitHub Pages custom-domain settings live in the generated directory.
    cname = (out / "CNAME").read_text(encoding="utf-8") if (out / "CNAME").is_file() else None
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    if cname is not None:
        (out / "CNAME").write_text(cname, encoding="utf-8")
    (out / "version.json").write_text(
      json.dumps({"version": BUILD_ID}),
      encoding="utf-8"
    )
    for doc, src in zip(docs, files):
        target = out / doc["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        if doc["kind"] != "html":
            shutil.copy2(src, target)
        else:
            target.write_text(with_nav_bar(doc), encoding="utf-8")

    own = ownership_meta()
    if own:
        (out / OWN_PATH).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(SRC / OWN_SRC, out / OWN_PATH)
        if own["changes"]:
            shutil.copy2(SRC / CHANGES_SRC, out / CHANGES_PATH)
        if own["reports"]:
            shutil.copy2(SRC / REPORTS_SRC, out / REPORTS_PATH)
        if own["prices"]:
            shutil.copy2(SRC / PRICES_SRC, out / PRICES_PATH)
    sb = index_meta(SB_INDEX_SRC, SB_INDEX_PATH, ("tickers", "users"))
    bei = index_meta(BEI_INDEX_SRC, BEI_INDEX_PATH, ("tickers",), ("names",))
    for meta, src in ((sb, SB_INDEX_SRC), (bei, BEI_INDEX_SRC)):
        if meta:
            (out / meta["path"]).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(SRC / src, out / meta["path"])
    head, body = build_page(docs, by_cat, own, sb, bei)
    endpoint = urlsplit(CHAT_API_URL)
    if CHAT_API_URL.startswith("/") and not CHAT_API_URL.startswith("//"):
        api_origin = "'self'"
    elif endpoint.scheme in ("https", "http") and endpoint.hostname and not endpoint.username and not endpoint.password:
        if endpoint.scheme == "http" and endpoint.hostname not in ("127.0.0.1", "localhost"):
            raise ValueError("API publik harus HTTPS.")
        api_origin = endpoint.scheme + "://" + endpoint.netloc
    else:
        raise ValueError("Alamat API chat tidak valid.")
    policy = ("default-src 'none'; script-src " + script_hash(PAGE_JS) + " " +
              " ".join(src for src, _ in LIBS) + "; style-src 'unsafe-inline' https://fonts.googleapis.com; "
              "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' " + api_origin +
              "; frame-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'")
    security_meta = '<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="' + esc(policy) + '">'
    (out / "index.html").write_text(
        '<!doctype html>\n<html lang="id"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        f"{security_meta}{head}</head><body>{body}</body></html>\n", encoding="utf-8")

    page_size = (out / "index.html").stat().st_size
    if page_size > PAGE_WARN_BYTES:
        print(f"PERINGATAN: index.html {page_size / 1024 / 1024:.1f} MB, melewati {PAGE_WARN_BYTES // 1024 // 1024} MB. "
              "Periksa dokumen yang di-embed (EMBED_LIMIT, SB_EMBED_DAYS).", file=sys.stderr)

    if BASE_URL:
        (out / "sitemap.xml").write_text(sitemap_xml(docs, BASE_URL), encoding="utf-8")
    (out / "robots.txt").write_text(robots_txt(BASE_URL), encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")

    for d in docs:
        print(f"{d['catName']:<22} {d['label']:<24} {d['name']} -> {d['path']}")
    if sb:
        print(f"{'Indeks Stockbit':<22} {sb['days']} hari, {sb['tickers']} emiten, {sb['users']} pengguna "
              f"{(SRC / SB_INDEX_SRC).name} -> {SB_INDEX_PATH}")
    if bei:
        print(f"{'Indeks BEI':<22} {bei['days']} hari, {bei['tickers']} emiten {(SRC / BEI_INDEX_SRC).name} -> {BEI_INDEX_PATH}")
    if own:
        print(f"{'Kepemilikan Saham':<22} {own['months'][0]['p']} s/d {own['months'][-1]['p']:<12} {(SRC / OWN_SRC).name} -> {OWN_PATH} "
              f"({own['count']} emiten, {len(own['months'])} bulan, {sum(1 for m in own['months'] if m['asOf'])} bulan KSEI)")
    print(f"{len(docs)} dokumen" + (" + tab Kepemilikan Saham" if own else "") + f" -> {out}")


if __name__ == "__main__":
    main()
