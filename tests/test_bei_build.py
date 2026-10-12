"""BEI categories, retired KI/digest navigation, lazy embedding, bei-index.json copy, and chat-index retirement.

Builds only a tiny temporary fixture (tests/helpers/bei_fixture.py); no network, no real archive.
Run: python3 -B -m unittest tests/test_bei_build.py
"""
from datetime import date
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "tests" / "helpers")); sys.path.insert(0, str(ROOT / "tools"))
import build  # noqa: E402
import bei_fixture as fx  # noqa: E402
from build_worker import worker_docs, LOW_PRIORITY  # noqa: E402
from event_index import text_events  # noqa: E402


def fake_doc(cat, day, kind="md", size=1000):
    d = date.fromisoformat(day)
    return {"id": "d", "name": f"{cat}-{day}.md", "path": f"files/{cat}/{day}/{cat}-{day}.md", "cat": cat, "kind": kind,
            "size": size, "content": "x", "end": day, "_end": d, "_start": d, "_precision": "day"}


class CategoryTests(unittest.TestCase):
    def test_prefixes_route_before_ki_keywords(self):
        self.assertEqual(build.categorize("beiringkas_2026-10-05_2026-10-05"), "bei-ringkasan")
        self.assertEqual(build.categorize("beidetail_2026-10-05_2026-10-05"), "bei-detail")
        self.assertEqual(build.categorize("beipekan_2026-09-28_2026-10-04"), "bei-pekan")
        # KI keywords ("emiten", "keterbukaan", "digest") still route legacy names, but never a bei* file.
        self.assertEqual(build.categorize("beiringkas_keterbukaan_emiten_digest_2026-10-05_2026-10-05"), "bei-ringkasan")
        self.assertEqual(build.categorize("ki_05102026"), "keterbukaan-informasi")
        self.assertEqual(build.categorize("pemeriksaan_55_emiten_14_September_2026"), "keterbukaan-informasi")
        self.assertEqual(build.categorize("digest_2026-10-01_2026-10-02"), "digest-emiten")
        self.assertEqual(build.parse_dates("beiringkas_2026-10-05_2026-10-05"), (date(2026, 10, 5), date(2026, 10, 5), "day"))
        self.assertEqual(build.parse_dates("beipekan_2026-09-28_2026-10-04"), (date(2026, 9, 28), date(2026, 10, 4), "day"))

    def test_names_navigation_and_order(self):
        cats = build.CATEGORIES
        self.assertEqual(cats["bei-ringkasan"]["nav"], "Indonesia (BEI)")
        self.assertEqual(cats["keterbukaan-informasi"]["name"], "Analisis KI (legacy)")
        self.assertIsNone(cats["keterbukaan-informasi"]["nav"])
        self.assertIn("Arsip lama", cats["keterbukaan-informasi"]["blurb"])
        self.assertIsNone(cats["digest-emiten"]["nav"])
        self.assertTrue(cats["digest-emiten"]["unlisted"])
        keys = list(cats)
        self.assertLess(keys.index("bei-ringkasan"), keys.index("keterbukaan-informasi"))
        self.assertEqual(keys[keys.index("bei-ringkasan"):keys.index("bei-ringkasan") + 3], ["bei-ringkasan", "bei-detail", "bei-pekan"])
        for key in ("bei-ringkasan", "bei-detail", "bei-pekan"):
            self.assertEqual(cats[key]["keywords"], ())
            self.assertIn("bukan rekomendasi", cats[key]["blurb"].lower())
        # Legacy KI keeps the Indonesia button only while no BEI summary exists.
        self.assertEqual(build.nav_label("keterbukaan-informasi", {"keterbukaan-informasi": [1]}), "Indonesia (BEI)")
        self.assertIsNone(build.nav_label("keterbukaan-informasi", {"keterbukaan-informasi": [1], "bei-ringkasan": [1]}))


