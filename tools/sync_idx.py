#!/usr/bin/env python3
"""Salin data IDX Signal Desk (server lokal idx-digest) ke arsip ini, lalu build ulang.

    python3 tools/sync_idx.py                  # sekali: sinkron, build kalau ada yang berubah
    python3 tools/sync_idx.py --watch 15       # ulangi tiap 15 menit sampai Ctrl+C
    python3 tools/sync_idx.py --fragment-index /tmp/artifact/index.html   # build juga versi Artifact

Yang disalin, ke needtobeindexed/idx-signal-desk/ (folder ini milik skrip, isinya boleh ditimpa):
  digest_<awal>_<akhir>[_HHMM-HHMM].md   satu per jendela "Saved Intelligence" (render /api/share/render)
  kepemilikan.json                       semua bulan KSEI: pemegang >1%, free float resmi, dan jumlah pemegang per emiten
                                         (dibaca tab Kepemilikan Saham di viewer)
Hanya membaca: GET, render tanpa menulis berkas, dan ledger kepemilikan dibuka read-only. Tidak memicu scraping IDX.
"""
import argparse
import difflib
import http.client
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import tempfile
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import date, datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from build import date_label  # noqa: E402  (satu sumber format tanggal)

DEST = ROOT / "needtobeindexed" / "idx-signal-desk"
STATE = DEST / ".sync.json"
# kepemilikan_*.md adalah format lama (satu berkas per bulan); dihapus saat kepemilikan.json ditulis.
OWNED = re.compile(r"^(digest|kepemilikan)_[\w\-]+\.md$")
OWNERSHIP_JSON = DEST / "kepemilikan.json"
# Naikkan kalau bentuk kepemilikan.json berubah, supaya sinkron berikutnya membuatnya ulang.
OWNERSHIP_FORMAT = 2

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
        return {"tickers": sorted(tickers), "files": files}
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
    """Versi laporan yang dipilih server untuk bulan itu, dan semua versinya."""
    for period in periods or []:
        if str(period.get("period", "")).startswith(month):
            versions = period.get("versions") or []
            return next((v for v in versions if v.get("id") == period.get("preferred_id")), versions[0] if versions else None), versions
    return None, []


def report_metrics(chosen, versions):
    """Free float resmi dan jumlah pemegang dari laporan bulanan emiten.

    Free float: [nilai, 1 kalau tervalidasi, url sumber, [nilai versi laporan lain]]. Jumlah pemegang: [nilai, 1 kalau tervalidasi].
    """
    metrics = (chosen or {}).get("metrics") or {}
    ff, count = metrics.get("free_float_pct") or {}, metrics.get("holder_count") or {}
    free_float = holders = None
    if ff.get("value") is not None:
        others = sorted({v["metrics"]["free_float_pct"]["value"] for v in versions if v is not chosen
                         and ((v.get("metrics") or {}).get("free_float_pct") or {}).get("value") not in (None, ff["value"])})
        free_float = [ff["value"], int(ff.get("validation") == "ok"), https_or_none(chosen.get("source_url")), others]
    if count.get("value") is not None:
        holders = [count["value"], int(count.get("validation") == "ok")]
    return free_float, holders


def report_holders(chosen, name_ref):
    """Daftar pemegang saham di laporan emiten: pemegang >=5%/pengendali/afiliasi, lalu direksi dan komisaris.

    {h: [[nama, peran (bit ROLE_BITS), lembar, persen, 1 kalau tervalidasi]], s: total saham, u: url laporan}.
    h kosong = laporan ada tetapi tabelnya belum terbaca oleh Signal Desk (mis. teks PDF acak).
    Alamat dan kutipan halaman laporan sengaja tidak disalin.
    """
    if not chosen:
        return None
    rows = [[name_ref(redact(h.get("name") or "")), sum(ROLE_BITS.get(r, 0) for r in h.get("roles") or []),
             h.get("shares"), h.get("pct"), int(h.get("validation") == "ok")] for h in chosen.get("holders") or []]
    rows.sort(key=lambda r: (not r[1] & 7, -(r[3] or 0), r[0]))
    total = ((chosen.get("metrics") or {}).get("total_shares") or {}).get("value")
    return {"h": rows, "s": total, "u": https_or_none(chosen.get("source_url"))}


