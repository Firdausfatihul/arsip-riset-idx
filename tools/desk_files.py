"""Berkas yang diterbitkan desk ke arsip: ringkasan Stockbit (sb*) dan ringkasan keterbukaan BEI (bei*).

Satu sumber untuk nama berkas, kategori build.py, berkas indeks/status/tahanan per keluarga, dan isi berkas tahanan.
tools/sync_idx.py menulis berkas ini; tools/publish_stockbit.py dan tools/rollback_stockbit.py meng-commit dan
membatalkannya.

Berkas tahanan (.stockbit-hold.json / .bei-hold.json): {"format": 1, "days": {tgl: {"sha256": sha|"*", "rollback_of"?,
"withheld_by"?}}}. Hari yang ditahan tidak diterbitkan lagi sampai sha ekspor desk berubah (desk memfinalkan ulang) atau
entrinya dihapus. rollback_stockbit.py menulis entri rollback (ikut di-commit bersama revert); sync_idx.py menambahkan
{"sha256": "*", "withheld_by": "desk"} untuk hari terbit yang ditahan desk dari web (berkasnya dicabut) dan membuang
hanya entri desk itu saat desk melepasnya.
"""
from dataclasses import dataclass
from datetime import date, timedelta
import json
import re
from typing import NamedTuple

FOLDER = "needtobeindexed/idx-signal-desk"
KINDS = {"ringkas": "ringkasan", "detail": "detail", "pekan": "pekan"}  # jenis berkas -> akhiran kategori build.py
DAY = r"[0-9]{4}-[0-9]{2}-[0-9]{2}"
NAME = re.compile(rf"(sb|bei)(ringkas|detail|pekan)_({DAY})_({DAY})\.md")


@dataclass(frozen=True)
class Family:
    key: str     # "stockbit" / "bei": endpoint /api/<key>/export di desk dan awalan kategori build.py
    label: str   # untuk pesan
    prefix: str  # berkas <prefix>ringkas_ / <prefix>detail_ / <prefix>pekan_<awal>_<akhir>.md
    index: str
    state: str
    hold: str
    suffix: str  # akhiran kolom keluarga ini di .stockbit-publish/log.jsonl (day_shas, withheld, held)

    def name(self, kind, start, end=None):
        return f"{self.prefix}{kind}_{start}_{end or start}.md"

    @property
    def names(self):
        """Berkas tetap keluarga ini: indeks, status sinkron, tahanan."""
        return (self.index, self.state, self.hold)


STOCKBIT = Family("stockbit", "Stockbit", "sb", "stockbit-index.json", ".sync-stockbit.json", ".stockbit-hold.json", "")
BEI = Family("bei", "BEI", "bei", "bei-index.json", ".sync-bei.json", ".bei-hold.json", "_bei")
FAMILIES = (STOCKBIT, BEI)


class DeskFile(NamedTuple):
    family: Family
    kind: str  # ringkas, detail, pekan
    start: str
    end: str

    @property
    def category(self):
        return f"{self.family.key}-{KINDS[self.kind]}"

    def days(self):
        """Hari yang dicakup: satu hari (ringkas/detail, awal = akhir) atau hari-hari pekan (paling banyak 7);
        kosong kalau tanggalnya tidak valid."""
        start, end = iso_date(self.start), iso_date(self.end)
        span = (end - start).days if start and end else -1
        if self.kind != "pekan":
            return {self.start} if span == 0 else set()
        return {(start + timedelta(days=i)).isoformat() for i in range(span + 1)} if 0 <= span <= 6 else set()


def parse(path):
    """DeskFile dari nama berkas sb*/bei* (atau path: nama akhirnya), atau None."""
    match = NAME.fullmatch(str(path).rsplit("/", 1)[-1])
    return match and DeskFile(next(f for f in FAMILIES if f.prefix == match[1]), *match.groups()[1:])


def family_of(path):
    """Keluarga pemilik berkas: berkas harian/pekannya atau indeks/status/tahanannya; None untuk berkas lain."""
    name = str(path).rsplit("/", 1)[-1]
    found = parse(name)
    return found.family if found else next((f for f in FAMILIES if name in f.names), None)


def iso_date(value):
    """date untuk tanggal YYYY-MM-DD yang valid, selain itu None."""
    if not isinstance(value, str) or not re.fullmatch(DAY, value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def parse_hold(text):
    """Entri berkas tahanan {tgl: entri}, apa adanya; ValueError kalau isinya bukan JSON dengan objek days."""
    data = json.loads(text)
    days = data.get("days") if isinstance(data, dict) else None
    if not isinstance(days, dict):
        raise ValueError("tidak berisi objek days")
    return dict(days)


def desk_held(entries):
    """Hari yang ditahan desk dari web (withheld_by=desk) di entri tahanan."""
    return {day for day, entry in entries.items()
            if isinstance(entry, dict) and entry.get("withheld_by") == "desk" and iso_date(day)}


def hold_text(entries):
    return json.dumps({"format": 1, "days": dict(sorted(entries.items()))}, ensure_ascii=False, indent=1) + "\n"