class EmbedRuleTests(unittest.TestCase):
    def test_bei_detail_always_lazy_old_ringkasan_lazy_unlisted_marked(self):
        docs = [fake_doc("bei-ringkasan", "2026-10-06"), fake_doc("bei-ringkasan", "2026-09-29"), fake_doc("bei-ringkasan", "2026-09-28"),
                fake_doc("bei-detail", "2026-10-06"), fake_doc("bei-pekan", "2026-10-04"), fake_doc("digest-emiten", "2026-10-01"),
                fake_doc("stockbit-ringkasan", "2026-09-28")]
        entries = {e["name"]: e for e in build.embed_entries(docs)}
        self.assertNotIn("lazy", entries["bei-ringkasan-2026-10-06.md"])
        self.assertNotIn("lazy", entries["bei-ringkasan-2026-09-29.md"])   # exactly 7 days older: still embedded
        self.assertTrue(entries["bei-ringkasan-2026-09-28.md"]["lazy"])
        self.assertTrue(entries["bei-detail-2026-10-06.md"]["lazy"])
        self.assertNotIn("content", entries["bei-detail-2026-10-06.md"])
        self.assertNotIn("lazy", entries["bei-pekan-2026-10-04.md"])
        # Stockbit's own newest day is the reference for Stockbit (no Stockbit doc is newer here).
        self.assertNotIn("lazy", entries["stockbit-ringkasan-2026-09-28.md"])
        self.assertTrue(entries["digest-emiten-2026-10-01.md"]["unlisted"])
        self.assertNotIn("unlisted", entries["bei-ringkasan-2026-10-06.md"])

    def test_viewer_skips_bei_detail_and_unlisted_in_bulk_search(self):
        self.assertIn("searchLazy = searchLazy.filter(function(d){ return d.cat !== 'bei-detail' && !d.unlisted; });", build.APP_JS)
        self.assertIn("if (d.unlisted) return;", build.APP_JS)


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

    def test_full_build_nav_paths_lazy_payload_and_index_copy(self):
        page, payload, stdout, stderr = self.build()
        docs = {d["name"]: d for d in payload["docs"]}
        ring = docs["beiringkas_2026-10-06_2026-10-06.md"]
        self.assertEqual((ring["cat"], ring["path"]), ("bei-ringkasan", "files/bei-ringkasan/2026-10-06/beiringkas_2026-10-06_2026-10-06.md"))
        self.assertTrue(docs["beidetail_2026-10-06_2026-10-06.md"]["lazy"])
        self.assertTrue(docs["beiringkas_2026-09-20_2026-09-20.md"]["lazy"])
        self.assertEqual(docs["beipekan_2026-09-28_2026-10-04.md"]["cat"], "bei-pekan")
        self.assertEqual(payload["bei"], {"path": "files/bei-index/bei-index.json", "days": 2, "tickers": 5})
        self.assertEqual((self.out / "files/bei-index/bei-index.json").read_bytes(),
                         (self.src / "idx-signal-desk/bei-index.json").read_bytes())
        self.assertNotIn("bei-index.json", docs)
        nav = re.search(r'<nav class="category-nav"[^>]*>(.*?)</nav>', page, re.S)[1]
        self.assertIn('href="#bei-ringkasan" data-cat="bei-ringkasan"><span class="swatch" aria-hidden="true"></span>Indonesia (BEI)</a>', nav)
        self.assertNotIn('data-cat="keterbukaan-informasi"', nav)
        self.assertNotIn('data-cat="digest-emiten"', nav)
        self.assertEqual(nav.count("Indonesia (BEI)"), 1)
        # Legacy KI list is still built (old links, search) and linked from the BEI list; digest is not listed at all.
        self.assertIn('<section class="cat" data-cat="keterbukaan-informasi" id="keterbukaan-informasi">', page)
        self.assertIn("Analisis KI (legacy)", page)
        self.assertIn('<p class="cat-legacy"><a href="#keterbukaan-informasi">', page)
        self.assertNotIn('id="digest-emiten"', page)
        digest = docs["digest_2026-10-01_2026-10-02.md"]
        self.assertTrue(digest["unlisted"])
        self.assertTrue((self.out / digest["path"]).is_file(), "old #doc= links keep working")
        self.assertNotIn(f'data-id="{digest["id"]}"', page)
        listed = sum(1 for d in payload["docs"] if not d.get("unlisted"))
        self.assertIn(f'Dokumen <span class="n">{listed}</span>', page)
        self.assertIn("<form class=\"sb-find\" data-bei-find", page)
        self.assertIn("Indeks BEI", stdout)
        self.assertIn("Ringkasan keterbukaan BEI", stdout)
        self.assertEqual(stderr, "")

    def test_without_bei_summaries_ki_keeps_the_indonesia_button(self):
        page, payload, _, _ = self.build(with_index=False)
        for p in (self.src / "idx-signal-desk").glob("bei*.md"):
            p.unlink()
        fx.build_site(self.src, self.out)
        page = (self.out / "index.html").read_text(encoding="utf-8")
        payload = json.loads(re.search(r'id="arsip-data">(.*?)</script>', page, re.S)[1])
        self.assertIsNone(payload["bei"])
        nav = re.search(r'<nav class="category-nav"[^>]*>(.*?)</nav>', page, re.S)[1]
        self.assertIn('href="#keterbukaan-informasi" data-cat="keterbukaan-informasi"><span class="swatch" aria-hidden="true"></span>Indonesia (BEI)</a>', nav)
        self.assertNotIn("<form class=\"sb-find\" data-bei-find", page)
        self.assertFalse((self.out / "files/bei-index").exists())

    def test_unknown_or_broken_index_fails_build(self):
        fx.write_fixture(self.src)
        for raw in ('{"format": 2}', '{"format": 1, "days": [{"d": "x"}]}', '{"format": 1, "days": [], "names": []}'):
            with self.subTest(raw):
                (self.src / "idx-signal-desk/bei-index.json").write_text(raw, encoding="utf-8")
                with self.assertRaises(ValueError):
                    fx.build_site(self.src, self.out)


