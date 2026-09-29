"""CSV build regressions using temporary sources and output; no network or real archives."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import build
from tools.chat_archive import read_archive


class CsvViewerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source, self.output = self.root / "sources", self.root / "site"
        self.source.mkdir()

    def generate(self, files):
        for name, raw in files.items():
            path = self.source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        with patch.multiple(build, SRC=self.source, OWN_SRC=self.source / "missing.json",
                            BASE_URL="", CHAT_API_URL="/api/chat"), \
                patch.object(sys, "argv", ["build.py", "--out", str(self.output)]), \
                redirect_stdout(io.StringIO()):
            build.main()
        page = (self.output / "index.html").read_text(encoding="utf-8")
        payload = re.search(r'id="arsip-data">(.*?)</script>', page, re.S)[1]
        return json.loads(payload)["docs"]

    def test_nested_uppercase_bom_discovery_and_original_bytes(self):
        raw = '\ufeffkode,catatan\r\nSOCI,"koma, kutip ""dua"" dan\r\nbaris baru"\r\n'.encode()
        docs = self.generate({
            "nested/stockbit_20260929.CSV": raw,
            ".hidden/ki_20260929.csv": b"secret,value\n1,2\n",
            "nested/.private.csv": b"secret,value\n1,2\n",
            "ignore.txt": b"not a document",
        })
        self.assertEqual(len(docs), 1)
        doc = docs[0]
        self.assertEqual((doc["kind"], doc["name"], doc["delimiter"]),
                         ("csv", "stockbit_20260929.CSV", ","))
        self.assertTrue(doc["content"].startswith("\ufeffkode,"))
        self.assertEqual((self.output / doc["path"]).read_bytes(), raw)
        self.assertEqual((self.source / "nested/stockbit_20260929.CSV").read_bytes(), raw)

    def test_semicolon_and_metadata_follow_filename_not_cells(self):
        raw = ('judul;tanggal;nilai\n'
               '"# Keterbukaan Informasi 1–5 September 2026";2026-09-05;00123\n').encode()
        doc, = self.generate({"stockbit_20260901.csv": raw})
        self.assertEqual(doc["delimiter"], ";")
        self.assertEqual(doc["title"], "stockbit 20260901")
        self.assertEqual(doc["cat"], "stockbit")
        self.assertEqual((doc["start"], doc["end"]), ("2026-09-01", "2026-09-01"))
        self.assertEqual((self.output / doc["path"]).read_bytes(), raw)
        archived, = read_archive(self.output)[0]
        self.assertEqual(archived["body"], raw.decode())
        self.assertEqual(archived["search_body"], raw.decode())

    def test_large_csv_uses_lazy_content_and_remains_searchable_for_worker(self):
        raw = b"kode,nilai\n" + b"SOCI,00123\n" * (build.EMBED_LIMIT // 11 + 1)
        self.assertGreater(len(raw), build.EMBED_LIMIT)
        doc, = self.generate({"ki_20260929.csv": raw})
        self.assertTrue(doc["lazy"])
        self.assertNotIn("content", doc)
        self.assertEqual((self.output / doc["path"]).read_bytes(), raw)
        archived, = read_archive(self.output)[0]
        self.assertEqual(archived["body"], raw.decode())
        self.assertEqual(archived["search_body"], raw.decode())
        self.assertEqual(archived["source_id"], doc["id"].upper())

    def test_uneven_semicolon_rows_use_header_delimiter(self):
        doc, = self.generate({"ki_20260929.csv": b"kode;nama\nSOCI;contoh;tambahan\n"})
        self.assertEqual(doc["delimiter"], ";")


if __name__ == "__main__":
    unittest.main()
