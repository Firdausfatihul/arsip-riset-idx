#!/usr/bin/env python3
"""Batalkan publish Stockbit/BEI terakhir (atau --tag tertentu) yang tercatat di .stockbit-publish/log.jsonl.

    python3 -B tools/rollback_stockbit.py --dry-run                         # tampilkan rencana saja
    python3 -B tools/rollback_stockbit.py                                   # rollback publish terakhir
    python3 -B tools/rollback_stockbit.py --tag stockbit-publish-20261007-101500

Tiga cara, menurut status publish yang dibatalkan:
  revert   (published, atau push_failed yang commit-nya ternyata sudah ada di origin/main; juga push_failed yang dipush
           manual setelah `git pull --rebase`: salinannya di origin/main dicari lewat subjek + patch-id (`git cherry`), lalu
           yang di-revert tepat salinan itu, <induknya>..<salinan>; `rebased_from` di catatan rollback)
           Preflight: git dan node ada, .local/vps.json ada, cabang main, tidak ada yang di-stage, tidak ada berkas
           dilacak yang kotor selain docs/ dan site/ (hasil build, dibuang) dan berkas titik non-Stockbit di
           needtobeindexed/idx-signal-desk/ (mis. .sync.json, dibiarkan), tidak ada commit lokal yang belum dipush,
           `git fetch` + `git pull --ff-only`. Rentang commit hanya boleh menyentuh berkas Stockbit (sb*.md,
           stockbit-index.json, .sync-stockbit.json, .stockbit-hold.json), berkas BEI (bei*.md, bei-index.json,
           .sync-bei.json, .bei-hold.json), docs/, dan site/. Lalu
           `git revert --no-commit <pre_sha>..<post_sha>`, tahanan hari ditulis, satu commit "Rollback Stockbit …", push
           (tanpa force push; sekali `git pull --rebase` kalau ditolak).
  reset    (push_failed, HEAD = commit publish yang belum pernah sampai ke origin/main)
           Commit itu tidak pernah publik: `git reset --keep <pre_sha>` (tanpa push), tahanan hari ditulis tanpa commit
           (ikut publish berikutnya).
  restore  (vps_not_committed, atau status lama deployed_index_pending / deployed_not_committed: situs sudah diperbarui,
           belum ada commit). Berkas Stockbit/BEI yang kotor dikembalikan ke HEAD (berkas baru dihapus), docs/ dan site/
           dikembalikan, tahanan hari ditulis tanpa commit; hanya hari dari berkas yang tercatat di publish itu (`files`),
           dengan sha dari `day_shas` (Stockbit) / `day_shas_bei` (BEI) publish itu (dicatat sebelum push VPS; catatan lama
           tanpa keduanya: "*").
Semua cara (juga putaran ulang 'partial'/'push_failed') ditolak (exit 2) sebelum ada yang diubah kalau cabang bukan main,
git sedang di tengah revert (REVERT_HEAD/sequencer: `git revert --abort` dulu), ada yang di-stage, atau ada perubahan
(dilacak atau berkas baru) di luar berkas Stockbit/BEI, docs/, site/, dan berkas titik lain di
needtobeindexed/idx-signal-desk/: `node local/vps.mjs push` mengirim pohon kerja apa adanya, jadi kode atau dokumen yang
belum di-commit akan ikut live. Putaran ulang juga ditolak kalau berkas Stockbit/BEI selain .stockbit-hold.json dan
.bei-hold.json kotor (sinkron
atau publish sesudahnya yang belum terbit; tanpa ini berkas yang belum lolos cek build ikut live); putaran pertama revert/reset
juga menolak berkas Stockbit/BEI baru yang belum dilacak selain kedua berkas tahanan (alasan yang sama); docs/ dan site/ dikembalikan
ke HEAD sebelum push VPS. Batas waktu di tengah `git revert`/`git commit` menjalankan `git revert --abort`.
Setelah itu (semua cara):
  - `node local/vps.mjs push` supaya situs di VPS mengikuti pohon yang sudah dikembalikan (juga setelah push git revert
    gagal: commit revert ada di lokal, situs tetap dikembalikan).
  - Worker Cloudflare tidak pernah disentuh; catatan lama yang masih membawa worker_version_* hanya diberi keterangan.
  - Catatan rollback ditambahkan ke log; satu baris JSON ringkasan di akhir.

Tahanan (needtobeindexed/idx-signal-desk/.stockbit-hold.json untuk sb*, .bei-hold.json untuk bei*; {tgl: sha256 ekspor})
membuat rollback menetap: desk masih
mengekspor hari itu sebagai final, tetapi sync_idx.py tidak menerbitkannya lagi sampai desk memfinalkan ulang hari itu
(sha berubah) atau entrinya dihapus dari berkas tahanan. Entri yang ditandai sinkron `withheld_by: "desk"` (hari yang ditahan
desk dari web) dipertahankan; hari yang berkasnya dihapus oleh publish yang dibatalkan tidak ditahan rollback. --tag untuk publish lama ditolak selama ada publish yang lebih
baru yang belum di-rollback. Rollback 'partial' (push VPS gagal, atau skrip dihentikan selagi push VPS: catatan 'partial'
ditulis sebelum push VPS, dengan "interim": true; desk menyembunyikannya kalau catatan akhir putaran yang sama ada) boleh
dijalankan ulang: langkah git dilewati, push VPS diulang. Rollback 'push_failed' (commit revert hanya di lokal, exit 4) juga:
kalau commit revert sudah dipush manual (juga sebagai salinan hasil rebase) langsung ke push VPS, kalau HEAD masih commit
revert itu dipush dulu (revert tidak diulang).
Publish yang mencabut hari yang ditahan desk dari web (`withheld` Stockbit atau `withheld_bei` BEI di log) ditolak (exit 2):
membatalkannya akan menerbitkan lagi hari itu. Pakai desk: tahan hari lain yang ingin dicabut, atau lepas tahanannya, lalu publish.

Exit code: 0 berhasil (atau dry-run), 1 kesalahan tak terduga, 2 preflight/rencana ditolak, 3 git revert/reset gagal,
4 push git revert gagal (commit revert di lokal; VPS tetap dicoba; jalankan skrip ini lagi atau push manual), 5 push VPS gagal
setelah git dikembalikan, atau sisa waktu tidak cukup (jalankan skrip ini lagi). Batas waktu total pub.ROLLBACK_BUDGET di bawah
batas desk (1800 detik).
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import publish_stockbit as pub  # noqa: E402  (git/VPS helper dan konstanta yang sama)


def read_log(log):
    if not log.is_file():
        raise pub.Failure(2, f"{log} belum ada; belum pernah ada publish Stockbit yang tercatat.")
    return pub.load_records(log)


def covers(record):
    return record.get("covers") or [record.get("tag")]


def choose(records, tag=None):
    """(publish target, rollback 'partial' sebelumnya untuk target itu atau None)."""
    done = pub.rolled_back_keys(records)
    partial = {}
    for r in records:
        # partial: git sudah dikembalikan, push VPS belum. push_failed: commit revert ada, hanya push git-nya yang belum.
        if r.get("type") == "rollback" and (r.get("status") == "partial"
                                            or (r.get("status") == "push_failed" and r.get("revert_sha"))):
            for key in covers(r):
                partial[key] = r
    publishes = [r for r in records if r.get("type") == "publish" and r.get("status") in pub.ROLLBACKABLE]
    if tag:
        position = next((i for i in range(len(publishes) - 1, -1, -1) if publishes[i].get("tag") == tag), None)
        if position is None:
            raise pub.Failure(2, f"tag {tag} tidak ada di log sebagai publish yang bisa di-rollback.")
        target = publishes[position]
        later = [pub.record_key(r) for r in publishes[position + 1:] if pub.record_key(r) not in done]
        if later and pub.record_key(target) not in done:
            raise pub.Failure(2, f"ada publish yang lebih baru dan belum di-rollback ({', '.join(map(str, later[:5]))}); "
                                 f"rollback yang terbaru dulu supaya situs dan git tetap sejalan.")
    else:
        if not publishes:
            raise pub.Failure(2, "tidak ada publish yang bisa di-rollback di log.")
        target = publishes[-1]
    key = pub.record_key(target)
    if key in done:
        raise pub.Failure(2, f"publish {key} sudah pernah di-rollback.")
    return target, partial.get(key)


def plan_for(target, previous=None):
    has_git = bool(target.get("pre_sha") and target.get("post_sha"))
    status = target.get("status")
    if status in pub.DEPLOYED_ONLY:
        mode = "restore"
    elif not has_git:
        # Ada commit (published/push_failed) tetapi rentangnya tidak tercatat: memulihkan pohon kerja tidak membatalkannya.
        raise pub.Failure(2, f"publish {pub.record_key(target)} berstatus {status} tanpa pre_sha/post_sha; rollback manual.")
    else:
        mode = "push_failed" if status == "push_failed" else "revert"
    pending = previous.get("revert_sha") if previous and previous.get("status") == "push_failed" else None
    return {
        "target": pub.record_key(target),
        "status": status,
        "mode": mode,
        "git_done": bool(previous and (previous.get("git_done") or pending)),
        "push_pending": pending,  # commit revert dari rollback sebelumnya yang belum dipush
        "revert": f"{target['pre_sha']}..{target['post_sha']}" if has_git else None,
        "vps": True,
        # Catatan dari masa Worker Cloudflare: Worker itu tidak dipakai lagi dan dibiarkan apa adanya.
        "legacy_worker": any(k in target for k in ("worker_version_before", "worker_version_after", "rollback_to")),
    }


def revert_in_progress(runner):
    """True kalau git sedang di tengah revert (REVERT_HEAD atau folder sequencer), mis. rollback yang terhenti batas waktu."""
    if pub.git(runner, "rev-parse", "-q", "--verify", "REVERT_HEAD").returncode == 0:
        return True
    sequencer = (pub.git(runner, "rev-parse", "--git-path", "sequencer").stdout or "").strip()
    return bool(sequencer) and (pub.ROOT / sequencer).is_dir()


def check_vps_tree(runner, rerun=False):
    """Syarat setiap push VPS rollback: `vps.mjs push` mengirim berkas dilacak + berkas baru yang tidak diabaikan dari disk.

    Cabang main, tidak ada revert setengah jalan, tidak ada yang di-stage, tidak ada perubahan (dilacak atau baru) di luar
    berkas Stockbit, docs/, site/, dan berkas titik non-Stockbit di DEST_REL: kode atau dokumen yang belum di-commit tidak
    boleh ikut live lewat rollback. Putaran ulang (`rerun`, langkah git sudah selesai) juga menolak berkas Stockbit yang kotor
    selain berkas tahanan: pohon kerja setelah langkah git hanya mengubah berkas tahanan, jadi berkas Stockbit kotor lainnya
    berasal dari sinkron/publish sesudahnya yang belum lolos cek build atau belum terbit.
    """
    branch = pub.git_ok(runner, "rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main":
        raise pub.Failure(2, f"cabang aktif '{branch}', bukan main.")
    if revert_in_progress(runner):
        raise pub.Failure(2, "git sedang di tengah revert (sisa rollback yang terhenti); jalankan `git revert --abort` lalu "
                             "ulangi rollback.")
    if pub.git(runner, "diff", "--cached", "--quiet").returncode:
        raise pub.Failure(2, "ada perubahan yang sudah di-stage; `git restore --staged .` dulu.")
    changes = pub.changed_paths(runner)
    outside = [path for _, path in changes if pub.dirty_kind(path) == "other"]
    if outside:
        raise pub.Failure(2, "push VPS akan ikut mengirim perubahan di luar berkas Stockbit/BEI/docs/site (commit atau kembalikan "
                             "dulu): " + ", ".join(outside[:15]))
    stale = [path for _, path in changes
             if rerun and pub.publish_owned(path) and path not in (pub.HOLD_REL, pub.BEI_HOLD_REL)]
    if stale:
        raise pub.Failure(2, "berkas Stockbit/BEI berubah sesudah langkah git rollback ini (sinkron/publish berikutnya yang belum "
                             "terbit); push VPS akan menerbitkannya tanpa cek build. Kembalikan dulu (`git checkout HEAD -- "
                             "<berkas>`, hapus berkas baru) lalu ulangi rollback: " + ", ".join(stale[:15]))


def rebased_copy(runner, sha, base):
    """Salinan `sha` di base..origin/main (push manual setelah `git pull --rebase`): satu-satunya commit non-merge dengan subjek
    sama yang `git cherry` nyatakan setara (patch-id sama). None kalau tidak ada atau lebih dari satu."""
    subject = pub.git(runner, "log", "-1", "--format=%s", sha)
    listing = pub.git(runner, "log", "--no-merges", "--format=%H%x00%s", f"{base}..origin/main")
    if subject.returncode or listing.returncode or not (subject.stdout or "").strip():
        return None
    subject = subject.stdout.strip()
    found = []
    for line in (listing.stdout or "").splitlines():
        candidate, _, title = line.partition("\0")
        candidate = candidate.strip()
        if not candidate or candidate == sha or title.strip() != subject:
            continue
        # `git cherry <sha> <c> <c>^`: "- <c>" kalau c setara dengan commit di c..sha (yaitu sha sendiri).
        cherry = pub.git(runner, "cherry", sha, candidate, f"{candidate}^")
        if cherry.returncode == 0 and (cherry.stdout or "").strip() == f"- {candidate}":
            found.append(candidate)
    return found[0] if len(found) == 1 else None


def preflight(runner, target, plan):
    """Kembalikan cara yang dipakai: 'revert', 'reset', atau 'restore'. Alat (git, node, .local/vps.json) dicek sebelumnya."""
    check_vps_tree(runner)
    if plan["mode"] == "restore":
        return "restore"  # berkas Stockbit kotor memang sisa publish ini
    changes = pub.changed_paths(runner)
    blocked = [path for status, path in changes
               if status != "??" and pub.dirty_kind(path) not in ("derived", "ignored")]
    if blocked:
        raise pub.Failure(2, "pohon kerja tidak bersih: " + ", ".join(blocked[:15]))
    # Berkas Stockbit/BEI baru yang belum dilacak: commit publish yang dibatalkan memuat semua berkasnya (dilacak), jadi berkas
    # baru selain tahanan berasal dari sinkron/publish sesudahnya yang belum lolos cek build atau belum terbit. `vps.mjs push`
    # mengirim berkas baru dari disk: tanpa ini berkas itu ikut live lewat rollback. Tidak dihapus otomatis (cara restore
    # menghapusnya karena memang sisa publish yang dibatalkan).
    unpublished = [path for status, path in changes
                   if status == "??" and pub.publish_owned(path) and path not in (pub.HOLD_REL, pub.BEI_HOLD_REL)]
    if unpublished:
        raise pub.Failure(2, "ada berkas Stockbit/BEI baru yang belum terbit (sinkron/publish sesudahnya yang belum lolos cek "
                             "build); push VPS akan menerbitkannya tanpa cek build. Hapus dulu lalu ulangi rollback: "
                             + ", ".join(unpublished[:15]))
    pre, post = target["pre_sha"], target["post_sha"]
    pub.git_ok(runner, "fetch", "origin", "main", timeout=pub.T_NET)
    mode = "revert"
    if plan["mode"] == "push_failed" and pub.git(runner, "merge-base", "--is-ancestor", post, "origin/main").returncode:
        head = pub.git_ok(runner, "rev-parse", "HEAD")
        if head == post:
            # Commit publish tidak pernah sampai ke origin: buang di lokal, jangan dorong isi yang dibatalkan ke riwayat publik.
            mode = "reset"
        else:
            # Dipush manual setelah `git pull --rebase` (exit 8): isinya sudah publik sebagai commit lain. Revert salinan itu,
            # tepat satu commit (pre = induknya), bukan rentang lama yang ikut memuat commit orang lain di origin.
            copy = rebased_copy(runner, post, pre)
            if not copy:
                raise pub.Failure(2, f"commit publish {post[:12]} tidak ada di origin/main, HEAD ({head[:12]}) bukan commit itu, "
                                     "dan tidak ada salinan hasil rebase-nya (subjek + patch-id sama) di origin/main; rollback manual.")
            pre = pub.git_ok(runner, "rev-parse", f"{copy}^")
            pub.say(f"  git: commit publish {post[:12]} sudah dipush manual sebagai {copy[:12]} (rebase); yang di-revert {copy[:12]}")
            plan.update(rebased_from=post, revert=f"{pre}..{copy}")
            target.update(pre_sha=pre, post_sha=copy)  # held_days dan git_step membaca rentang baru ini
            post = copy
    if mode == "revert":
        ahead = int(pub.git_ok(runner, "rev-list", "--count", "origin/main..HEAD") or 0)
        if ahead:
            raise pub.Failure(2, f"ada {ahead} commit lokal yang belum dipush.")
        if int(pub.git_ok(runner, "rev-list", "--count", "HEAD..origin/main") or 0):
            pub.git_ok(runner, "pull", "--ff-only", "origin", "main", timeout=pub.T_NET, what="git pull --ff-only")
    for older, newer in ((pre, post), (post, "HEAD")):
        if pub.git(runner, "merge-base", "--is-ancestor", older, newer).returncode:
            raise pub.Failure(2, f"{older[:12]} bukan leluhur {newer[:12]}; riwayat berubah, rollback manual.")
    touched = pub.git_ok(runner, "diff", "--name-only", pre, post).splitlines()
    outside = [p for p in touched if pub.dirty_kind(p) not in ("derived", *pub.OWNED_KINDS)]
    if outside:
        raise pub.Failure(2, "rentang commit menyentuh berkas di luar berkas Stockbit/BEI/docs/site: " + ", ".join(outside[:10]))
    return mode


# Per keluarga: kunci day_shas di catatan publish (sha yang dikirim ke VPS).
DAY_SHAS_KEY = {"stockbit": "day_shas", "bei": "day_shas_bei"}


def held_days(runner, target, mode, family="stockbit"):
    """{tgl: sha256 ekspor desk} untuk hari harian keluarga itu (sb*/bei*) yang dibawa publish ini; "*" kalau sha tidak
    diketahui.

    Berkas yang dihapus publish ini (hari yang ditahan desk dari web) tidak dibawa, jadi harinya tidak ditahan rollback:
    rollback mengembalikan berkasnya, dan sinkron berikutnya mengikuti daftar tahanan desk lagi.
    """
    names = set(target.get("files") or [])
    if mode == "restore":
        # Hanya berkas publish ini (files mencatat semua berkas Stockbit/BEI yang berubah saat itu, termasuk dari publish
        # yang di-supersede). Berkas kotor lain (sinkron publish berikutnya yang gagal) tidak pernah live: tidak ditahan.
        changes = pub.changed_paths(runner)
        removed = {p.rsplit("/", 1)[-1] for status, p in changes if "D" in status and pub.publish_owned(p)}
        # sha yang dikirim ke VPS oleh publish ini (day_shas/day_shas_bei, dicatat sebelum push VPS). Berkas status sinkron
        # di pohon kerja bisa sudah ditulis ulang sinkron sesudahnya (hari difinalkan ulang); catatan lama tanpa: "*".
        recorded = target.get(DAY_SHAS_KEY[family])
        recorded = recorded if isinstance(recorded, dict) else {}
        out = pub.state_day_shas(names - removed, "", family)
        return {day: sha if (sha := str(recorded.get(day) or "")) not in ("", "None") else "*" for day in out}
    diff = pub.git(runner, "diff", "--name-only", target["pre_sha"], target["post_sha"]).stdout or ""
    names |= {p.rsplit("/", 1)[-1] for p in diff.splitlines()}
    gone = pub.git(runner, "diff", "--diff-filter=D", "--name-only", target["pre_sha"], target["post_sha"]).stdout or ""
    removed = {p.rsplit("/", 1)[-1] for p in gone.splitlines()}
    if family != "stockbit" and not pub.state_day_shas(names - removed, "", family):
        return {}  # publish tanpa hari BEI: .sync-bei.json tidak perlu dibaca (Stockbit tetap persis seperti sebelumnya)
    state_text = pub.git(runner, "show", f"{target['post_sha']}:{pub.STATES[family]}").stdout or ""
    return pub.state_day_shas(names - removed, state_text, family)


def write_hold(days, key, rel=None):
    """Gabungkan ke berkas tahanan (default .stockbit-hold.json; BEI: .bei-hold.json); kembalikan True kalau ditulis.

    Entri yang sudah ada dipertahankan; untuk hari yang sama kolom lain (mis. withheld_by=desk dari sinkron) tetap ada.
    """
    if not days:
        return False
    path = pub.ROOT / (rel or pub.HOLD_REL)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    hold = data.get("days") if isinstance(data, dict) and isinstance(data.get("days"), dict) else {}
    for day, sha in days.items():
        prev = hold.get(day)
        hold[day] = {**(prev if isinstance(prev, dict) else {}), "sha256": sha, "rollback_of": key}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"format": 1, "days": dict(sorted(hold.items()))}, ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8")
    return True


discard_derived = pub.discard_derived


def restore_tree(runner):
    """Kembalikan berkas Stockbit/BEI yang kotor ke HEAD (berkas baru dihapus), kecuali berkas tahanan."""
    tracked = []
    for status, path in pub.changed_paths(runner):
        if not pub.publish_owned(path) or path in (pub.HOLD_REL, pub.BEI_HOLD_REL):
            continue
        if status == "??":
            (pub.ROOT / path).unlink(missing_ok=True)
        else:
            tracked.append(path)
    if tracked:
        pub.git_ok(runner, "checkout", "HEAD", "--", *tracked, code=3, what="git checkout HEAD -- <berkas Stockbit/BEI>")
    discard_derived(runner, 3)


def abort_revert(raw):
    """`git revert --abort` tanpa anggaran total (dipanggil setelah batas waktu); juga melepas berkas tahanan yang di-stage."""
    if pub.git_within(raw, "revert", "--abort", timeout=pub.T_GIT) != 0:
        pub.say("  peringatan: revert tidak bisa dibatalkan otomatis; jalankan `git revert --abort` sebelum rollback berikutnya")


def git_step(runner, target, plan, mode, record, raw=None):
    """`raw`: runner tanpa anggaran total, hanya untuk membatalkan revert setelah batas waktu."""
    key = plan["target"]
    days = held_days(runner, target, mode)
    bei_days = held_days(runner, target, mode, "bei")
    record["held"] = days
    if bei_days:
        record["held_bei"] = bei_days
    if mode == "revert":
        discard_derived(runner, 3)
        try:
            result = pub.git(runner, "revert", "--no-commit", plan["revert"], timeout=pub.T_GIT)
            if result.returncode:
                pub.git(runner, "revert", "--abort")
                raise pub.Failure(3, f"git revert gagal: {pub.output(result).strip()[-400:]}")
            if write_hold(days, key):
                pub.git_ok(runner, "add", "--", pub.HOLD_REL, code=3)
            if write_hold(bei_days, key, pub.BEI_HOLD_REL):
                pub.git_ok(runner, "add", "--", pub.BEI_HOLD_REL, code=3)
            result = pub.git(runner, "commit", "-q", "-m", f"Rollback Stockbit {key}", timeout=pub.T_GIT)
            if result.returncode:
                pub.git(runner, "revert", "--abort")
                raise pub.Failure(3, f"git commit revert gagal: {pub.output(result).strip()[-400:]}")
        except subprocess.TimeoutExpired:
            # Hook commit lambat atau anggaran habis: jangan tinggalkan REVERT_HEAD + index yang di-stage.
            abort_revert(raw or runner)
            raise
        record["revert_sha"] = pub.git_ok(runner, "rev-parse", "HEAD", code=3)
        if not pub.push(runner, "HEAD:main"):
            # Situs tetap dikembalikan (push VPS di bawah); commit revert menunggu di lokal. Putaran ulang hanya mendorongnya.
            record["git_push_failed"] = True
        record["revert_sha"] = pub.git_ok(runner, "rev-parse", "HEAD", code=4)  # pull --rebase bisa menggantinya
    elif mode == "reset":
        discard_derived(runner, 3)
        pub.git_ok(runner, "reset", "--keep", target["pre_sha"], code=3, what="git reset --keep")
        record["reset_to"] = target["pre_sha"]
        write_hold(days, key)
        write_hold(bei_days, key, pub.BEI_HOLD_REL)
    else:
        restore_tree(runner)
        write_hold(days, key)
        write_hold(bei_days, key, pub.BEI_HOLD_REL)
    if mode != "revert" and (days or bei_days):
        written = [rel for rel, d in ((pub.HOLD_REL, days), (pub.BEI_HOLD_REL, bei_days)) if d]
        pub.say(f"  tahanan ditulis ke {', '.join(written)} (belum di-commit; ikut publish berikutnya)")
    record["git_done"] = True


def finish_revert_push(runner, sha, record):
    """Putaran ulang setelah exit 4: commit revert `sha` sudah ada; dorong kalau belum sampai origin (revert tidak diulang)."""
    record["revert_sha"] = sha
    pub.git_ok(runner, "fetch", "origin", "main", timeout=pub.T_NET)
    if pub.git(runner, "merge-base", "--is-ancestor", sha, "origin/main").returncode == 0:
        pub.say(f"  git: commit revert {sha[:12]} sudah ada di origin/main")
        return
    head = pub.git_ok(runner, "rev-parse", "HEAD")
    if head != sha:
        # Dipush manual setelah `git pull --rebase`: commit revert ada di origin/main sebagai salinan dengan sha lain.
        base = (pub.git(runner, "merge-base", sha, "origin/main").stdout or "").strip()
        copy = rebased_copy(runner, sha, base) if base else None
        if copy:
            record.update(revert_sha=copy, rebased_from=sha)
            pub.say(f"  git: commit revert {sha[:12]} sudah dipush manual sebagai {copy[:12]} (rebase)")
            return
        raise pub.Failure(2, f"commit revert {sha[:12]} tidak ada di origin/main, HEAD ({head[:12]}) bukan commit itu, dan tidak "
                             "ada salinan hasil rebase-nya di origin/main; rollback manual.")
    pub.say(f"  git: push commit revert {sha[:12]}")
    if not pub.push(runner, "HEAD:main"):
        record["git_push_failed"] = True
    record["revert_sha"] = pub.git_ok(runner, "rev-parse", "HEAD", code=4)


def vps_step(runner, record, timeout=pub.T_VPS):
    """`node local/vps.mjs push` dari pohon yang sudah dikembalikan. 0 berhasil, 5 gagal (vps.mjs memulihkan versi live)."""
    if timeout < pub.MIN_VPS_SECONDS:
        pub.say("  sisa waktu tidak cukup untuk push VPS; tidak dimulai")
        record["vps"] = False
        pub.say("  situs belum mengikuti rollback. Jalankan skrip ini lagi (langkah git dilewati)")
        return 5
    try:
        ok = pub.vps_push(runner, timeout=timeout)
    except pub.Failure as e:  # batas waktu
        pub.say(f"  {e}")
        ok = False
    record["vps"] = ok
    if not ok:
        pub.say("  push VPS gagal; situs belum mengikuti rollback. Jalankan: node local/vps.mjs push "
                "(atau skrip ini lagi: langkah git dilewati)")
    return 0 if ok else 5


def rollback(args, runner=pub.run_command, which=shutil.which, log=None, budget=None):
    log = log or pub.LOG
    budget = budget or pub.Budget(pub.ROLLBACK_BUDGET)
    raw, runner = runner, budget.wrap(runner)  # raw: hanya untuk `git revert --abort` setelah batas waktu
    summary = {"status": "dimulai", "dry_run": bool(args.dry_run)}
    record = {"type": "rollback", "started_at": pub.now_iso()}
    try:
        target, previous = choose(read_log(log), args.tag)
        plan = plan_for(target, previous)
        summary["plan"] = plan
        # Stockbit dan BEI: membatalkan publish yang mencabut hari yang ditahan desk (salah satu keluarga) ditolak.
        withheld = [*(target.get("withheld") or []), *(f"BEI {d}" for d in target.get("withheld_bei") or [])]
        if withheld and not plan["git_done"]:
            # Membatalkan publish ini mengembalikan berkas hari yang ditahan desk (revert/reset/restore), dan push VPS
            # menerbitkannya: hari itu terbit lagi padahal desk masih menahannya. Tidak diubah apa pun.
            raise pub.Failure(2, f"publish {plan['target']} mencabut hari yang ditahan desk dari web ({', '.join(map(str, withheld[:10]))}); "
                                 "rollback otomatis akan menerbitkannya lagi. Untuk mencabut isi lain dari publish ini, tahan harinya "
                                 "di Signal Desk lalu publish; untuk menerbitkan lagi hari yang ditahan, lepas tahanannya di desk lalu publish.")
        record.update(tag=plan["target"], covers=[plan["target"], *(target.get("supersedes") or [])],
                      reverted=plan["revert"], target="vps")
        pub.say(f"rencana rollback {plan['target']} (status {plan['status']}, cara {plan['mode']}):")
        if plan["push_pending"]:
            pub.say(f"  git: commit revert {plan['push_pending'][:12]} sudah ada (rollback sebelumnya, push gagal); hanya dipush")
        elif plan["git_done"]:
            pub.say("  git: sudah dikembalikan oleh rollback sebelumnya (partial); dilewati")
        elif plan["mode"] == "restore":
            pub.say("  git: belum ada commit; berkas Stockbit/BEI yang kotor dikembalikan ke HEAD, docs/ dan site/ dibuang")
        elif plan["mode"] == "push_failed":
            pub.say(f"  git: {plan['revert']} (reset lokal kalau commit belum pernah dipush, selain itu revert + push)")
        else:
            pub.say(f"  git: revert {plan['revert']} + push")
        pub.say(f"  hari yang dibawa publish ini ditahan di {pub.HOLD_REL} (BEI: {pub.BEI_HOLD_REL}) sampai desk memfinalkannya ulang")
        pub.say("  lalu node local/vps.mjs push (situs mengikuti pohon yang dikembalikan)")
        if plan["legacy_worker"]:
            pub.say("  catatan: publish ini dari masa Worker Cloudflare; Worker lama tidak dipakai lagi dan dibiarkan")
        if args.dry_run:
            summary["status"] = "dry-run"
            return 0, summary
        pub.check_tools(which)
        if plan["git_done"]:
            # Putaran ulang: hanya berkas tahanan yang boleh kotor (berkas Stockbit/BEI lain = sinkron sesudahnya, belum terbit).
            check_vps_tree(runner, rerun=True)
            discard_derived(runner, 3)  # docs/ dan site/ sisa publish/build sesudahnya tidak ikut ke VPS
            record["git_done"] = True
            if plan["push_pending"]:
                finish_revert_push(runner, plan["push_pending"], record)
        else:
            mode = preflight(runner, target, plan)
            record.update(mode=mode, reverted=plan["revert"])
            if plan.get("rebased_from"):
                record["rebased_from"] = plan["rebased_from"]
            git_step(runner, target, plan, mode, record, raw=raw)
        # Dicatat sebelum push VPS: kalau skrip dihentikan di tengahnya, putaran ulang tidak mengulang langkah git.
        # interim: catatan sementara; desk menyembunyikannya bila catatan akhir putaran yang sama (started_at) sudah ada.
        try:
            pub.append_log({**record, "status": "push_failed" if record.get("git_push_failed") else "partial", "vps": None,
                            "interim": True, "finished_at": pub.now_iso()}, log)
        except OSError as e:
            pub.say(f"  peringatan: catatan sementara rollback tidak tertulis: {e}")
        code = vps_step(runner, record, timeout=min(pub.T_VPS, budget.left() - 30))
        if record.get("git_push_failed"):
            record["status"] = "push_failed"
            pub.say("  push git revert gagal; commit revert ada di lokal (push manual: git push origin HEAD:main)")
            summary.update(status="gagal", error="push revert gagal; commit revert ada di lokal",
                           revert_sha=record.get("revert_sha"), held=sorted(record.get("held") or {}), vps=record["vps"])
            if record.get("held_bei"):
                summary["held_bei"] = sorted(record["held_bei"])
            return 4, summary
        record["status"] = "rolled_back" if code == 0 else "partial"
        if code:
            pub.say("  rollback belum lengkap; jalankan skrip ini lagi setelah memperbaikinya (langkah git tidak diulang)")
        summary.update(status=record["status"], revert_sha=record.get("revert_sha"), held=sorted(record.get("held") or {}),
                       vps=record["vps"])
        if record.get("held_bei"):
            summary["held_bei"] = sorted(record["held_bei"])
        return code, summary
    except pub.Failure as e:
        summary.update(status="gagal", error=str(e))
        record.setdefault("status", "gagal")
        pub.say(f"GAGAL: {e}")
        return e.code, summary
    except subprocess.TimeoutExpired as e:
        # Batas waktu langkah git atau anggaran total habis sebelum push VPS. Commit revert yang sudah ada tercatat (revert_sha).
        error = f"batas waktu habis: {' '.join(map(str, e.cmd))[:200]}"
        summary.update(status="gagal", error=error)
        record.setdefault("status", "push_failed" if record.get("revert_sha") else "gagal")
        pub.say(f"GAGAL: {error}")
        return (4 if record.get("revert_sha") else 1), summary
    finally:
        if not args.dry_run and record.get("tag"):
            record["finished_at"] = pub.now_iso()
            try:
                pub.append_log(record, log)
            except OSError as e:
                pub.say(f"  peringatan: catatan rollback tidak tertulis: {e}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tag", help="tag stockbit-publish-… yang dikembalikan (default: publish terakhir)")
    ap.add_argument("--dry-run", action="store_true", help="tampilkan rencana tanpa mengubah apa pun")
    args = ap.parse_args(argv)
    try:
        code, summary = rollback(args)
    except (Exception, subprocess.TimeoutExpired) as e:
        code, summary = 1, {"status": "gagal", "error": f"{type(e).__name__}: {e}"}
    summary["exit"] = code
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True), flush=True)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
