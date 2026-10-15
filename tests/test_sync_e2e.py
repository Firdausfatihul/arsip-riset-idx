"""tools/sync_idx.py as the desk and the owner run it: a subprocess on a temp copy of the archive, a fake Signal Desk
over real HTTP. Covers the exit codes (0 ok, 1 unreachable/HTTP error/refused, 2 other profile, 3 build failed), the
staging (a refused sync writes nothing), the combined Stockbit + BEI run, and the ownership fingerprint skip."""
from contextlib import closing
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import unittest
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parent / "helpers"))
from e2e import copy_code, run, serve  # noqa: E402
from fake_desk import BeiDesk, StockbitDesk  # noqa: E402

SYNC = "tools/sync_idx.py"
DAYS = ["2026-10-05", "2026-10-06"]


class Desk(BeiDesk):
    """BEI + Stockbit exports plus the profile and ownership endpoints of the default sync."""

    def __init__(self, data_dir):
        super().__init__(DAYS, stockbit=StockbitDesk(DAYS))
        self.active, self.data_dir, self.fail = "p1", str(data_dir), {}

    def get(self, path, timeout=60):
        for prefix, code in self.fail.items():
            if path.startswith(prefix):
                self.calls.append(path)
                raise HTTPError(path, code, "broken", {}, None)
        if path == "/api/profiles":
            return {"active_profile_id": self.active, "profiles": [{"id": "p1", "data_dir": self.data_dir}, {"id": "p2"}]}
        if path.startswith("/api/ownership"):
            self.calls.append(path)
            if path.startswith("/api/ownership?"):
                return {"profile_id": "p1", "updated_at": "u1", "companies": [{"ticker": "BBCA"}], "ksei": {"months": ["2026-09"]}}
            # One KSEI month, one issuer report and one filing: all three ownership files are written.
            name = "PT DWIMURIA SARANA"
            holder = {"name": name, "pct": 54.94, "total": 100, "validation": "ok", "classification": "CP", "local_foreign": "L"}
            report = {"id": "v1", "holders": [{"name": name, "roles": ["controller"], "shares": 100, "pct": 54.94}]}
            filing = {"event_date": "2026-09-10", "holder_name": name, "shares_before": 90, "shares_after": 100,
                      "pct_before": 49.4, "pct_after": 54.94, "validation": "ok", "source_url": "https://www.idx.co.id/a.pdf"}
            return {"ticker": "BBCA", "company_name": "Bank Central Asia Tbk",
                    "ksei_periods": [{"period": "2026-09", "as_of": "2026-09-30", "total_pct": 54.94, "validation": "ok",
                                      "holders": [holder]}],
                    "periods": [{"period": "2026-09", "preferred_id": "v1", "versions": [report]}], "filings": [filing]}
        return super().get(path, timeout)


class SyncCliTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "arsip"; self.root.mkdir()
        copy_code(self.root)
        self.dest = self.root / "needtobeindexed/idx-signal-desk"
        self.ledger = Path(self.tmp.name) / "desk-data/ownership/ledger.sqlite3"; self.ledger.parent.mkdir(parents=True)
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.executescript("CREATE TABLE ksei_files(file_id TEXT, as_of TEXT, fetched_at TEXT, active INTEGER);"
                              "CREATE TABLE ksei_holdings(file_id TEXT, ticker TEXT);"
                              "INSERT INTO ksei_files VALUES('1', '2026-09-30', 'f1', 1);"
                              "INSERT INTO ksei_holdings VALUES('1', 'BBCA');")
        self.desk = Desk(self.ledger.parents[1])
        server = serve(self.desk)
        self.server = server.__enter__(); self.addCleanup(server.__exit__, None, None, None)
        self.addCleanup(lambda: self.assertEqual(self.server.errors, []))

    def sync(self, *args, server=None):
        return run(self.root, SYNC, "--server", server or self.server.url, *args)

    def files(self):
        return {p.name: p.read_bytes() for p in self.dest.iterdir()}

    def test_stockbit_and_bei_staging_and_exit_1(self):
        port = socket.socket(); port.bind(("127.0.0.1", 0)); closed = port.getsockname()[1]; port.close()
        code, _, err = self.sync("--stockbit-only", "--no-build", server=f"http://127.0.0.1:{closed}")
        self.assertEqual(code, 1); self.assertIn("tidak bisa dihubungi", err)

        code, out, err = self.sync("--stockbit-only", "--with-bei", "--no-build")
        self.assertEqual(code, 0, out + err)
        self.assertEqual(set(self.files()), {f"{p}_{d}_{d}.md" for p in ("sbringkas", "sbdetail", "beiringkas", "beidetail")
                                             for d in DAYS} | {"stockbit-index.json", ".sync-stockbit.json",
                                                               "bei-index.json", ".sync-bei.json"})
        self.assertFalse([c for c in self.desk.calls if c.startswith(("/api/profiles", "/api/ownership"))])
        self.assertFalse((self.root / "site").exists())

        # A refused Stockbit day writes nothing at all (BEI included); a refused BEI day only skips BEI.
        before = self.files()
        stockbit = self.desk.stockbit
        stockbit.listing.append({**stockbit.listing[0], "date": "2026-10-07", "sha256": "h7"})
        stockbit.days.append("2026-10-07")
        stockbit.overrides[("2026-10-07", "ringkas")] = {"sha256": "0" * 64}
        self.desk.days.append("2026-10-07")
        self.desk.listing.append({**self.desk.listing[0], "date": "2026-10-07", "sha256": "r7",
                                  "files": {"ringkas": "beiringkas_2026-10-07_2026-10-07.md",
                                            "detail": "beidetail_2026-10-07_2026-10-07.md"}})
        code, _, err = self.sync("--stockbit-only", "--with-bei", "--no-build")
        self.assertEqual(code, 1); self.assertIn("Stockbit ditolak, tidak ada berkas yang ditulis", err)
        self.assertEqual(self.files(), before)

        stockbit.overrides.clear()
        self.desk.overrides[("2026-10-07", "ringkas")] = {"sha256": "0" * 64}
        code, out, err = self.sync("--stockbit-only", "--with-bei", "--no-build")
        self.assertEqual(code, 0, out + err); self.assertIn("BEI dilewati", out)
        self.assertIn("sbringkas_2026-10-07_2026-10-07.md", self.files())
        self.assertNotIn("beiringkas_2026-10-07_2026-10-07.md", self.files())
        code, _, err = self.sync("--bei-only", "--no-build")
        self.assertEqual(code, 1); self.assertIn("BEI ditolak, tidak ada berkas yang ditulis", err)

        self.desk.fail["/api/stockbit/export/days"] = 500
        code, _, err = self.sync("--stockbit-only", "--no-build")
        self.assertEqual(code, 1); self.assertIn("HTTP 500", err)

    def test_default_sync_fingerprint_profile_guard_and_build(self):
        code, out, err = self.sync("--no-build")
        self.assertEqual(code, 0, out + err)
        self.assertIn("kepemilikan.json", self.files())
        self.assertIn("/api/ownership/BBCA?profile_id=p1", self.desk.calls)
        self.assertFalse([c for c in self.desk.calls if c.startswith(("/api/stockbit", "/api/bei"))])

        # Same summary and same ledger files: the per-issuer details are not fetched again.
        self.desk.calls.clear()
        self.assertEqual(self.sync("--no-build")[0], 0)
        self.assertNotIn("/api/ownership/BBCA?profile_id=p1", self.desk.calls)
        with closing(sqlite3.connect(self.ledger)) as con, con:
            con.execute("INSERT INTO ksei_files VALUES('2', '2026-10-15', 'f2', 1)")
        self.assertEqual(self.sync("--no-build")[0], 0)
        self.assertIn("/api/ownership/BBCA?profile_id=p1", self.desk.calls)

        before = self.files()
        self.desk.active = "p2"
        code, _, err = self.sync("--no-build")
        self.assertEqual(code, 2); self.assertIn("Dilewati", err)
        self.assertEqual(self.files(), before)

        self.desk.active = "p1"
        code, out, err = self.sync("--build")
        self.assertEqual(code, 0, out + err)
        self.assertTrue((self.root / "site/index.html").is_file())
        for folder in ("a", "b"):  # build.py refuses two sources with the same name
            (self.root / "needtobeindexed" / folder).mkdir()
            (self.root / "needtobeindexed" / folder / "ki_20260915.md").write_text("# KI\n")
        code, _, err = self.sync("--build")
        self.assertEqual(code, 3, err); self.assertIn("build.py gagal", err)


if __name__ == "__main__":
    unittest.main()
