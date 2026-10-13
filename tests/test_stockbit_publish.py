"""publish_stockbit.py / rollback_stockbit.py with an injected command runner: no git push, node, ssh, network or deploy."""
import io
import json
import os
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import publish_stockbit as pub  # noqa: E402
import rollback_stockbit as rb  # noqa: E402

VPS_PUSH = "node local/vps.mjs push"
SB = ["sbringkas_2026-10-05_2026-10-05.md", "sbdetail_2026-10-05_2026-10-05.md"]


def build_stdout(rows):
    return "\n".join(f"{'Stockbit':<22} {'5 Okt 2026':<24} {name} -> files/{cat}/{day}/{name}" for name, cat, day in rows) + "\n2 dokumen -> /tmp/x\n"


GOOD_BUILD = build_stdout([(SB[0], "stockbit-ringkasan", "2026-10-05"), (SB[1], "stockbit-detail", "2026-10-05")])


class FakeRunner:
    """Scripted git/node/python. `rules` maps a key (first matching substring of the joined argv) to a result or callable."""

    def __init__(self, **overrides):
        self.calls, self.envs, self.state = [], [], {"added": False, "committed": False, "vps": 0}
        self.timeouts = []
        self.overrides = overrides

    def result(self, code=0, out=""):
        return subprocess.CompletedProcess([], code, out, "")

    def __call__(self, argv, timeout, env=None, tee=False):
        assert isinstance(argv, list) and timeout, "argv list and timeout required"
        line = " ".join(map(str, argv))
        self.calls.append(line)
        self.envs.append((line, env))
        self.timeouts.append((line, timeout))
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
        if line == "git ls-files -z -- docs site":
            return r(0, "docs/index.html\0site/index.html\0")
        if line.startswith("git status"):
            return r(0, " M docs/index.html\0?? needtobeindexed/idx-signal-desk/sbringkas_2026-10-05_2026-10-05.md\0")
        if line.startswith("git rev-list --count"):
            return r(0, "0\n")
        if line == "git rev-parse HEAD":
            return r(0, ("post1" if self.state["committed"] else "pre1") + "\n")
        if line == "git rev-parse HEAD^":
            return r(0, "pre1\n")
        if line.startswith("git rev-parse -q --verify"):
            return r(1)  # no REVERT_HEAD: no revert in progress
        if line == "git rev-parse --git-path sequencer":
            return r(0, ".git/sequencer\n")  # does not exist under the temp ROOT
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
        if "build.py --out" in line and line.split("--out ")[1] not in ("docs", "site"):
            return r(0, GOOD_BUILD)
        if line == VPS_PUSH:
            self.state["vps"] += 1
            return r(0, "Mengirim 10 berkas ke 192.0.2.1…\nServer berjalan. Buka https://arsip.example di perangkat mana pun.\n")
        if "wrangler" in line or "publish_chat" in line or "sync_chat_index" in line or "build_worker" in line:
            raise AssertionError(f"Cloudflare/Worker command must never run: {line}")
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
        (self.root / ".local").mkdir(); (self.root / pub.VPS_CONFIG_REL).write_text("{}")
        p = patch.object(pub, "ROOT", self.root); p.start(); self.addCleanup(p.stop)

    def no_calls(self, runner, *needles):
        return not [c for c in runner.calls if any(n in c for n in needles)]

    def publish(self, runner, dry_run=False, free=10e9, which=lambda t: "/bin/" + t, budget=None, **extra):
        with redirect_stdout(io.StringIO()) as out:
            code, summary = pub.publish(SimpleNamespace(dry_run=dry_run, **extra), runner=runner, which=which,
                                        disk_usage=lambda p: SimpleNamespace(free=free), log=self.log,
                                        clock=lambda: datetime(2026, 10, 7, 10, 15, 0), budget=budget)
        self.output = out.getvalue()
        return code, summary

    def records(self):
        return [json.loads(l) for l in self.log.read_text().splitlines()] if self.log.exists() else []

    def test_publish_omits_ignored_site_from_staging(self):
        runner = FakeRunner(**{"git ls-files -z -- docs site": lambda r, l: r.result(0, "docs/index.html\0")})
        code, _ = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        add = next(c for c in runner.calls if c.startswith("git add --"))
        self.assertTrue(add.endswith(" docs"), add)
        self.assertNotIn(" site", add)

    def test_range_start_is_forwarded_to_sync(self):
        runner = FakeRunner()
        code, _ = self.publish(runner, stockbit_since="2026-09-01")
        self.assertEqual(code, 0, self.output)
        self.assertIn("sync_idx.py --stockbit-only --no-build --stockbit-since 2026-09-01",
                      runner.calls[runner.index("sync_idx.py")])
        runner = FakeRunner()
        self.publish(runner)
        self.assertNotIn("--stockbit-since", runner.calls[runner.index("sync_idx.py")])

    def test_provisional_days_are_forwarded_to_sync_only_when_asked(self):
        runner = FakeRunner()
        code, _ = self.publish(runner, allow_provisional=True)
        self.assertEqual(code, 0, self.output)
        self.assertIn("--allow-provisional --with-bei", runner.calls[runner.index("sync_idx.py")])
        runner = FakeRunner()
        self.publish(runner)
        self.assertNotIn("--allow-provisional", runner.calls[runner.index("sync_idx.py")])

    def test_cli_rejects_bad_range_start(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            pub.main(["--stockbit-since", "2026-9-1"])

    def test_happy_path_order_commit_tag_and_log(self):
        runner = FakeRunner()
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        order = ["git fetch origin main", "sync_idx.py --stockbit-only --no-build", "build.py --out /", "build.py --out docs",
                 VPS_PUSH, f"git add -- needtobeindexed/idx-signal-desk/{SB[0]} docs site", "git commit",
                 "git push origin HEAD:main", "git tag -a stockbit-publish-20261007-101500", "git push origin refs/tags/"]
        positions = [runner.index(n) for n in order]
        self.assertEqual(positions, sorted(positions), runner.calls)
        self.assertEqual(runner.state["vps"], 1)
        commit = runner.calls[runner.index("git commit")]
        self.assertIn("Stockbit: ringkasan 2026-10-05", commit)
        self.assertFalse([c for c in runner.calls if "--force" in c or "push -f" in c])
        self.assertTrue(self.no_calls(runner, "wrangler", "npx", "publish_chat", "sync_chat_index", "build_worker"))
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["pre_sha"], rec["post_sha"], rec["tag"], rec["target"], rec["vps"]),
                         ("published", "pre1", "post1", "stockbit-publish-20261007-101500", "vps", True))
        self.assertFalse([k for k in rec if k.startswith("worker_") or k == "rollback_to"])
        self.assertEqual((summary["status"], summary["vps"]), ("published", True))

    def test_docs_rebuilt_like_publish_chat_env(self):
        runner = FakeRunner()
        with patch.dict("os.environ", {"CHAT_API_URL": "http://127.0.0.1:8788/api/chat"}):
            self.assertEqual(self.publish(runner)[0], 0, self.output)
        env = next(e for line, e in runner.envs if line.endswith("build.py --out docs"))
        self.assertNotIn("CHAT_API_URL", env)
        self.assertEqual(env["BASE_URL"], "https://arsip.seekingomega.capital")
        # Legacy checkout that still tracks site/: rebuilt as well, before the VPS push.
        self.assertLess(runner.index("build.py --out site"), runner.index(VPS_PUSH))
        runner = FakeRunner(**{"git ls-files -z -- docs site": lambda r, l: r.result(0, "docs/index.html\0")})
        self.assertEqual(self.publish(runner)[0], 0, self.output)
        self.assertTrue(self.no_calls(runner, "build.py --out site"))

    def test_preflight_needs_node_and_vps_config_not_npx(self):
        for missing in ("node", "git"):
            with self.subTest(missing):
                runner = FakeRunner()
                code, summary = self.publish(runner, which=lambda t, m=missing: None if t == m else "/bin/" + t)
                self.assertEqual(code, 2)
                self.assertIn(f"'{missing}' tidak ditemukan", summary["error"])
                self.assertEqual(runner.calls, [])
        runner = FakeRunner()
        self.assertEqual(self.publish(runner, which=lambda t: None if t == "npx" else "/bin/" + t)[0], 0, self.output)
        (self.root / pub.VPS_CONFIG_REL).unlink()
        for dry_run in (False, True):
            runner = FakeRunner()
            code, summary = self.publish(runner, dry_run=dry_run)
            self.assertEqual(code, 2)
            self.assertIn(".local/vps.json", summary["error"])
            self.assertEqual(runner.calls, [])

    def test_dirty_tree_outside_publish_paths_aborts_before_sync(self):
        runner = FakeRunner(**{"git status": lambda r, l: r.result(0, " M build.py\0 M docs/index.html\0")})
        code, _ = self.publish(runner)
        self.assertEqual(code, 2)
        self.assertIn("build.py", self.output)
        self.assertTrue(self.no_calls(runner, "sync_idx", VPS_PUSH))
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
        code, summary = self.publish(runner)
        self.assertEqual(code, 7)
        self.assertFalse([c for c in runner.calls if c.startswith("git commit") or c.startswith("git push")])
        self.assertIn(f"git reset -q -- needtobeindexed/idx-signal-desk/{SB[0]} docs site", runner.calls)
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["vps"], summary["vps"]), ("vps_not_committed", True, True))

    def test_deleted_sb_in_worktree_aborts_before_deploy(self):
        runner = FakeRunner(**{"git status": lambda r, l: r.result(0, f" D needtobeindexed/idx-signal-desk/{SB[0]}\0")})
        self.assertEqual(self.publish(runner)[0], 2)
        self.assertTrue(self.no_calls(runner, VPS_PUSH))

    def withheld_runner(self, hold_days, staged_days=None, deleted=None, derived=(), **extra):
        """Sync removed the files of desk-withheld 2026-10-03 (day files + the week that contains it)."""
        dest = "needtobeindexed/idx-signal-desk/"
        deleted = deleted or ["sbringkas_2026-10-03_2026-10-03.md", "sbdetail_2026-10-03_2026-10-03.md",
                              "sbpekan_2026-09-28_2026-10-04.md"]
        hold = json.dumps({"format": 1, "days": hold_days})
        (self.dest / ".stockbit-hold.json").write_text(hold)
        staged = hold if staged_days is None else json.dumps({"format": 1, "days": staged_days})
        paths = [dest + n for n in deleted] + list(derived)
        status = "".join(f" D {n}\0" for n in paths) + f" M {dest}.stockbit-hold.json\0 M docs/index.html\0"
        names = "".join(f"{n}\n" for n in paths) + f"{dest}.stockbit-hold.json\ndocs/index.html\n"
        return FakeRunner(**{"git status": lambda r, l: r.result(0, status),
                             "--diff-filter=D": lambda r, l: r.result(0, "".join(f"{n}\n" for n in paths)),
                             "git diff --cached --name-only": lambda r, l: r.result(0, names),
                             f"git show :{dest}.stockbit-hold.json": lambda r, l: r.result(0, staged), **extra})

    DESK = {"sha256": "*", "withheld_by": "desk"}

    def test_desk_withheld_deletions_are_committed(self):
        rollback = {"sha256": "abc", "rollback_of": "stockbit-publish-x"}
        runner = self.withheld_runner({"2026-10-03": self.DESK, "2026-10-01": rollback})
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        add = runner.calls[runner.index("git add --")]
        for name in ("sbringkas_2026-10-03_2026-10-03.md", "sbpekan_2026-09-28_2026-10-04.md", ".stockbit-hold.json"):
            self.assertIn(f"needtobeindexed/idx-signal-desk/{name}", add)
        self.assertEqual(summary["message"], "Stockbit: tahan 2026-10-03 dari web")
        self.assertIn("Stockbit: tahan 2026-10-03 dari web", runner.calls[runner.index("git commit")])
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["tag"]), ("published", "stockbit-publish-20261007-101500"))
        self.assertIn("sbringkas_2026-10-03_2026-10-03.md", rec["files"])
        # Combined with a rollback hold that also carries withheld_by=desk.
        runner = self.withheld_runner({"2026-10-03": {**rollback, "withheld_by": "desk"}})
        self.assertEqual(self.publish(runner)[0], 0, self.output)

    def test_withheld_copies_in_rebuilt_docs_are_committed(self):
        # build.py --out docs rebuilds tracked docs/ without the day: its copies become staged deletions too.
        copies = ["docs/files/stockbit-ringkasan/2026-10-03/sbringkas_2026-10-03_2026-10-03.md",
                  "docs/files/stockbit-detail/2026-10-03/sbdetail_2026-10-03_2026-10-03.md",
                  "docs/files/stockbit-pekan/2026-09-28/sbpekan_2026-09-28_2026-10-04.md",
                  "site/files/stockbit-ringkasan/2026-10-03/sbringkas_2026-10-03_2026-10-03.md"]
        runner = self.withheld_runner({"2026-10-03": self.DESK}, derived=copies)
        code, summary = self.publish(runner)
        self.assertEqual(code, 0, self.output)
        self.assertEqual(summary["message"], "Stockbit: tahan 2026-10-03 dari web")
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["withheld"]), ("published", ["2026-10-03"]))
        # A docs copy of a day that is not withheld is still refused (staged only -> commit guard, exit 7).
        other = "docs/files/stockbit-ringkasan/2026-10-02/sbringkas_2026-10-02_2026-10-02.md"
        dest = "needtobeindexed/idx-signal-desk/"
        runner = self.withheld_runner({"2026-10-03": self.DESK}, derived=copies, **{
            "--diff-filter=D": lambda r, l: r.result(0, "".join(f"{n}\n" for n in [dest + "sbringkas_2026-10-03_2026-10-03.md", other]))})
        self.assertEqual(self.publish(runner)[0], 7)
        self.assertFalse([c for c in runner.calls if c.startswith(("git commit", "git push"))])
        self.assertIn(other, self.output)
        self.assertFalse(pub.withheld_deletion("notes/sbringkas_2026-10-03_2026-10-03.md", {"2026-10-03"}))
        self.assertTrue(pub.withheld_deletion(copies[2], {"2026-10-03"}))

    def test_other_sb_deletions_still_refused(self):
        cases = {
            # Hold entry without withheld_by=desk (rollback only): not a desk withholding.
            "rollback_only": (dict(hold_days={"2026-10-03": {"sha256": "*", "rollback_of": "t"}}), 2),
            # Another day disappears next to the withheld one.
            "other_day": (dict(hold_days={"2026-10-03": self.DESK},
                               deleted=["sbringkas_2026-10-03_2026-10-03.md", "sbringkas_2026-10-02_2026-10-02.md"]), 2),
            # A week that does not contain the withheld day.
            "other_week": (dict(hold_days={"2026-10-03": self.DESK}, deleted=["sbpekan_2026-10-05_2026-10-11.md"]), 2),
            # Working tree says withheld, but the staged hold file (what would be committed) does not.
            "staged_hold_differs": (dict(hold_days={"2026-10-03": self.DESK}, staged_days={}), 7),
        }
        for label, (kw, expected) in cases.items():
            with self.subTest(label):
                runner = self.withheld_runner(**kw)
                self.assertEqual(self.publish(runner)[0], expected, self.output)
                self.assertFalse([c for c in runner.calls if c.startswith(("git commit", "git push", "git tag"))])
                if expected == 2:
                    self.assertTrue(self.no_calls(runner, VPS_PUSH, "sync_idx"))
        # The sync itself deleting a non-withheld sb file is caught right after the sync (exit 7, before deploy).
        dest = "needtobeindexed/idx-signal-desk/"
        runner = FakeRunner(**{"git status": lambda r, l: r.result(0, f" D {dest}{SB[0]}\0" if any("sync_idx" in c for c in r.calls)
                                                                  else f" M {dest}stockbit-index.json\0")})
        self.assertEqual(self.publish(runner)[0], 7)
        self.assertTrue(self.no_calls(runner, VPS_PUSH))
        self.assertEqual(self.records()[-1]["status"], "gagal")

    def test_commit_message_mentions_withheld_days(self):
        msg = pub.commit_message
        self.assertEqual(msg(["sbringkas_2026-10-03_2026-10-03.md", "sbdetail_2026-10-03_2026-10-03.md"],
                             ["sbringkas_2026-10-03_2026-10-03.md", "sbdetail_2026-10-03_2026-10-03.md"]),
                         "Stockbit: tahan 2026-10-03 dari web")
        self.assertEqual(msg(["sbringkas_2026-10-08_2026-10-08.md", "sbringkas_2026-10-03_2026-10-03.md"],
                             ["sbringkas_2026-10-03_2026-10-03.md"]),
                         "Stockbit: ringkasan 2026-10-08 · tahan 2026-10-03 dari web")
        self.assertEqual(msg(["sbpekan_2026-09-28_2026-10-04.md"], ["sbpekan_2026-09-28_2026-10-04.md"]),
                         "Stockbit: tahan pekan 2026-09-28..2026-10-04 dari web")
        self.assertEqual(msg(["sbringkas_2026-10-08_2026-10-08.md"]), "Stockbit: ringkasan 2026-10-08")
        self.assertEqual(pub.desk_withheld_days('{"days": {"2026-10-03": {"withheld_by": "desk"}, "2026-10-04": {"sha256": "*"},'
                                                ' "2026-13-01": {"withheld_by": "desk"}, "x": {"withheld_by": "desk"}}}'),
                         {"2026-10-03"})
        self.assertEqual(pub.desk_withheld_days("not json"), set())
        self.assertFalse(pub.withheld_deletion("elsewhere/sbringkas_2026-10-03_2026-10-03.md", {"2026-10-03"}))

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
        self.assertFalse([c for c in runner.calls if "build.py" in c or VPS_PUSH in c
                          or c.startswith(("git add", "git commit", "git push", "git tag"))])
        self.assertEqual(self.records()[-1]["status"], "tidak ada perubahan")

    def test_retry_after_vps_without_commit_is_committed_and_superseded(self):
        self.log.parent.mkdir(parents=True)
        self.log.write_text("".join(json.dumps(r) + "\n" for r in [
            {"type": "publish", "status": "published", "tag": "t0", "worker_version_before": "v-0"},
            # Old Worker-era record and a new VPS record, neither committed nor rolled back.
            {"type": "publish", "status": "deployed_index_pending", "started_at": "s0", "worker_version_before": "v-old",
             "worker_version_after": "v-live"},
            {"type": "publish", "status": "vps_not_committed", "target": "vps", "vps": True, "started_at": "s1"},
            {"type": "publish", "status": "vps_failed", "target": "vps", "started_at": "s2"},
            {"type": "publish", "status": "gagal", "started_at": "s3"}]))
        runner = FakeRunner()
        self.assertEqual(self.publish(runner)[0], 0, self.output)
        self.assertIn("ikut di-commit sekarang", self.output)
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["supersedes"]), ("published", ["s0", "s1"]))
        self.assertNotIn("rollback_to", rec)
        self.assertLess(runner.index(VPS_PUSH), runner.index("git commit"))
        # A rolled-back one is not carried forward.
        self.log.write_text("".join(json.dumps(r) + "\n" for r in [
            {"type": "publish", "status": "vps_not_committed", "started_at": "s1"},
            {"type": "rollback", "status": "rolled_back", "tag": "s1", "covers": ["s1"]}]))
        self.assertEqual(self.publish(FakeRunner())[0], 0, self.output)
        self.assertNotIn("supersedes", self.records()[-1])

    def test_vps_failure_exit_5_no_commit_and_rerun_publishes(self):
        runner = FakeRunner(**{VPS_PUSH: lambda r, l: r.result(1, "Gagal: Mengganti versi gagal (exit 1).\n"
                                                                      "Mengembalikan versi sebelumnya…\n")})
        code, summary = self.publish(runner)
        self.assertEqual(code, 5, self.output)
        self.assertIn("VPS gagal; situs tetap versi sebelumnya; tidak ada commit", summary["error"])
        self.assertLess(runner.index("build.py --out docs"), runner.index(VPS_PUSH))
        self.assertFalse([c for c in runner.calls if c.startswith(("git add", "git commit", "git push", "git tag"))])
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["vps"], summary["vps"], summary["log_status"]), ("vps_failed", False, False, "vps_failed"))
        # The synced files are still uncommitted changes: the next click does not stop at "tidak ada perubahan".
        runner = FakeRunner()
        code, summary = self.publish(runner)
        self.assertEqual((code, summary["status"]), (0, "published"), self.output)
        self.assertNotIn("supersedes", self.records()[-1])  # vps_failed changed nothing on the site

    def test_vps_timeout_exit_5_and_cleanup_only_failure_counts_as_live(self):
        def slow(r, l):
            raise subprocess.TimeoutExpired(l, 1800)
        code, summary = self.publish(FakeRunner(**{VPS_PUSH: slow}))
        self.assertEqual(code, 5)
        self.assertIn("node local/vps.mjs status", summary["error"])
        self.assertEqual(self.records()[-1]["status"], "vps_failed")
        # New server already running, only removing app.old failed: the site is the new version, so commit.
        runner = FakeRunner(**{VPS_PUSH: lambda r, l: r.result(1, "Server berjalan. Buka https://x\nGagal: Membersihkan gagal (exit 1).\n")})
        self.assertEqual(self.publish(runner)[0], 0, self.output)
        self.assertIn("git commit", " ".join(runner.calls))

    def test_docs_build_failure_exit_4_before_vps(self):
        runner = FakeRunner(**{"build.py --out docs": lambda r, l: r.result(1, "boom")})
        code, _ = self.publish(runner)
        self.assertEqual(code, 4)
        self.assertTrue(self.no_calls(runner, VPS_PUSH, "git add", "git commit"))
        self.assertEqual(self.records()[-1]["status"], "gagal")

    def test_commit_step_failure_after_vps_exit_6(self):
        for step in ("git add", "git commit"):
            with self.subTest(step):
                runner = FakeRunner(**{step: lambda r, l: r.result(1, "index.lock exists")})
                code, summary = self.publish(runner)
                self.assertEqual(code, 6, self.output)
                self.assertLess(runner.index(VPS_PUSH), runner.index(step))
                self.assertTrue(self.no_calls(runner, "git push", "git tag"))
                rec = self.records()[-1]
                self.assertEqual((rec["status"], rec["vps"], summary["vps"]), ("vps_not_committed", True, True))
        def slow(r, l):
            raise subprocess.TimeoutExpired(l, 60)
        self.assertEqual(self.publish(FakeRunner(**{"git commit": slow}))[0], 6)
        self.assertEqual(self.records()[-1]["status"], "vps_not_committed")

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
        self.assertFalse([c for c in runner.calls if VPS_PUSH in c or c.startswith(("git add", "git commit", "git push", "git pull"))])
        self.assertEqual(self.records(), [])
        self.assertTrue(self.no_calls(runner, VPS_PUSH, "--out docs"))

    def test_build_check_wrong_category_stops_before_deploy(self):
        bad = build_stdout([(SB[0], "lainnya", "2026-10-05"), (SB[1], "stockbit-detail", "2026-10-05")])
        runner = FakeRunner(**{"build.py --out": lambda r, l: r.result(0, bad)})
        code, _ = self.publish(runner)
        self.assertEqual(code, 4)
        self.assertIn("lainnya", self.output)
        self.assertTrue(self.no_calls(runner, VPS_PUSH, "--out docs"))

    def test_sync_failure_stops(self):
        runner = FakeRunner(**{"sync_idx.py": lambda r, l: r.result(1, "Stockbit ditolak")})
        self.assertEqual(self.publish(runner)[0], 3)
        self.assertTrue(self.no_calls(runner, "build.py", VPS_PUSH))

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
        code, summary = self.publish(runner)
        self.assertEqual(code, 8)
        self.assertIn("git rebase --abort", runner.calls)
        self.assertIn("VPS sudah live", summary["error"])
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["vps"], rec["pre_sha"], rec["post_sha"]), ("push_failed", True, "pre1", "post1"))

    # --- regressions from the VPS-flow review ---------------------------------------------------------------------------

    def test_push_timeout_after_commit_is_push_failed_exit_8(self):
        def slow(r, l):
            raise subprocess.TimeoutExpired(l, 180)
        runner = FakeRunner(**{"git push origin HEAD:main": slow, "git pull --rebase": slow})
        code, summary = self.publish(runner)
        self.assertEqual(code, 8, self.output)
        self.assertIn("git rebase --abort", runner.calls)
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["pre_sha"], rec["post_sha"], rec["vps"]), ("push_failed", "pre1", "post1", True))
        self.assertEqual(rb.plan_for(rec)["mode"], "push_failed")
        # Timeout of a step after the commit that push() does not wrap (rev-parse) is push_failed / exit 8 as well.
        def rev(r, l):
            if r.state["committed"] and any(c.startswith("git push") for c in r.calls):
                raise subprocess.TimeoutExpired(l, 60)
            return r.result(0, ("post1" if r.state["committed"] else "pre1") + "\n")
        runner = FakeRunner(**{"git push origin HEAD:main": lambda r, l: r.result(1, "rejected"),
                               "git pull --rebase": lambda r, l: r.result(1, "x"), "git rev-parse HEAD": rev})
        self.assertEqual(self.publish(runner)[0], 8, self.output)
        self.assertEqual(self.records()[-1]["status"], "push_failed")

    def test_tag_failure_after_successful_push_stays_published(self):
        runner = FakeRunner(**{"git tag -a": lambda r, l: r.result(1, "fatal: tag exists")})
        code, summary = self.publish(runner)
        self.assertEqual(code, 8, self.output)
        self.assertIn("commit sudah dipush", summary["error"])
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["pre_sha"], rec["post_sha"], rec["tag"]), ("published", "pre1", "post1", None))
        self.assertEqual(rb.plan_for(rec)["mode"], "revert")
        # A tag push timeout is only a warning.
        def slow(r, l):
            raise subprocess.TimeoutExpired(l, 180)
        code, summary = self.publish(FakeRunner(**{"git push origin refs/tags/": slow}))
        self.assertEqual((code, summary["status"], summary["tag_pushed"]), (0, "published", False), self.output)

    def test_commit_failure_unstages_so_rerun_and_rollback_are_not_blocked(self):
        paths = f"needtobeindexed/idx-signal-desk/{SB[0]} docs site"
        def slow(r, l):
            raise subprocess.TimeoutExpired(l, 60)
        for label, fail in (("returns 1", lambda r, l: r.result(1, "pre-commit hook failed")), ("timeout", slow)):
            with self.subTest(label):
                runner = FakeRunner(**{"git commit": fail})
                code, _ = self.publish(runner)
                self.assertEqual(code, 6, self.output)
                self.assertLess(runner.index("git commit"), runner.index(f"git reset -q -- {paths}"))
                self.assertEqual(self.records()[-1]["status"], "vps_not_committed")
        # An add that fails or times out half-way is unstaged too.
        runner = FakeRunner(**{"git add": slow})
        self.assertEqual(self.publish(runner)[0], 6)
        self.assertIn(f"git reset -q -- {paths}", runner.calls)
        # Happy path never unstages.
        runner = FakeRunner()
        self.assertEqual(self.publish(runner)[0], 0)
        self.assertTrue(self.no_calls(runner, "git reset"))

    def test_unstage_after_hook_rejected_commit_with_real_git(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def runner(argv, timeout, **kwargs):
                return subprocess.run(argv, cwd=root, capture_output=True, text=True, timeout=timeout)
            ident = ["-c", "user.name=T", "-c", "user.email=t@example.test"]
            runner(["git", "init", "-q"], 10)
            (root / "a.md").write_text("a")
            runner(["git", "add", "a.md"], 10); runner(["git", *ident, "commit", "-qm", "init"], 10)
            hook = root / ".git/hooks/pre-commit"; hook.write_text("#!/bin/sh\nexit 1\n"); hook.chmod(0o755)
            (root / "sb.md").write_text("x")
            runner(["git", "add", "--", "sb.md"], 10)
            self.assertNotEqual(runner(["git", *ident, "commit", "-qm", "x", "--", "sb.md"], 10).returncode, 0)
            self.assertEqual(runner(["git", "diff", "--cached", "--quiet"], 10).returncode, 1)
            with redirect_stdout(io.StringIO()):
                pub.unstage(runner, ["sb.md"])
            self.assertEqual(runner(["git", "diff", "--cached", "--quiet"], 10).returncode, 0)
            self.assertTrue((root / "sb.md").exists())

    def test_deleted_sb_copy_in_rebuilt_docs_stops_before_vps(self):
        stale = "docs/files/stockbit-ringkasan/2026-10-01/sbringkas_2026-10-01_2026-10-01.md"
        dest = "needtobeindexed/idx-signal-desk/"
        def status(r, l):
            built = any(c.endswith("build.py --out docs") for c in r.calls)
            return r.result(0, f"?? {dest}{SB[0]}\0" + (f" D {stale}\0" if built else ""))
        runner = FakeRunner(**{"git status": status})
        code, summary = self.publish(runner)
        self.assertEqual(code, 7, self.output)
        self.assertIn(stale, summary["error"])
        self.assertEqual(runner.state["vps"], 0)
        self.assertTrue(self.no_calls(runner, "git add", "git commit"))
        self.assertIn("git checkout -- docs site", runner.calls)  # docs/ restored: the next preflight is not blocked
        self.assertEqual(self.records()[-1]["status"], "gagal")

    def test_exit_8_advice_and_rerun_refused_while_commit_unpushed(self):
        runner = FakeRunner(**{"git push origin HEAD:main": lambda r, l: r.result(1, "rejected"),
                               "git pull --rebase": lambda r, l: r.result(1, "conflict")})
        code, summary = self.publish(runner)
        self.assertEqual(code, 8)
        self.assertIn("git push origin HEAD:main", summary["error"])
        self.assertIn("rollback_stockbit.py", summary["error"])
        self.assertNotIn("jalankan ulang", summary["error"])
        self.assertNotIn("jalankan ulang", pub.__doc__.split("  8 ")[1].split("\n  ")[0])
        runner = FakeRunner(**{"origin/main..HEAD": lambda r, l: r.result(0, "1\n")})
        code, summary = self.publish(runner)
        self.assertEqual(code, 2)
        self.assertIn("belum dipush", summary["error"])
        self.assertTrue(self.no_calls(runner, "sync_idx", VPS_PUSH))

    def test_push_failure_after_successful_rebase_records_rebased_commit(self):
        pushes = []
        def push(r, line):
            pushes.append(line)
            return r.result(1, "rejected")
        def pull(r, line):
            r.state["rebased"] = True
            return r.result(0)
        head = lambda r, l: r.result(0, ("post2" if r.state.get("rebased") else "post1" if r.state["committed"] else "pre1") + "\n")
        runner = FakeRunner(**{"git push origin HEAD:main": push, "git pull --rebase": pull,
                               "git rev-parse HEAD^": lambda r, l: r.result(0, ("upstream1" if r.state.get("rebased") else "pre1") + "\n"),
                               "git rev-parse HEAD": head})
        self.assertEqual(self.publish(runner)[0], 8, self.output)
        self.assertEqual(len(pushes), 2)
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["pre_sha"], rec["post_sha"]), ("push_failed", "upstream1", "post2"))
        # Rollback resets that local commit instead of refusing with "HEAD bukan commit publish".
        check = FakeRunner(**{"git status": lambda r, l: r.result(0, ""), "is-ancestor post2 origin/main": lambda r, l: r.result(1),
                              "git rev-parse HEAD": lambda r, l: r.result(0, "post2\n"),
                              "git diff --name-only": lambda r, l: r.result(0, f"needtobeindexed/idx-signal-desk/{SB[0]}\n")})
        self.assertEqual(rb.preflight(check, rec, rb.plan_for(rec)), "reset")

    def test_total_budget_caps_vps_timeout_and_refuses_late_vps(self):
        now = [0.0]
        clock = lambda: now[0]
        runner = FakeRunner()
        self.assertEqual(self.publish(runner, budget=pub.Budget(1500, clock=clock))[0], 0, self.output)
        self.assertEqual(dict(runner.timeouts)[VPS_PUSH], 1500 - pub.POST_VPS_RESERVE)
        self.assertTrue(all(t <= 1500 for _, t in runner.timeouts))
        # Default budget stays under the desk's 3600 s publish limit (and 1800 s for rollback).
        self.assertLess(pub.PUBLISH_BUDGET, 3600)
        self.assertLess(pub.ROLLBACK_BUDGET, 1800)
        # Not enough time left for the VPS push and the commit: VPS untouched, no commit.
        def slow_build(r, l):
            now[0] += 700
            return r.result(0)
        now[0] = 0.0
        runner = FakeRunner(**{"build.py --out docs": slow_build})
        code, summary = self.publish(runner, budget=pub.Budget(1500, clock=clock))
        self.assertEqual(code, 5, self.output)
        self.assertIn("sisa waktu", summary["error"])
        self.assertEqual(runner.state["vps"], 0)
        self.assertEqual(self.records()[-1]["status"], "gagal")
        # Budget exhausted during the sync: the next command is not even started.
        def slow_sync(r, l):
            now[0] += 5000
            return r.result(0)
        now[0] = 0.0
        runner = FakeRunner(**{"sync_idx.py": slow_sync})
        self.assertEqual(self.publish(runner, budget=pub.Budget(1500, clock=clock))[0], 1)
        self.assertTrue(self.no_calls(runner, "build.py", VPS_PUSH))

    def test_tee_timeout_kills_whole_process_group(self):
        started = time.monotonic()
        with redirect_stdout(io.StringIO()) as out, self.assertRaises(subprocess.TimeoutExpired):
            pub.run_command(["sh", "-c", "sleep 20 & echo $!; wait"], timeout=1, tee=True)
        self.assertLess(time.monotonic() - started, 10, "grandchild kept stdout open: not killed with the group")
        pid = int(out.getvalue().split()[0])
        for _ in range(40):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            self.fail("background child still alive after timeout")

    def test_day_shas_recorded_from_state_sent_to_vps(self):
        # Review finding 2: the per-day export sha is read before the VPS push; a later rewrite of the state is not recorded.
        state = self.dest / ".sync-stockbit.json"
        state.write_text(json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "s1|t|final"}}}))
        def vps(r, l):
            state.write_text(json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "s2|t|final"}}}))
            return r.default(l)
        runner = FakeRunner(**{VPS_PUSH: vps, "git commit": lambda r, l: r.result(1, "hook failed")})
        self.assertEqual(self.publish(runner)[0], 6, self.output)
        rec = self.records()[-1]
        self.assertEqual((rec["status"], rec["day_shas"]), ("vps_not_committed", {"2026-10-05": "s1"}))
        self.assertEqual(pub.state_day_shas(["sbpekan_2026-09-28_2026-10-04.md", SB[1]], "not json"), {"2026-10-05": "*"})

    def test_build_table_and_commit_label(self):
        self.assertEqual(len(pub.check_build(GOOD_BUILD, SB)), 2)
        with self.assertRaises(pub.Failure):
            pub.check_build(build_stdout([(SB[0], "stockbit-ringkasan", "2026-10-04")]), SB[:1])
        with self.assertRaises(pub.Failure):
            pub.check_build(GOOD_BUILD, SB + ["sbpekan_2026-10-05_2026-10-11.md"])
        self.assertIn("2026-10-01 s/d 2026-10-07 (7 hari)",
                      pub.commit_message([f"sbringkas_2026-10-0{d}_2026-10-0{d}.md" for d in range(1, 8)]))


