#!/usr/bin/env python3
"""Terbitkan ringkasan Stockbit dan keterbukaan BEI sekali klik (dijalankan desk dengan cwd = akar arsip), dan bisa di-rollback.

    python3 -B tools/publish_stockbit.py             # preflight, sinkron, cek build, docs/, push VPS, commit+tag, push git
    python3 -B tools/publish_stockbit.py --dry-run   # preflight + sinkron + cek build saja (tanpa VPS/commit/push)

Situs live = VPS Jakarta (`node local/vps.mjs push`); GitHub hanya riwayat (docs/ ikut di-commit).

Urutan:
  1. Preflight: git dan node ada, .local/vps.json ada, cabang main, tidak ada yang di-stage, tidak ada perubahan selain
     berkas Stockbit/BEI di needtobeindexed/idx-signal-desk/ (sb*.md, stockbit-index.json, .sync-stockbit.json,
     .stockbit-hold.json, bei*.md, bei-index.json, .sync-bei.json, .bei-hold.json; berkas titik lain seperti .sync.json
     dibiarkan karena tidak ikut build) dan docs/ (hasil build yang dilacak git). digest_*/kepemilikan* yang belum di-commit menolak publish: push VPS akan ikut
     mengirimnya dan rollback Stockbit akan ikut membatalkannya. Lalu tidak ada commit lokal yang belum dipush,
     `git fetch` + `git pull --ff-only` kalau tertinggal origin/main, ruang disk >= 1,5 GB.
  2. Catat HEAD. Kalau publish sebelumnya sudah memperbarui VPS tanpa commit (vps_not_committed, belum di-rollback),
     berkasnya ikut di-commit publish ini (`supersedes`; rollback publish ini ikut menutupnya).
  3. `tools/sync_idx.py --stockbit-only --no-build --with-bei` (+ `--stockbit-since <tgl>` dan `--allow-provisional`
     kalau diberikan; yang kedua ikut menerbitkan hari 'sementara', mis. hari ini yang belum tutup): Stockbit dan
     BEI dalam SATU staging; BEI yang ditolak (atau HTTP error BEI, ekspor dari profil desk lain, desk tanpa /api/bei)
     dikembalikan utuh dan dilewati ("BEI dilewati" -> `bei_skipped` di ringkasan), Stockbit tetap terbit. Kalau tidak ada
     berkas Stockbit/BEI yang berubah terhadap HEAD: selesai, "tidak ada perubahan" (tanpa build, VPS, commit, atau tag).
     Berkas dari putaran yang gagal sebelumnya masih berubah terhadap HEAD, jadi putaran ulang tetap menerbitkannya.
  4. `build.py --out <folder sementara>`: setiap sb*.md/bei*.md harus masuk kategori stockbit-*/bei-* yang benar dengan
     tanggal yang benar. Lalu `build.py --out docs` (tanpa CHAT_API_URL, BASE_URL=https://arsip.seekingomega.capital) untuk
     riwayat git, dan penjaga sb*/bei* terhapus diulang pada docs/ hasil build (gagal: docs/ dikembalikan, VPS tidak
     disentuh, exit 7).
  5. `node local/vps.mjs push` SEBELUM commit: build di VPS selagi versi lama melayani, tukar, restart. Kalau gagal,
     vps.mjs sendiri memulihkan versi sebelumnya; tidak ada commit, dan putaran ulang mengulang dari awal.
  6. `git add` hanya berkas Stockbit/BEI di atas plus hasil build yang masih dilacak Git; berhenti kalau ada berkas sb*/bei*
     terhapus, kecuali berkas hari yang ditahan desk dari web (entri withheld_by=desk di .stockbit-hold.json /
     .bei-hold.json yang ikut di-commit); commit "Stockbit: ringkasan <tanggal>" (atau "Stockbit: tahan <tanggal> dari
     web"; bagian "BEI: ringkasan <tanggal>" ditambahkan kalau ada berkas BEI), push (sekali `git pull --rebase` kalau
     ditolak), lalu tag beranotasi stockbit-publish-YYYYMMDD-HHMMSS dan push tag. Langkah commit yang gagal sebelum
     commit terjadi melepas kembali berkas yang sudah di-stage (`git reset -q -- <berkas>`), jadi putaran ulang dan rollback
     tidak tertahan oleh index.
  7. Catatan ke .stockbit-publish/log.jsonl ("target": "vps"; dipakai tools/rollback_stockbit.py; "day_shas" = {tgl: sha256
     ekspor} hari harian Stockbit yang dikirim putaran ini, "day_shas_bei" sama untuk BEI, keduanya dibaca sebelum push VPS;
     "withheld"/"withheld_bei" = hari yang ditahan desk yang dicabut putaran ini) dan satu baris JSON ringkasan di akhir
     ("vps": true kalau VPS sudah diperbarui; "supports": ["stockbit", "bei"]; "bei_skipped" kalau BEI dilewati).

Exit code:
  0 berhasil, tidak ada perubahan, atau dry-run lolos
  1 kesalahan tak terduga (termasuk batas waktu sebelum push VPS; VPS tidak berubah)
  2 preflight gagal (tidak ada yang diubah)
  3 sinkron Stockbit/BEI gagal/ditolak (VPS tidak berubah; BEI yang ditolak sendiri tidak menggagalkan, lihat langkah 3)
  4 cek build atau build docs/ gagal, mis. berkas sb*/bei* salah kategori/tanggal (VPS tidak berubah)
  5 push VPS gagal atau sisa waktu tidak cukup: situs tetap versi sebelumnya (kecuali batas waktu di tengah push: periksa
    `node local/vps.mjs status`), tidak ada commit (jalankan ulang)
  6 VPS sudah diperbarui tetapi commit gagal (tidak ada commit, berkas di-unstage): situs mendahului git (vps_not_committed;
    jalankan ulang atau rollback)
  7 penjaga sb*/bei*: ada berkas sb*/bei* yang akan terhapus tanpa tahanan desk (ditemukan sebelum push VPS: VPS tidak berubah, status
    gagal; ditemukan di index setelahnya: VPS sudah diperbarui, vps_not_committed). Tidak di-commit.
  8 commit lokal ada tetapi push git gagal (push_failed; VPS sudah live). Publish ulang ditolak preflight selama commit itu belum
    dipush: push manual `git push origin HEAD:main` (boleh setelah `git pull --rebase`: rollback mengenali salinannya lewat
    subjek + patch-id), atau batalkan dengan tools/rollback_stockbit.py. Juga: push sudah berhasil
    tetapi tag gagal dibuat (status published; buat tag manual atau biarkan, rollback tanpa --tag tetap memilihnya).
Semua perintah memakai daftar argumen, tanpa shell, dengan batas waktu per langkah dan batas waktu total (BUDGET di bawah
batas desk, supaya penanganan batas waktu skrip ini sendiri yang berjalan, bukan SIGKILL dari desk).
"""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

