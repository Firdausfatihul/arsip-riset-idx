#!/usr/bin/env python3
"""Batalkan publish Stockbit terakhir (atau --tag tertentu) yang tercatat di .stockbit-publish/log.jsonl.

    python3 -B tools/rollback_stockbit.py --dry-run                         # tampilkan rencana saja
    python3 -B tools/rollback_stockbit.py                                   # rollback publish terakhir
    python3 -B tools/rollback_stockbit.py --tag stockbit-publish-20261007-101500

Tiga cara, menurut status publish yang dibatalkan:
  revert   (published, atau push_failed yang commit-nya ternyata sudah ada di origin/main)
           Preflight: git dan npx ada, cabang main, tidak ada yang di-stage, tidak ada berkas dilacak yang kotor selain
           docs/ dan site/ (hasil build, dibuang) dan berkas titik non-Stockbit di needtobeindexed/idx-signal-desk/
           (mis. .sync.json, dibiarkan), tidak ada commit lokal yang belum dipush, `git fetch` + `git pull --ff-only`.
           Rentang commit hanya boleh menyentuh berkas Stockbit (sb*.md, stockbit-index.json, .sync-stockbit.json,
           .stockbit-hold.json), docs/, dan site/. Lalu `git revert --no-commit <pre_sha>..<post_sha>`, tahanan hari
           ditulis, satu commit "Rollback Stockbit …", push (tanpa force push; sekali `git pull --rebase` kalau ditolak).
  reset    (push_failed, HEAD = commit publish yang belum pernah sampai ke origin/main)
           Commit itu tidak pernah publik: `git reset --keep <pre_sha>` (tanpa push), tahanan hari ditulis tanpa commit
           (ikut publish berikutnya).
  restore  (deployed_index_pending / deployed_not_committed: Worker sudah live, belum ada commit)
           Tanpa cek pohon bersih: berkas Stockbit yang kotor dikembalikan ke HEAD (berkas baru dihapus), docs/ dan site/
           dikembalikan, tahanan hari ditulis tanpa commit.
Setelah itu (semua cara):
  - Worker: `npx wrangler@4.135.0 rollback <versi sebelum publish>` HANYA kalau versi live masih versi yang di-deploy
    publish ini (worker_version_after). Kalau bukan atau tidak terbaca, Worker tidak disentuh (deploy yang lebih baru
    tidak dibuang); langkah manual dicetak dan exit 5.
  - `tools/sync_chat_index.py` supaya indeks chat mengikuti dokumen yang dikembalikan.
  - Catatan rollback ditambahkan ke log; satu baris JSON ringkasan di akhir.

Tahanan (needtobeindexed/idx-signal-desk/.stockbit-hold.json, {tgl: sha256 ekspor}) membuat rollback menetap: desk masih
mengekspor hari itu sebagai final, tetapi sync_idx.py tidak menerbitkannya lagi sampai desk memfinalkan ulang hari itu
(sha berubah) atau entrinya dihapus dari berkas tahanan. Entri yang ditandai sinkron `withheld_by: "desk"` (hari yang ditahan
desk dari web) dipertahankan; hari yang berkasnya dihapus oleh publish yang dibatalkan tidak ditahan rollback. --tag untuk publish lama ditolak selama ada publish yang lebih
baru yang belum di-rollback. Rollback 'partial' (Worker atau indeks gagal) boleh dijalankan ulang: langkah git dilewati.
Publish yang mencabut hari yang ditahan desk dari web (`withheld` di log) ditolak (exit 2): membatalkannya akan menerbitkan
lagi hari itu (berkas dan Worker versi sebelumnya). Pakai desk: tahan hari lain yang ingin dicabut, atau lepas tahanannya, lalu publish.

Exit code: 0 berhasil (atau dry-run), 1 kesalahan tak terduga, 2 preflight/rencana ditolak, 3 git revert/reset gagal,
4 push gagal, 5 Worker tidak di-rollback otomatis (git sudah dikembalikan), 6 sinkron indeks chat gagal.
"""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import publish_stockbit as pub  # noqa: E402  (git/wrangler helper dan konstanta yang sama)


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
        if r.get("type") == "rollback" and r.get("status") == "partial":
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
                                 f"rollback yang terbaru dulu supaya Worker dan git tetap sejalan.")
    else:
        if not publishes:
            raise pub.Failure(2, "tidak ada publish yang bisa di-rollback di log.")
        target = publishes[-1]
    key = pub.record_key(target)
    if key in done:
        raise pub.Failure(2, f"publish {key} sudah pernah di-rollback.")
    return target, partial.get(key)


def worker_target(target):
    return target["rollback_to"] if "rollback_to" in target else target.get("worker_version_before")


