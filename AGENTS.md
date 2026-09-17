# AGENTS.md

Baca **README.md** dulu. Di sana ada cara kerja, cara build, dan cara host ulang situs arsip ini.

Ringkas:
- Sumber: `needtobeindexed/` (nama file `stockbit_YYYYMMDD.md` / `ki_YYYYMMDD.md`). Generator: `build.py` (Python stdlib saja).
- Build: `python3 build.py`, hasil di `site/`. Folder itu hasil build: jangan diedit manual, dan folder dihapus total tiap build.
- Setelah build, cek baris output (kategori + tanggal tiap file) sebelum deploy.
- Jangan ubah isi file di `needtobeindexed/`, karena itu arsip riset milik user.
  Pengecualian: `needtobeindexed/idx-signal-desk/` dikelola `tools/sync_idx.py` (salinan dari IDX Signal Desk lokal). Jangan edit manual; jalankan skripnya.
