"""sync_idx.py --bei-only and --stockbit-only --with-bei: fake Signal Desk, no network, isolated temp archive."""
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

sys.path.insert(0, str(ROOT / "tests"))
from test_stockbit_sync import FakeDesk as StockbitDesk  # noqa: E402

CATS = {"beiringkas": "bei-ringkasan", "beidetail": "bei-detail", "beipekan": "bei-pekan",
        "sbringkas": "stockbit-ringkasan", "sbdetail": "stockbit-detail", "sbpekan": "stockbit-pekan"}


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def day_text(day, kind, extra=""):
    return (f"# Ringkasan keterbukaan BEI · {day} ({kind})\n\nCakupan: 12 pengumuman · 5 emiten · final\n\n"
            f"### BBCA — Bank Central Asia Tbk\n- 09:12 · Panggilan RUPS · [pengumuman](https://www.idx.co.id/x.pdf) · 123{extra}\n")


class FakeBeiDesk:
    """Ekspor read-only BEI (kontrak docs/BEI_PIPELINE_PLAN.md); mencatat setiap path yang diminta.

    has_bei=False meniru desk lama tanpa /api/bei (404 di semua endpoint BEI).
    """

    def __init__(self, days, weeks=(), withheld=None, has_bei=True, stockbit=None, profile_id=None, empty=()):
        self.calls, self.days, self.weeks = [], list(days), set(weeks)
        self.withheld, self.has_bei, self.stockbit = withheld, has_bei, stockbit
        self.profile_id = profile_id  # None = desk lama yang tidak menyebut profil
        self.profile_by_path = {}  # awalan path -> profil lain (profil aktif berganti di tengah sinkron)
        self.overrides = {}
        # Hari tercakup tanpa pengumuman: final, tanpa berkas (kontrak baru export/days).
        self.empty = [{"date": d, "state": "final", "announcements": 0, "sha256": None, "detail_sha256": None,
                       "updated_at": "t1", "ok": True, "problems": [], "warnings": [], "files": {}} for d in empty]
        self.listing = [{"date": d, "state": "final", "sha256": "r" + d, "detail_sha256": "d" + d, "updated_at": "t1",
                         "ok": True, "problems": [], "warnings": [],
                         "files": {"ringkas": f"beiringkas_{d}_{d}.md", "detail": f"beidetail_{d}_{d}.md"}} for d in self.days]

    def hidden(self, day):
        return day in (self.withheld or ())

    def exported(self, day, path):
        row = next((r for r in self.listing if r["date"] == day), None)
        return row is None or row["state"] == "final" or "include_provisional=1" in path

    def day(self, day, kind):
        prefix = {"ringkas": "beiringkas", "detail": "beidetail"}[kind]
        text = day_text(day, kind)
        r = {"name": f"{prefix}_{day}_{day}.md", "text": text, "sha256": sha(text), "state": "final", "llm_calls": 0}
        r.update(self.overrides.get((day, kind), {}))
        return r

    def index(self, path=""):
        shown = [d for d in self.days if self.exported(d, path) and not self.hidden(d)]
        idx = {"format": 1, "generated_at": "x",
               "days": [{"d": d, "f": f"beiringkas_{d}_{d}.md", "detail": f"beidetail_{d}_{d}.md", "k": "final", "n": 12,
                         "nonroutine": 4, "emiten": 5, "sha": "r" + d} for d in shown],
               "tickers": {"BBCA": [[0, 2, 1, "lanjutan", "panggilan RUPS", "Sebelumnya rencana; hari ini panggilan RUPS.",
                                     {"Aksi korporasi": 1, "Laporan rutin": 1}, ["id-1", "id-2"]]]},
               "names": {"BBCA": "Bank Central Asia Tbk"}}
        idx.update(self.overrides.get("index", {}))
        return idx

    def get(self, path, timeout=60):
        r = self.answer(path, timeout)
        pid = next((v for prefix, v in self.profile_by_path.items() if path.startswith(prefix)), self.profile_id)
        return {**r, "profile_id": pid} if pid is not None and isinstance(r, dict) and path.startswith("/api/bei/") else r

    def answer(self, path, timeout=60):
        self.calls.append(path)
        if path == "/api/health":
            return {"ok": True}
        if path.startswith("/api/stockbit/"):
            if self.stockbit is None:
                raise AssertionError(f"unexpected Stockbit call {path}")
            return self.stockbit.get(path, timeout)
        if path.startswith("/api/bei/") and not self.has_bei:
            raise HTTPError(path, 404, "no bei router", {}, None)
        if path == "/api/bei/export/withheld":
            if "withheld" in self.overrides:
                return self.overrides["withheld"]
            if self.withheld is None:
                raise HTTPError(path, 404, "old desk", {}, None)
            return {"days": list(self.withheld), "llm_calls": 0}
        if path.startswith("/api/bei/export/days"):
            return {"days": sorted([r for r in self.listing + self.empty if (r["state"] == "final" or "include_provisional=1" in path)
                                    and not self.hidden(r["date"])], key=lambda r: r["date"])}
        if path.startswith("/api/bei/export/day/"):
            day, query = path.rsplit("/", 1)[1].split("?kind=")
            kind = query.split("&", 1)[0]
            if self.hidden(day):
                raise HTTPError(path, 409, "withheld", {}, None)
            if not self.exported(day, path):
                raise HTTPError(path, 404, "not final", {}, None)
            return self.day(day, kind)
        if path.startswith("/api/bei/export/week/"):
            monday = path.rsplit("/", 1)[1]
            sunday = (sync.date.fromisoformat(monday) + sync.timedelta(days=6)).isoformat()
            week = {(sync.date.fromisoformat(monday) + sync.timedelta(days=i)).isoformat() for i in range(7)}
            if monday not in self.weeks or any(self.hidden(d) for d in week):
                raise HTTPError(path, 404, "not complete", {}, None)
            text = f"# Rekap keterbukaan BEI pekan {monday}\n\nTujuh hari final.\n"
            r = {"name": f"beipekan_{monday}_{sunday}.md", "text": text, "sha256": sha(text), "llm_calls": 0}
            r.update(self.overrides.get(("week", monday), {}))
            return r
        if path.split("?", 1)[0] == "/api/bei/export/index":
            return self.index(path)
        raise AssertionError(f"unexpected call {path}")


class BeiSyncTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dest = self.root / "needtobeindexed/idx-signal-desk"; self.dest.mkdir(parents=True)
        p = patch.multiple(sync, ROOT=self.root, DEST=self.dest, STATE=self.dest / ".sync.json",
                           OWNERSHIP_JSON=self.dest / "kepemilikan.json",
                           STOCKBIT_STATE=self.dest / ".sync-stockbit.json", STOCKBIT_INDEX=self.dest / "stockbit-index.json",
                           STOCKBIT_HOLD=self.dest / ".stockbit-hold.json",
                           BEI_STATE=self.dest / ".sync-bei.json", BEI_INDEX=self.dest / "bei-index.json",
                           BEI_HOLD=self.dest / ".bei-hold.json",
                           categorize=lambda stem: CATS.get(stem.split("_", 1)[0], build.categorize(stem)))
        p.start(); self.addCleanup(p.stop)

    def snapshot(self):
        return {p.name: p.read_bytes() for p in self.dest.iterdir()}

    def sync(self, desk, **extra):
        args = SimpleNamespace(**{"server": "http://127.0.0.1:8787", "bei_only": True, "force": False,
                                  "allow_provisional": False, "bei_since": None, **extra})
        with patch.object(sync, "Server", return_value=desk), redirect_stdout(io.StringIO()) as out:
            result = sync.sync_once(args)
        self.output = out.getvalue()
        return result

    def refused(self, desk, pattern=None, exc=None, **extra):
        before = self.snapshot()
        with self.assertRaises(exc or sync.BeiRefused) as ctx:
            self.sync(desk, **extra)
        self.assertEqual(self.snapshot(), before, "a refused sync must not write anything")
        if pattern:
            self.assertRegex(str(ctx.exception), pattern)

    def hold(self):
        return json.loads((self.dest / ".bei-hold.json").read_text())["days"]

    def index(self):
        return json.loads((self.dest / "bei-index.json").read_text())

    def test_bei_only_writes_days_index_state_without_profile_or_stockbit_calls(self):
        desk = FakeBeiDesk(["2026-10-05", "2026-10-06"])
        with patch.object(sync, "_sync_once", side_effect=AssertionError("profile path must not run")), \
                patch.object(sync, "sync_stockbit", side_effect=AssertionError("Stockbit must not run")):
            self.assertTrue(self.sync(desk))
        names = set(self.snapshot())
        self.assertLessEqual({"beiringkas_2026-10-05_2026-10-05.md", "beidetail_2026-10-05_2026-10-05.md",
                              "beiringkas_2026-10-06_2026-10-06.md", "bei-index.json", ".sync-bei.json"}, names)
        self.assertFalse(names & {".sync.json", ".sync-stockbit.json", "stockbit-index.json"})
        self.assertFalse([c for c in desk.calls if c.startswith(("/api/profiles", "/api/ownership", "/api/share", "/api/stockbit"))])
        state = json.loads((self.dest / ".sync-bei.json").read_text())
        self.assertEqual(state["days"]["2026-10-05"]["files"]["beiringkas_2026-10-05_2026-10-05.md"],
                         sha(day_text("2026-10-05", "ringkas")))
        self.assertEqual(state["days"]["2026-10-05"]["fp"], "r2026-10-05|d2026-10-05|t1|final")
        self.assertEqual(self.index()["names"], {"BBCA": "Bank Central Asia Tbk"})
        desk.calls.clear()
        self.assertFalse(self.sync(desk))
        self.assertFalse([c for c in desk.calls if "/export/day/" in c])

    def test_globals_restored_after_success_and_failure(self):
        originals = (sync.DEST, sync.BEI_STATE, sync.BEI_INDEX, sync.BEI_HOLD)
        self.sync(FakeBeiDesk(["2026-10-05"]))
        self.assertEqual((sync.DEST, sync.BEI_STATE, sync.BEI_INDEX, sync.BEI_HOLD), originals)
        bad = FakeBeiDesk(["2026-10-06"]); bad.overrides[("2026-10-06", "ringkas")] = {"sha256": "0" * 64}
        with self.assertRaises(sync.BeiRefused):
            self.sync(bad)
        self.assertEqual((sync.DEST, sync.BEI_STATE, sync.BEI_INDEX, sync.BEI_HOLD), originals)

    def test_desk_without_bei_router_is_skipped_untouched(self):
        self.sync(FakeBeiDesk(["2026-10-05"]))
        before = self.snapshot()
        desk = FakeBeiDesk(["2026-10-05"], has_bei=False)
        self.assertFalse(self.sync(desk))
        self.assertEqual(self.snapshot(), before)
        self.assertIn("BEI dilewati", self.output)
        self.assertEqual([c for c in desk.calls if c.startswith("/api/bei")], ["/api/bei/export/days"])

    def test_validation_failures_abort_without_writing(self):
        self.sync(FakeBeiDesk(["2026-10-05"]))
        cases = {
            "sha": ({("2026-10-06", "ringkas"): {"sha256": "0" * 64}}, "sha256"),
            "name": ({("2026-10-06", "detail"): {"name": "beidetail_2026-10-07_2026-10-07.md"}}, "nama berkas"),
            "traversal": ({("2026-10-06", "ringkas"): {"name": "../../etc/beiringkas_2026-10-06_2026-10-06.md"}}, "nama berkas"),
            "state": ({("2026-10-06", "ringkas"): {"state": "sementara"}}, "status"),
            "llm": ({("2026-10-06", "ringkas"): {"llm_calls": 1}}, "LLM"),
            "empty": ({("2026-10-06", "ringkas"): {"text": " ", "sha256": sha(" ")}}, "kosong"),
            "index_unpublished": ({"index": {"days": [{"d": "2026-10-09", "f": "beiringkas_2026-10-09_2026-10-09.md"}]}},
                                  "tidak diterbitkan"),
            "index_format": ({"index": {"format": 2}}, "format"),
            "index_detail": ({"index": {"days": [{"d": "2026-10-05", "f": "beiringkas_2026-10-05_2026-10-05.md",
                                                  "detail": "../beidetail_2026-10-05_2026-10-05.md"}]}}, "detail"),
            "index_bad_code": ({"index": {"tickers": {"<img>": [[0, 1, 1, "baru", "", "", {}, []]]}}}, "kode"),
            "index_row_shape": ({"index": {"tickers": {"BBCA": [[0, "2", 1, "baru", "", ""]]}}}, "format 1"),
            "index_row_nonroutine": ({"index": {"tickers": {"BBCA": [[0, 1, 3, "baru", "", ""]]}}}, "format 1"),
            "index_row_categories": ({"index": {"tickers": {"BBCA": [[0, 1, 1, "baru", "", "", {"x": -1}]]}}}, "format 1"),
            "index_row_day": ({"index": {"tickers": {"BBCA": [[7, 1, 1, "baru", "", ""]]}}}, "format 1"),
            "index_names": ({"index": {"names": {"BBCA": ["x"]}}}, "nama emiten"),
        }
        for label, (overrides, pattern) in cases.items():
            with self.subTest(label):
                desk = FakeBeiDesk(["2026-10-05", "2026-10-06"]); desk.overrides = overrides
                self.refused(desk, pattern)

    def test_listing_rejects_bad_dates_unreviewed_days_and_foreign_file_names(self):
        for row, pattern in (({"date": "2026-13-01"}, "tanggal"), ({"date": "../../x"}, "tanggal"), ({"ok": False}, "belum klop"),
                             ({"files": {"ringkas": "../beiringkas_2026-10-05_2026-10-05.md"}}, "kontrak"),
                             ({"files": "beiringkas"}, "kontrak")):
            with self.subTest(row):
                desk = FakeBeiDesk(["2026-10-05"]); desk.listing[0].update(row)
                self.refused(desk, pattern)

    def test_hostile_index_strings_are_kept_as_data_and_redacted(self):
        desk = FakeBeiDesk(["2026-10-05"])
        evil = '<img src=x onerror="alert(1)"> hubungi 0812-3456-7890'
        desk.overrides["index"] = {"tickers": {"BBCA": [[0, 1, 1, "baru", "rencana", evil, {evil: 1}, [evil]]]},
                                   "names": {"BBCA": evil}}
        self.sync(desk)
        index = self.index()
        row = index["tickers"]["BBCA"][0]
        self.assertTrue(row[5].startswith('<img src=x onerror="alert(1)">'))
        self.assertNotIn("0812-3456-7890", json.dumps(index))
        self.assertIn("[nomor HP disamarkan]", index["names"]["BBCA"])

    def week_desk(self, **kw):
        days = [f"2026-10-{d:02d}" for d in range(5, 13)]  # Sen 5 .. Min 11, plus Sen 12
        return FakeBeiDesk(days, weeks={"2026-10-05"}, **kw)

    def test_weeks_only_when_complete_and_404_skipped(self):
        desk = self.week_desk()
        self.sync(desk)
        self.assertTrue((self.dest / "beipekan_2026-10-05_2026-10-11.md").is_file())
        self.assertNotIn("/api/bei/export/week/2026-10-12", desk.calls)
        state = json.loads((self.dest / ".sync-bei.json").read_text())
        self.assertEqual(state["weeks"]["2026-10-05"]["file"], "beipekan_2026-10-05_2026-10-11.md")
        bad = self.week_desk(); bad.overrides[("week", "2026-10-05")] = {"name": "beipekan_2026-10-05_2026-10-12.md"}
        (self.dest / "beipekan_2026-10-05_2026-10-11.md").unlink()
        self.refused(bad, "nama berkas")

    def test_withheld_published_day_is_withdrawn_held_filtered_and_restored(self):
        desk = self.week_desk()
        self.sync(desk)
        rollback = {"sha256": "r2026-10-04", "rollback_of": "stockbit-publish-x"}
        (self.dest / ".bei-hold.json").write_text(json.dumps({"format": 1, "days": {"2026-10-04": rollback}}))
        desk.withheld = ["2026-10-07"]
        desk.calls.clear()
        all_days = [{"d": d, "f": f"beiringkas_{d}_{d}.md", "detail": f"beidetail_{d}_{d}.md"} for d in desk.days]
        desk.overrides["index"] = {"days": all_days,
                                   "tickers": {"BBCA": [[2, 1, 1, "baru", "", "", {}, []], [3, 2, 1, "lanjutan", "", "x", {}, []]],
                                               "ONLY": [[2, 1, 0, "rutin", "", "", {}, []]]},
                                   "names": {"BBCA": "Bank", "ONLY": "Hanya hari ditahan"}}
        self.assertTrue(self.sync(desk))  # 8 hari terbit, desk mengekspor 7: penjaga jumlah tidak menolak
        names = set(self.snapshot())
        for gone in ("beiringkas_2026-10-07_2026-10-07.md", "beidetail_2026-10-07_2026-10-07.md", "beipekan_2026-10-05_2026-10-11.md"):
            self.assertNotIn(gone, names)
        self.assertIn("beiringkas_2026-10-08_2026-10-08.md", names)
        self.assertEqual(self.hold(), {"2026-10-04": rollback, "2026-10-07": {"sha256": "*", "withheld_by": "desk"}})
        state = json.loads((self.dest / ".sync-bei.json").read_text())
        self.assertNotIn("2026-10-07", state["days"]); self.assertNotIn("2026-10-05", state["weeks"])
        index = self.index()
        self.assertNotIn("2026-10-07", [d["d"] for d in index["days"]])
        self.assertEqual(index["tickers"], {"BBCA": [[2, 2, 1, "lanjutan", "", "x", {}, []]]})
        self.assertEqual(index["names"], {"BBCA": "Bank"})
        self.assertFalse([c for c in desk.calls if "/export/day/2026-10-07" in c or "/export/week/" in c])
        before = self.snapshot()
        self.assertFalse(self.sync(desk))
        self.assertEqual(self.snapshot(), before)
        # 404 = tidak diketahui: tahanan desk tetap berlaku walau desk mendaftar harinya lagi.
        desk.withheld = None
        del desk.overrides["index"]
        self.sync(desk)
        self.assertNotIn("beiringkas_2026-10-07_2026-10-07.md", set(self.snapshot()))
        self.assertIn("2026-10-07", self.hold())
        # Dilepas desk: hanya entri desk yang hilang; hari dan pekannya diambil ulang.
        desk.withheld = []
        self.assertTrue(self.sync(desk))
        names = set(self.snapshot())
        for back in ("beiringkas_2026-10-07_2026-10-07.md", "beipekan_2026-10-05_2026-10-11.md"):
            self.assertIn(back, names)
        self.assertEqual(self.hold(), {"2026-10-04": rollback})

    def test_withheld_unpublished_day_is_not_published(self):
        desk = FakeBeiDesk(["2026-10-05", "2026-10-06"], withheld=["2026-10-06"])
        self.sync(desk)
        names = set(self.snapshot())
        self.assertNotIn("beiringkas_2026-10-06_2026-10-06.md", names)
        self.assertNotIn(".bei-hold.json", names)
        self.assertEqual([d["d"] for d in self.index()["days"]], ["2026-10-05"])

    def test_bad_withheld_answers_refuse(self):
        self.sync(FakeBeiDesk(["2026-10-05"]))
        for answer, pattern in (({"days": "2026-10-06"}, "withheld"), ({"days": ["2026-13-01"]}, "tanggal"),
                                ({"days": [], "llm_calls": 1}, "LLM")):
            with self.subTest(answer):
                bad = FakeBeiDesk(["2026-10-05", "2026-10-06"], withheld=[])
                bad.overrides["withheld"] = answer
                self.refused(bad, pattern)
        broken = FakeBeiDesk(["2026-10-05", "2026-10-06"], withheld=[])

        def get(path, timeout=60):
            if path.endswith("/withheld"):
                raise HTTPError(path, 500, "boom", {}, None)
            return FakeBeiDesk.get(broken, path)
        with patch.object(broken, "get", side_effect=get):
            self.refused(broken, exc=HTTPError)

    def test_rollback_hold_skips_day_until_sha_changes(self):
        desk = FakeBeiDesk(["2026-10-05", "2026-10-06"])
        (self.dest / ".bei-hold.json").write_text(json.dumps({"format": 1, "days": {"2026-10-06": {"sha256": "r2026-10-06"}}}))
        self.sync(desk)
        self.assertNotIn("beiringkas_2026-10-06_2026-10-06.md", set(self.snapshot()))
        self.assertEqual([d["d"] for d in self.index()["days"]], ["2026-10-05"])
        desk.listing[1]["sha256"] = "r-new"
        self.sync(desk)
        self.assertIn("beiringkas_2026-10-06_2026-10-06.md", set(self.snapshot()))

    def test_shrink_guard_since_and_provisional(self):
        for d in ("2026-10-01", "2026-10-02", "2026-10-03"):
            (self.dest / f"beiringkas_{d}_{d}.md").write_text("terbit")
        self.refused(FakeBeiDesk(["2026-10-01", "2026-10-02"]), "sudah terbit")
        for p in self.dest.glob("beiringkas_*"):
            p.unlink()
        desk = FakeBeiDesk(["2026-09-30", "2026-10-05", "2026-10-06"])
        desk.listing[2]["state"] = "sementara"
        self.sync(desk, bei_since="2026-10-01")
        names = set(self.snapshot())
        self.assertIn("beiringkas_2026-10-05_2026-10-05.md", names)
        self.assertNotIn("beiringkas_2026-09-30_2026-09-30.md", names)
        self.assertNotIn("beiringkas_2026-10-06_2026-10-06.md", names)
        self.assertEqual([d["d"] for d in self.index()["days"]], ["2026-10-05"])
        desk.overrides[("2026-10-06", "ringkas")] = {"state": "sementara"}
        desk.overrides[("2026-10-06", "detail")] = {"state": "sementara"}
        self.sync(desk, allow_provisional=True)
        self.assertIn("/api/bei/export/day/2026-10-06?kind=ringkas&include_provisional=1", desk.calls)
        self.assertIn("/api/bei/export/index?include_provisional=1", desk.calls)
        # Tanpa --bei-since: semua hari final desk.
        self.sync(FakeBeiDesk(["2026-09-30", "2026-10-05", "2026-10-06"]))
        self.assertIn("beiringkas_2026-09-30_2026-09-30.md", set(self.snapshot()))

    def test_published_provisional_day_may_age_out_of_the_export(self):
        # A 'sementara' day that went live stays as published when the desk stops listing it (its provisional window
        # passed); only a final day that disappears still blocks the sync.
        desk = FakeBeiDesk(["2026-10-04", "2026-10-05", "2026-10-06"])
        desk.listing[2]["state"] = "sementara"
        desk.overrides[("2026-10-06", "ringkas")] = {"state": "sementara"}
        desk.overrides[("2026-10-06", "detail")] = {"state": "sementara"}
        self.sync(desk, allow_provisional=True)
        self.assertIn("beiringkas_2026-10-06_2026-10-06.md", set(self.snapshot()))
        self.sync(FakeBeiDesk(["2026-10-04", "2026-10-05"]), allow_provisional=True)
        self.assertIn("beiringkas_2026-10-06_2026-10-06.md", set(self.snapshot()))
        self.refused(FakeBeiDesk(["2026-10-05"]), "sudah terbit")  # a final day went missing

    def test_wrong_build_category_refused_and_redaction_after_hash(self):
        with patch.object(sync, "categorize", return_value="keterbukaan-informasi"):
            self.refused(FakeBeiDesk(["2026-10-05"]), "kategori")
        desk = FakeBeiDesk(["2026-10-05"])
        text = day_text("2026-10-05", "detail", " hubungi 0812-3456-7890")
        desk.overrides[("2026-10-05", "detail")] = {"text": text, "sha256": sha(text)}
        self.sync(desk)
        written = (self.dest / "beidetail_2026-10-05_2026-10-05.md").read_text()
        self.assertNotIn("0812-3456-7890", written); self.assertIn("[nomor HP disamarkan]", written)

    def test_profile_pinned_on_first_sync_and_other_profile_skipped_untouched(self):
        desk = FakeBeiDesk(["2026-10-05", "2026-10-06"], profile_id="10-11-august")
        self.assertTrue(self.sync(desk))
        self.assertEqual(json.loads((self.dest / ".sync-bei.json").read_text())["profile_id"], "10-11-august")
        self.assertNotIn("profile_id", self.index(), "desk profile id is not published to the web")
        before = self.snapshot()
        # Profil lain dengan lebih sedikit hari final (dulu: BeiRefused) atau lebih banyak (dulu: menimpa): dilewati.
        for days in (["2026-10-05"], [], ["2026-10-05", "2026-10-06", "2026-10-07"]):
            with self.subTest(days=days):
                other = FakeBeiDesk(days, profile_id="sona", withheld=[])
                self.assertFalse(self.sync(other))
                self.assertEqual(self.snapshot(), before)
                self.assertIn("BEI dilewati", self.output)
                self.assertIn("'sona'", self.output)
                self.assertEqual([c for c in other.calls if c.startswith("/api/bei")], ["/api/bei/export/days"])
        # Desk yang tidak menyebut profil = tidak diketahui: perilaku lama, profil tercatat tidak diubah.
        old = FakeBeiDesk(["2026-10-05", "2026-10-06", "2026-10-07"])
        self.assertTrue(self.sync(old))
        self.assertIn("beiringkas_2026-10-07_2026-10-07.md", set(self.snapshot()))
        self.assertEqual(json.loads((self.dest / ".sync-bei.json").read_text())["profile_id"], "10-11-august")

    def test_bei_profile_override_switches_on_purpose(self):
        self.sync(FakeBeiDesk(["2026-10-05"], profile_id="a"))
        desk = FakeBeiDesk(["2026-10-05", "2026-10-06"], profile_id="b")
        self.assertFalse(self.sync(desk))
        self.assertTrue(self.sync(desk, bei_profile="b"))
        self.assertEqual(json.loads((self.dest / ".sync-bei.json").read_text())["profile_id"], "b")
        self.assertIn("beiringkas_2026-10-06_2026-10-06.md", set(self.snapshot()))
        # --bei-profile yang tidak cocok dengan desk juga melewati BEI.
        before = self.snapshot()
        self.assertFalse(self.sync(FakeBeiDesk(["2026-10-07"], profile_id="b"), bei_profile="c"))
        self.assertEqual(self.snapshot(), before)

    def test_profile_switch_mid_sync_skips_without_writing(self):
        self.sync(FakeBeiDesk(["2026-10-05"], profile_id="a"))
        for prefix in ("/api/bei/export/withheld", "/api/bei/export/day/", "/api/bei/export/index", "/api/bei/export/week/"):
            with self.subTest(prefix):
                desk = self.week_desk(profile_id="a", withheld=[])
                desk.profile_by_path[prefix] = "b"
                before = self.snapshot()
                self.assertFalse(self.sync(desk))
                self.assertEqual(self.snapshot(), before)
                self.assertIn("berganti di tengah sinkron", self.output)
        bad = FakeBeiDesk(["2026-10-06"], profile_id="a"); bad.profile_by_path["/api/bei/export/days"] = ["x"]
        self.refused(bad, "profile_id")

    def test_week_with_zero_announcement_final_days_is_synced(self):
        # Sen 5 .. Jum 9 berpengumuman, Sab 10 dan Min 11 tercakup tanpa pengumuman (desk: final).
        desk = FakeBeiDesk([f"2026-10-{d:02d}" for d in range(5, 10)], weeks={"2026-10-05"},
                           empty=["2026-10-10", "2026-10-11"])
        self.assertTrue(self.sync(desk))
        names = set(self.snapshot())
        self.assertIn("beipekan_2026-10-05_2026-10-11.md", names)
        self.assertFalse([c for c in desk.calls if "/export/day/2026-10-1" in c], "empty days have no files to fetch")
        self.assertNotIn("beiringkas_2026-10-10_2026-10-10.md", names)
        state = json.loads((self.dest / ".sync-bei.json").read_text())
        self.assertNotIn("2026-10-10", state["days"])
        self.assertEqual(state["weeks"]["2026-10-05"]["file"], "beipekan_2026-10-05_2026-10-11.md")
        # Tanpa perubahan: pekan tidak diminta ulang.
        desk.calls.clear()
        self.assertFalse(self.sync(desk))
        self.assertNotIn("/api/bei/export/week/2026-10-05", desk.calls)
        # Hari kosong yang tidak tercakup (tidak ada di export/days) = pekan belum lengkap.
        def fresh():
            for p in self.dest.iterdir():
                p.unlink()
        fresh()
        partial = FakeBeiDesk([f"2026-10-{d:02d}" for d in range(12, 17)], weeks={"2026-10-12"}, empty=["2026-10-17"])
        self.sync(partial)
        self.assertNotIn("/api/bei/export/week/2026-10-12", partial.calls)
        # Hari kosong yang ikut di indeks desk tidak menunjuk berkas yang tidak ada.
        fresh()
        idx = FakeBeiDesk(["2026-10-19"], empty=["2026-10-20"])
        idx.overrides["index"] = {"days": [{"d": d, "f": f"beiringkas_{d}_{d}.md", "detail": f"beidetail_{d}_{d}.md"}
                                           for d in ("2026-10-19", "2026-10-20")]}
        self.sync(idx)
        self.assertNotIn("2026-10-20", [d["d"] for d in self.index()["days"]])

    def test_index_rows_may_carry_a_section_hint(self):
        for hint in ("bbca", "emiten-lain", "laporan-rutin", True, False, None, {"s": "emiten-lain"}):
            with self.subTest(hint=hint):
                desk = FakeBeiDesk(["2026-10-05"])
                desk.overrides["index"] = {"tickers": {"BBCA": [[0, 2, 1, "baru", "", "", {}, [], hint]]}}
                self.sync(desk)
                self.assertEqual(self.index()["tickers"]["BBCA"][0][8], hint)
        for bad in ("<img>", "a b", "x" * 200, 3, ["bbca"], {"s": "<img>"}):
            with self.subTest(bad=bad):
                desk = FakeBeiDesk(["2026-10-05"])
                desk.overrides["index"] = {"tickers": {"BBCA": [[0, 2, 1, "baru", "", "", {}, [], bad]]}}
                self.refused(desk, "format 1")

    def test_never_pruned(self):
        for prefix in ("beiringkas_", "beidetail_", "beipekan_"):
            with self.assertRaises(ValueError):
                sync.prune(prefix, set(), allow_empty=True)

    @unittest.skipUnless("bei-ringkasan" in build.CATEGORIES, "build.py belum punya kategori bei-*")
    def test_real_build_categories_match(self):
        for prefix, cat in sync.BEI_CATEGORY.items():
            self.assertEqual(build.categorize(f"{prefix}_2026-10-05_2026-10-05"), cat)
        self.assertEqual(build.categorize("beipekan_2026-10-05_2026-10-11"), "bei-pekan")


