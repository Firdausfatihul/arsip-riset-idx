#!/usr/bin/env python3
"""Terbitkan ringkasan Stockbit dan keterbukaan BEI sekali klik (dijalankan desk dengan cwd = akar arsip), dan bisa di-rollback.

    python3 -B tools/publish_stockbit.py             # preflight, sinkron, cek build, deploy chat, commit+tag, push
    python3 -B tools/publish_stockbit.py --dry-run   # preflight + sinkron + cek build saja (tanpa deploy/commit/push)

Urutan:
  1. Preflight: git dan npx ada, cabang main, tidak ada yang di-stage, tidak ada perubahan selain berkas Stockbit/BEI di
     needtobeindexed/idx-signal-desk/ (sb*.md, stockbit-index.json, .sync-stockbit.json, .stockbit-hold.json, bei*.md,
     bei-index.json, .sync-bei.json, .bei-hold.json; berkas titik lain seperti .sync.json dibiarkan karena tidak ikut
     build), docs/, dan site/ (hasil build yang ikut dilacak git).
     digest_*/kepemilikan* yang belum di-commit menolak publish: publish_chat akan men-deploy-nya dan rollback Stockbit
     akan ikut membatalkannya. Lalu tidak ada commit lokal yang belum dipush, `git fetch` + `git pull --ff-only` kalau
     tertinggal origin/main, ruang disk >= 1,5 GB.
  2. Catat titik rollback SEBELUM mengubah apa pun: HEAD dan versi Worker yang sedang live. Kalau publish sebelumnya
     sudah deploy tanpa commit (exit 6/7/batas waktu), versi Worker sebelum publish itu yang dipakai (`rollback_to`).
  3. `tools/sync_idx.py --stockbit-only --no-build --with-bei`: Stockbit dan BEI dalam SATU staging; BEI yang ditolak
     (atau HTTP error BEI) dikembalikan utuh dan dilewati (`bei_skipped`), Stockbit tetap terbit; desk tanpa /api/bei (404) = BEI dilewati. Kalau tidak ada
     berkas Stockbit/BEI yang berubah: selesai, "tidak ada perubahan" (tanpa build, deploy, commit, atau tag).
  4. `build.py --out <folder sementara>`: setiap sb*.md/bei*.md harus masuk kategori stockbit-*/bei-* yang benar dengan
     tanggal yang benar.
  5. `tools/publish_chat.py` (build site/, Worker, deploy, indeks chat, docs/). Kalau gagal setelah deploy,
     `tools/sync_chat_index.py` (dan build docs/) diulang sekali.
  6. `git add` hanya berkas Stockbit/BEI di atas plus hasil build yang masih dilacak Git; berhenti kalau ada berkas sb*/bei*
     terhapus, kecuali berkas hari yang ditahan desk dari web (entri withheld_by=desk di .stockbit-hold.json / .bei-hold.json
     yang ikut di-commit); commit "Stockbit: ringkasan <tanggal>" (atau "Stockbit: tahan <tanggal> dari web"; bagian
     "BEI: ringkasan <tanggal>" ditambahkan kalau ada berkas BEI), push (sekali `git pull --rebase` kalau ditolak), lalu tag
     beranotasi stockbit-publish-YYYYMMDD-HHMMSS dan push tag.
  7. Catatan ke .stockbit-publish/log.jsonl (dipakai tools/rollback_stockbit.py) dan satu baris JSON ringkasan di akhir.

Exit code:
  0 berhasil, tidak ada perubahan, atau dry-run lolos
  1 kesalahan tak terduga
  2 preflight gagal (tidak ada yang diubah)
  3 sinkron Stockbit/BEI gagal/ditolak (tidak ada yang ditulis atau di-deploy)
  4 cek build gagal: berkas sb*/bei* salah kategori/tanggal (tidak ada yang di-deploy)
  5 publish_chat.py gagal sebelum deploy (Worker tidak berubah, tidak ada commit)
  6 Worker sudah ter-deploy tetapi indeks chat/docs gagal setelah diulang (belum commit/push; bisa di-rollback)
  7 penjaga commit: ada berkas sb*/bei* yang akan terhapus tanpa tahanan desk (tidak di-commit)
  8 push gagal (commit lokal ada, Worker live; jalankan ulang atau push manual)
Semua perintah memakai daftar argumen, tanpa shell, dengan batas waktu.
"""
import argparse
from datetime import date, datetime, timedelta
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading

ROOT = Path(__file__).resolve().parents[1]
DEST_REL = "needtobeindexed/idx-signal-desk"
LOG = ROOT / ".stockbit-publish" / "log.jsonl"
WRANGLER = ["npx", "--yes", "wrangler@4.135.0"]
WRANGLER_CONFIG = ["--config", "worker/wrangler.jsonc"]
# Folder hasil build yang diizinkan; hanya folder yang masih dilacak Git boleh di-stage.
# main terbaru mengabaikan site/, sedangkan publikasi lama mungkin masih melacaknya.
DERIVED_PATHS = ("docs", "site")
# Di DEST_REL hanya berkas Stockbit/BEI ini (plus SB_FILE/BEI_FILE) yang boleh kotor dan di-commit; digest/kepemilikan tidak.
STOCKBIT_NAMES = ("stockbit-index.json", ".sync-stockbit.json", ".stockbit-hold.json")
HOLD_REL = f"{DEST_REL}/.stockbit-hold.json"
STATE_REL = f"{DEST_REL}/.sync-stockbit.json"
BEI_NAMES = ("bei-index.json", ".sync-bei.json", ".bei-hold.json")
BEI_HOLD_REL = f"{DEST_REL}/.bei-hold.json"
BEI_STATE_REL = f"{DEST_REL}/.sync-bei.json"
MIN_FREE_BYTES = 1_500_000_000
SB_FILE = re.compile(r"(?:^|/)(sbringkas|sbdetail|sbpekan)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.md$")
SB_CATEGORY = {"sbringkas": "stockbit-ringkasan", "sbdetail": "stockbit-detail", "sbpekan": "stockbit-pekan"}
BEI_FILE = re.compile(r"(?:^|/)(beiringkas|beidetail|beipekan)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.md$")
BEI_CATEGORY = {"beiringkas": "bei-ringkasan", "beidetail": "bei-detail", "beipekan": "bei-pekan"}
# Berkas harian/pekan kedua keluarga yang diterbitkan publish ini (sb* atau bei*).
PUB_FILE = re.compile(r"(?:^|/)(sbringkas|sbdetail|sbpekan|beiringkas|beidetail|beipekan)_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.md$")
PUB_CATEGORY = {**SB_CATEGORY, **BEI_CATEGORY}
WEEK_PREFIXES = ("sbpekan", "beipekan")
# Keluarga per awalan berkas, dan berkas tahanan/status tiap keluarga.
FAMILY = {prefix: "stockbit" for prefix in SB_CATEGORY} | {prefix: "bei" for prefix in BEI_CATEGORY}
HOLDS = {"stockbit": HOLD_REL, "bei": BEI_HOLD_REL}
BUILD_LINE = re.compile(r" -> files/([^/\s]+)/(\d{4}-\d{2}-\d{2})/(\S+)\s*$")
FAILED_COMMAND = re.compile(r"Command '(\[.*?\])' returned non-zero exit status")
DEPLOYED_ONLY = ("deployed_index_pending", "deployed_not_committed")
ROLLBACKABLE = ("published", "push_failed") + DEPLOYED_ONLY

