"""tools/build_worker.py over the site of tests/helpers/doc_fixture.py, without the real desk data:
the chat manifest (documents, exclusions, hashes, tables) is compared with tests/golden/worker.json.

A change in chat_archive, evidence_index, event_index or archive_tables that alters what chat reads shows up here.
After an intended change: UPDATE_GOLDEN=1 python3 -B -m unittest discover -s tests -p test_worker_assets_golden.py
"""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "tests" / "helpers"), str(ROOT / "tools")]
import build_worker  # noqa: E402
from doc_fixture import build_fixture  # noqa: E402

GOLDEN = ROOT / "tests" / "golden" / "worker.json"


class WorkerAssetsGoldenTests(unittest.TestCase):
    def test_golden_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            site, _ = build_fixture(tmp)
            out, stdout = Path(tmp) / "assets", io.StringIO()
            with patch.object(build_worker, "DESK", Path(tmp) / "no-desk"), redirect_stdout(stdout):
                build_worker.build(site, out)
            manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        keep = ("name", "cat", "start", "end", "covers", "document_hash", "sizes", "priority")
        snapshot = {
            "lines": [line.replace(str(out.resolve()), "<out>") for line in stdout.getvalue().splitlines()],
            "keys": sorted(manifest),
            "docs": [{k: d[k] for k in keep if k in d} for d in manifest["docs"]],
            "version": manifest["version"],
            "retrieval_version": manifest["retrieval_version"],
            "tickers": manifest["tickers"],
            "handles": manifest["handles"],
            "tables": manifest["tables"],
            "asset_hashes": manifest["asset_hashes"],
        }
        if os.environ.get("UPDATE_GOLDEN"):
            GOLDEN.write_text(json.dumps(snapshot, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
        for key in snapshot:
            self.assertEqual(snapshot[key], golden[key], f"{key} differs from tests/golden/worker.json (see module docstring)")


if __name__ == "__main__":
    unittest.main()