class CombinedSyncTests(unittest.TestCase):
    """--stockbit-only --with-bei: satu staging; BEI ditolak = BEI dikembalikan utuh dan dilewati, Stockbit tetap ditulis."""
    setUp = BeiSyncTests.setUp
    snapshot = BeiSyncTests.snapshot

    def combined(self, desk):
        args = SimpleNamespace(server="http://127.0.0.1:8787", stockbit_only=True, with_bei=True, force=False,
                               allow_provisional=False, stockbit_since="2026-10-01", bei_since=None)
        with patch.object(sync, "Server", return_value=desk), redirect_stdout(io.StringIO()) as out:
            result = sync.sync_once(args)
        self.output = out.getvalue()
        return result

    def test_both_written_in_one_round(self):
        desk = FakeBeiDesk(["2026-10-05"], stockbit=StockbitDesk(["2026-10-05"]))
        self.assertTrue(self.combined(desk))
        names = set(self.snapshot())
        self.assertLessEqual({"sbringkas_2026-10-05_2026-10-05.md", "beiringkas_2026-10-05_2026-10-05.md",
                              "stockbit-index.json", "bei-index.json", ".sync-stockbit.json", ".sync-bei.json"}, names)

    def test_bei_refusal_skips_bei_but_still_publishes_stockbit(self):
        desk = FakeBeiDesk(["2026-10-05"], stockbit=StockbitDesk(["2026-10-05"]))
        desk.overrides[("2026-10-05", "detail")] = {"sha256": "0" * 64}
        self.assertTrue(self.combined(desk))
        names = set(self.snapshot())
        self.assertIn("sbringkas_2026-10-05_2026-10-05.md", names)
        self.assertFalse({n for n in names if n.startswith("bei") or "bei" in n})
        self.assertIn("BEI dilewati", self.output)

    def test_published_bei_day_back_to_provisional_keeps_bei_untouched(self):
        for d in ("2026-10-01", "2026-10-02"):
            (self.dest / f"beiringkas_{d}_{d}.md").write_text("terbit")
        (self.dest / ".sync-bei.json").write_text(json.dumps({"format": 1, "days": {"2026-10-01": {"fp": "x"}}}))
        before = {p.name: p.read_bytes() for p in self.dest.iterdir() if "bei" in p.name}
        desk = FakeBeiDesk(["2026-10-01"], stockbit=StockbitDesk(["2026-10-05"]))
        self.assertTrue(self.combined(desk))
        self.assertIn("sbringkas_2026-10-05_2026-10-05.md", set(self.snapshot()))
        self.assertEqual({p.name: p.read_bytes() for p in self.dest.iterdir() if "bei" in p.name}, before)
        self.assertIn("BEI dilewati", self.output)

    def test_desk_without_bei_still_publishes_stockbit(self):
        desk = FakeBeiDesk(["2026-10-05"], has_bei=False, stockbit=StockbitDesk(["2026-10-05"]))
        self.assertTrue(self.combined(desk))
        names = set(self.snapshot())
        self.assertIn("sbringkas_2026-10-05_2026-10-05.md", names)
        self.assertFalse({n for n in names if n.startswith("bei") or "bei" in n})
        self.assertIn("BEI dilewati", self.output)

    def test_other_desk_profile_skips_bei_but_still_publishes_stockbit(self):
        for d in ("2026-10-01", "2026-10-02"):
            (self.dest / f"beiringkas_{d}_{d}.md").write_text("terbit")
        (self.dest / ".sync-bei.json").write_text(json.dumps({"format": 1, "profile_id": "10-11-august"}))
        desk = FakeBeiDesk([], profile_id="sona", stockbit=StockbitDesk(["2026-10-05"]))
        self.assertTrue(self.combined(desk))
        names = set(self.snapshot())
        self.assertIn("sbringkas_2026-10-05_2026-10-05.md", names)
        self.assertEqual({n for n in names if n.startswith("bei")}, {"beiringkas_2026-10-01_2026-10-01.md",
                                                                       "beiringkas_2026-10-02_2026-10-02.md"})
        self.assertEqual(json.loads((self.dest / ".sync-bei.json").read_text())["profile_id"], "10-11-august")
        self.assertIn("BEI dilewati", self.output)

    def test_run_dispatch_and_exit_codes(self):
        calls = []

        def fake_sync_once(args):
            calls.append((bool(getattr(args, "stockbit_only", False)), bool(getattr(args, "bei_only", False)),
                          bool(getattr(args, "with_bei", False))))
            return False
        base = dict(server="http://127.0.0.1:8787", no_build=True, build=False, fragment_index=None, force=False,
                    stockbit_only=False, bei_only=False, with_stockbit=False, with_bei=False)
        with patch.object(sync, "sync_once", fake_sync_once):
            self.assertEqual(sync.run(argparse.Namespace(**{**base, "with_bei": True})), 0)
            self.assertEqual(calls, [(False, False, True), (False, True, False)])
            calls.clear()
            self.assertEqual(sync.run(argparse.Namespace(**{**base, "with_stockbit": True, "with_bei": True})), 0)
            self.assertEqual(calls, [(False, False, True), (True, False, True)])
            calls.clear()
            self.assertEqual(sync.run(argparse.Namespace(**{**base, "bei_only": True})), 0)
            self.assertEqual(calls, [(False, True, False)])
        with patch.object(sync, "sync_once", side_effect=sync.BeiRefused("x")), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(sync.run(argparse.Namespace(**{**base, "bei_only": True})), 1)
        self.assertIn("BEI ditolak", err.getvalue())