import desk_files as desk

ROOT = Path(__file__).resolve().parents[1]
LOG = ROOT / ".stockbit-publish" / "log.jsonl"
VPS_PUSH = ["node", "local/vps.mjs", "push"]
VPS_CONFIG_REL = ".local/vps.json"
TARGET = "vps"
# Folder hasil build yang dilacak Git (riwayat situs); site/ diabaikan Git.
DERIVED_PATHS = ("docs",)
MIN_FREE_BYTES = 1_500_000_000
BUILD_LINE = re.compile(r" -> files/([^/\s]+)/(\d{4}-\d{2}-\d{2})/(\S+)\s*$")
# Situs sudah diperbarui tetapi belum ada commit.
UNCOMMITTED = ("vps_not_committed",)
ROLLBACKABLE = ("published", "push_failed") + UNCOMMITTED

T_GIT, T_NET, T_SYNC, T_BUILD, T_VPS = 60, 180, 1800, 900, 1800
# Desk (idx_digest/stockbit_jobs.py) membunuh skrip setelah PUBLISH_TIMEOUT_SECONDS = 3600 / ROLLBACK_TIMEOUT_SECONDS = 1800.
# Anggaran total di bawahnya; sisanya untuk membersihkan (unstage), mencatat log, dan menulis ringkasan JSON.
PUBLISH_BUDGET, ROLLBACK_BUDGET = 3600 - 180, 1800 - 120
POST_VPS_RESERVE = 600  # publish: commit + push (+ pull --rebase + push) + tag setelah push VPS
MIN_VPS_SECONDS = 300   # push VPS tidak dimulai kalau sisa waktunya kurang dari ini