HOLD = "needtobeindexed/idx-signal-desk/.stockbit-hold.json"


class RollbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        p = patch.object(pub, "ROOT", self.root); p.start(); self.addCleanup(p.stop)
        (self.root / ".local").mkdir(); (self.root / pub.VPS_CONFIG_REL).write_text("{}")
        self.log = self.root / ".stockbit-publish/log.jsonl"
        self.log.parent.mkdir()
        self.write([{"type": "publish", "status": "published", "tag": "stockbit-publish-20261006-100000", "pre_sha": "a0",
                     "post_sha": "a1", "worker_version_before": "v-a", "worker_version_after": "v-b"},
                    {"type": "publish", "status": "gagal", "tag": None},
                    {"type": "publish", "status": "published", "tag": "stockbit-publish-20261007-101500", "pre_sha": "b0",
                     "post_sha": "b1", "worker_version_before": "v-b", "worker_version_after": "v-live", "files": [SB[0]]}])

    def write(self, rows):
        self.log.write_text("".join(json.dumps(r) + "\n" for r in rows))

    def rollback(self, runner, tag=None, dry_run=False, which=lambda t: "/bin/" + t):
        with redirect_stdout(io.StringIO()) as out:
            code, summary = rb.rollback(SimpleNamespace(tag=tag, dry_run=dry_run), runner=runner,
                                        which=which, log=self.log)
        self.output = out.getvalue()
        return code, summary

    def runner(self, **overrides):
        state = json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "shaX|t1|final"}}})
        base = {"git status": lambda r, l: r.result(0, "?? needtobeindexed/idx-signal-desk/.sync-abc123\0"),
                "git show b1:": lambda r, l: r.result(0, state),
                "git diff --name-only": lambda r, l: r.result(0, f"docs/index.html\nneedtobeindexed/idx-signal-desk/{SB[0]}\nsite/index.html\n")}
        return FakeRunner(**{**base, **overrides})

    def last(self):
        return json.loads(self.log.read_text().splitlines()[-1])

    def hold(self):
        return json.loads((self.root / HOLD).read_text())["days"]

    def test_reverts_recorded_range_then_pushes_vps_never_worker(self):
        runner = self.runner()
        code, summary = self.rollback(runner)
        self.assertEqual(code, 0, self.output)
        order = ["git fetch origin main", "git merge-base --is-ancestor b0 b1", "git checkout -- docs site",
                 "git revert --no-commit b0..b1", f"git add -- {HOLD}", "git commit -q -m Rollback Stockbit",
                 "git push origin HEAD:main", VPS_PUSH]
        positions = [runner.index(n) for n in order]
        self.assertEqual(positions, sorted(positions), runner.calls)
        self.assertEqual(runner.state["vps"], 1)
        self.assertFalse([c for c in runner.calls if "--force" in c or "reset --hard" in c])
        self.assertFalse([c for c in runner.calls if "wrangler" in c or "npx" in c or "sync_chat_index" in c])
        # Old log records still carry worker_version_*: noted, never acted on.
        self.assertIn("Worker lama tidak dipakai lagi", self.output)
        rec = self.last()
        self.assertEqual((rec["type"], rec["tag"], rec["reverted"], rec["status"], rec["vps"], rec["target"]),
                         ("rollback", "stockbit-publish-20261007-101500", "b0..b1", "rolled_back", True, "vps"))
        self.assertEqual((summary["status"], summary["vps"]), ("rolled_back", True))
        # The hold makes the rollback stick: the desk still exports 2026-10-05 with sha shaX.
        self.assertEqual(self.hold(), {"2026-10-05": {"sha256": "shaX", "rollback_of": "stockbit-publish-20261007-101500"}})
        # Same publish cannot be rolled back twice.
        self.assertEqual(self.rollback(self.runner())[0], 2)

    def test_tag_for_older_publish_needs_newer_rolled_back_first(self):
        self.assertEqual(self.rollback(self.runner(), tag="stockbit-publish-20261006-100000")[0], 2)
        self.assertIn("lebih baru", self.output)
        self.assertEqual(self.rollback(self.runner())[0], 0, self.output)
        runner = self.runner()
        self.assertEqual(self.rollback(runner, tag="stockbit-publish-20261006-100000")[0], 0, self.output)
        self.assertIn("git revert --no-commit a0..a1", runner.calls)
        self.assertLess(runner.index("git revert --no-commit a0..a1"), runner.index(VPS_PUSH))
        self.assertEqual(self.rollback(self.runner(), tag="stockbit-publish-nope")[0], 2)

    def test_dry_run_prints_plan_only(self):
        runner = self.runner()
        code, summary = self.rollback(runner, dry_run=True)
        self.assertEqual((code, summary["plan"]["revert"]), (0, "b0..b1"))
        self.assertIn("b0..b1", self.output)
        self.assertIn("node local/vps.mjs push", self.output)
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

    def test_preflight_needs_node_and_vps_config(self):
        runner = self.runner()
        code, summary = self.rollback(runner, which=lambda t: None if t == "node" else "/bin/" + t)
        self.assertEqual(code, 2)
        self.assertIn("'node' tidak ditemukan", summary["error"])
        self.assertEqual(runner.calls, [])
        (self.root / pub.VPS_CONFIG_REL).unlink()
        runner = self.runner()
        self.assertEqual(self.rollback(runner)[0], 2)
        self.assertEqual(runner.calls, [])
        # npx is not needed anymore.
        (self.root / pub.VPS_CONFIG_REL).write_text("{}")
        self.assertEqual(self.rollback(self.runner(), which=lambda t: None if t == "npx" else "/bin/" + t)[0], 0, self.output)

    def test_partial_rerun_skips_git_and_retries_vps(self):
        fail = self.runner(**{VPS_PUSH: lambda r, l: r.result(1, "Gagal: Upload gagal (tar 0, ssh 255).")})
        code, summary = self.rollback(fail)
        self.assertEqual(code, 5)
        self.assertIn("git revert --no-commit b0..b1", fail.calls)
        self.assertIn("node local/vps.mjs push", self.output)
        self.assertEqual((self.last()["status"], self.last()["vps"], summary["vps"]), ("partial", False, False))
        again = self.runner()
        self.assertEqual(self.rollback(again)[0], 0, self.output)
        self.assertFalse([c for c in again.calls if c.startswith(("git revert", "git commit", "git push", "git fetch"))])
        self.assertEqual([c for c in again.calls if not c.startswith(("git rev-parse --abbrev-ref", "git diff --cached --quiet",
                                                                      "git status", "git rev-parse -q --verify REVERT_HEAD",
                                                                      "git rev-parse --git-path sequencer", "git ls-files",
                                                                      "git checkout -- docs site", "git clean -fdq -- docs site"))],
                         [VPS_PUSH])
        self.assertLess(again.index("git checkout -- docs site"), again.index(VPS_PUSH))  # derived dirt not uploaded
        self.assertEqual(self.last()["status"], "rolled_back")
        self.assertEqual(self.rollback(self.runner())[0], 2)

    def test_git_push_failure_still_restores_site(self):
        runner = self.runner(**{"git push origin HEAD:main": lambda r, l: r.result(1, "rejected"),
                                "git pull --rebase": lambda r, l: r.result(1, "conflict")})
        code, summary = self.rollback(runner)
        self.assertEqual(code, 4, self.output)
        self.assertLess(runner.index("git commit -q -m Rollback Stockbit"), runner.index(VPS_PUSH))
        self.assertIn("git push origin HEAD:main", self.output)
        self.assertEqual((self.last()["status"], self.last()["vps"], summary["vps"]), ("push_failed", True, True))

    def test_vps_without_commit_restores_tree_then_pushes_vps(self):
        legacy = {"status": "deployed_index_pending", "worker_version_before": "v-b", "worker_version_after": "v-live"}
        # day_shas (recorded before the VPS push) gives the live sha; an old record without it holds "*" rather than trusting
        # the working-tree state (shaZ here), which a later sync may have rewritten.
        for label, fields in (("vps", {"status": "vps_not_committed", "target": "vps", "vps": True,
                                       "day_shas": {"2026-10-05": "shaY"}}), ("legacy", legacy)):
            with self.subTest(label):
                self.write([{"type": "publish", "started_at": "s-" + label, "pre_sha": None, "post_sha": None,
                             "files": [SB[0]], **fields}])
                dest = self.root / pub.DEST_REL; dest.mkdir(parents=True, exist_ok=True)
                (dest / SB[0]).write_text("new day")
                (dest / ".sync-stockbit.json").write_text(json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "shaZ|t|final"}}}))
                status = (f" M docs/index.html\0 M site/index.html\0?? needtobeindexed/idx-signal-desk/{SB[0]}\0"
                          " M needtobeindexed/idx-signal-desk/stockbit-index.json\0 M needtobeindexed/idx-signal-desk/.sync-stockbit.json\0")
                runner = self.runner(**{"git status": lambda r, l: r.result(0, status)})
                code, _ = self.rollback(runner)
                self.assertEqual(code, 0, self.output)
                self.assertFalse((dest / SB[0]).exists())
                self.assertIn("git checkout HEAD -- needtobeindexed/idx-signal-desk/stockbit-index.json "
                              "needtobeindexed/idx-signal-desk/.sync-stockbit.json", runner.calls)
                self.assertIn("git checkout -- docs site", runner.calls)
                self.assertFalse([c for c in runner.calls if c.startswith(("git fetch", "git revert", "git push", "git pull"))])
                self.assertLess(runner.index("git checkout -- docs site"), runner.index(VPS_PUSH))
                self.assertEqual(self.hold()["2026-10-05"]["sha256"], "shaY" if label == "vps" else "*")
                (self.root / HOLD).unlink()
                self.assertEqual(self.last()["status"], "rolled_back")
                self.assertEqual("Worker lama tidak dipakai lagi" in self.output, label == "legacy")

    def test_superseded_uncommitted_publish_is_covered(self):
        self.write([{"type": "publish", "status": "vps_not_committed", "target": "vps", "started_at": "s1", "vps": True},
                    {"type": "publish", "status": "published", "target": "vps", "tag": "t2", "pre_sha": "b0", "post_sha": "b1",
                     "vps": True, "supersedes": ["s1"]}])
        runner = self.runner()
        self.assertEqual(self.rollback(runner)[0], 0, self.output)
        self.assertNotIn("Worker", self.output)
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
        # The VPS was updated before the commit, so it is pushed again from the reset tree.
        self.assertLess(runner.index("git reset --keep b0"), runner.index(VPS_PUSH))
        self.assertIn("2026-10-05", self.hold())

    def test_rollback_keeps_desk_hold_fields_and_does_not_hold_withdrawn_days(self):
        hold = self.root / HOLD
        hold.parent.mkdir(parents=True)
        hold.write_text(json.dumps({"format": 1, "days": {
            "2026-10-03": {"sha256": "*", "withheld_by": "desk"},
            "2026-10-05": {"sha256": "*", "withheld_by": "desk"}}}))
        # The publish brought 2026-10-05 and removed the files of desk-withheld 2026-10-04.
        removed = "needtobeindexed/idx-signal-desk/sbringkas_2026-10-04_2026-10-04.md\n"
        runner = self.runner(**{"--diff-filter=D --name-only b0 b1": lambda r, l: r.result(0, removed),
                                "git diff --name-only": lambda r, l: r.result(0, f"needtobeindexed/idx-signal-desk/{SB[0]}\n" + removed)})
        self.assertEqual(self.rollback(runner)[0], 0, self.output)
        self.assertEqual(self.hold(), {
            "2026-10-03": {"sha256": "*", "withheld_by": "desk"},
            "2026-10-05": {"sha256": "shaX", "withheld_by": "desk", "rollback_of": "stockbit-publish-20261007-101500"}})
        self.assertEqual(self.last()["held"], {"2026-10-05": "shaX"})

    def test_rollback_of_withholding_publish_is_refused_without_changes(self):
        rows = [json.loads(l) for l in self.log.read_text().splitlines()]
        rows[-1]["withheld"] = ["2026-10-03"]
        self.write(rows)
        for dry_run in (True, False):
            with self.subTest(dry_run=dry_run):
                runner = self.runner()
                code, summary = self.rollback(runner, dry_run=dry_run)
                self.assertEqual(code, 2, self.output)
                self.assertIn("ditahan desk", summary["error"])
                self.assertEqual(runner.calls, [], "nothing reverted, reset, restored or rolled back")
                self.assertFalse((self.root / HOLD).exists())
        # Deploy-without-commit variant (restore mode) is refused as well.
        for status in ("vps_not_committed", "deployed_not_committed"):
            self.write([{"type": "publish", "status": status, "started_at": "s1", "withheld": ["2026-10-03"]}])
            runner = self.runner()
            self.assertEqual(self.rollback(runner)[0], 2)
            self.assertEqual(runner.calls, [])

    # --- regressions from the VPS-flow review ---------------------------------------------------------------------------

    def restore_case(self, status_extra="", rows=None):
        self.write(rows or [{"type": "publish", "status": "vps_not_committed", "target": "vps", "vps": True, "started_at": "s1",
                             "pre_sha": None, "post_sha": None, "files": [SB[0]]}])
        dest = self.root / pub.DEST_REL; dest.mkdir(parents=True, exist_ok=True)
        (dest / SB[0]).write_text("new day")
        status = f" M docs/index.html\0?? needtobeindexed/idx-signal-desk/{SB[0]}\0" + status_extra
        return dest, self.runner(**{"git status": lambda r, l: r.result(0, status)})

    def test_restore_refuses_outside_changes_before_touching_anything(self):
        for dirty in (" M build.py\0", "?? local/new.mjs\0", "?? needtobeindexed/ki_20261008.md\0"):
            with self.subTest(dirty):
                dest, runner = self.restore_case(dirty)
                code, summary = self.rollback(runner)
                self.assertEqual(code, 2, self.output)
                self.assertIn("push VPS akan ikut mengirim", summary["error"])
                self.assertTrue((dest / SB[0]).exists())
                self.assertFalse([c for c in runner.calls if c.startswith("git checkout") or c == VPS_PUSH])
                self.assertFalse((self.root / HOLD).exists())

    def test_revert_refuses_untracked_unreviewed_documents(self):
        runner = self.runner(**{"git status": lambda r, l: r.result(0, "?? needtobeindexed/digest_2026-10-08_2026-10-08.md\0")})
        self.assertEqual(self.rollback(runner)[0], 2)
        self.assertFalse([c for c in runner.calls if "revert" in c or c == VPS_PUSH])

    def test_first_revert_refuses_untracked_unpublished_stockbit_day(self):
        """A later publish synced a new day and failed its build check (untracked file): the first revert must not push it."""
        later = "sbringkas_2026-10-11_2026-10-11.md"
        runner = self.runner(**{"git status": lambda r, l: r.result(0, f"?? needtobeindexed/idx-signal-desk/{later}\0")})
        code, summary = self.rollback(runner)
        self.assertEqual(code, 2, self.output)
        self.assertIn(later, summary["error"])
        self.assertFalse([c for c in runner.calls if "revert" in c or c == VPS_PUSH or c.startswith("git push")])
        self.assertFalse((self.root / HOLD).exists())

    def test_partial_rerun_checks_branch_and_tree_before_vps(self):
        self.assertEqual(self.rollback(self.runner(**{VPS_PUSH: lambda r, l: r.result(1, "Gagal")}))[0], 5)
        for label, override in (("branch", {"--abbrev-ref": lambda r, l: r.result(0, "other\n")}),
                                ("dirty", {"git status": lambda r, l: r.result(0, " M worker/core.mjs\0")}),
                                ("staged", {"git diff --cached --quiet": lambda r, l: r.result(1)})):
            with self.subTest(label):
                runner = self.runner(**override)
                self.assertEqual(self.rollback(runner)[0], 2, self.output)
                self.assertNotIn(VPS_PUSH, runner.calls)
        self.assertEqual(self.rollback(self.runner())[0], 0, self.output)

    def test_rerun_after_revert_push_failure_pushes_without_reverting_again(self):
        fail = {"git push origin HEAD:main": lambda r, l: r.result(1, "rejected"), "git pull --rebase": lambda r, l: r.result(1, "x")}
        for label in ("still_local", "pushed_by_hand"):
            with self.subTest(label):
                self.setUp()
                code, _ = self.rollback(self.runner(**fail))
                self.assertEqual(code, 4, self.output)
                first = self.last()
                self.assertEqual((first["status"], first["revert_sha"], first["git_done"]), ("push_failed", "post1", True))
                ancestor = 0 if label == "pushed_by_hand" else 1
                again = self.runner(**{"is-ancestor post1 origin/main": lambda r, l, a=ancestor: r.result(a),
                                       "git rev-parse HEAD": lambda r, l: r.result(0, "post1\n")})
                self.assertEqual(self.rollback(again)[0], 0, self.output)
                self.assertFalse([c for c in again.calls if c.startswith(("git revert", "git commit"))])
                self.assertEqual("git push origin HEAD:main" in again.calls, label == "still_local")
                self.assertLess(again.index("git fetch origin main"), again.index(VPS_PUSH))
                rec = self.last()
                self.assertEqual((rec["status"], rec["revert_sha"]), ("rolled_back", "post1"))
                # The publish is done: an older --tag rollback is no longer blocked.
                self.assertEqual(self.rollback(self.runner(), tag="stockbit-publish-20261006-100000")[0], 0, self.output)
        # HEAD moved away from the revert commit: refused, nothing pushed.
        self.setUp()
        self.rollback(self.runner(**fail))
        moved = self.runner(**{"is-ancestor post1 origin/main": lambda r, l: r.result(1),
                               "git rev-parse HEAD": lambda r, l: r.result(0, "other\n")})
        self.assertEqual(self.rollback(moved)[0], 2)
        self.assertFalse([c for c in moved.calls if c.startswith("git push") or c == VPS_PUSH])

    def test_restore_holds_only_days_of_the_target_publish(self):
        rows = [{"type": "publish", "status": "vps_not_committed", "target": "vps", "vps": True, "started_at": "V",
                 "pre_sha": None, "post_sha": None, "files": [SB[0]]},
                {"type": "publish", "status": "vps_failed", "target": "vps", "started_at": "P2"}]
        later = "sbringkas_2026-10-06_2026-10-06.md"
        dest, runner = self.restore_case(f"?? needtobeindexed/idx-signal-desk/{later}\0", rows=rows)
        (dest / later).write_text("never published")
        (dest / ".sync-stockbit.json").write_text(json.dumps({"format": 1, "days": {
            "2026-10-05": {"fp": "shaV|t|final"}, "2026-10-06": {"fp": "shaD2|t|final"}}}))
        self.assertEqual(self.rollback(runner)[0], 0, self.output)
        self.assertEqual(self.last()["covers"], ["V"])
        self.assertEqual(set(self.hold()), {"2026-10-05"})

    def test_published_without_range_is_not_restored(self):
        self.write([{"type": "publish", "status": "published", "tag": "stockbit-publish-20261007-101500", "pre_sha": None,
                     "post_sha": "b1"}])
        runner = self.runner()
        code, summary = self.rollback(runner)
        self.assertEqual(code, 2)
        self.assertIn("rollback manual", summary["error"])
        self.assertEqual(runner.calls, [])

    def test_partial_record_written_before_vps_push_so_a_killed_run_resumes(self):
        seen = []
        def vps(r, l):
            seen.append(self.last())
            raise KeyboardInterrupt  # stands in for the desk killing the script mid-push
        with self.assertRaises(KeyboardInterrupt):
            self.rollback(self.runner(**{VPS_PUSH: vps}))
        self.assertEqual((seen[0]["status"], seen[0]["git_done"], seen[0]["vps"]), ("partial", True, None))
        again = self.runner()
        self.assertEqual(self.rollback(again)[0], 0, self.output)
        self.assertFalse([c for c in again.calls if c.startswith(("git revert", "git commit", "git push"))])
        self.assertEqual(self.last()["status"], "rolled_back")

    def test_rollback_budget_caps_vps_timeout(self):
        def run(runner, seconds):
            with redirect_stdout(io.StringIO()):
                return rb.rollback(SimpleNamespace(tag=None, dry_run=False), runner=runner, which=lambda t: "/bin/" + t,
                                   log=self.log, budget=pub.Budget(seconds, clock=lambda: 0.0))[0]
        runner = self.runner()
        self.assertEqual(run(runner, 1000), 0)
        self.assertEqual(dict(runner.timeouts)[VPS_PUSH], 970)
        self.assertTrue(all(t <= 1000 for _, t in runner.timeouts))
        # Too little left for a VPS push after the git steps: not started, recorded partial (the re-run only pushes the VPS).
        self.setUp()
        runner = self.runner()
        self.assertEqual(run(runner, 200), 5)
        self.assertNotIn(VPS_PUSH, runner.calls)
        self.assertEqual((self.last()["status"], self.last()["git_done"]), ("partial", True))

    def test_revert_conflict_aborts(self):
        runner = self.runner(**{"git revert --no-commit": lambda r, l: r.result(1, "conflict")})
        self.assertEqual(self.rollback(runner)[0], 3)
        self.assertIn("git revert --abort", runner.calls)
        self.assertFalse([c for c in runner.calls if "push" in c])
        self.assertEqual(self.last()["status"], "gagal")

    # --- regressions from the second review ------------------------------------------------------------------------------

    def test_resumed_rollback_refuses_unpublished_stockbit_files(self):
        """Finding 1: a later failed publish left synced, build-unchecked files; a resumed run must not push them live."""
        dest = "needtobeindexed/idx-signal-desk/"
        stale = (f" M {dest}stockbit-index.json\0 M {dest}.sync-stockbit.json\0"
                 f"?? {dest}sbringkas_2026-10-09_2026-10-09.md\0 M docs/index.html\0")
        fail_git = {"git push origin HEAD:main": lambda r, l: r.result(1, "rejected"), "git pull --rebase": lambda r, l: r.result(1, "x")}
        for label, first, expected in (("partial", {VPS_PUSH: lambda r, l: r.result(1, "Gagal")}, 5), ("push_failed", fail_git, 4)):
            with self.subTest(label):
                self.setUp()
                self.assertEqual(self.rollback(self.runner(**first))[0], expected, self.output)
                rows = [json.loads(l) for l in self.log.read_text().splitlines()]
                self.write(rows + [{"type": "publish", "status": "gagal", "started_at": "later"}])
                runner = self.runner(**{"git status": lambda r, l: r.result(0, stale),
                                        "is-ancestor post1 origin/main": lambda r, l: r.result(1),
                                        "git rev-parse HEAD": lambda r, l: r.result(0, "post1\n") if l == "git rev-parse HEAD" else r.default(l)})
                code, summary = self.rollback(runner)
                self.assertEqual(code, 2, self.output)
                self.assertIn("sbringkas_2026-10-09_2026-10-09.md", summary["error"])
                self.assertIn("stockbit-index.json", summary["error"])
                self.assertFalse([c for c in runner.calls if c == VPS_PUSH or c.startswith(("git push", "git revert", "git checkout"))])
                # Only the hold file (written by the rollback itself) and derived dirt: resumes, docs/ restored before the VPS push.
                ok = self.runner(**{"git status": lambda r, l: r.result(0, f" M {dest}.stockbit-hold.json\0 M docs/index.html\0"),
                                    "is-ancestor post1 origin/main": lambda r, l: r.result(0)})
                self.assertEqual(self.rollback(ok)[0], 0, self.output)
                self.assertLess(ok.index("git checkout -- docs site"), ok.index(VPS_PUSH))
                self.assertEqual(self.last()["status"], "rolled_back")

    def test_restore_holds_sha_recorded_at_publish_not_resynced_one(self):
        """Finding 2: V went live with s1; the desk re-finalised the day (s2) and a later publish failed after syncing it."""
        rows = [{"type": "publish", "status": "vps_not_committed", "target": "vps", "vps": True, "started_at": "V",
                 "pre_sha": None, "post_sha": None, "files": [SB[0]], "day_shas": {"2026-10-05": "s1"}},
                {"type": "publish", "status": "vps_failed", "target": "vps", "started_at": "P2", "files": [SB[0]],
                 "day_shas": {"2026-10-05": "s2"}}]
        dest, runner = self.restore_case(rows=rows)
        (dest / ".sync-stockbit.json").write_text(json.dumps({"format": 1, "days": {"2026-10-05": {"fp": "s2|t|final"}}}))
        self.assertEqual(self.rollback(runner)[0], 0, self.output)
        self.assertEqual(self.hold(), {"2026-10-05": {"sha256": "s1", "rollback_of": "V"}})
        self.assertEqual(self.last()["held"], {"2026-10-05": "s1"})

    def rebased_publish_runner(self, cherry="- Xp\n", **extra):
        """push_failed publish b0..b1 pushed by hand after `git pull --rebase`: origin/main = b0 -> U (unrelated) -> Xp."""
        self.write([{"type": "publish", "status": "push_failed", "tag": None, "started_at": "s1", "pre_sha": "b0",
                     "post_sha": "b1", "files": [SB[0]]}])
        heads = {"git rev-parse HEAD": "Xp", "git rev-parse Xp^": "U"}
        return self.runner(**{"is-ancestor b1 origin/main": lambda r, l: r.result(1),
                              "git rev-parse": lambda r, l: r.result(0, heads[l] + "\n") if l in heads else r.default(l),
                              "git log -1 --format=%s b1": lambda r, l: r.result(0, "Stockbit: ringkasan 2026-10-05\n"),
                              "git log --no-merges --format=%H%x00%s b0..origin/main": lambda r, l: r.result(
                                  0, "Xp\0Stockbit: ringkasan 2026-10-05\nU\0Unrelated upstream change\n"),
                              "git cherry b1 Xp Xp^": lambda r, l: r.result(0, cherry), **extra})

    def test_push_failed_publish_pushed_after_rebase_reverts_the_copy(self):
        """Finding 5: the rebased copy Xp is found by subject + patch-id and reverted alone (U..Xp, not b0..Xp)."""
        runner = self.rebased_publish_runner()
        code, summary = self.rollback(runner)
        self.assertEqual(code, 0, self.output)
        self.assertIn("git revert --no-commit U..Xp", runner.calls)
        self.assertFalse([c for c in runner.calls if c.startswith("git reset") or "b0..b1" in c or "b0..Xp" in c and "revert" in c])
        self.assertIn("git diff --name-only U Xp", runner.calls)
        self.assertLess(runner.index("git push origin HEAD:main"), runner.index(VPS_PUSH))
        rec = self.last()
        self.assertEqual((rec["status"], rec["mode"], rec["reverted"], rec["rebased_from"]), ("rolled_back", "revert", "U..Xp", "b1"))
        # The record is done: it no longer blocks an older --tag rollback.
        self.assertEqual(self.rollback(self.runner())[0], 2)  # already rolled back
        # No patch-equivalent copy (or an ambiguous one): refused before anything changes.
        for cherry in ("+ Xp\n", ""):
            with self.subTest(cherry=cherry):
                runner = self.rebased_publish_runner(cherry=cherry)
                code, summary = self.rollback(runner)
                self.assertEqual(code, 2, self.output)
                self.assertIn("salinan hasil rebase", summary["error"])
                self.assertFalse([c for c in runner.calls if c.startswith(("git revert", "git reset", "git push")) or c == VPS_PUSH])

    def test_rollback_revert_pushed_after_rebase_is_recognised(self):
        """Finding 5 (rollback side): revert commit post1 pushed by hand as R2 after a rebase; the re-run only pushes the VPS."""
        fail = {"git push origin HEAD:main": lambda r, l: r.result(1, "rejected"), "git pull --rebase": lambda r, l: r.result(1, "x")}
        self.assertEqual(self.rollback(self.runner(**fail))[0], 4, self.output)
        again = self.runner(**{"is-ancestor post1 origin/main": lambda r, l: r.result(1),
                               "git rev-parse HEAD": lambda r, l: r.result(0, "R2\n") if l == "git rev-parse HEAD" else r.default(l),
                               "git merge-base post1 origin/main": lambda r, l: r.result(0, "b1\n"),
                               "git log -1 --format=%s post1": lambda r, l: r.result(0, "Rollback Stockbit stockbit-publish-20261007-101500\n"),
                               "git log --no-merges --format=%H%x00%s b1..origin/main": lambda r, l: r.result(
                                   0, "R2\0Rollback Stockbit stockbit-publish-20261007-101500\n"),
                               "git cherry post1 R2 R2^": lambda r, l: r.result(0, "- R2\n")})
        self.assertEqual(self.rollback(again)[0], 0, self.output)
        self.assertFalse([c for c in again.calls if c.startswith(("git push", "git revert", "git commit"))])
        self.assertIn(VPS_PUSH, again.calls)
        rec = self.last()
        self.assertEqual((rec["status"], rec["revert_sha"], rec["rebased_from"]), ("rolled_back", "R2", "post1"))
        self.assertEqual(self.rollback(self.runner(), tag="stockbit-publish-20261006-100000")[0], 0, self.output)

    def test_timeout_inside_revert_aborts_and_half_revert_is_refused(self):
        """Finding 6: a slow commit hook or the exhausted budget aborts the revert (unbudgeted), and a leftover REVERT_HEAD
        is refused with `git revert --abort` advice before anything else runs."""
        now = [0.0]
        def slow_commit(r, l):
            now[0] += 5000  # budget gone: a budget-wrapped abort would not even start
            raise subprocess.TimeoutExpired(l, 60)
        runner = self.runner(**{"git commit": slow_commit})
        with redirect_stdout(io.StringIO()) as out:
            code, summary = rb.rollback(SimpleNamespace(tag=None, dry_run=False), runner=runner, which=lambda t: "/bin/" + t,
                                        log=self.log, budget=pub.Budget(1000, clock=lambda: now[0]))
        self.assertEqual(code, 1, out.getvalue())
        self.assertLess(runner.index("git commit"), runner.index("git revert --abort"))
        self.assertNotIn(VPS_PUSH, runner.calls)
        self.assertEqual(self.last()["status"], "gagal")
        # The revert itself timing out is aborted as well.
        def slow(r, l):
            raise subprocess.TimeoutExpired(l, 60)
        runner = self.runner(**{"git revert --no-commit": slow})
        self.assertEqual(self.rollback(runner)[0], 1)
        self.assertIn("git revert --abort", runner.calls)
        # Left mid-revert anyway (abort failed): refused with the right advice, for first runs and resumed runs alike.
        stuck = self.runner(**{"git rev-parse -q --verify REVERT_HEAD": lambda r, l: r.result(0, "abc\n")})
        code, summary = self.rollback(stuck)
        self.assertEqual(code, 2)
        self.assertIn("git revert --abort", summary["error"])
        self.assertFalse([c for c in stuck.calls if c.startswith(("git revert", "git fetch", "git checkout")) or c == VPS_PUSH])

    def test_revert_in_progress_detected_with_real_git(self):
        def runner(argv, timeout, **kwargs):
            return subprocess.run(argv, cwd=self.root, capture_output=True, text=True, timeout=timeout)
        ident = ["-c", "user.name=T", "-c", "user.email=t@example.test"]
        runner(["git", "init", "-q"], 10)
        for text in ("a", "b", "c"):
            (self.root / "f.md").write_text(text)
            runner(["git", "add", "f.md"], 10); runner(["git", *ident, "commit", "-qm", text], 10)
        self.assertFalse(rb.revert_in_progress(runner))
        self.assertEqual(runner(["git", "revert", "--no-commit", "HEAD~2..HEAD"], 10).returncode, 0)
        self.assertTrue(rb.revert_in_progress(runner))
        with redirect_stdout(io.StringIO()):
            rb.abort_revert(runner)
        self.assertFalse(rb.revert_in_progress(runner))
        self.assertEqual(runner(["git", "status", "--porcelain", "--untracked-files=no"], 10).stdout, "")
        # A committed revert leaves no REVERT_HEAD behind.
        runner(["git", "revert", "--no-commit", "HEAD~1..HEAD"], 10); runner(["git", *ident, "commit", "-qm", "rb"], 10)
        self.assertFalse(rb.revert_in_progress(runner))

    def test_interim_record_is_marked(self):
        """Finding 7: the record written before the VPS push carries interim: true; the final one does not."""
        self.assertEqual(self.rollback(self.runner())[0], 0, self.output)
        rows = [json.loads(l) for l in self.log.read_text().splitlines() if json.loads(l).get("type") == "rollback"]
        self.assertEqual([(r["status"], r.get("interim", False)) for r in rows], [("partial", True), ("rolled_back", False)])
        self.assertEqual(rows[0]["started_at"], rows[1]["started_at"])
        # Interim records stay resumable.
        self.setUp()
        self.assertEqual(self.rollback(self.runner(**{VPS_PUSH: lambda r, l: r.result(1, "Gagal")}))[0], 5)
        self.write([json.loads(l) for l in self.log.read_text().splitlines()][:-1])  # killed before the final record
        self.assertTrue(self.last()["interim"])
        again = self.runner()
        self.assertEqual(self.rollback(again)[0], 0, self.output)
        self.assertFalse([c for c in again.calls if c.startswith(("git revert", "git commit"))])


class IgnoredBuildGitTests(unittest.TestCase):
    def test_current_and_legacy_build_folders_with_real_git(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            def runner(argv, timeout, **kwargs):
                return subprocess.run(argv, cwd=root, capture_output=True, text=True, timeout=timeout)
            def run(*args):
                result = runner(list(args), 10)
                self.assertEqual(result.returncode, 0, result.stderr)
                return result
            run("git", "init", "-q")
            for name in ("docs", "site"):
                (root / name).mkdir()
                (root / name / "index.html").write_text("original")
            (root / ".gitignore").write_text("site/\n")
            run("git", "add", ".gitignore", "docs")
            run("git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "fixture")
            self.assertEqual(pub.tracked_derived_paths(runner), ["docs"])
            (root / "docs/index.html").write_text("changed")
            rb.discard_derived(runner, 3)
            self.assertEqual((root / "docs/index.html").read_text(), "original")
            self.assertEqual((root / "site/index.html").read_text(), "original")
            run("git", "add", "-f", "site")
            self.assertEqual(pub.tracked_derived_paths(runner), ["docs", "site"])


if __name__ == "__main__":
    unittest.main()
