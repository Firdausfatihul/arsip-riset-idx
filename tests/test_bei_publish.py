"""publish_stockbit.py / rollback_stockbit.py with BEI files on the VPS flow: injected command runner (the FakeRunner of
test_stockbit_publish.py, which fails on any wrangler/build_worker call), no git push,
node, ssh, network or deploy."""
import io
import json
from contextlib import redirect_stdout
from datetime import datetime
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools")); sys.path.insert(0, str(ROOT / "tests"))
import publish_stockbit as pub  # noqa: E402
import rollback_stockbit as rb  # noqa: E402
from test_stockbit_publish import FakeRunner, SB, VPS_PUSH, build_stdout  # noqa: E402

DEST = "needtobeindexed/idx-signal-desk/"
BEI = ["beiringkas_2026-10-05_2026-10-05.md", "beidetail_2026-10-05_2026-10-05.md"]
BOTH_BUILD = build_stdout([(SB[0], "stockbit-ringkasan", "2026-10-05"), (SB[1], "stockbit-detail", "2026-10-05"),
                           (BEI[0], "bei-ringkasan", "2026-10-05"), (BEI[1], "bei-detail", "2026-10-05")])
# The retired Worker deploy tools: publish never runs them.
NEVER_RUN = ("wrangler", "npx", "build_worker")


def status(*paths, code="??"):
    return "".join(f"{code} {p}\0" for p in paths)


def temp_build(r, line):
    """Temporary build check (build.py --out /tmp/...): both families; the docs/ rebuild: plain success."""
    return r.result(0, BOTH_BUILD) if line.split("--out ")[1] != "docs" else r.result(0, "")


class BeiPublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dest = self.root / pub.desk.FOLDER; self.dest.mkdir(parents=True)
        for n in SB + BEI:
            (self.dest / n).write_text("x")
        (self.root / ".local").mkdir(); (self.root / pub.VPS_CONFIG_REL).write_text("{}")
        self.log = self.root / ".stockbit-publish/log.jsonl"
        p = patch.object(pub, "ROOT", self.root); p.start(); self.addCleanup(p.stop)

    def publish(self, runner, dry_run=False, **extra):
        with redirect_stdout(io.StringIO()) as out:
            code, summary = pub.publish(SimpleNamespace(dry_run=dry_run, **extra), runner=runner, which=lambda t: "/bin/" + t,
                                        disk_usage=lambda p: SimpleNamespace(free=10e9), log=self.log,
                                        clock=lambda: datetime(2026, 10, 9, 10, 0, 0))
        self.output = out.getvalue()
        return code, summary

    def records(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []

    def no_worker_deploy(self, runner):
        return not [c for c in runner.calls if any(n in c for n in NEVER_RUN)]

    def runner(self, files, **extra):
        paths = [DEST + n for n in files]
        names = "".join(f"{p}\n" for p in paths) + "docs/index.html\n"
        return FakeRunner(**{"git status": lambda r, l: r.result(0, " M docs/index.html\0" + status(*paths)),
                             "git diff --cached --name-only": lambda r, l: r.result(0, names),
                             "build.py --out": temp_build, **extra})

    def test_one_publish_syncs_both_pushes_vps_once_and_commits_both(self):
        (self.dest / ".sync-stockbit.json").write_text(json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "sbS|t|final"}}}))
        (self.dest / ".sync-bei.json").write_text(json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "beiS|d|t|final"}}}))
        runner = self.runner(SB[:1] + BEI[:1] + ["bei-index.json", ".sync-bei.json"])
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        sync = runner.calls[runner.index("sync_idx.py")]
        self.assertIn("sync_idx.py --stockbit-only --no-build --with-bei", sync)
        # VPS flow: temporary build check, docs/ rebuild, VPS push BEFORE git add/commit; never Cloudflare.
        order = ["sync_idx.py", "build.py --out /", "build.py --out docs", VPS_PUSH, "git add --", "git commit",
                 "git push origin HEAD:main", "git tag -a stockbit-publish-20261009-100000"]
        positions = [runner.index(n) for n in order]
        self.assertEqual(positions, sorted(positions), runner.calls)
        self.assertEqual(runner.state["vps"], 1)
        self.assertTrue(self.no_worker_deploy(runner), runner.calls)
        add = runner.calls[runner.index("git add --")]
        for name in (SB[0], BEI[0], "bei-index.json", ".sync-bei.json"):
            self.assertIn(DEST + name, add)
        self.assertEqual(summary["message"], "Stockbit: ringkasan 2026-10-05 · BEI: ringkasan 2026-10-05")
        self.assertEqual(summary["supports"], ["stockbit", "bei"])
        self.assertEqual((summary["status"], summary["vps"]), ("published", True))
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["target"], rec["vps"]), ("published", "vps", True))
        self.assertIn(BEI[0], rec["files"])
        self.assertIn("bei-index.json", rec["files"])
        # Per-day export shas sent to the VPS, one map per family (Stockbit's day_shas unchanged by BEI).
        self.assertEqual(rec["day_shas"], {"2026-10-05": "sbS"})
        self.assertEqual(rec["day_shas_bei"], {"2026-10-05": "beiS"})
        self.assertFalse([k for k in rec if k.startswith("worker_") or k == "rollback_to"])

    def test_range_start_forwarded_next_to_with_bei(self):
        runner = self.runner(SB[:1] + BEI[:1])
        self.assertEqual(self.publish(runner, stockbit_since="2026-09-01")[0], 0, self.output)
        self.assertIn("sync_idx.py --stockbit-only --no-build --stockbit-since 2026-09-01 --with-bei",
                      runner.calls[runner.index("sync_idx.py")])

    def test_skipped_bei_is_reported_and_capability_marked(self):
        note = ("  peringatan: BEI dilewati, tidak ada berkas BEI yang diubah: ekspor dari profil desk 'sona', padahal "
                "profil BEI yang tercatat di .sync-bei.json '10-11-august'.\n")
        runner = self.runner(SB[:1], **{"sync_idx.py": lambda r, l: r.result(0, "Stockbit: 1 berkas\n" + note)})
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        self.assertEqual(runner.state["vps"], 1)  # Stockbit still goes live
        self.assertIn("bei", summary["supports"])
        self.assertIn("'sona'", summary["bei_skipped"])
        code, summary = self.publish(self.runner(SB[:1] + BEI[:1]))
        self.assertNotIn("bei_skipped", summary)
        # A run with nothing to publish still reports the capability (the desk reads it from any summary).
        nothing = FakeRunner(**{"git status": lambda r, l: r.result(0, "")})
        code, summary = self.publish(nothing)
        self.assertEqual((code, summary["status"], summary["supports"]), (0, "tidak ada perubahan", ["stockbit", "bei"]))
        self.assertEqual(nothing.state["vps"], 0)

    def test_bei_only_change_is_published_with_bei_message(self):
        runner = self.runner(BEI + ["bei-index.json"])
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        self.assertEqual(summary["message"], "BEI: ringkasan 2026-10-05")
        self.assertEqual(runner.state["vps"], 1)
        self.assertTrue(self.no_worker_deploy(runner))
        rec = self.records()[-1]
        self.assertEqual(rec["day_shas"], {})  # no Stockbit day in this publish
        self.assertEqual(rec["day_shas_bei"], {"2026-10-05": "*"})  # no .sync-bei.json in the tree: unknown sha

    def test_commit_messages(self):
        msg = pub.commit_message
        self.assertEqual(msg([SB[0], BEI[0]]), "Stockbit: ringkasan 2026-10-05 · BEI: ringkasan 2026-10-05")
        self.assertEqual(msg([BEI[0], "beipekan_2026-09-28_2026-10-04.md"]), "BEI: ringkasan 2026-10-05 · pekan 2026-09-28..2026-10-04")
        self.assertEqual(msg([DEST + "bei-index.json"]), "BEI: ringkasan pembaruan indeks/situs")
        self.assertEqual(msg(["beiringkas_2026-10-03_2026-10-03.md"], ["beiringkas_2026-10-03_2026-10-03.md"]),
                         "BEI: tahan 2026-10-03 dari web")
        self.assertEqual(msg([SB[0], "beiringkas_2026-10-03_2026-10-03.md"], ["beiringkas_2026-10-03_2026-10-03.md"]),
                         "Stockbit: ringkasan 2026-10-05 · BEI: tahan 2026-10-03 dari web")
        self.assertEqual(msg(["docs/index.html"]), "Stockbit: ringkasan pembaruan indeks/situs")

    def test_digest_still_refused_bei_dot_files_allowed(self):
        runner = self.runner([], **{"git status": lambda r, l: r.result(0, status(DEST + "digest_2026-10-01_2026-10-02.md", code=" M"))})
        self.assertEqual(self.publish(runner)[0], 2)
        self.assertIn("bei*.md", self.output)
        self.assertEqual(runner.state["vps"], 0)
        ok = self.runner([".bei-hold.json", ".sync-bei.json", "bei-index.json"])
        self.assertEqual(self.publish(ok)[0], 0, self.output)
        self.assertEqual([pub.dirty_kind(DEST + n) for n in (BEI[0], ".bei-hold.json", ".sync.json", "digest_x.md")],
                         ["bei", "bei", "ignored", "other"])

    def test_build_check_covers_bei_categories(self):
        bad = build_stdout([(SB[0], "stockbit-ringkasan", "2026-10-05"), (SB[1], "stockbit-detail", "2026-10-05"),
                            (BEI[0], "keterbukaan-informasi", "2026-10-05"), (BEI[1], "bei-detail", "2026-10-05")])
        runner = self.runner(BEI[:1], **{"build.py --out": lambda r, l: r.result(0, bad)})
        self.assertEqual(self.publish(runner)[0], 4)
        self.assertIn("keterbukaan-informasi", self.output)
        self.assertEqual(runner.state["vps"], 0)
        self.assertFalse([c for c in runner.calls if c.endswith("build.py --out docs") or c.startswith("git add")])
        missing = build_stdout([(SB[0], "stockbit-ringkasan", "2026-10-05"), (SB[1], "stockbit-detail", "2026-10-05")])
        with self.assertRaises(pub.Failure):
            pub.check_build(missing, SB + BEI)

    def test_sync_refusal_stops_before_build_and_vps(self):
        runner = self.runner(BEI[:1], **{"sync_idx.py": lambda r, l: r.result(1, "BEI ditolak, tidak ada berkas yang ditulis")})
        self.assertEqual(self.publish(runner)[0], 3)
        self.assertFalse([c for c in runner.calls if "build.py" in c or c == VPS_PUSH or c.startswith("git add")])
        self.assertEqual(self.records()[-1]["status"], "gagal")

    def test_deleted_bei_copy_in_rebuilt_docs_stops_before_vps(self):
        stale = "docs/files/bei-ringkasan/2026-10-01/beiringkas_2026-10-01_2026-10-01.md"
        def st(r, l):
            built = any(c.endswith("build.py --out docs") for c in r.calls)
            return r.result(0, f"?? {DEST}{BEI[0]}\0" + (f" D {stale}\0" if built else ""))
        runner = self.runner([], **{"git status": st})
        code, summary = self.publish(runner)
        self.assertEqual(code, 7, self.output)
        self.assertIn(stale, summary["error"])
        self.assertEqual(runner.state["vps"], 0)
        self.assertIn("git checkout -- docs", runner.calls)
        self.assertEqual(self.records()[-1]["status"], "gagal")

    def withheld_runner(self, hold_days, deleted, staged_days=None, derived=()):
        hold = json.dumps({"format": 1, "days": hold_days})
        (self.dest / ".bei-hold.json").write_text(hold)
        staged = hold if staged_days is None else json.dumps({"format": 1, "days": staged_days})
        paths = [DEST + n for n in deleted] + list(derived)
        st = "".join(f" D {p}\0" for p in paths) + f" M {DEST}.bei-hold.json\0 M docs/index.html\0"
        names = "".join(f"{p}\n" for p in paths) + f"{DEST}.bei-hold.json\ndocs/index.html\n"
        return FakeRunner(**{"git status": lambda r, l: r.result(0, st),
                             "--diff-filter=D": lambda r, l: r.result(0, "".join(f"{p}\n" for p in paths)),
                             "git diff --cached --name-only": lambda r, l: r.result(0, names),
                             f"git show :{DEST}.bei-hold.json": lambda r, l: r.result(0, staged),
                             "build.py --out": temp_build})

    DESK = {"sha256": "*", "withheld_by": "desk"}

    def test_desk_withheld_bei_deletions_committed_and_logged(self):
        deleted = ["beiringkas_2026-10-03_2026-10-03.md", "beidetail_2026-10-03_2026-10-03.md", "beipekan_2026-09-28_2026-10-04.md"]
        copies = ["docs/files/bei-ringkasan/2026-10-03/beiringkas_2026-10-03_2026-10-03.md",
                  "docs/files/bei-pekan/2026-09-28/beipekan_2026-09-28_2026-10-04.md"]
        runner = self.withheld_runner({"2026-10-03": self.DESK}, deleted, derived=copies)
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        self.assertEqual(runner.state["vps"], 1)
        self.assertEqual(summary["message"], "BEI: tahan 2026-10-03 dari web")
        self.assertEqual(summary["withheld_bei"], ["2026-10-03"])
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["withheld_bei"]), ("published", ["2026-10-03"]))
        self.assertNotIn("withheld", rec)
        # The Stockbit hold file is not read for a BEI-only deletion.
        self.assertFalse([c for c in runner.calls if c == f"git show :{pub.rel(pub.desk.STOCKBIT.hold)}"])
        # A Stockbit hold does not cover a BEI deletion, and vice versa; docs/ copies follow their family.
        self.assertFalse(pub.withheld_deletion(DEST + deleted[0], {"stockbit": {"2026-10-03"}, "bei": set()}))
        self.assertFalse(pub.withheld_deletion(DEST + "sbringkas_2026-10-03_2026-10-03.md", {"bei": {"2026-10-03"}}))
        self.assertTrue(pub.withheld_deletion("docs/files/bei-pekan/2026-09-28/" + deleted[2], {"bei": {"2026-10-03"}}))
        # Another BEI day disappearing, or a hold without withheld_by=desk: refused in preflight, VPS untouched.
        other = self.withheld_runner({"2026-10-03": self.DESK}, deleted + ["beiringkas_2026-10-02_2026-10-02.md"])
        self.assertEqual(self.publish(other)[0], 2)
        self.assertEqual(other.state["vps"], 0)
        rollback_only = self.withheld_runner({"2026-10-03": {"sha256": "*", "rollback_of": "t"}}, deleted)
        self.assertEqual(self.publish(rollback_only)[0], 2)
        self.assertEqual(rollback_only.state["vps"], 0)
        # The staged hold (what would be committed) no longer withholds the day: index guard after the VPS push, exit 7,
        # nothing committed, staged files released, record vps_not_committed (main's semantics for sb*).
        staged_differs = self.withheld_runner({"2026-10-03": self.DESK}, deleted, staged_days={})
        self.assertEqual(self.publish(staged_differs)[0], 7)
        self.assertEqual(staged_differs.state["vps"], 1)
        self.assertFalse([c for c in staged_differs.calls if c.startswith(("git commit", "git push"))])
        self.assertTrue([c for c in staged_differs.calls if c.startswith("git reset -q --")])
        self.assertEqual(self.records()[-1]["status"], "vps_not_committed")


