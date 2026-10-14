"""Tiny BEI + Stockbit archive fixture for build/viewer tests: temporary sources only, never the real archive.

CLI (used by tests/bei_viewer.cjs): python3 -B tests/helpers/bei_fixture.py OUT_DIR
builds OUT_DIR/sources (fixture) and OUT_DIR/site (build output) with hostile strings in bei-index.json.
"""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
for extra in (ROOT, ROOT / "tests" / "helpers"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))
import build  # noqa: E402
import stockbit_fixture  # noqa: E402

EVIL = stockbit_fixture.EVIL


def ringkas_md(day_label, extra=""):
    return "\n".join([
        f"# Ringkasan keterbukaan BEI · {day_label}", "",
        "Cakupan: 12 pengumuman · 5 emiten · 4 non-rutin · 8 rutin · 0 koreksi · terakhir 17:59 · final", "",
        "Ringkasan otomatis dari pengumuman resmi di idx.co.id; bukan rekomendasi. Angka dikutip dari dokumen emiten dan belum diaudit ulang.", "",
        "## Sorotan", "", "- BBCA: panggilan RUPS untuk rencana rights issue.", "",
        "## Yang berubah dari progres sebelumnya", "",
        "| Emiten | Sebelumnya | Hari ini | Tahap | Berikutnya |", "|---|---|---|---|---|",
        "| BBCA | 01/10 rencana | panggilan RUPS | panggilan RUPS | RUPS 30/10 |", "",
        "### BBCA — Bank Central Asia Tbk", "",
        "Status: lanjutan · Sebelumnya rencana rights issue (1/10); hari ini panggilan RUPS.", "",
        "- 09:12 · Panggilan RUPS · [pengumuman](https://www.idx.co.id/x.pdf) · 202610050001", "",
        "### BREN — Barito Renewables Energy Tbk", "",
        "Status: baru · Hari ini: rencana akuisisi.", "",
        "## Emiten lain", "", "- TOBA · TBS Energi Utama Tbk · 1 pengumuman · baru · paparan publik", "",
        "- MEJA · Harta Djaya Karya Tbk · 1 pengumuman · baru · perubahan pengurus", "",
        "## Laporan rutin", "", "8 laporan registrasi: TLKM, ASII.", "", extra]) + "\n"


# Full "Yang berubah" sentences as the desk detail writes them (md_inline escapes, other codes in lower case); the
# index rows below carry their shortened form. Used by the "selengkapnya" checks of tests/bei_viewer.cjs.
EPAC_FULL = ("Sebelumnya (28/09): rencana PMHMETD I hingga 2.000.000.000 saham dan buyback maksimum Rp20.000.000.000, "
             "RUPSLB 3 November 2026; hari ini: pemanggilan RUPSLB 3 November 2026 pukul 10.00 WIB \\[agenda 1\\-5\\] "
             "dan bukti iklan panggilan, mitra bbca disebut.")
SB_EPAC_FULL = ("Diskusi EPAC berpusat pada rights issue (rasio 1:2, harga Rp100 menurut brief), harga turun ke 4830, dan "
                "perdebatan dividend trap. Juga dibahas buyback Rp8 triliun serta klaim akumulasi asing.")


def detail_md(day_label, epac=False, evil=False):
    """A beidetail file in the desk's real layout ("## KODE — Nama", status line, "Kesinambungan (…): …")."""
    lines = [
        f"# Detail keterbukaan BEI · {day_label}", "",
        "Cakupan: 12 pengumuman · 5 emiten · 4 non-rutin · 8 rutin · 0 koreksi · terakhir 17:59 · final", "",
        "Ringkasan otomatis dari pengumuman resmi di idx.co.id; bukan rekomendasi.", "",
        "## Ikhtisar emiten", "", "- EPAC · lanjutan · 2 pengumuman non-rutin", "- BBCA · lanjutan", "",
        "## BBCA — Bank Central Asia Tbk", "", "Status: lanjutan", "",
        "Kesinambungan (disusun kode): Sebelumnya rencana rights issue (05/10); hari ini panggilan RUPS.", "",
        "### Hari ini", "", "- 09:12 · Panggilan RUPS", "",
        "## BREN — Barito Renewables Energy Tbk", "", "Status: baru", ""]
    if epac:
        lines += ["## EPAC — PT Megalestari Epack Sentosaraya Tbk", "",
                  "Status: lanjutan (juga: jadwal) · tahap: keterbukaan/prospektus → panggilan RUPS (naik) · 2 pengumuman "
                  "non-rutin", "",
                  "Kesinambungan (kalimat LLM tervalidasi): " + EPAC_FULL + (EVIL if evil else ""), "",
                  "**Hari ini**", "",
                  "- 14:32 · Pemanggilan Rapat Umum Pemegang Saham Luar Biasa · [pengumuman](https://www.idx.co.id/x.pdf)",
                  "  - Ringkasan: Kesinambungan (palsu): bukan baris kesinambungan.", ""]
    lines += ["## Lampiran", "", "- EPAC 14:32 · Pemanggilan RUPS", ""]
    return "\n".join(lines) + "\n"