T_GIT, T_NET, T_SYNC, T_BUILD, T_PUBLISH, T_INDEX = 60, 180, 900, 900, 3600, 1800


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def run_command(argv, timeout, env=None, tee=False):
    """Runner bawaan: argv tanpa shell, cwd = akar arsip, stdin kosong. Tidak melempar error untuk exit code bukan 0."""
    if not tee:
        return subprocess.run(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    # Perintah panjang (publish_chat) ditampilkan sambil berjalan, dan keluarannya tetap disimpan untuk dianalisis.
    proc = subprocess.Popen(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    expired = threading.Event()

    def kill():
        expired.set()
        proc.kill()
    timer = threading.Timer(timeout, kill)
    timer.start()
    lines = []
    try:
        for line in proc.stdout:
            sys.stdout.write(line)
            lines.append(line)
        code = proc.wait()
    finally:
        timer.cancel()
    if expired.is_set():
        raise subprocess.TimeoutExpired(argv, timeout, output="".join(lines))
    return subprocess.CompletedProcess(argv, code, "".join(lines), "")


def say(message):
    print(message, flush=True)


def output(result):
    return (result.stdout or "") + (result.stderr or "")


def git(runner, *args, timeout=T_GIT):
    return runner(["git", *args], timeout=timeout)


def git_ok(runner, *args, timeout=T_GIT, code=2, what=None):
    result = git(runner, *args, timeout=timeout)
    if result.returncode:
        raise Failure(code, f"{what or 'git ' + ' '.join(args)} gagal: {output(result).strip()[-400:]}")
    return result.stdout.strip()


def changed_paths(runner):
    """(kode status, path) dari `git status --porcelain -z`, termasuk berkas baru."""
    result = git(runner, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    if result.returncode:
        raise Failure(2, f"git status gagal: {output(result).strip()[-400:]}")
    raw = result.stdout or ""  # jangan di-strip: kolom status pertama bisa berupa spasi
    entries, parts, i = [], raw.split("\0"), 0
    while i < len(parts):
        item = parts[i]
        i += 1
        if len(item) < 4:
            continue
        code, path = item[:2], item[3:]
        entries.append((code, path))
        if code[0] in "RC":
            i += 1  # path asal rename/copy
    return entries


def inside(path, prefixes):
    return any(path == p or path.startswith(p.rstrip("/") + "/") for p in prefixes)


def stockbit_owned(path):
    """Berkas Stockbit langsung di DEST_REL: sb*.md, stockbit-index.json, .sync-stockbit.json, .stockbit-hold.json."""
    folder, _, name = path.rpartition("/")
    return folder == DEST_REL and (bool(SB_FILE.search(name)) or name in STOCKBIT_NAMES)


def bei_owned(path):
    """Berkas BEI langsung di DEST_REL: bei*.md, bei-index.json, .sync-bei.json, .bei-hold.json."""
    folder, _, name = path.rpartition("/")
    return folder == DEST_REL and (bool(BEI_FILE.search(name)) or name in BEI_NAMES)


def publish_owned(path):
    """Berkas yang boleh diubah dan di-commit publish ini (Stockbit atau BEI)."""
    return stockbit_owned(path) or bei_owned(path)


# Jenis dirty_kind yang dimiliki publish ini (boleh kotor, di-commit, dan di-revert rollback).
OWNED_KINDS = ("stockbit", "bei")


def dirty_kind(path):
    """derived (docs/, site/), stockbit, bei, ignored (berkas titik lain di DEST_REL: tidak ikut build), atau other."""
    if inside(path, DERIVED_PATHS):
        return "derived"
    if stockbit_owned(path):
        return "stockbit"
    if bei_owned(path):
        return "bei"
    folder, _, name = path.rpartition("/")
    if folder == DEST_REL and name.startswith("."):
        return "ignored"
    return "other"


def tracked_derived_paths(runner):
    """Keep legacy tracked site/ compatible without staging today's ignored local build."""
    tracked = git_ok(runner, "ls-files", "-z", "--", *DERIVED_PATHS).split("\0")
    return [folder for folder in DERIVED_PATHS if any(inside(path, (folder,)) for path in tracked if path)]


def stockbit_changes(runner):
    """Berkas Stockbit dan BEI yang berubah (nama lama dipertahankan untuk rollback_stockbit.py)."""
    return sorted(path for _, path in changed_paths(runner) if publish_owned(path))


def record_key(record):
    return record.get("tag") or record.get("started_at")


def load_records(log):
    records = []
    try:
        lines = log.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return records
    for line in lines:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if isinstance(row, dict):
            records.append(row)
    return records


def rolled_back_keys(records):
    """Publish yang sudah selesai di-rollback (termasuk deploy tanpa commit yang ikut ditutup oleh publish itu)."""
    done = set()
    for r in records:
        if r.get("type") == "rollback" and r.get("status") == "rolled_back":
            done.update(r.get("covers") or [r.get("tag")])
    return done


def unrolled_deploys(records):
    """Rantai publish terakhir yang sudah deploy tanpa commit dan belum di-rollback (paling lama dulu).

    Putaran berikutnya men-deploy ulang dan meng-commit sisa berkasnya, jadi rollback-nya harus kembali ke versi
    Worker sebelum rantai ini, bukan ke versi yang sudah memuat isi itu.
    """
    done, chain = rolled_back_keys(records), []
    for r in reversed(records):
        if r.get("type") != "publish":
            continue
        status = r.get("status")
        if status in DEPLOYED_ONLY:
            if record_key(r) in done:
                break
            chain.insert(0, r)
        elif status not in ("gagal", "tidak ada perubahan"):  # dua status ini tidak mengubah Worker
            break
    return chain


def desk_withheld_days(text):
    """Hari di isi .stockbit-hold.json yang ditahan desk dari web (withheld_by=desk). Isi rusak/kosong = tidak ada."""
    try:
        data = json.loads(text or "")
    except ValueError:
        return set()
    days = data.get("days") if isinstance(data, dict) else None
    out = set()
    for day, entry in (days.items() if isinstance(days, dict) else ()):
        if isinstance(entry, dict) and entry.get("withheld_by") == "desk" and re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            try:
                out.add(date.fromisoformat(day).isoformat())
            except ValueError:
                continue
    return out


def sb_file_days(path):
    """Hari yang dicakup berkas sb*/bei*: satu hari (ringkas/detail) atau hari-hari pekannya (pekan); kosong kalau tidak valid."""
    match = PUB_FILE.search(path)
    if not match:
        return set()
    try:
        start, end = date.fromisoformat(match[2]), date.fromisoformat(match[3])
    except ValueError:
        return set()
    span = (end - start).days
    if match[1] not in WEEK_PREFIXES:
        return {match[2]} if span == 0 else set()
    return {(start + timedelta(days=i)).isoformat() for i in range(span + 1)} if 0 <= span <= 6 else set()


def file_family(path):
    """'stockbit' (sb*), 'bei' (bei*), atau None."""
    match = PUB_FILE.search(path)
    return FAMILY[match[1]] if match else None


def withheld_deletion(path, withheld):
    """True kalau path berkas sb*/bei* yang mencakup hari yang ditahan desk (pekan: salah satu harinya).

    `withheld`: {"stockbit": hari, "bei": hari}; himpunan biasa = hari Stockbit (bentuk lama).
    Berlaku untuk sumbernya di DEST_REL dan untuk salinannya di hasil build (docs/, site/): publish_chat.py membangun ulang
    docs/ tanpa hari itu, jadi salinan files/stockbit-*/<tgl>/sb*.md (atau files/bei-*/…) ikut terhapus dan harus boleh di-commit.
    """
    if not (publish_owned(path) or inside(path, DERIVED_PATHS)):
        return False
    family = file_family(path)
    days = withheld.get(family, set()) if isinstance(withheld, dict) else (withheld if family == "stockbit" else set())
    return bool(sb_file_days(path) & days)


def withheld_removed(runner, withheld, family="stockbit"):
    """Hari yang ditahan desk yang berkas keluarga itu terhapus di pohon kerja (dicatat untuk rollback)."""
    days = withheld.get(family, set()) if isinstance(withheld, dict) else withheld
    return sorted({day for status, path in changed_paths(runner)
                   if "D" in status and file_family(path) == family and withheld_deletion(path, withheld)
                   for day in sb_file_days(path) & days})


def worktree_withheld():
    """Tahanan desk di .stockbit-hold.json / .bei-hold.json pohon kerja (ikut di-commit bersama penghapusannya)."""
    out = {}
    for family, rel in HOLDS.items():
        try:
            out[family] = desk_withheld_days((ROOT / rel).read_text(encoding="utf-8"))
        except OSError:
            out[family] = set()
    return out


def check_no_deleted_sb(runner, code):
    """sb*/bei* hanya boleh terhapus kalau harinya ditahan desk (withheld_by=desk); penghapusan lain menghentikan publish."""
    withheld = worktree_withheld()
    deleted = [path for status, path in changed_paths(runner)
               if "D" in status and PUB_FILE.search(path) and not withheld_deletion(path, withheld)]
    if deleted:
        raise Failure(code, "berkas Stockbit/BEI akan terhapus, publish dihentikan: " + ", ".join(deleted[:10]))


def preflight(runner, dry_run=False, which=shutil.which, disk_usage=shutil.disk_usage):
    for tool in ("git", "npx"):
        if not which(tool):
            raise Failure(2, f"'{tool}' tidak ditemukan di PATH; jalankan desk dari terminal (nvm) supaya {tool} terbaca.")
    branch = git_ok(runner, "rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main":
        raise Failure(2, f"cabang aktif '{branch}', bukan main.")
    if git(runner, "diff", "--cached", "--quiet").returncode:
        raise Failure(2, "ada perubahan yang sudah di-stage; selesaikan atau `git restore --staged` dulu.")
    outside = [path for _, path in changed_paths(runner) if dirty_kind(path) == "other"]
    if outside:
        raise Failure(2, "ada perubahan yang tidak boleh ikut publish Stockbit (hanya sb*.md, " + ", ".join(STOCKBIT_NAMES)
                      + ", bei*.md, " + ", ".join(BEI_NAMES)
                      + ", docs/, site/; commit atau kembalikan dulu): " + ", ".join(outside[:15]))
    check_no_deleted_sb(runner, 2)
    git_ok(runner, "fetch", "origin", "main", timeout=T_NET)
    ahead = int(git_ok(runner, "rev-list", "--count", "origin/main..HEAD") or 0)
    if ahead:
        raise Failure(2, f"ada {ahead} commit lokal yang belum dipush; publish tidak boleh ikut mendorongnya.")
    behind = int(git_ok(runner, "rev-list", "--count", "HEAD..origin/main") or 0)
    if behind:
        if dry_run:
            say(f"  tertinggal {behind} commit dari origin/main (dry-run: tidak di-pull)")
        else:
            git_ok(runner, "pull", "--ff-only", "origin", "main", timeout=T_NET, what="git pull --ff-only")
    free = disk_usage(ROOT).free
    if free < MIN_FREE_BYTES:
        raise Failure(2, f"ruang disk tinggal {free / 1e9:.2f} GB; perlu minimal {MIN_FREE_BYTES / 1e9:.1f} GB.")
    return {"branch": branch, "behind": behind}


def parse_worker_version(text):
    """ID versi Worker yang live dari JSON `deployments list` / `deployments status` / `versions list`; None kalau tidak jelas."""
    start = min([i for i in (text.find("["), text.find("{")) if i >= 0], default=-1)
    if start < 0:
        return None
    try:
        data, _ = json.JSONDecoder().raw_decode(text[start:])
    except ValueError:
        return None
    rows = data if isinstance(data, list) else [data]
    rows = [r for r in rows if isinstance(r, dict)]
    if not rows:
        return None

    def created(row):
        return str(row.get("created_on") or (row.get("metadata") or {}).get("created_on") or "")
    latest = max(rows, key=created) if any(created(r) for r in rows) else rows[-1]
    versions = latest.get("versions")
    if isinstance(versions, list):
        live = [v for v in versions if isinstance(v, dict) and v.get("version_id")]
        if not live:
            return None
        return str(max(live, key=lambda v: v.get("percentage") or 0)["version_id"])
    value = latest.get("id")  # versions list: versi terbaru = yang di-deploy `wrangler deploy`
    return str(value) if value else None


def worker_version(runner):
    for sub in (["deployments", "list"], ["versions", "list"]):
        try:
            result = runner(WRANGLER + sub + WRANGLER_CONFIG + ["--json"], timeout=T_NET)
        except (OSError, subprocess.TimeoutExpired):
            continue
        if result.returncode == 0:
            version = parse_worker_version(result.stdout or "")
            if version:
                return version
    return None


def check_build(stdout, sb_names):
    """Baris build.py → tabel (nama, kategori, tanggal). Gagal kalau ada sb*/bei* yang salah kategori/tanggal atau hilang."""
    rows, problems, seen = [], [], {}
    for line in stdout.splitlines():
        match = BUILD_LINE.search(line)
        if not match:
            continue
        category, start, name = match.groups()
        sb = PUB_FILE.search(name)
        if not sb:
            continue
        seen[name] = seen.get(name, 0) + 1
        expected = PUB_CATEGORY[sb[1]]
        rows.append((name, category, start))
        if category != expected:
            problems.append(f"{name}: kategori '{category}', seharusnya '{expected}'")
        if start != sb[2]:
            problems.append(f"{name}: tanggal {start}, seharusnya {sb[2]}")
    for name in sorted(sb_names):
        if seen.get(name) != 1:
            problems.append(f"{name}: {'tidak muncul' if name not in seen else 'muncul ganda'} di output build.py")
    if problems:
        raise Failure(4, "cek build gagal: " + "; ".join(problems[:15]))
    return rows


def build_check(runner, dest=None):
    dest = dest or ROOT / DEST_REL
    names = [p.name for p in [*dest.glob("sb*.md"), *dest.glob("bei*.md")] if PUB_FILE.search(p.name)] if dest.is_dir() else []
    folder = tempfile.mkdtemp(prefix="arsip-sbcheck-")
    try:
        result = runner([sys.executable, "-B", "build.py", "--out", str(Path(folder) / "site")], timeout=T_BUILD)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    if result.returncode:
        raise Failure(4, f"build.py gagal: {output(result).strip()[-600:]}")
    rows = check_build(result.stdout or "", names)
    say(f"  {'berkas':<34} {'kategori':<20} tanggal")
    for name, category, start in sorted(rows):
        say(f"  {name:<34} {category:<20} {start}")
    say(f"  {len(rows)} berkas Stockbit/BEI cocok kategori dan tanggal")
    return rows


def publish_env():
    """Lingkungan yang sama dengan tools/publish_chat.py untuk mengulang langkah setelah deploy."""
    env = dict(os.environ)
    env.pop("CHAT_API_URL", None)
    env["BASE_URL"] = "https://arsip.seekingomega.capital"
    return env


def failed_step(text):
    match = None
    for match in FAILED_COMMAND.finditer(text or ""):
        pass
    command = match[1] if match else ""
    if "sync_chat_index.py" in command:
        return "index"
    if "'--out', 'docs'" in command:
        return "docs"
    if "wrangler" in command:
        return "deploy"
    return "before-deploy" if command else "unknown"


def publish_chat(runner, worker_before):
    """Jalankan publish_chat.py. Kembalikan (deployed, ok). Gagal setelah deploy → ulangi indeks chat (dan docs/) sekali."""
    result = runner([sys.executable, "-B", "tools/publish_chat.py"], timeout=T_PUBLISH, tee=True)
    if result.returncode == 0:
        return True, True
    step = failed_step(output(result))
    now = worker_version(runner)
    deployed = step in ("index", "docs") or (bool(now and worker_before) and now != worker_before)
    if not deployed:
        return False, False
    env = publish_env()
    say("  publish_chat.py gagal setelah deploy; mengulang langkah setelahnya sekali")
    if step != "docs":
        if runner([sys.executable, "-B", "tools/sync_chat_index.py"], timeout=T_INDEX, env=env, tee=True).returncode:
            return True, False
    retry = runner([sys.executable, "-B", "build.py", "--out", "docs"], timeout=T_BUILD, env=env)
    return True, retry.returncode == 0


def _family_message(source, pattern, day_prefix, week_prefix, kept, removed):
    def label(days):
        return f"{days[0]} s/d {days[-1]} ({len(days)} hari)" if len(days) > 5 else ", ".join(days)
    removed = [n for n in removed if pattern.search(n)]
    days = sorted({m[2] for n in kept if (m := pattern.search(n)) and m[1] == day_prefix})
    weeks = sorted({f"{m[2]}..{m[3]}" for n in kept if (m := pattern.search(n)) and m[1] == week_prefix})
    held = sorted({m[2] for n in removed if (m := pattern.search(n)) and m[1] != week_prefix})
    held_weeks = sorted({f"{m[2]}..{m[3]}" for n in removed if (m := pattern.search(n)) and m[1] == week_prefix})
    withheld = f"tahan {label(held) if held else 'pekan ' + ', '.join(held_weeks)} dari web" if removed else ""
    if withheld and not days and not weeks:
        return f"{source}: {withheld}"
    return (f"{source}: ringkasan {label(days) or 'pembaruan indeks/situs'}" + (f" · pekan {', '.join(weeks)}" if weeks else "")
            + (f" · {withheld}" if withheld else ""))


def commit_message(names, removed=()):
    """`removed` = berkas sb*/bei* yang dihapus commit ini (hari yang ditahan desk dari web).

    Bagian "BEI: …" hanya ditulis kalau commit menyentuh berkas BEI; bagian Stockbit selalu ada kecuali commit hanya BEI.
    """
    removed = set(removed)
    kept = [n for n in names if n not in removed]
    base = lambda n: n.rsplit("/", 1)[-1]
    touches_sb = any(SB_FILE.search(n) or base(n) in STOCKBIT_NAMES for n in names)
    touches_bei = any(BEI_FILE.search(n) or base(n) in BEI_NAMES for n in names)
    parts = []
    if touches_sb or not touches_bei:
        parts.append(_family_message("Stockbit", SB_FILE, "sbringkas", "sbpekan", kept, removed))
    if touches_bei:
        parts.append(_family_message("BEI", BEI_FILE, "beiringkas", "beipekan", kept, removed))
    return " · ".join(parts)


def push(runner, refspec):
    if git(runner, "push", "origin", refspec, timeout=T_NET).returncode == 0:
        return True
    say("  push ditolak; git pull --rebase sekali lalu coba lagi")
    if git(runner, "pull", "--rebase", "origin", "main", timeout=T_NET).returncode:
        git(runner, "rebase", "--abort")
        return False
    return git(runner, "push", "origin", refspec, timeout=T_NET).returncode == 0


def append_log(record, log=None):
    log = log or LOG
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def publish(args, runner=run_command, which=shutil.which, disk_usage=shutil.disk_usage, log=None, clock=datetime.now):
    stamp = clock().strftime("%Y%m%d-%H%M%S")
    # "supports": penanda kemampuan untuk desk (skrip lama tanpa BEI tidak menyebut "bei").
    summary = {"status": "dimulai", "dry_run": bool(args.dry_run), "started_at": now_iso(), "supports": ["stockbit", "bei"]}
    record = {"type": "publish", "tag": None, "start_sha": None, "pre_sha": None, "post_sha": None,
              "worker_version_before": None, "worker_version_after": None, "files": [], "started_at": summary["started_at"]}
    deployed = False
    try:
        say("1/6 preflight")
        preflight(runner, args.dry_run, which, disk_usage)
        record["start_sha"] = git_ok(runner, "rev-parse", "HEAD")
        if not args.dry_run:
            record["worker_version_before"] = worker_version(runner)
            if not record["worker_version_before"]:
                say("  peringatan: versi Worker live tidak terbaca; rollback Worker nanti harus manual")
            chain = unrolled_deploys(load_records(log or LOG))
            if chain:
                first = chain[0]
                record["supersedes"] = [record_key(r) for r in chain]
                record["rollback_to"] = first["rollback_to"] if "rollback_to" in first else first.get("worker_version_before")
                say(f"  publish sebelumnya sudah deploy tanpa commit; rollback Worker nanti ke {record['rollback_to'] or '(tidak tercatat)'}")
        say("2/6 sinkron Stockbit + BEI")
        # Satu staging untuk keduanya; BEI yang ditolak dikembalikan utuh dan dilewati, Stockbit tetap terbit.
        result = runner([sys.executable, "-B", "tools/sync_idx.py", "--stockbit-only", "--no-build", "--with-bei"], timeout=T_SYNC)
        say(output(result).rstrip())
        if result.returncode:
            raise Failure(3, f"sync_idx.py --stockbit-only --with-bei keluar dengan kode {result.returncode}")
        # BEI dilewati (desk tanpa /api/bei, ekspor dari profil desk lain, atau ekspor BEI ditolak) tidak menggagalkan Stockbit, tetapi
        # dilaporkan supaya job BEI di desk tidak menganggap BEI sudah terbit.
        skipped = [line.strip() for line in output(result).splitlines() if "BEI dilewati" in line]
        if skipped:
            summary["bei_skipped"] = skipped[0][:500]
        check_no_deleted_sb(runner, 7)
        # Dicatat sebelum deploy: rollback_stockbit.py menolak membatalkan publish yang mencabut hari yang ditahan desk.
        holds = worktree_withheld()
        withheld = withheld_removed(runner, holds, "stockbit")
        if withheld:
            record["withheld"] = summary["withheld"] = withheld
        withheld_bei = withheld_removed(runner, holds, "bei")
        if withheld_bei:
            record["withheld_bei"] = summary["withheld_bei"] = withheld_bei
        changes = stockbit_changes(runner)
        record["files"] = sorted(p.rsplit("/", 1)[-1] for p in changes)
        if not changes:
            # Tanpa ini setiap klik men-deploy ulang Worker dan meng-commit docs/ dan site/ dengan BUILD_ID baru.
            record["status"] = summary["status"] = "tidak ada perubahan"
            say("tidak ada perubahan Stockbit/BEI; tidak ada build, deploy, atau commit")
            return 0, summary
        say("3/6 cek build (folder sementara)")
        summary["checked"] = len(build_check(runner))
        if args.dry_run:
            summary["status"] = "dry-run"
            return 0, summary
        say("4/6 publish_chat.py")
        deployed, ok = publish_chat(runner, record["worker_version_before"])
        if not deployed:
            raise Failure(5, "publish_chat.py gagal sebelum deploy; Worker tidak berubah")
        if not ok:
            record["status"] = "deployed_index_pending"
            raise Failure(6, "Worker sudah ter-deploy tetapi indeks chat/docs belum selesai; belum di-commit")
        say("5/6 commit")
        paths = [*stockbit_changes(runner), *tracked_derived_paths(runner)]
        git_ok(runner, "add", "--", *paths, code=7)
        removed = [n for n in git_ok(runner, "diff", "--cached", "--diff-filter=D", "--name-only", code=7).splitlines() if PUB_FILE.search(n)]
        # Penghapusan sb*/bei* hanya untuk hari yang ditahan desk menurut berkas tahanan yang di-stage (yang ikut di-commit).
        withheld = {}
        for family, rel in HOLDS.items():
            staged_hold = git(runner, "show", f":{rel}") if any(file_family(n) == family for n in removed) else None
            withheld[family] = desk_withheld_days(staged_hold.stdout if staged_hold and staged_hold.returncode == 0 else "")
        deleted = [n for n in removed if not withheld_deletion(n, withheld)]
        if deleted:
            git(runner, "reset", "-q", "--", *paths)
            raise Failure(7, "berkas Stockbit/BEI akan terhapus, tidak di-commit: " + ", ".join(deleted[:10]))
        if git(runner, "diff", "--cached", "--quiet").returncode == 0:
            record["status"] = summary["status"] = "tidak ada perubahan"
            record["worker_version_after"] = worker_version(runner)
            say("tidak ada perubahan")
            return 0, summary
        names = git_ok(runner, "diff", "--cached", "--name-only", code=7).splitlines()
        record["files"] = sorted(n.rsplit("/", 1)[-1] for n in names
                                 if PUB_FILE.search(n) or n.endswith(("stockbit-index.json", "bei-index.json")))
        message = commit_message(names, removed)
        git_ok(runner, "commit", "-q", "-m", message, "--", *paths, code=7, what="git commit")
        record["post_sha"] = git_ok(runner, "rev-parse", "HEAD")
        say("6/6 push")
        if not push(runner, "HEAD:main"):
            record["status"] = "push_failed"
            record["pre_sha"] = git_ok(runner, "rev-parse", "HEAD^", code=8)
            raise Failure(8, "push gagal; commit ada di lokal dan Worker sudah live")
        # Setelah `pull --rebase` commit bisa berganti: rentang rollback = tepat satu commit publish ini.
        record["post_sha"] = git_ok(runner, "rev-parse", "HEAD", code=8)
        record["pre_sha"] = git_ok(runner, "rev-parse", "HEAD^", code=8)
        tag = f"stockbit-publish-{stamp}"
        git_ok(runner, "tag", "-a", tag, "-m", message, record["post_sha"], code=8, what="git tag")
        record["tag"] = tag
        if git(runner, "push", "origin", f"refs/tags/{tag}", timeout=T_NET).returncode:
            say(f"  peringatan: tag {tag} gagal dipush; commit sudah live (push tag manual: git push origin {tag})")
            summary["tag_pushed"] = False
        record["worker_version_after"] = worker_version(runner)
        record["status"] = summary["status"] = "published"
        summary.update(tag=tag, commit=record["post_sha"], message=message)
        return 0, summary
    except Failure as e:
        summary.update(status="gagal", error=str(e))
        if "status" not in record:
            record["status"] = "deployed_not_committed" if deployed else "gagal"
        if deployed and not record["worker_version_after"]:
            record["worker_version_after"] = worker_version(runner)  # rollback memeriksa versi live = versi ini
        say(f"GAGAL: {e}")
        return e.code, summary
    except subprocess.TimeoutExpired as e:
        summary.update(status="gagal", error=f"batas waktu habis: {' '.join(map(str, e.cmd))[:200]}")
        before = record["worker_version_before"]
        if not args.dry_run and (deployed or before):
            now = worker_version(runner)
            deployed = deployed or (bool(before) and now not in (None, before))
            if deployed:
                record["worker_version_after"] = now
        if "status" not in record:
            record["status"] = "deployed_not_committed" if deployed else "gagal"
        say(f"GAGAL: {summary['error']}")
        return (6 if deployed else 1), summary
    finally:
        if not args.dry_run and record.get("start_sha"):
            record.setdefault("status", "gagal")
            record["finished_at"] = now_iso()
            summary.setdefault("log_status", record["status"])
            try:
                append_log(record, log)
            except OSError as e:
                say(f"  peringatan: log rollback tidak tertulis: {e}")
        summary["finished_at"] = now_iso()


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="preflight + sinkron + cek build saja")
    args = ap.parse_args(argv)
    try:
        code, summary = publish(args)
    except Exception as e:  # tetap keluarkan satu baris JSON untuk desk
        code, summary = 1, {"status": "gagal", "error": f"{type(e).__name__}: {e}"}
    summary["exit"] = code
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
