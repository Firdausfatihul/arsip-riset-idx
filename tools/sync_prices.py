#!/usr/bin/env python3
"""Salin harga penutupan harian dari dataset broker summary riset (chatgptrisetkeystat) untuk tab Kepemilikan Saham.

Sumber: <BROKSUM_DIR>/stockbit_<KODE>_metrics.csv (kolom `date`, `Close 1D`), dibaca saja, tidak diubah.
Hasil: needtobeindexed/harga/harga.json
  {format: 1, source, updated, d: [tanggal snapshot KSEI...], c: {KODE: [harga per tanggal d | null]}}
Harga per tanggal = baris terakhir dengan tanggal <= tanggal snapshot, paling lama 7 hari sebelumnya; selain itu null.
Dataset menulis ulang nilai terakhir pada hari tanpa perdagangan, jadi ini harga "as-of", belum disesuaikan aksi korporasi.

    python3 tools/sync_prices.py                  # lalu python3 build.py
    BROKSUM_DIR=/path/ke/dataset python3 tools/sync_prices.py
"""
import csv
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
OWN = ROOT / "needtobeindexed" / "idx-signal-desk" / "kepemilikan.json"
OUT = ROOT / "needtobeindexed" / "harga" / "harga.json"
DEFAULT_SRC = ROOT.parent / "chatgptrisetkeystat" / "dataset_broksum_20261003_recovered"
FILE = re.compile(r"stockbit_([A-Z0-9]{2,12})_metrics\.csv")
STALE = timedelta(days=7)


def closes(path, wanted):
    """Harga penutupan as-of tiap tanggal di `wanted` (urut naik)."""
    out = [None] * len(wanted)
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        di, ci = header.index("date"), header.index("Close 1D")
        rows = []
        for row in reader:
            try:
                day, price = date.fromisoformat(row[di]), float(row[ci])
            except (ValueError, IndexError):
                continue
            if price > 0:
                rows.append((day, price))
    rows.sort()
    k = 0
    for i, want in enumerate(wanted):
        while k < len(rows) and rows[k][0] <= want:
            k += 1
        if k and want - rows[k - 1][0] <= STALE:
            out[i] = rows[k - 1][1]
    return out


def main():
    src = Path(os.environ.get("BROKSUM_DIR") or DEFAULT_SRC)
    if not src.is_dir():
        raise SystemExit(f"Folder dataset harga tidak ada: {src} (atur BROKSUM_DIR).")
    own = json.loads(OWN.read_text(encoding="utf-8"))
    dates = sorted({m["asOf"] for m in own["months"] if m.get("asOf")})
    tickers = {c["t"] for c in own["companies"]}
    wanted = [date.fromisoformat(d) for d in dates]
    data = {"format": 1, "source": "Stockbit, dataset broker summary riset (Close 1D)",
            "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "d": dates, "c": {}}
    for path in sorted(src.glob("stockbit_*_metrics.csv")):
        m = FILE.fullmatch(path.name)
        if not m or m.group(1) not in tickers:
            continue
        prices = closes(path, wanted)
        if any(p is not None for p in prices):
            data["c"][m.group(1)] = prices
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    tmp.replace(OUT)
    print(f"Harga: {len(data['c'])} emiten, {len(dates)} tanggal snapshot ({dates[0] if dates else '-'} s/d {dates[-1] if dates else '-'}) -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    sys.exit(main())