def sbdetail_md(day_label, evil=False):
    """An sbdetail file in the desk's real layout: "## KODE", line 1 with the inti, "Perkembangan:", bullets."""
    return "\n".join([
        f"# Detail temuan Stockbit Ideas · {day_label}", "",
        "Cakupan: 1.603/1.603 posting utama diberi disposisi · 312 akun · 41 emiten · final", "",
        "## Ikhtisar emiten", "", "- EPAC · 47 posting / 42 akun · 3 temuan", "",
        "## BBCA", "",
        "BBCA · 2026-10-05 · 14 posting / 9 akun · bahan: 2 rumor · inti (diskusi pengguna, belum diverifikasi): contoh.", "",
        "- [Rumor] klaim contoh — @GoldenDirt 09:12 [pos](https://stockbit.com/post/123) (F20261005-0001)", "",
        "## EPAC", "",
        "EPAC · 2026-10-05 · 47 posting / 42 akun · bahan: 1 keterbukaan, 2 klaim (3 akun) · inti (diskusi pengguna, "
        "belum diverifikasi): " + SB_EPAC_FULL + (EVIL if evil else ""), "",
        "Perkembangan: Dari kekhawatiran target turun, kini lebih optimis. · target harga Rp4400 → Rp5000 (vs 2 Okt)", "",
        "- [Klaim penulis] Pengguna menyebut inti (diskusi pengguna, belum diverifikasi): bukan baris inti. — @a 09:45 "
        "[pos](https://stockbit.com/post/1) (F20261005-0009)", "",
        "Terkait: BBCA", "",
        "## Disebut tanpa temuan", "", "| Kode | Posting |", "|---|---|", "| TLKM | 3 |", ""]) + "\n"


def index_json(evil=False):
    bad = EVIL if evil else ""
    return {
        "format": 1, "generated_at": "2026-10-07T00:00:00+07:00",
        "days": [
            {"d": "2026-10-05", "f": "beiringkas_2026-10-05_2026-10-05.md", "detail": "beidetail_2026-10-05_2026-10-05.md",
             "k": "final", "n": 12, "nonroutine": 4, "emiten": 5, "sha": "a" * 64},
            {"d": "2026-10-06", "f": "beiringkas_2026-10-06_2026-10-06.md", "detail": "beidetail_2026-10-06_2026-10-06.md",
             "k": "final" if not evil else "sementara" + bad, "n": 9, "nonroutine": 3, "emiten": 4, "sha": "b" * 64},
        ],
        "tickers": {
            # Baris[8] = petunjuk bagian ringkasan dari desk (true = blok ### KODE, false = satu baris di "Emiten lain").
            "BBCA": [[0, 1, 1, "baru", "rencana", "Hari ini: rencana rights issue.", {"Aksi korporasi": 1}, ["202610050001"], True],
                     [1, 3, 2, "lanjutan" + bad, "panggilan RUPS" + bad,
                      "Sebelumnya rencana rights issue (05/10); hari ini panggilan RUPS." + bad,
                      {"Aksi korporasi": 2, "Laporan rutin": 1, **({bad: 4} if evil else {})}, ["202610060001", bad], "bbca"]],
            # Tanpa petunjuk (indeks desk lama): tanggal menuju detail.
            "BREN": [[1, 1, 1, "baru", "rencana", "Hari ini: rencana akuisisi.", {"Akuisisi": 1}, ["202610060002"]]],
            "TOBA": [[1, 1, 1, "baru", "paparan publik", "Hari ini: paparan publik.", {"Paparan publik": 1}, ["202610060004"], False]],
            "MEJA": [[1, 1, 1, "baru", "", "Hari ini: perubahan pengurus.", {}, ["202610060005"],
                      bad or {"s": "emiten-lain"}]],
            "ASII": [[1, 1, 0, "rutin", "", "", {"Laporan rutin": 1}, ["202610060003"]]],
            # "Yang berubah" shortened by the desk (10th element 1) / by an older desk (trailing "…", no flag; the
            # 05/10 detail has no EPAC section, so the full text falls back to a link).
            "EPAC": [[1, 2, 2, "lanjutan", "panggilan RUPS",
                      "Sebelumnya (28/09): rencana PMHMETD I hingga 2.000.000.000 saham dan buyback maksimum "
                      "Rp20.000.000.000, RUPSLB 3 November 2026…" + bad, {"Aksi korporasi": 2}, ["202610060006"], "epac", 1],
                     [0, 1, 1, "baru", "rencana", "Hari ini: rencana PMHMETD I hingga 2.000.000.000 saham…",
                      {"Aksi korporasi": 1}, ["202610050006"], "epac"]],
            # Bentuk rusak: baris tanpa hari valid diabaikan viewer.
            **({"ZZZZ": [[99, 1, 1, "baru", "", "x", {}, []], "bukan baris", None]} if evil else {}),
        },
        "names": {"BBCA": "Bank Central Asia Tbk" + bad, "BREN": "Barito Renewables Energy Tbk", "ASII": "Astra International Tbk"},
    }


