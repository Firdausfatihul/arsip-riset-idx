#!/usr/bin/env python3
"""Salin data IDX Signal Desk (server lokal idx-digest) ke arsip ini, lalu build ulang.

    python3 tools/sync_idx.py                  # sekali: sinkron, build kalau ada yang berubah
    python3 tools/sync_idx.py --watch 15       # ulangi tiap 15 menit sampai Ctrl+C
    python3 tools/sync_idx.py --fragment-index /tmp/artifact/index.html   # build juga versi Artifact
    python3 tools/sync_idx.py --stockbit-only --no-build                  # hanya ringkasan Stockbit (dipakai publish_stockbit.py)

Yang disalin, ke needtobeindexed/idx-signal-desk/ (folder ini milik skrip, isinya boleh ditimpa):
  digest_<awal>_<akhir>[_HHMM-HHMM].md   satu per jendela "Saved Intelligence" (render /api/share/render)
  kepemilikan.json                       semua bulan (laporan emiten sejak Mei 2023, KSEI >1% sejak Feb 2026): pemegang >1%,
                                         pemegang >=5%, free float resmi, dan jumlah pemegang per emiten (tab Kepemilikan Saham)
  kepemilikan-laporan.json               daftar pemegang saham, jenis pemilik BAE, dan tautan laporan bulanan emiten,
                                         diambil viewer saat satu emiten dibuka
  kepemilikan-perubahan.json             laporan perubahan kepemilikan pemegang saham per emiten (Jul 2023–),
                                         diambil viewer saat satu emiten dibuka
  sbringkas_/sbdetail_<tgl>_<tgl>.md,     ringkasan Stockbit Ideas per hari final, rekap pekan lengkap, dan indeksnya
  sbpekan_<senin>_<minggu>.md,           (hanya dengan --stockbit-only atau --with-stockbit; hanya dihapus untuk hari yang
  stockbit-index.json                    ditahan desk dari web, atau oleh rollback_stockbit.py)
Hanya membaca: GET, render tanpa menulis berkas, dan ledger kepemilikan dibuka read-only. Tidak memicu scraping IDX.
"""
import argparse
import collections
import hashlib
import http.client
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import time
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from build import categorize, date_label  # noqa: E402  (satu sumber format tanggal dan kategori)

DEST = ROOT / "needtobeindexed" / "idx-signal-desk"
STATE = DEST / ".sync.json"
# kepemilikan_*.md adalah format lama (satu berkas per bulan); dihapus saat kepemilikan.json ditulis.
OWNED = re.compile(r"^(digest|kepemilikan)_[\w\-]+\.md$")
OWNERSHIP_JSON = DEST / "kepemilikan.json"
FILINGS_JSON = DEST / "kepemilikan-perubahan.json"
REPORTS_JSON = DEST / "kepemilikan-laporan.json"
# Ringkasan Stockbit Ideas (hanya --stockbit-only / --with-stockbit). Berkas sb* tidak pernah di-prune(): arsip ini
# append-only. Hanya hari yang ditahan desk dari web (export/withheld) dan rollback_stockbit.py yang menghapus sb*;
# pola ini dipakai managed() untuk staging (tulis dan hapus), tidak untuk prune().
STOCKBIT_STATE = DEST / ".sync-stockbit.json"
STOCKBIT_INDEX = DEST / "stockbit-index.json"
# Ditulis tools/rollback_stockbit.py (ikut di-commit bersama revert): {"format":1,"days":{tgl:{"sha256":sha|"*",...}}}.
# Hari yang ditahan tidak diterbitkan lagi sampai sha ekspor desk berubah (difinalkan ulang) atau entrinya dihapus.
# Sinkron menambahkan {"sha256":"*","withheld_by":"desk"} untuk hari terbit yang ditahan desk dari web (berkasnya dicabut),
# dan membuang hanya entri desk itu saat desk melepasnya; entri rollback tidak pernah dihapus sinkron.
STOCKBIT_HOLD = DEST / ".stockbit-hold.json"
STOCKBIT_FILE = re.compile(r"^(sbringkas|sbdetail|sbpekan)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.md$")
STOCKBIT_CATEGORY = {"sbringkas": "stockbit-ringkasan", "sbdetail": "stockbit-detail", "sbpekan": "stockbit-pekan"}
STOCKBIT_KIND = {"ringkas": "sbringkas", "detail": "sbdetail"}
# Keputusan pemilik: backfill dimulai 1 Oktober 2026; hari sebelumnya tidak diterbitkan.
STOCKBIT_SINCE = "2026-10-01"
ISO_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
# Naikkan kalau bentuk kepemilikan.json / kepemilikan-laporan.json berubah, supaya sinkron berikutnya membuatnya ulang.
OWNERSHIP_FORMAT = 6
REPORTS_FORMAT = 2
# Tautan laporan emiten di IDX hampir selalu diawali ini; kepemilikan-laporan.json menyimpan sisanya saja.
IDX_REPORT_BASE = "https://www.idx.co.id/StaticData/NewsAndAnnouncement/ANNOUNCEMENTSTOCK/"

# Arsip ini bisa dibagikan lewat link. Nomor HP pribadi (mis. corporate secretary) dan kode akses rapat
# yang ikut terkutip dari pengumuman disamarkan; nama, alamat usaha, dan angka kepemilikan tidak diubah.
REDACTIONS = (
    (re.compile(r"(?<![\w.])(?:\+62|62|0)[ \-]?8\d{1,3}(?:[ \-]?\d{3,4}){2}(?![\w.])"), "[nomor HP disamarkan]"),
    (re.compile(r"(?i)\b(passcode|password|kata sandi|kode akses)(\s*[:=]?\s*)(?=[^\s,;)]*\d)[^\s,;)]*[^\s,;).]"), r"\1\2[disamarkan]"),
    (re.compile(r"(?i)([?&]pwd=)[^\s&,;)\]]*[^\s&,;).\]]"), r"\1[disamarkan]"),
)


class ProfileMismatch(Exception):
    pass


# ---------------------------------------------------------------- server

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Redirect dari server sinkron ditolak.")


class Server:
    def __init__(self, base):
        parsed = urlsplit(base)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Alamat Signal Desk tidak valid.")
        if parsed.scheme == "http" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
            raise ValueError("HTTP hanya untuk loopback; server jarak jauh harus HTTPS.")
        self.local = parsed.hostname in ("localhost", "127.0.0.1", "::1")
        self.base = base.rstrip("/")
        self.opener = build_opener(NoRedirect())

    def request(self, path, body=None, timeout=60):
        if not path.startswith("/api/") or path.startswith("//"):
            raise ValueError("Path sinkron tidak valid.")
        req = Request(self.base + path, data=None if body is None else json.dumps(body).encode(),
                      headers={"content-type": "application/json"})
        with self.opener.open(req, timeout=timeout) as response:
            raw = response.read(32 * 1024 * 1024 + 1)
        if len(raw) > 32 * 1024 * 1024:
            raise ValueError("Respons Signal Desk terlalu besar.")
        return json.loads(raw)

    def get(self, path, timeout=60):
        return self.request(path, timeout=timeout)

    def post(self, path, body, timeout=300):
        return self.request(path, body, timeout)


# ---------------------------------------------------------------- berkas