def plan_for(target, previous=None):
    has_git = bool(target.get("pre_sha") and target.get("post_sha"))
    status = target.get("status")
    if status in pub.DEPLOYED_ONLY or not has_git:
        mode = "restore"
    else:
        mode = "push_failed" if status == "push_failed" else "revert"
    return {
        "target": pub.record_key(target),
        "status": status,
        "mode": mode,
        "git_done": bool(previous and previous.get("git_done")),
        "revert": f"{target['pre_sha']}..{target['post_sha']}" if has_git else None,
        "worker_rollback_to": worker_target(target),
        "worker_expected_live": target.get("worker_version_after"),
    }


def preflight(runner, target, plan, which=shutil.which):
    """Kembalikan cara yang dipakai: 'revert', 'reset', atau 'restore'."""
    for tool in ("git", "npx"):
        if not which(tool):
            raise pub.Failure(2, f"'{tool}' tidak ditemukan di PATH.")
    branch = pub.git_ok(runner, "rev-parse", "--abbrev-ref", "HEAD")
    if branch != "main":
        raise pub.Failure(2, f"cabang aktif '{branch}', bukan main.")
    if pub.git(runner, "diff", "--cached", "--quiet").returncode:
        raise pub.Failure(2, "ada perubahan yang sudah di-stage.")
    if plan["mode"] == "restore":
        return "restore"  # berkas kotor memang sisa publish ini; berkas lain tidak disentuh
    blocked = [path for status, path in pub.changed_paths(runner)
               if status != "??" and pub.dirty_kind(path) not in ("derived", "ignored")]
    if blocked:
        raise pub.Failure(2, "pohon kerja tidak bersih: " + ", ".join(blocked[:15]))
    pre, post = target["pre_sha"], target["post_sha"]
    pub.git_ok(runner, "fetch", "origin", "main", timeout=pub.T_NET)
    mode = "revert"
    if plan["mode"] == "push_failed" and pub.git(runner, "merge-base", "--is-ancestor", post, "origin/main").returncode:
        # Commit publish tidak pernah sampai ke origin: buang di lokal, jangan dorong isi yang dibatalkan ke riwayat publik.
        if pub.git_ok(runner, "rev-parse", "HEAD") != post:
            raise pub.Failure(2, f"HEAD bukan commit publish {post[:12]} yang gagal dipush; rollback manual.")
        mode = "reset"
    else:
        ahead = int(pub.git_ok(runner, "rev-list", "--count", "origin/main..HEAD") or 0)
        if ahead:
            raise pub.Failure(2, f"ada {ahead} commit lokal yang belum dipush.")
        if int(pub.git_ok(runner, "rev-list", "--count", "HEAD..origin/main") or 0):
            pub.git_ok(runner, "pull", "--ff-only", "origin", "main", timeout=pub.T_NET, what="git pull --ff-only")
    for older, newer in ((pre, post), (post, "HEAD")):
        if pub.git(runner, "merge-base", "--is-ancestor", older, newer).returncode:
            raise pub.Failure(2, f"{older[:12]} bukan leluhur {newer[:12]}; riwayat berubah, rollback manual.")
    touched = pub.git_ok(runner, "diff", "--name-only", pre, post).splitlines()
    outside = [p for p in touched if pub.dirty_kind(p) not in ("derived", "stockbit")]
    if outside:
        raise pub.Failure(2, "rentang commit menyentuh berkas di luar berkas Stockbit/docs/site: " + ", ".join(outside[:10]))
    return mode


def held_days(runner, target, mode):
    """{tgl: sha256 ekspor desk} untuk hari harian yang dibawa publish ini; "*" kalau sha tidak diketahui.

    Berkas yang dihapus publish ini (hari yang ditahan desk dari web) tidak dibawa, jadi harinya tidak ditahan rollback:
    rollback mengembalikan berkasnya, dan sinkron berikutnya mengikuti daftar tahanan desk lagi.
    """
    names = set(target.get("files") or [])
    if mode == "restore":
        changes = pub.changed_paths(runner)
        names |= {p.rsplit("/", 1)[-1] for status, p in changes if pub.stockbit_owned(p)}
        removed = {p.rsplit("/", 1)[-1] for status, p in changes if "D" in status and pub.stockbit_owned(p)}
        try:
            state_text = (pub.ROOT / pub.STATE_REL).read_text(encoding="utf-8")
        except OSError:
            state_text = ""
    else:
        diff = pub.git(runner, "diff", "--name-only", target["pre_sha"], target["post_sha"]).stdout or ""
        names |= {p.rsplit("/", 1)[-1] for p in diff.splitlines()}
        gone = pub.git(runner, "diff", "--diff-filter=D", "--name-only", target["pre_sha"], target["post_sha"]).stdout or ""
        removed = {p.rsplit("/", 1)[-1] for p in gone.splitlines()}
        state_text = pub.git(runner, "show", f"{target['post_sha']}:{pub.STATE_REL}").stdout or ""
    try:
        state_days = json.loads(state_text).get("days") or {}
    except (ValueError, AttributeError):
        state_days = {}
    out = {}
    for name in names - removed:
        match = pub.SB_FILE.search(name)
        if not match or match[1] == "sbpekan":
            continue  # rekap pekan ikut tertahan karena salah satu harinya tidak lagi eligible
        entry = state_days.get(match[2]) if isinstance(state_days, dict) else None
        fp = entry.get("fp") if isinstance(entry, dict) else None
        sha = str(fp).split("|", 1)[0] if fp else ""
        out[match[2]] = sha if sha and sha != "None" else "*"
    return out


