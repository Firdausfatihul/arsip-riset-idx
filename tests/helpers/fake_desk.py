"""Fake IDX Signal Desk for the sync tests: the read-only export of one family (Stockbit /api/stockbit, BEI /api/bei).

Records every requested path in `calls`. `overrides` replaces fields of a day file ({(day, kind): {...}}), a week
({("week", monday): {...}}), the index ({"index": {...}}) or the withheld answer ({"withheld": ...}).
withheld=None is an old desk without /export/withheld (404); a list is the days held from the web, hidden by the desk.
"""
from datetime import date, timedelta
import hashlib
from urllib.error import HTTPError


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class FakeDesk:
    api = prefix = None  # "/api/stockbit", "sb"

    def __init__(self, days, weeks=(), withheld=None):
        self.calls, self.days, self.weeks, self.withheld, self.overrides = [], list(days), set(weeks), withheld, {}

    def hidden(self, day):
        return day in (self.withheld or ())

    def exported(self, day, path):
        """Like the real desk: non-final days only with include_provisional=1."""
        row = next((r for r in self.listing if r["date"] == day), None)
        return row is None or row["state"] == "final" or "include_provisional=1" in path

    def shown(self, rows, path):
        return [r for r in rows if (r["state"] == "final" or "include_provisional=1" in path) and not self.hidden(r["date"])]

    def day(self, day, kind):
        text = self.day_text(day, kind)
        r = {"name": f"{self.prefix}{kind}_{day}_{day}.md", "text": text, "sha256": sha(text), **self.day_fields(day)}
        r.update(self.overrides.get((day, kind), {}))
        return r

    def week(self, monday, sunday):
        text = self.week_text(monday)
        r = {"name": f"{self.prefix}pekan_{monday}_{sunday}.md", "text": text, "sha256": sha(text), **self.week_fields}
        r.update(self.overrides.get(("week", monday), {}))
        return r

    def get(self, path, timeout=60):
        self.calls.append(path)
        api = self.api
        if path == "/api/health":
            return {"ok": True}
        if path == api + "/export/withheld":
            if "withheld" in self.overrides:
                return self.overrides["withheld"]
            if self.withheld is None:
                raise HTTPError(path, 404, "old desk", {}, None)
            return {"days": list(self.withheld), "llm_calls": 0}
        if path.startswith(api + "/export/days"):
            return {"days": self.export_days(path)}
        if path.startswith(api + "/export/day/"):
            day, query = path.rsplit("/", 1)[1].split("?kind=")
            if self.hidden(day):
                raise HTTPError(path, 409, "withheld", {}, None)
            if not self.exported(day, path):
                raise HTTPError(path, 404, "not final", {}, None)
            return self.day(day, query.split("&", 1)[0])
        if path.startswith(api + "/export/week/"):
            monday = path.rsplit("/", 1)[1]
            week = [(date.fromisoformat(monday) + timedelta(days=i)).isoformat() for i in range(7)]
            if monday not in self.weeks or any(self.hidden(d) for d in week):
                raise HTTPError(path, 404, "not complete", {}, None)
            return self.week(monday, week[-1])
        if path.split("?", 1)[0] == api + "/export/index":
            return self.index(path)
        raise AssertionError(f"unexpected call {path}")


class StockbitDesk(FakeDesk):
    api, prefix, week_fields = "/api/stockbit", "sb", {}

    def __init__(self, days, quarantined=None, weeks=(), user_notes=None, withheld=None):
        super().__init__(days, weeks, withheld)
        self.quarantined, self.user_notes = quarantined or {}, user_notes
        self.listing = [{"date": d, "state": "final", "sha256": "h" + d, "updated_at": "t1", "ok": True,
                         "coverage": {"posts_total": 10}} for d in self.days]

    @staticmethod
    def day_text(day, kind, extra=""):
        return (f"# Ringkasan Stockbit Ideas · {day} ({kind})\n\nCakupan: 10/10 posting utama diberi disposisi · final\n\n"
                f"## BBCA\n- klaim pengguna [pos](https://stockbit.com/post/36000001){extra}\n")

    def day_fields(self, day):
        return {"state": "final", "coverage": {"ok": True}, "quarantined_stream_ids": self.quarantined.get(day, []), "llm_calls": 0}

    @staticmethod
    def week_text(monday):
        return f"# Rekap pekan {monday}\n\nCakupan: tujuh hari final.\n"

    def export_days(self, path):
        return self.shown(self.listing, path)

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


class BeiDesk(FakeDesk):
    """BEI export (contract: docs/BEI_PIPELINE_PLAN.md in the desk repo). has_bei=False is an old desk without /api/bei
    (404 everywhere); `stockbit` answers /api/stockbit; profile_id is added to every BEI answer (None: an old desk that
    names no profile), profile_by_path switches it per path prefix (the active profile changes mid-sync); `empty` are
    covered days without announcements (final, no files)."""
    api, prefix, week_fields = "/api/bei", "bei", {"llm_calls": 0}

    def __init__(self, days, weeks=(), withheld=None, has_bei=True, stockbit=None, profile_id=None, empty=()):
        super().__init__(days, weeks, withheld)
        self.has_bei, self.stockbit, self.profile_id, self.profile_by_path = has_bei, stockbit, profile_id, {}
        self.empty = [{"date": d, "state": "final", "announcements": 0, "sha256": None, "detail_sha256": None,
                       "updated_at": "t1", "ok": True, "problems": [], "warnings": [], "files": {}} for d in empty]
        self.listing = [{"date": d, "state": "final", "sha256": "r" + d, "detail_sha256": "d" + d, "updated_at": "t1",
                         "ok": True, "problems": [], "warnings": [],
                         "files": {"ringkas": f"beiringkas_{d}_{d}.md", "detail": f"beidetail_{d}_{d}.md"}} for d in self.days]

    @staticmethod
    def day_text(day, kind, extra=""):
        return (f"# Ringkasan keterbukaan BEI · {day} ({kind})\n\nCakupan: 12 pengumuman · 5 emiten · final\n\n"
                f"### BBCA — Bank Central Asia Tbk\n- 09:12 · Panggilan RUPS · [pengumuman](https://www.idx.co.id/x.pdf) · 123{extra}\n")

    def day_fields(self, day):
        return {"state": "final", "llm_calls": 0}

    @staticmethod
    def week_text(monday):
        return f"# Rekap keterbukaan BEI pekan {monday}\n\nTujuh hari final.\n"

    def export_days(self, path):
        return sorted(self.shown(self.listing + self.empty, path), key=lambda r: r["date"])

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
        if path.startswith("/api/stockbit/"):
            self.calls.append(path)
            if self.stockbit is None:
                raise AssertionError(f"unexpected Stockbit call {path}")
            return self.stockbit.get(path, timeout)
        if path.startswith("/api/bei/") and not self.has_bei:
            self.calls.append(path)
            raise HTTPError(path, 404, "no bei router", {}, None)
        r = super().get(path, timeout)
        pid = next((v for prefix, v in self.profile_by_path.items() if path.startswith(prefix)), self.profile_id)
        return {**r, "profile_id": pid} if pid is not None and isinstance(r, dict) and path.startswith("/api/bei/") else r