class Failure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def kill_group(proc):
    """SIGKILL ke seluruh grup proses (node vps.mjs beserta ssh/tar anaknya), bukan hanya proses pertama."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def run_command(argv, timeout, env=None, tee=False):
    """Runner bawaan: argv tanpa shell, cwd = akar arsip, stdin kosong. Tidak melempar error untuk exit code bukan 0."""
    if not tee:
        return subprocess.run(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    # Perintah panjang (push VPS) ditampilkan sambil berjalan, dan keluarannya tetap disimpan untuk dianalisis.
    # Grup proses sendiri: saat batas waktu (atau skrip ini berhenti di tengah), node dan ssh di bawahnya ikut dimatikan.
    proc = subprocess.Popen(argv, cwd=ROOT, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1, start_new_session=True)
    expired = threading.Event()

    def kill():
        expired.set()
        kill_group(proc)
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
        if proc.poll() is None:  # pengecualian/sinyal di skrip ini selagi perintah masih jalan
            kill_group(proc)
            proc.wait()
    if expired.is_set():
        raise subprocess.TimeoutExpired(argv, timeout, output="".join(lines))
    return subprocess.CompletedProcess(argv, code, "".join(lines), "")


class Budget:
    """Batas waktu total: setiap perintah mendapat min(batas langkahnya, sisa anggaran); habis = TimeoutExpired tanpa menjalankan."""

    def __init__(self, seconds, clock=time.monotonic):
        self.clock, self.end = clock, clock() + seconds

    def left(self):
        return self.end - self.clock()

    def wrap(self, runner):
        def run(argv, timeout, **kwargs):
            left = self.left()
            if left < 1:
                raise subprocess.TimeoutExpired(argv, 0)
            return runner(argv, timeout=min(timeout, left), **kwargs)
        return run


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


def rel(name):
    """Path berkas desk di folder sinkron, relatif terhadap akar arsip (seperti git menulisnya)."""
    return f"{desk.FOLDER}/{name}"


HOLDS = tuple(rel(fam.hold) for fam in desk.FAMILIES)


def owner(path):
    """Keluarga (Stockbit/BEI) yang memiliki berkas langsung di folder sinkron, atau None. Hanya berkas ini yang boleh kotor
    dan di-commit di folder itu; digest/kepemilikan tidak."""
    folder, _, name = path.rpartition("/")
    return desk.family_of(name) if folder == desk.FOLDER else None


def publish_owned(path):
    return owner(path) is not None


# Jenis dirty_kind yang dimiliki publish ini (boleh kotor, di-commit, dan di-revert rollback).
OWNED_KINDS = tuple(fam.key for fam in desk.FAMILIES)


def dirty_kind(path):
    """derived (docs/), stockbit, bei, ignored (berkas titik lain di folder sinkron: tidak ikut build), atau other."""
    if inside(path, DERIVED_PATHS):
        return "derived"
    fam = owner(path)
    if fam:
        return fam.key
    folder, _, name = path.rpartition("/")
    if folder == desk.FOLDER and name.startswith("."):
        return "ignored"
    return "other"


def stockbit_changes(runner):
    """Berkas Stockbit dan BEI yang berubah (nama lama dipertahankan untuk rollback_stockbit.py)."""
    return sorted(path for _, path in changed_paths(runner) if publish_owned(path))


def state_day_shas(names, state_text, fam=desk.STOCKBIT):
    """{tgl: sha256 ekspor desk} untuk berkas harian keluarga itu (sb*: .sync-stockbit.json, bei*: .sync-bei.json) di
    `names` menurut isi berkas status sinkronnya; "*" kalau tidak diketahui.

    Rekap pekan (sbpekan/beipekan) tidak dihitung: ikut tertahan karena salah satu harinya tidak lagi eligible.
    """
    try:
        days = json.loads(state_text or "").get("days") or {}
    except (ValueError, AttributeError):
        days = {}
    out = {}
    for name in names:
        found = desk.parse(name)
        if not found or found.family != fam or found.kind == "pekan":
            continue
        entry = days.get(found.start) if isinstance(days, dict) else None
        fp = entry.get("fp") if isinstance(entry, dict) else None
        sha = str(fp).split("|", 1)[0] if fp else ""
        out[found.start] = sha if sha and sha != "None" else "*"
    return out


def worktree_day_shas(names, fam):
    """state_day_shas dari berkas status sinkron keluarga itu di pohon kerja (yang dibangun dan dikirim ke VPS putaran ini)."""
    try:
        text = (ROOT / rel(fam.state)).read_text(encoding="utf-8")
    except OSError:
        text = ""
    return state_day_shas(names, text, fam)


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


def unrolled_uncommitted(records):
    """Rantai publish terakhir yang sudah memperbarui situs tanpa commit dan belum di-rollback (paling lama dulu).

    Berkasnya masih berubah terhadap HEAD, jadi putaran berikutnya meng-commit-nya; rollback putaran itu ikut menutup
    rantai ini (`supersedes`).
    """
    done, chain = rolled_back_keys(records), []
    for r in reversed(records):
        if r.get("type") != "publish":
            continue
        status = r.get("status")
        if status in UNCOMMITTED:
            if record_key(r) in done:
                break
            chain.insert(0, r)
        elif status not in ("gagal", "tidak ada perubahan", "vps_failed"):  # tiga status ini tidak mengubah situs
            break
    return chain


def desk_withheld_days(text):
    """Hari di isi berkas tahanan yang ditahan desk dari web (withheld_by=desk). Isi rusak/kosong = tidak ada."""
    try:
        return desk.desk_held(desk.parse_hold(text or ""))
    except ValueError:
        return set()


def withheld_days(path, withheld):
    """Hari yang ditahan desk yang dicakup berkas sb*/bei* ini (pekan: hari-harinya yang ditahan).

    `withheld`: {"stockbit": hari, "bei": hari}. Tahanan satu keluarga tidak pernah mencakup berkas keluarga lain.
    """
    found = desk.parse(path)
    return found.days() & withheld.get(found.family.key, set()) if found else set()


def withheld_deletion(path, withheld):
    """True kalau path berkas sb*/bei* yang mencakup hari yang ditahan desk (lihat withheld_days).

    Berlaku untuk sumbernya di folder sinkron dan untuk salinannya di hasil build (docs/): `build.py --out docs` membangun
    ulang docs/ tanpa hari itu, jadi salinan files/stockbit-*/<tgl>/sb*.md (atau files/bei-*/…/bei*.md) ikut terhapus dan
    harus boleh di-commit.
    """
    return (publish_owned(path) or inside(path, DERIVED_PATHS)) and bool(withheld_days(path, withheld))


def withheld_removed(runner, withheld, fam):
    """Hari yang ditahan desk yang berkas keluarga itu terhapus di pohon kerja (dicatat untuk rollback)."""
    return sorted({day for status, path in changed_paths(runner)
                   if "D" in status and desk.family_of(path) == fam and withheld_deletion(path, withheld)
                   for day in withheld_days(path, withheld)})


def worktree_withheld():
    """Tahanan desk di .stockbit-hold.json / .bei-hold.json pohon kerja (ikut di-commit bersama penghapusannya)."""
    out = {}
    for fam in desk.FAMILIES:
        try:
            out[fam.key] = desk_withheld_days((ROOT / rel(fam.hold)).read_text(encoding="utf-8"))
        except OSError:
            out[fam.key] = set()
    return out


def check_no_deleted_sb(runner, code):
    """sb*/bei* hanya boleh terhapus kalau harinya ditahan desk (withheld_by=desk); penghapusan lain menghentikan publish."""
    withheld = worktree_withheld()
    deleted = [path for status, path in changed_paths(runner)
               if "D" in status and desk.parse(path) and not withheld_deletion(path, withheld)]
    if deleted:
        raise Failure(code, "berkas Stockbit/BEI akan terhapus, publish dihentikan: " + ", ".join(deleted[:10]))


def discard_derived(runner, code):
    """docs/ hanya hasil build (build.py menghapus dan membangun ulang folder itu): kembalikan ke HEAD."""
    git_ok(runner, "checkout", "--", *DERIVED_PATHS, code=code, what="git checkout hasil build terlacak")
    git_ok(runner, "clean", "-fdq", "--", *DERIVED_PATHS, code=code, what="git clean hasil build terlacak")


def check_tools(which=shutil.which):
    """git dan node di PATH, dan konfigurasi VPS (.local/vps.json dari `node local/vps.mjs setup`)."""
    for tool in ("git", "node"):
        if not which(tool):
            raise Failure(2, f"'{tool}' tidak ditemukan di PATH; jalankan desk dari terminal (nvm) supaya {tool} terbaca.")
    if not (ROOT / VPS_CONFIG_REL).is_file():
        raise Failure(2, f"{VPS_CONFIG_REL} tidak ada; VPS belum di-setup di Mac ini (node local/vps.mjs setup …).")


def preflight(runner, dry_run=False, which=shutil.which, disk_usage=shutil.disk_usage):
    check_tools(which)
    branch = git_ok(runner, "rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main":
        raise Failure(2, f"cabang aktif '{branch}', bukan main.")
    if git(runner, "diff", "--cached", "--quiet").returncode:
        raise Failure(2, "ada perubahan yang sudah di-stage; selesaikan atau `git restore --staged` dulu.")
    outside = [path for _, path in changed_paths(runner) if dirty_kind(path) == "other"]
    if outside:
        allowed = ", ".join(f"{fam.prefix}*.md, " + ", ".join(fam.names) for fam in desk.FAMILIES)
        raise Failure(2, f"ada perubahan yang tidak boleh ikut publish Stockbit (hanya {allowed}, docs/; commit atau kembalikan "
                         "dulu): " + ", ".join(outside[:15]))
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


def check_build(stdout, sb_names):
    """Baris build.py → tabel (nama, kategori, tanggal). Gagal kalau ada sb*/bei* yang salah kategori/tanggal atau hilang."""
    rows, problems, seen = [], [], {}
    for line in stdout.splitlines():
        match = BUILD_LINE.search(line)
        if not match:
            continue
        category, start, name = match.groups()
        found = desk.parse(name)
        if not found:
            continue
        seen[name] = seen.get(name, 0) + 1
        rows.append((name, category, start))
        if category != found.category:
            problems.append(f"{name}: kategori '{category}', seharusnya '{found.category}'")
        if start != found.start:
            problems.append(f"{name}: tanggal {start}, seharusnya {found.start}")
    for name in sorted(sb_names):
        if seen.get(name) != 1:
            problems.append(f"{name}: {'tidak muncul' if name not in seen else 'muncul ganda'} di output build.py")
    if problems:
        raise Failure(4, "cek build gagal: " + "; ".join(problems[:15]))
    return rows


def build_check(runner, dest=None):
    dest = dest or ROOT / desk.FOLDER
    names = [p.name for p in dest.glob("*.md") if desk.parse(p.name)] if dest.is_dir() else []
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
    """Lingkungan build docs/: tanpa CHAT_API_URL lokal (bawaan /api/chat), BASE_URL domain situs."""
    env = dict(os.environ)
    env.pop("CHAT_API_URL", None)
    env["BASE_URL"] = "https://arsip.seekingomega.capital"
    return env


def build_docs(runner):
    """Bangun ulang docs/ untuk riwayat git."""
    result = runner([sys.executable, "-B", "build.py", "--out", "docs"], timeout=T_BUILD, env=publish_env())
    if result.returncode:
        raise Failure(4, f"build.py --out docs gagal: {output(result).strip()[-600:]}")


def vps_push(runner, timeout=T_VPS):
    """`node local/vps.mjs push` (keluaran ditampilkan). True kalau versi baru live.

    vps.mjs memulihkan versi sebelumnya sendiri kalau build/tukar/restart gagal. Kalau server baru sudah jalan dan hanya
    pembersihan app.old yang gagal, situs sudah versi baru: dihitung berhasil (dengan peringatan).
    """
    try:
        result = runner(VPS_PUSH, timeout=timeout, tee=True)
    except subprocess.TimeoutExpired:
        raise Failure(5, f"push VPS melewati batas {int(timeout) // 60} menit dan dihentikan; status situs tidak pasti "
                         "(periksa: node local/vps.mjs status). Tidak ada commit.")
    if result.returncode == 0:
        return True
    text = output(result)
    if "Server berjalan." in text and "Mengembalikan versi sebelumnya" not in text:
        say("  peringatan: server baru di VPS sudah berjalan, tetapi langkah akhir vps.mjs gagal (pembersihan)")
        return True
    return False


def _family_message(fam, kept, removed):
    def label(days):
        return f"{days[0]} s/d {days[-1]} ({len(days)} hari)" if len(days) > 5 else ", ".join(days)

    def files(names):
        return [f for f in map(desk.parse, names) if f and f.family == fam]
    kept, removed = files(kept), files(removed)
    days = sorted({f.start for f in kept if f.kind == "ringkas"})
    weeks = sorted({f"{f.start}..{f.end}" for f in kept if f.kind == "pekan"})
    held = sorted({f.start for f in removed if f.kind != "pekan"})
    held_weeks = sorted({f"{f.start}..{f.end}" for f in removed if f.kind == "pekan"})
    withheld = f"tahan {label(held) if held else 'pekan ' + ', '.join(held_weeks)} dari web" if removed else ""
    if withheld and not days and not weeks:
        return f"{fam.label}: {withheld}"
    return (f"{fam.label}: ringkasan {label(days) or 'pembaruan indeks/situs'}" + (f" · pekan {', '.join(weeks)}" if weeks else "")
            + (f" · {withheld}" if withheld else ""))


def commit_message(names, removed=()):
    """`removed` = berkas sb*/bei* yang dihapus commit ini (hari yang ditahan desk dari web).

    Bagian "BEI: …" hanya ditulis kalau commit menyentuh berkas BEI; bagian Stockbit selalu ada kecuali commit hanya BEI.
    Subjek ini juga dipakai rollback_stockbit.py untuk mengenali salinan hasil rebase (subjek + patch-id).
    """
    removed = set(removed)
    kept = [n for n in names if n not in removed]
    touched = {desk.family_of(n) for n in names}
    families = [fam for fam in desk.FAMILIES if fam in touched] or [desk.STOCKBIT]
    return " · ".join(_family_message(fam, kept, removed) for fam in families)


def git_within(runner, *args, timeout=T_NET):
    """Exit code, atau None kalau batas waktu habis (dihitung gagal)."""
    try:
        return git(runner, *args, timeout=timeout).returncode
    except subprocess.TimeoutExpired:
        return None


def push(runner, refspec):
    """True kalau push berhasil. Penolakan, galat, dan batas waktu = False (push yang terputus mungkin tetap sampai;
    rollback memeriksa origin/main sebelum memilih reset atau revert)."""
    if git_within(runner, "push", "origin", refspec) == 0:
        return True
    say("  push ditolak/gagal; git pull --rebase sekali lalu coba lagi")
    if git_within(runner, "pull", "--rebase", "origin", "main") != 0:
        git_within(runner, "rebase", "--abort", timeout=T_GIT)
        return False
    return git_within(runner, "push", "origin", refspec) == 0


def unstage(runner, paths):
    """Lepas berkas yang sudah di-stage kalau commit tidak terjadi; pohon kerja tetap (putaran ulang/rollback memakainya)."""
    if git_within(runner, "reset", "-q", "--", *paths, timeout=T_GIT) != 0:
        say("  peringatan: berkas yang di-stage tidak bisa dilepas; jalankan `git restore --staged .` sebelum publish/rollback")


def append_log(record, log=None):
    log = log or LOG
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def publish(args, runner=run_command, which=shutil.which, disk_usage=shutil.disk_usage, log=None, clock=datetime.now,
            budget=None):
    budget = budget or Budget(PUBLISH_BUDGET)
    raw, runner = runner, budget.wrap(runner)  # raw: hanya untuk membersihkan setelah anggaran habis (di dalam sisa batas desk)
    stamp = clock().strftime("%Y%m%d-%H%M%S")
    # "supports": penanda kemampuan untuk desk (skrip lama tanpa BEI tidak menyebut "bei").
    summary = {"status": "dimulai", "dry_run": bool(args.dry_run), "started_at": now_iso(), "vps": False,
               "supports": ["stockbit", "bei"]}
    record = {"type": "publish", "target": TARGET, "tag": None, "start_sha": None, "pre_sha": None, "post_sha": None,
              "vps": False, "files": [], "started_at": summary["started_at"]}
    staged = None  # berkas yang sudah (mungkin) di-stage dan belum ter-commit
    try:
        say("1/6 preflight")
        preflight(runner, args.dry_run, which, disk_usage)
        record["start_sha"] = git_ok(runner, "rev-parse", "HEAD")
        if not args.dry_run:
            chain = unrolled_uncommitted(load_records(log or LOG))
            if chain:
                record["supersedes"] = [record_key(r) for r in chain]
                say(f"  publish sebelumnya sudah memperbarui situs tanpa commit ({', '.join(map(str, record['supersedes']))}); "
                    "berkasnya ikut di-commit sekarang")
        say("2/6 sinkron Stockbit + BEI")
        since = getattr(args, "stockbit_since", None)
        # Satu staging untuk keduanya; BEI yang ditolak dikembalikan utuh dan dilewati, Stockbit tetap terbit.
        # --stockbit-since hanya batas bawah Stockbit (tanggal 'Dari' desk); BEI memakai batas bawaannya sendiri.
        # --allow-provisional: hari 'sementara' (mis. hari ini) ikut terbit dengan label sementara; hari itu diperbarui
        # pada publish berikutnya dan menjadi final setelah desk menutupnya.
        result = runner([sys.executable, "-B", "tools/sync_idx.py", "--stockbit-only", "--no-build"]
                        + (["--stockbit-since", since] if since else [])
                        + (["--allow-provisional"] if getattr(args, "allow_provisional", False) else [])
                        + ["--with-bei"], timeout=T_SYNC)
        say(output(result).rstrip())
        if result.returncode:
            raise Failure(3, f"sync_idx.py --stockbit-only --with-bei keluar dengan kode {result.returncode}")
        # BEI dilewati (desk tanpa /api/bei, ekspor dari profil desk lain, atau ekspor BEI ditolak) tidak menggagalkan
        # Stockbit, tetapi dilaporkan supaya job BEI di desk tidak menganggap BEI sudah terbit.
        skipped = [line.strip() for line in output(result).splitlines() if "BEI dilewati" in line]
        if skipped:
            summary["bei_skipped"] = skipped[0][:500]
        check_no_deleted_sb(runner, 7)
        # Dicatat sebelum push VPS: rollback_stockbit.py menolak membatalkan publish yang mencabut hari yang ditahan desk.
        holds = worktree_withheld()
        for fam in desk.FAMILIES:
            withheld = withheld_removed(runner, holds, fam)
            if withheld:
                record["withheld" + fam.suffix] = summary["withheld" + fam.suffix] = withheld
        # Dibanding HEAD, bukan keluaran sinkron: berkas dari putaran yang gagal sebelumnya (VPS gagal, commit gagal)
        # masih kotor dan ikut diterbitkan putaran ini.
        changes = stockbit_changes(runner)
        record["files"] = sorted(p.rsplit("/", 1)[-1] for p in changes)
        if not changes:
            # Tanpa ini setiap klik membangun dan mengirim ulang situs ke VPS dan meng-commit docs/ dengan BUILD_ID baru.
            record["status"] = summary["status"] = "tidak ada perubahan"
            say("tidak ada perubahan Stockbit/BEI; tidak ada build, push VPS, atau commit")
            return 0, summary
        # sha per hari dari state yang dikirim putaran ini, dicatat sebelum push VPS: rollback cara restore menahan sha yang
        # benar-benar live, bukan sha yang ditulis sinkron sesudahnya (desk memfinalkan ulang, publish berikutnya gagal).
        # day_shas (Stockbit) selalu dicatat, day_shas_bei hanya kalau ada hari BEI.
        for fam in desk.FAMILIES:
            shas = worktree_day_shas(record["files"], fam)
            if shas or fam == desk.STOCKBIT:
                record["day_shas" + fam.suffix] = shas
        say("3/6 cek build (folder sementara)")
        summary["checked"] = len(build_check(runner))
        if args.dry_run:
            summary["status"] = "dry-run"
            return 0, summary
        say("  build docs/ (riwayat git)")
        build_docs(runner)
        # build.py --out docs bisa menghapus salinan sb*/bei* yang tidak dihasilkan lagi; periksa sebelum VPS, bukan baru di index.
        try:
            check_no_deleted_sb(runner, 7)
        except Failure as e:
            try:
                discard_derived(raw, 7)  # docs/ dikembalikan supaya preflight berikutnya tidak tertahan
            except (Failure, subprocess.TimeoutExpired) as cleanup:
                say(f"  peringatan: docs/ tidak bisa dikembalikan: {cleanup}")
            raise Failure(7, f"{e} (salinan hasil build docs/; VPS tidak disentuh)")
        vps_time = min(T_VPS, budget.left() - POST_VPS_RESERVE)
        if vps_time < MIN_VPS_SECONDS:
            raise Failure(5, "sisa waktu tidak cukup untuk push VPS dan commit; VPS tidak disentuh, tidak ada commit (jalankan ulang publish)")
        say("4/6 push VPS (node local/vps.mjs push)")
        record["status"] = "vps_failed"  # sampai vps.mjs berhasil (gagal atau batas waktu)
        if not vps_push(runner, timeout=vps_time):
            raise Failure(5, "VPS gagal; situs tetap versi sebelumnya; tidak ada commit (jalankan ulang publish)")
        record["vps"] = summary["vps"] = True
        del record["status"]
        say("5/6 commit")
        paths = [*stockbit_changes(runner), *DERIVED_PATHS]
        staged = paths  # sebelum add: add yang terputus pun bisa meninggalkan entri di index
        git_ok(runner, "add", "--", *paths, code=6, what="git add")
        removed = [n for n in git_ok(runner, "diff", "--cached", "--diff-filter=D", "--name-only", code=6).splitlines() if desk.parse(n)]
        # Penghapusan sb*/bei* hanya untuk hari yang ditahan desk menurut berkas tahanan keluarganya yang di-stage (yang ikut
        # di-commit).
        withheld = {}
        for fam in desk.FAMILIES:
            staged_hold = git(runner, "show", f":{rel(fam.hold)}") if any(desk.family_of(n) == fam for n in removed) else None
            withheld[fam.key] = desk_withheld_days(staged_hold.stdout if staged_hold and staged_hold.returncode == 0 else "")
        deleted = [n for n in removed if not withheld_deletion(n, withheld)]
        if deleted:
            raise Failure(7, "berkas Stockbit/BEI akan terhapus, tidak di-commit (VPS sudah memuat versi ini): " + ", ".join(deleted[:10]))
        if git(runner, "diff", "--cached", "--quiet").returncode == 0:
            staged = None
            record["status"] = summary["status"] = "tidak ada perubahan"
            say("tidak ada perubahan")
            return 0, summary
        names = git_ok(runner, "diff", "--cached", "--name-only", code=6).splitlines()
        record["files"] = sorted(n.rsplit("/", 1)[-1] for n in names
                                 if desk.parse(n) or n.endswith(tuple(fam.index for fam in desk.FAMILIES)))
        message = commit_message(names, removed)
        git_ok(runner, "commit", "-q", "-m", message, "--", *paths, code=6, what="git commit")
        staged = None
        # Sejak commit ada: push_failed (commit hanya di lokal) sampai push berhasil, lalu published. Tidak pernah lagi
        # vps_not_committed: rollback harus membuang/me-revert commit ini, bukan memulihkan pohon kerja.
        record["status"] = "push_failed"
        record["post_sha"] = git_ok(runner, "rev-parse", "HEAD", code=8)
        record["pre_sha"] = git_ok(runner, "rev-parse", "HEAD^", code=8)
        say("6/6 push git")
        pushed = push(runner, "HEAD:main")
        if pushed:
            record["status"] = "published"
        # Setelah `pull --rebase` (berhasil, termasuk bila push kedua gagal) commit berganti: rentang rollback = tepat satu
        # commit publish di HEAD.
        record["post_sha"] = git_ok(runner, "rev-parse", "HEAD", code=8)
        record["pre_sha"] = git_ok(runner, "rev-parse", "HEAD^", code=8)
        if not pushed:
            raise Failure(8, "push git gagal; commit ada di lokal dan VPS sudah live. Publish ulang ditolak selama commit itu belum "
                             "dipush: push manual `git push origin HEAD:main`, atau batalkan dengan tools/rollback_stockbit.py")
        tag = f"stockbit-publish-{stamp}"
        git_ok(runner, "tag", "-a", tag, "-m", message, record["post_sha"], code=8,
               what="commit sudah dipush, tetapi git tag")
        record["tag"] = tag
        if git_within(runner, "push", "origin", f"refs/tags/{tag}") != 0:
            say(f"  peringatan: tag {tag} gagal dipush; commit sudah live (push tag manual: git push origin {tag})")
            summary["tag_pushed"] = False
        summary["status"] = "published"
        summary.update(tag=tag, commit=record["post_sha"], message=message)
        return 0, summary
    except Failure as e:
        summary.update(status="gagal", error=str(e))
        if staged:
            unstage(raw, staged)
        if "status" not in record:
            record["status"] = "vps_not_committed" if record["vps"] else "gagal"
        say(f"GAGAL: {e}")
        return e.code, summary
    except subprocess.TimeoutExpired as e:
        summary.update(status="gagal", error=f"batas waktu habis: {' '.join(map(str, e.cmd))[:200]}")
        if staged:
            unstage(raw, staged)
        if "status" not in record:
            record["status"] = "vps_not_committed" if record["vps"] else "gagal"
        say(f"GAGAL: {summary['error']}")
        committed = record["status"] in ("push_failed", "published")
        return (8 if committed else 6 if record["vps"] else 1), summary
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


def since_day(value):
    if desk.iso_date(value):
        return value
    raise argparse.ArgumentTypeError(f"tanggal tidak valid: {value!r} (pakai YYYY-MM-DD)")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="preflight + sinkron + cek build saja")
    ap.add_argument("--stockbit-since", type=since_day, metavar="YYYY-MM-DD",
                    help="terbitkan hari final Stockbit mulai tanggal ini (tanggal 'Dari' di desk), bukan batas bawah "
                         "bawaan sync_idx.py; hari yang sudah terbit tetap dipertahankan")
    ap.add_argument("--allow-provisional", action="store_true",
                    help="ikut terbitkan hari 'sementara' Stockbit/BEI (mis. hari ini yang belum tutup)")
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