def write_hold(days, key):
    """Gabungkan ke .stockbit-hold.json; kembalikan True kalau berkas ditulis.

    Entri yang sudah ada dipertahankan; untuk hari yang sama kolom lain (mis. withheld_by=desk dari sinkron) tetap ada.
    """
    if not days:
        return False
    path = pub.ROOT / pub.HOLD_REL
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


def discard_derived(runner, code):
    """docs/ dan site/ hanya hasil build (build.py menghapus dan membangun ulang folder itu)."""
    paths = pub.tracked_derived_paths(runner)
    if paths:
        pub.git_ok(runner, "checkout", "--", *paths, code=code, what="git checkout hasil build terlacak")
        pub.git_ok(runner, "clean", "-fdq", "--", *paths, code=code, what="git clean hasil build terlacak")


def restore_tree(runner):
    """Kembalikan berkas Stockbit yang kotor ke HEAD (berkas baru dihapus), kecuali berkas tahanan."""
    tracked = []
    for status, path in pub.changed_paths(runner):
        if not pub.stockbit_owned(path) or path == pub.HOLD_REL:
            continue
        if status == "??":
            (pub.ROOT / path).unlink(missing_ok=True)
        else:
            tracked.append(path)
    if tracked:
        pub.git_ok(runner, "checkout", "HEAD", "--", *tracked, code=3, what="git checkout HEAD -- <berkas Stockbit>")
    discard_derived(runner, 3)


def git_step(runner, target, plan, mode, record):
    key = plan["target"]
    days = held_days(runner, target, mode)
    record["held"] = days
    if mode == "revert":
        discard_derived(runner, 3)
        result = pub.git(runner, "revert", "--no-commit", plan["revert"], timeout=pub.T_GIT)
        if result.returncode:
            pub.git(runner, "revert", "--abort")
            raise pub.Failure(3, f"git revert gagal: {pub.output(result).strip()[-400:]}")
        if write_hold(days, key):
            pub.git_ok(runner, "add", "--", pub.HOLD_REL, code=3)
        result = pub.git(runner, "commit", "-q", "-m", f"Rollback Stockbit {key}", timeout=pub.T_GIT)
        if result.returncode:
            pub.git(runner, "revert", "--abort")
            raise pub.Failure(3, f"git commit revert gagal: {pub.output(result).strip()[-400:]}")
        record["revert_sha"] = pub.git_ok(runner, "rev-parse", "HEAD", code=3)
        if not pub.push(runner, "HEAD:main"):
            record["status"] = "push_failed"
            raise pub.Failure(4, "push revert gagal; commit revert ada di lokal (push manual: git push origin HEAD:main)")
        record["revert_sha"] = pub.git_ok(runner, "rev-parse", "HEAD", code=4)
    elif mode == "reset":
        discard_derived(runner, 3)
        pub.git_ok(runner, "reset", "--keep", target["pre_sha"], code=3, what="git reset --keep")
        record["reset_to"] = target["pre_sha"]
        write_hold(days, key)
    else:
        restore_tree(runner)
        write_hold(days, key)
    if mode != "revert" and days:
        pub.say(f"  tahanan ditulis ke {pub.HOLD_REL} (belum di-commit; ikut publish berikutnya)")
    record["git_done"] = True


