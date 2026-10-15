"""build.py over the fixed sources of tests/helpers/doc_fixture.py (never the real archive): every naming rule, then
a golden snapshot of the per-document output lines, the page payload, the files/ list and the index.html hash.

After an intended change to build.py, app.css, app.js, chat.js or report-*.js, regenerate the snapshot explicitly:
    UPDATE_GOLDEN=1 python3 -B -m unittest discover -s tests -p test_build_golden.py
and review the diff of tests/golden/build.json.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests" / "helpers"))
from doc_fixture import RULES, build_fixture  # noqa: E402

GOLDEN = ROOT / "tests" / "golden" / "build.json"


class BuildGoldenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(tmp.cleanup)
        cls.out, stdout = build_fixture(tmp.name)
        cls.lines = stdout.replace(str(cls.out.resolve()), "<out>").splitlines()
        page = (cls.out / "index.html").read_text(encoding="utf-8")
        cls.payload = json.loads(re.search(r'id="arsip-data">(.*?)</script>', page, re.S)[1])
        cls.docs = {d["name"]: d for d in cls.payload["docs"]}
        cls.page_hash = hashlib.sha256(page.encode()).hexdigest()

    def test_naming_rules(self):
        self.assertEqual(sorted(self.docs), sorted(name for name, *_ in RULES))
        for name, cat, start, end, label in RULES:
            d = self.docs[name]
            self.assertEqual((d["cat"], d["start"], d["end"], d["label"]), (cat, start, end, label), name)
            self.assertEqual(d["path"], f"files/{cat}/{start}/{name}")
        self.assertTrue(self.docs["ki_20260915.md"]["lazy"])
        self.assertTrue(self.docs["digest_2026-10-01_2026-10-02.md"]["unlisted"])

    def test_golden_snapshot(self):
        keep = ("name", "cat", "kind", "start", "end", "label", "path", "title", "desc", "codes", "tickers", "lazy", "unlisted", "delimiter")
        snapshot = {
            "lines": self.lines,
            "payload_keys": sorted(self.payload),
            "docs": [{k: d[k] for k in keep if k in d} for d in self.payload["docs"]],
            "files": sorted(p.relative_to(self.out).as_posix() for p in self.out.rglob("*") if p.is_file()),
            "index_html_sha256": self.page_hash,
        }
        if os.environ.get("UPDATE_GOLDEN"):
            GOLDEN.parent.mkdir(exist_ok=True)
            GOLDEN.write_text(json.dumps(snapshot, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
        for key in snapshot:
            self.assertEqual(snapshot[key], golden[key], f"{key} differs from tests/golden/build.json (see module docstring)")


if __name__ == "__main__":
    unittest.main()
