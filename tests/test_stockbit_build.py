"""Stockbit summary categories, lazy embedding, robots/sitemap and stockbit-index.json copy.

Builds only a tiny temporary fixture (tests/helpers/stockbit_fixture.py); no network, no real archive.
Run: python3 -B -m unittest tests/test_stockbit_build.py
"""
from datetime import date
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests" / "helpers"))
import build  # noqa: E402
import stockbit_fixture as fx  # noqa: E402


def fake_doc(cat, day, kind="md", size=1000):
    d = date.fromisoformat(day)
    return {"id": "d", "name": f"{cat}-{day}.md", "path": f"files/{cat}/{day}/{cat}-{day}.md", "cat": cat, "kind": kind,
            "size": size, "content": "x", "end": day, "_end": d, "_start": d, "_precision": "day"}


class CategoryAndDateTests(unittest.TestCase):
    def test_new_prefixes_map_to_stockbit_categories(self):
        self.assertEqual(build.categorize("sbringkas_2026-10-05_2026-10-05"), "stockbit-ringkasan")
        self.assertEqual(build.categorize("sbdetail_2026-10-05_2026-10-05"), "stockbit-detail")
        self.assertEqual(build.categorize("sbpekan_2026-09-28_2026-10-04"), "stockbit-pekan")
        # Old raw reports keep their category (and therefore their published path).
        self.assertEqual(build.categorize("stockbit_05102026"), "stockbit")
        self.assertEqual(build.categorize("stockbit_ki_review_2026-09-05_2026-09-10"), "stockbit")
        self.assertEqual(build.categorize("Analisis_Stockbit_25-31_Agustus_2026"), "stockbit")

    def test_order_places_new_categories_right_after_stockbit(self):
        keys = list(build.CATEGORIES)
        i = keys.index("stockbit")
        self.assertEqual(keys[i:i + 4], ["stockbit", "stockbit-ringkasan", "stockbit-detail", "stockbit-pekan"])
        for key in ("stockbit-ringkasan", "stockbit-detail", "stockbit-pekan"):
            self.assertIn("diskusi pengguna Stockbit, belum diverifikasi, bukan keterbukaan resmi", build.CATEGORIES[key]["blurb"])
            self.assertEqual(build.CATEGORIES[key]["keywords"], ())
        self.assertIn("kursor lama", build.CATEGORIES["stockbit"]["blurb"])
        self.assertEqual(build.CATEGORIES["stockbit-ringkasan"]["nav"], "Stockbit harian")

    def test_dates_exact_day_and_week_range(self):
        self.assertEqual(build.parse_dates("sbringkas_2026-10-05_2026-10-05"), (date(2026, 10, 5), date(2026, 10, 5), "day"))
        self.assertEqual(build.parse_dates("sbdetail_2026-10-05_2026-10-05"), (date(2026, 10, 5), date(2026, 10, 5), "day"))
        self.assertEqual(build.parse_dates("sbpekan_2026-09-28_2026-10-04"), (date(2026, 9, 28), date(2026, 10, 4), "day"))
        self.assertEqual(build.parse_dates("stockbit_05102026"), (date(2026, 10, 5), date(2026, 10, 5), "day"))
        self.assertTrue(build.EXPLICIT_RANGE.search("sbringkas_2026-10-05_2026-10-05"))


class EmbedRuleTests(unittest.TestCase):
    def lazy(self, docs):
        return {e["name"]: bool(e.get("lazy")) for e in build.embed_entries(docs)}

    def test_detail_always_lazy_and_old_ringkasan_lazy(self):
        docs = [fake_doc("stockbit-ringkasan", "2026-10-05"), fake_doc("stockbit-ringkasan", "2026-09-28"),
                fake_doc("stockbit-ringkasan", "2026-09-27"), fake_doc("stockbit-detail", "2026-10-05"),
                fake_doc("stockbit-pekan", "2026-10-04"), fake_doc("stockbit", "2026-09-01"),
                fake_doc("keterbukaan-informasi", "2026-01-01")]
        lazy = self.lazy(docs)
        self.assertFalse(lazy["stockbit-ringkasan-2026-10-05.md"])
        self.assertFalse(lazy["stockbit-ringkasan-2026-09-28.md"])   # exactly 7 days older: still embedded
        self.assertTrue(lazy["stockbit-ringkasan-2026-09-27.md"])
        self.assertTrue(lazy["stockbit-detail-2026-10-05.md"])
        self.assertFalse(lazy["stockbit-pekan-2026-10-04.md"])
        self.assertFalse(lazy["stockbit-2026-09-01.md"])
        self.assertFalse(lazy["keterbukaan-informasi-2026-01-01.md"])
        entries = build.embed_entries(docs)
        self.assertNotIn("content", next(e for e in entries if e["name"] == "stockbit-detail-2026-10-05.md"))
        self.assertTrue(all(not k.startswith("_") for e in entries for k in e))

    def test_size_limit_still_applies_and_html_never_lazy(self):
        lazy = self.lazy([fake_doc("keterbukaan-informasi", "2026-10-01", size=build.EMBED_LIMIT + 1),
                          fake_doc("stockbit-detail", "2026-10-01", kind="html")])
        self.assertTrue(lazy["keterbukaan-informasi-2026-10-01.md"])
        self.assertFalse(lazy["stockbit-detail-2026-10-01.md"])

    def test_viewer_skips_detail_in_bulk_search_preload(self):
        self.assertIn("searchLazy = lazyDocs.filter(function(d){ return d.cat !== 'stockbit-detail'; })", build.APP_JS)
        self.assertIn("var queue = searchLazy.filter(", build.APP_JS)


