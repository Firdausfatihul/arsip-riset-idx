# AGENTS.md

Baca **README.md** dulu. Di sana ada cara kerja, cara build, dan cara host ulang situs arsip ini.

Ringkas:
- Sumber: `needtobeindexed/` (nama file `stockbit_YYYYMMDD.md` / `ki_YYYYMMDD.md`). Generator: `build.py` (Python stdlib saja).
- Build: `python3 build.py`, hasil di `site/`. Folder itu hasil build: jangan diedit manual, dan folder dihapus total tiap build.
- Setelah build, cek baris output (kategori + tanggal tiap file) sebelum deploy.
- Jangan ubah isi file di `needtobeindexed/`, karena itu arsip riset milik user.
  Pengecualian: `needtobeindexed/idx-signal-desk/` dikelola `tools/sync_idx.py` (salinan dari IDX Signal Desk lokal). Jangan edit manual; jalankan skripnya.
  `needtobeindexed/harga/harga.json` dibuat `tools/sync_prices.py` dari dataset broksum lokal. Jangan edit manual; jalankan skripnya.

## Invarian keamanan (tetap berlaku)

Diringkas dari audit 20 September 2026 (`SECURITY_REVIEW.md` dan `reports/security-audit-web-2026-09-20.md`, kini hanya di
riwayat git). Jangan dilonggarkan tanpa alasan tertulis; uji serangan hanya offline (`tests/security.mjs`,
`tests/web_security.cjs`, `tests/test_sync_security.py`), tidak pernah flood/payload ke situs publik.

- Chat: browser tidak bisa mengirim riwayat, model, URL, dokumen, atau pengaturan token. Riwayat ditulis server (tiga pertukaran
  ringkas, 1 jam, terikat hash IP, maks 20 giliran) dan dirujuk token acak 256 bit. Pertanyaan ≤600 karakter (normalisasi
  Unicode, kontrol tak terlihat dibuang), body ≤4 KB JSON, unggahan ≤5 detik, maks 4 unggahan bersamaan.
- Batas byte/token/panggilan per analisis dan anggaran harian dicadangkan sebelum setiap panggilan model dan disimpan di SQLite
  (bertahan setelah restart). Model tanpa shell/berkas; mode agen hanya alat baca-saja dengan host/path tetap dari server;
  secret tidak pernah masuk prompt atau ke browser.
- Pencarian: hanya own-property berupa array yang menjadi posting (kata seperti `constructor` aman); peta tanpa prototype.
- Render: jawaban model dan Markdown arsip lewat allowlist tag/atribut dan validasi URL sebelum dipasang ke DOM (style, form,
  SVG, media, event handler dibuang). marked/DOMPurify versi dikunci dengan SRI SHA-384; CSP meta memakai hash skrip hasil build.
  JSON tertanam meng-escape `<`, `>`, `&`. Laporan HTML lama di iframe `srcdoc` dengan `sandbox="allow-scripts allow-popups"`,
  tanpa `allow-same-origin`.
- Statistik: teks pertanyaan yang lolos validasi disimpan 365 hari dengan hash klien; tanpa IP mentah, riwayat model, atau key.
  Laporan HTML meng-escape teks; ekspor hanya di `reports/private/` (diabaikan Git).
- Build/sinkron: sumber atau tujuan symlink ditolak, tujuan build harus folder hasil build; sinkron menulis lewat staging
  (berkas sementara acak, `os.replace`) dan memeriksa profil/perubahan bersamaan sebelum commit. Data kepemilikan divalidasi
  skema/tipe/batas sebelum dirender.
- Batas yang diakui: prompt injection masih dapat memengaruhi isi jawaban; ini bukan penetration test; sinkron multi-berkas tidak
  atomik terhadap mati listrik/SIGKILL.
