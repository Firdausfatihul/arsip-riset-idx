"""publish_stockbit.py / rollback_stockbit.py with BEI files: injected command runner, no git, npx, network or deploy."""
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
from test_stockbit_publish import FakeRunner, DEPLOYMENTS, SB, build_stdout  # noqa: E402

DEST = "needtobeindexed/idx-signal-desk/"
BEI = ["beiringkas_2026-10-05_2026-10-05.md", "beidetail_2026-10-05_2026-10-05.md"]
BOTH_BUILD = build_stdout([(SB[0], "stockbit-ringkasan", "2026-10-05"), (SB[1], "stockbit-detail", "2026-10-05"),
                           (BEI[0], "bei-ringkasan", "2026-10-05"), (BEI[1], "bei-detail", "2026-10-05")])


def status(*paths, code="??"):
    return "".join(f"{code} {p}\0" for p in paths)


class BeiPublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dest = self.root / pub.DEST_REL; self.dest.mkdir(parents=True)
        for n in SB + BEI:
            (self.dest / n).write_text("x")
        self.log = self.root / ".stockbit-publish/log.jsonl"
        p = patch.object(pub, "ROOT", self.root); p.start(); self.addCleanup(p.stop)

    def publish(self, runner, dry_run=False):
        with redirect_stdout(io.StringIO()) as out:
            code, summary = pub.publish(SimpleNamespace(dry_run=dry_run), runner=runner, which=lambda t: "/bin/" + t,
                                        disk_usage=lambda p: SimpleNamespace(free=10e9), log=self.log,
                                        clock=lambda: datetime(2026, 10, 9, 10, 0, 0))
        self.output = out.getvalue()
        return code, summary

    def records(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []

    def runner(self, files, **extra):
        paths = [DEST + n for n in files]
        names = "".join(f"{p}\n" for p in paths) + "docs/index.html\n"
        return FakeRunner(**{"git status": lambda r, l: r.result(0, " M docs/index.html\0" + status(*paths)),
                             "git diff --cached --name-only": lambda r, l: r.result(0, names),
                             "build.py --out": lambda r, l: r.result(0, BOTH_BUILD), **extra})

    def test_one_publish_syncs_both_and_commits_both(self):
        runner = self.runner(SB[:1] + BEI[:1] + ["bei-index.json", ".sync-bei.json"])
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        sync = runner.calls[runner.index("sync_idx.py")]
        self.assertIn("--stockbit-only --no-build --with-bei", sync)
        add = runner.calls[runner.index("git add --")]
        for name in (SB[0], BEI[0], "bei-index.json", ".sync-bei.json"):
            self.assertIn(DEST + name, add)
        self.assertEqual(summary["message"], "Stockbit: ringkasan 2026-10-05 · BEI: ringkasan 2026-10-05")
        rec = self.records()[-1]
        self.assertEqual(rec["status"], "published")
        self.assertIn(BEI[0], rec["files"])
        self.assertIn("bei-index.json", rec["files"])

    def test_skipped_bei_is_reported_and_capability_marked(self):
        note = ("  peringatan: BEI dilewati, tidak ada berkas BEI yang diubah: ekspor dari profil desk 'sona', padahal "
                "profil BEI yang tercatat di .sync-bei.json '10-11-august'.\n")
        runner = self.runner(SB[:1], **{"sync_idx.py": lambda r, l: r.result(0, "Stockbit: 1 berkas\n" + note)})
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        self.assertIn("bei", summary["supports"])
        self.assertIn("'sona'", summary["bei_skipped"])
        code, summary = self.publish(self.runner(SB[:1] + BEI[:1]))
        self.assertNotIn("bei_skipped", summary)

    def test_bei_only_change_is_published_with_bei_message(self):
        runner = self.runner(BEI + ["bei-index.json"])
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        self.assertEqual(summary["message"], "BEI: ringkasan 2026-10-05")
        self.assertTrue([c for c in runner.calls if "publish_chat.py" in c])

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
        self.assertFalse([c for c in runner.calls if "publish_chat" in c])
        missing = build_stdout([(SB[0], "stockbit-ringkasan", "2026-10-05"), (SB[1], "stockbit-detail", "2026-10-05")])
        with self.assertRaises(pub.Failure):
            pub.check_build(missing, SB + BEI)

    def test_sync_refusal_stops_before_build_and_deploy(self):
        runner = self.runner(BEI[:1], **{"sync_idx.py": lambda r, l: r.result(1, "BEI ditolak, tidak ada berkas yang ditulis")})
        self.assertEqual(self.publish(runner)[0], 3)
        self.assertFalse([c for c in runner.calls if "build.py" in c or "publish_chat" in c or c.startswith("git add")])

    def withheld_runner(self, hold_days, deleted, staged_days=None):
        hold = json.dumps({"format": 1, "days": hold_days})
        (self.dest / ".bei-hold.json").write_text(hold)
        staged = hold if staged_days is None else json.dumps({"format": 1, "days": staged_days})
        paths = [DEST + n for n in deleted]
        st = "".join(f" D {p}\0" for p in paths) + f" M {DEST}.bei-hold.json\0 M docs/index.html\0"
        names = "".join(f"{p}\n" for p in paths) + f"{DEST}.bei-hold.json\ndocs/index.html\n"
        return FakeRunner(**{"git status": lambda r, l: r.result(0, st),
                             "--diff-filter=D": lambda r, l: r.result(0, "".join(f"{p}\n" for p in paths)),
                             "git diff --cached --name-only": lambda r, l: r.result(0, names),
                             f"git show :{DEST}.bei-hold.json": lambda r, l: r.result(0, staged),
                             "build.py --out": lambda r, l: r.result(0, BOTH_BUILD)})

    DESK = {"sha256": "*", "withheld_by": "desk"}

    def test_desk_withheld_bei_deletions_committed_and_logged(self):
        deleted = ["beiringkas_2026-10-03_2026-10-03.md", "beidetail_2026-10-03_2026-10-03.md", "beipekan_2026-09-28_2026-10-04.md"]
        runner = self.withheld_runner({"2026-10-03": self.DESK}, deleted)
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        self.assertEqual(summary["message"], "BEI: tahan 2026-10-03 dari web")
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["withheld_bei"]), ("published", ["2026-10-03"]))
        self.assertNotIn("withheld", rec)
        # A Stockbit hold does not cover a BEI deletion, and a BEI deletion of another day is refused.
        self.assertFalse(pub.withheld_deletion(DEST + deleted[0], {"stockbit": {"2026-10-03"}, "bei": set()}))
        self.assertFalse(pub.withheld_deletion(DEST + deleted[0], {"2026-10-03"}))
        self.assertTrue(pub.withheld_deletion("docs/files/bei-pekan/2026-09-28/" + deleted[2], {"bei": {"2026-10-03"}}))
        other = self.withheld_runner({"2026-10-03": self.DESK}, deleted + ["beiringkas_2026-10-02_2026-10-02.md"])
        self.assertEqual(self.publish(other)[0], 2)
        rollback_only = self.withheld_runner({"2026-10-03": {"sha256": "*", "rollback_of": "t"}}, deleted)
        self.assertEqual(self.publish(rollback_only)[0], 2)
        staged_differs = self.withheld_runner({"2026-10-03": self.DESK}, deleted, staged_days={})
        self.assertEqual(self.publish(staged_differs)[0], 7)
        self.assertFalse([c for c in staged_differs.calls if c.startswith(("git commit", "git push"))])


