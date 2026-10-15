"""Desk publish -> rollback -> republish, end to end: tools/publish_stockbit.py and tools/rollback_stockbit.py run as the
desk runs them (subprocess, cwd = archive), on a temp git repo with a bare origin, a fake Signal Desk over HTTP and a
fake `node local/vps.mjs push` that records what it would send. Pins the desk contract: exit codes, the last JSON line,
the log.jsonl records, the tag format, commit subjects, the hold files and the files the VPS receives."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent / "helpers"))
from e2e import ROOT, copy_code, last_json, run, serve  # noqa: E402
from fake_desk import BeiDesk, StockbitDesk, sha  # noqa: E402

DAYS = ["2026-10-05", "2026-10-06"]
DEST = "needtobeindexed/idx-signal-desk"
FAKE_VPS = """import { appendFileSync, readdirSync } from 'node:fs';
const files = readdirSync('needtobeindexed/idx-signal-desk').filter((n) => n.endsWith('.md')).sort();
appendFileSync(process.env.FAKE_VPS_LOG, JSON.stringify({ argv: process.argv.slice(2), files }) + '\\n');
console.log('Server berjalan.');
"""
TAG = re.compile(r"stockbit-publish-\d{8}-\d{6}")
PUBLISH_KEYS = {"type", "target", "tag", "start_sha", "pre_sha", "post_sha", "vps", "files", "started_at", "finished_at",
                "status", "day_shas", "day_shas_bei"}


class DeskRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.repo, origin, self.vps_log = base / "arsip", base / "origin.git", base / "vps.jsonl"
        self.repo.mkdir()
        self.git("init", "-q", "--bare", "-b", "main", str(origin), cwd=base)
        copy_code(self.repo)
        (self.repo / "local").mkdir(); (self.repo / "local/vps.mjs").write_text(FAKE_VPS)
        (self.repo / ".local").mkdir(); (self.repo / ".local/vps.json").write_text("{}")
        (base / "hooks").mkdir()
        self.git("init", "-q", "-b", "main")
        for key, value in (("user.name", "Desk"), ("user.email", "desk@example.test"), ("commit.gpgsign", "false"),
                           ("tag.gpgsign", "false"), ("core.hooksPath", str(base / "hooks"))):
            self.git("config", key, value)
        self.git("add", "-A"); self.git("commit", "-qm", "arsip")
        self.git("remote", "add", "origin", str(origin)); self.git("push", "-q", "-u", "origin", "main")
        self.desk = BeiDesk(DAYS, stockbit=StockbitDesk(DAYS))
        server = serve(self.desk)
        self.server = server.__enter__(); self.addCleanup(server.__exit__, None, None, None)
        self.addCleanup(lambda: self.assertEqual(self.server.errors, []))
        self.last_publish = 0.0
        self.env = {**os.environ, "IDX_SIGNAL_DESK": self.server.url, "FAKE_VPS_LOG": str(self.vps_log)}

    def git(self, *args, cwd=None):
        result = subprocess.run(["git", *args], cwd=cwd or self.repo, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def script(self, name, *args):
        if name.startswith("publish"):  # the tag has a one-second stamp: never two publishes in the same second
            time.sleep(max(0.0, self.last_publish + 1.1 - time.time()))
            self.last_publish = time.time()
        code, out, err = run(self.repo, f"tools/{name}", *args, env=self.env)
        self.assertEqual(err, "", out)
        summary = last_json(out)
        self.assertEqual(summary["exit"], code)
        return code, summary, out

    def records(self):
        return [json.loads(line) for line in (self.repo / ".stockbit-publish/log.jsonl").read_text().splitlines()]

    def vps_calls(self):
        return [json.loads(line) for line in self.vps_log.read_text().splitlines()] if self.vps_log.exists() else []

    def subjects(self):
        return self.git("log", "--format=%s", "origin/main").splitlines()

    def hold(self, name):
        return json.loads((self.repo / DEST / name).read_text())["days"]

    def files(self):
        return sorted(p.name for p in (self.repo / DEST).glob("*.md"))

    def test_publish_rollback_republish(self):
        # 1. Publish two final days of each family.
        code, summary, out = self.script("publish_stockbit.py", "--stockbit-since", "2026-10-01")
        self.assertEqual(code, 0, out)
        self.assertEqual(set(summary), {"status", "dry_run", "started_at", "vps", "supports", "checked", "tag", "commit",
                                        "message", "log_status", "finished_at", "exit"})
        self.assertEqual((summary["status"], summary["vps"], summary["supports"], summary["checked"]),
                         ("published", True, ["stockbit", "bei"], 8))
        tag = summary["tag"]
        self.assertRegex(tag, TAG)
        message = "Stockbit: ringkasan 2026-10-05, 2026-10-06 · BEI: ringkasan 2026-10-05, 2026-10-06"
        self.assertEqual(summary["message"], message)
        self.assertEqual(self.subjects()[0], message)
        published = self.records()[-1]
        self.assertEqual(set(published), PUBLISH_KEYS)
        self.assertEqual((published["status"], published["target"], published["tag"], published["vps"]),
                         ("published", "vps", tag, True))
        self.assertEqual(published["day_shas"], {d: "h" + d for d in DAYS})
        self.assertEqual(published["day_shas_bei"], {d: "r" + d for d in DAYS})
        self.assertEqual(published["post_sha"], self.git("rev-parse", "origin/main"))
        self.assertIn(f"{published['post_sha']}\trefs/tags/{tag}^{{}}", self.git("ls-remote", "--tags", "origin"))  # annotated
        # Basenames of the committed sources and of their copies in docs/, as rollback reads them.
        names = ["bei-index.json", "stockbit-index.json"] + [f"{p}_{d}_{d}.md" for d in DAYS
                                                             for p in ("beidetail", "beiringkas", "sbdetail", "sbringkas")]
        self.assertEqual(published["files"], sorted(names * 2))
        self.assertEqual(self.vps_calls(), [{"argv": ["push"], "files": self.files()}])
        self.assertEqual(len(self.files()), 8)
        self.assertEqual(self.git("status", "--porcelain"), "")

        # 2. Roll it back: one revert commit, holds on every day it carried, the VPS follows the reverted tree.
        code, summary, out = self.script("rollback_stockbit.py")
        self.assertEqual(code, 0, out)
        self.assertEqual((summary["status"], summary["vps"], summary["held"], summary["held_bei"]),
                         ("rolled_back", True, DAYS, DAYS))
        self.assertEqual(summary["plan"]["mode"], "revert")
        self.assertEqual(self.subjects()[0], f"Rollback Stockbit {tag}")
        self.assertEqual(self.hold(".stockbit-hold.json"), {d: {"sha256": "h" + d, "rollback_of": tag} for d in DAYS})
        self.assertEqual(self.hold(".bei-hold.json"), {d: {"sha256": "r" + d, "rollback_of": tag} for d in DAYS})
        interim, final = self.records()[-2:]
        self.assertEqual((interim["status"], interim["interim"], final["status"], final["revert_sha"]),
                         ("partial", True, "rolled_back", self.git("rev-parse", "origin/main")))
        self.assertEqual(set(final), {"type", "started_at", "tag", "covers", "reverted", "target", "mode", "held", "held_bei",
                                      "git_done", "revert_sha", "vps", "status", "finished_at"})
        self.assertEqual(self.files(), [])
        self.assertEqual(self.vps_calls()[-1]["files"], [])
        self.assertEqual(self.git("status", "--porcelain"), "")
        code, summary, _ = self.script("rollback_stockbit.py")
        self.assertEqual((code, summary["status"]), (2, "gagal"))  # already rolled back

        # 3. Same desk again: the held days stay off the site; only the (now empty) indexes and states are published.
        code, summary, out = self.script("publish_stockbit.py")
        self.assertEqual((code, summary["status"]), (0, "published"), out)
        self.assertEqual(summary["message"], "Stockbit: ringkasan pembaruan indeks/situs · BEI: ringkasan pembaruan indeks/situs")
        self.assertEqual(self.files(), [])
        self.assertEqual(self.records()[-1]["day_shas"], {})
        self.assertNotIn("day_shas_bei", self.records()[-1])
        self.assertEqual(self.vps_calls()[-1]["files"], [])

        # 4. The desk refinalizes 2026-10-06 (new sha): only that Stockbit day is published again.
        text = StockbitDesk.day_text("2026-10-06", "ringkas", " (diperbaiki)")
        self.desk.stockbit.overrides[("2026-10-06", "ringkas")] = {"text": text, "sha256": sha(text)}
        self.desk.stockbit.listing[1]["sha256"] = "h2"
        code, summary, out = self.script("publish_stockbit.py")
        self.assertEqual((code, summary["status"]), (0, "published"), out)
        self.assertEqual(self.files(), ["sbdetail_2026-10-06_2026-10-06.md", "sbringkas_2026-10-06_2026-10-06.md"])
        self.assertEqual(self.subjects()[0], "Stockbit: ringkasan 2026-10-06")
        self.assertEqual(self.records()[-1]["day_shas"], {"2026-10-06": "h2"})
        self.assertEqual(self.vps_calls()[-1]["files"], self.files())

        # 5. The desk withholds it from the web: the files are withdrawn, and that publish cannot be rolled back.
        self.desk.stockbit.withheld = ["2026-10-06"]
        code, summary, out = self.script("publish_stockbit.py")
        self.assertEqual((code, summary["status"], summary["withheld"]), (0, "published", ["2026-10-06"]), out)
        self.assertEqual((self.records()[-1]["withheld"], self.records()[-1]["day_shas"]), (["2026-10-06"], {"2026-10-06": "*"}))
        self.assertEqual(self.files(), [])
        self.assertEqual(self.subjects()[0], "Stockbit: tahan 2026-10-06 dari web")
        self.assertEqual(self.hold(".stockbit-hold.json")["2026-10-06"]["withheld_by"], "desk")
        head = self.git("rev-parse", "HEAD")
        code, summary, out = self.script("rollback_stockbit.py")
        self.assertEqual(code, 2, out)
        self.assertIn("ditahan desk dari web", summary["error"])
        self.assertEqual((self.git("rev-parse", "HEAD"), self.git("status", "--porcelain")), (head, ""))

        # 6. Nothing new: no build, no VPS push, no commit.
        pushes = len(self.vps_calls())
        code, summary, out = self.script("publish_stockbit.py")
        self.assertEqual((code, summary["status"], self.records()[-1]["status"]), (0, "tidak ada perubahan", "tidak ada perubahan"))
        self.assertEqual((len(self.vps_calls()), self.git("rev-parse", "HEAD")), (pushes, head))

    def test_desk_finds_its_flags(self):
        """The desk greps these scripts for the flags it passes before offering them."""
        for name in ("publish_stockbit.py", "sync_idx.py"):
            text = (ROOT / "tools" / name).read_text()
            for flag in ("--stockbit-since", "--allow-provisional", "--with-bei"):
                self.assertIn(flag, text, name)


if __name__ == "__main__":
    unittest.main()
