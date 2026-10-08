"""publish_stockbit.py / rollback_stockbit.py with an injected command runner: no git, npx, network or deploy."""
import io
import json
from contextlib import redirect_stdout
from datetime import datetime
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import publish_stockbit as pub  # noqa: E402
import rollback_stockbit as rb  # noqa: E402

DEPLOYMENTS = json.dumps([
    {"id": "d1", "created_on": "2026-10-06T10:00:00Z", "versions": [{"version_id": "v-old", "percentage": 100}]},
    {"id": "d2", "created_on": "2026-10-07T09:00:00Z", "versions": [{"version_id": "v-live", "percentage": 100}]},
])
SB = ["sbringkas_2026-10-05_2026-10-05.md", "sbdetail_2026-10-05_2026-10-05.md"]


def build_stdout(rows):
    return "\n".join(f"{'Stockbit':<22} {'5 Okt 2026':<24} {name} -> files/{cat}/{day}/{name}" for name, cat, day in rows) + "\n2 dokumen -> /tmp/x\n"


GOOD_BUILD = build_stdout([(SB[0], "stockbit-ringkasan", "2026-10-05"), (SB[1], "stockbit-detail", "2026-10-05")])


class FakeRunner:
    """Scripted git/npx/python. `rules` maps a key (first matching substring of the joined argv) to a result or callable."""

    def __init__(self, **overrides):
        self.calls, self.state = [], {"added": False, "committed": False, "deploys": 0}
        self.overrides = overrides

    def result(self, code=0, out=""):
        return subprocess.CompletedProcess([], code, out, "")

    def __call__(self, argv, timeout, env=None, tee=False):
        assert isinstance(argv, list) and timeout, "argv list and timeout required"
        line = " ".join(map(str, argv))
        self.calls.append(line)
        for key, value in self.overrides.items():
            if key.replace("_", " ") in line or key in line:
                return value(self, line) if callable(value) else value
        return self.default(line)

    def default(self, line):
        r = self.result
        if line == "git rev-parse --abbrev-ref HEAD":
            return r(0, "main\n")
        if line == "git diff --cached --quiet":
            return r(1 if self.state["added"] and not self.state["committed"] else 0)
        if line.startswith("git status"):
            return r(0, " M docs/index.html\0?? needtobeindexed/idx-signal-desk/sbringkas_2026-10-05_2026-10-05.md\0")
        if line.startswith("git rev-list --count"):
            return r(0, "0\n")
        if line == "git rev-parse HEAD":
            return r(0, ("post1" if self.state["committed"] else "pre1") + "\n")
        if line == "git rev-parse HEAD^":
            return r(0, "pre1\n")
        if line.startswith("git add"):
            self.state["added"] = True
            return r()
        if line.startswith("git diff --cached --diff-filter=D"):
            return r(0, "")
        if line.startswith("git diff --cached --name-only"):
            return r(0, "".join(f"needtobeindexed/idx-signal-desk/{n}\n" for n in SB) + "docs/index.html\n")
        if line.startswith("git commit"):
            self.state["committed"] = True
            return r()
        if "deployments list" in line:
            return r(0, DEPLOYMENTS if not self.state["deploys"] else DEPLOYMENTS.replace("v-live", "v-new"))
        if "build.py --out" in line and "docs" not in line.split("--out")[1]:
            return r(0, GOOD_BUILD)
        if "publish_chat.py" in line:
            self.state["deploys"] += 1
            return r()
        return r()

    def index(self, needle):
        return next(i for i, c in enumerate(self.calls) if needle in c)


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dest = self.root / pub.DEST_REL; self.dest.mkdir(parents=True)
        for n in SB:
            (self.dest / n).write_text("x")
        self.log = self.root / ".stockbit-publish/log.jsonl"
        p = patch.object(pub, "ROOT", self.root); p.start(); self.addCleanup(p.stop)

    def publish(self, runner, dry_run=False, free=10e9):
        with redirect_stdout(io.StringIO()) as out:
            code, summary = pub.publish(SimpleNamespace(dry_run=dry_run), runner=runner, which=lambda t: "/bin/" + t,
                                        disk_usage=lambda p: SimpleNamespace(free=free), log=self.log,
                                        clock=lambda: datetime(2026, 10, 7, 10, 15, 0))
        self.output = out.getvalue()
        return code, summary

    def records(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_happy_path_order_commit_tag_and_log(self):
        runner = FakeRunner()
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        order = ["git fetch origin main", "deployments list", "sync_idx.py --stockbit-only --no-build", "build.py --out",
                 "publish_chat.py", f"git add -- needtobeindexed/idx-signal-desk/{SB[0]} docs site", "git commit",
                 "git push origin HEAD:main", "git tag -a stockbit-publish-20261007-101500", "git push origin refs/tags/"]
        positions = [runner.index(n) for n in order]
        self.assertEqual(positions, sorted(positions), runner.calls)
        commit = runner.calls[runner.index("git commit")]
        self.assertIn("Stockbit: ringkasan 2026-10-05", commit)
        self.assertFalse([c for c in runner.calls if "--force" in c or "push -f" in c])
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["pre_sha"], rec["post_sha"], rec["tag"]),
                         ("published", "pre1", "post1", "stockbit-publish-20261007-101500"))
        self.assertEqual((rec["worker_version_before"], rec["worker_version_after"]), ("v-live", "v-new"))
        self.assertEqual(summary["status"], "published")

    def test_dirty_tree_outside_publish_paths_aborts_before_sync(self):
        runner = FakeRunner(**{"git status": lambda r, l: r.result(0, " M build.py\0 M docs/index.html\0")})
        code, _ = self.publish(runner)
        self.assertEqual(code, 2)
        self.assertIn("build.py", self.output)
        self.assertFalse([c for c in runner.calls if "sync_idx" in c or "publish_chat" in c])
        self.assertEqual(self.records(), [])

    def test_staged_changes_wrong_branch_ahead_and_disk_abort(self):
        cases = {
            "staged": {"git diff --cached --quiet": lambda r, l: r.result(1)},
            "branch": {"--abbrev-ref": lambda r, l: r.result(0, "stockbit-summaries\n")},
            "ahead": {"origin/main..HEAD": lambda r, l: r.result(0, "2\n")},
        }
        for label, override in cases.items():
            with self.subTest(label):
                runner = FakeRunner(**override)
                self.assertEqual(self.publish(runner)[0], 2)
                self.assertFalse([c for c in runner.calls if "sync_idx" in c])
        self.assertEqual(self.publish(FakeRunner(), free=1e9)[0], 2)
        self.assertEqual(self.publish(FakeRunner(), dry_run=True)[0], 0)
        self.assertEqual(self.publish(FakeRunner(), dry_run=True, free=1e9)[0], 2)

    def test_behind_pulls_ff_only(self):
        runner = FakeRunner(**{"HEAD..origin/main": lambda r, l: r.result(0, "3\n")})
        self.assertEqual(self.publish(runner)[0], 0)
        self.assertLess(runner.index("git pull --ff-only origin main"), runner.index("sync_idx.py"))

    def test_deleted_sb_file_aborts_without_commit(self):
        runner = FakeRunner(**{"--diff-filter=D": lambda r, l: r.result(0, f"needtobeindexed/idx-signal-desk/{SB[0]}\n")})
        code, _ = self.publish(runner)
        self.assertEqual(code, 7)
        self.assertFalse([c for c in runner.calls if c.startswith("git commit") or c.startswith("git push")])
        self.assertIn(f"git reset -q -- needtobeindexed/idx-signal-desk/{SB[0]} docs site", runner.calls)
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["worker_version_after"]), ("deployed_not_committed", "v-new"))

    def test_deleted_sb_in_worktree_aborts_before_deploy(self):
        runner = FakeRunner(**{"git status": lambda r, l: r.result(0, f" D needtobeindexed/idx-signal-desk/{SB[0]}\0")})
        self.assertEqual(self.publish(runner)[0], 2)
        self.assertFalse([c for c in runner.calls if "publish_chat" in c])

    def test_digest_or_ownership_changes_refused_dot_files_ignored(self):
        for dirty in (" M needtobeindexed/idx-signal-desk/digest_2026-10-01_2026-10-02.md\0",
                      " M needtobeindexed/idx-signal-desk/kepemilikan.json\0"):
            with self.subTest(dirty):
                runner = FakeRunner(**{"git status": lambda r, l, d=dirty: r.result(0, d)})
                self.assertEqual(self.publish(runner)[0], 2)
                self.assertIn("tidak boleh ikut publish Stockbit", self.output)
                self.assertFalse([c for c in runner.calls if "sync_idx" in c])
        status = (" M needtobeindexed/idx-signal-desk/.sync.json\0?? needtobeindexed/idx-signal-desk/.sync-abc123\0"
                  f"?? needtobeindexed/idx-signal-desk/{SB[0]}\0 M needtobeindexed/idx-signal-desk/stockbit-index.json\0 M site/index.html\0")
        runner = FakeRunner(**{"git status": lambda r, l: r.result(0, status)})
        self.assertEqual(self.publish(runner)[0], 0, self.output)
        add = runner.calls[runner.index("git add")]
        self.assertEqual(add, f"git add -- needtobeindexed/idx-signal-desk/{SB[0]} needtobeindexed/idx-signal-desk/stockbit-index.json docs site")
        commit = runner.calls[runner.index("git commit")]
        self.assertNotIn(".sync.json", commit)

    def test_sync_without_stockbit_changes_stops_before_build_and_deploy(self):
        runner = FakeRunner(**{"git status": lambda r, l: r.result(0, " M docs/index.html\0 M needtobeindexed/idx-signal-desk/.sync.json\0")})
        code, summary = self.publish(runner)
        self.assertEqual((code, summary["status"]), (0, "tidak ada perubahan"), self.output)
        self.assertTrue([c for c in runner.calls if "sync_idx.py" in c])
        self.assertFalse([c for c in runner.calls if "build.py" in c or "publish_chat" in c
                          or c.startswith(("git add", "git commit", "git push", "git tag"))])
        self.assertEqual(self.records()[-1]["status"], "tidak ada perubahan")

    def test_retry_after_deploy_without_commit_carries_rollback_point(self):
        self.log.parent.mkdir(parents=True)
        self.log.write_text("".join(json.dumps(r) + "\n" for r in [
            {"type": "publish", "status": "published", "tag": "t0", "worker_version_before": "v-0"},
            {"type": "publish", "status": "deployed_index_pending", "started_at": "s1", "worker_version_before": "v-old",
             "worker_version_after": "v-live"},
            {"type": "publish", "status": "gagal", "started_at": "s2"}]))
        self.assertEqual(self.publish(FakeRunner())[0], 0, self.output)
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["worker_version_before"], rec["rollback_to"], rec["supersedes"]),
                         ("published", "v-live", "v-old", ["s1"]))
        # A rolled-back deploy is not carried forward.
        self.log.write_text("".join(json.dumps(r) + "\n" for r in [
            {"type": "publish", "status": "deployed_index_pending", "started_at": "s1", "worker_version_before": "v-old"},
            {"type": "rollback", "status": "rolled_back", "tag": "s1", "covers": ["s1"]}]))
        self.assertEqual(self.publish(FakeRunner())[0], 0, self.output)
        self.assertNotIn("rollback_to", self.records()[-1])

    def test_nothing_staged_reports_no_change(self):
        runner = FakeRunner(**{"git diff --cached --quiet": lambda r, l: r.result(0)})
        code, summary = self.publish(runner)
        self.assertEqual((code, summary["status"]), (0, "tidak ada perubahan"))
        self.assertIn("tidak ada perubahan", self.output)
        self.assertFalse([c for c in runner.calls if c.startswith("git commit") or c.startswith("git tag")])

    def test_dry_run_stops_after_build_check(self):
        runner = FakeRunner()
        code, summary = self.publish(runner, dry_run=True)
        self.assertEqual((code, summary["status"]), (0, "dry-run"))
        self.assertTrue([c for c in runner.calls if "sync_idx.py" in c])
        self.assertFalse([c for c in runner.calls if "publish_chat" in c or c.startswith(("git add", "git commit", "git push", "git pull"))])
        self.assertEqual(self.records(), [])

    def test_build_check_wrong_category_stops_before_deploy(self):
        bad = build_stdout([(SB[0], "lainnya", "2026-10-05"), (SB[1], "stockbit-detail", "2026-10-05")])
        runner = FakeRunner(**{"build.py --out": lambda r, l: r.result(0, bad)})
        code, _ = self.publish(runner)
        self.assertEqual(code, 4)
        self.assertIn("lainnya", self.output)
        self.assertFalse([c for c in runner.calls if "publish_chat" in c])

    def test_sync_failure_stops(self):
        runner = FakeRunner(**{"sync_idx.py": lambda r, l: r.result(1, "Stockbit ditolak")})
        self.assertEqual(self.publish(runner)[0], 3)
        self.assertFalse([c for c in runner.calls if "build.py" in c or "publish_chat" in c])

    def test_publish_chat_index_failure_retries_once_then_commits(self):
        trace = ("Traceback...\nsubprocess.CalledProcessError: Command '['/usr/bin/python3', '-B', "
                 "'tools/sync_chat_index.py']' returned non-zero exit status 1.\n")
        runner = FakeRunner(**{"publish_chat.py": lambda r, l: (r.state.__setitem__("deploys", 1), r.result(1, trace))[1]})
        code, _ = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        retry, docs = runner.index("sync_chat_index.py"), runner.index("build.py --out docs")
        self.assertLess(runner.index("publish_chat.py"), retry); self.assertLess(retry, docs)
        self.assertLess(docs, runner.index("git commit"))

    def test_publish_chat_failure_after_deploy_twice_is_logged_not_pushed(self):
        trace = "CalledProcessError: Command '['python3', '-B', 'tools/sync_chat_index.py']' returned non-zero exit status 1."
        runner = FakeRunner(**{"publish_chat.py": lambda r, l: r.result(1, trace),
                               "sync_chat_index.py": lambda r, l: r.result(1, "still down")})
        code, _ = self.publish(runner)
        self.assertEqual(code, 6)
        self.assertFalse([c for c in runner.calls if c.startswith("git commit") or c.startswith("git push")])
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["worker_version_before"]), ("deployed_index_pending", "v-live"))
        # The fake publish_chat override does not bump the deployment; whatever is live is recorded for rollback.
        self.assertEqual((rec["worker_version_after"], rec["files"]), ("v-live", [SB[0]]))

    def test_publish_chat_failure_before_deploy(self):
        trace = "CalledProcessError: Command '['npx', '--yes', 'wrangler@4.135.0', 'deploy']' returned non-zero exit status 1."
        runner = FakeRunner(**{"publish_chat.py": lambda r, l: r.result(1, trace)})
        self.assertEqual(self.publish(runner)[0], 5)
        self.assertFalse([c for c in runner.calls if "sync_chat_index" in c or c.startswith("git add")])

    def test_push_rejected_rebases_once_and_rereads_sha(self):
        pushes = []

        def push(r, line):
            pushes.append(line)
            if len(pushes) == 1:
                return r.result(1, "rejected")
            r.state["rebased"] = True
            return r.result(0)
        runner = FakeRunner(**{"git push origin HEAD:main": push,
                               "git rev-parse HEAD^": lambda r, l: r.result(0, "upstream1\n"),
                               "git rev-parse HEAD": lambda r, l: r.result(0, ("post2" if r.state.get("rebased") else
                                                                              "post1" if r.state["committed"] else "pre1") + "\n")})
        code, _ = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        self.assertIn("git pull --rebase origin main", runner.calls)
        rec = self.records()[-1]
        self.assertEqual((rec["pre_sha"], rec["post_sha"]), ("upstream1", "post2"))
        self.assertIn(f"git tag -a {rec['tag']} -m", runner.calls[runner.index("git tag")])
        self.assertTrue(runner.calls[runner.index("git tag")].endswith(" post2"))

    def test_push_failure_after_rebase_exit_8(self):
        runner = FakeRunner(**{"git push origin HEAD:main": lambda r, l: r.result(1, "rejected"),
                               "git pull --rebase": lambda r, l: r.result(1, "conflict")})
        self.assertEqual(self.publish(runner)[0], 8)
        self.assertIn("git rebase --abort", runner.calls)
        self.assertEqual(self.records()[-1]["status"], "push_failed")

    def test_worker_version_unknown_warns_and_continues(self):
        runner = FakeRunner(**{"deployments list": lambda r, l: r.result(1, ""), "versions list": lambda r, l: r.result(1, "")})
        self.assertEqual(self.publish(runner)[0], 0)
        self.assertIn("versi Worker live tidak terbaca", self.output)
        self.assertIsNone(self.records()[-1]["worker_version_before"])

    def test_parse_worker_version_and_build_table(self):
        self.assertEqual(pub.parse_worker_version("warning\n" + DEPLOYMENTS), "v-live")
        self.assertEqual(pub.parse_worker_version(json.dumps({"versions": [{"version_id": "a", "percentage": 10},
                                                                            {"version_id": "b", "percentage": 90}]})), "b")
        self.assertEqual(pub.parse_worker_version(json.dumps([{"id": "x1", "metadata": {"created_on": "2026-10-01"}},
                                                              {"id": "x2", "metadata": {"created_on": "2026-10-02"}}])), "x2")
        for junk in ("", "not json", "[]", '{"versions": []}'):
            self.assertIsNone(pub.parse_worker_version(junk))
        self.assertEqual(len(pub.check_build(GOOD_BUILD, SB)), 2)
        with self.assertRaises(pub.Failure):
            pub.check_build(build_stdout([(SB[0], "stockbit-ringkasan", "2026-10-04")]), SB[:1])
        with self.assertRaises(pub.Failure):
            pub.check_build(GOOD_BUILD, SB + ["sbpekan_2026-10-05_2026-10-11.md"])
        self.assertEqual(pub.failed_step("Command '['x', 'build.py', '--out', 'docs']' returned non-zero exit status 1"), "docs")
        self.assertIn("2026-10-01 s/d 2026-10-07 (7 hari)",
                      pub.commit_message([f"sbringkas_2026-10-0{d}_2026-10-0{d}.md" for d in range(1, 8)]))