def wdoc(name, cat, start):
    return {"name": name, "cat": cat, "start": start, "end": start, "body": "Isi.", "search_body": "Isi.", "title": name,
            "source_id": "D1", "kind": "md"}


class ChatIndexTests(unittest.TestCase):
    def test_digest_is_retired_from_chat_and_bei_detail_is_low_priority(self):
        docs = [wdoc("digest_2026-10-01_2026-10-02.md", "digest-emiten", "2026-10-01"),
                wdoc("beiringkas_2026-10-05_2026-10-05.md", "bei-ringkasan", "2026-10-05"),
                wdoc("beidetail_2026-10-05_2026-10-05.md", "bei-detail", "2026-10-05"),
                wdoc("ki_05102026.md", "keterbukaan-informasi", "2026-10-05")]
        kept, excluded = worker_docs(docs)
        self.assertEqual([d["name"] for d in excluded], ["digest_2026-10-01_2026-10-02.md"])
        self.assertEqual({d["name"] for d in kept}, {"beiringkas_2026-10-05_2026-10-05.md", "beidetail_2026-10-05_2026-10-05.md",
                                                     "ki_05102026.md"})
        self.assertIn("bei-detail", LOW_PRIORITY)
        self.assertIn("stockbit-detail", LOW_PRIORITY)

    def test_bei_events_are_official_kind_and_heading_owns_prose(self):
        for cat in ("bei-ringkasan", "bei-detail", "bei-pekan"):
            with self.subTest(cat=cat):
                events = text_events({"cat": cat, "kind": "md", "start": "2026-10-05", "end": "2026-10-05", "source_id": "D9"},
                                     {"BBCA"}, [{"content": "### BBCA — Bank Central Asia Tbk\n\nPanggilan RUPS untuk rights issue.", "line": 3}])
                self.assertEqual([(e["ticker"], e["type"], e["kind"]) for e in events], [("BBCA", "rights_issue", "bei")])


if __name__ == "__main__":
    unittest.main()