HOLD_SB = DEST + ".stockbit-hold.json"
HOLD_BEI = DEST + ".bei-hold.json"


class BeiRollbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        p = patch.object(pub, "ROOT", self.root); p.start(); self.addCleanup(p.stop)
        (self.root / ".local").mkdir(); (self.root / pub.VPS_CONFIG_REL).write_text("{}")
        self.log = self.root / ".stockbit-publish/log.jsonl"
        self.log.parent.mkdir()
        self.write([{"type": "publish", "status": "published", "target": "vps", "vps": True,
                     "tag": "stockbit-publish-20261009-100000", "pre_sha": "b0", "post_sha": "b1", "files": [SB[0], BEI[0]]}])

    def write(self, rows):
        self.log.write_text("".join(json.dumps(r) + "\n" for r in rows))

    def last(self):
        return json.loads(self.log.read_text().splitlines()[-1])

    def rollback(self, runner, dry_run=False):
        with redirect_stdout(io.StringIO()) as out:
            code, summary = rb.rollback(SimpleNamespace(tag=None, dry_run=dry_run), runner=runner,
                                        which=lambda t: "/bin/" + t, log=self.log)
        self.output = out.getvalue()
        return code, summary

    def runner(self, **overrides):
        sb_state = json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "shaX|t1|final"}}})
        bei_state = json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "beiR|beiD|t1|final"}}})
        base = {"git status": lambda r, l: r.result(0, f"?? {DEST}.sync-abc123\0"),
                f"git show b1:{DEST}.sync-bei.json": lambda r, l: r.result(0, bei_state),
                "git show b1:": lambda r, l: r.result(0, sb_state),
                "git diff --name-only": lambda r, l: r.result(0, f"docs/index.html\n{DEST}{SB[0]}\n{DEST}{BEI[0]}\n{DEST}bei-index.json\n")}
        return FakeRunner(**{**base, **overrides})

    def test_revert_allows_bei_range_holds_bei_days_then_pushes_vps(self):
        runner = self.runner()
        code, summary = self.rollback(runner)
        self.assertEqual(code, 0, self.output)
        order = ["git fetch origin main", "git revert --no-commit b0..b1", f"git add -- {HOLD_SB}", f"git add -- {HOLD_BEI}",
                 "git commit -q -m Rollback Stockbit", "git push origin HEAD:main", VPS_PUSH]
        positions = [runner.index(n) for n in order]
        self.assertEqual(positions, sorted(positions), runner.calls)
        self.assertEqual(runner.state["vps"], 1)
        self.assertFalse([c for c in runner.calls if any(n in c for n in NEVER_RUN)])
        bei_hold = json.loads((self.root / HOLD_BEI).read_text())["days"]
        self.assertEqual(bei_hold, {"2026-10-05": {"sha256": "beiR", "rollback_of": "stockbit-publish-20261009-100000"}})
        sb_hold = json.loads((self.root / HOLD_SB).read_text())["days"]
        self.assertEqual(sb_hold["2026-10-05"]["sha256"], "shaX")
        self.assertEqual((summary["status"], summary["vps"], summary["held_bei"]), ("rolled_back", True, ["2026-10-05"]))
        rec = self.last()
        self.assertEqual((rec["status"], rec["target"], rec["held_bei"]), ("rolled_back", "vps", {"2026-10-05": "beiR"}))

    def test_stockbit_only_publish_reads_no_bei_state(self):
        self.write([{"type": "publish", "status": "published", "target": "vps", "tag": "t1", "pre_sha": "b0", "post_sha": "b1",
                     "files": [SB[0]]}])
        runner = self.runner(**{"git diff --name-only": lambda r, l: r.result(0, f"docs/index.html\n{DEST}{SB[0]}\n")})
        code, summary = self.rollback(runner)
        self.assertEqual(code, 0, self.output)
        self.assertFalse([c for c in runner.calls if ".sync-bei.json" in c or HOLD_BEI in c])
        self.assertFalse((self.root / HOLD_BEI).exists())
        self.assertNotIn("held_bei", summary)

    def test_foreign_range_still_refused(self):
        foreign = self.runner(**{"git diff --name-only": lambda r, l: r.result(0, f"{DEST}{BEI[0]}\n{DEST}digest_x.md\n")})
        self.assertEqual(self.rollback(foreign)[0], 2)
        self.assertFalse([c for c in foreign.calls if "revert" in c or c == VPS_PUSH])

    def test_bei_withholding_publish_is_refused(self):
        rows = [json.loads(l) for l in self.log.read_text().splitlines()]
        rows[-1]["withheld_bei"] = ["2026-10-03"]
        self.write(rows)
        runner = self.runner()
        code, summary = self.rollback(runner)
        self.assertEqual(code, 2)
        self.assertIn("ditahan desk", summary["error"])
        self.assertIn("BEI 2026-10-03", summary["error"])
        self.assertEqual(runner.calls, [])

    def test_restore_mode_restores_bei_files_and_holds_recorded_bei_sha(self):
        # vps_not_committed: day_shas_bei (recorded before the VPS push) wins over the re-synced working-tree state (beiY);
        # an old record without it holds "*".
        legacy = {"status": "vps_not_committed"}
        for label, fields in (("vps", {"status": "vps_not_committed", "target": "vps", "vps": True,
                                       "day_shas_bei": {"2026-10-05": "beiL"}}), ("legacy", legacy)):
            with self.subTest(label):
                self.write([{"type": "publish", "started_at": "s-" + label, "pre_sha": None, "post_sha": None,
                             "files": [BEI[0]], **fields}])
                dest = self.root / pub.desk.FOLDER; dest.mkdir(parents=True, exist_ok=True)
                (dest / BEI[0]).write_text("new day")
                (dest / ".sync-bei.json").write_text(json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "beiY|d|t|final"}}}))
                st = f" M docs/index.html\0?? {DEST}{BEI[0]}\0 M {DEST}bei-index.json\0 M {DEST}.sync-bei.json\0"
                runner = self.runner(**{"git status": lambda r, l: r.result(0, st)})
                code, _ = self.rollback(runner)
                self.assertEqual(code, 0, self.output)
                self.assertFalse((dest / BEI[0]).exists())
                self.assertIn(f"git checkout HEAD -- {DEST}bei-index.json {DEST}.sync-bei.json", runner.calls)
                self.assertFalse([c for c in runner.calls if c.startswith(("git fetch", "git revert", "git push", "git pull"))])
                self.assertLess(runner.index("git checkout -- docs"), runner.index(VPS_PUSH))
                self.assertEqual(json.loads((self.root / HOLD_BEI).read_text())["days"]["2026-10-05"]["sha256"],
                                 "beiL" if label == "vps" else "*")
                self.assertFalse((self.root / HOLD_SB).exists())
                self.assertIn(HOLD_BEI, self.output)
                (self.root / HOLD_BEI).unlink()
                self.assertEqual(self.last()["status"], "rolled_back")

    def test_resumed_rollback_refuses_unpublished_bei_files_but_allows_bei_hold(self):
        self.assertEqual(self.rollback(self.runner(**{VPS_PUSH: lambda r, l: r.result(1, "Gagal")}))[0], 5, self.output)
        self.assertEqual(self.last()["status"], "partial")
        stale = f" M {DEST}bei-index.json\0?? {DEST}beiringkas_2026-10-09_2026-10-09.md\0 M docs/index.html\0"
        runner = self.runner(**{"git status": lambda r, l: r.result(0, stale)})
        code, summary = self.rollback(runner)
        self.assertEqual(code, 2, self.output)
        self.assertIn("beiringkas_2026-10-09_2026-10-09.md", summary["error"])
        self.assertFalse([c for c in runner.calls if c == VPS_PUSH or c.startswith(("git push", "git revert", "git checkout"))])
        ok = self.runner(**{"git status": lambda r, l: r.result(0, f" M {HOLD_SB}\0 M {HOLD_BEI}\0 M docs/index.html\0")})
        self.assertEqual(self.rollback(ok)[0], 0, self.output)
        self.assertFalse([c for c in ok.calls if "revert" in c])
        self.assertLess(ok.index("git checkout -- docs"), ok.index(VPS_PUSH))
        self.assertEqual(self.last()["status"], "rolled_back")

    def test_first_revert_or_reset_refuses_untracked_unpublished_files_but_allows_hold_files(self):
        """A later publish synced a new sb*/bei* day, then failed its build check (or the VPS push): the file is left
        untracked. `vps.mjs push` sends untracked files, so a first-run revert/reset must refuse before git or the VPS."""
        reset = {"is-ancestor b1 origin/main": lambda r, l: r.result(1),
                 "git rev-parse HEAD": lambda r, l: r.result(0, "b1\n") if l == "git rev-parse HEAD" else r.default(l)}
        cases = [(name, mode) for name in ("beiringkas_2026-10-11_2026-10-11.md", "beidetail_2026-10-11_2026-10-11.md",
                                           "sbringkas_2026-10-11_2026-10-11.md", "sbpekan_2026-10-05_2026-10-11.md")
                 for mode in ("revert", "reset")]
        for name, mode in cases:
            with self.subTest(name=name, mode=mode):
                self.setUp()
                if mode == "reset":
                    self.write([{"type": "publish", "status": "push_failed", "target": "vps", "vps": True, "started_at": "s1",
                                 "pre_sha": "b0", "post_sha": "b1", "files": [SB[0], BEI[0]]}])
                runner = self.runner(**{"git status": lambda r, l: r.result(0, status(f"{DEST}{name}", f"{DEST}.sync-abc123")),
                                        **(reset if mode == "reset" else {})})
                code, summary = self.rollback(runner)
                self.assertEqual(code, 2, self.output)
                self.assertIn(name, summary["error"])
                self.assertIn("belum terbit", summary["error"])
                self.assertFalse([c for c in runner.calls
                                  if c == VPS_PUSH or c.startswith(("git push", "git revert", "git reset", "git checkout"))])
                self.assertFalse((self.root / HOLD_BEI).exists())
                self.assertEqual(self.last()["status"], "gagal")
        # Untracked hold files (written by an earlier reset/restore rollback, committed with the next publish) are fine.
        self.setUp()
        runner = self.runner(**{"git status": lambda r, l: r.result(0, status(f"{DEST}.sync-abc123", HOLD_SB, HOLD_BEI))})
        self.assertEqual(self.rollback(runner)[0], 0, self.output)
        self.assertEqual(runner.state["vps"], 1)


if __name__ == "__main__":
    unittest.main()