HOLD = "needtobeindexed/idx-signal-desk/.stockbit-hold.json"


class RollbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        p = patch.object(pub, "ROOT", self.root); p.start(); self.addCleanup(p.stop)
        self.log = self.root / ".stockbit-publish/log.jsonl"
        self.log.parent.mkdir()
        self.write([{"type": "publish", "status": "published", "tag": "stockbit-publish-20261006-100000", "pre_sha": "a0",
                     "post_sha": "a1", "worker_version_before": "v-a", "worker_version_after": "v-b"},
                    {"type": "publish", "status": "gagal", "tag": None},
                    {"type": "publish", "status": "published", "tag": "stockbit-publish-20261007-101500", "pre_sha": "b0",
                     "post_sha": "b1", "worker_version_before": "v-b", "worker_version_after": "v-live", "files": [SB[0]]}])

    def write(self, rows):
        self.log.write_text("".join(json.dumps(r) + "\n" for r in rows))

    def rollback(self, runner, tag=None, dry_run=False):
        with redirect_stdout(io.StringIO()) as out:
            code, summary = rb.rollback(SimpleNamespace(tag=tag, dry_run=dry_run), runner=runner,
                                        which=lambda t: "/bin/" + t, log=self.log)
        self.output = out.getvalue()
        return code, summary

    def runner(self, **overrides):
        state = json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "shaX|t1|final"}}})
        base = {"git status": lambda r, l: r.result(0, "?? notes.txt\0"),
                "git show b1:": lambda r, l: r.result(0, state),
                "git diff --name-only": lambda r, l: r.result(0, f"docs/index.html\nneedtobeindexed/idx-signal-desk/{SB[0]}\nsite/index.html\n")}
        return FakeRunner(**{**base, **overrides})

    def last(self):
        return json.loads(self.log.read_text().splitlines()[-1])

    def hold(self):
        return json.loads((self.root / HOLD).read_text())["days"]

    def test_reverts_recorded_range_rolls_back_worker_and_reindexes(self):
        runner = self.runner()
        code, _ = self.rollback(runner)
        self.assertEqual(code, 0, self.output)
        order = ["git fetch origin main", "git merge-base --is-ancestor b0 b1", "git checkout -- docs site",
                 "git revert --no-commit b0..b1", f"git add -- {HOLD}", "git commit -q -m Rollback Stockbit",
                 "git push origin HEAD:main", "deployments list",
                 "wrangler@4.135.0 rollback v-b --config worker/wrangler.jsonc --message", "sync_chat_index.py"]
        positions = [runner.index(n) for n in order]
        self.assertEqual(positions, sorted(positions), runner.calls)
        self.assertFalse([c for c in runner.calls if "--force" in c or "reset --hard" in c])
        rec = self.last()
        self.assertEqual((rec["type"], rec["tag"], rec["reverted"], rec["status"]),
                         ("rollback", "stockbit-publish-20261007-101500", "b0..b1", "rolled_back"))
        # The hold makes the rollback stick: the desk still exports 2026-10-05 with sha shaX.
        self.assertEqual(self.hold(), {"2026-10-05": {"sha256": "shaX", "rollback_of": "stockbit-publish-20261007-101500"}})
        # Same publish cannot be rolled back twice.
        self.assertEqual(self.rollback(self.runner())[0], 2)

    def test_tag_for_older_publish_needs_newer_rolled_back_first(self):
        self.assertEqual(self.rollback(self.runner(), tag="stockbit-publish-20261006-100000")[0], 2)
        self.assertIn("lebih baru", self.output)
        self.assertEqual(self.rollback(self.runner())[0], 0, self.output)
        runner = self.runner(**{"deployments list": lambda r, l: r.result(0, DEPLOYMENTS.replace("v-live", "v-b"))})
        self.assertEqual(self.rollback(runner, tag="stockbit-publish-20261006-100000")[0], 0, self.output)
        self.assertIn("git revert --no-commit a0..a1", runner.calls)
        self.assertTrue([c for c in runner.calls if "rollback v-a" in c])
        self.assertEqual(self.rollback(self.runner(), tag="stockbit-publish-nope")[0], 2)

    def test_dry_run_prints_plan_only(self):
        runner = self.runner()
        code, summary = self.rollback(runner, dry_run=True)
        self.assertEqual((code, summary["plan"]["revert"]), (0, "b0..b1"))
        self.assertIn("b0..b1", self.output)
        self.assertEqual(runner.calls, [])
        self.assertEqual(len(self.log.read_text().splitlines()), 3)

    def test_dirty_tree_or_foreign_range_refused(self):
        dirty = self.runner(**{"git status": lambda r, l: r.result(0, " M build.py\0")})
        self.assertEqual(self.rollback(dirty)[0], 2)
        self.assertFalse([c for c in dirty.calls if "revert" in c])
        for touched in ("build.py\ndocs/index.html\n", "needtobeindexed/idx-signal-desk/digest_2026-10-01_2026-10-02.md\n"):
            foreign = self.runner(**{"git diff --name-only": lambda r, l, t=touched: r.result(0, t)})
            self.assertEqual(self.rollback(foreign)[0], 2)
            self.assertFalse([c for c in foreign.calls if "revert" in c])

    def test_derived_and_sync_state_dirt_allowed_and_derived_discarded(self):
        status = " M docs/index.html\0 M site/version.json\0 M needtobeindexed/idx-signal-desk/.sync.json\0"
        runner = self.runner(**{"git status": lambda r, l: r.result(0, status)})
        self.assertEqual(self.rollback(runner)[0], 0, self.output)
        self.assertLess(runner.index("git checkout -- docs site"), runner.index("git revert --no-commit"))
        stockbit_dirty = self.runner(**{"git status": lambda r, l: r.result(0, " M needtobeindexed/idx-signal-desk/stockbit-index.json\0")})
        self.write([json.loads(l) for l in self.log.read_text().splitlines()][:3])
        self.assertEqual(self.rollback(stockbit_dirty)[0], 2)

    def test_unknown_worker_version_prints_manual_steps(self):
        rows = self.log.read_text().splitlines()
        last = json.loads(rows[-1]); last["worker_version_before"] = None
        self.log.write_text("\n".join(rows[:-1] + [json.dumps(last)]) + "\n")
        runner = self.runner()
        code, _ = self.rollback(runner)
        self.assertEqual(code, 5)
        self.assertIn("git revert --no-commit b0..b1", runner.calls)
        self.assertFalse([c for c in runner.calls if " rollback " in c and "wrangler" in c])
        self.assertIn("deployments list", self.output)
        self.assertEqual(self.last()["status"], "partial")

    def test_newer_deploy_live_is_not_discarded(self):
        runner = self.runner(**{"deployments list": lambda r, l: r.result(0, DEPLOYMENTS.replace("v-live", "v-other"))})
        code, _ = self.rollback(runner)
        self.assertEqual(code, 5, self.output)
        self.assertIn("git revert --no-commit b0..b1", runner.calls)
        self.assertFalse([c for c in runner.calls if " rollback v-" in c and "wrangler" in c])
        self.assertIn("v-other", self.output)

    def test_partial_rerun_skips_git_and_retries_worker(self):
        fail = self.runner(**{"wrangler@4.135.0 rollback": lambda r, l: r.result(1, "api down")})
        self.assertEqual(self.rollback(fail)[0], 5)
        self.assertEqual(self.last()["status"], "partial")
        again = self.runner()
        self.assertEqual(self.rollback(again)[0], 0, self.output)
        self.assertFalse([c for c in again.calls if c.startswith(("git revert", "git commit", "git push", "git fetch"))])
        self.assertTrue([c for c in again.calls if "rollback v-b" in c])
        self.assertEqual(self.last()["status"], "rolled_back")
        self.assertEqual(self.rollback(self.runner())[0], 2)

    def test_deployed_without_commit_restores_tree_and_worker(self):
        self.write([{"type": "publish", "status": "deployed_index_pending", "started_at": "s1", "pre_sha": None,
                     "post_sha": None, "worker_version_before": "v-b", "worker_version_after": "v-live", "files": [SB[0]]}])
        dest = self.root / pub.DEST_REL; dest.mkdir(parents=True)
        (dest / SB[0]).write_text("new day")
        (dest / ".sync-stockbit.json").write_text(json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "shaY|t|final"}}}))
        status = (f" M docs/index.html\0 M site/index.html\0?? needtobeindexed/idx-signal-desk/{SB[0]}\0"
                  " M needtobeindexed/idx-signal-desk/stockbit-index.json\0 M needtobeindexed/idx-signal-desk/.sync-stockbit.json\0"
                  " M build.py\0")
        runner = self.runner(**{"git status": lambda r, l: r.result(0, status)})
        code, _ = self.rollback(runner)
        self.assertEqual(code, 0, self.output)
        self.assertFalse((dest / SB[0]).exists())
        self.assertIn("git checkout HEAD -- needtobeindexed/idx-signal-desk/stockbit-index.json "
                      "needtobeindexed/idx-signal-desk/.sync-stockbit.json", runner.calls)
        self.assertIn("git checkout -- docs site", runner.calls)
        self.assertFalse([c for c in runner.calls if c.startswith(("git fetch", "git revert", "git push", "git pull"))])
        self.assertTrue([c for c in runner.calls if "rollback v-b" in c])
        self.assertEqual(self.hold()["2026-10-05"]["sha256"], "shaY")
        self.assertEqual(self.last()["status"], "rolled_back")

    def test_superseded_deploy_uses_earliest_worker_version_and_is_covered(self):
        self.write([{"type": "publish", "status": "deployed_not_committed", "started_at": "s1", "worker_version_before": "v-1",
                     "worker_version_after": "v-2"},
                    {"type": "publish", "status": "published", "tag": "t2", "pre_sha": "b0", "post_sha": "b1",
                     "worker_version_before": "v-2", "worker_version_after": "v-live", "rollback_to": "v-1", "supersedes": ["s1"]}])
        runner = self.runner()
        self.assertEqual(self.rollback(runner)[0], 0, self.output)
        self.assertTrue([c for c in runner.calls if "rollback v-1" in c])
        self.assertEqual(self.last()["covers"], ["t2", "s1"])
        self.assertEqual(self.rollback(self.runner())[0], 2)  # t2 done; s1 is covered as well

    def test_push_failed_never_pushed_is_reset_locally(self):
        self.write([{"type": "publish", "status": "push_failed", "tag": None, "started_at": "s1", "pre_sha": "b0",
                     "post_sha": "b1", "worker_version_before": "v-b", "worker_version_after": "v-live", "files": [SB[0]]}])
        runner = self.runner(**{"is-ancestor b1 origin/main": lambda r, l: r.result(1),
                                "git rev-parse HEAD": lambda r, l: r.result(0, "b1\n"),
                                "origin/main..HEAD": lambda r, l: r.result(0, "1\n"),
                                "HEAD..origin/main": lambda r, l: r.result(0, "4\n")})
        code, _ = self.rollback(runner)
        self.assertEqual(code, 0, self.output)
        self.assertIn("git reset --keep b0", runner.calls)
        self.assertFalse([c for c in runner.calls if c.startswith(("git revert", "git push", "git pull"))])
        self.assertTrue([c for c in runner.calls if "rollback v-b" in c])
        self.assertIn("2026-10-05", self.hold())

    def test_revert_conflict_aborts(self):
        runner = self.runner(**{"git revert --no-commit": lambda r, l: r.result(1, "conflict")})
        self.assertEqual(self.rollback(runner)[0], 3)
        self.assertIn("git revert --abort", runner.calls)
        self.assertFalse([c for c in runner.calls if "push" in c or "wrangler" in c])


if __name__ == "__main__":
    unittest.main()
