"""Tiny Stockbit archive fixture for build/viewer tests: temporary sources only, never the real archive.

CLI (used by tests/stockbit_viewer.cjs): python3 -B tests/helpers/stockbit_fixture.py OUT_DIR
builds OUT_DIR/sources (fixture) and OUT_DIR/site (build output) with a hostile stockbit-index.json.
"""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
import build  # noqa: E402

EVIL = '<img src=x onerror="window.pwned=1">'


def day_md(day_label, codes, extra=""):
    parts = [f"# Ringkasan Stockbit Ideas · {day_label}", "",
             "Cakupan: 1.603/1.603 posting utama diberi disposisi · 312 akun · 41 emiten · final", "",
             "Klaim pengguna, belum diverifikasi, bukan rekomendasi.", ""]
    for code in codes:
        parts += [f"## {code}", "",
                  f"{code} · 14 posting / 9 akun · inti (diskusi pengguna, belum diverifikasi): contoh.", "",
                  f"- [Rumor] klaim contoh — @GoldenDirt 09:12 [pos](https://stockbit.com/post/123) (F20261005-0001)", ""]
    parts += ["## Disebut tanpa temuan", "", "| Kode | Posting |", "|---|---|", "| TLKM | 3 |", "", extra]
    return "\n".join(parts) + "\n"


def index_json(evil=False):
    bad = EVIL if evil else ""
    return {
        "format": 1, "generated_at": "2026-10-06T00:00:00",
        "days": [
            {"d": "2026-09-20", "f": "sbringkas_2026-09-20_2026-09-20.md", "detail": "sbdetail_2026-09-20_2026-09-20.md",
             "k": "final", "n": 900, "classified": 900, "unreviewed": 0, "findings": 20, "accounts": 300, "sha": "a" * 64},
            {"d": "2026-10-05", "f": "sbringkas_2026-10-05_2026-10-05.md", "detail": "sbdetail_2026-10-05_2026-10-05.md",
             "k": "final" if not evil else "sementara" + bad, "n": 1603, "classified": 1603, "unreviewed": 0,
             "findings": 41, "accounts": 312, "sha": "b" * 64},
        ],
        "tickers": {
            "BBCA": [[1, 14, 9, 3, "inti BBCA" + bad, {"R": 2, "C": 1, **({bad: 4} if evil else {})}],
                     [0, 5, 4, 1, "inti lama", {"A": 1}]],
            "TLKM": [[1, 3, 3, 0, "", {}]],
        },
        "users": {
            "GoldenDirt": [[1, 11, ["BBCA", *( [bad] if evil else [])], ["F20261005-0001", *([bad] if evil else [])]],
                           [0, 2, ["BBCA"], ["F20260920-0003"]]],
            **({bad: [[1, 1, ["BBCA"], ["F20261005-0002"]]]} if evil else {}),
        },
        "user_notes": {
            "GoldenDirt": {"penilaian": {"text": "Argumen bersandar pada satu sumber tanpa dokumen." + bad,
                                         "finding_ids": ["F20261005-0001", "F20260920-0003", *([bad] if evil else [])]},
                           "window": "2026-09-20 s/d 2026-10-05" + bad},
        },
    }


def write_fixture(src, evil=False, with_index=True):
    files = {
        "stockbit_05102026.md": "# Laporan Stockbit lama\n\nPenelusuran lama dengan kursor lama yang belum lengkap sama sekali.\n\n### BBCA\n\nisi\n",
        "ki_05102026.md": "# Keterbukaan 5 Oktober\n\nPemeriksaan keterbukaan informasi emiten pada hari itu secara lengkap.\n",
        "sbringkas_2026-10-05_2026-10-05.md": day_md("5 Oktober 2026", ["BBCA"], f"Catatan {EVIL if evil else ''} dari @Evil_Handle."),
        "sbringkas_2026-09-28_2026-09-28.md": day_md("28 September 2026", ["BBCA"]),
        "sbringkas_2026-09-20_2026-09-20.md": day_md("20 September 2026", ["BBCA"]),
        "sbdetail_2026-10-05_2026-10-05.md": day_md("5 Oktober 2026", ["BBCA"]).replace("Ringkasan", "Detail"),
        "sbdetail_2026-09-20_2026-09-20.md": day_md("20 September 2026", ["BBCA"]).replace("Ringkasan", "Detail"),
        "sbpekan_2026-09-28_2026-10-04.md": "# Stockbit mingguan 28 September–4 Oktober 2026\n\nRekap mingguan dari ringkasan harian tanpa LLM untuk pekan ini.\n",
    }
    for name, text in files.items():
        (src / name).write_text(text, encoding="utf-8")
    if with_index:
        (src / "idx-signal-desk").mkdir(exist_ok=True)
        (src / "idx-signal-desk" / "stockbit-index.json").write_text(json.dumps(index_json(evil)), encoding="utf-8")


def build_site(src, out, base_url="https://arsip.test"):
    """Run build.main() against the fixture; returns (stdout, stderr)."""
    stdout, stderr = io.StringIO(), io.StringIO()
    with patch.multiple(build, SRC=src, OWN_SRC=src / "missing.json", SB_INDEX_SRC=src / "idx-signal-desk" / "stockbit-index.json",
                        BASE_URL=base_url, CHAT_API_URL="/api/chat"), \
            patch.object(sys, "argv", ["build.py", "--out", str(out)]), \
            redirect_stdout(stdout), patch.object(sys, "stderr", stderr):
        build.main()
    return stdout.getvalue(), stderr.getvalue()


if __name__ == "__main__":
    base = Path(sys.argv[1])
    src, out = base / "sources", base / "site"
    src.mkdir(parents=True, exist_ok=True)
    write_fixture(src, evil=True)
    build_site(src, out)
    print(out)