HOLD_BEI = DEST + ".bei-hold.json"


class BeiRollbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        p = patch.object(pub, "ROOT", self.root); p.start(); self.addCleanup(p.stop)
        self.log = self.root / ".stockbit-publish/log.jsonl"
        self.log.parent.mkdir()
        self.write([{"type": "publish", "status": "published", "tag": "stockbit-publish-20261009-100000", "pre_sha": "b0",
                     "post_sha": "b1", "worker_version_before": "v-b", "worker_version_after": "v-live", "files": [SB[0], BEI[0]]}])

    def write(self, rows):
        self.log.write_text("".join(json.dumps(r) + "\n" for r in rows))

    def rollback(self, runner, dry_run=False):
        with redirect_stdout(io.StringIO()) as out:
            code, summary = rb.rollback(SimpleNamespace(tag=None, dry_run=dry_run), runner=runner,
                                        which=lambda t: "/bin/" + t, log=self.log)
        self.output = out.getvalue()
        return code, summary

    def runner(self, **overrides):
        sb_state = json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "shaX|t1|final"}}})
        bei_state = json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "beiR|beiD|t1|final"}}})
        base = {"git status": lambda r, l: r.result(0, "?? notes.txt\0"),
                f"git show b1:{DEST}.sync-bei.json": lambda r, l: r.result(0, bei_state),
                "git show b1:": lambda r, l: r.result(0, sb_state),
                "git diff --name-only": lambda r, l: r.result(0, f"docs/index.html\n{DEST}{SB[0]}\n{DEST}{BEI[0]}\n{DEST}bei-index.json\n")}
        return FakeRunner(**{**base, **overrides})

    def test_revert_allows_bei_range_and_holds_bei_days_separately(self):
        runner = self.runner()
        code, summary = self.rollback(runner)
        self.assertEqual(code, 0, self.output)
        self.assertIn("git revert --no-commit b0..b1", runner.calls)
        self.assertIn(f"git add -- {HOLD_BEI}", runner.calls)
        self.assertLess(runner.index(f"git add -- {HOLD_BEI}"), runner.index("git commit -q -m Rollback Stockbit"))
        bei_hold = json.loads((self.root / HOLD_BEI).read_text())["days"]
        self.assertEqual(bei_hold, {"2026-10-05": {"sha256": "beiR", "rollback_of": "stockbit-publish-20261009-100000"}})
        sb_hold = json.loads((self.root / DEST / ".stockbit-hold.json").read_text())["days"]
        self.assertEqual(sb_hold["2026-10-05"]["sha256"], "shaX")
        self.assertEqual(summary["held_bei"], ["2026-10-05"])

    def test_foreign_range_still_refused(self):
        foreign = self.runner(**{"git diff --name-only": lambda r, l: r.result(0, f"{DEST}{BEI[0]}\n{DEST}digest_x.md\n")})
        self.assertEqual(self.rollback(foreign)[0], 2)
        self.assertFalse([c for c in foreign.calls if "revert" in c])

    def test_bei_withholding_publish_is_refused(self):
        rows = [json.loads(l) for l in self.log.read_text().splitlines()]
        rows[-1]["withheld_bei"] = ["2026-10-03"]
        self.write(rows)
        runner = self.runner()
        code, summary = self.rollback(runner)
        self.assertEqual(code, 2)
        self.assertIn("ditahan desk", summary["error"])
        self.assertEqual(runner.calls, [])

    def test_restore_mode_restores_bei_files_and_writes_bei_hold(self):
        self.write([{"type": "publish", "status": "deployed_index_pending", "started_at": "s1", "pre_sha": None, "post_sha": None,
                     "worker_version_before": "v-b", "worker_version_after": "v-live", "files": [BEI[0]]}])
        dest = self.root / pub.DEST_REL; dest.mkdir(parents=True)
        (dest / BEI[0]).write_text("new day")
        (dest / ".sync-bei.json").write_text(json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "beiY|d|t|final"}}}))
        st = (f" M docs/index.html\0?? {DEST}{BEI[0]}\0 M {DEST}bei-index.json\0 M {DEST}.sync-bei.json\0")
        runner = self.runner(**{"git status": lambda r, l: r.result(0, st)})
        code, _ = self.rollback(runner)
        self.assertEqual(code, 0, self.output)
        self.assertFalse((dest / BEI[0]).exists())
        self.assertIn(f"git checkout HEAD -- {DEST}bei-index.json {DEST}.sync-bei.json", runner.calls)
        self.assertEqual(json.loads((self.root / HOLD_BEI).read_text())["days"]["2026-10-05"]["sha256"], "beiY")
        self.assertFalse((self.root / DEST / ".stockbit-hold.json").exists())


if __name__ == "__main__":
    unittest.main()