def worker_step(runner, plan, record):
    version, expected = plan["worker_rollback_to"], plan["worker_expected_live"]
    if not version:
        record["worker_rolled_back"] = False
        return 5
    live = pub.worker_version(runner)
    if live and live == version:
        record["worker_rolled_back"] = True  # sudah di versi sebelum publish (mis. putaran partial sebelumnya)
        return 0
    if not expected or live != expected:
        record["worker_rolled_back"] = False
        pub.say(f"  Worker live {live or '(tidak terbaca)'} bukan versi yang di-deploy publish ini "
                f"({expected or 'tidak tercatat'}); tidak di-rollback otomatis supaya deploy yang lebih baru tidak terbuang.")
        return 5
    result = runner(pub.WRANGLER + ["rollback", version] + pub.WRANGLER_CONFIG +
                    ["--message", f"rollback {plan['target']}", "--yes"], timeout=pub.T_NET)
    record["worker_rolled_back"] = result.returncode == 0
    if result.returncode:
        pub.say(f"  Worker gagal di-rollback: {pub.output(result).strip()[-400:]}")
        return 5
    return 0


def rollback(args, runner=pub.run_command, which=shutil.which, log=None):
    log = log or pub.LOG
    summary = {"status": "dimulai", "dry_run": bool(args.dry_run)}
    record = {"type": "rollback", "started_at": pub.now_iso()}
    try:
        target, previous = choose(read_log(log), args.tag)
        plan = plan_for(target, previous)
        summary["plan"] = plan
        withheld = target.get("withheld") or []
        if withheld and not plan["git_done"]:
            # Membatalkan publish ini mengembalikan berkas hari yang ditahan desk (revert/reset/restore) dan Worker versi
            # sebelumnya yang masih memuatnya: hari itu terbit lagi padahal desk masih menahannya. Tidak diubah apa pun.
            raise pub.Failure(2, f"publish {plan['target']} mencabut hari yang ditahan desk dari web ({', '.join(map(str, withheld[:10]))}); "
                                 "rollback otomatis akan menerbitkannya lagi. Untuk mencabut isi lain dari publish ini, tahan harinya "
                                 "di Signal Desk lalu publish; untuk menerbitkan lagi hari yang ditahan, lepas tahanannya di desk lalu publish.")
        record.update(tag=plan["target"], covers=[plan["target"], *(target.get("supersedes") or [])],
                      reverted=plan["revert"], worker_rollback_to=plan["worker_rollback_to"])
        pub.say(f"rencana rollback {plan['target']} (status {plan['status']}, cara {plan['mode']}):")
        if plan["git_done"]:
            pub.say("  git: sudah dikembalikan oleh rollback sebelumnya (partial); dilewati")
        elif plan["mode"] == "restore":
            pub.say("  git: belum ada commit; berkas Stockbit yang kotor dikembalikan ke HEAD, docs/ dan site/ dibuang")
        elif plan["mode"] == "push_failed":
            pub.say(f"  git: {plan['revert']} (reset lokal kalau commit belum pernah dipush, selain itu revert + push)")
        else:
            pub.say(f"  git: revert {plan['revert']} + push")
        worker = plan["worker_rollback_to"]
        pub.say(f"  Worker: {'rollback ke ' + worker if worker else 'versi sebelumnya tidak tercatat, manual'}"
                f" (hanya kalau live = {plan['worker_expected_live'] or '? (tidak tercatat)'})")
        pub.say(f"  hari yang dibawa publish ini ditahan di {pub.HOLD_REL} sampai desk memfinalkannya ulang")
        pub.say("  lalu tools/sync_chat_index.py")
        if args.dry_run:
            summary["status"] = "dry-run"
            return 0, summary
        if plan["git_done"]:
            record["git_done"] = True
        else:
            mode = preflight(runner, target, plan, which)
            record["mode"] = mode
            git_step(runner, target, plan, mode, record)
        code = worker_step(runner, plan, record)
        if code == 5:
            pub.say("  Rollback Worker manual:\n"
                    "    npx wrangler@4.135.0 deployments list --config worker/wrangler.jsonc\n"
                    "    npx wrangler@4.135.0 rollback <version-id sebelum publish> --config worker/wrangler.jsonc --message rollback\n"
                    "  atau deploy ulang dari pohon yang sudah dikembalikan: python3 -B tools/publish_chat.py "
                    "(lalu commit docs/ dan site/)")
        if runner([sys.executable, "-B", "tools/sync_chat_index.py"], timeout=pub.T_INDEX, tee=True).returncode:
            code = code or 6
            pub.say("  sync_chat_index.py gagal; jalankan ulang: python3 -B tools/sync_chat_index.py")
        record["status"] = "rolled_back" if code == 0 else "partial"
        if code:
            pub.say("  rollback belum lengkap; jalankan skrip ini lagi setelah memperbaikinya (langkah git tidak diulang)")
        summary.update(status=record["status"], revert_sha=record.get("revert_sha"), held=sorted(record.get("held") or {}))
        return code, summary
    except pub.Failure as e:
        summary.update(status="gagal", error=str(e))
        record.setdefault("status", "gagal")
        pub.say(f"GAGAL: {e}")
        return e.code, summary
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