def report_categories(chosen, category_ref):
    """Jenis pemilik dari laporan BAE: {r: [[L/F, jenis, jumlah pemegang, lembar, persen, 1 kalau tervalidasi]],
    t: [[L/F/A (semua), jumlah pemegang, lembar, persen]], u: url}."""
    if not chosen or not chosen.get("rows"):
        return None
    rows = [[DOMICILE.get(r.get("domicile"), ""), category_ref(r.get("category_raw") or ""), r.get("holder_count"),
             r.get("shares"), r.get("pct"), int(r.get("validation") == "ok")] for r in chosen["rows"]]
    totals = [[DOMICILE.get(r.get("domicile"), ""), r.get("holder_count"), r.get("shares"), r.get("pct")] for r in chosen.get("totals") or []]
    return {"r": rows, "t": totals, "u": https_or_none(chosen.get("source_url"))}


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
              "CORPORATION", "DRS", "DRA", "IR", "SE", "SH", "SKH", "AC", "SA", "THE", "OF", "DR", "NA"}


def name_tokens(name):
    return {t for t in re.split(r"[^A-Z0-9]+", str(name or "").upper())
            if len(t) > 1 and t not in NAME_NOISE and not t.isdigit()}


def same_investor(a, b):
    """Nama mirip: satu berisi semua kata inti yang lain (TASPEN / PT TASPEN (PERSERO)) atau hampir sama ejaannya."""
    ta, tb = name_tokens(a), name_tokens(b)
    if not ta or not tb:
        return False
    return ta <= tb or tb <= ta or difflib.SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio() >= 0.85


def match_renamed(now, old):
    """KSEI kadang menulis nama investor berbeda antarbulan (TASPEN / PT TASPEN (PERSERO)).

    Pasangan "baru" dan "keluar" dianggap investor yang sama hanya kalau jumlah lembarnya persis sama
    dan namanya mirip; lembar sama dengan nama berbeda bisa berarti saham benar-benar berpindah tangan.
    """
    gone = {k: g for k, g in old.items() if k not in now and g["total"]}
    renamed = {}
    for key, g in now.items():
        if key in old or not g["total"]:
            continue
        match = next((k for k, o in gone.items() if o["total"] == g["total"] and same_investor(o["name"], g["name"])), None)
        if match:
            renamed[key] = gone.pop(match)
    return renamed


ISSUE_TEXT = {
    "missing": "tidak ada baris pemegang untuk emiten ini",
    "duplicate_investor_key": "investor dengan nama sama muncul lebih dari sekali",
    "row_needs_review": "ada baris yang perlu dicek",
}


def issue_text(issue):
    code, _, detail = str(issue).partition(":")
    return ISSUE_TEXT.get(code, code) + (f" ({detail})" if detail else "")