class DigestRetirementTests(unittest.TestCase):
    def test_digests_off_by_default_and_never_pruned(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "needtobeindexed/idx-signal-desk"; dest.mkdir(parents=True)
            old = dest / "digest_2026-09-01_2026-09-02.md"; old.write_text("lama")

            class Desk:
                def get(self, path, timeout=60):
                    if path == "/api/profiles":
                        return {"active_profile_id": "p1", "profiles": [{"id": "p1"}]}
                    if path == "/api/share/windows":
                        return {"windows": [{"start_date": "2026-10-01", "end_date": "2026-10-01", "start_at": "2026-10-01T00:00",
                                             "end_at": "2026-10-01T23:59", "updated_at": "u", "company_count": 1}]}
                    return {"ok": True}

                def post(self, path, body, timeout=300):
                    return {"text": "# x\nisi\n"}
            with patch.multiple(sync, ROOT=Path(tmp), DEST=dest, STATE=dest / ".sync.json"), \
                    patch.object(sync, "Server", return_value=Desk()), \
                    patch.object(sync, "sync_ownership", return_value=([], [])), redirect_stdout(io.StringIO()):
                sync.sync_once(SimpleNamespace(server="http://127.0.0.1:8787", profile=None, force=False))
                self.assertEqual(sorted(p.name for p in dest.glob("digest_*")), [old.name])
                sync.sync_once(SimpleNamespace(server="http://127.0.0.1:8787", profile=None, force=False, with_digests=True))
            self.assertEqual(sorted(p.name for p in dest.glob("digest_*")), ["digest_2026-09-01_2026-09-02.md", "digest_2026-10-01_2026-10-01.md"])
            self.assertEqual(old.read_text(), "lama")


if __name__ == "__main__":
    unittest.main()
