"""A fixed set of archive sources covering every naming rule and the Markdown viewer's layouts, built with build.py.

Used by tests/test_build_golden.py (golden snapshot) and tests/doc_viewer.cjs (DOM), never the real archive.
CLI: python3 -B tests/helpers/doc_fixture.py OUT_DIR  ->  OUT_DIR/sources and OUT_DIR/site; prints the site path.
"""
from datetime import datetime
import os
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_fixture import build, build_site  # noqa: E402

MTIME = datetime(2026, 10, 1, 12).timestamp()  # the date of names without one (fallback; avoid in real names)

# (file name, category, start, end, label): the naming table in README/AGENTS, checked through build.main().
RULES = [
    ("sbringkas_2026-10-05_2026-10-05.md", "stockbit-ringkasan", "2026-10-05", "2026-10-05", "5 Oktober 2026"),
    ("sbdetail_2026-10-05_2026-10-05.md", "stockbit-detail", "2026-10-05", "2026-10-05", "5 Oktober 2026"),
    ("sbpekan_2026-09-28_2026-10-04.md", "stockbit-pekan", "2026-09-28", "2026-10-04", "28 September–4 Oktober 2026"),
    ("beiringkas_2026-10-05_2026-10-05.md", "bei-ringkasan", "2026-10-05", "2026-10-05", "5 Oktober 2026"),
    ("beidetail_2026-10-05_2026-10-05.md", "bei-detail", "2026-10-05", "2026-10-05", "5 Oktober 2026"),
    ("beipekan_2026-09-28_2026-10-04.md", "bei-pekan", "2026-09-28", "2026-10-04", "28 September–4 Oktober 2026"),
    ("stockbit_01092026.md", "stockbit", "2026-09-01", "2026-09-01", "1 September 2026"),            # DDMMYYYY
    ("stockbit_05102026.md", "stockbit", "2026-10-05", "2026-10-05", "5 Oktober 2026"),  # chat: covered by sbringkas
    ("ki_20260915.md", "keterbukaan-informasi", "2026-09-15", "2026-09-15", "15 September 2026"),    # YYYYMMDD
    # One date in the name, a range starting there in the opening text: the range wins.
    ("ki_22092026.md", "keterbukaan-informasi", "2026-09-22", "2026-09-24", "22–24 September 2026"),
    # Two full dates are used as written, even when the text names another period.
    ("stockbit_ki_review_2026-09-05_2026-09-10.md", "stockbit", "2026-09-05", "2026-09-10", "5–10 September 2026"),
    ("stockbit_review_2026-09-13_14.html", "stockbit", "2026-09-13", "2026-09-14", "13–14 September 2026"),
    ("Analisis_Stockbit_25-31_Agustus_2026.md", "stockbit", "2026-08-25", "2026-08-31", "25–31 Agustus 2026"),
    ("pemeriksaan_55_emiten_14_September_2026.md", "keterbukaan-informasi", "2026-09-14", "2026-09-14", "14 September 2026"),
    # Month-only names: the exact range from the opening text, else the whole months.
    ("Laporan_Stockbit_Agustus_September_2026.md", "stockbit", "2026-08-01", "2026-09-05", "1 Agustus–5 September 2026"),
    ("Arsip_Stockbit_Juli_2026.md", "stockbit", "2026-07-01", "2026-07-31", "Juli 2026"),
    ("asx_20260913.md", "keterbukaan-australia", "2026-09-13", "2026-09-13", "13 September 2026"),
    ("sgx_29092026.md", "keterbukaan-singapura", "2026-09-29", "2026-09-29", "29 September 2026"),
    ("sgx_january-20september2026.md", "keterbukaan-singapura", "2026-09-20", "2026-09-20", "20 September 2026"),
    ("keterbukaan_sg_20092026_semua_kode.csv", "keterbukaan-singapura", "2026-09-20", "2026-09-20", "20 September 2026"),
    ("digest_2026-10-01_2026-10-02.md", "digest-emiten", "2026-10-01", "2026-10-02", "1–2 Oktober 2026"),
    ("catatan_bebas.md", "lainnya", "2026-10-01", "2026-10-01", "1 Oktober 2026"),                  # mtime fallback
]
BODIES = {
    # The Markdown viewer (tests/doc_viewer.cjs): H2 contents, numbered issuer sections with a numbered subsection,
    # "Label: isi" facts, a three-date schedule.
    "ki_22092026.md": ("# KI scan\n\nDigest periode 22–24 September 2026, mencakup 60 perusahaan.\n\n## Temuan utama\n\n"
                       "### 1. FORU — Rencana rights issue\n\nStatus: rencana.\n\nNilai: Rp20,8 triliun.\n\n"
                       "15 Oktober 2026: RUPS. 17 Oktober 2026: cum date. 20 Oktober 2026: pembayaran.\n\n"
                       "### 2.1 ESTA — Perubahan pengendali\n\nPembeli belum diumumkan.\n\n## Batas bukti\n\nHanya digest.\n"),
    # Sections divided by "#": the contents come from H1, "# 2. DOOH" is an issuer.
    "asx_20260913.md": "# ASX 13 September\n\n# 1. Ringkasan\n\nDua emiten.\n\n# 2. DOOH\n\nKontrak baru DOOH.\n",
    "stockbit_ki_review_2026-09-05_2026-09-10.md": "# Review\n\nPeriode 1–12 September 2026 tidak dipakai.\n",
    "Laporan_Stockbit_Agustus_September_2026.md": "# Laporan\n\nArsip 1 Agustus–5 September 2026 dari Stockbit Ideas.\n",
    "stockbit_review_2026-09-13_14.html": ("<!doctype html><html><head><title>Review</title><script>const records=[{\"summary\":\"SOCI kapal\"}]"
                                           "</script></head><body><header><h1>Review Stockbit</h1><p>Ringkasan dua hari diskusi.</p></header>"
                                           "<table><tr><th>Kode</th><th>Isi</th></tr><tr><td>SOCI / BULL</td><td>x</td></tr></table></body></html>"),
    "keterbukaan_sg_20092026_semua_kode.csv": "kode,nama\nD05,DBS\nO39,OCBC\n",
    "sbringkas_2026-10-05_2026-10-05.md": ("# Ringkasan Stockbit Ideas · 5 Oktober 2026\n\nKlaim pengguna, belum diverifikasi, bukan rekomendasi.\n\n"
                                           "## SOCI\n\nRencana kapal baru dibahas 12 akun.\n\n## BULL\n\nRumor akuisisi.\n"),
    "beidetail_2026-10-05_2026-10-05.md": ("# Detail BEI · 5 Oktober 2026\n\n## ESTA\n\nPT Esta Indonesia Tbk (ESTA) mengumumkan rencana "
                                           "rights issue 500 juta saham.\n\nTanggal RUPS: 15 Oktober 2026.\n\n"
                                           "15 Oktober 2026: RUPS. 17 Oktober 2026: cum date. 20 Oktober 2026: pembayaran.\n"),
    "sbdetail_2026-10-05_2026-10-05.md": (
        "# Detail temuan Stockbit Ideas · 5 Oktober 2026\n\nCakupan: 3/3 posting utama diberi disposisi · 3 akun · 1 emiten · final\n\n"
        "## FORU\n\nFORU · 2026-10-05 · 3 posting / 3 akun · inti (diskusi pengguna, belum diverifikasi): rights issue jumbo.\n\n"
        "- [Klaim penulis] Rights issue FORU tidak laku, disarankan jual R. — @rujakberkah96 10:49 [pos](https://stockbit.com/post/36297180)"
        " · 1 sumber · celah: tanpa dokumen · 8 balasan (F20261005-0001)\n"
        "- [Hitungan penulis] Sisa HMETD FORU sekitar 3,1 miliar lembar, setara Rp391 miliar. — @OjaIsun 11:33"
        " [pos](https://stockbit.com/post/36300179) · +1 akun (juga: 36300180) · celah: tanpa dokumen (F20261005-0002)\n"
        "- [Rumor] Ada pihak di balik FORU yang akan tender offer. — @santoswah 12:00 [pos](https://stockbit.com/post/36300200)"
        " · 1 sumber · celah: tanpa dokumen (F20261005-0003)\n"),
    "digest_2026-10-01_2026-10-02.md": ("# Digest emiten 1–2 Oktober 2026\n\n## BAJA\n\nPT Saranacentral Bajatama Tbk (BAJA)\n\n"
                                        "- Rights issue: BAJA menerbitkan 1 miliar saham baru dengan HMETD.\n"
                                        "- Risiko: dilusi bila pemegang saham tidak menebus.\n"),
    "pemeriksaan_55_emiten_14_September_2026.md": ("# Pemeriksaan 55 emiten\n\n### 2. EURO — Rights issue\n\n"
                                                   "PT Estee Gold Feet Tbk (EURO) akan melakukan rights issue 2 miliar saham.\n\n"
                                                   "Tidak ada aksi korporasi seperti stock split atau buyback.\n"),
}
# Over EMBED_LIMIT: fetched when opened (lazy), never embedded.
BODIES["ki_20260915.md"] = ("# KI 15 September\n\n### 01. MNCN — Rencana\n\nPerseroan: PT Media Nusantara Citra Tbk.\n\n"
                            + "Catatan panjang. " * 16000 + "\n")


def body(name):
    return BODIES.get(name, f"# {Path(name).stem}\n\nIsi dokumen {name} untuk uji build, dengan kode SOCI.\n")


def write_sources(src):
    src.mkdir(parents=True, exist_ok=True)
    for name, *_ in RULES:
        (src / name).write_text(body(name), encoding="utf-8")
        os.utime(src / name, (MTIME, MTIME))


def build_fixture(base):
    """Sources in base/sources, site in base/site with a fixed BUILD_ID; returns (site, stdout)."""
    src, out = Path(base) / "sources", Path(base) / "site"
    write_sources(src)
    with patch.object(build, "BUILD_ID", "20261001120000"):
        stdout, _ = build_site(src, out, base_url="https://arsip.test")
    return out, stdout


if __name__ == "__main__":
    print(build_fixture(sys.argv[1])[0])