def ownership_data(server, index, ledger, pid):
    """Semua bulan KSEI dalam satu struktur ringkas untuk tab Kepemilikan Saham.

    months:    [{p: "2026-08", asOf, url, desc}] urut naik; semua larik per emiten sejajar dengan ini (null = tidak ada data).
    names/classes: kamus nama investor dan jenis pemegang (baris hanya menyimpan nomor urutnya).
    companies: [{t: kode, n: nama, k: [{tp: akumulasi >1%, h: [[investor, nama, jenis, L/F, persen, lembar, jumlah baris]],
                i: [catatan]}], f: [free float], c: [jumlah pemegang],
                d: [daftar pemegang saham laporan emiten], b: [jenis pemilik BAE]}]  (d dan b tidak ada kalau kosong semua)
    Nomor investor tetap sama lintas bulan per emiten: nama yang sama, atau nama mirip dengan lembar persis sama
    dari bulan data sebelumnya (lihat match_renamed), sehingga viewer bisa membandingkan dua bulan mana pun.
    """
    tickers = sorted({c["ticker"] for c in index["companies"]} | set((ledger or {}).get("tickers") or []))
    if len(tickers) > 5000 or any(not isinstance(t, str) or not re.fullmatch(r"[A-Z0-9]{2,12}", t) for t in tickers):
        raise ValueError("Kode emiten dari server tidak valid.")
    with ThreadPoolExecutor(max_workers=4) as pool:
        details = list(pool.map(lambda t: server.get(f"/api/ownership/{quote(t)}?profile_id={pid}"), tickers))
    months = sorted(index["ksei"]["months"])
    meta = [{"p": m, "asOf": None, "url": None, "desc": None} for m in months]
    names, classes, categories, lookup = [], [], [], {}

    def ref(table, value):
        key = (id(table), value)
        if key not in lookup:
            lookup[key] = len(table)
            table.append(value)
        return lookup[key]

    companies = []
    for d in sorted(details, key=lambda d: d["ticker"]):
        ksei = {p["period"]: p for p in d.get("ksei_periods") or []}
        ids, prev, k, f, c, dps, bae = {}, None, [], [], [], [], []
        for i, month in enumerate(months):
            chosen, versions = chosen_version(d.get("periods"), month)
            free_float, holders = report_metrics(chosen, versions)
            f.append(free_float)
            c.append(holders)
            dps.append(report_holders(chosen, lambda v: ref(names, v)))
            bae.append(report_categories(chosen_version(d.get("category_periods"), month)[0], lambda v: ref(categories, v)))
            cur = ksei.get(month)
            if not cur:
                k.append(None)
                continue
            source = cur.get("file") or {}
            meta[i]["asOf"] = meta[i]["asOf"] or cur.get("as_of")
            if not meta[i]["url"] and str(source.get("url") or "").startswith("https://"):
                meta[i]["url"], meta[i]["desc"] = source["url"], redact(source.get("description") or "")
            groups = holder_groups(cur.get("holders") or [])
            renamed = match_renamed(groups, prev) if prev else {}
            rows = []
            for key, g in groups.items():
                inv = ids.get(key)
                if inv is None:
                    inv = renamed[key]["inv"] if key in renamed else len({*ids.values()})
                ids[key] = g["inv"] = inv
                rows.append([inv, ref(names, redact(g["name"] or "")), ref(classes, g["cls"] or ""), g["lf"] or "",
                             None if g["pct"] is None else round(g["pct"], 4), g["total"], g["rows"]])
            rows.sort(key=lambda r: (-(r[4] or 0), r[0]))
            entry = {"tp": cur.get("total_pct"), "h": rows}
            issues = cur.get("issues") or ([] if cur.get("validation") in (None, "ok") else [cur.get("validation")])
            if issues:
                entry["i"] = [redact(issue_text(x)) for x in issues]
            k.append(entry)
            prev = groups
        if any(k) or any(f) or any(dps):
            company = {"t": d["ticker"], "n": redact((d.get("company_name") or "").strip()), "k": k, "f": f, "c": c}
            if any(dps):
                company["d"] = dps
            if any(bae):
                company["b"] = bae
            companies.append(company)
    return {"format": OWNERSHIP_FORMAT, "updated": index.get("updated_at"), "months": meta,
            "names": names, "classes": classes, "categories": categories, "companies": companies}


def sync_ownership(server, state, force, profile, guard):
    pid = quote(profile["id"], safe="")
    index = server.get(f"/api/ownership?profile_id={pid}")
    if index.get("profile_id") not in (None, profile["id"]):
        raise ProfileMismatch(f"data kepemilikan dari profil '{index.get('profile_id')}', bukan '{profile['id']}'")
    ledger = read_ledger(profile) if getattr(server, "local", False) else None
    fp = json.dumps({"format": OWNERSHIP_FORMAT,
                     "index": {k: index.get(k) for k in ("profile_id", "updated_at", "parser_version", "counts", "ksei")},
                     "ksei_files": ledger and ledger["files"], "ksei_tickers": ledger and len(ledger["tickers"])}, sort_keys=True)
    if not force and state.get("ownership") == fp and OWNERSHIP_JSON.exists():
        return [], []
    data = ownership_data(server, index, ledger, pid)
    if not data["companies"]:
        print("  server tidak mengembalikan data kepemilikan; kepemilikan.json lama dibiarkan")
        return [], []
    text = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    changed = [OWNERSHIP_JSON.name] if write_if_changed(OWNERSHIP_JSON, text) else []
    guard()
    removed = prune("kepemilikan_", set(), allow_empty=True)
    state["ownership"] = fp
    return changed, removed


# ---------------------------------------------------------------- inti

def prune(prefix, keep, allow_empty):
    """Hapus berkas lama milik skrip ini yang tidak lagi dihasilkan server."""
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
    d_changed, d_removed = sync_digests(server, state, args.force, guard)
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
    global DEST, STATE, OWNERSHIP_JSON
    original, old_state, old_ownership = DEST, STATE, OWNERSHIP_JSON
    if original.is_symlink() or not original.resolve().is_relative_to((ROOT / "needtobeindexed").resolve()):
        raise ValueError("Folder sinkron menunjuk keluar arsip.")
    original.mkdir(parents=True, exist_ok=True)
    def managed(path):
        return path.name in (".sync.json", "kepemilikan.json") or bool(OWNED.fullmatch(path.name))
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
            changed = _sync_once(args)
        finally:
            DEST, STATE, OWNERSHIP_JSON = original, old_state, old_ownership
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
    ap.add_argument("--fragment-index", type=Path, help="teruskan ke build.py (versi index untuk Claude Artifact)")
    args = ap.parse_args()
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
