"""sync_idx.py --stockbit-only: fake Signal Desk, no network, isolated temp archive."""
import argparse
import hashlib
import io
import json
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / "tools"))
import build  # noqa: E402
import sync_idx as sync  # noqa: E402

CATS = {"sbringkas": "stockbit-ringkasan", "sbdetail": "stockbit-detail", "sbpekan": "stockbit-pekan"}


def fake_categorize(stem):
    return CATS.get(stem.split("_", 1)[0], build.categorize(stem))


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def day_text(day, kind, extra=""):
    return (f"# Ringkasan Stockbit Ideas · {day} ({kind})\n\nCakupan: 10/10 posting utama diberi disposisi · final\n\n"
            f"## BBCA\n- klaim pengguna [pos](https://stockbit.com/post/36000001){extra}\n")


class FakeDesk:
    """Ekspor read-only Stockbit; mencatat setiap path yang diminta."""

    def __init__(self, days, quarantined=None, weeks=(), user_notes=None, withheld=None):
        self.calls, self.days, self.quarantined = [], list(days), quarantined or {}
        self.weeks = set(weeks)
        # None = desk lama tanpa /export/withheld (404); daftar = hari yang ditahan dari web, disembunyikan di sisi desk.
        self.withheld = withheld
        self.overrides, self.user_notes = {}, user_notes
        self.listing = [{"date": d, "state": "final", "sha256": "h" + d, "updated_at": "t1", "ok": True,
                         "coverage": {"posts_total": 10}} for d in self.days]

    def day(self, day, kind):
        prefix = {"ringkas": "sbringkas", "detail": "sbdetail"}[kind]
        text = day_text(day, kind)
        r = {"name": f"{prefix}_{day}_{day}.md", "text": text, "sha256": sha(text), "state": "final",
             "coverage": {"ok": True}, "quarantined_stream_ids": self.quarantined.get(day, []), "llm_calls": 0}
        r.update(self.overrides.get((day, kind), {}))
        return r

    def hidden(self, day):
        return day in (self.withheld or ())

    def exported(self, day, path):
        """Like the real desk: non-final days only with include_provisional=1."""
        row = next((r for r in self.listing if r["date"] == day), None)
        return row is None or row["state"] == "final" or "include_provisional=1" in path

    def index(self, path=""):
        # The real desk has no start filter: every final day in its DB, including days before --stockbit-since.
        idx = {"format": 1, "generated_at": "x", "days": [
            {"d": d, "f": f"sbringkas_{d}_{d}.md", "detail": f"sbdetail_{d}_{d}.md", "k": 1, "n": 10}
            for d in self.days if self.exported(d, path) and not self.hidden(d)],
            "tickers": {"BBCA": [[0, 3, 2, 1, "inti", {}]]}, "users": {"alice": [[0, 2, ["BBCA"], ["f1"]]]}}
        if self.user_notes is not None:
            idx["user_notes"] = self.user_notes
        idx.update(self.overrides.get("index", {}))
        return idx

    def get(self, path, timeout=60):
        self.calls.append(path)
        if path == "/api/health":
            return {"ok": True}
        if path == "/api/stockbit/export/withheld":
            if "withheld" in self.overrides:
                return self.overrides["withheld"]
            if self.withheld is None:
                raise HTTPError(path, 404, "old desk", {}, None)
            return {"days": list(self.withheld), "llm_calls": 0}
        if path.startswith("/api/stockbit/export/days"):
            rows = [r for r in self.listing if (r["state"] == "final" or "include_provisional=1" in path) and not self.hidden(r["date"])]
            return {"days": rows}
        if path.startswith("/api/stockbit/export/day/"):
            day, query = path.rsplit("/", 1)[1].split("?kind=")
            kind = query.split("&", 1)[0]
            if self.hidden(day):
                raise HTTPError(path, 409, "withheld", {}, None)
            if not self.exported(day, path):
                raise HTTPError(path, 404, "not final", {}, None)
            return self.day(day, kind)
        if path.startswith("/api/stockbit/export/week/"):
            monday = path.rsplit("/", 1)[1]
            sunday = (sync.date.fromisoformat(monday) + sync.timedelta(days=6)).isoformat()
            week = {(sync.date.fromisoformat(monday) + sync.timedelta(days=i)).isoformat() for i in range(7)}
            if monday not in self.weeks or any(self.hidden(d) for d in week):
                raise HTTPError(path, 404, "not complete", {}, None)
            text = f"# Rekap pekan {monday}\n\nCakupan: tujuh hari final.\n"
            return {"name": f"sbpekan_{monday}_{sunday}.md", "text": text, "sha256": sha(text)}
        if path.split("?", 1)[0] == "/api/stockbit/export/index":
            return self.index(path)
        raise AssertionError(f"unexpected call {path}")


class StockbitSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dest = self.root / "needtobeindexed/idx-signal-desk"; self.dest.mkdir(parents=True)
        p = patch.multiple(sync, ROOT=self.root, DEST=self.dest, STATE=self.dest / ".sync.json",
                           OWNERSHIP_JSON=self.dest / "kepemilikan.json",
                           STOCKBIT_STATE=self.dest / ".sync-stockbit.json", STOCKBIT_INDEX=self.dest / "stockbit-index.json",
                           STOCKBIT_HOLD=self.dest / ".stockbit-hold.json",
                           categorize=fake_categorize)
        p.start(); self.addCleanup(p.stop)

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.dest.iterdir()}

    def sync(self, desk, **extra):
        args = SimpleNamespace(**{"server": "http://127.0.0.1:8787", "stockbit_only": True, "force": False,
                                  "allow_provisional": False, "stockbit_since": "2026-10-01", **extra})
        with patch.object(sync, "Server", return_value=desk), redirect_stdout(io.StringIO()):
            return sync.sync_once(args)

    def refused(self, desk, pattern=None, **extra):
        before = self.snapshot()
        with self.assertRaises(sync.StockbitRefused) as ctx:
            self.sync(desk, **extra)
        self.assertEqual(self.snapshot(), before, "a refused sync must not write anything")
        if pattern:
            self.assertRegex(str(ctx.exception), pattern)

    def test_stockbit_only_writes_days_index_state_without_profile_calls(self):
        desk = FakeDesk(["2026-10-05", "2026-10-06"])
        with patch.object(sync, "_sync_once", side_effect=AssertionError("profile path must not run")), \
                patch.object(sync, "sync_ownership", side_effect=AssertionError("ownership must not run")):
            self.assertTrue(self.sync(desk))
        names = set(self.snapshot())
        self.assertLessEqual({"sbringkas_2026-10-05_2026-10-05.md", "sbdetail_2026-10-05_2026-10-05.md",
                              "sbringkas_2026-10-06_2026-10-06.md", "stockbit-index.json", ".sync-stockbit.json"}, names)
        self.assertNotIn(".sync.json", names)
        self.assertFalse([c for c in desk.calls if c.startswith(("/api/profiles", "/api/ownership", "/api/share"))])
        state = json.loads((self.dest / ".sync-stockbit.json").read_text())
        self.assertEqual(state["days"]["2026-10-05"]["files"]["sbringkas_2026-10-05_2026-10-05.md"],
                         sha(day_text("2026-10-05", "ringkas")))
        self.assertNotIn("synced_at", state)
        self.assertEqual(json.loads((self.dest / "stockbit-index.json").read_text())["format"], 1)
        # Second run: fingerprints unchanged -> no day refetch, no file changes.
        desk.calls.clear()
        self.assertFalse(self.sync(desk))
        self.assertFalse([c for c in desk.calls if "/export/day/" in c])

    def test_globals_restored_after_success_and_failure(self):
        originals = (sync.DEST, sync.STOCKBIT_STATE, sync.STOCKBIT_INDEX)
        self.sync(FakeDesk(["2026-10-05"]))
        self.assertEqual((sync.DEST, sync.STOCKBIT_STATE, sync.STOCKBIT_INDEX), originals)
        bad = FakeDesk(["2026-10-06"]); bad.overrides[("2026-10-06", "ringkas")] = {"sha256": "0" * 64}
        with self.assertRaises(sync.StockbitRefused):
            self.sync(bad)
        self.assertEqual((sync.DEST, sync.STOCKBIT_STATE, sync.STOCKBIT_INDEX), originals)

    def test_validation_failures_abort_without_writing(self):
        self.sync(FakeDesk(["2026-10-05"]))  # existing published state must survive each refusal untouched
        cases = {
            "sha": ({("2026-10-06", "ringkas"): {"sha256": "0" * 64}}, "sha256"),
            "name": ({("2026-10-06", "detail"): {"name": "sbdetail_2026-10-07_2026-10-07.md"}}, "nama berkas"),
            "traversal": ({("2026-10-06", "ringkas"): {"name": "../../etc/sbringkas_2026-10-06_2026-10-06.md"}}, "nama berkas"),
            "coverage": ({("2026-10-06", "detail"): {"coverage": {"ok": False}}}, "cakupan"),
            "state": ({("2026-10-06", "ringkas"): {"state": "sementara"}}, "status"),
            "llm": ({("2026-10-06", "ringkas"): {"llm_calls": 2}}, "LLM"),
            "empty": ({("2026-10-06", "ringkas"): {"text": "", "sha256": sha("")}}, "kosong"),
            "index_unpublished": ({"index": {"days": [{"d": "2026-10-09", "f": "sbringkas_2026-10-09_2026-10-09.md"}]}}, "tidak diterbitkan"),
            "index_format": ({"index": {"format": 2}}, "format"),
        }
        for label, (overrides, pattern) in cases.items():
            with self.subTest(label):
                desk = FakeDesk(["2026-10-05", "2026-10-06"]); desk.overrides = overrides
                self.refused(desk, pattern)

    def test_listing_rejects_bad_dates_and_unreviewed_days(self):
        for row, pattern in (({"date": "2026-13-01"}, "tanggal"), ({"date": "../../x"}, "tanggal"), ({"ok": False}, "belum klop")):
            with self.subTest(row):
                desk = FakeDesk(["2026-10-05"]); desk.listing[0].update(row)
                self.refused(desk, pattern)

    def test_penilaian_requires_text_and_finding_ids(self):
        ok = FakeDesk(["2026-10-05"], user_notes={"alice": {"penilaian": {"text": "Argumen bersandar angka.", "finding_ids": ["f1"]},
                                                           "window": 7}})
        self.sync(ok)
        self.assertIn("penilaian", (self.dest / "stockbit-index.json").read_text())
        bad = FakeDesk(["2026-10-05", "2026-10-06"], user_notes={"alice": {"penilaian": {"text": "Lemah.", "finding_ids": []}}})
        self.refused(bad, "finding_ids")

    def test_benang_and_based_on_validated_like_penilaian(self):
        note = {"penilaian": {"text": "Argumen bersandar angka.", "finding_ids": ["f1"]},
                "window": {"start": "2026-09-29", "end": "2026-10-05"},
                "benang": {"text": "Klaim BBCA berulang lintas hari.", "finding_ids": ["f0", "f1"]},
                "based_on": {"findings": 2, "last_day": "2026-10-05"}}
        rows = {"users": {"alice": [[0, 2, ["BBCA"], ["f0", "f1"]]]}}
        desk = FakeDesk(["2026-10-05"], user_notes={"alice": note}); desk.overrides["index"] = rows
        self.sync(desk)
        written = json.loads((self.dest / "stockbit-index.json").read_text())["user_notes"]["alice"]
        self.assertEqual((written["benang"], written["based_on"]), (note["benang"], note["based_on"]))
        # Notes without the new fields (older desk) stay valid.
        self.sync(FakeDesk(["2026-10-05"], user_notes={"alice": {"penilaian": note["penilaian"], "window": 7}}))
        bad = {
            "benang_not_object": ({"benang": "teks"}, "benang"),
            "benang_empty_text": ({"benang": {"text": "  ", "finding_ids": ["f1"]}}, "benang"),
            "benang_no_ids": ({"benang": {"text": "x", "finding_ids": []}}, "benang"),
            "benang_int_ids": ({"benang": {"text": "x", "finding_ids": [1, 2]}}, "benang"),
            "benang_ids_not_list": ({"benang": {"text": "x", "finding_ids": "f1"}}, "benang"),
            "based_on_negative": ({"based_on": {"findings": -1, "last_day": "2026-10-05"}}, "based_on"),
            "based_on_bool": ({"based_on": {"findings": True, "last_day": "2026-10-05"}}, "based_on"),
            "based_on_string": ({"based_on": {"findings": "2", "last_day": "2026-10-05"}}, "based_on"),
            "based_on_bad_day": ({"based_on": {"findings": 2, "last_day": "2026-13-05"}}, "last_day"),
            "based_on_not_object": ({"based_on": [2, "2026-10-05"]}, "based_on"),
        }
        for label, (extra, pattern) in bad.items():
            with self.subTest(label):
                desk = FakeDesk(["2026-10-05", "2026-10-06"], user_notes={"alice": {**note, **extra}})
                desk.overrides["index"] = rows
                self.refused(desk, pattern)
        # Ids must be findings of the published users rows.
        for part in ("penilaian", "benang"):
            with self.subTest(part):
                desk = FakeDesk(["2026-10-05", "2026-10-06"], user_notes={"alice": {
                    **note, part: {"text": "x", "finding_ids": ["f1", "F-unknown"]}}})
                desk.overrides["index"] = rows
                self.refused(desk, "F-unknown")

    def test_notes_citing_dropped_days_are_dropped_whole(self):
        # 2026-10-06 is held by rollback (dropped from the index); 2026-09-30 is before --stockbit-since.
        (self.dest / ".stockbit-hold.json").write_text(json.dumps({"format": 1, "days": {"2026-10-06": {"sha256": "*", "rollback_of": "t"}}}))
        desk = FakeDesk(["2026-09-30", "2026-10-05", "2026-10-06"])
        ok = {"penilaian": {"text": "ok", "finding_ids": ["a5"]}, "benang": {"text": "ok", "finding_ids": ["a5", "a5b"]},
              "based_on": {"findings": 2, "last_day": "2026-10-05"}}
        desk.overrides["index"] = {"users": {
            "alice": [[1, 1, [], ["a5", "a5b"]]],
            "pen": [[1, 1, [], ["p5"]], [2, 1, [], ["p6"]]],
            "ben": [[1, 1, [], ["b5"]], [0, 1, [], ["b0"]]],
            "last": [[1, 1, [], ["l5"]], [2, 1, [], ["l6"]]]}, "user_notes": {
            "alice": ok,
            "pen": {"penilaian": {"text": "menyebut 6 Okt", "finding_ids": ["p5", "p6"]}},
            "ben": {"penilaian": {"text": "ok", "finding_ids": ["b5"]}, "benang": {"text": "30 Sep", "finding_ids": ["b5", "b0"]}},
            "last": {"penilaian": {"text": "ok", "finding_ids": ["l5"]}, "based_on": {"findings": 2, "last_day": "2026-10-06"}}}}
        self.sync(desk)
        index = json.loads((self.dest / "stockbit-index.json").read_text())
        self.assertEqual(index["user_notes"], {"alice": ok})
        self.assertEqual(set(index["users"]), {"alice", "pen", "ben", "last"})

    def week_desk(self, **kw):
        days = [f"2026-10-{d:02d}" for d in range(5, 13)]  # Mon 5 .. Sun 11, plus Mon 12
        return FakeDesk(days, weeks={"2026-10-05"}, **kw)

    def hold(self):
        return json.loads((self.dest / ".stockbit-hold.json").read_text())["days"]

    def test_withheld_unpublished_day_is_not_published(self):
        desk = FakeDesk(["2026-10-05", "2026-10-06"], withheld=["2026-10-06"])
        self.sync(desk)
        names = set(self.snapshot())
        self.assertIn("sbringkas_2026-10-05_2026-10-05.md", names)
        self.assertFalse({"sbringkas_2026-10-06_2026-10-06.md", "sbdetail_2026-10-06_2026-10-06.md"} & names)
        self.assertNotIn(".stockbit-hold.json", names, "nothing was published, so nothing to hold")
        self.assertFalse([c for c in desk.calls if "/export/day/2026-10-06" in c])
        self.assertEqual([d["d"] for d in json.loads((self.dest / "stockbit-index.json").read_text())["days"]], ["2026-10-05"])
        # Even a desk that (wrongly) still lists the day does not get it published.
        desk.hidden = lambda day: False
        desk.withheld = ["2026-10-06"]
        desk.overrides["index"] = {"days": [{"d": "2026-10-05", "f": "sbringkas_2026-10-05_2026-10-05.md"},
                                            {"d": "2026-10-06", "f": "sbringkas_2026-10-06_2026-10-06.md"}]}
        self.sync(desk)
        self.assertNotIn("sbringkas_2026-10-06_2026-10-06.md", set(self.snapshot()))
        self.assertEqual([d["d"] for d in json.loads((self.dest / "stockbit-index.json").read_text())["days"]], ["2026-10-05"])

    def test_withheld_published_day_is_withdrawn_held_filtered_and_restored(self):
        desk = self.week_desk()
        self.sync(desk)
        self.assertTrue((self.dest / "sbpekan_2026-10-05_2026-10-11.md").is_file())
        rollback = {"sha256": "h2026-10-04", "rollback_of": "stockbit-publish-x"}
        (self.dest / ".stockbit-hold.json").write_text(json.dumps({"format": 1, "days": {"2026-10-04": rollback}}))
        desk.withheld = ["2026-10-07"]
        desk.calls.clear()
        # The index filter drops the withheld day even if the desk index still listed it (and remaps rows past it).
        all_days = [{"d": d, "f": f"sbringkas_{d}_{d}.md", "detail": f"sbdetail_{d}_{d}.md"} for d in desk.days]
        desk.overrides["index"] = {"days": all_days, "tickers": {"BBCA": [[2, 1, 1, 0, "", {}], [3, 1, 1, 0, "", {}]]},
                                   "users": {"bob": [[2, 1, [], ["f7"]]], "alice": [[3, 2, ["BBCA"], ["f8"]]]},
                                   "user_notes": {"bob": {"penilaian": {"text": "x", "finding_ids": ["f7"]}}}}
        self.assertTrue(self.sync(desk))  # 8 days were published, desk exports 7: the shrink guard must not refuse
        names = set(self.snapshot())
        for gone in ("sbringkas_2026-10-07_2026-10-07.md", "sbdetail_2026-10-07_2026-10-07.md", "sbpekan_2026-10-05_2026-10-11.md"):
            self.assertNotIn(gone, names)
        for kept in ("sbringkas_2026-10-06_2026-10-06.md", "sbdetail_2026-10-08_2026-10-08.md", "sbringkas_2026-10-12_2026-10-12.md"):
            self.assertIn(kept, names)
        self.assertEqual(self.hold(), {"2026-10-04": rollback, "2026-10-07": {"sha256": "*", "withheld_by": "desk"}})
        state = json.loads((self.dest / ".sync-stockbit.json").read_text())
        self.assertNotIn("2026-10-07", state["days"]); self.assertIn("2026-10-08", state["days"])
        self.assertNotIn("2026-10-05", state["weeks"])
        index = json.loads((self.dest / "stockbit-index.json").read_text())
        self.assertNotIn("2026-10-07", [d["d"] for d in index["days"]])
        self.assertEqual(index["tickers"], {"BBCA": [[2, 1, 1, 0, "", {}]]})
        self.assertEqual(index["users"], {"alice": [[2, 2, ["BBCA"], ["f8"]]]})
        self.assertEqual(index["user_notes"], {})
        self.assertFalse([c for c in desk.calls if "/export/day/2026-10-07" in c or "/export/week/" in c])
        # Still withheld: a second sync changes nothing.
        before = self.snapshot()
        self.assertFalse(self.sync(desk))
        self.assertEqual(self.snapshot(), before)
        # Un-withheld: only the desk entry goes; the day and the week are fetched again because their files are missing.
        desk.withheld = []
        del desk.overrides["index"]
        self.assertTrue(self.sync(desk))
        names = set(self.snapshot())
        for back in ("sbringkas_2026-10-07_2026-10-07.md", "sbdetail_2026-10-07_2026-10-07.md", "sbpekan_2026-10-05_2026-10-11.md"):
            self.assertIn(back, names)
        self.assertEqual(self.hold(), {"2026-10-04": rollback})
        state = json.loads((self.dest / ".sync-stockbit.json").read_text())
        self.assertIn("2026-10-07", state["days"]); self.assertIn("2026-10-05", state["weeks"])

    def test_desk_hold_merges_with_rollback_entries_and_never_drops_them(self):
        rollback = {"sha256": "abc", "rollback_of": "t1"}
        merged = sync.desk_hold_entries({"2026-10-05": rollback, "2026-10-06": "*"}, {"2026-10-05", "2026-10-06", "2026-10-07"},
                                        {"2026-10-05", "2026-10-06", "2026-10-07"})
        self.assertEqual(merged, {"2026-10-05": {**rollback, "withheld_by": "desk"},
                                  "2026-10-06": {"sha256": "*", "rollback_of": None, "withheld_by": "desk"},
                                  "2026-10-07": {"sha256": "*", "withheld_by": "desk"}})
        released = sync.desk_hold_entries(merged, set(), set())
        self.assertEqual(released, {"2026-10-05": rollback, "2026-10-06": {"sha256": "*", "rollback_of": None}})
        # A withheld day whose files are already gone keeps its desk entry while the desk still withholds it.
        self.assertEqual(sync.desk_hold_entries(merged, {"2026-10-07"}, set())["2026-10-07"], {"sha256": "*", "withheld_by": "desk"})

    def test_refused_withheld_sync_deletes_nothing(self):
        self.sync(FakeDesk(["2026-10-05", "2026-10-06"]))
        desk = FakeDesk(["2026-10-05", "2026-10-06"], withheld=["2026-10-06"])
        desk.overrides["index"] = {"format": 2}
        self.refused(desk, "format")
        self.assertTrue((self.dest / "sbringkas_2026-10-06_2026-10-06.md").is_file())
        for answer, pattern in (({"days": "2026-10-06"}, "withheld"), ({"days": ["2026-13-01"]}, "tanggal"),
                                (["2026-10-06"], "withheld"), ({"days": ["2026-10-06"], "llm_calls": 1}, "LLM")):
            with self.subTest(answer):
                bad = FakeDesk(["2026-10-05", "2026-10-06"], withheld=[])
                bad.overrides["withheld"] = answer
                self.refused(bad, pattern)
        # A desk error other than 404 is not "nothing withheld": the round aborts without touching the archive.
        broken = FakeDesk(["2026-10-05", "2026-10-06"], withheld=[])

        def get(path, timeout=60):
            if path.endswith("/withheld"):
                raise HTTPError(path, 500, "boom", {}, None)
            return FakeDesk.get(broken, path)
        before = self.snapshot()
        with patch.object(broken, "get", side_effect=get):
            with self.assertRaises(HTTPError):
                self.sync(broken)
        self.assertEqual(self.snapshot(), before)

    def test_404_keeps_existing_desk_holds(self):
        desk = self.week_desk(withheld=[])
        self.sync(desk)
        desk.withheld = ["2026-10-07"]
        self.sync(desk)
        self.assertEqual(self.hold(), {"2026-10-07": {"sha256": "*", "withheld_by": "desk"}})
        self.assertNotIn("sbringkas_2026-10-07_2026-10-07.md", set(self.snapshot()))
        hold_before = self.hold()
        # The desk now answers 404 (old/unrestarted desk) and lists 2026-10-07 again: unknown is not "released".
        desk.withheld = None
        desk.calls.clear()
        self.sync(desk)
        names = set(self.snapshot())
        self.assertNotIn("sbringkas_2026-10-07_2026-10-07.md", names)
        self.assertNotIn("sbpekan_2026-10-05_2026-10-11.md", names)
        self.assertEqual(self.hold(), hold_before)
        self.assertNotIn("2026-10-07", [d["d"] for d in json.loads((self.dest / "stockbit-index.json").read_text())["days"]])
        self.assertFalse([c for c in desk.calls if "/export/day/2026-10-07" in c or "/export/week/" in c])
        # Only a desk that supports the endpoint can release it.
        desk.withheld = []
        self.sync(desk)
        self.assertIn("sbringkas_2026-10-07_2026-10-07.md", set(self.snapshot()))
        self.assertEqual(self.hold(), {})

    def test_old_desk_without_withheld_endpoint(self):
        desk = FakeDesk(["2026-10-05", "2026-10-06"])  # 404 for /export/withheld
        self.assertTrue(self.sync(desk))
        self.assertIn("/api/stockbit/export/withheld", desk.calls)
        self.assertIn("sbringkas_2026-10-06_2026-10-06.md", set(self.snapshot()))
        self.assertNotIn(".stockbit-hold.json", set(self.snapshot()))

    def test_quarantined_stream_id_refused_as_link_or_bare_id(self):
        for extra in (" lihat [pos](https://stockbit.com/post/36999999)", " (post 36999999)"):
            with self.subTest(extra):
                desk = FakeDesk(["2026-10-05"], quarantined={"2026-10-05": [36999999]})
                text = day_text("2026-10-05", "detail", extra)
                desk.overrides[("2026-10-05", "detail")] = {"text": text, "sha256": sha(text)}
                self.refused(desk, "karantina")
        # Index carrying a quarantined id is also refused; longer numbers containing the id are not a hit.
        desk = FakeDesk(["2026-10-05"], quarantined={"2026-10-05": ["36999999"]})
        desk.overrides["index"] = {"users": {"bob": [[0, 1, ["BBCA"], ["https://stockbit.com/post/36999999"]]]}}
        self.refused(desk, "karantina")
        self.assertEqual(sync.quarantine_hits("x 136999999 and 369999990", {"36999999"}), [])
        with self.assertRaises(sync.StockbitRefused):
            sync.stockbit_ids(["12; rm"])

    def test_shrink_guard(self):
        for d in ("2026-10-01", "2026-10-02", "2026-10-03"):
            (self.dest / f"sbringkas_{d}_{d}.md").write_text("terbit")
        self.refused(FakeDesk(["2026-10-01", "2026-10-02"]), "sudah terbit")

    def test_provisional_days_need_flag_and_since_filter(self):
        # The desk index lists the final 2026-09-30 too (no start filter): it is dropped, not refused.
        desk = FakeDesk(["2026-09-30", "2026-10-05", "2026-10-06"])
        desk.listing[2]["state"] = "sementara"
        desk.overrides["index"] = {"tickers": {"BBCA": [[0, 1, 1, 0, "", {}], [1, 3, 2, 1, "inti", {}]], "OLD": [[0, 1, 1, 0, "", {}]]},
                                   "users": {"old": [[0, 1, [], ["f0"]]], "alice": [[1, 2, ["BBCA"], ["f1"]]]},
                                   "user_notes": {"old": {"penilaian": {"text": "x", "finding_ids": ["f0"]}}}}
        self.sync(desk)
        names = set(self.snapshot())
        self.assertIn("sbringkas_2026-10-05_2026-10-05.md", names)
        self.assertNotIn("sbringkas_2026-10-06_2026-10-06.md", names)
        self.assertNotIn("sbringkas_2026-09-30_2026-09-30.md", names)  # before 2026-10-01 backfill start
        index = json.loads((self.dest / "stockbit-index.json").read_text())
        self.assertEqual([d["d"] for d in index["days"]], ["2026-10-05"])
        self.assertEqual(index["tickers"], {"BBCA": [[0, 3, 2, 1, "inti", {}]]})
        self.assertEqual(index["users"], {"alice": [[0, 2, ["BBCA"], ["f1"]]]})
        self.assertEqual(index["user_notes"], {})
        self.assertFalse([c for c in desk.calls if "2026-10-06?kind" in c])
        # A 'sementara' day is fetched with include_provisional=1 (the real desk answers 404 without it).
        del desk.overrides["index"]
        desk.overrides[("2026-10-06", "ringkas")] = {"state": "sementara"}
        desk.overrides[("2026-10-06", "detail")] = {"state": "sementara"}
        self.sync(desk, allow_provisional=True)
        self.assertIn("sbringkas_2026-10-06_2026-10-06.md", set(self.snapshot()))
        self.assertIn("/api/stockbit/export/day/2026-10-06?kind=ringkas&include_provisional=1", desk.calls)
        self.assertIn("/api/stockbit/export/index?include_provisional=1", desk.calls)
        index = json.loads((self.dest / "stockbit-index.json").read_text())
        self.assertEqual([d["d"] for d in index["days"]], ["2026-10-05", "2026-10-06"])

    def test_earlier_since_publishes_and_later_default_keeps_those_days(self):
        # The desk's 'Dari' date (2026-09-29) publishes September; the next run with the default floor must neither
        # refuse (shrink guard) nor drop them from the index, and keeps updating them.
        desk = FakeDesk(["2026-09-29", "2026-09-30", "2026-10-05"])
        self.sync(desk, stockbit_since="2026-09-29")
        names = set(self.snapshot())
        self.assertIn("sbringkas_2026-09-29_2026-09-29.md", names)
        self.assertIn("sbringkas_2026-09-30_2026-09-30.md", names)
        self.sync(desk)
        index = json.loads((self.dest / "stockbit-index.json").read_text())
        self.assertEqual([d["d"] for d in index["days"]], ["2026-09-29", "2026-09-30", "2026-10-05"])
        desk.listing[0]["sha256"] = "h-new"
        desk.overrides[("2026-09-29", "ringkas")] = {"text": "baru", "sha256": sha("baru")}
        self.sync(desk)
        self.assertEqual((self.dest / "sbringkas_2026-09-29_2026-09-29.md").read_text(), "baru")

    def test_index_day_outside_since_and_held_still_refused_if_unknown(self):
        desk = FakeDesk(["2026-10-05"])
        desk.overrides["index"] = {"days": [{"d": "2026-10-05", "f": "sbringkas_2026-10-05_2026-10-05.md"},
                                            {"d": "2026-10-09", "f": "sbringkas_2026-10-09_2026-10-09.md"}]}
        self.refused(desk, "tidak diterbitkan")

    def test_rollback_hold_skips_day_until_desk_sha_changes(self):
        desk = FakeDesk(["2026-10-05", "2026-10-06"])
        (self.dest / ".stockbit-hold.json").write_text(json.dumps(
            {"format": 1, "days": {"2026-10-06": {"sha256": "h2026-10-06", "tag": "stockbit-publish-x"}}}))
        self.sync(desk)
        names = set(self.snapshot())
        self.assertIn("sbringkas_2026-10-05_2026-10-05.md", names)
        self.assertNotIn("sbringkas_2026-10-06_2026-10-06.md", names)
        self.assertFalse([c for c in desk.calls if "2026-10-06?kind" in c])
        index = json.loads((self.dest / "stockbit-index.json").read_text())
        self.assertEqual([d["d"] for d in index["days"]], ["2026-10-05"])
        self.assertTrue((self.dest / ".stockbit-hold.json").is_file(), "sync never rewrites or drops the hold")
        # The desk re-finalized the day (new sha): the hold no longer applies.
        desk.listing[1]["sha256"] = "h-new"
        self.sync(desk)
        self.assertIn("sbringkas_2026-10-06_2026-10-06.md", set(self.snapshot()))

    def test_weeks_only_when_complete(self):
        days = [f"2026-10-{d:02d}" for d in range(5, 12)]  # Mon 5 .. Sun 11
        desk = FakeDesk(days + ["2026-10-12"], weeks={"2026-10-05"})
        self.sync(desk)
        self.assertTrue((self.dest / "sbpekan_2026-10-05_2026-10-11.md").is_file())
        self.assertNotIn("/api/stockbit/export/week/2026-10-12", desk.calls)  # 12..18 incomplete: not requested
        desk2 = FakeDesk(days + ["2026-10-12"])  # server 404 for the week -> skipped, no error
        self.tmp2 = self.dest / "sbpekan_2026-10-05_2026-10-11.md"; self.tmp2.unlink()
        state = json.loads((self.dest / ".sync-stockbit.json").read_text()); state["weeks"] = {}
        (self.dest / ".sync-stockbit.json").write_text(json.dumps(state))
        self.sync(desk2)
        self.assertFalse(self.tmp2.exists())

    def test_wrong_build_category_refused(self):
        with patch.object(sync, "categorize", return_value="lainnya"):
            self.refused(FakeDesk(["2026-10-05"]), "kategori")

    def test_redaction_applied_after_hash_check(self):
        desk = FakeDesk(["2026-10-05"])
        text = day_text("2026-10-05", "detail", " hubungi 0812-3456-7890")
        desk.overrides[("2026-10-05", "detail")] = {"text": text, "sha256": sha(text)}
        self.sync(desk)
        written = (self.dest / "sbdetail_2026-10-05_2026-10-05.md").read_text()
        self.assertNotIn("0812-3456-7890", written); self.assertIn("[nomor HP disamarkan]", written)

    def test_failed_commit_restores_stockbit_files_and_state(self):
        self.sync(FakeDesk(["2026-10-05"]))
        before = self.snapshot()
        desk = FakeDesk(["2026-10-05", "2026-10-06"])
        write, failed = sync.write_if_changed, []

        def fail_state(path, text):
            if path == self.dest / ".sync-stockbit.json" and not failed:
                failed.append(path)
                raise OSError("simulated disk failure")
            return write(path, text)
        with patch.object(sync, "write_if_changed", fail_state), self.assertRaises(OSError):
            self.sync(desk)
        self.assertEqual(self.snapshot(), before)

    def test_normal_sync_never_prunes_stockbit_files(self):
        sb = self.dest / "sbringkas_2026-10-05_2026-10-05.md"; sb.write_text("terbit")
        (self.dest / "digest_old.md").write_text("old")

        def work(args):
            sync.prune("digest_", set(), allow_empty=True)
            return True
        with patch.object(sync, "_sync_once", work):
            sync.sync_once(SimpleNamespace())
        self.assertEqual(sb.read_text(), "terbit"); self.assertFalse((self.dest / "digest_old.md").exists())
        for prefix in ("sbringkas_", "sbdetail_", "sbpekan_"):
            with self.assertRaises(ValueError):
                sync.prune(prefix, set(), allow_empty=True)

    def test_run_dispatch_default_and_with_stockbit(self):
        calls = []

        def fake_sync_once(args):
            calls.append(bool(getattr(args, "stockbit_only", False)))
            return False
        base = dict(server="http://127.0.0.1:8787", no_build=True, build=False, fragment_index=None, force=False,
                    stockbit_only=False, with_stockbit=False)
        with patch.object(sync, "sync_once", fake_sync_once):
            self.assertEqual(sync.run(argparse.Namespace(**base)), 0)
            self.assertEqual(calls, [False])
            calls.clear()
            self.assertEqual(sync.run(argparse.Namespace(**{**base, "with_stockbit": True})), 0)
            self.assertEqual(calls, [False, True])
        with patch.object(sync, "sync_once", side_effect=sync.StockbitRefused("x")), redirect_stderr(io.StringIO()):
            self.assertEqual(sync.run(argparse.Namespace(**{**base, "stockbit_only": True})), 1)

    @unittest.skipUnless("stockbit-ringkasan" in build.CATEGORIES, "build.py belum punya kategori stockbit-* (tugas build-viewer)")
    def test_real_build_categories_match(self):
        for prefix, cat in CATS.items():
            self.assertEqual(build.categorize(f"{prefix}_2026-10-05_2026-10-05"), cat)
        self.assertEqual(sync.STOCKBIT_CATEGORY, CATS)


if __name__ == "__main__":
    unittest.main()