def write_if_changed(path, text):
    """Tulis atomik; kembalikan True kalau isi berubah."""
    data = text.encode("utf-8")
    if path.is_symlink():
        raise ValueError("Tujuan sinkron tidak boleh symlink.")
    if path.exists() and path.read_bytes() == data:
        return False
    if path.is_symlink() or path.parent.resolve() != DEST.resolve():
        raise ValueError("Tujuan sinkron bukan berkas biasa dalam folder yang dikelola.")
    fd, tmp = tempfile.mkstemp(prefix=".sync-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)

    return True


def redact(text):
    for pattern, repl in REDACTIONS:
        text = pattern.sub(repl, text)
    return text


# ---------------------------------------------------------------- digest per jendela

def digest_name(w):
    for key in ("start_date", "end_date"):
        if not isinstance(w[key], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", w[key]):
            raise ValueError("Tanggal jendela tidak valid.")
        date.fromisoformat(w[key])
    for key in ("start_at", "end_at"):
        if not isinstance(w[key], str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?", w[key]):
            raise ValueError("Waktu jendela tidak valid.")
        datetime.fromisoformat(w[key].replace("Z", "+00:00"))
    if w["start_at"][:10] != w["start_date"] or w["end_at"][:10] != w["end_date"]:
        raise ValueError("Tanggal dan waktu jendela tidak konsisten.")
    start_t, end_t = w["start_at"][11:16], w["end_at"][11:16]
    name = f"digest_{w['start_date']}_{w['end_date']}"
    if (start_t, end_t) != ("00:00", "23:59"):
        name += f"_{start_t.replace(':', '')}-{end_t.replace(':', '')}"
    return name + ".md"


def digest_text(server, w):
    r = server.post("/api/share/render", {"format": "md", "date_mode": "exact", "per_ticker": "all",
                                          "window_keys": [[w["start_at"], w["end_at"]]]})
    text = r["text"]
    start, end = date.fromisoformat(w["start_date"]), date.fromisoformat(w["end_date"])
    title = f"# Digest emiten IDX · {date_label(start, end)}"
    if w["end_at"][11:16] != "23:59":
        title += f" (s/d pukul {w['end_at'][11:16]})"
    # Judul bawaan ("IDX Signal Desk · Company Digests") sama untuk semua berkas; ganti supaya bisa dibedakan.
    lines = text.split("\n", 1)
    body = lines[1] if lines[0].startswith("# ") and len(lines) > 1 else text
    return f"{title}\n{redact(body).rstrip()}\n"


def sync_digests(server, state, force, guard):
    windows = server.get("/api/share/windows")["windows"]
    seen, changed, fingerprints = set(), [], state.setdefault("digests", {})
    for w in windows:
        name = digest_name(w)
        if name in seen:
            raise RuntimeError(f"dua jendela menghasilkan nama berkas yang sama: {name}")
        seen.add(name)
        fp = f"{w['updated_at']}|{w['company_count']}"
        path = DEST / name
        if not force and fingerprints.get(name) == fp and path.exists():
            continue
        if write_if_changed(path, digest_text(server, w)):
            changed.append(name)
        fingerprints[name] = fp
    guard()
    removed = prune("digest_", seen, allow_empty=bool(windows))
    for name in removed:
        fingerprints.pop(name, None)
    return changed, removed


# ---------------------------------------------------------------- kepemilikan

def read_ledger(profile):
    """Kode emiten dan identitas file KSEI aktif, dari ledger kepemilikan (read-only).

    /api/ownership hanya mendaftar emiten yang punya laporan emiten; emiten yang hanya ada di file KSEI
    (mis. ASII, BMRI) perlu diambil kodenya dari sini. None kalau ledger tidak terbaca.
    """
    db = Path(profile.get("data_dir") or "") / "ownership" / "ledger.sqlite3"
    if not profile.get("data_dir") or not db.is_file():
        return None
    try:
        with closing(sqlite3.connect(f"file:{quote(str(db))}?mode=ro", uri=True, timeout=10)) as con:
            tickers = [r[0] for r in con.execute("""SELECT DISTINCT h.ticker FROM ksei_holdings h
                                                    JOIN ksei_files f ON f.file_id=h.file_id WHERE f.active=1""")]
            files = [list(r) for r in con.execute("SELECT file_id, as_of, fetched_at FROM ksei_files WHERE active=1 ORDER BY as_of, fetched_at")]
            tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            filings = coverage = None
            if "filings" in tables:
                tickers += [r[0] for r in con.execute("SELECT DISTINCT ticker FROM filings WHERE ticker IS NOT NULL")]
                filings = list(con.execute("SELECT count(*), max(updated_at) FROM filings").fetchone())
            if {"backfill_sources", "backfill_months"} <= tables:
                listed, downloaded = con.execute("SELECT count(*), count(local_path) FROM backfill_sources WHERE kind='filings'").fetchone()
                first, last = con.execute("SELECT min(month), max(month) FROM backfill_months WHERE kind='filings'").fetchone()
                coverage = {"listed": listed, "downloaded": downloaded, "from": first, "to": last}
        return {"tickers": sorted(set(tickers)), "files": files, "filings": filings, "coverage": coverage}
    except sqlite3.Error as e:
        print(f"  ledger kepemilikan tidak terbaca ({e}); hanya emiten yang punya laporan emiten yang disalin", file=sys.stderr)
        return None


ROLE_BITS = {"shareholder_5plus": 1, "controller": 2, "affiliate": 4, "director": 8, "commissioner": 16}
DOMICILE = {"national": "L", "foreign": "F", "all": "A"}


def https_or_none(url):
    try:
        parsed = urlsplit(url or "")
        return url if parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password and not re.search(r"[\x00-\x20\x7f]", url) else None
    except ValueError:
        return None


def chosen_version(periods, month):
    """Versi laporan yang dipilih server untuk bulan itu, semua versinya, dan apakah versinya bertentangan."""
    for period in periods or []:
        if str(period.get("period", "")).startswith(month):
            versions = period.get("versions") or []
            chosen = next((v for v in versions if v.get("id") == period.get("preferred_id")), versions[0] if versions else None)
            return chosen, versions, bool(period.get("conflict"))
    return None, [], False


# Aturan kepercayaan angka laporan emiten, sama dengan tab Ownership di Signal Desk (web/index.html: ownSnapshotComparable,
# ownMetricOk, ownBlockholders). Angka yang tidak lolos tetap disalin, hanya ditandai belum terverifikasi.
SOURCE_BLOCKED = re.compile(r"^(issuer_mismatch|previous_parse_retained|issuer_code_mismatch|source_refresh_degraded)(:|$)")
SKIPPED_TABLE = re.compile(r"^(required_metric_missing|holder_needs_review|holder_percentage_mismatch|holder_headers_unverified|"
                           r"conflicting_holder|composition_rows_incomplete_or_out_of_order):")
HOLDER_REVIEW = re.compile(r"^(holder_needs_review|conflicting_holder)(:|$)")
# Masalah laporan yang tidak menyentuh angka lembar/persen pemegang: peran "unknown" di laporan lama, total saham tidak tertulis.
DERIVABLE_ISSUE = re.compile(r"^(holder_needs_review|required_metric_missing):")


def derivable(chosen, versions):
    """Laporan belum terverifikasi yang angka pemegangnya tetap boleh dipakai viewer untuk menghitung perubahan,
    asalkan viewer juga mencocokkan lembar/persen dengan total saham. Tidak untuk sumber diblokir, tabel/angka yang gagal
    dibaca, atau periode meragukan: hanya masalah yang terdaftar di DERIVABLE_ISSUE.

    Flag conflict server juga menyala karena metrik lain (free float, jumlah pemegang) dan hanya membandingkan pemegang
    tervalidasi, jadi versi diperiksa langsung: setiap nama pemegang (bukan agregat) yang disebut lebih dari satu versi harus
    punya lembar dan persen yang sama, dan total saham yang tertulis tidak boleh berbeda. Nama yang hanya ada di satu versi
    (mis. tabel direksi tidak terbaca di versi lain) tidak dianggap bertentangan.
    """
    if not chosen or chosen.get("import_status") in ("quarantined", "previous_parse_retained"):
        return False
    if chosen.get("validation") == "missing" or not chosen.get("holders"):
        return False
    if not all(DERIVABLE_ISSUE.match(str(x)) for x in chosen.get("issues") or []):
        return False
    seen, totals = {}, set()
    for v in [chosen] + [v for v in versions or [] if v is not chosen]:
        if metric(v, "total_shares") is not None:
            totals.add(metric(v, "total_shares"))
        for h in v.get("holders") or []:
            if aggregate_holder(h.get("name"), include_public=True):
                continue
            seen.setdefault(str(h.get("name") or "").strip().casefold(), set()).add((h.get("shares"), h.get("pct")))
    return len(totals) <= 1 and all(len(x) == 1 for x in seen.values())


def number(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def metric(snapshot, key):
    return number((((snapshot or {}).get("metrics") or {}).get(key) or {}).get("value"))


def metric_ok(snapshot, key):
    validation = (((snapshot or {}).get("metrics") or {}).get(key) or {}).get("validation")
    return metric(snapshot, key) is not None and (not validation or validation == "ok")


def comparable(snapshot):
    """Laporan bisa dipakai untuk angka terverifikasi: sumbernya tidak diblokir dan masalahnya hanya tabel yang dilewati."""
    if not snapshot:
        return False
    issues = [str(x) for x in snapshot.get("issues") or []]
    if snapshot.get("import_status") in ("quarantined", "previous_parse_retained") or any(SOURCE_BLOCKED.match(x) for x in issues):
        return False
    if snapshot.get("validation") == "missing":
        return False
    return snapshot.get("validation") == "ok" or (bool(issues) and all(SKIPPED_TABLE.match(x) for x in issues))


def holder_roles(holder):
    roles = holder.get("roles")
    return [str(r).strip() for r in roles] if isinstance(roles, list) else [r.strip() for r in str(holder.get("role") or "").split(",") if r.strip()]


def js_round(value, scale):
    """Math.round(value * scale) / scale, seperti di Signal Desk (Python round() membulatkan ke genap)."""
    return math.floor(value * scale + 0.5) / scale


def blockholders(snapshot, trusted):
    """Pemegang >=5% gabungan dari laporan emiten: saham semua pemegang >=5% (termasuk direksi/komisaris >=5%) / total saham.

    (nilai, 1 kalau terverifikasi). Tidak diketahui (None) kalau daftarnya kosong atau terbukti tidak lengkap:
    daftar kosong bukan bukti nol. Terverifikasi hanya kalau nama + publik <5% + treasuri = total saham dan semua peran terbaca.
    """
    holders = (snapshot or {}).get("holders") or []
    total = metric(snapshot, "total_shares") if metric_ok(snapshot, "total_shares") else None
    if not holders or not total or total <= 0:
        return None, 0
    state = "unchecked"
    parts = [metric(snapshot, k) if metric_ok(snapshot, k) else None for k in ("public_under5_scrip", "public_under5_scripless", "treasury_shares")]
    named = [number(h.get("shares")) for h in holders]
    if None not in parts and None not in named:
        if abs(total - sum(parts) - sum(named)) > 1:
            return None, 0
        clean = all(holder_roles(h) and "unknown" not in holder_roles(h) and h.get("validation") == "ok"
                    for h in holders) and not duplicate_holder_names(holders) and \
            not any(HOLDER_REVIEW.match(str(x)) for x in snapshot.get("issues") or []) and \
            not any(aggregate_holder(h.get("name")) and (number(h.get("shares")) or number(h.get("pct")) or 0) > 0
                    for h in holders)
        state = "ok" if clean else state
    block = []
    for h in holders:
        roles, name = holder_roles(h), re.sub(r"\s+", "", str(h.get("name") or "")).lower()
        if aggregate_holder(h.get("name"), include_public=True):
            continue  # kelompok/subtotal bukan identitas satu pemegang >=5%
        shares = number(h.get("shares"))
        pct = 100 * shares / total if shares is not None else number(h.get("pct"))
        if pct is not None and pct >= 5:
            block.append(shares)
    if None in block:
        return None, 0
    value = math.floor(1e8 * sum(block) / total + 0.5) / 1e6
    return value, int(trusted and state == "ok" and value <= 100.0001)


PUBLIC_ROW = re.compile(r"(masyarakat|public|publik)")
SUBTOTAL_ROW = re.compile(r"^(total|jumlah|subtotal|sub-total)(pengendali|nonpengendali|non-pengendali|pemegang|saham)|^afiliasi(pengendali)?$|^lain")
# Baris sisa di laporan lama, di posisi mana pun pada nama: "Umum (Publik)", "Pemegang saham lainnya", "Saham Treasury".
# Hanya untuk written_blockholders; blockholders() tetap memakai PUBLIC_ROW supaya nama seperti "... Public Company" tidak terbuang.
LEFTOVER_ROW = re.compile(r"^umum|\((publik|public|umum|masyarakat)\)|lainnya|treasur|tresur|dibelikembali|^pemegangsaham$")


def aggregate_holder(name, include_public=False):
    name = re.sub(r"\s+", "", str(name or "")).lower()
    return bool(SUBTOTAL_ROW.match(name) or LEFTOVER_ROW.search(name) or
                (include_public and PUBLIC_ROW.match(name)))


def duplicate_holder_names(holders):
    counts = collections.Counter(investor_signature(h.get("name")) for h in holders)
    return {name for name, count in counts.items() if name and count > 1}


def written_blockholders(snapshot, conflict=False):
    """Cadangan kalau total saham laporan emiten tidak terbaca (umumnya laporan sebelum April 2026):
    jumlah persen yang tertulis di laporan untuk pemegang >=5% yang punya peran (pemegang, pengendali, afiliasi, direksi,
    komisaris). Baris "Masyarakat" dan subtotal ("Total Pengendali", "Afiliasi") tidak dihitung.

    Selalu belum terverifikasi karena tidak dicocokkan ke total saham. Pada 3.200 bulan yang angka resminya terverifikasi
    (Sep 2026), hasil cara ini sama dalam 0,02 poin untuk 98,3% bulan dan meleset >1 poin di 7 bulan.
    Tidak diketahui (None) kalau daftar meragukan: pemegang >=5% tanpa peran yang terbaca, atau persen tertulis yang
    bertentangan dengan lembarnya (selisih >1 poin dari lembar / total saham tersirat, yaitu median lembar*100/persen).
    """
    if not snapshot or metric_ok(snapshot, "total_shares") or conflict or \
            snapshot.get("import_status") in ("quarantined", "previous_parse_retained") or \
            any(SOURCE_BLOCKED.match(str(issue)) for issue in snapshot.get("issues") or []) or \
            duplicate_holder_names(snapshot.get("holders") or []):
        return None
    rows = []
    for h in snapshot.get("holders") or []:
        name = re.sub(r"\s+", "", str(h.get("name") or "")).lower()
        if not (PUBLIC_ROW.match(name) or SUBTOTAL_ROW.match(name) or LEFTOVER_ROW.search(name)):
            rows.append((number(h.get("pct")), number(h.get("shares")), any(r in ROLE_BITS for r in holder_roles(h))))
    implied = sorted(shares * 100 / pct for pct, shares, _ in rows if pct is not None and pct >= 0.5 and shares and shares > 0)
    if len(implied) >= 2:
        total = implied[len(implied) // 2]
        if any(pct is not None and shares and abs(shares * 100 / total - pct) > 1 for pct, shares, _ in rows):
            return None
    big = [(pct, known) for pct, _, known in rows if pct is not None and pct >= 5]
    if not big or not all(known for _, known in big):
        return None
    value = js_round(sum(pct for pct, _ in big), 1e6)
    return value if value <= 100.01 else None


def ksei_ok(cur):
    """Akumulasi >1% terverifikasi: semua baris emiten itu di file KSEI lolos pemeriksaan."""
    total = number(cur.get("total_pct"))
    holders = cur.get("holders") or []
    return bool(holders) and total is not None and not cur.get("issues") and cur.get("validation") == "ok" and \
        all(h.get("validation") == "ok" for h in holders) and 0 <= total <= 100.05


def ksei_block(cur):
    """Pemegang >=5% menurut baris KSEI >1%, dipakai kalau laporan emiten bulan itu tidak terbaca."""
    holders = cur.get("holders") or []
    if not holders or cur.get("validation") == "missing" or number(cur.get("total_pct")) is None:
        return None, 0
    return js_round(sum(h["pct"] for h in holders if (number(h.get("pct")) or 0) >= 5), 1e6), int(ksei_ok(cur))


def report_metrics(chosen, versions, trusted):
    """Free float resmi dan jumlah pemegang dari laporan bulanan emiten.

    Free float: [nilai, 1 kalau terverifikasi, [nilai versi laporan lain]]. Jumlah pemegang: [nilai, 1 kalau terverifikasi].
    """
    free_float = holders = None
    ff, count = metric(chosen, "free_float_pct"), metric(chosen, "holder_count")
    if ff is not None:
        others = sorted({metric(v, "free_float_pct") for v in versions if v is not chosen} - {None, ff})
        free_float = [ff, int(trusted and metric_ok(chosen, "free_float_pct") and 0 <= ff <= 100), others]
    if count is not None:
        holders = [count, int(trusted and metric_ok(chosen, "holder_count"))]
    return free_float, holders


def report_url(url):
    """Tautan laporan di IDX tanpa awalan IDX_REPORT_BASE yang sama untuk semua laporan."""
    url = https_or_none(url)
    return url[len(IDX_REPORT_BASE):] if url and url.startswith(IDX_REPORT_BASE) else url


def report_holders(chosen, name_ref, trusted=True, usable=False):
    """Daftar pemegang saham di laporan emiten: pemegang >=5%/pengendali/afiliasi, lalu direksi dan komisaris.

    {h: [[nama, peran (bit ROLE_BITS), lembar, persen, 1 kalau tervalidasi, turunan]], s: total saham, v: 1 kalau derivable()}.
    turunan: 1 = baris boleh dipakai viewer untuk menghitung perubahan (lembar dan persen terbaca, nama tidak berulang, dan
    satu-satunya catatan untuk nama ini dari DERIVABLE_ISSUE); 2 = baris agregat (Masyarakat, subtotal); 0 = pemegang lain.
    v tidak sama dengan tervalidasi: laporan comparable() bisa saja punya versi yang angka pemegang review-nya berbeda.
    h kosong = laporan ada tetapi tabelnya belum terbaca oleh Signal Desk (mis. teks PDF acak).
    Alamat dan kutipan halaman laporan sengaja tidak disalin.
    """
    if not chosen:
        return None
    holders = chosen.get("holders") or []
    duplicates = duplicate_holder_names(holders)
    # Nama yang disebut catatan selain DERIVABLE_ISSUE (holder_percentage_mismatch, conflicting_holder, ...).
    flagged = {str(x).split(":", 1)[1].strip().casefold() for x in chosen.get("issues") or []
               if ":" in str(x) and not DERIVABLE_ISSUE.match(str(x))}
    rows = []
    for h in holders:
        aggregate = aggregate_holder(h.get("name"), include_public=True)
        plain = investor_signature(h.get("name")) not in duplicates and not aggregate
        derive = plain and number(h.get("shares")) is not None and number(h.get("pct")) is not None and \
            str(h.get("name") or "").strip().casefold() not in flagged
        rows.append([name_ref(redact(h.get("name") or "")), sum(ROLE_BITS.get(r, 0) for r in h.get("roles") or []),
                     h.get("shares"), h.get("pct"), int(trusted and h.get("validation") == "ok" and plain),
                     2 if aggregate else int(derive)])
    rows.sort(key=lambda r: (not r[1] & 7, -(r[3] or 0), r[0]))
    return {"h": rows, "s": metric(chosen, "total_shares"), "v": int(bool(usable))}


def report_categories(chosen, category_ref):
    """Jenis pemilik dari laporan BAE: {r: [[L/F, jenis, jumlah pemegang, lembar, persen, 1 kalau tervalidasi]],
    t: [[L/F/A (semua), jumlah pemegang, lembar, persen]], u: url}."""
    if not chosen or not chosen.get("rows"):
        return None
    rows = [[DOMICILE.get(r.get("domicile"), ""), category_ref(r.get("category_raw") or ""), r.get("holder_count"),
             r.get("shares"), r.get("pct"), int(r.get("validation") == "ok")] for r in chosen["rows"]]
    totals = [[DOMICILE.get(r.get("domicile"), ""), r.get("holder_count"), r.get("shares"), r.get("pct")] for r in chosen.get("totals") or []]
    return {"r": rows, "t": totals, "u": https_or_none(chosen.get("source_url"))}


def month_range(details, ksei_months):
    """Bulan untuk semua larik: dari bulan laporan emiten pertama yang cukup lengkap sampai bulan data terakhir.

    Bulan yang dilaporkan kurang dari 10% emiten (laporan lama yang tercecer, halaman PDF acak yang terbaca sebagai
    tahun depan) tidak memperpanjang sumbu; bulan KSEI selalu ikut. Bulan di tengah tanpa data tetap ada (null).
    """
    this_month, counts = date.today().isoformat()[:7], collections.Counter()
    for d in details:
        counts.update({str(p.get("period") or "")[:7] for p in d.get("periods") or []})
    floor = max(5, len(details) // 10)
    dense = {m for m, n in counts.items() if n >= floor and re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", m) and m <= this_month}
    dense |= set(ksei_months)
    if not dense:
        return []
    months, (y, m) = [], map(int, min(dense).split("-"))
    while f"{y:04d}-{m:02d}" <= max(dense):
        months.append(f"{y:04d}-{m:02d}")
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return months


def holder_groups(holders):
    """Investor yang namanya muncul lebih dari sekali dijumlahkan per nama sebelum dibandingkan."""
    groups = {}
    for h in holders:
        g = groups.setdefault(h.get("name_key") or h.get("name"), {"name": h.get("name"), "pct": 0.0, "total": 0, "rows": 0,
                                                                  "cls": h.get("classification"), "lf": h.get("local_foreign")})
        g["rows"] += 1
        g["pct"] = None if g["pct"] is None or h.get("pct") is None else g["pct"] + h["pct"]
        g["total"] = None if g["total"] is None or h.get("total") is None else g["total"] + h["total"]
    return groups


NAME_NOISE = {"PT", "TBK", "PERSERO", "PERSEROAN", "PERUSAHAAN", "LTD", "LIMITED", "PTE", "PRIVATE", "INC", "CO", "CORP",
              "CORPORATION", "DRS", "DRA", "IR", "SE", "SH", "SKH", "DR"}
ACCOUNT_NAME = re.compile(r"\b(?:A\s*[/.-]\s*C|AC|ACCT|ACCOUNT|REKENING|QQ|Q[. ]*Q|NOMINEE[S]?)\b", re.I)


def name_tokens(name):
    """Kata inti lengkap; nomor rekening dan kata pembeda tetap dipertahankan."""
    return {t for t in re.split(r"[^A-Z0-9]+", str(name or "").upper())
            if t and t not in NAME_NOISE}


def investor_signature(name):
    """Normalisasi dekorasi nama, tanpa fuzzy/subset atau menghapus identitas rekening.

    Nama dengan penanda rekening/nominee mempertahankan urutan kata dan nomor. Nama biasa
    boleh berubah urutan (DRS LO KHENG HONG; PT TRIPLE BERSAMA BERKAH), dengan semua kata inti sama.
    """
    raw = str(name or "").upper()
    tokens = tuple(t for t in re.split(r"[^A-Z0-9]+", raw) if t and t not in NAME_NOISE)
    if not tokens:
        return ()
    return ("account", *tokens) if ACCOUNT_NAME.search(raw) else ("name", *sorted(tokens))


def same_investor(a, b):
    a, b = investor_signature(a), investor_signature(b)
    return bool(a and a == b)


def match_renamed(now, old):
    """KSEI kadang menulis nama investor berbeda antarbulan (TASPEN / PT TASPEN (PERSERO)).

    Semua kata inti harus sama dan pasangan harus unik di kedua sisi. Perubahan lembar tidak
    mengubah identitas. Kemiripan sebagian nama atau jumlah lembar sama bukan bukti identitas.
    """
    gone = {k: g for k, g in old.items() if k not in now}
    candidates = {k: [p for p, o in gone.items() if same_investor(o["name"], g["name"])]
                  for k, g in now.items() if k not in old}
    uses = collections.Counter(p for ps in candidates.values() for p in ps)
    return {k: gone[ps[0]] for k, ps in candidates.items() if len(ps) == 1 and uses[ps[0]] == 1}


def assign_investor_ids(groups, history):
    """ID stabil seluruh riwayat, satu ID per baris per bulan; alias ambigu tetap terpisah.

    history menyimpan seluruh ejaan yang pernah terlihat, termasuk ketika investor sempat di
    bawah ambang. Pasangan nama persis didahulukan; normalisasi hanya untuk pasangan unik.
    """
    keys = sorted(groups, key=str)
    next_id = max((g["inv"] for g in history.values()), default=-1) + 1
    exact = {key: history[key]["inv"] for key in keys if key in history}
    counts = collections.Counter(exact.values())
    assigned = {key: inv for key, inv in exact.items() if counts[inv] == 1}
    ambiguous = {key for key, inv in exact.items() if counts[inv] > 1}
    tainted = {investor_signature(old["name"]) for old in history.values() if old.get("ambiguous")}
    signatures = collections.defaultdict(list)
    for key in keys:
        signature = investor_signature(groups[key]["name"])
        if signature:
            signatures[signature].append(key)
            if signature in tainted:
                ambiguous.add(key)
    for same in signatures.values():
        if len(same) > 1:
            ambiguous.update(same)
    candidates = {}
    for key in keys:
        if key in assigned or key in ambiguous:
            continue
        candidates[key] = {old["inv"] for old in history.values()
                           if same_investor(old["name"], groups[key]["name"])}
    uses = collections.Counter(inv for invs in candidates.values() for inv in invs)
    used = set(assigned.values())
    for key in keys:
        if key in assigned:
            continue
        invs = candidates.get(key, set())
        inv = next(iter(invs)) if len(invs) == 1 else None
        if inv is not None and inv not in used and uses[inv] == 1:
            assigned[key] = inv
        else:
            if invs:
                ambiguous.add(key)
            assigned[key] = next_id
            next_id += 1
        used.add(assigned[key])
    for key in keys:
        groups[key]["inv"] = assigned[key]
        history[key] = {"name": groups[key]["name"], "inv": assigned[key], "ambiguous": key in ambiguous}
    return ["identitas investor ambigu; varian nama tetap dipisahkan (" + str(groups[key]["name"]) + ")"
            for key in sorted(ambiguous, key=str)]


ISSUE_TEXT = {
    "missing": "tidak ada baris pemegang untuk emiten ini",
    "duplicate_investor_key": "investor dengan nama sama muncul lebih dari sekali",
    "row_needs_review": "ada baris yang perlu dicek",
}


def issue_text(issue):
    code, _, detail = str(issue).partition(":")
    return ISSUE_TEXT.get(code, code) + (f" ({detail})" if detail else "")


FILING_ISSUES = {
    "reconciliation_mismatch": "saham sebelum ± transaksi tidak sama dengan sesudah",
    "pct_inconsistent_with_total_shares": "persen tidak cocok dengan total saham emiten",
    "pct_inconsistent_with_paid_up_capital": "persen tidak cocok dengan modal disetor",
    "unreported_change_between_filings": "ada perubahan yang tidak dilaporkan sejak laporan sebelumnya",
    "shares_and_percentage_move_in_opposite_directions": "lembar dan persen bergerak berlawanan",
    "percentage_out_of_range": "persen di luar 0–100",
    "controller_claim_below_5pct": "ditandai pengendali tetapi di bawah 5%",
    "price_may_be_total_value": "harga mungkin nilai total transaksi",
    "transaction_row_incomplete": "baris transaksi tidak lengkap",
    "required_field_missing": "kolom wajib kosong",
    "announcement_code_mismatch": "kode di pengumuman IDX berbeda dengan formulir",
    "target_ticker_unresolved": "saham sasaran belum dikenali",
    "scanned_pdf_no_text": "PDF hasil pindai, teksnya belum terbaca",
    "unrecognized_filing_layout": "format formulir belum dikenali",
    "bae_table_unrecognized": "tabel surat BAE belum terbaca",
    "parse_failed": "PDF gagal dibaca",
}
# Ringkasan global backfill (bulan belum lengkap, unduhan gagal) bukan catatan satu laporan.
GLOBAL_AUDIT = ("month_listing_incomplete", "source_not_downloaded")
FIRST_FILING_DAY = "2023-01-01"


GAP_DETAIL = re.compile(r"previous report ended at ([\d,]+), next starts at ([\d,]+) \(([+-][\d,]+) shares")


def filing_note(issue):
    code, _, detail = str(issue).partition(":")
    detail = detail.strip()
    gap = GAP_DETAIL.search(detail) if code == "unreported_change_between_filings" else None
    if gap:
        end, start, diff = (x.replace(",", ".") for x in gap.groups())
        return f"selisih {diff} lembar dari laporan sebelumnya (berakhir {end}, laporan ini mulai {start})"
    return redact(FILING_ISSUES.get(code, code) + (f" ({detail[:200]})" if detail else ""))


def filing_date(value, today):
    value = str(value or "")[:10]
    return value if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) and FIRST_FILING_DAY <= value <= today else None


def filing_rows(filings, audit, today):
    """Laporan perubahan kepemilikan satu emiten, urut tanggal, hanya kolom yang ditampilkan.

    [tanggal, pemegang, jabatan/status, lembar sebelum, lembar sesudah, % sebelum, % sesudah,
     [[jenis transaksi, arah 1/-1/0, lembar, harga, tanggal]], 1 kalau tervalidasi, [catatan], url PDF]
    Angka persis yang dilaporkan; catatan hanya menandai, tidak mengoreksi. Tanggal di luar 2023–hari ini dikosongkan
    dan diberi catatan supaya satu tanggal salah ketik tidak merusak data viewer.
    """
    extra = {}
    for a in audit or []:
        if a.get("source") == "filing" and a.get("check") not in GLOBAL_AUDIT and a.get("reference"):
            extra.setdefault((a["reference"], a.get("date")), []).append(a)
    rows = []
    for f in filings or []:
        if f.get("public_float"):
            continue
        notes = [filing_note(x) for x in f.get("issues") or []]
        raw_date = f.get("event_date")
        day = filing_date(raw_date, today)
        if raw_date and not day:
            notes.append(redact(f"tanggal tidak wajar ({str(raw_date)[:20]})"))
        url = https_or_none(f.get("source_url"))
        shares = f.get("shares_after")
        for a in extra.get((f.get("source_url"), raw_date), []):
            # Satu surat BAE bisa berisi beberapa pemegang: cocokkan catatan persen lewat jumlah lembarnya.
            if a["check"] == "pct_inconsistent_with_total_shares" and shares is not None and f"{shares:,}" not in (a.get("detail") or ""):
                continue
            note = filing_note(f"{a['check']}: {a.get('detail') or ''}")
            if note not in notes:
                notes.append(note)
        role = [str(f.get("position") or f.get("category") or "").strip()]
        if f.get("controller"):
            role.append("Pengendali")
        tx = [[redact(str(t.get("type") or ""))[:120], t.get("direction") if t.get("direction") in (1, -1, 0) else None,
               t.get("shares"), t.get("price"), filing_date(t.get("date"), today)] for t in f.get("transactions") or []]
        rows.append([day, redact((f.get("holder_name") or "").strip())[:300], redact(" · ".join(r for r in role if r))[:200],
                     f.get("shares_before"), shares, f.get("pct_before"), f.get("pct_after"), tx,
                     int(f.get("validation") == "ok"), notes, url])
    rows.sort(key=lambda r: (r[0] or "", r[1]))
    return rows


def ownership_data(server, index, ledger, pid):
    """Semua bulan dalam satu struktur ringkas untuk tab Kepemilikan Saham.

    months:    [{p: "2026-08", asOf, url, desc}] urut naik (lihat month_range); asOf/url hanya ada di bulan data KSEI.
               Semua larik per emiten sejajar dengan ini (null = tidak ada data).
    names/classes: kamus nama investor KSEI dan jenis pemegang (baris hanya menyimpan nomor urutnya).
    companies: [{t: kode, n: nama, k: [{tp: akumulasi >1%, h: [[investor, nama, jenis, L/F, persen, lembar, jumlah baris]],
                i: [catatan; ada = belum terverifikasi]}], f: [free float], c: [jumlah pemegang],
                p: [[pemegang >=5% gabungan, 1 kalau terverifikasi, R (laporan emiten) / K (baris KSEI >=5%) /
                     P (persen tertulis laporan, kalau total saham tidak terbaca; selalu 0, lihat written_blockholders)]],
                r: satu huruf per bulan: v laporan emiten terbaca, x ada tetapi tabel pemegangnya belum terbaca, - tidak ada}]
    Nomor investor tetap sama lintas bulan per emiten: nama sama atau variasi semua kata inti sama yang
    unik di kedua sisi (lihat assign_investor_ids). Pasangan ambigu ditandai dan tidak dipaksakan sama.

    Hasil kedua (kepemilikan-laporan.json, diambil saat satu emiten dibuka):
      {months: [p], base: awalan url, names, categories, companies: {KODE: {d: [daftar pemegang (report_holders) | nomor bulan dengan
       daftar yang persis sama | null], u: [url laporan, tanpa base kalau diawali base], b: [jenis pemilik BAE]}}}
    Hasil ketiga: laporan perubahan kepemilikan per emiten (lihat filing_rows).
    """
    tickers = sorted({c["ticker"] for c in index["companies"]} | set((ledger or {}).get("tickers") or []))
    if len(tickers) > 5000 or any(not isinstance(t, str) or not re.fullmatch(r"[A-Z0-9]{2,12}", t) for t in tickers):
        raise ValueError("Kode emiten dari server tidak valid.")
    with ThreadPoolExecutor(max_workers=4) as pool:
        details = list(pool.map(lambda t: server.get(f"/api/ownership/{quote(t)}?profile_id={pid}"), tickers))
    months = month_range(details, index["ksei"]["months"])
    meta = [{"p": m, "asOf": None, "url": None, "desc": None} for m in months]
    names, classes, dps_names, categories, lookup = [], [], [], [], {}

    def ref(table, value):
        key = (id(table), value)
        if key not in lookup:
            lookup[key] = len(table)
            table.append(value)
        return lookup[key]

    companies, reports, filings, today = [], {}, {}, date.today().isoformat()
    for d in sorted(details, key=lambda d: d["ticker"]):
        rows = filing_rows(d.get("filings"), d.get("ownership_audit"), today)
        if rows:
            filings[d["ticker"]] = rows
        ksei = {p["period"]: p for p in d.get("ksei_periods") or []}
        history, k, f, c, p5, status, dps, urls, bae = {}, [], [], [], [], "", [], [], []
        for i, month in enumerate(months):
            chosen, versions, conflict = chosen_version(d.get("periods"), month)
            trusted = comparable(chosen) and not conflict
            free_float, holders = report_metrics(chosen, versions, trusted)
            f.append(free_float)
            c.append(holders)
            listed = report_holders(chosen, lambda v: ref(dps_names, v), trusted=trusted,
                                    usable=derivable(chosen, versions))
            status += "-" if not chosen else "v" if listed["h"] else "x"
            same = next((j for j in range(i - 1, -1, -1) if isinstance(dps[j], dict)), None)
            dps.append(same if listed and same is not None and dps[same] == listed else listed)
            urls.append(report_url((chosen or {}).get("source_url")))
            bae.append(report_categories(chosen_version(d.get("category_periods"), month)[0], lambda v: ref(categories, v)))
            block = blockholders(chosen, trusted)
            cur = ksei.get(month)
            if block[0] is None and cur:
                block = ksei_block(cur) + ("K",)
            if block[0] is None:
                written = written_blockholders(chosen, conflict=conflict)
                block = block if written is None else (written, 0, "P")
            p5.append(None if block[0] is None else [block[0], block[1], block[2] if len(block) > 2 else "R"])
            if not cur:
                k.append(None)
                continue
            source = cur.get("file") or {}
            meta[i]["asOf"] = meta[i]["asOf"] or cur.get("as_of")
            if not meta[i]["url"] and str(source.get("url") or "").startswith("https://"):
                meta[i]["url"], meta[i]["desc"] = source["url"], redact(source.get("description") or "")
            groups = holder_groups(cur.get("holders") or [])
            identity_issues = assign_investor_ids(groups, history)
            if identity_issues and p5[-1] and p5[-1][2] == "K":
                p5[-1][1] = 0
            rows = []
            for key, g in groups.items():
                rows.append([g["inv"], ref(names, redact(g["name"] or "")), ref(classes, g["cls"] or ""), g["lf"] or "",
                             None if g["pct"] is None else round(g["pct"], 4), g["total"], g["rows"]])
            rows.sort(key=lambda r: (-(r[4] or 0), r[0]))
            entry = {"tp": cur.get("total_pct"), "h": rows}
            issues = cur.get("issues") or ([] if cur.get("validation") in (None, "ok") else [cur.get("validation")])
            if not issues and not ksei_ok(cur) and cur.get("holders"):
                issues = ["row_needs_review"]
            issues = list(issues) + identity_issues
            if issues:
                entry["i"] = [redact(issue_text(x)) for x in issues]
            k.append(entry)
        if any(k) or any(f) or any(c) or any(p5) or any(x is not None for x in dps) or d["ticker"] in filings:
            companies.append({"t": d["ticker"], "n": redact((d.get("company_name") or "").strip()), "k": k, "f": f, "c": c, "p": p5, "r": status})
            report = {}
            if any(x is not None for x in dps):
                report["d"], report["u"] = dps, urls
            if any(bae):
                report["b"] = bae
            if report:
                reports[d["ticker"]] = report
    data = {"format": OWNERSHIP_FORMAT, "updated": index.get("updated_at"), "months": meta,
            "names": names, "classes": classes, "companies": companies}
    laporan = {"format": REPORTS_FORMAT, "months": months, "base": IDX_REPORT_BASE, "names": dps_names,
               "categories": categories, "companies": reports}
    changes = {"format": 1, "coverage": (ledger or {}).get("coverage"), "companies": filings}
    return data, laporan, changes


def sync_ownership(server, state, force, profile, guard):
    pid = quote(profile["id"], safe="")
    index = server.get(f"/api/ownership?profile_id={pid}")
    if index.get("profile_id") not in (None, profile["id"]):
        raise ProfileMismatch(f"data kepemilikan dari profil '{index.get('profile_id')}', bukan '{profile['id']}'")
    ledger = read_ledger(profile) if getattr(server, "local", False) else None
    fp = json.dumps({"format": [OWNERSHIP_FORMAT, REPORTS_FORMAT],
                     "index": {k: index.get(k) for k in ("profile_id", "updated_at", "parser_version", "counts", "ksei")},
                     "ksei_files": ledger and ledger["files"], "ksei_tickers": ledger and len(ledger["tickers"]),
                     "filings": ledger and ledger["filings"], "coverage": ledger and ledger["coverage"]}, sort_keys=True)
    if not force and state.get("ownership") == fp and all(
            path.exists() for path in (OWNERSHIP_JSON, REPORTS_JSON, FILINGS_JSON)):
        return [], []
    data, laporan, changes = ownership_data(server, index, ledger, pid)
    if not data["companies"]:
        print("  server tidak mengembalikan data kepemilikan; kepemilikan.json lama dibiarkan")
        return [], []
    changed = []
    for path, value in ((OWNERSHIP_JSON, data), (REPORTS_JSON, laporan if laporan["companies"] else None),
                        (FILINGS_JSON, changes if changes["companies"] else None)):
        if value is not None and write_if_changed(path, json.dumps(value, ensure_ascii=False, separators=(",", ":"))):
            changed.append(path.name)
    guard()
    removed = prune("kepemilikan_", set(), allow_empty=True)
    state["ownership"] = fp
    return changed, removed


# ---------------------------------------------------------------- Stockbit Ideas

class StockbitRefused(ValueError):
    """Ekspor Stockbit tidak lolos pemeriksaan; sinkron dibatalkan tanpa menulis apa pun."""


def iso_day(value, what="tanggal"):
    if not isinstance(value, str) or not ISO_DAY.fullmatch(value):
        raise StockbitRefused(f"{what} tidak valid: {value!r}")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise StockbitRefused(f"{what} tidak valid: {value!r}") from None


def sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def stockbit_ids(ids):
    """stream_id karantina dari server, sebagai string angka."""
    if ids is None:
        return set()
    if not isinstance(ids, list):
        raise StockbitRefused("quarantined_stream_ids harus berupa daftar.")
    out = set()
    for value in ids:
        text = str(value) if isinstance(value, int) and not isinstance(value, bool) else value
        if not isinstance(text, str) or not re.fullmatch(r"[1-9]\d{0,19}", text):
            raise StockbitRefused(f"stream_id karantina tidak valid: {value!r}")
        out.add(text)
    return out


def quarantine_hits(text, ids):
    """stream_id karantina yang masih muncul, baik sebagai tautan stockbit.com/post/<id> maupun angka lepas."""
    return sorted(ids & set(re.findall(r"(?<!\d)\d{1,20}(?!\d)", text)), key=int) if ids else []


def check_stockbit_file(name, expected, text, sha, quarantined):
    """Tolak berkas yang namanya, kategorinya, hash-nya, atau isinya tidak sesuai kontrak ekspor."""
    if name != expected:
        raise StockbitRefused(f"nama berkas dari server {name!r}, seharusnya {expected!r}")
    match = STOCKBIT_FILE.fullmatch(name)
    if not match:
        raise StockbitRefused(f"nama berkas Stockbit tidak dikenal: {name!r}")
    category = categorize(Path(name).stem)
    if category != STOCKBIT_CATEGORY[match[1]]:
        raise StockbitRefused(f"build.py memasukkan {name} ke kategori '{category}', bukan '{STOCKBIT_CATEGORY[match[1]]}'; "
                              f"tambahkan kategorinya di CATEGORIES build.py dulu")
    if not isinstance(text, str) or not text.strip():
        raise StockbitRefused(f"{name} kosong")
    if not isinstance(sha, str) or sha.lower() != sha256_text(text):
        raise StockbitRefused(f"sha256 {name} tidak cocok dengan isinya")
    hits = quarantine_hits(text, quarantined)
    if hits:
        raise StockbitRefused(f"{name} masih memuat stream_id karantina {', '.join(hits[:5])}")


def filter_stockbit_index(index, drop):
    """Buang hari `drop` (sebelum --stockbit-since, ditahan rollback, atau ditahan desk) dari indeks desk dan petakan ulang dayIdx.

    Ekspor desk mendaftar semua hari final di DB-nya tanpa batas awal; baris tickers/users yang menunjuk hari
    yang dibuang ikut dibuang, begitu juga kunci yang jadi kosong dan user_notes untuk akun yang tidak tersisa.
    Catatan akun (penilaian/benang) yang merujuk temuan hari yang dibuang, atau yang based_on.last_day-nya hari yang
    dibuang, dibuang utuh: teksnya bisa menceritakan hari itu dan tidak bisa dibersihkan.
    """
    if not isinstance(index, dict) or index.get("format") != 1 or not isinstance(index.get("days"), list):
        raise StockbitRefused("stockbit-index.json tidak berformat 1")
    if not drop:
        return index
    # id temuan -> hari, dari baris users SEBELUM hari dibuang (sesudahnya rujukan ke hari yang dibuang tidak terlihat lagi).
    dropped_ids = set()
    users = index.get("users")
    for rows in (users.values() if isinstance(users, dict) else ()):
        for row in (rows if isinstance(rows, list) else ()):
            if isinstance(row, list) and len(row) > 3 and isinstance(row[0], int) and not isinstance(row[0], bool) \
                    and 0 <= row[0] < len(index["days"]) and isinstance(index["days"][row[0]], dict) \
                    and index["days"][row[0]].get("d") in drop and isinstance(row[3], list):
                dropped_ids |= {str(i) for i in row[3] if isinstance(i, (str, int)) and not isinstance(i, bool)}
    remap, days = {}, []
    for old, row in enumerate(index["days"]):
        if isinstance(row, dict) and row.get("d") in drop:
            continue
        remap[old] = len(days)
        days.append(row)
    out = {**index, "days": days}
    for key in ("tickers", "users"):
        table = index.get(key, {})
        if not isinstance(table, dict):
            continue  # check_stockbit_index menolaknya
        kept = {}
        for name, rows in table.items():
            if not isinstance(rows, list):
                raise StockbitRefused(f"{key}.{name} di stockbit-index.json harus daftar")
            new = []
            for row in rows:
                if not isinstance(row, list) or not row or not isinstance(row[0], int) or isinstance(row[0], bool) \
                        or not 0 <= row[0] < len(index["days"]):
                    raise StockbitRefused(f"baris {key}.{name} di stockbit-index.json tidak menunjuk hari yang valid")
                if row[0] in remap:
                    new.append([remap[row[0]], *row[1:]])
            if new:
                kept[name] = new
        out[key] = kept
    notes = index.get("user_notes")
    if isinstance(notes, dict):
        out["user_notes"] = {h: n for h, n in notes.items()
                             if h in out.get("users", {}) and not note_touches(n, dropped_ids, drop)}
    return out


def note_ids(note):
    """id temuan yang dirujuk penilaian dan benang sebuah catatan akun, sebagai string."""
    out = []
    for part in ("penilaian", "benang"):
        sub = note.get(part) if isinstance(note, dict) else None
        ids = sub.get("finding_ids") if isinstance(sub, dict) else None
        out += [str(i) for i in ids if isinstance(i, (str, int)) and not isinstance(i, bool)] if isinstance(ids, list) else []
    return out


def note_touches(note, dropped_ids, drop):
    """True kalau catatan merujuk temuan hari yang dibuang, atau based_on.last_day-nya hari yang dibuang."""
    based = note.get("based_on") if isinstance(note, dict) else None
    return any(i in dropped_ids for i in note_ids(note)) or (isinstance(based, dict) and based.get("last_day") in drop)


def check_stockbit_index(index, published, quarantined):
    """stockbit-index.json hanya boleh menunjuk hari yang terbit, dan penilaian otomatis harus bersumber temuan."""
    if not isinstance(index, dict) or index.get("format") != 1 or not isinstance(index.get("days"), list):
        raise StockbitRefused("stockbit-index.json tidak berformat 1")
    for row in index["days"]:
        if not isinstance(row, dict):
            raise StockbitRefused("baris hari di stockbit-index.json tidak valid")
        day = row.get("d")
        iso_day(day, "tanggal di stockbit-index.json")
        if row.get("f") != f"sbringkas_{day}_{day}.md" or day not in published:
            raise StockbitRefused(f"stockbit-index.json menunjuk hari {day} yang tidak diterbitkan ({row.get('f')!r})")
        if row.get("detail") not in (None, f"sbdetail_{day}_{day}.md"):
            raise StockbitRefused(f"berkas detail {row.get('detail')!r} di stockbit-index.json tidak sesuai tanggal {day}")
    for key in ("tickers", "users"):
        if not isinstance(index.get(key, {}), dict):
            raise StockbitRefused(f"{key} di stockbit-index.json harus objek")
    notes = index.get("user_notes", {})
    if not isinstance(notes, dict):
        raise StockbitRefused("user_notes di stockbit-index.json harus objek")
    published_ids = {str(i) for rows in index.get("users", {}).values() if isinstance(rows, list)
                     for row in rows if isinstance(row, list) and len(row) > 3 and isinstance(row[3], list)
                     for i in row[3] if isinstance(i, (str, int)) and not isinstance(i, bool)}
    for handle, note in notes.items():
        if not isinstance(note, dict):
            continue
        verdict = note.get("penilaian")
        if verdict is not None:
            ids = verdict.get("finding_ids") if isinstance(verdict, dict) else None
            if not isinstance(verdict, dict) or not isinstance(verdict.get("text"), str) or not verdict["text"].strip() \
                    or not isinstance(ids, list) or not ids or not all(isinstance(i, (str, int)) and not isinstance(i, bool) for i in ids):
                raise StockbitRefused(f"penilaian untuk @{handle} harus punya teks dan finding_ids")
        # Opsional (desk baru): benang lintas hari juga harus bersumber temuan; based_on = jumlah temuan s.d. hari terakhir.
        thread = note.get("benang")
        if thread is not None:
            ids = thread.get("finding_ids") if isinstance(thread, dict) else None
            if not isinstance(thread, dict) or not isinstance(thread.get("text"), str) or not thread["text"].strip() \
                    or not isinstance(ids, list) or not ids or not all(isinstance(i, str) and i for i in ids):
                raise StockbitRefused(f"benang untuk @{handle} harus punya teks dan finding_ids")
        based = note.get("based_on")
        if based is not None:
            count = based.get("findings") if isinstance(based, dict) else None
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                raise StockbitRefused(f"based_on untuk @{handle} harus berisi findings (bilangan >= 0) dan last_day")
            iso_day(based.get("last_day"), f"based_on.last_day untuk @{handle}")
        # Rujukan harus temuan yang ada di baris users yang terbit (bukan hari yang dibuang atau tidak dikenal).
        missing = [i for i in note_ids(note) if i not in published_ids]
        if missing:
            raise StockbitRefused(f"catatan @{handle} merujuk temuan yang tidak ada di indeks yang terbit: {', '.join(missing[:5])}")
    text = json.dumps(index, ensure_ascii=False, separators=(",", ":"))
    hits = quarantine_hits(text, quarantined)
    if hits:
        raise StockbitRefused(f"stockbit-index.json masih memuat stream_id karantina {', '.join(hits[:5])}")
    redacted = redact(text)
    try:
        json.loads(redacted)
    except ValueError:
        raise StockbitRefused("penyamaran merusak stockbit-index.json") from None
    return redacted


def load_stockbit_state():
    try:
        state = json.loads(STOCKBIT_STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"format": 1}
    return state if isinstance(state, dict) and state.get("format") == 1 else {"format": 1}


def read_stockbit_hold():
    """Entri mentah .stockbit-hold.json {tgl: entri}, apa adanya. Berkas tidak ada = tidak ada yang ditahan."""
    try:
        data = json.loads(STOCKBIT_HOLD.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        raise StockbitRefused(f"{STOCKBIT_HOLD.name} tidak bisa dibaca; perbaiki atau hapus dulu") from None
    days = data.get("days") if isinstance(data, dict) else None
    if not isinstance(days, dict):
        raise StockbitRefused(f"{STOCKBIT_HOLD.name} tidak berisi objek days")
    for day in days:
        iso_day(day, f"tanggal di {STOCKBIT_HOLD.name}")
    return dict(days)


def hold_sha(entry):
    sha = entry.get("sha256") if isinstance(entry, dict) else entry
    return str(sha or "*").lower()


def load_stockbit_hold():
    """Hari yang ditahan (rollback atau desk): {tgl: sha256 atau "*"}."""
    return {day: hold_sha(entry) for day, entry in read_stockbit_hold().items()}


# Entri tahanan yang dibuat sinkron untuk hari terbit yang ditahan desk ("tahan dari web").
DESK_HOLD = {"sha256": "*", "withheld_by": "desk"}


def stockbit_withheld(server):
    """Hari yang ditahan desk dari web, atau None kalau desk tidak punya endpoint ini (HTTP 404: desk lama/belum di-restart).

    None berarti "tidak diketahui", bukan "tidak ada yang ditahan": pemanggil mempertahankan tahanan desk yang sudah tercatat.
    """
    try:
        r = server.get("/api/stockbit/export/withheld")
    except HTTPError as e:
        if e.code == 404:
            e.close()
            return None
        raise
    days = r.get("days") if isinstance(r, dict) else None
    if not isinstance(days, list):
        raise StockbitRefused("respons export/withheld tidak berisi daftar days")
    if r.get("llm_calls", 0) != 0:
        raise StockbitRefused("export/withheld melaporkan panggilan LLM; ekspor harus read-only")
    for day in days:
        iso_day(day, "tanggal export/withheld")
    return set(days)


def stockbit_file_days(match):
    """Hari yang dicakup berkas sb*: satu hari untuk sbringkas/sbdetail, tujuh hari untuk sbpekan."""
    try:
        start, end = date.fromisoformat(match[2]), date.fromisoformat(match[3])
    except ValueError:
        return set()  # nama berpola tanggal tetapi tidak valid: bukan hasil sinkron, dibiarkan
    if match[1] != "sbpekan":
        return {match[2]}
    return {(start + timedelta(days=i)).isoformat() for i in range(min((end - start).days, 6) + 1)}


def desk_hold_entries(entries, withheld, withdrawn):
    """Gabungkan tahanan desk ke entri .stockbit-hold.json; tahanan rollback tidak pernah dihapus.

    Hari yang tidak lagi ditahan desk: entri desk murni dihapus (hari itu terbit lagi), sedangkan entri rollback yang
    ikut ditandai desk hanya kehilangan withheld_by. Hari terbit yang berkasnya dicabut (`withdrawn`) diberi withheld_by=desk.
    """
    out = {}
    for day, entry in entries.items():
        if isinstance(entry, dict) and entry.get("withheld_by") == "desk" and day not in withheld:
            if entry == DESK_HOLD:
                continue
            entry = {k: v for k, v in entry.items() if k != "withheld_by"}
        out[day] = entry
    for day in withdrawn:
        prev = out.get(day)
        if prev is None:
            out[day] = dict(DESK_HOLD)
        elif isinstance(prev, dict):
            out[day] = {**prev, "withheld_by": "desk"}
        else:  # entri lama berbentuk teks = tahanan rollback; dipertahankan saat desk melepas harinya
            out[day] = {"sha256": hold_sha(prev), "rollback_of": None, "withheld_by": "desk"}
    return out


def sync_stockbit(server, state, force=False, allow_provisional=False, since=STOCKBIT_SINCE):
    """Salin hari final Stockbit dari ekspor read-only Signal Desk; kembalikan nama berkas yang berubah.

    Semua respons diperiksa dulu; satu kegagalan menolak seluruh putaran sebelum ada berkas yang ditulis atau dihapus.
    Berkas sb* hanya dihapus untuk hari yang ditahan desk dari web (export/withheld): berkas harian dan rekap pekan yang
    memuat hari itu dicabut, statusnya dibuang, dan harinya dicatat di .stockbit-hold.json dengan withheld_by=desk.
    Penghapusan lain hanya lewat rollback_stockbit.py.
    """
    since_day = iso_day(since, "--stockbit-since")
    withheld = stockbit_withheld(server)
    if withheld is None:
        # Tanpa daftar dari desk, tahanan desk terakhir tetap berlaku: hari itu tetap tidak terbit dan tidak masuk indeks.
        withheld = {day for day, entry in read_stockbit_hold().items()
                    if isinstance(entry, dict) and entry.get("withheld_by") == "desk"}
        if withheld:
            print(f"  peringatan: desk tidak punya export/withheld (HTTP 404); {len(withheld)} hari yang ditahan desk tetap ditahan")
    listing = server.get("/api/stockbit/export/days" + ("?include_provisional=1" if allow_provisional else ""))
    days = listing.get("days") if isinstance(listing, dict) else None
    if not isinstance(days, list):
        raise StockbitRefused("respons export/days tidak berisi daftar days")
    allowed = {"final", "sementara"} if allow_provisional else {"final"}
    provisional = "include_provisional=1" if allow_provisional else ""

    # Berkas terbit yang mencakup hari yang ditahan desk dicabut (sbpekan juga, karena rekapnya memuat hari itu).
    entries = read_stockbit_hold()
    withdraw, withdrawn = [], set()
    for p in sorted(DEST.glob("sb*.md")):
        m = STOCKBIT_FILE.fullmatch(p.name)
        hit = stockbit_file_days(m) & withheld if m else set()
        if hit:
            withdraw.append(p.name)
            withdrawn |= hit
    new_entries = desk_hold_entries(entries, withheld, withdrawn)
    hold = {day: hold_sha(entry) for day, entry in new_entries.items()}

    # Hari yang sudah terbit tidak pernah "terlalu awal": publish dengan --stockbit-since lebih awal (tanggal 'Dari' di
    # desk) tetap diperbarui dan dihitung oleh putaran berikutnya yang memakai batas bawaan.
    already = {m[2] for p in DEST.glob("sbringkas_*.md") if (m := STOCKBIT_FILE.fullmatch(p.name))}
    eligible, held, early = {}, set(), set()
    for row in days:
        if not isinstance(row, dict):
            raise StockbitRefused("baris export/days tidak valid")
        day = iso_day(row.get("date"), "tanggal export/days")
        if row["date"] in withheld:
            continue  # desk seharusnya sudah tidak mendaftarnya; tetap tidak diterbitkan
        if day < since_day and row["date"] not in already:
            early.add(row["date"])
            continue
        if row.get("state") not in allowed:
            continue
        if row["date"] in hold and hold[row["date"]] in ("*", str(row.get("sha256") or "").lower()):
            held.add(row["date"])  # di-rollback; tunggu desk memfinalkan ulang (sha baru) atau hapus entri tahanan
            continue
        if row["date"] in eligible:
            raise StockbitRefused(f"tanggal {row['date']} muncul dua kali di export/days")
        if row.get("ok") is not True:
            raise StockbitRefused(f"cakupan {row['date']} belum klop (ok bukan true); tinjau di Signal Desk dulu")
        eligible[row["date"]] = row

    # Hari yang dicabut karena ditahan desk tidak dihitung sebagai terbit (sama seperti hari yang ditahan rollback),
    # jadi penjaga jumlah di bawah tidak menolaknya.
    published = {m[2] for p in DEST.glob("sbringkas_*.md") if (m := STOCKBIT_FILE.fullmatch(p.name)) and p.name not in withdraw}
    for day in sorted(held):
        print(f"  ditahan rollback: {day} (sha ekspor belum berubah; lihat {STOCKBIT_HOLD.name})")
    for day in sorted(withheld):
        print(f"  ditahan desk dari web: {day}" + (" (berkas terbit dicabut)" if day in withdrawn else ""))
    if len(eligible) + len(held & published) < len(published):
        raise StockbitRefused(f"server hanya mengekspor {len(eligible)} hari final, padahal {len(published)} hari sudah terbit; "
                              f"tidak ada yang ditulis")
    for day in sorted(published - eligible.keys() - held):
        print(f"  peringatan: {day} sudah terbit tetapi tidak lagi diekspor sebagai final; berkasnya dibiarkan")

    day_state, week_state = state.setdefault("days", {}), state.setdefault("weeks", {})
    pending, new_days, new_weeks, quarantined = {}, {}, {}, {}
    for day, row in sorted(eligible.items()):
        fp = f"{row.get('sha256')}|{row.get('updated_at')}|{row.get('state')}"
        names = {kind: f"{prefix}_{day}_{day}.md" for kind, prefix in STOCKBIT_KIND.items()}
        prev = day_state.get(day) or {}
        if not force and prev.get("fp") == fp and all((DEST / n).is_file() for n in names.values()):
            quarantined[day] = set(prev.get("quarantined") or [])
            continue
        responses = {}
        for kind in names:
            r = server.get(f"/api/stockbit/export/day/{day}?kind={kind}" + (f"&{provisional}" if provisional else ""))
            if not isinstance(r, dict):
                raise StockbitRefused(f"respons export/day {day} {kind} tidak valid")
            if r.get("state") != row.get("state"):
                raise StockbitRefused(f"status {day} berubah di tengah sinkron ({row.get('state')} -> {r.get('state')}); ulangi")
            coverage = r.get("coverage")
            if isinstance(coverage, dict) and coverage.get("ok") is False:
                raise StockbitRefused(f"cakupan {day} ({kind}) belum klop")
            if r.get("llm_calls", 0) != 0:
                raise StockbitRefused(f"export/day {day} melaporkan panggilan LLM; ekspor harus read-only")
            responses[kind] = r
        ids = set().union(*(stockbit_ids(r.get("quarantined_stream_ids")) for r in responses.values()))
        entry = {"fp": fp, "files": {}, "quarantined": sorted(ids, key=int)}
        for kind, r in responses.items():
            check_stockbit_file(r.get("name"), names[kind], r.get("text"), r.get("sha256"), ids)
            pending[names[kind]] = redact(r["text"])
            entry["files"][names[kind]] = r["sha256"].lower()
        quarantined[day], new_days[day] = ids, entry

    mondays = sorted({date.fromisoformat(d) - timedelta(days=date.fromisoformat(d).weekday()) for d in eligible})
    for monday in mondays:
        week = [(monday + timedelta(days=i)).isoformat() for i in range(7)]
        if not all(d in eligible for d in week):
            continue  # pekan belum lengkap di sisi arsip; jangan terbitkan rekap yang menunjuk hari yang belum terbit
        name = f"sbpekan_{week[0]}_{week[-1]}.md"
        fp = "|".join((new_days.get(d) or day_state.get(d) or {}).get("fp", "") for d in week)
        if not force and (week_state.get(week[0]) or {}).get("fp") == fp and (DEST / name).is_file():
            continue
        try:
            r = server.get(f"/api/stockbit/export/week/{week[0]}")
        except HTTPError as e:
            if e.code == 404:  # pekan belum lengkap menurut server
                e.close()
                continue
            raise
        if not isinstance(r, dict):
            raise StockbitRefused(f"respons export/week {week[0]} tidak valid")
        ids = set().union(*(quarantined.get(d, set()) for d in week))
        check_stockbit_file(r.get("name"), name, r.get("text"), r.get("sha256"), ids)
        pending[name] = redact(r["text"])
        new_weeks[week[0]] = {"fp": fp, "file": name, "sha256": r["sha256"].lower()}

    all_ids = set().union(*quarantined.values()) if quarantined else set()
    # Desk tidak membatasi tanggal awal indeks: buang hari sebelum --stockbit-since (kecuali yang sudah terbit) dan
    # hari yang ditahan (rollback atau desk); hari lain yang tidak terbit tetap ditolak.
    index = server.get("/api/stockbit/export/index" + (f"?{provisional}" if provisional else ""))
    index = filter_stockbit_index(index, (early - published) | held | withheld)
    index_text = check_stockbit_index(index, published | eligible.keys(), all_ids)

    # Semua lolos: baru menulis dan menghapus (di folder staging sync_once; sinkron yang ditolak tidak menghapus apa pun).
    changed = [name for name, text in sorted(pending.items()) if write_if_changed(DEST / name, text)]
    if write_if_changed(STOCKBIT_INDEX, index_text):
        changed.append(STOCKBIT_INDEX.name)
    for name in withdraw:
        path = DEST / name
        if path.is_symlink() or path.parent.resolve() != DEST.resolve():
            raise ValueError("Berkas Stockbit yang dicabut bukan berkas biasa dalam folder yang dikelola.")
        path.unlink()
        changed.append(name)
    if new_entries != entries:
        write_if_changed(STOCKBIT_HOLD, json.dumps({"format": 1, "days": dict(sorted(new_entries.items()))},
                                                   ensure_ascii=False, indent=1) + "\n")
        changed.append(STOCKBIT_HOLD.name)
    day_state.update(new_days)
    week_state.update(new_weeks)
    for day in withheld:
        day_state.pop(day, None)
    for monday in list(week_state):
        try:
            week = {(date.fromisoformat(monday) + timedelta(days=i)).isoformat() for i in range(7)}
        except (TypeError, ValueError):
            continue
        if week & withheld:
            del week_state[monday]
    state["format"] = 1
    # Tanpa cap waktu: status hanya berubah kalau isi berubah, supaya publish tanpa perubahan tidak membuat commit.
    write_if_changed(STOCKBIT_STATE, json.dumps(state, ensure_ascii=False, indent=1, sort_keys=True))
    return changed


def _sync_stockbit_once(args):
    """Mode --stockbit-only: tanpa /api/profiles, penjaga profil, digest, atau kepemilikan."""
    server = Server(args.server)
    server.get("/api/health", timeout=10)
    DEST.mkdir(parents=True, exist_ok=True)
    changed = sync_stockbit(server, load_stockbit_state(), force=getattr(args, "force", False),
                            allow_provisional=getattr(args, "allow_provisional", False),
                            since=getattr(args, "stockbit_since", None) or STOCKBIT_SINCE)
    print(f"[{datetime.now():%H:%M:%S}] Stockbit: {len(changed)} berkas baru/berubah")
    for name in changed:
        print(f"  {'+' if (DEST / name).exists() else '-'} {name}")
    return bool(changed)


# ---------------------------------------------------------------- inti

def prune(prefix, keep, allow_empty):
    """Hapus berkas lama milik skrip ini yang tidak lagi dihasilkan server."""
    if prefix.startswith("sb") or prefix.startswith("stockbit"):
        raise ValueError("Berkas Stockbit tidak pernah di-prune; hanya hari yang ditahan desk (atau rollback) yang dicabut.")
    stale = [p for p in DEST.glob(prefix + "*.md") if OWNED.match(p.name) and p.name not in keep]
    if stale and not allow_empty:
        print(f"  server tidak mengembalikan data {prefix.rstrip('_')}; {len(stale)} berkas lama dibiarkan")
        return []
    for p in stale:
        if p.is_symlink():
            raise ValueError("Berkas sinkron lama tidak boleh symlink.")
        p.unlink()
    return [p.name for p in stale]


def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _sync_once(args):
    server = Server(args.server)
    server.get("/api/health", timeout=10)
    DEST.mkdir(parents=True, exist_ok=True)
    state = load_state()
    profiles = server.get("/api/profiles")
    expected = args.profile or state.get("profile_id") or profiles["active_profile_id"]

    def guard():
        # Render digest selalu memakai profil aktif; cek ulang sebelum menghapus atau menyimpan status.
        active = server.get("/api/profiles")["active_profile_id"]
        if active != expected:
            raise ProfileMismatch(f"profil aktif di Signal Desk '{active}', arsip ini disinkron dari '{expected}'. "
                                  f"Aktifkan profil itu, atau jalankan dengan --profile {active} (berkas lama akan diganti).")

    guard()
    profile = next((p for p in profiles["profiles"] if p["id"] == expected), {"id": expected})
    if state.get("profile_id") != expected:
        state = {"profile_id": expected}
    d_changed, d_removed = ([], []) if getattr(args, "ownership_only", False) else sync_digests(server, state, args.force, guard)
    o_changed, o_removed = sync_ownership(server, state, args.force, profile, guard)
    guard()
    state["synced_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    write_if_changed(STATE, json.dumps(state, ensure_ascii=False, indent=1, sort_keys=True))
    changed, removed = d_changed + o_changed, d_removed + o_removed
    print(f"[{datetime.now():%H:%M:%S}] profil {expected}: {len(changed)} berkas baru/berubah, {len(removed)} dihapus")
    for name in changed:
        print(f"  + {name}")
    for name in removed:
        print(f"  - {name}")
    return bool(changed or removed)


def sync_once(args):
    global DEST, STATE, OWNERSHIP_JSON, FILINGS_JSON, REPORTS_JSON, STOCKBIT_STATE, STOCKBIT_INDEX, STOCKBIT_HOLD
    original, old_state, old_ownership, old_filings, old_reports = DEST, STATE, OWNERSHIP_JSON, FILINGS_JSON, REPORTS_JSON
    old_sb_state, old_sb_index, old_sb_hold = STOCKBIT_STATE, STOCKBIT_INDEX, STOCKBIT_HOLD
    if original.is_symlink() or not original.resolve().is_relative_to((ROOT / "needtobeindexed").resolve()):
        raise ValueError("Folder sinkron menunjuk keluar arsip.")
    original.mkdir(parents=True, exist_ok=True)
    def managed(path):
        return path.name in (".sync.json", "kepemilikan.json", "kepemilikan-perubahan.json", "kepemilikan-laporan.json",
                             ".sync-stockbit.json", "stockbit-index.json", ".stockbit-hold.json") \
            or bool(OWNED.fullmatch(path.name)) or bool(STOCKBIT_FILE.fullmatch(path.name))
    originals = {}
    for path in original.iterdir():
        if managed(path):
            if path.is_symlink() or not path.is_file():
                raise ValueError("Berkas sinkron harus file biasa.")
            originals[path.name] = path.read_bytes()
    with tempfile.TemporaryDirectory(prefix="archives-sync-") as folder:
        stage = Path(folder)
        for name, data in originals.items():
            (stage / name).write_bytes(data)
        try:
            DEST, STATE, OWNERSHIP_JSON = stage, stage / ".sync.json", stage / "kepemilikan.json"
            FILINGS_JSON, REPORTS_JSON = stage / "kepemilikan-perubahan.json", stage / "kepemilikan-laporan.json"
            STOCKBIT_STATE, STOCKBIT_INDEX = stage / ".sync-stockbit.json", stage / "stockbit-index.json"
            STOCKBIT_HOLD = stage / ".stockbit-hold.json"
            # --stockbit-only diputuskan di sini, sebelum _sync_once: tidak menyentuh /api/profiles, guard(), atau kepemilikan.
            changed = _sync_stockbit_once(args) if getattr(args, "stockbit_only", False) else _sync_once(args)
        finally:
            DEST, STATE, OWNERSHIP_JSON, FILINGS_JSON, REPORTS_JSON = original, old_state, old_ownership, old_filings, old_reports
            STOCKBIT_STATE, STOCKBIT_INDEX, STOCKBIT_HOLD = old_sb_state, old_sb_index, old_sb_hold
        staged = {p.name: p.read_bytes() for p in stage.iterdir() if managed(p)}
        # Refuse concurrent edits instead of silently overwriting them.
        current = {p.name: p.read_bytes() for p in original.iterdir() if managed(p) and p.is_file() and not p.is_symlink()}
        if current != originals or any(p.is_symlink() for p in original.iterdir() if managed(p)):
            raise RuntimeError("Arsip berubah selama sinkron; hasil sementara dibatalkan.")
        try:
            for name, data in staged.items():
                write_if_changed(original / name, data.decode("utf-8"))
            for name in originals.keys() - staged.keys():
                (original / name).unlink()
        except Exception:
            for name, data in originals.items():
                write_if_changed(original / name, data.decode("utf-8"))
            for name in staged.keys() - originals.keys():
                (original / name).unlink(missing_ok=True)
            raise
        return changed


def build(args):
    cmd = [sys.executable, str(ROOT / "build.py")]
    if args.fragment_index:
        cmd += ["--fragment-index", str(args.fragment_index)]
    result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
    lines = result.stdout.strip().splitlines()
    if result.returncode:
        print(result.stdout + result.stderr, file=sys.stderr)
        raise RuntimeError("build.py gagal")
    lainnya = [l for l in lines if l.startswith("Lainnya")]
    print(f"  build: {lines[-1] if lines else 'selesai'}" + (f" · {len(lainnya)} dokumen masuk 'Lainnya', cek nama berkas" if lainnya else ""))


def run(args):
    try:
        changed = sync_once(args)
        if getattr(args, "with_stockbit", False) and not getattr(args, "stockbit_only", False):
            # Putaran terpisah dengan staging sendiri: Stockbit yang ditolak tidak membatalkan digest/kepemilikan.
            changed = sync_once(argparse.Namespace(**{**vars(args), "stockbit_only": True})) or changed
    except StockbitRefused as e:
        print(f"Stockbit ditolak, tidak ada berkas yang ditulis: {e}", file=sys.stderr)
        return 1
    except HTTPError as e:
        print(f"Signal Desk menjawab HTTP {e.code} untuk {e.url}", file=sys.stderr)
        return 1
    except URLError as e:
        print(f"Signal Desk tidak bisa dihubungi di {args.server} ({getattr(e, 'reason', e)}). Jalankan: idx-digest gui", file=sys.stderr)
        return 1
    except ProfileMismatch as e:
        print(f"Dilewati: {e}", file=sys.stderr)
        return 2
    except (OSError, ValueError, KeyError, http.client.HTTPException, RuntimeError) as e:
        print(f"Sinkron gagal: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    if args.no_build:
        return 0
    # Fragment Artifact selalu ditulis ulang kalau diminta, supaya selalu sesuai build.py terbaru.
    if changed or args.build or args.fragment_index or not (ROOT / "site" / "index.html").exists():
        try:
            build(args)
        except RuntimeError as e:
            print(e, file=sys.stderr)
            return 3
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default=os.environ.get("IDX_SIGNAL_DESK", "http://127.0.0.1:8787"))
    ap.add_argument("--profile", help="ID profil Signal Desk yang disalin (default: yang tercatat di .sync.json, lalu profil aktif)")
    ap.add_argument("--watch", type=float, metavar="MENIT", help="ulangi sinkron tiap N menit")
    ap.add_argument("--force", action="store_true", help="render ulang semua walau server tidak berubah")
    ap.add_argument("--build", action="store_true", help="build walau tidak ada perubahan")
    ap.add_argument("--no-build", action="store_true", help="hanya salin berkas")
    ap.add_argument("--ownership-only", action="store_true", help="hanya sinkron data kepemilikan; digest dan statusnya dipertahankan")
    ap.add_argument("--fragment-index", type=Path, help="teruskan ke build.py (versi index untuk Claude Artifact)")
    ap.add_argument("--stockbit-only", action="store_true",
                    help="hanya ringkasan Stockbit (sb*.md + stockbit-index.json); tanpa profil, digest, atau kepemilikan")
    ap.add_argument("--with-stockbit", action="store_true", help="setelah sinkron biasa, jalankan juga sinkron Stockbit")
    ap.add_argument("--allow-provisional", action="store_true", help="Stockbit: ikutkan hari 'sementara' (default hanya final)")
    ap.add_argument("--stockbit-since", default=STOCKBIT_SINCE, metavar="YYYY-MM-DD",
                    help=f"Stockbit: abaikan hari sebelum tanggal ini (default {STOCKBIT_SINCE})")
    args = ap.parse_args()
    if args.stockbit_only and args.ownership_only:
        ap.error("--stockbit-only dan --ownership-only tidak bisa digabung")
    if not args.watch:
        raise SystemExit(run(args))
    print(f"Sinkron tiap {args.watch:g} menit dari {args.server}. Ctrl+C untuk berhenti.")
    try:
        while True:
            try:
                run(args)
            except Exception as e:  # satu putaran gagal tidak boleh menghentikan --watch
                print(f"[{datetime.now():%H:%M:%S}] putaran gagal: {type(e).__name__}: {e}", file=sys.stderr)
            args.build = args.force = False
            time.sleep(args.watch * 60)
    except KeyboardInterrupt:
        print("\nBerhenti.")


if __name__ == "__main__":
    main()