class RobotsSitemapTests(unittest.TestCase):
    def test_robots_disallows_all_stockbit_files_and_keeps_allow(self):
        text = build.robots_txt("https://arsip.test")
        self.assertIn("User-agent: *\n", text)
        self.assertIn("Disallow: /files/stockbit\n", text)
        self.assertIn("Allow: /\n", text)
        self.assertIn("Sitemap: https://arsip.test/sitemap.xml\n", text)
        self.assertLess(text.index("Disallow:"), text.index("Allow: /"))
        self.assertNotIn("Sitemap", build.robots_txt(""))

    def test_sitemap_skips_every_stockbit_category(self):
        docs = [fake_doc(c, "2026-10-05") for c in ("stockbit", "stockbit-ringkasan", "stockbit-detail", "stockbit-pekan",
                                                    "keterbukaan-informasi")]
        xml = build.sitemap_xml(docs, "https://arsip.test")
        self.assertIn("files/keterbukaan-informasi/", xml)
        self.assertNotIn("files/stockbit", xml)
        self.assertIn("<loc>https://arsip.test/</loc>", xml)


class FixtureBuildTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.src, self.out = self.base / "sources", self.base / "site"
        self.src.mkdir()

    def build(self, **kw):
        fx.write_fixture(self.src, **kw)
        stdout, stderr = fx.build_site(self.src, self.out)
        page = (self.out / "index.html").read_text(encoding="utf-8")
        payload = json.loads(re.search(r'id="arsip-data">(.*?)</script>', page, re.S)[1])
        return page, payload, stdout, stderr

    def test_full_build_paths_lazy_payload_robots_sitemap(self):
        page, payload, stdout, stderr = self.build()
        docs = {d["name"]: d for d in payload["docs"]}
        self.assertEqual(docs["sbringkas_2026-10-05_2026-10-05.md"]["path"],
                         "files/stockbit-ringkasan/2026-10-05/sbringkas_2026-10-05_2026-10-05.md")
        self.assertEqual((docs["sbringkas_2026-10-05_2026-10-05.md"]["start"], docs["sbringkas_2026-10-05_2026-10-05.md"]["end"]),
                         ("2026-10-05", "2026-10-05"))
        self.assertEqual(docs["stockbit_05102026.md"]["cat"], "stockbit")
        self.assertEqual(docs["sbpekan_2026-09-28_2026-10-04.md"]["cat"], "stockbit-pekan")
        self.assertTrue(docs["sbringkas_2026-09-20_2026-09-20.md"].get("lazy"))
        self.assertNotIn("lazy", docs["sbringkas_2026-09-28_2026-09-28.md"])
        self.assertTrue(docs["sbdetail_2026-10-05_2026-10-05.md"].get("lazy"))
        # stockbit-index.json copied explicitly and exposed to the viewer.
        self.assertEqual(payload["stockbit"], {"path": "files/stockbit-index/stockbit-index.json", "days": 2, "tickers": 2, "users": 1})
        self.assertEqual((self.out / "files/stockbit-index/stockbit-index.json").read_bytes(),
                         (self.src / "idx-signal-desk/stockbit-index.json").read_bytes())
        # The index is data for the viewer, not an archive document.
        self.assertNotIn("stockbit-index.json", docs)
        robots = (self.out / "robots.txt").read_text()
        self.assertIn("Disallow: /files/stockbit\n", robots)
        sitemap = (self.out / "sitemap.xml").read_text()
        self.assertIn("ki_05102026.md", sitemap)
        self.assertNotIn("stockbit", sitemap.replace("arsip.test", ""))
        # Viewer entry points.
        self.assertIn('<form class="sb-find" data-sb-find', page)
        self.assertIn("Cari emiten atau @pengguna di ringkasan Stockbit", page)
        self.assertIn('<span class="sb-badge">Cakupan</span> 1.603/1.603 posting utama', page)
        self.assertIn('data-cat="stockbit-ringkasan"', page)
        self.assertIn("Indeks Stockbit", stdout)
        self.assertEqual(stderr, "")

    def test_without_index_no_payload_and_no_search_box(self):
        page, payload, _, _ = self.build(with_index=False)
        self.assertIsNone(payload["stockbit"])
        self.assertFalse((self.out / "files/stockbit-index").exists())
        self.assertNotIn('class="sb-find"', page)

    def test_unknown_index_format_fails_build(self):
        fx.write_fixture(self.src)
        (self.src / "idx-signal-desk/stockbit-index.json").write_text('{"format": 2}', encoding="utf-8")
        with self.assertRaises(ValueError):
            fx.build_site(self.src, self.out)

    def test_page_size_warning_goes_to_stderr(self):
        fx.write_fixture(self.src)
        from unittest.mock import patch
        with patch.object(build, "PAGE_WARN_BYTES", 1000):
            _, stderr = fx.build_site(self.src, self.out)
        self.assertIn("PERINGATAN: index.html", stderr)


if __name__ == "__main__":
    unittest.main()
