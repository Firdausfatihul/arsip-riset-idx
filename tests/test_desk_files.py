"""tools/desk_files.py: names, categories and hold files of the Stockbit and BEI families."""
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "tools"))
import build  # noqa: E402
import desk_files as desk  # noqa: E402


class DeskFilesTests(unittest.TestCase):
    def test_every_kind_matches_the_real_build_category(self):
        for fam in desk.FAMILIES:
            for kind in desk.KINDS:
                name = fam.name(kind, "2026-10-05", "2026-10-11" if kind == "pekan" else None)
                found = desk.parse(name)
                self.assertEqual((found.family, found.kind), (fam, kind))
                self.assertEqual(build.categorize(Path(name).stem), found.category)

    def test_parse_and_family(self):
        self.assertEqual(desk.parse("docs/files/bei-detail/2026-10-05/beidetail_2026-10-05_2026-10-05.md").family, desk.BEI)
        for other in ("sbringkas_2026-10-05.md", "xsbringkas_2026-10-05_2026-10-05.md", "sbringkas_2026-10-05_2026-10-05.md.bak",
                      "digest_2026-10-05_2026-10-05.md", "sbringkas_２０２６-10-05_2026-10-05.md"):
            self.assertIsNone(desk.parse(other), other)
        self.assertEqual(desk.family_of("needtobeindexed/idx-signal-desk/.bei-hold.json"), desk.BEI)
        self.assertEqual(desk.family_of("stockbit-index.json"), desk.STOCKBIT)
        self.assertIsNone(desk.family_of(".sync.json"))

    def test_days_are_strict(self):
        days = lambda name: desk.parse(name).days()  # noqa: E731
        self.assertEqual(days("sbringkas_2026-10-05_2026-10-05.md"), {"2026-10-05"})
        self.assertEqual(days("beipekan_2026-10-05_2026-10-11.md"), {f"2026-10-{d:02d}" for d in range(5, 12)})
        for bad in ("sbringkas_2026-10-05_2026-10-06.md", "sbpekan_2026-10-05_2026-10-12.md", "sbpekan_2026-10-05_2026-10-04.md",
                    "sbringkas_2026-02-30_2026-02-30.md"):
            self.assertEqual(days(bad), set(), bad)

    def test_hold_files(self):
        entries = desk.parse_hold('{"format": 1, "days": {"2026-10-06": {"sha256": "*", "withheld_by": "desk"}, '
                                  '"2026-10-05": {"sha256": "ab", "rollback_of": "t"}, "2026-13-01": {"withheld_by": "desk"}}}')
        self.assertEqual(desk.desk_held(entries), {"2026-10-06"})
        self.assertEqual(desk.parse_hold(desk.hold_text(entries)), entries)
        self.assertTrue(desk.hold_text(entries).index("2026-10-05") < desk.hold_text(entries).index("2026-10-06"))
        for bad in ("", "[]", '{"days": []}'):
            with self.assertRaises(ValueError):
                desk.parse_hold(bad)


if __name__ == "__main__":
    unittest.main()