def write_fixture(src, evil=False, with_index=True, with_stockbit=True):
    if with_stockbit:
        stockbit_fixture.write_fixture(src, evil=evil)
        (src / "sbdetail_2026-10-05_2026-10-05.md").write_text(sbdetail_md("5 Oktober 2026", evil), encoding="utf-8")
        sb_index = src / "idx-signal-desk" / "stockbit-index.json"
        data = json.loads(sb_index.read_text(encoding="utf-8"))
        # Inti shortened by the desk (8th element 1, 7th null: no pk) and an older unflagged "…" row whose detail
        # (20/09) has no EPAC section.
        data["tickers"]["EPAC"] = [
            [1, 47, 42, 3, "Diskusi EPAC berpusat pada rights issue (rasio 1:2, harga Rp100 menurut brief), harga turun "
                           "ke 4830…", {"D": 1, "C": 2}, None, 1],
            [0, 5, 4, 1, "Rumor rights issue EPAC…", {"R": 1}],
        ]
        sb_index.write_text(json.dumps(data), encoding="utf-8")
    else:
        (src / "ki_05102026.md").write_text("# Keterbukaan 5 Oktober\n\nPemeriksaan keterbukaan informasi emiten pada hari itu secara lengkap.\n",
                                            encoding="utf-8")
    files = {
        "beiringkas_2026-10-05_2026-10-05.md": ringkas_md("5 Oktober 2026"),
        "beiringkas_2026-10-06_2026-10-06.md": ringkas_md("6 Oktober 2026", f"Catatan {EVIL if evil else ''}."),
        "beiringkas_2026-09-20_2026-09-20.md": ringkas_md("20 September 2026"),
        "beidetail_2026-10-05_2026-10-05.md": detail_md("5 Oktober 2026"),
        "beidetail_2026-10-06_2026-10-06.md": detail_md("6 Oktober 2026", epac=True, evil=evil),
        "beipekan_2026-09-28_2026-10-04.md": "# BEI mingguan 28 September–4 Oktober 2026\n\nRekap mingguan keterbukaan BEI tanpa LLM untuk pekan ini.\n",
    }
    desk = src / "idx-signal-desk"
    desk.mkdir(exist_ok=True)
    for name, text in files.items():
        (desk / name).write_text(text, encoding="utf-8")
    (desk / "digest_2026-10-01_2026-10-02.md").write_text(
        "# Digest emiten IDX · 1–2 Oktober 2026\n\n## BBCA\n\nDigestkhusus lama yang dipensiunkan, tetap terbuka lewat tautan lama.\n",
        encoding="utf-8")
    if with_index:
        (desk / "bei-index.json").write_text(json.dumps(index_json(evil)), encoding="utf-8")


def build_site(src, out, base_url="https://arsip.test"):
    """Run build.main() against the fixture; returns (stdout, stderr)."""
    stdout, stderr = io.StringIO(), io.StringIO()
    with patch.multiple(build, SRC=src, OWN_SRC=src / "missing.json", SB_INDEX_SRC=src / "idx-signal-desk" / "stockbit-index.json",
                        BEI_INDEX_SRC=src / "idx-signal-desk" / "bei-index.json", BASE_URL=base_url, CHAT_API_URL="/api/chat"), \
            patch.object(sys, "argv", ["build.py", "--out", str(out)]), \
            redirect_stdout(stdout), patch.object(sys, "stderr", stderr):
        build.main()
    return stdout.getvalue(), stderr.getvalue()


if __name__ == "__main__":
    base = Path(sys.argv[1])
    src, out = base / "sources", base / "site"
    src.mkdir(parents=True, exist_ok=True)
    write_fixture(src, evil=True, with_stockbit="--no-stockbit" not in sys.argv)
    build_site(src, out)
    print(out)
