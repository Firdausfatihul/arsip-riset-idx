# Arsip Riset IDX

Viewer Markdown, HTML, dan CSV statis untuk arsip riset pasar modal (Stockbit, Keterbukaan Informasi emiten BEI, Australia, dan Singapura, serta data IDX Signal Desk).
File sumber di `needtobeindexed/` tidak diubah. Markdown dan CSV disalin mentah; HTML lama dibungkus dalam iframe terisolasi saat build.
`build.py` hanya membuat halaman daftar dan pencarian, karena static host tidak bisa membaca isi folder.

> Untuk agent (Codex, Claude, dll.): semua yang dibutuhkan untuk membangun ulang dan meng-host ulang ada di file ini.
> Tidak ada dependency Python di luar standard library. Folder `site/` adalah hasil build dan boleh dihapus kapan saja.

---

## TL;DR, kalau site hilang

```bash
cd /path/ke/archivescrapingweb
python3 build.py                 # hasil: site/
python3 -m http.server -d site 8000   # cek di http://localhost:8000
```

Lalu upload **isi** folder `site/` ke host statis mana pun (lihat [Cara host ulang](#cara-host-ulang)).
Untuk pemakaian sendiri dengan akun Claude, situs + chat di Mac ini: `node local/server.mjs` (lihat [Host lokal dengan akun Claude](#host-lokal-dengan-akun-claude-localservermjs)).
Semua di VPS Jakarta (Mac boleh mati), setelah ada dokumen baru: `node local/vps.mjs push` (lihat [Semua di VPS Jakarta](#semua-di-vps-jakarta-localvpsmjs)).
Sumber build: `needtobeindexed/`, `build.py`, `chat.js`, dan `chat.config.json` (alamat API publik).

---

## Struktur

```
archivescrapingweb/
├── needtobeindexed/      # SUMBER: taruh file .md, .html, atau .csv di sini
│   ├── harga/harga.json  # DIBUAT tools/sync_prices.py: harga penutupan per tanggal snapshot KSEI (jangan edit manual)
│   └── idx-signal-desk/  # DISALIN OTOMATIS oleh tools/sync_idx.py (jangan isi manual; isinya ditimpa)
│       ├── kepemilikan.json  # data tab Kepemilikan Saham
│       ├── kepemilikan-laporan.json    # daftar pemegang saham, jenis pemilik BAE, tautan laporan emiten
│       └── kepemilikan-perubahan.json  # laporan perubahan kepemilikan per emiten
├── build.py              # generator (Python 3.9+, stdlib saja)
├── report-frame.js       # pencarian dan navigasi lokal di laporan HTML terisolasi
├── report-shell.js       # pembungkus tepercaya untuk laporan HTML
├── tools/build_safety.py # batas aman sumber dan output build
├── chat.js               # antarmuka percakapan; digabung ke index.html saat build
├── chat.config.json      # alamat API publik; bukan secret
├── worker/               # API Cloudflare Worker + Durable Object
├── local/                # host lokal: Worker yang sama di Node + jembatan Claude Code CLI (akun Claude)
├── tools/build_worker.py # indeks pencarian, bagian sumber, dan indeks emiten untuk Worker
├── tools/evidence_index.py # pemisahan sumber tanpa AI, dengan lokasi dan hash isi
├── tools/event_index.py  # tabel aksi korporasi per emiten tanpa AI (events.json) untuk pertanyaan screening
├── tools/archive_tables.py # tabel klaim Stockbit, sebutan lintas emiten, nama, cek rumor, cakupan (tanpa AI) untuk chat
├── tools/compare_chat_costs.mjs # pembanding alur lama/baru, simulasi atau API nyata
├── tools/chat_metrics.py # laporan biaya aktual melalui endpoint privat
├── tools/publish_chat.py # LAMA, manual: deploy Worker Cloudflare + docs/ (tidak dipakai desk/publish_stockbit)
├── tools/chat_archive.py # pembaca arsip dan pemisah teks untuk build Worker (Python 3.9+, stdlib)
├── tools/sync_idx.py     # salin data dari IDX Signal Desk lokal (http://127.0.0.1:8787) lalu build
├── tools/sync_prices.py  # harga penutupan per tanggal snapshot KSEI dari dataset broker summary riset → needtobeindexed/harga/harga.json
├── README.md             # file ini
├── AGENTS.md / CLAUDE.md # penunjuk ke README ini untuk agent
└── site/                 # HASIL BUILD, jangan diedit manual, dihapus & dibuat ulang tiap build
    ├── index.html        # aplikasi viewer + daftar dokumen + isi .md/.csv ≤256 KB tertanam (JSON)
    ├── files/<kategori>/<YYYY-MM-DD>/<nama-asli>.md   # salinan mentah (.csv juga)
    ├── files/kepemilikan/kepemilikan.json            # salinan data kepemilikan, diambil viewer saat tab dibuka
    ├── files/kepemilikan/kepemilikan-laporan.json    # daftar pemegang laporan emiten, diambil saat satu emiten dibuka
    ├── files/kepemilikan/kepemilikan-perubahan.json  # laporan perubahan, diambil saat satu emiten dibuka
    ├── files/kepemilikan/harga.json                  # harga penutupan per snapshot KSEI, dimuat bersama data kepemilikan
    ├── robots.txt
    ├── sitemap.xml       # hanya dibuat kalau BASE_URL di-set
    └── .nojekyll         # supaya GitHub Pages tidak memproses folder
```

## Konvensi nama file

| Pola nama | Kategori |
|---|---|
| `stockbit_YYYYMMDD.md` | Stockbit |
| `ki_YYYYMMDD.md` | Analisis KI (legacy): arsip lama, tanpa tombol sumber, tetap dibangun dan bisa dicari |
| `idx-signal-desk/beiringkas_<tgl>_<tgl>.md` / `beidetail_…` / `beipekan_<senin>_<minggu>.md` | Indonesia (BEI): ringkasan, detail, dan rekap pekan keterbukaan BEI (dibuat `tools/sync_idx.py --bei-only`) |
| `digest_YYYY-MM-DD_YYYY-MM-DD[_HHMM-HHMM].md` | Digest Emiten (dipensiunkan: tidak tampil di daftar/tombol, tidak masuk chat; `#doc=` lama tetap jalan) |
| `asx_YYYYMMDD.md` | Keterbukaan Informasi Australia (tanggal potret riset) |
| `sgx_YYYYMMDD.md` / `sgx_january-20september2026.md` | Keterbukaan Informasi Singapura (SGX); file kedua memakai 20 September 2026 sebagai tanggal penyusunan |
| `keterbukaan_sg_DDMMYYYY_*.md` / `.csv` | Keterbukaan Informasi Singapura (SGX), tanggal dari nama file |
| `idx-signal-desk/kepemilikan.json` | bukan dokumen: data tab **Kepemilikan Saham** (dibuat `tools/sync_idx.py`) |
| lainnya | dicocokkan dengan kata kunci (lihat di bawah), kalau tidak cocok masuk **Lainnya** |

Aturan lengkap ada di dict `CATEGORIES` di `build.py`:
- `prefixes`: dicocokkan dengan **kata pertama** nama file (dipisah `_`, `-`, spasi, atau `.`). Contoh: `ki_...` → Keterbukaan Informasi.
- `keywords`: dicocokkan dengan bagian mana pun dari nama file (`stockbit`, `keterbukaan`, `pemeriksaan`, `emiten`, `digest`, `disclosure`).
- Urutan kunci di dict = urutan tampil. Tambah sumber baru cukup dengan menambah entri di sini.

Tanggal dibaca dari nama file, dengan urutan percobaan:
1. `YYYY-MM-DD_YYYY-MM-DD` → `stockbit_ki_review_2026-09-05_2026-09-10` = 5–10 Sep 2026 (dipakai apa adanya, tidak ditafsir ulang dari isi)
2. `YYYY-MM-DD`, opsional rentang hari `_DD` → `stockbit_review_2026-09-13_14` = 13–14 Sep 2026
3. `DD[-DD]_NamaBulan_YYYY` (Indonesia/Inggris, penuh/3 huruf) → `..._14_September_2026`, `Analisis_Stockbit_25-31_Agustus_2026`
   - Tanggal tanpa pemisah di akhir nama juga didukung: `...20september2026` → 20 September 2026. Untuk `sgx_january-20september2026.md`, ini tanggal penyusunan; pembuka dokumen menyebut potret arsip sampai 19 September 2026.
4. `NamaBulan[_NamaBulan]_YYYY` (hanya bulan) → rentang tanggal persis dicari di ±5.000 karakter awal isi dokumen
   (mis. "1 Agustus–5 September 2026"). Kalau tidak ketemu, label jadi "Agustus–September 2026".
5. 8 digit: `YYYYMMDD` → `ki_20260915`, atau `DDMMYYYY` → `stockbit_01092026` (dikenali dari posisi "20xx")
   - Kalau nama hanya menyebut satu tanggal dan awal dokumen menulis rentang yang dimulai di tanggal itu
     (mis. judul "1–5 September 2026"), rentang dari dokumen yang dipakai.
6. Kalau tidak ada, pakai tanggal modifikasi file (mtime). **Hindari ini**, karena tanggalnya bisa berubah setelah file disalin.

## Cara pakai `build.py`

```bash
python3 build.py                                   # output ke ./site
python3 build.py --out docs                        # output ke folder lain (mis. untuk GitHub Pages /docs)
BASE_URL=https://arsip.contoh.com python3 build.py # + <link rel=canonical> dan sitemap.xml absolut
python3 build.py --fragment-index /tmp/artifact/index.html   # versi index tanpa <html>/<head>/<body>, khusus Claude Artifact
```

Folder `--out` dibuat ulang. Build menolak symlink, akar proyek, folder yang beririsan dengan sumber, dan folder berisi data yang tidak dikenali sebagai hasil build arsip. Pemeriksaan ini membantu mencegah salah tujuan; penanda build bukan bukti bahwa semua file di folder boleh dibuang. Jangan arahkan ke folder yang berisi file lain. File `CNAME` yang sudah ada dipertahankan agar domain GitHub Pages tidak hilang.

Output terminal menampilkan satu baris per dokumen: `kategori | tanggal | file sumber -> path di site`.
Cek baris ini untuk memastikan kategori dan tanggal terbaca benar.

## Cara kerja viewer (`site/index.html`)

- **CSV:** taruh file UTF-8 (BOM boleh) di `needtobeindexed/`, lalu build ulang seperti biasa. Contoh `stockbit_20260929.csv` masuk Stockbit tanggal 29 September 2026; nama tanpa kategori yang dikenali masuk **Lainnya**.
  CSV dibuka sebagai tabel yang dapat digeser mendatar, dengan baris pertama sebagai judul kolom dan nama file sebagai judul dokumen. Pemisah koma, titik koma, atau tab dideteksi saat build (koma jika tidak terdeteksi). Tanda kutip, koma dan baris baru di dalam sel didukung. Nilai tetap teks: nol awal, angka panjang, HTML, dan rumus tidak diubah atau dijalankan. Klik judul kolom untuk mengurutkan: kolom angka mulai dari nilai terbesar, kolom teks dari A–Z; klik kedua membalik urutan, klik ketiga kembali ke urutan file. Sel kosong selalu di bawah, dan urutan bertahan saat mencari. Pencarian yang sama menandai teks di tabel; **Unduh CSV asli** mengambil salinan file tanpa perubahan.
- Satu halaman. Metadata semua dokumen, isi `.md`/`.csv` sampai 256 KB (`EMBED_LIMIT`), dan teks `.html` tertanam di
  `<script type="application/json" id="arsip-data">`.
- `.md`/`.csv` di atas 256 KB (digest besar; digest kecil tetap tertanam) **tidak ditanam**: viewer mengambil `files/…`
  dengan `fetch()` saat dokumen dibuka, dan mengambil semuanya (3 sekaligus) saat kotak cari pertama kali diisi ≥2 huruf.
  Selama itu catatan cari menulis "memuat isi N dokumen besar…". Yang gagal dimuat bisa dicoba lagi lewat tombol **Coba lagi**, saat dibuka ulang, atau saat mencari ≥30 detik kemudian.
  Ini jalan di server HTTP dan Claude Artifact. Dari `file://` (dobel klik) dokumen besar tidak bisa dibuka atau dicari; dokumen kecil tetap jalan.
- Library dari CDN (versi dikunci): `marked@15.0.7` (parser Markdown) dan `dompurify@3.4.15` (sanitasi) dari `cdnjs.cloudflare.com`.
  Kalau CDN gagal dimuat, dokumen tetap tampil sebagai teks mentah (`<pre>`).
- Font dari Google Fonts: IBM Plex Sans / Sans Condensed / Mono. Kalau gagal, pakai font sistem.
- Tab di atas: **Dokumen** (daftar dan pembaca) dan **Kepemilikan Saham** (hanya muncul kalau `kepemilikan.json` ada).
- Beranda memakai **tombol sumber + satu daftar**. Tombol selalu tersedia di atas daftar maupun pembaca:
  Stockbit → Stockbit harian → Detail Stockbit → Stockbit mingguan → Indonesia (BEI) → Detail BEI → BEI mingguan → Australia (ASX) → Singapura (SGX)
  (tombol hanya untuk kategori yang punya dokumen). Kategori dengan `"nav": None` tidak punya tombol: **Analisis KI (legacy)**
  (daftarnya tetap ada lewat `#keterbukaan-informasi`, ditautkan dari daftar Indonesia (BEI); selama arsip belum punya ringkasan
  BEI, tombol "Indonesia (BEI)" tetap menunjuk ke daftar ini) dan **Digest Emiten** (`"unlisted": True`: tidak tampil di daftar,
  tidak dihitung atau diambil saat mencari, berkasnya tetap dibangun sehingga tautan `#doc=` lama tetap jalan).
  - Lebar layar ≥768 px: lima tombol satu baris. Di HP: dua kolom, Australia dan Singapura berdampingan di baris kedua; Digest memenuhi baris ketiga.
  - Klik sumber membuka satu daftar sumber itu dan menghapus pencarian. Beranda awal memilih Stockbit. Tautan `#keterbukaan-singapura` langsung membuka SGX.
  - Pencarian tetap **lintas semua sumber**. Saat ada kata pencarian, daftar menampilkan semua sumber yang cocok; tombol sumber tetap terlihat meski tidak ada hasil.
  - Tombol **Hapus pencarian** mengembalikan daftar sumber yang terakhir dipilih. Saat membaca dokumen, kata ditandai dan tersedia tautan ke daftar hasil pencarian.
  - Sidebar daftar ganda dihapus. Area aplikasi dibatasi 1200 px, teks laporan 68 karakter kira-kira per baris, ukuran teks utama 18 px.
  - Daftar isi dapat dibuka/tutup; mula-mula tertutup di bawah 1440 px, terbuka di samping teks mulai 1440 px.
  - Input dan tombol utama setidaknya 44 px tinggi; tombol sumber 52 px. Tabel lebar tetap dapat digeser secara lokal di HP.
  - Warna mengikuti mode terang/gelap perangkat; pembesaran halaman tetap diizinkan. HTML arsip lama tetap memakai desain aslinya di dalam iframe.
- Routing lewat hash: `#doc=files/<kategori>/<tanggal>/<file>.md` dan opsional `&s=<id-bagian>`.
  Contoh: `#doc=files/keterbukaan-informasi/2026-09-14/pemeriksaan_55_emiten_14_September_2026.md&s=foru`
  Halaman emiten: `#emiten=<KODE>` menggabungkan dua bagian dengan label dan disclaimer masing-masing: **Keterbukaan resmi BEI**
  (`files/bei-index/bei-index.json`; tabel Tanggal | Pengumuman | Status/Tahap | Yang berubah | Kategori, tautan ke seksi emiten di
  `beiringkas_`/`beidetail_`, atau ke "Laporan rutin" untuk hari yang hanya berisi laporan rutin; emiten non-rutin memakai petunjuk
  bagian dari desk (baris indeks ke-9: id bagian seperti `emiten-lain`, atau true/false), dan tanpa petunjuk tanggalnya membuka
  `beidetail_` di `## KODE`) di atas, dan **Diskusi Stockbit**
  (`stockbit-index.json`) di bawahnya. Kode yang hanya ada di salah satu indeks tetap punya halaman; indeks yang gagal dimuat
  hanya menampilkan "Coba lagi" di bagiannya. Isi indeks divalidasi saat dimuat dan selalu masuk sebagai teks (DOM), tidak pernah HTML.
  Tab kepemilikan: `#kepemilikan=<KODE>&dari=<YYYY-MM>&sampai=<YYYY-MM>` (kode kosong = daftar semua emiten;
  tanpa `dari` = bulan KSEI pertama, tanpa `sampai` = bulan terakhir). Contoh: `#kepemilikan=BBRI&dari=2026-06`, `#kepemilikan=ADES&dari=2023-05`
- Rapikan otomatis setelah render Markdown:
  - `## Judul` → id slug (`[^a-z0-9]+` → `-`), masuk daftar isi. Kalau dokumen membagi bagian dengan `#` (lebih dari satu H1), daftar isi memakai H1.
  - `### 01. MNCN — Judul`, `### 1. FORU`, `### 2.1 ESTA — Judul`, `### FORU`, atau bagian bernomor `# 2. DOOH` → badge ticker, masuk grid "Emiten" dan pintasan pada kartu daftar. Nomor subbab bertingkat dikenali oleh generator dan pembaca; tautan lama ke judul subbab tetap dapat dibuka.
    Di dokumen tanpa H1 bagian, `## KODE` (format digest Signal Desk) juga jadi emiten, tapi tidak ikut daftar isi.
    Link `&s=foru` dicocokkan ke bagian pertama kode itu.
  - Paragraf `Label: isi` di dalam bagian emiten, atau yang labelnya kode 4 huruf → tabel label/isi (`<dl class="facts">`).
  - Paragraf berisi ≥3 entri `15 September 2026: ... 17 September: ...` → daftar jadwal.
  - Sel tabel yang isinya persis 4 huruf kapital → badge ticker.
- **Kepemilikan Saham** (`files/kepemilikan/kepemilikan.json`, ±3,3 MB, diambil dengan `fetch()` saat tab pertama dibuka;
  `kepemilikan-laporan.json` ±4,4 MB diambil saat emiten pertama dibuka):
  - Sumbu bulan: laporan bulanan emiten sejak Mei 2023 (bulan pertama yang dilaporkan ≥10% emiten), KSEI >1% sejak Feb 2026.
    Bulan sebelum KSEI hanya berisi angka laporan emiten. Rentang awal = bulan KSEI pertama sampai bulan terakhir.
  - Kontrol: cari (Enter membuka kode yang cocok), pilih emiten, **Dari** dan **Sampai** (tanggal file KSEI, atau bulan laporan emiten sebelum KSEI).
  - Tanpa emiten: tabel semua emiten, akumulasi >1% di tanggal Dari dan Sampai, perubahan (poin), jumlah pemegang >1%,
    jumlah pemegang saham (dengan perubahan %), free float resmi (dua yang terakhir dari laporan emiten terakhir sampai Sampai, bulannya ditulis),
    tren kecil. Bisa diurutkan per perubahan akumulasi atau per perubahan jumlah pemegang; 100 baris pertama, lalu "Tampilkan semua".
  - Satu emiten, kartu **Struktur pemegang** (per Sampai, deskriptif, belum diuji terhadap harga; persentil dibanding semua emiten bulan itu): jumlah dan porsi pemegang >1%;
    sisa (100 − akumulasi) dibagi jumlah pemegang terverifikasi (rata-rata % dan rupiah per pihak = lembar rata-rata × harga penutupan di tanggal snapshot;
    tanpa harga, lot); HHI pemegang >1% (setara N pemegang sama besar, terbesar);
    free float resmi vs di luar pemegang >1% (selisih = porsi pemegang 1–5%, tanpa rekening kustodian/nominee); perubahan jumlah pemegang 1/3/6/12 bulan
    (kedua ujung terverifikasi); pola akumulasi/distribusi Dari–Sampai (lembar pemegang >1% yang sama tanpa kustodian ≥ +1 poin dan pemegang ≤ −5%, atau sebaliknya).
  - Satu emiten: kotak angka per tanggal Sampai dibanding Dari; grafik bulanan (akumulasi >1% + pemegang ≥5%, sisa <1% + free float resmi,
    jumlah pemegang), mula-mula menampilkan semua bulan yang punya angka; tombol **Perbesar ke rentang** menampilkan Dari–Sampai plus satu bulan di tiap sisi (pilihan ini berlaku untuk emiten lain sampai halaman dimuat ulang); rentang diarsir; pilih rentang dengan menyeret di chart, atau klik bulan awal lalu bulan akhir (keyboard: panah, Enter dua kali, Esc batal); tombol cepat 1 bln/3 bln/6 bln/1 thn (mundur dari Sampai), Sejak KSEI, Semua;
    batang "siapa menambah, siapa mengurangi" berdasarkan perubahan **lembar saham** antara Dari dan Sampai, dengan perubahan porsi sebagai angka pendamping;
    hanya dibandingkan bila kedua snapshot KSEI tersedia dan lolos validasi. Bulan tanpa data tidak dianggap nol atau tidak berubah.
    Kalau pasangan KSEI tidak tersedia (mis. Dari sebelum Feb 2026), bagian ini menampilkan perubahan antar laporan bulanan emiten
    (pemegang ≥5%, direksi, komisaris; aturan turunan di bawah) dan tautan untuk membandingkan dari snapshot KSEI valid pertama di rentang.
    Pemegang yang hanya tercatat pada satu ujung rentang diberi status tercatat/tidak lagi tercatat >1%, tanpa menganggap jumlah sebelumnya/sesudahnya nol.
    Ini perubahan posisi antara dua tanggal, bukan catatan seluruh transaksi beli/jual. Tabel pemegang >1% tetap menampilkan angka sumber serta tren kecil;
    **daftar pemegang saham (DPS) dari laporan emiten**: pemegang ≥5%/pengendali/afiliasi, direksi dan komisaris dengan lembar dan persen,
    dibanding laporan sebelumnya, plus jumlah pemegang saham dan total saham. Baris yang belum terverifikasi Signal Desk tetap diberi perubahan
    (ditandai "belum terverifikasi") hanya bila: kedua laporan `derivable()` di `tools/sync_idx.py` (versi sepakat, sumber tidak
    diblokir, masalahnya hanya peran "unknown"/total saham tidak tertulis; format laporan 2), kedua baris bukan agregat/nama berulang/bercatatan,
    punya peran, porsinya ≥0,1%, total saham sama di seluruh rentang, dan lembar/persen kedua baris serta seluruh baris ≥1% kedua laporan cocok
    dengan total itu (kurang dari setengah satuan desimal yang tertulis, minimal 2 desimal; laporan tanpa total memakai total laporan terdekat). Data format 1 tidak
    pernah diturunkan. Selain itu tetap "perlu dicek"; **jenis pemilik (laporan BAE)** dengan jumlah pemegang per jenis
    (hanya ±30 emiten yang tabelnya terbaca); **laporan perubahan kepemilikan** (formulir KSEI/IDX dan surat BAE ≥5%, Jul 2023–):
    tanggal, pemegang, lembar/persen sebelum dan sesudah, transaksi, PDF, dan catatan "Perlu dicek" dari audit Signal Desk tanpa mengoreksi angka;
    laporan di rentang Dari–Sampai tampil, sisanya di balik "Di luar rentang"; batas akhir tetap berlaku pada bulan terakhir data KSEI;
    tautan file KSEI dan laporan emiten di IDX.
  - Laporan emiten tidak terbit tiap bulan, jadi angka laporan memakai laporan terakhir sampai Sampai, dibanding laporan terakhir sampai Dari
    (atau laporan paling awal di dalam rentang). Laporan yang ada tetapi tabelnya belum terbaca Signal Desk ditandai, dengan tautan ke PDF-nya.
  - **Pemegang ≥5%**: saham masing-masing pemegang ≥5% (termasuk direksi/komisaris ≥5%, tanpa baris Masyarakat, subtotal, Afiliasi agregat, atau treasuri)
    dibagi total saham laporan emiten; kalau laporan bulan itu tidak terbaca, jumlah baris KSEI ≥5%. Tooltip dan tabel menyebut sumbernya.
    Kalau total saham laporan tidak terbaca (umumnya laporan sebelum April 2026), dipakai jumlah **persen tertulis** pemegang ≥5% yang punya peran
    (`written_blockholders()`, tanpa baris Masyarakat/subtotal/lainnya/treasuri; kosong kalau sumber diblokir, versi bertentangan, nama berulang,
    ada pemegang ≥5% tanpa peran, atau persen bertentangan dengan lembarnya).
    Angka ini tidak dicocokkan ke total saham, jadi ditampilkan sebagai titik kosong tanpa garis penghubung dan ditandai "persen tertulis laporan".
  - Angka terverifikasi memakai aturan `comparable()`/`blockholders()` di `tools/sync_idx.py`: sumber tidak diblokir, versi tidak
    bertentangan, metrik dan baris pemegang lolos validasi, identitas tidak ambigu, dan untuk ≥5% komposisi saham dapat direkonsiliasi.
    Baris kelompok positif yang pembagian per pemegangnya tidak diketahui tidak membuat agregat ≥5% menjadi terverifikasi.
    Nama berulang di laporan emiten dipertahankan, tetapi tidak menghasilkan perubahan jika pasangan barisnya ambigu. Yang belum terverifikasi tetap tampil
    sebagai titik kosong (tidak disambung garis) dan diberi ⚠ di tabel "Lihat angka per bulan".
  - Semua grafik SVG buatan sendiri di `APP_JS`, tanpa library.
  - Pencarian di tab Dokumen: kalau yang dicari persis kode emiten, catatan di bawah kotak cari memberi tautan ke kepemilikannya.
- Pencarian mencocokkan judul, ringkasan, tanggal, nama file, kode saham, **dan isi teks** (tidak peka huruf besar-kecil).
  Jumlah kemunculan tampil di kartu hasil pencarian, dan kata yang dicari ditandai `<mark>` di dokumen yang sedang dibuka.
  - File `.md`/`.csv`: yang dicari isi mentahnya (`content`).
  - File `.html`: yang dicari teks yang tampil (tanpa `<script>`/`<style>`) plus nilai string data JSON di `<script>`
    (mis. `const records=[{"summary": "..."}]`), disimpan sebagai `text` (lihat `html_text()` di `build.py`).
    Penandaan dikirim melalui pesan terbatas ke iframe terisolasi, maksimal 500 kemunculan; pencarian maksimal 128 karakter. Jumlah indeks tetap tersedia jika frame belum merespons.
- HTML lama ditempatkan utuh dalam `srcdoc` dengan `sandbox="allow-scripts allow-popups"`, tanpa `allow-same-origin`. Pembungkus tepercaya menyediakan navigasi kembali dan pesan pencarian. Laporan tidak mendapat akses DOM/storage halaman utama. Tautan tanggal dan salin nomor postingan tetap tersedia; jika clipboard tidak tersedia, nomor tampil sebagai teks yang dapat dipilih.
- CSP melalui meta membatasi skrip ke hash hasil build/CDN yang dikunci, koneksi ke situs dan API chat, serta memblokir form/object. Markdown hanya mengizinkan tag baca dan tautan HTTP(S)/anchor; style/form/SVG/media dibuang. Referrer dimatikan. CSP meta tidak menyediakan HSTS atau perlindungan `frame-ancestors`.
- Data kepemilikan divalidasi sebelum dirender: versi/skema, tipe angka, indeks investor, ticker unik, rentang tanggal, serta batas jumlah baris. Data rusak menampilkan pesan gagal dan tombol coba lagi.
- **Pengunjung** (hanya jalan di Claude Artifact; di host lain angka tidak tampil, halaman tetap normal):
  - *Pengunjung lalu*: kemampuan `db`. Satu dokumen per browser di `visitors/<id-acak-localStorage>` dengan
    `pages.<kunci-halaman> = {count, first, last}`. Angka = jumlah browser unik yang pernah membuka halaman itu,
    dan tooltip menampilkan total kali dibuka. Kunci halaman = nama file huruf kecil (`[^a-z0-9_-]` → `-`), beranda = `home`.
    **Jangan ganti nama file**, karena hitungannya akan mulai dari nol. Kapasitas db 5.000 dokumen, artinya ±5.000 browser unik.
  - *Pengunjung aktif*: kemampuan `room`, presence `{page: <kunci>}`. Dihitung per tab, tidak disimpan.
  - Saat publish ulang lewat Artifact tool, **tidak perlu** mengirim `capabilities` lagi (deklarasi `db` + `room` tersimpan).
    Mengirim `capabilities: {}` akan mematikan fitur ini.

Batas yang perlu diingat (per 15 Sep 2026: 41 dokumen + kepemilikan 963 emiten, `index.html` ±2,4 MB, `files/` ±16 MB):
- Claude Artifact: halaman dan tiap berkas maks 16 MB, maks 255 berkas, **maks 64 MB per versi**. Digest bertambah ±2 MB per minggu,
  jadi batas 64 MB tercapai dalam beberapa bulan. Saat itu pindah ke host B/C, atau buang digest lama dari sumber.
- Dokumen 2 MB butuh beberapa detik untuk dirender pertama kali (parse Markdown + DOM besar).

## Percakapan arsip dengan Qwen3.7 Flash

Kotak **Tanya arsip** berada langsung di bawah pencarian. Pertanyaan seperti “analisis SOCI”
menemukan seluruh dokumen yang memuat kode tersebut, membaca isinya, lalu menjawab dengan
rujukan `[D…]` yang bisa diklik. Daftar sumber tersedia di bawah jawaban. Pengguna bisa
bertanya lanjutan, menghentikan proses, mencoba lagi, atau memulai percakapan baru.

### Konfigurasi key dan percakapan

Key khusus arsip disimpan lokal di `.env.chat` yang diabaikan Git dan diunggah
sebagai secret `OPENROUTER_API_KEY` pada Cloudflare. Key tidak masuk hasil build.
Browser hanya mengirim pertanyaan (maksimal 600 karakter) dan token konteks acak.
Backend menolak riwayat, pilihan model, URL, dokumen, atau pengaturan token dari klien.
Riwayat singkat disimpan di SQLite: tiga pertukaran terakhir, jawaban lama maksimal
1.500 karakter. Token terikat hash IP, berlaku satu jam, maksimal 20 pertukaran.
Token kedaluwarsa ditolak; barisnya dihapus saat permintaan berikutnya. Refresh atau
Percakapan baru menghapus token dari memori tab. Perubahan jaringan/IP memerlukan
Percakapan baru. Riwayat model tidak dicatat ke log. Teks pertanyaan pengguna dicatat di statistik privat pengelola; key tidak pernah masuk prompt.

### Cara dokumen dipilih dan dibaca

- Pencarian menemukan **semua dokumen dalam cakupan yang diminta** yang cocok dengan ticker/kata utuh; tidak memakai top-3/top-5.
  Sumber yang disebut (misalnya SGX atau Stockbit) tetap membatasi pencarian topik. Pertanyaan tanpa ticker memakai
  satu panggilan kecil untuk membedakan pencarian topik, ringkasan dokumen, dan penemuan kandidat dari konteks percakapan.
  Pertanyaan hubungan Indonesia–ASX/SGX memakai variasi nama negara/bursa yang dikenali langsung, tanpa panggilan penentu istilah.
  Bukti hubungan lintas negara dapat berasal dari kedua sisi, termasuk dokumen Indonesia.
- Kode saham dicocokkan **peka huruf besar**: kata biasa "naik", "gold", "true" bukan ticker NAIK/GOLD/TRUE.
  Kode yang juga kata umum (`WORD_TICKERS` di `tools/chat_archive.py`) dalam huruf kecil hanya dibaca sebagai
  ticker setelah kata petunjuk (analisa, saham, emiten, dokumen, …) atau bila pertanyaan hanya berisi kode itu ("ship").
  Kode lain tetap dikenali dalam huruf kecil ("analisis soci").
- Nama pengguna Stockbit yang ditulis penanya ("Primestockid", "@athira", juga yang salah eja seperti "zeinfahrozi") dicari oleh kode, walaupun model
  menebak istilah lain atau tidak memberi istilah sama sekali. Daftar `handles` di manifest dibuat saat build dari nama yang di arsip kebanyakan ditulis dengan `@`
  (kata biasa seperti "media" tidak termasuk).
- Jika pencarian tidak menemukan apa pun, ejaan terdekat di indeks kata dicoba dulu tanpa panggilan model
  ("Zeinfahrozi" → zeinihzafahrozi): hanya huruf yang hilang atau satu salah ketik, huruf pertama sama.
  Jawaban menyebut koreksi ejaan itu. Baru setelah itu model diminta istilah lain.
- Permintaan isi dokumen ("ringkas keterbukaan informasi 22 September", "baca SGX, intinya apa") membaca dokumen
  berdasarkan sumber dan tanggal katalog. Tanpa tanggal, pilihan awal memakai potret terbaru per sumber; "semua"
  memperluas ke riwayat sumber itu, tetap dalam batas bahan. CSV dengan kembaran Markdown bernama sama tidak dibaca dua kali.
  Tahun boleh dihilangkan bila seluruh arsip berada dalam satu tahun. "Stockbit 25 September dan KI 26 September"
  memasangkan tiap tanggal dengan sumbernya; "SGX soal delisting" tetap mencari topik dalam sumber SGX.
  Rentang dua tanggal lengkap ("3 Oktober 2026 sampai tanggal 5 Oktober 2026") mencakup hari di antaranya,
  termasuk lintas bulan/tahun. Tanggal tidak valid atau urutan terbalik meminta koreksi tanpa membaca bahan lewat AI.
  Nama bulan salah ketik di samping angka hari ("22 Septembet - 5 Oct", "oktber 5") dibaca sebagai bulan bila kata dan
  bulannya sama-sama ≥6 huruf, tiga huruf awalnya sama dan selisihnya satu huruf; kata biasa ("market", "marsh") tidak.
- Permintaan kandidat/rumor yang jarang dibahas dapat dijawab tanpa ticker. Tanpa sumber atau tanggal, mode biasa
  mulai dari potret KI Indonesia dan Stockbit terbaru, lalu menyebut cakupannya. Ini penemuan kandidat dari bahan tersebut,
  bukan screening seluruh pasar; jumlah temuan tidak dipaksakan bila bukti kurang.
- Pertanyaan lanjutan ("analisa lebih dalam", "periksa dokumen di atas", "apa risikonya") mempertahankan topik dan
  cakupan sumber/dokumen yang disimpan di server. Koreksi tanggal atau "yang terbaru" memilih ulang dalam sumber itu;
  objek atau sumber baru mengikuti permintaan baru. Riwayat singkat tetap berlaku, bukan memori riset tanpa batas.
- `tools/evidence_index.py` membagi sumber secara deterministik saat build, tanpa API berbayar.
  Heading emiten dipertahankan sebagai bagian utuh; baris tabel Markdown dan baris CSV menjadi bagian sendiri dengan
  header sebagai konteks (header tabel berakhir di bagian pertama yang bukan baris tabel). Baris CSV dipisah seperti
  viewer membacanya: tanda kutip hanya membuka sel bila berada di awal sel, `""` di dalam sel kutip adalah kutip,
  dan baris berakhir di `\n`, `\r` atau `\r\n`. Blok Markdown di atas 1.500 karakter dipecah per butir daftar di kolom 0
  (`- `, `* `, `+ `, `1. `, `1) `, `[^KODE]:`; butir bertingkat/lanjutan ikut butirnya), masing-masing dengan
  ticker sendiri; baris di dalam blok kode berpagar (```` ``` ````/`~~~`) tidak dipecah. Artikel HTML tetap utuh,
  dan skrip/data HTML tetap menjadi bagian sumber. Gabungan `content` seluruh bagian harus sama persis
  dengan sumber asli. Setiap bagian mempunyai lokasi, ticker, tanggal, dan hash dokumen (versi `issuer-passages-v3`).
- Worker mencari dan mengambil bagian terkait dari SQLite FTS5 jika seluruh versi arsip sudah diimpor.
  `source_documents`, `source_passages`, dan `source_fts` menyimpan sumber lengkap serta indeksnya.
  Jika indeks database belum lengkap, pencarian masih memakai Assets.
- Worker mengambil bagian terkait dari setiap dokumen. Bagian prosa tetangga dan rujukan internal
  disertakan untuk menjaga konteks. Butir daftar dan baris tabel diambil tanpa tetangganya (tetangganya biasanya
  butir emiten lain); daftar yang cocok tetap membawa kalimat pengantarnya ("Nama yang paling menarik …:").
  Salinan untuk model membuang tautan, nomor posting "(juga: …)", ID temuan dan ID pengumuman IDX; daftar panjang
  di berkas desk (Ikhtisar emiten, Lampiran) hanya mengirim butir yang menyebut kode yang dicari. Di berkas Stockbit,
  bagian emiten lain yang menyebut kode itu hanya mengirim butir temuannya yang belum ada di bagian emiten itu sendiri
  (bagian PMUI yang mengulang butir GRPM tidak dikirim). Pemeriksa angka tetap memakai teks asli.
- Pertanyaan ticker membatasi bahan per keluarga: ringkasan Stockbit 90 KB, BEI 70 KB, Stockbit mentah/KI lama 60 KB.
  Hari terbaru dibaca utuh; hari yang lebih lama tercantum satu baris buatan kode dan tetap menjadi sumber yang
  dapat dibuka. Bagian emiten di ringkasan harian tidak dikirim bila bagian emiten yang sama di dokumen detail hari
  itu (≥2× lebih besar) ikut dibaca. Stockbit mentah/KI lama: bagian emiten itu (atau baris yang menyebutnya) dari
  setiap dokumen dibaca lebih dulu, dokumen dengan bagian sendiri didahulukan, lalu sisa dokumen (prosa tetangga,
  emiten lain) selama muat; dokumen yang hanya dikirim bagiannya diberi `cakupan_bahan`. Bahan pertanyaan ticker
  disusun keterbukaan resmi (BEI, KI, bursa lain) dulu, lalu Stockbit mentah, lalu berkas Stockbit harian, dan
  jawabannya diminta mempertahankan klasifikasi transaksi resmi (afiliasi/material), penjamin/tanggung renteng,
  tujuan dana dan status proses terakhir, serta satu baris per hari yang membahas emiten itu.
  Kalau indeks hilang, versinya salah, atau tidak menemukan bagian
  meskipun dokumen cocok, Worker kembali ke dokumen asal tersebut. Pencocokan tetap berbasis teks:
  penyebutan hanya melalui alias/nama tanpa ticker dapat terlewat.
- Tanggal dokumen dipisahkan dari tanggal kejadian. Hanya tanggal ISO di awal record yang jelas
  diklasifikasikan sebagai tanggal kejadian; tanggal lainnya dicatat sebagai penyebutan tanggal.
  Filter tanggal hanya membuang record dengan tanggal pasti yang berbeda. Tanggal tidak pasti,
  rentang tanggal, dan bahan dengan tanggal relevan lain tetap dipertahankan. “Tanggal 17” tanpa
  bulan/tahun meminta penjelasan tanpa panggilan model; tanggal lengkap dari pertanyaan sebelumnya
  dapat menjadi konteks. Filter ini konservatif, bukan jaminan seluruh tanggal telah dikenali.
- Bahan sampai 240 KB (±130 ribu token Claude, ±1,8 byte per token) dibaca model sebagai teks asli dalam satu
  panggilan jawaban, termasuk permintaan dokumen utuh; batas pesan jalur dokumen utuh 320 KB termasuk
  instruksi/metadata. Batas ini menyisakan ruang di konteks 200 ribu token untuk instruksi, riwayat dan jawaban;
  evaluasi ulang jika model diganti. Batas total analisis dan harian tetap berlaku.
  Berkas desk Stockbit/BEI (`sbringkas_`, `sbdetail_`, `sbpekan_`, `beiringkas_`, `beidetail_`, `beipekan_`) yang tidak
  muat dibaca sebagai **ringkasan buatan kode** (`worker/document-material.mjs`): bagian pembuka dan sorotan tiap hari
  (utuh bila semuanya muat dalam 60% anggaran; selain itu dibagi rata dalam 60% itu), lalu bagian emiten berurutan dibagi
  adil antarhari (paragraf awal dulu, lalu diperluas), bagian emiten tingkat kedua, lalu lampiran; sisanya hanya tercantum
  satu baris di "DAFTAR BAGIAN YANG TIDAK DIKIRIM" atau dihitung ("dan N bagian lain"). Mulai hari kedua, kode yang
  sudah masuk 10 teratas hari sebelumnya (FORU, GOTO …) mundur ke akhir tingkat teratas hari itu, dan bagian yang
  mengutip keterbukaan resmi didahulukan dari bagian rumor saja. Paragraf awal membawa sampai dua butir
  "[Mengutip keterbukaan]" (≤400 byte). Bagian yang hanya dikirim paragraf awalnya
  selalu diberi tanda "(… rincian bagian ini tidak dikirim)". Anggaran: 72 KB, 27 KB bila diminta singkat, 165 KB untuk
  seluruh temuan, 120 KB untuk "semua yang penting" atas beberapa hari dan untuk "detail"/"rinci" atas satu hari.
  Dua anggaran terakhir memakai **paragraf awal kaya**: semua bagian emiten teratas lebih dulu (paragraf awal plus sampai
  tiga butir temuan, didahulukan "[Mengutip keterbukaan]" yang memuat angka, lalu temuan lain yang memuat angka;
  pertanyaan tidak dipilih; dua butir untuk kode yang sudah teratas di hari sebelumnya), lalu bagian tingkat kedua yang
  memuat angka (Rp, US$, %, juta/miliar/triliun), baru kemudian perluasan. Bagian emiten `beidetail_` dikirim sebagai
  ringkas: Status, Kesinambungan, lalu per pengumuman hari itu judul, Ringkasan, Mengoreksi dan butir Fakta sampai
  ±320 byte (diperluas sampai ±1,4 KB bila anggaran sisa); Angka, Aksi korporasi, Tanggal penting, Batasan, Lampiran,
  Baru vs sebelumnya, Riwayat dan Jadwal tidak dikirim dan ditandai. Cadangan daftar 6% (biasa 15%). Uji offline
  (pesan jawaban, perkiraan token): Stockbit 1–6 Okt "semua yang penting" ±300 ribu → ±76 ribu (dulu teks utuh); BEI 12 Okt
  detail ±294 ribu → ±73 ribu. Ringkasan harian yang dibaca bersama dokumen detail tanggal yang sama hanya mengirim pembuka,
  sorotan dan bagian yang tidak ada di dokumen detail (Baru muncul, Emiten lain, Laporan rutin, Jadwal 30 hari,
  Cakupan); `cakupan_bahan` per dokumen menyebut apa yang dikirim. Rentang tanggal eksplisit di atas batas jumlah
  dokumen dibaca sampai 31 dokumen (dokumen non-desk ≤8 dan ≤1,5 MB); lebih dari itu dijawab dengan permintaan
  mempersempit rentang, tanpa panggilan AI. Hitungan "FAKTA TERHITUNG SISTEM" dan pemeriksa angka tetap memakai
  dokumen lengkap.
  Bahan di atas 240 KB memakai catatan sumber bersama untuk unit di atas 24 KB, maksimal dua pembaca bersamaan.
  Catatan membahas bukti emiten tanpa pertanyaan atau riwayat pengguna. Jika model menyatakan catatan belum cukup, satu pemeriksaan tambahan atas
  maksimal dua dokumen lengkap diperbolehkan; seluruh batas biaya/koneksi tetap berlaku.
  Permintaan dokumen utuh mengemas teks asli berurutan, dengan identitas sumber dan lokasi per potongan;
  judul/header tabel tidak diulang pada setiap baris indeks. Seluruh teks dan hash sumber tetap sama.
  Sebelum membaca, sistem menghitung kebutuhan awal seluruh catatan dan menyisihkan 6.500 token untuk jawaban.
  Jika permintaan seluruh temuan dapat membaca teks asli langsung dan bahannya ≤180 KB, jawaban mendapat maksimal
  24.000 token, tanpa panggilan catatan perantara. Semua teks sumber masuk ke model, tetapi ringkasan tetap dapat menghilangkan rincian
  atau keliru mengaitkan fakta; tersedianya seluruh teks bukan jaminan setiap detail termuat atau setiap klaim benar.
  Jalur dokumen utuh membatasi teks keluaran 160 ribu karakter, aliran provider 6 MB, dan waktu panggilan 6 menit;
  antarmuka menerima sampai 200 ribu karakter termasuk catatan validasi. Jalur biasa mempertahankan batas lamanya.
  Catatan dokumen utuh dibaca sekali, maksimal 5.000 token per unit (dibagi sesuai sisa anggaran, minimal 1.800).
  Catatan pencarian topik mendapat 1.800–4.000 token sesuai ukuran unit (±1 token per 30 byte) dan tidak dibaca ulang;
  bila jumlahnya bersama jawaban melebihi batas keluaran analisis, semua catatan diperkecil (minimal 1.800) alih-alih
  menolak pertanyaan. Jika teks asli ditambah catatan masih melebihi 240 KB, unit terbesar yang tersisa (>12 KB) juga
  dijadikan catatan (maksimal 14 catatan). Catatan yang terpotong ditandai; jawaban dari catatan tersebut juga ditandai
  parsial dan tidak disimpan sebagai jawaban lengkap.
- Kalimat penyangkalan ("Tidak ada aksi korporasi seperti rights issue…", "belum merencanakan delisting") tidak
  dihitung sebagai kecocokan kata topik. Dokumen yang hanya menyebut topik dalam penyangkalan tidak dibaca.
- **Topik terlalu luas** (tanpa kode saham, bahan di atas 240 KB):
  - Jika pertanyaan menyebut jenis aksi korporasi (rights issue, private placement, stock split, buyback,
    tender offer, go private/delisting, akuisisi, perubahan pengendali/backdoor, KBLI/kegiatan usaha, merger,
    dividen, saham bonus), jawaban memakai **tabel aksi korporasi** `events.json` dari `tools/event_index.py`.
    Tabel dibuat saat build tanpa AI: bullet fakta per emiten di digest (bukan skenario/risiko) dan kalimat
    atau baris yang menyebut kode saham berhuruf besar di KI/Stockbit, tanpa penyangkalan. Kode menyusun
    daftar lengkap dan jumlah emiten; model hanya menulis ringkasan ±350 kata. Pencocokan kata dapat
    memasukkan emiten yang hanya disebut sepintas atau kejadian historis; bukti tiap baris ditautkan.
  - Topik lain yang terlalu besar untuk catatan (lebih dari 6 unit catatan atau 4 MB) dijawab dengan daftar
    emiten yang menyebut topik itu, tanpa AI, disertai saran bertanya per kode.
- **Hitungan tidak diserahkan ke model.** Permintaan dokumen per tanggal memberi model "FAKTA TERHITUNG SISTEM"
  (jumlah bagian emiten dan baris tabel bertanggal, beserta kodenya). Setelah jawaban selesai, pemeriksa angka
  mencocokkan jumlah ("18 emiten") dan nominal/persen dengan bahan sumber; angka yang tidak ditemukan persis
  diberi catatan di bawah jawaban. Nilai yang dibulatkan/dipotong dan singkatan satuan (Rp20,817tn → Rp20,8 triliun)
  dianggap cocok. Pemeriksa ini tidak menilai perhitungan yang sah atau angka yang benar tetapi ditempelkan ke
  emiten yang salah.
- **Nama emiten diambil dari arsip, bukan ingatan model.** `events.json` memuat nama resmi per kode dari pola
  "PT … Tbk (KODE)" (semua nama untuk kode yang berganti nama). Nama itu diberikan ke model untuk kode di bahan,
  dicantumkan di daftar screening, dan nama lain yang ditulis model diberi catatan beserta nama menurut arsip.
  Tanpa daftar ini, uji 35 pertanyaan menemukan 23 nama perusahaan karangan model; dengan daftar ini, 0.
- Catatan ringkas dapat melewatkan detail. Model tidak boleh menganggap tidak tercatat berarti tidak
  ada dalam dokumen. Fakta, rumor/pernyataan penulis, angka, tanggal dan ketidakpastian tetap dibedakan.
  Jawaban dimulai dengan kesimpulan, memakai rujukan `[D…]` yang ditautkan ke arsip, dan menyebut batas bukti.
  Jika diminta singkat, targetnya sekitar 150–250 kata kecuali pengguna menentukan panjang lain.
  Permintaan cakupan eksplisit ("semua/seluruh temuan|detail|isi|rincian", "selengkapnya", "ringkasan/rincian/detail/
  daftar/versi lengkap", "secara lengkap", "tanpa kecuali", "jangan hilangkan/lewatkan detail|apa pun|satu pun") tidak
  dibatasi ke 3–5 pilihan atau panjang ringkasan umum. "Lengkap" saja ("tanggal lengkap") dan "semua dokumen …" bukan
  permintaan cakupan, dan kata singkat ("singkat", "padat", "intinya") selalu menang ("singkat tapi lengkap" = singkat).
  "Semua temuan" meminta jawaban lengkap, bukan berkas `sbdetail_` (itu hanya dengan kata "detail"). Permintaan dokumen
  yang bukan cakupan penuh, lebih dari satu dokumen atau meminta peringkat ("paling menarik", "urutkan") dijawab
  sebagai peringkat maksimal 10 butir (3 per dokumen untuk lebih dari tiga dokumen, paling banyak 20), kecuali pengguna
  meminta singkat atau menyebut jumlah/panjang sendiri. "Semua/seluruh" tanpa kata peringkat atas beberapa dokumen
  ("stockbit 1-6 oktober ringkas semua yang penting") memakai anggaran 120 KB dengan paragraf awal kaya; setiap butir
  Yang berubah/Sorotan/Jarang disebut tiap hari mendapat satu baris, dikelompokkan per jenis, dengan jawaban maksimal
  12.000 token. Kata "detail"/"rinci" tidak pernah dijawab sebagai peringkat (kecuali ada kata peringkat): jawaban
  maksimal 12.000 token, mulai dari jumlah di baris Cakupan, satu baris per butir Sorotan/Yang berubah dan satu butir per
  bagian emiten yang dikirim. Rincian yang tidak dikirim disebut "tidak termasuk bahan yang dibaca", bukan "terpotong".
  Kalimat cakupan penutup menyebut bagian emiten utuh, sebagian dan yang hanya tercantum/dihitung secara terpisah. Permintaan seluruh temuan atas ringkasan buatan kode juga diminta memasukkan setiap butir bagian pembuka
  tiap hari; kalimat awal di daftar boleh dikutip sebagai temuan satu baris bertanda "dari daftar".
  Ini tetap ringkasan dengan batas keluaran: model harus menyebut rincian yang belum termuat, bukan mengklaim seluruh detail selesai.
- Pembacaan gagal/terpotong tidak masuk cache. Catatan tidak dibaca ulang dengan batas lebih besar; catatan yang
  terpotong (mis. katalog 1.535 kode SGX) dipakai apa adanya dengan tanda "Catatan terpotong" dan tidak disimpan di cache, supaya satu unit panjang tidak menggagalkan seluruh jawaban. Jawaban akhir yang mencapai batas panjang tetap ditampilkan dengan tanda terpotong, tidak masuk
  cache jawaban dan tidak menjadi riwayat percakapan. Rujukan `[D…]` di luar sumber yang diperiksa tidak
  menggagalkan jawaban; jawaban diberi catatan agar rujukan itu diabaikan.
- Tombol Hentikan memutus koneksi. Server menghentikan pekerjaan setelah mendeteksi pemutusan;
  provider masih dapat mengenakan biaya untuk pekerjaan yang sudah dikirim.

### Tabel arsip: tambahan untuk pertanyaan kode saham, dan rute satu panggilan

`tools/archive_tables.py` (dipanggil `tools/build_worker.py`, tanpa AI) menulis `claims.json` (temuan `sbdetail_*` dengan F-id),
`subjects.json` (emiten lain yang disebut di bagian emiten BEI/KI: kode huruf kecil tepat di samping "saham/emiten/tbk",
`(kode)`, nama resmi terpanjang; baris lampiran/PDF dan pengenal `snake_case` dilewati; "transaksi saham" hanya bila kalimatnya
menyebut "saham", kalimat pinjaman/bank menjadi "kreditur"), `entities.json` (nama persis KSEI/DPS/keterbukaan, alias grup
tertulis, ejaan mirip, kata nama resmi emiten), `links.json` (cek rumor per kode: didukung/tercatat/tidak dapat dicek/tanpa dasar;
pemegang KSEI hanya bila namanya disebut, bukan karena persentase mirip, dan hanya bulan KSEI yang lolos validasi; klaim
bertanggal sesudah bulan KSEI terakhir tidak pernah disebut "bertentangan", hanya "KSEI s.d. <bulan> mencatat …; belum ada data
KSEI untuk <bulan>", atau "terakhir tercatat >1% <bulan>; tidak lagi >1% s.d. <bulan>"; klaim yang menyebut kode lain lebih dulu
tidak dicek untuk kode ini) dan `coverage.json`.
Hash tabel ikut `data_version`, jadi cache jawaban berganti saat tabel berubah. Kode di `worker/tables.mjs`.

- **Pertanyaan kode saham**: alur di atas tidak berubah. Ditambah blok **[A2]**: kode itu disebut di pengumuman emiten lain
  dalam huruf kecil atau nama resmi (mis. PMUI menulis "grpm"), yang tidak ditemukan pencarian kode peka huruf besar;
  maks 8 baris per kode, 4 KB; tidak ditambahkan bila pertanyaan menyebut tanggal atau sumber. Untuk 2+ kode dengan kata
  hubungan ("pengendali yang sama", "hubungan", "afiliasi", "terkait antara", "apakah … terkait"; "berita terkait X" tidak)
  ditambah **[H]**: nama persis yang tercatat di kedua emiten, bertier kuat/sedang/lemah.
- **Tanpa kode saham**, satu panggilan jawaban (maks 4.500 token) atas bahan yang disusun kode, berurutan:
  rumor aksi korporasi yang jarang dibahas ("jarang/sedikit dibahas"); nama pengguna Stockbit (ejaan terdekat hanya untuk
  pertanyaan tentang pengguna, mis. "ngomongin", "akun", "@", atau satu kata); nama orang/grup/perusahaan yang ada di
  `entities.json` (kartu nama, kutipan arsip, klaim Stockbit). Nama emiten ("telkom", "adaro"), kode saham sebagai kata
  ("emas") dan nama yang hanya dikenal sebagian ("Sukanto Tanoto") tetap memakai alur di atas. Di bawah jawaban,
  kode menambah maks 8 baris "Klaim tercatat lain" yang tidak dibahas. Pertanyaan lanjutan, bertanggal, bersumber
  tertentu, atau yang tidak cocok rute mana pun tetap memakai alur di atas; lanjutan dari rute nama mencari nama itu.

### Mode agen (datacat)

Kotak centang **Mode agen** membuat model memanggil alat baca-saja: `cari_arsip` (arsip ini) dan datacat
(`quant.renr.ai`, data terstruktur keterbukaan informasi BEI: kepemilikan, pemegang saham, RUPS, pengurus,
transaksi, laporan keuangan, pengumuman, profil dan jaringan pihak). Kode ada di `worker/agent.mjs`.

- Permintaan isi dokumen tanpa kode saham ("baca dokumen keterbukaan singapura, intinya apa", "ringkas KI 22 September") dialihkan ke alur arsip biasa yang membaca dokumen utuh; tidak memakai kuota mode agen. Mode agen hanya melihat kutipan pencarian pendek, jadi dulu menjawab dokumen SGX tidak ada.
- Kuota: `CHAT_AGENTIC_DAILY` pertanyaan per hari UTC untuk seluruh situs (produksi 50 di `worker/wrangler.jsonc`; tanpa nilai 10). Jawaban tersimpan tidak memakai kuota.
- Key datacat disimpan sebagai secret Worker `DATACAT_API_KEY` (lokal di `.env.chat`), tidak pernah ke browser.
  Host, path, dan parameter ditetapkan kode; argumen alat divalidasi; endpoint tulis API tidak tersedia sebagai alat.
- Batas per pertanyaan: 4 langkah model lalu jawaban maksimal 2.000 token, 18 panggilan alat, 6 KB per hasil dan 70 KB bahan;
  maks 3 pencarian nama, 3 pembacaan teks dokumen dan 3 pencarian frasa teks. Batas koneksi keluar tetap berlaku.
- Hemat: hasil datacat dipangkas dan ditulis ringkas (tanpa tanda kutip JSON), objek berulang jadi rujukan `K1`;
  respons datacat di-cache 6 jam, jawaban identik 6 jam. Akhir tiap prompt diberi `cache_control` sehingga
  langkah berikutnya dan jawaban akhir membaca awalan dari cache provider (±77% input dari cache pada uji).
  Instruksi jawaban dikirim sebagai hasil alat: pesan user/system baru membuat template menulis ulang giliran alat dan cache hilang.
- Pihak baru (pembeli, pelapor kepemilikan, direksi/komisaris baru) diperiksa silang lewat profil pihak di datacat.
- Penemuan awal oleh kode dimulai dari arsip. Nama pihak tetap dicari dengan nama lengkap di indeks kepemilikan dan
  datacat; profil dibuka untuk hingga tiga akun yang cocok. Username Stockbit dicari sebagai penulis, bukan diasumsikan pemegang saham.
  Sinyal kepemilikan emiten ditambahkan bila pertanyaan membahas pemilik, relasi, transaksi saham atau analisis emiten;
  pertanyaan pengumuman, laporan keuangan atau RUPS sederhana tidak otomatis memerlukan penelusuran sinyal tersebut.
- "Terbaru" berarti entri terakhir yang tersedia, bukan hanya hari ini; periode yang disebut pengguna tetap dipertahankan.
  Bila daftar utama kosong, agen boleh mencoba satu pencarian teks bertopik dan berticker yang sesuai selama anggaran masih ada.
  Hasil kosong atau alat gagal tidak membuktikan peristiwa tidak terjadi.
- Hasil daftar menyertakan jumlah yang ditampilkan/diterima, total bila tersedia, dan penanda cakupan terbatas atau teks dipangkas.
  Jawaban harus menyebut keterbatasan bahan; potongan daftar bukan pemeriksaan lengkap.
- Profil orang memuat `jejak_dokumen` (dokumen yang menyebut namanya: emiten, tanggal, peran, halaman) dan, bila ada,
  `riwayat_karier` dari halaman profil public expose/laporan tahunan, dipotong di judul bagian agar riwayat tetangga tidak tercampur.
- Pertanyaan hubungan diuji per jenis: orang sama lintas emiten, rantai kepemilikan, riwayat karier, nama grup/keluarga,
  alamat, BAE/auditor/notaris, transaksi pihak berelasi, waktu. Jawaban memakai tabel kekuatan (kuat/sedang/lemah);
  pernyataan "tidak terkait" diberi catatan bahwa ketiadaan bukti bukan bukti. Alamat hanya ada di teks dokumen.
- Rujukan `[D..]` ke arsip, `[K..]` ke halaman datacat, `[O..]` ke tab Kepemilikan Saham; nama emiten diambil dari arsip dan diperiksa setelah jawaban.
- **Sinyal KSEI dihitung saat build dan diperiksa bersama bukti.**
  - `tools/ksei_signals.py` (stdlib, tanpa jaringan) membaca `kepemilikan.json` dan menulis `signals.json` dan `ksei_history.json`
    ke aset Worker: pengalihan blok (satu pembeli), pemecahan blok (2-8 pemegang baru), pemegang baru/keluar >=2%, dekat 5%,
    ganti nama (lembar persis sama di >=2 emiten), kelompok pemegang lintas emiten, pemegang yang juga emiten, dan peringkat awal.
    Varian nama satu pemegang digabung (urutan kata, kesinambungan lembar atau persen); rekening kustodian/nominee dikecualikan;
    bulan kosong, tidak lengkap, atau mempunyai catatan validasi tidak dipakai untuk sinyal, peringkat, atau indeks pihak.
    Riwayat mentah menyimpan penanda kelayakan dan alasan per bulan; jawaban riwayat tidak menyajikan angka bermasalah sebagai fakta terverifikasi.
    Tiap sinyal punya tingkat (fakta/kuat/sedang/lemah) dan kalimat yang ditulis kode.
    Uji: `python3 -B -m unittest tests/test_ksei_signals.py`.
  - Untuk pertanyaan yang relevan dengan kepemilikan, kode mengirim sinyal emiten yang disebut (yang `wajib:1` harus dibahas), lalu memeriksa emiten lain milik pihak
    dalam sinyal itu. Sinyal wajib yang tidak dibahas ditambahkan kode di akhir jawaban. Pertanyaan "hidden gems" tanpa nama emiten
    memakai peringkat awal (belum disetel).
  - `worker/facts.mjs`: formulir perubahan kepemilikan menjadi kartu (harga per saham terpisah dari nilai total, jeda lapor,
    isian formulir sebagai pernyataan pelapor), badan usaha tidak pernah ditulis "individu", risalah RUPS dibedakan keputusan dan
    kehadiran, batas 44 koneksi keluar per pertanyaan (termasuk ulangan), batas datacat 45/menit, dan pemeriksaan setelah jawaban.
  - `cari_teks`: pencarian frasa persis di teks semua dokumen lewat halaman publik datacat (`/explore/documents/`), tanpa key API,
    host dan path tetap, maks 3 per pertanyaan, cache 24 jam; halaman yang tidak terbaca dilaporkan sebagai galat, bukan "0 hasil".
    Dijalankan otomatis untuk nama tanpa profil datacat (banyak komisaris/direksi hanya tercatat di teks risalah atau prospektus).
    Kata yang tidak dikenal arsip tetap dianggap bagian nama bila bersebelahan dengan kata nama lain ("ferita lie").
  - Tautan `[O..]` membuka tab Kepemilikan dengan rentang bulan.
- Uji: `node --test tests/agent.mjs` (tanpa jaringan) dan `node tools/eval_agentic.mjs --label nama`
  (kasus dalam skrip, API nyata, ambang biaya bawaan US$0,50 yang diperbarui setelah tiap pertanyaan; bukan batas tagihan mutlak).
  Proses selesai tidak sama dengan jawaban yang telah diuji kebenarannya.
- Statistik privat (`tools/chat_metrics.py --html`) memisahkan mode biasa dan mode agen: biaya, rata-rata, termahal, panggilan alat, cache.

### Cache bersama dan invalidasi

SQLite Durable Object menyimpan `evidence_cache` dengan tiga jenis: `source` (bagian teks asli),
`notes` (catatan bukti sumber), dan `answer` (jawaban permintaan identik). View `issuer_evidence`
menyediakan `document_id`, `document_hash`, `source_path`, `document_date`, `tickers`, `event_date`,
`source_line`, dan `content` untuk memeriksa bagian sumber yang sudah diminta. Indeks lengkap yang
belum pernah diminta juga diimpor ke tabel sumber persisten tanpa AI; Assets tetap tersedia sebagai cadangan.

- Dokumen lama bersifat tetap; pembaruan normal hanya menambah dokumen. Cache sumber/catatan tidak
  kedaluwarsa berdasarkan waktu, dikenali berdasarkan identitas/hash dokumen, ticker/istilah,
  versi parser; catatan juga berdasarkan model, instruksi, metadata sumber dan isi unit.
  Catatan menggunakan ID sumber lokal yang dipetakan ulang saat menjawab agar perubahan nomor
  `[D…]` setelah build tidak membuat rujukan lama salah.
  Cache bahan dokumen utuh tidak bergantung pada judul sumber pendamping. Cache catatan tetap
  membedakan fokus instruksi, termasuk sumber pendamping. Versi catatan terpisah dari versi alur,
  dengan hash instruksi aktual. Seleksi lintas negara juga
  memakai identitas dokumen/bagian yang tetap, sehingga penomoran ulang D tidak membuang hasil seleksi.
- Cache jawaban: 15 menit, kuncinya mencakup pertanyaan, riwayat, model, versi seluruh arsip dan
  instruksi, serta hash tabel fakta/nama `events.json`. Pertanyaan dengan riwayat dibatasi ke klien yang sama; jawaban tanpa riwayat dapat
  digunakan lintas pengguna. Pertanyaan yang hanya mirip tidak dipaksa memakai jawaban yang sama.
- Mode agen memakai cache jawaban 6 jam yang juga membedakan huruf besar/kecil, tanggal hari ini,
  dan fingerprint isi data turunan. `manifest.version` tetap khusus dokumen; `asset_hashes` dan
  `data_version` mencakup events, kepemilikan, sinyal, dan riwayat KSEI. Cache data datacat/web
  mempunyai versi format sendiri, sehingga perubahan prompt agen tidak membuang data mentah yang masih berlaku.
  Generator sinyal mengurutkan anggota kelompok agar build dari data yang sama menghasilkan byte/hash yang sama.
- Pekerjaan dengan kunci sama yang datang bersamaan bergabung pada satu pekerjaan. Di mode agen,
  pembatalan penunggu tidak menghentikan pemilik. Jika pemilik gagal/dibatalkan, penunggu aktif boleh
  mencoba sekali dengan model, sinyal pembatalan, dan kuotanya sendiri. Jalur biasa mempertahankan
  perilaku sebelumnya: kegagalan pemilik dapat menggagalkan penunggu. Hasil parsial tidak disimpan.
- Panggilan alat agen yang menghasilkan permintaan tervalidasi identik berbagi hasil yang sedang
  diproses. Hasil berikutnya menunjuk ID panggilan pertama; query dan rentang tanggal berbeda tetap
  dibaca terpisah. Permintaan HTTP yang sama dalam satu pertanyaan juga dipakai ulang.
- Maksimal 512 entri / 16 MB isi cache; entri lama dikeluarkan bila batas tercapai. Batas per entri 1 MB.
  Cache dapat bertahan setelah restart/deploy SQLite, tetapi selalu memeriksa versi sumber.
- Prompt menempatkan bahan yang tetap sebelum pertanyaan/riwayat yang berubah untuk membantu cache
  input otomatis provider. Tidak mengirim `cache_control` yang belum diverifikasi didukung endpoint.
  Header cache respons OpenRouter juga diaktifkan untuk permintaan identik dengan TTL 15 menit.
  Dukungan dan diskon provider tetap harus dibuktikan dari `usage`, bukan diasumsikan.

### Indeks teks persisten dan pertanyaan lintas negara

`python3 tools/sync_chat_index.py` mengimpor dokumen yang belum ada melalui endpoint privat
`/api/chat/index`, memakai token pengelola yang sama dengan laporan statistik. Tidak memakai AI,
embedding, layanan baru, cron, atau perubahan dokumen asli. `tools/publish_chat.py` menjalankan
sinkronisasi ini sesudah deploy Worker. Jika terputus, jalankan lagi; dokumen yang selesai dilewati.

Satu permintaan impor hanya membaca satu dokumen. Hash seluruh teks diverifikasi, lalu bagian dan
indeks FTS5 ditulis dalam satu transaksi sebelum dokumen dinyatakan siap. Status indeks menyebutkan
jumlah dokumen/bagian serta daftar dokumen yang belum diimpor. Perubahan hash/parser memakai versi
baru. Pencarian membatasi hasil ke versi dokumen dalam manifest aktif; sumber versi lama tidak
ikut hasil. Tabel sumber terpisah dari cache 16 MB sehingga cache yang dikeluarkan tidak menghapus
sumber persisten.

Untuk pertanyaan yang eksplisit menyebut Indonesia/BEI/IDX, hubungan/akuisisi/kepemilikan, dan
ASX/Australia atau SGX/Singapura, pencarian memakai sinonim bursa/negara. Semua dokumen yang cocok
diperiksa. Satu panggilan model menyeleksi semua cuplikan kandidat tanpa top-k; ID hasil harus ada dalam
daftar kandidat. Seleksi disimpan per bahan/topik tanpa riwayat pengguna sehingga pertanyaan
berbeda dapat memakainya lagi. Teks asli kandidat terpilih dan tetangganya kemudian diambil
dari database. Bagian besar dipersempit ke paragraf yang menyebut istilah, paragraf tetangga,
heading dan batas bukti eksplisit. Setiap cuplikan tetap mempunyai sumber dan nomor baris; ini pemilihan bahan,
bukan bukti bahwa perusahaan mempunyai hubungan. Bahan panjang menggunakan catatan bersama yang
sudah ada, maksimal dua pembaca bersamaan, kemudian satu sintesis jawaban. Untuk bahan yang muat, alurnya dua panggilan: seleksi dan jawaban; seleksi tersimpan mengurangi
pengulangan menjadi satu panggilan. Jumlah nyata tetap bergantung ukuran bahan dan retry.

Jawaban diminta membedakan emiten BEI/perusahaan privat, domisili Singapura/pencatatan SGX, dan
rencana/penyelesaian transaksi. Pencarian teks dapat melewatkan hubungan implisit atau nama alias.
Seleksi dari cuplikan juga dapat melewatkan kandidat; hitungan kandidat ditemukan/terpilih dan
dokumen bukti dicatat pada statistik. Batas bahan/token tetap berlaku; aplikasi tidak mengklaim screening menyeluruh di luar bahan yang
diperiksa. Fitur ini tidak menambah sistem pekerjaan latar belakang atau graph perusahaan.

### Biaya aktual dan perbandingan

Setiap panggilan mencatat input/output token, input cache, cache write, biaya USD yang dilaporkan,
ID generation, byte pesan, dan alokasi maksimum output. `analysis_usage` menyimpan hasil agregasi
per analisis selama 365 hari, termasuk analisis gagal. `question_events` mencatat **setiap pertanyaan
pengguna yang diterima dan lolos validasi isi**: teks, waktu, penanda klien anonim, topik, serta status
(selesai, perlu tanggal lengkap, gagal, dibatalkan, server sibuk, atau kuota). Pertanyaan dan metrik
dihubungkan lewat ID analisis. Permintaan ditolak sebelum isi dibaca/validasi ukuran, termasuk banjir
permintaan, tidak menyimpan teks. Riwayat percakapan, key dan IP mentah tidak dicatat. Penanda
klien berasal dari hash koneksi/IP dengan secret; bukan hitungan orang unik. Riwayat statistik ini
berlaku sejak fitur diaktifkan dan tidak dapat merekonstruksi pertanyaan lama yang belum dicatat. Biaya yang belum dilaporkan ditandai `missing_usage_calls`; jangan menganggapnya
nol. Batas anggaran byte/token tetap dicadangkan sebelum panggilan dan terpisah dari tagihan aktual.
Rincian biaya permintaan tersedia pada bagian yang dapat dibuka di bawah jawaban.

```bash
node tools/eval_chat.mjs --label nama      # kasus tests/eval/cases.json, API nyata, ambang biaya US$2
node tools/eval_chat.mjs --label cache --only optimization_sgx,optimization_sgx_stockbit --shared-cache 1 --concurrency 1
node --test tests/eval_reporting.mjs       # kontrak laporan evaluasi, tanpa jaringan
python3 -B -m unittest tests/test_chat_metrics.py # pemisahan ID tes dalam laporan, tanpa jaringan
node tools/compare_chat_costs.mjs           # simulasi offline, tidak memanggil provider
node tools/compare_chat_costs.mjs --live    # perbandingan API nyata, batas cadangan konservatif US$1
python3 tools/chat_metrics.py --days 7 --out reports/private/chat-metrics.json --html reports/private/chat-statistics.html
```

**Bandingkan token dua versi kode (`tools/bench_tokens.mjs`).** Menjalankan pertanyaan yang sama lewat `converse()` dari satu
salinan kode dengan aset Worker-nya dan mencatat setiap panggilan model (jenis, byte masuk, estimasi token = byte/1,8).
Mode bawaan offline: model tiruan, tanpa jaringan dan tanpa kuota; panggilan istilah memakai istilah produksi dari dump.
`--bridge` memakai `claude -p` sungguhan lewat `local/claude-bridge.mjs` salinan itu (langganan Claude, memakai batas pemakaian).

```bash
node tools/bench_tokens.mjs --impl <salinan-lama> --assets <aset-lama> --questions q.json --out /tmp/a.json --now 2026-10-15T05:00:00Z
node tools/bench_tokens.mjs --impl . --assets <aset-baru> --questions q.json --out /tmp/b.json --now 2026-10-15T05:00:00Z
node tools/bench_tokens.mjs --diff /tmp/a.json /tmp/b.json [--out diff.json]   # tabel Markdown + ringkasan JSON
node tools/bench_tokens.mjs --bridge --model sonnet --effort low --impl . --assets <aset> --questions q.json --out reports/private/live.json --limit 8
```

`--questions` menerima dump pertanyaan VPS (baris mode agen dilewati, pertanyaan identik sekali) atau larik string/
`{id, question, terms?, intent?}`. Bangun aset per versi dengan `tools/build_worker.py --out <folder baru>` bila
`build_worker.py`/`evidence_index.py` berbeda. Pilihan lain: `--only`, `--limit`, `--concurrency`, `--no-store`, `--verbose`.
Kunci penanda giliran kini disimpan di `.local/boundary.key`: jalankan arm `--bridge` berjarak lebih dari TTL cache, atau
dari salinan berbeda, supaya arm kedua tidak membaca cache arm pertama. `--out` harus di luar repo atau di folder yang
diabaikan Git (mis. `reports/private/`).

Hasil pembanding berada di `reports/cache-comparison/`. Alur lama tetap tersedia sebagai
`converseLegacy` untuk kontrol pengujian, bukan pilihan dari browser publik. Mode nyata memakai
key khusus `.env.chat`; biaya aktual berasal dari respons provider. Batas US$1 adalah cadangan
konservatif berdasarkan byte dan tarif tertinggi endpoint yang diverifikasi pada 20 September 2026;
verifikasi ulang tarif sebelum menjalankan ulang jika harga/model berubah. Cache provider tidak
dipaksa kosong, sehingga laporan mencantumkan cached token dan hasil yang benar-benar ditagih.

Evaluasi normal secara default memakai cache aplikasi kosong per percobaan; `--shared-cache 1`
khusus eksperimen penggunaan ulang. Cache respons provider dimatikan dalam evaluator. Total biaya/token
dan receipts mencakup pertanyaan pembuka serta semua percobaan ulang, termasuk yang gagal;
`final_usage`, jawaban dan pemeriksaan sumber menggambarkan percobaan terakhir. `--max-usd` evaluator
adalah ambang yang diperiksa sebelum panggilan berikutnya, bukan batas tagihan keras untuk panggilan
yang sedang berlangsung. Kasus `optimization_*` adalah benchmark sintetis, bukan pertanyaan pengguna riil.

Kedua skrip evaluasi memakai fungsi lokal, bukan endpoint chat produksi. Hasilnya menyimpan ID run dan asal
`test/local`. Ringkasan memisahkan `completed` dari `fixture_assessed`/`fixture_passed`, serta kegagalan pemeriksaan
sumber, pola fakta, istilah dan ID rujukan. Kasus tanpa ekspektasi isi tidak dihitung sebagai lolos pemeriksaan isi.
Pemeriksaan ini terbatas pada fixture; lolos bukan audit lengkap kebenaran jawaban. Field lama `ok` berarti proses selesai.

Endpoint `GET /api/chat/metrics?days=7` memerlukan bearer `CHAT_METRICS_TOKEN`, secret terpisah dari
key OpenRouter. Nilainya disimpan lokal di `.env.chat.metrics` (izin 600, diabaikan Git), diunggah
sebagai secret Worker, dan tidak masuk frontend. Tanpa secret, endpoint menolak akses. Pengelola
memakai `tools/chat_metrics.py`; token tidak dicetak atau ditaruh pada URL. Laporan menyediakan
pertanyaan berulang, topik teratas, tren harian, token/biaya, hasil proses, dan cache hit. Teks pertanyaan
ditampilkan dengan escaping HTML. Laporan JSON/HTML privat disimpan di `reports/private/` yang
diabaikan Git. `--limit` (maksimal 500) dan `--offset` menyediakan halaman riwayat berikutnya.

Untuk memisahkan tes produksi, catat ID permintaannya dalam ledger privat, misalnya
`{"runs":[{"run_id":"smoke-1","execution":"production","production_request_ids":["request-id"]}]}`.
Berikan `--test-runs reports/private/test-runs.json` saat membuat laporan. Hanya ID yang cocok ditandai tes;
lainnya **belum diketahui asalnya**, bukan otomatis pengguna riil. Teks yang sama dapat berasal dari pengguna maupun replay tes.
Agregat server tetap mencakup seluruh trafik; tabel asal input hanya menghitung ID unik pada halaman yang dimuat.
`--from-file reports/private/questions-0.json` mengolah snapshot lama tanpa jaringan; gunakan nama output baru untuk mempertahankan aslinya.

### Batas keamanan dan biaya

Batas backend tetap berlaku walaupun JavaScript browser diubah:

| Lapisan | Batas |
|---|---|
| Pertanyaan | 600 karakter, normalisasi Unicode, hapus kontrol tak terlihat |
| HTTP body | 4.096 byte, JSON saja, unggahan maksimal 5 detik |
| Riwayat dari browser | Ditolak; hanya token konteks acak 256 bit |
| Topik | Maksimal 4 ticker/istilah, 4 MB bahan, 14 kelompok |
| Satu panggilan model | Maksimal 480.000 byte JSON pesan; 320.000 khusus teks asli dokumen utuh yang dipilih server; tidak sama dengan jumlah token |
| Satu analisis | 8 MB total pesan termasuk retry, 20 panggilan, alokasi keluaran 36.000 token |
| Keluaran per panggilan | Catatan topik 1.800–4.000 token sesuai ukuran unit, tanpa retry; catatan dokumen utuh 1.800–5.000 sekali baca; jawaban akhir 6.500, atau 24.000 untuk seluruh temuan dari teks asli dokumen utuh ≤180 KB; termasuk penalaran |
| Anggaran global/hari UTC | 80 MB pesan model dan alokasi keluaran 500.000 token, dicadangkan sebelum setiap panggilan |
| Permintaan masuk termasuk invalid | 12/IP/menit dan 120 global/menit |
| Analisis diterima | 120/IP/jam, 3.000 global/hari |
| Koneksi | 4 unggahan, 10 analisis (maksimal 5/IP), batas keseluruhan 8 menit, pembaca lambat diputus setelah 10 detik |

Alokasi keluaran memakai batas maksimum, bukan tagihan aktual. Model, endpoint, dan
parameter tidak bisa dipilih pengguna. Pemeriksaan ulang sumber hanya memakai ID dokumen yang ditemukan server. Mode biasa tanpa tools/function calling; mode agen hanya memakai alat baca-saja yang ditetapkan server. Tidak ada eksekusi shell
atau pengambilan URL pengguna. HTML jawaban memakai allowlist tag sederhana; style,
form, media, SVG, event handler, dan URL di luar sumber terverifikasi dibuang sebelum
dipasang ke DOM. DOMPurify 3.4.15 dan marked memakai versi serta hash SRI terkunci.

Prompt injection tetap dapat memengaruhi isi/judgment model; sanitasi bukan bukti bahwa
model kebal instruksi jahat. Dokumen tetap utuh dan diperlakukan sebagai bahan data.
Batas kode membatasi dampak pada kapabilitas dan biaya, bukan menjamin kebenaran jawaban.
Endpoint publik tanpa login masih bisa menghabiskan kuota melalui banyak IP. Batas ini
bukan batas dolar; batasi kredit key OpenRouter secara terpisah jika diperlukan.

Uji serangan dijalankan di salinan terpisah tanpa `.env.chat`, tanpa key asli, dan tanpa
akses provider. `tests/security.mjs` memblokir global fetch; `tests/worker_runtime.cjs`
memakai workerd/SQLite dengan seluruh jaringan keluar diganti model simulasi.

```bash
node --test tests/worker.mjs tests/security.mjs tests/cache.mjs tests/source-store.mjs   # Node 22+ untuk node:sqlite
NODE_PATH=/path/to/test-deps/node_modules node tests/chat_ui.cjs
NODE_PATH=/path/to/test-deps/node_modules node tests/worker_runtime.cjs
```

Runtime test memerlukan Miniflare 5 (adapter V4) dan esbuild dari alat Wrangler 4.135.0.
Jangan menjalankan flood/attack test pada URL publik. Lihat `SECURITY_REVIEW.md` untuk
cakupan, bukti, dan batas audit.

### Memasang di situs publik

> Sekarang `arsip.seekingomega.capital` dilayani VPS Jakarta (`node local/vps.mjs push`, lihat [Semua di VPS Jakarta](#semua-di-vps-jakarta-localvpsmjs)).
> GitHub Pages dimatikan (repo hanya riwayat, `docs/` tetap di-commit) dan Worker Cloudflare tidak dipakai situs lagi.
> Bagian ini dan `tools/publish_chat.py` adalah dokumentasi/alat lama untuk deploy manual ke Cloudflare.

Frontend tetap **GitHub Pages**, domain `arsip.seekingomega.capital`, folder `docs/`.
API publik memakai **Cloudflare Workers Free + SQLite Durable Object** di akun yang
ditentukan `worker/wrangler.jsonc`. Model tetap OpenRouter `qwen/qwen3.7-flash`.

- Worker luar hanya memeriksa origin dan meneruskan koneksi ke satu Durable Object.
  Pembacaan arsip berjalan di Durable Object (batas CPU aktif 30 detik), sehingga
  tidak bergantung pada batas CPU 10 ms Worker biasa. Waktu menunggu model tetap
  membutuhkan waktu nyata dan dapat berlangsung beberapa menit.
- `tools/build_worker.py` menyiapkan indeks kata dan potongan isi lengkap dari hasil
  build. Seluruh sumber dan indeks bagian emiten dibundel sebagai Assets; tidak ada pemotongan
  top-k. Data sumber lengkap tetap tersedia untuk fallback; Worker tidak membolehkan URL sumber
  arbitrer dari pengguna. Berkas hasilnya ada di `worker/.assets/`, diabaikan Git.
- Kuota 3.000 pertanyaan/hari UTC dan 120/alamat IP/jam disimpan dalam SQLite Durable
  Object dan tetap ada setelah restart/deploy. Alamat koneksi Cloudflare di-hash.
  Maksimal 10 analisis bersamaan, lima per IP, masing-masing 2 pembaca model. CORS
  produksi hanya mengizinkan domain situs; lokal memerlukan override konfigurasi uji.
- Tidak ada cron/keepalive atau server yang harus dinyalakan di Mac. Durable Object
  dapat dikeluarkan dari memori saat tidak aktif dan diinisialisasi saat dibutuhkan;
  ini bukan jaminan latensi nol, tetapi tidak memakai jeda bangun satu menit Render.
- Free tier memiliki batas harian. Pemakaian OpenRouter tetap berbayar terpisah.
  Kuota pertanyaan bukan batas dolar; gunakan batas kredit pada key khusus OpenRouter.
  CORS bukan autentikasi, sehingga batas global juga diterapkan untuk klien non-browser.

Batas produksi dikonfigurasi melalui `worker/wrangler.jsonc`: `CHAT_DAILY_REQUESTS`,
`CHAT_HOURLY_PER_IP`, `CHAT_CONCURRENT_REQUESTS`, dan `CHAT_CONCURRENT_PER_IP`.
Perubahan memerlukan deploy Worker; mengedit `.env.chat` saja tidak mengubah produksi.
Slot aktif dihitung per permintaan, sehingga pengguna pada IP/Wi-Fi yang sama tidak
menghapus slot pengguna lain saat selesai. Pesan slot global penuh dibedakan dari
batas proses pada jaringan yang sama. Kuota pertanyaan tidak mengalahkan batas anggaran
model harian: 500.000 token keluaran yang dicadangkan dapat habis sebelum 3.000
pertanyaan baru; jawaban cache tidak membuat panggilan model baru.

Alamat API tersimpan di `chat.config.json`, sehingga build/sinkron berikutnya tidak
kembali ke `/api/chat` di GitHub Pages. `CHAT_API_URL` bisa mengalahkannya untuk uji lokal.

**Memperbarui arsip dan chat setelah menambah dokumen (lama, Cloudflare; situs kini: `node local/vps.mjs push`):**

```bash
python3 tools/publish_chat.py
# Periksa perubahan dan output kategori/tanggal, lalu commit/push untuk GitHub Pages.
```

Skrip membangun `site/`, membuat Assets, men-deploy Worker, menyinkronkan indeks SQLite, lalu membangun `docs/`.
Jika deploy gagal, skrip berhenti sebelum memperbarui `docs/`. Skrip tidak melakukan
commit/push. Worker dan GitHub Pages perlu diperbarui bersama supaya bahan chat dan
tautan sumber mengikuti arsip yang sama. `build.py` biasa hanya memperbarui frontend.

**Setup ulang Cloudflare / mengganti key:**

```bash
npx wrangler@4.135.0 login
python3 build.py
python3 tools/build_worker.py
npx wrangler@4.135.0 deploy --config worker/wrangler.jsonc
npx wrangler@4.135.0 secret put OPENROUTER_API_KEY --config worker/wrangler.jsonc
```

Masukkan key pada prompt secret; jangan menaruhnya dalam `wrangler.jsonc`,
`chat.config.json`, atau command argument. Key tidak diunggah sebagai Assets.
Jika memakai akun lain, sesuaikan `account_id` dan alamat API setelah deploy.

**Uji Worker lokal tanpa key asli:**

```bash
python3 tools/build_worker.py
node --test tests/worker.mjs
npx wrangler@4.135.0 dev --config worker/wrangler.jsonc --local --port 8788
```

Key lokal dapat diisi di `worker/.dev.vars` sebagai `OPENROUTER_API_KEY=...`;
file tersebut diabaikan Git. Tanpa key, API mengembalikan pesan belum diaktifkan.
Runtime Worker tidak mempunyai dependency aplikasi npm; Wrangler hanya alat
pengembangan/deployment. Untuk mencoba frontend lokal dengan Worker lokal,
jalankan `CHAT_API_URL=http://127.0.0.1:8788/api/chat python3 build.py`, lalu
`python3 -m http.server -d site 8017` dan buka `http://127.0.0.1:8017`.

Pemeriksaan tanpa panggilan berbayar:

```bash
python3 tools/build_worker.py
node --test tests/worker.mjs
node --check chat.js
```

Uji DOM opsional memakai dependency pengujian saja, tidak dipakai server/build:

```bash
chat_test_deps=$(mktemp -d)
npm install --prefix "$chat_test_deps" jsdom@26.1.0 marked@15.0.7 dompurify@3.4.15
NODE_PATH="$chat_test_deps/node_modules" node tests/chat_ui.cjs
```

## Host lokal dengan akun Claude (`local/server.mjs`)

Untuk pemakaian sendiri, situs dan chat bisa berjalan seluruhnya di Mac ini, tanpa Cloudflare dan tanpa key OpenRouter.
Model dijawab oleh Claude Code CLI (`claude -p`) yang sudah login dengan akun Claude (langganan), bukan API berbayar per token.

```bash
claude                          # sekali: login akun Claude (/login), lalu keluar
node local/server.mjs --pin     # pertama kali di mesin ini: build + kunci mesin + jalan
node local/server.mjs           # berikutnya; tambah --build setelah ada dokumen baru
# buka http://127.0.0.1:8017
```

- Kode Worker yang sama (`worker/index.mjs`, Durable Object `ArchiveChat`) dijalankan di Node 22. Penyimpanan Durable Object
  diganti SQLite lokal `.local/chat.sqlite`; aset Worker di `.local/assets`, situs di `.local/site` (dibangun dengan
  `CHAT_API_URL=/api/chat`, jadi chat satu origin dengan situs). Semua di `.local/` diabaikan Git. `docs/` dan Worker publik tidak diubah.
- Saat start, indeks sumber SQLite diisi langsung tanpa AI (pengganti `tools/sync_chat_index.py`). Setelah semua dokumen
  manifest aktif terimpor, `SourceStore.prune` menghapus dokumen versi lain (versi bukti lama atau hash lama), satu
  transaksi per dokumen. Selama impor belum lengkap tidak ada yang dihapus, dan baris versi bukti yang lebih baru
  (`issuer-passages-v3` > `-v2`) selalu disimpan: push yang gagal di tengah lalu kembali ke `app.old` tidak membuang
  kemajuan impor, sehingga push berikutnya melanjutkan, bukan mengimpor dari nol.
- `local/claude-bridge.mjs` menggantikan `fetch` ke OpenRouter (hook `env.MODEL_FETCHER`, hanya ada di server lokal):
  tiap panggilan model = satu proses `claude -p` tanpa alat (`--tools ""`), tanpa setting/hook/MCP pengguna, tanpa sesi tersimpan,
  dari folder kosong. Pesan sistem lewat berkas sementara (izin 600), bahan lewat stdin. CLI dijalankan dengan lingkungan
  seperti terminal baru (`cliEnv`: HOME, PATH, bahasa, proxy, `CLAUDE_CONFIG_DIR`), jadi kredensialnya hanya login
  `claude auth login` milik akun itu. `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock/Vertex, secret server, dan variabel
  sesi Claude Code yang menjalankan server tidak diteruskan, supaya CLI tidak pindah ke tagihan API atau akun lain. Saat start,
  `claude auth status` harus menunjukkan login langganan (`authMethod` `claude.ai`, provider `firstParty`); selain itu server
  berhenti dengan kode 78. Streaming, mode JSON, dan langkah mode agen diterjemahkan ke format yang dibaca `worker/core.mjs`
  **tanpa `--json-schema`** (yang menambah putaran alat StructuredOutput): fungsi server dijelaskan di system prompt
  ("FUNGSI SERVER …") dan model membalas satu objek JSON `{content, tool_calls}` sebagai teks (`parseStep`/`parseJson`).
  Rencana dibaca bila objek JSON berada di awal balasan (polos, beberapa objek per baris, atau dalam pagar kode; catatan
  sesudahnya diabaikan) atau setelah satu baris pengantar ("Rencana:") sampai akhir balasan. JSON yang dikutip di
  tengah kalimat tidak pernah dijalankan, supaya teks dokumen yang dikutip model tidak memicu panggilan. Balasan yang
  dimulai seperti rencana tetapi tidak terbaca dijawab 502 (Worker mencoba lagi), bukan dianggap "SIAP". Jawaban akhir
  mode agen ditahan ±64 karakter pertama: bila isinya JSON protokol atau tag transkrip, isinya dibuka bila berupa
  jawaban biasa, atau aliran diakhiri tanpa "stop" sehingga Worker mencoba sekali lagi dengan `tool_choice` none (system
  prompt hanya meminta jawaban teks). Penanda giliran rahasia selalu dibuang dari teks yang dialirkan.
  Penalaran (thinking): jawaban biasa mengikuti `--effort` (bawaan `medium`), tanpa `MAX_THINKING_TOKENS`; panggilan dengan
  `reasoning {enabled:false}` (catatan, mode JSON, langkah dan jawaban mode agen) memakai `--thinking disabled`.
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS` = anggaran teks Worker + 64.000 ruang thinking, supaya thinking tidak menghabiskan jawaban;
  teks jawaban tetap dihentikan sebagai "length" di ±8 karakter per token anggaran. Uji Haiku effort max: satu pertanyaan
  pendek atas ±34 ribu token bahan memakai ±15.800 token thinking (estimasi API US$0,015 vs US$0,007 tanpa thinking).
  Pesan dikirim sebagai `--input-format stream-json`: tiap giliran satu blok teks, giliran pertama (bahan arsip) diberi
  breakpoint cache 5 menit (`ARSIP_CLAUDE_CACHE_TTL=1h` untuk 1 jam; TTL yang sama dipakai breakpoint CLI sendiri lewat
  `CLAUDE_CODE_PROMPT_CACHE_TTL`, karena entri 1 jam setelah entri 5 menit ditolak API; tulis cache 5 menit 1,25× harga
  input, 1 jam 2×), dan penanda giliran tetap sama untuk bahan yang sama (HMAC dengan kunci di `.local/boundary.key`,
  izin 600, ditulis ke berkas sementara lalu dipindah; berkas kosong/rusak diganti; `node local/vps.mjs push` menyalin
  kunci yang valid ke salinan baru sehingga cache tetap hangat setelah deploy; symlink atau folder tak tertulis = kunci
  per proses). Panggilan bersamaan dengan awalan sama (system prompt + giliran pertama) menunggu maksimal 30 detik
  sampai panggilan pertama mulai dijawab (`message_start`), supaya cache tidak ditulis dua kali.
  Uji nyata: pertanyaan kedua atas bahan yang sama membaca ±99% input dari cache (estimasi API ±15× lebih murah).
  Sebelumnya penanda acak per panggilan membuat cache tidak pernah terbaca.
  Di bawah jawaban, "Biaya & token" menampilkan model, panggilan, token input (baru/dibaca/ditulis cache), output,
  biaya ditagih (US$0, langganan) dan estimasi harga daftar API menurut Claude Code (`total_cost_usd`).
  Batas pemakaian langganan dipetakan ke 429 (pesan "sedang membatasi"), bahan terlalu panjang ke 413.
- Biaya per panggilan dicatat 0 (langganan); jumlah token tetap dicatat. Batas langganan Claude (jendela 5 jam) tetap berlaku.
- Pilihan: `--model sonnet|opus|haiku` (bawaan `sonnet`), `--effort low|medium|high` (bawaan `medium`), `--concurrency 3`
  (proses `claude` bersamaan), `--port 8017`. Env: `ARSIP_CLAUDE_MODEL`, `ARSIP_CLAUDE_EFFORT`, `ARSIP_CLAUDE_CONCURRENCY`,
  `ARSIP_CLAUDE_BIN`, `ARSIP_PORT`, `ARSIP_CLAUDE_CACHE_TTL` (`5m` bawaan atau `1h`), `CHAT_AGENTIC_DAILY` (bawaan lokal 100).
- Mode agen aktif bila `DATACAT_API_KEY` ada di `.env.chat`. Hanya ini yang keluar ke layanan lain selain Claude:
  datacat (`quant.renr.ai`). Tanpa key, mode agen disembunyikan.
- Hanya mendengar `127.0.0.1`. `--host <ip> --allow-lan` membuka ke jaringan lokal **tanpa login**. Origin yang diizinkan hanya
  alamat server sendiri, sehingga situs lain yang dibuka di browser tidak bisa memakai chat. IP klien diambil dari socket, bukan header.

**Kunci mesin (fail-closed).** Server menolak start, sehingga tidak ada pertanyaan yang sampai ke Claude, bila:
berjalan di container (`/.dockerenv`, `/run/.containerenv`, Kubernetes), zona waktu bukan Indonesia
(`Asia/Jakarta`, `Asia/Pontianak`, `Asia/Makassar`, `Asia/Jayapura`), ID perangkat keras tidak terbaca, atau hash ID
berbeda dari `.local/machine-lock.json` yang dibuat `--pin`. Salinan yang dibuka di host/region lain tetap mati sampai
pemiliknya sengaja menjalankan `--pin` di sana. Zona waktu hanya pengaman tambahan karena bisa diatur; yang mengikat adalah ID mesin.
Container dan Cloudflare Workers tidak cocok untuk cara ini: container dibuat ulang (login hilang, mesin berganti) dan Worker
tidak bisa menjalankan CLI. Untuk selalu menyala tanpa Mac, pakai VPS Jakarta yang tetap: lihat
[Semua di VPS Jakarta](#semua-di-vps-jakarta-localvpsmjs). Token di variabel lingkungan sengaja tidak dipakai.

### Semua di VPS Jakarta (`local/vps.mjs`)

```
perangkat --HTTPS--> VPS Jakarta: Caddy --> 127.0.0.1:8018 local/server.mjs (wajib kata sandi) --> claude -p (login akun Claude)
```

Mac boleh mati. Saat ini: Tencent Cloud Lighthouse `ap-jakarta` (2 vCPU, 2 GB, Ubuntu 24.04), domain `arsip.seekingomega.capital`
(A record di ClouDNS). Semua perintah dijalankan dari Mac lewat SSH ke akun admin (`ubuntu`, sudo).

```bash
# 1. Sidik jari host dibaca di konsol web penyedia (bukan lewat SSH dari Mac): ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
node local/vps.mjs setup --host <ip> --domain arsip.seekingomega.capital --host-key SHA256:…   # .local/vps.json, kata sandi
node local/vps.mjs bootstrap   # root: zona Asia/Jakarta, Node 22.17.1 (checksum), Caddy, swap, user arsip, Claude Code, systemd
node local/vps.mjs login       # interaktif di Terminal: claude auth login --claudeai sebagai user arsip (buka URL, tempel kode)
node local/vps.mjs push        # salin kode + arsip + key, build, kunci mesin (pertama kali), jalankan; ulangi setelah ada dokumen baru
node local/vps.mjs setup --model sonnet --effort medium && node local/vps.mjs apply   # ganti model/effort tanpa build ulang
node local/vps.mjs status | logs [--follow] | password
```

- **Kredensial seperti pemakai CLI.** Claude Code dipasang dengan installer resmi Anthropic untuk user `arsip`, versi sama dengan Mac,
  dan login dengan `claude auth login` (langganan Claude). Login tersimpan dan diperbarui oleh CLI sendiri di `/home/arsip`; tidak ada
  API key atau token yang disalin. `login`, `push`, dan `status` menampilkan akun VPS dan Mac berdampingan dan memberi peringatan bila berbeda.
- **Kunci mesin di VPS** (`ARSIP_ALLOW_VPS=1` dari unit systemd): selain zona waktu Indonesia dan `/etc/machine-id`, server membaca
  metadata Tencent (`placement/region` harus `ap-jakarta`, `instance-id` ikut di-hash ke kunci). Disk yang disalin ke instance atau
  region lain tidak pernah start. Metadata tidak terbaca = tidak start. Penyedia lain belum didukung.
- Gagal kunci mesin atau login bukan langganan: exit 78, systemd tidak mengulang (`RestartPreventExitStatus=78`). Status login yang tidak
  terbaca sementara (timeout, update CLI): exit 1, diulang tiap 10 detik.
- Di VPS hanya listener bersandi (`127.0.0.1:8018` di belakang Caddy) yang dibuka; tidak ada listener tanpa sandi.
  Endpoint statistik/impor tidak tersedia di VPS.
- `push` mengirim berkas Git (tercatat dan baru yang tidak diabaikan) kecuali `docs/`, `reports/`, `tests/`, `.env*`, `.local/`.
  Dari `.env.chat` hanya `DATACAT_API_KEY` dan `CHAT_METRICS_TOKEN` yang dikirim (key OpenRouter tetap di Mac). Build berjalan di salinan
  baru selagi server lama tetap melayani; database chat dan kunci dipindah, lalu server baru dijalankan. Bila gagal, versi lama dipulihkan.
- Host key SSH dicocokkan dengan `--host-key` (StrictHostKeyChecking=yes, `.local/known_hosts`), supaya kode login Claude, arsip, dan key
  hanya sampai ke server itu.
- Kata sandi perangkat: `.local/vps.json` (hash scrypt, izin 600); `password` membuat yang baru dan mengeluarkan semua perangkat.
- Bootstrap root tidak menyentuh jalur di dalam folder milik `arsip` (symlink). Unit: `ProtectSystem=strict`, `PrivateTmp`,
  `NoNewPrivileges`, tulis hanya `/srv/arsip` dan `/home/arsip`. Bawaan `--concurrency 4` (2 analisis) dengan swap; ±1,3 GB terpakai saat penuh.
- Yang dapat dilihat penyedia VPS (root/agen Tencent `tat_agent`, `YDService`, `barad_agent`): login Claude, arsip, key datacat, isi
  percakapan. Itu harga menjalankan Claude tanpa Mac; mode tunnel di bawah menyimpan semuanya di Mac.

### Akses dari perangkat lain lewat VPS Jakarta, Claude tetap di Mac (`local/remote.mjs`)

```
perangkat (ponsel/laptop/tablet) --HTTPS--> VPS Jakarta (Caddy) --127.0.0.1:18017--> tunnel SSH dari Mac --> Mac 127.0.0.1:8018 (wajib kata sandi)
```

Claude tetap hanya dipanggil dari Mac. VPS tidak menyimpan login Claude maupun arsip; ia hanya membuka HTTPS dan
meneruskan ke tunnel yang dibuka Mac. Kunci tunnel hanya boleh membuka satu forward itu (tanpa shell). Mac tidak membuka port publik.

```bash
node local/remote.mjs setup --vps <ip-vps> --domain arsip.seekingomega.capital   # kunci SSH, kata sandi, .local/vps-setup.sh
# DNS: A record domain -> IP VPS. Lalu di VPS (Debian 12 / Ubuntu 24.04, root):
scp .local/vps-setup.sh root@<ip-vps>:/root/ && ssh root@<ip-vps> bash /root/vps-setup.sh
node local/remote.mjs install     # server + tunnel jalan sekarang dan otomatis saat login (launchd)
# perangkat mana pun: buka https://<domain>, masukkan kata sandi sekali (sesi 30 hari per perangkat)
```

- Kata sandi dibuat acak (±100 bit), ditampilkan sekali, disimpan sebagai hash scrypt di `.local/remote.json` (izin 600).
  `node local/remote.mjs password` membuat sandi baru dan mengeluarkan semua sesi di semua perangkat (cara memutus perangkat yang hilang).
- Banyak perangkat boleh masuk bersamaan. Analisis yang berjalan serentak dibatasi `--concurrency`/2 untuk seluruh perangkat
  (bawaan 2); perangkat berikutnya mendapat pesan slot penuh. Naikkan dengan `--concurrency 8` (maks 4 analisis), dengan risiko batas langganan Claude lebih cepat tercapai.
- Pemeriksaan sandi berjalan di Mac, bukan di VPS. Tanpa sesi, semua halaman, berkas, dan `/api/` ditolak. Cookie
  `__Host-…; Secure; HttpOnly; SameSite=Strict`, ditandatangani HMAC. Masuk hanya dari origin domain itu; 5 kali gagal per
  alamat per 15 menit, 30 kali gagal total per jam (lalu semua percobaan menunggu). Endpoint statistik/impor hanya lokal.
- Listener lokal `127.0.0.1:8017` tetap tanpa sandi untuk Mac sendiri. Kunci mesin dan pemeriksaan zona tetap berlaku.
- `install` memasang dua LaunchAgent (`capital.seekingomega.arsip.server` dengan `caffeinate -s`, dan `…tunnel`), log di
  `~/Library/Logs/arsip-*.log`. Mac harus menyala dan tersambung; dengan daya listrik Mac tidak tidur, tetapi menutup
  layar MacBook tetap membuatnya tidur. `status` dan `uninstall` tersedia. Hentikan server manual sebelum `install`.
- Tunnel memakai kunci `~/.ssh/arsip_tunnel` dan host key VPS dicatat saat koneksi pertama (`.local/known_hosts`);
  cocokkan dengan sidik jari yang dicetak skrip VPS.
- Jika VPS mati atau tunnel putus, akses dari perangkat lain ikut mati; tidak ada jalur cadangan ke luar Indonesia.
- Yang terlihat oleh VPS: isi lalu lintas setelah HTTPS dibuka (pertanyaan, jawaban, halaman arsip). Pilih VPS milik sendiri.

Uji tanpa jaringan (CLI tiruan, tidak memakai langganan): `node --test tests/local_server.mjs`.

## Harga penutupan (`tools/sync_prices.py`)

Membaca `Close 1D` dari `../chatgptrisetkeystat/dataset_broksum_20261003_recovered/stockbit_<KODE>_metrics.csv` (ubah dengan `BROKSUM_DIR`), hanya baca,
untuk setiap tanggal snapshot KSEI di `kepemilikan.json`: harga as-of (baris terakhir ≤ tanggal, maksimal 7 hari sebelumnya), belum disesuaikan aksi korporasi.
Hasil `needtobeindexed/harga/harga.json` (±35 KB) disalin build ke `files/kepemilikan/harga.json` dan dimuat bersama data kepemilikan; file tidak ada,
rusak, atau emiten tanpa harga (±650 dari ±980 emiten punya harga) membuat viewer memakai lot. Jalankan setelah `tools/sync_idx.py` bila ada bulan KSEI baru:

```bash
python3 tools/sync_prices.py && python3 build.py
```

## Sinkron dari IDX Signal Desk (`tools/sync_idx.py`)

Menyalin data dari aplikasi lokal `idx-digest gui` (default `http://127.0.0.1:8787`, ubah dengan `--server` atau env `IDX_SIGNAL_DESK`)
ke `needtobeindexed/idx-signal-desk/`, lalu menjalankan `build.py` kalau ada yang berubah.

```bash
python3 tools/sync_idx.py                 # sekali
python3 tools/sync_idx.py --ownership-only # perbarui kepemilikan saja, tanpa merender ulang digest
python3 tools/sync_idx.py --watch 15      # tiap 15 menit, biarkan jalan di tab Terminal
python3 tools/sync_idx.py --fragment-index <scratchpad>/artifact/index.html   # sekalian siapkan publish Artifact
```

- `digest_<awal>_<akhir>[_HHMM-HHMM].md` (**dipensiunkan**; hanya dengan `--with-digests`): satu per jendela di *Library → Summary
  Windows*, isi = `POST /api/share/render` (format md, semua digest per emiten). Baris judul diganti supaya tiap berkas bisa dibedakan.
  Akhiran jam dipakai kalau jendela tidak 00:00–23:59 (mis. `_0000-1959`). Berkas digest yang ada tidak pernah dihapus sinkron.
- `kepemilikan.json`: semua bulan sekaligus (laporan emiten sejak Mei 2023 dan bulan KSEI), dari `GET /api/ownership` dan `/api/ownership/<KODE>?profile_id=…`:
  per emiten per bulan akumulasi >1%, pemegang >1% (baris dengan nama investor sama dijumlahkan), catatan data KSEI, free float resmi,
  jumlah pemegang, pemegang ≥5% gabungan, dan status laporan emiten, masing-masing dengan penanda terverifikasi.
- `kepemilikan-laporan.json`: daftar pemegang saham laporan emiten (nama, peran, lembar, persen; tanpa alamat; bulan dengan daftar persis sama
  menunjuk bulan sebelumnya), jenis pemilik BAE, dan tautan laporan di IDX (tanpa awalan `base`). Bentuknya di docstring `ownership_data()`.
  Tiap investor KSEI punya nomor yang sama lintas bulan: nama sama atau variasi nama dengan kata inti lengkap yang sama dan pasangan unik,
  termasuk saat jumlah saham berubah (mis. `LO KHENG HONG. DRS` / `DRS LO KHENG HONG`). Nomor/penanda rekening dipertahankan;
  nama yang hanya mirip atau sebagian sama tidak otomatis digabung. Identitas ambigu diberi catatan dan tidak dipakai untuk kesimpulan perubahan.
  Bentuknya dijelaskan di docstring `ownership_data()`; kalau diubah, naikkan `OWNERSHIP_FORMAT` / `REPORTS_FORMAT`.
  Berkas lama `kepemilikan_<tanggal>.md` (format sebelum 15 Sep 2026) dihapus otomatis. `/api/ownership` hanya mendaftar emiten yang punya laporan emiten,
  jadi daftar kode emiten KSEI (mis. ASII, BMRI) dan identitas file KSEI aktif dibaca langsung dari
  `<data_dir profil>/ownership/ledger.sqlite3` dalam mode read-only. Kalau ledger tidak terbaca, hanya emiten dari `/api/ownership` yang disalin.
- `kepemilikan-perubahan.json`: field `filings` dan `ownership_audit` dari `/api/ownership/<KODE>` (hasil `idx-digest ownership-backfill`),
  hanya kolom yang ditampilkan (lihat docstring `filing_rows()`). Catatan audit global (bulan belum lengkap, unduhan gagal) tidak ditempel per laporan;
  cakupan unduhan ditulis sekali. Tanggal di luar 2023–hari ini dikosongkan dan diberi catatan. Sinkron berikutnya berjalan saat jumlah/waktu
  pembaruan tabel `filings` atau jumlah PDF terunduh di ledger berubah. Publikasikan setelah backfill selesai supaya daftar tidak tampil setengah.
- Disamarkan otomatis (di digest dan kepemilikan): nomor HP Indonesia (`08…`, `+62 8…`) dan kode akses rapat (`Passcode: …`, `pwd=…`),
  karena arsip bisa dibagikan lewat link. Nama, alamat, dan angka dari pengumuman tidak diubah. Setelah mengubah pola di `REDACTIONS`, jalankan sekali dengan `--force`.
- Hanya endpoint baca. `/api/share/export` sengaja **tidak** dipakai karena menulis berkas ke `data/share/` scraper. Skrip tidak memicu scraping.
- Hemat: jendela yang `updated_at`/jumlah emitennya sama tidak dirender ulang; kepemilikan hanya diambil ulang kalau ringkasan `/api/ownership`
  atau file KSEI aktif di ledger berubah.
  Status disimpan di `needtobeindexed/idx-signal-desk/.sync.json`. `--force` merender ulang semuanya.
- Berkas lama `kepemilikan_*.md` dihapus saat `kepemilikan.json` ditulis. Berkas `digest_*.md` tidak lagi dihapus (dipensiunkan; tautan lama tetap jalan).
- Profil: yang pertama kali disinkron dicatat di `.sync.json`. Kalau profil aktif di Signal Desk berbeda, sinkron dilewati (exit 2)
  supaya data profil lain tidak menimpa. Profil aktif dicek lagi sebelum menghapus berkas lama dan sebelum menyimpan status. Ganti sengaja dengan `--profile <id>`.
- Sinkron menyusun hasil di direktori sementara terlebih dahulu. Penjagaan profil dan keberhasilan seluruh pengambilan diperiksa sebelum menulis tujuan. Perubahan bersamaan pada tujuan membatalkan commit; kegagalan commit biasa dipulihkan dari snapshot. Ini bukan transaksi atomik terhadap mati listrik/SIGKILL di tengah beberapa berkas. Berkas sementara memakai nama acak dan tujuan symlink ditolak.
- HTTP hanya diizinkan untuk loopback; server jauh harus HTTPS, tanpa kredensial di URL dan tanpa redirect. Respons maksimal 32 MB. Path ledger lokal hanya dipakai untuk server loopback dan SQLite dibuka read-only.
- Exit code: 0 ok, 1 server tidak bisa dihubungi / HTTP error / data tak terduga / ekspor Stockbit ditolak, 2 profil beda, 3 build gagal.
  Mode `--watch` terus jalan walau satu putaran gagal. Dengan `--fragment-index`, build selalu dijalankan supaya fragment Artifact ikut kode terbaru.
- Publish ke Artifact tetap lewat Claude Code (skrip tidak bisa memanggil tool Artifact): minta "publish" setelah sinkron.
  Untuk host yang bisa di-deploy dari skrip (Cloudflare Pages dll.), jalankan perintah deploy setelah sinkron.

### Ringkasan Stockbit Ideas (`--stockbit-only`, publish sekali klik, rollback)

```bash
python3 -B tools/sync_idx.py --stockbit-only --no-build   # hanya Stockbit; tanpa profil, digest, kepemilikan
python3 -B tools/sync_idx.py --with-stockbit              # sinkron biasa, lalu Stockbit (staging terpisah)
python3 -B tools/publish_stockbit.py --dry-run            # preflight + sinkron + cek build, tanpa VPS/commit
python3 -B tools/publish_stockbit.py                      # publish live (dipanggil desk saat "Publikasikan live" dicentang)
python3 -B tools/rollback_stockbit.py --dry-run           # lihat rencana rollback publish terakhir
python3 -B tools/rollback_stockbit.py [--tag stockbit-publish-YYYYMMDD-HHMMSS]
```

- Sumber: endpoint read-only Signal Desk `GET /api/stockbit/export/days|day/<tgl>?kind=ringkas|detail|week/<senin>|index|withheld`
  (tanpa `profile_id`, tanpa LLM). Sinkron biasa tidak menyentuh Stockbit kecuali diberi `--with-stockbit`.
- Berkas: `sbringkas_<tgl>_<tgl>.md` (ringkasan harian, default chat), `sbdetail_<tgl>_<tgl>.md` (semua temuan per emiten),
  `sbpekan_<senin>_<minggu>.md` (hanya pekan yang ketujuh harinya final dan server menjawab selain 404), dan `stockbit-index.json`.
  Status sendiri di `.sync-stockbit.json` (tanpa cap waktu, jadi tidak ada commit kalau isi tidak berubah); ikut staging dan rollback yang sama dengan `.sync.json`.
- Hanya hari `final` sejak `--stockbit-since` (default 2026-10-01); `--allow-provisional` mengikutkan hari `sementara` (jangan untuk publish;
  `export/day` dan `export/index` lalu diminta dengan `include_provisional=1`). Indeks desk tidak punya batas awal: hari sebelum
  `--stockbit-since` (yang belum terbit) dan hari yang ditahan rollback dibuang dari `stockbit-index.json`, dayIdx dipetakan ulang.
- Tahanan rollback `.stockbit-hold.json` (`{"format":1,"days":{tgl:{"sha256":…}}}`, ditulis `rollback_stockbit.py`): hari itu tidak
  diterbitkan lagi selama sha di `export/days` sama (atau `"*"`). Desk harus memperbaiki dan memfinalkan ulang hari itu (sha baru), atau
  hapus entrinya, sebelum hari itu bisa terbit lagi.
- "Tahan dari web" di desk: `export/withheld` (`{"days":[tgl…],"llm_calls":0}`; jawaban rusak menolak sinkron). HTTP 404 (desk lama
  atau belum di-restart) berarti "tidak diketahui": tahanan desk yang sudah tercatat tetap berlaku (peringatan dicetak); tanda desk
  hanya dilepas oleh desk yang punya endpoint ini dan tidak lagi mendaftar hari itu. Hari yang ditahan dan belum terbit tidak diterbitkan. Hari yang sudah terbit dicabut:
  `sbringkas_`/`sbdetail_` hari itu dan `sbpekan_` yang memuat hari itu dihapus (lewat staging yang sama; sinkron yang ditolak tidak
  menghapus apa pun), status hari/pekannya dibuang dari `.sync-stockbit.json`, harinya dibuang dari indeks, dan dicatat di
  `.stockbit-hold.json` sebagai `{"sha256":"*","withheld_by":"desk"}` (digabung dengan tahanan rollback; entri rollback tidak pernah dihapus,
  paling banter diberi `withheld_by`). Begitu desk melepasnya, hanya tanda desk itu yang dibuang dan hari itu (serta pekannya) diambil ulang
  karena berkasnya hilang. Hari yang dicabut tidak dihitung sebagai "sudah terbit" oleh penjaga jumlah hari.
- `user_notes[akun]` boleh membawa `benang` (`{"text", "finding_ids"}`, satu kalimat yang menghubungkan temuan lintas hari) dan
  `based_on` (`{"findings": n, "last_day": tgl}`); viewer `#pengguna=` menampilkannya di kotak penilaian ("Benang lintas hari",
  "Berdasarkan n temuan s.d. …" menggantikan baris "Jendela:"). Id `penilaian`/`benang` harus ada di baris `users` yang terbit
  (selain itu ditolak). Saat hari dibuang dari indeks (sebelum `--stockbit-since`, ditahan rollback/desk), catatan akun yang merujuk
  temuan hari itu atau yang `based_on.last_day`-nya hari itu dibuang utuh.
- Ditolak (exit 1, tidak ada berkas yang ditulis) bila: tanggal/nama berkas tidak sesuai pola, `build.categorize()` tidak memberi kategori
  `stockbit-ringkasan|stockbit-detail|stockbit-pekan` yang cocok, `ok` cakupan bukan true, sha256 tidak cocok dengan teks,
  teks/indeks masih memuat stream_id karantina (tautan `stockbit.com/post/<id>` atau angka lepas), indeks menunjuk hari yang tidak terbit,
  `penilaian`/`benang` di `user_notes` tanpa teks atau `finding_ids`, `based_on` tanpa `findings` ≥ 0 dan `last_day` yang valid, atau server
  mengekspor lebih sedikit hari final daripada `sbringkas_*` yang sudah terbit (di luar hari yang ditahan).
  `REDACTIONS` diterapkan setelah cek hash. Berkas `sb*` tidak pernah di-prune; yang menghapusnya hanya tahanan desk di atas dan rollback.
- `publish_stockbit.py` (cwd akar arsip): situs live = VPS (`node local/vps.mjs push`), GitHub = riwayat; Worker Cloudflare tidak disentuh.
  Preflight (git & node ada di PATH, `.local/vps.json` ada, cabang `main`, tidak ada yang di-stage, perubahan hanya berkas Stockbit
  di `needtobeindexed/idx-signal-desk/` (`sb*.md`, `stockbit-index.json`, `.sync-stockbit.json`, `.stockbit-hold.json`; berkas titik lain seperti
  `.sync.json` dibiarkan dan tidak di-commit), `docs/`, `site/`; `digest_*`/`kepemilikan*` yang belum di-commit menolak publish, tidak ada commit
  lokal yang belum dipush, `git fetch` + `git pull --ff-only`, disk ≥ 1,5 GB), catat HEAD, sinkron `--stockbit-only --no-build --with-bei`
  (BEI ikut di staging yang sama, lihat bagian BEI di bawah; tidak ada berkas Stockbit/BEI yang berubah terhadap HEAD → selesai "tidak ada perubahan", tanpa build/VPS/commit; berkas dari putaran gagal sebelumnya tetap
  terhitung berubah), `build.py --out <folder sementara>` lalu cek tiap `sb*` masuk kategori dan tanggal yang benar (tabelnya dicetak),
  `build.py --out docs` (tanpa `CHAT_API_URL`, `BASE_URL=https://arsip.seekingomega.capital`), lalu `node local/vps.mjs push` **sebelum commit**
  (gagal → vps.mjs memulihkan versi lama, exit 5, tidak ada commit; jalankan ulang; sebelumnya penjaga `sb*` terhapus diulang pada `docs/`
  hasil build: salinan `sb*` yang hilang tanpa tahanan desk → `docs/` dikembalikan, exit 7, VPS tidak disentuh), `git add` hanya berkas Stockbit tadi plus folder hasil build
  yang masih dilacak Git (`docs/`; `site/` hanya pada checkout lama), berhenti kalau ada `sb*` terhapus (kecuali berkas hari yang ditahan desk menurut `.stockbit-hold.json` yang ikut di-commit, termasuk salinannya di `docs/`/`site/`
  yang dibangun ulang tanpa hari itu; harinya dicatat sebagai `withheld` di log), commit `Stockbit: ringkasan <tanggal>` (atau `Stockbit: tahan <tanggal> dari web`), push (sekali `git pull --rebase` bila ditolak),
  tag beranotasi `stockbit-publish-YYYYMMDD-HHMMSS`, push tag. `site/` kini diabaikan Git; hanya `docs/` yang di-commit. Kompatibilitas `site/` terlacak dipertahankan untuk checkout lama.
  Exit: 0 ok/tidak ada perubahan, 2 preflight, 3 sinkron, 4 cek build/build `docs/`, 5 push VPS gagal atau sisa waktu tidak cukup
  (situs versi lama, tanpa commit), 6 VPS sudah diperbarui tapi commit gagal (situs mendahului git; berkas yang sudah di-stage dilepas
  lagi, jadi publish ulang atau rollback bisa langsung jalan), 7 ada `sb*` terhapus tanpa tahanan desk, 8 commit lokal ada tetapi push git
  gagal atau terputus (`push_failed`, VPS sudah live; publish ulang ditolak preflight selama commit itu belum dipush: push manual
  `git push origin HEAD:main` (boleh setelah `git pull --rebase`; rollback mengenali salinannya) atau `rollback_stockbit.py`; juga bila
  push berhasil tetapi tag gagal dibuat, status tetap `published`),
  1 lain-lain. Baris terakhir keluaran = ringkasan JSON (`"vps": true` bila VPS sudah diperbarui).
  Batas waktu: per langkah, ditambah anggaran total di bawah batas desk (`PUBLISH_BUDGET` 3.420 dari 3.600 detik; `ROLLBACK_BUDGET`
  1.680 dari 1.800 detik) supaya penanganan batas waktu skrip sendiri yang berjalan, bukan SIGKILL dari desk. Push VPS mendapat sisa
  anggaran (publish menyisakan 10 menit untuk commit/push) dan tidak dimulai kalau sisanya < 5 menit. `node local/vps.mjs push` berjalan
  di grup proses sendiri; saat batas waktu, node beserta ssh/tar di bawahnya dimatikan bersama.
- Titik rollback dicatat di `.stockbit-publish/log.jsonl` (diabaikan git): `target: "vps"`, `vps`, `pre_sha`, `post_sha` (tepat satu commit publish),
  tag, `supersedes`, `files`, `day_shas` (`{tgl: sha256 ekspor}` hari harian yang dikirim putaran itu, dibaca sebelum push VPS), `withheld`, status (`published`, `vps_failed`, `vps_not_committed`, `push_failed`, `gagal`, `tidak ada perubahan`).
  Publish berikutnya setelah `vps_not_committed` yang belum di-rollback meng-commit berkasnya dan mencatatnya di `supersedes`.
  Catatan lama dengan `worker_version_*`/`rollback_to` dan status `deployed_*` tetap terbaca. `rollback_stockbit.py` memakai entri terakhir
  (atau `--tag`, ditolak selama ada publish lebih baru yang belum di-rollback):
  - `published`: `git revert --no-commit <pre_sha>..<post_sha>` + tahanan + satu commit + push (tanpa force push, riwayat tetap ada). `docs/`/`site/`
    yang kotor dibuang dulu (hasil build), berkas titik non-Stockbit seperti `.sync.json` dibiarkan, berkas dilacak lain yang kotor menolak;
    rentang yang menyentuh selain berkas Stockbit/`docs/`/`site/` ditolak.
  - `push_failed` yang commit-nya tidak pernah sampai ke origin: `git reset --keep <pre_sha>` (tanpa push). Kalau HEAD bukan commit itu karena
    pemilik sudah `git pull --rebase` + push manual, salinannya di origin/main dicari (subjek sama dan `git cherry`/patch-id setara, harus tepat
    satu); yang di-revert hanya salinan itu (`<induk>..<salinan>`, commit orang lain di antaranya tidak ikut) dan dicatat sebagai `rebased_from`.
    Tidak ketemu: ditolak (exit 2), rollback manual. Commit revert rollback yang dipush manual setelah rebase dikenali dengan cara yang sama.
  - `vps_not_committed` (dan status lama `deployed_index_pending`/`deployed_not_committed`): berkas Stockbit yang kotor
    dikembalikan ke HEAD (yang baru dihapus), `docs/`/`site/` dikembalikan; yang ditahan hanya hari dari berkas yang tercatat di publish itu
    (`files`), bukan berkas kotor dari sinkron sesudahnya, dengan sha dari `day_shas` publish itu (bukan `.sync-stockbit.json` pohon kerja
    yang mungkin sudah ditulis ulang sinkron sesudahnya; catatan lama tanpa `day_shas`: `"*"`, ditahan sampai entrinya dihapus).
    Tahanan di dua cara ini belum di-commit dan ikut publish berikutnya.
  - Semua cara, termasuk putaran ulang, ditolak (exit 2) sebelum ada yang diubah bila cabang bukan `main`, ada yang di-stage, atau ada perubahan
    (dilacak atau berkas baru) di luar berkas Stockbit/`docs/`/`site/`/berkas titik non-Stockbit: `vps.mjs push` mengirim pohon kerja apa adanya,
    jadi kode atau dokumen yang belum di-commit akan ikut live. Commit atau kembalikan dulu. Juga ditolak bila git masih di tengah revert
    (REVERT_HEAD/sequencer; jalankan `git revert --abort`). Batas waktu di tengah `git revert`/`git commit` rollback langsung menjalankan
    `git revert --abort` (di luar anggaran total). Putaran ulang `partial`/`push_failed` juga ditolak bila berkas Stockbit selain
    `.stockbit-hold.json` kotor (sisa sinkron/publish sesudahnya yang belum lolos cek build; kembalikan dulu), dan `docs/`/`site/` dikembalikan
    ke HEAD sebelum push VPS.
  - Publish yang mencabut hari yang ditahan desk (`withheld` di log) tidak bisa di-rollback (exit 2, tidak ada yang diubah): membatalkannya
    akan menerbitkan lagi hari itu. Pakai desk: tahan hari lain yang ingin dicabut, atau lepas tahanannya, lalu publish.
  - Tahanan rollback digabung ke entri yang ada (tanda `withheld_by=desk` tetap). Hari yang berkasnya justru dihapus publish itu
    (tahanan desk) tidak ditahan rollback; sinkron berikutnya mengikuti daftar tahanan desk lagi.
  - Lalu `node local/vps.mjs push` dari pohon yang sudah dikembalikan (juga bila push git revert gagal). Worker Cloudflare tidak pernah disentuh;
    catatan lama dengan `worker_version_*` hanya diberi keterangan. Catatan `partial` ditulis sebelum push VPS dengan `"interim": true`
    (desk menyembunyikannya bila catatan akhir dengan `started_at` yang sama ada); rollback `partial` (push VPS
    gagal, atau skrip dihentikan di tengah push VPS) boleh dijalankan ulang: langkah git dilewati, push VPS diulang. Rollback `push_failed`
    (exit 4) juga: commit revert yang sudah dipush manual langsung lanjut ke push VPS, yang masih di lokal (HEAD = commit revert) dipush dulu;
    revert tidak diulang. Exit: 0 ok, 2 ditolak (termasuk node/`.local/vps.json` tidak ada), 3 revert/reset gagal, 4 push git gagal
    (commit revert di lokal; jalankan skrip ini lagi), 5 push VPS gagal atau sisa waktu tidak cukup setelah git dikembalikan (jalankan skrip ini lagi).
  Riwayat GitHub publik tetap menyimpan versi lama; penghapusan isi butuh langkah terpisah.

### Ringkasan keterbukaan BEI (`--bei-only`, ikut publish sekali klik)

```bash
python3 -B tools/sync_idx.py --bei-only --no-build                   # hanya BEI
python3 -B tools/sync_idx.py --stockbit-only --with-bei --no-build   # Stockbit + BEI dalam satu staging (dipakai publish_stockbit.py)
python3 -B tools/sync_idx.py --with-bei                              # sinkron biasa, lalu BEI (staging terpisah)
```

- Kontrak: `docs/BEI_PIPELINE_PLAN.md` di repo IDX Signal Desk. Sumber: endpoint read-only `GET /api/bei/export/days|day/<tgl>?kind=ringkas|detail|
  week/<senin>|index|withheld` (tanpa profil, tanpa LLM; `llm_calls` bukan 0 ditolak). Klon aturan Stockbit di atas:
  `beiringkas_<tgl>_<tgl>.md`, `beidetail_<tgl>_<tgl>.md`, `beipekan_<senin>_<minggu>.md` (hanya pekan yang ketujuh harinya final dan server
  tidak menjawab 404; hari tercakup tanpa pengumuman di `export/days` (`announcements: 0`, tanpa berkas) ikut melengkapi pekan),
  `bei-index.json` (format 1: `days`, `tickers{KODE:[[hariIdx, n, nonrutin, status, tahap, delta, {kategori:n}, [id…], petunjuk_bagian?]]}`,
  `names`), status `.sync-bei.json`, tahanan `.bei-hold.json` (bentuk sama dengan `.stockbit-hold.json`).
- Desk tanpa `/api/bei` (HTTP 404 pada `export/days`): BEI dilewati dengan pesan, tidak ada berkas BEI yang diubah, Stockbit tetap jalan.
- Profil: `profile_id` dari ekspor desk dicatat di `.sync-bei.json` pada sinkron BEI pertama. Ekspor dari profil lain (profil aktif desk
  berganti, juga di tengah sinkron) = BEI dilewati dengan peringatan, tidak ada berkas BEI yang ditulis atau dihapus, Stockbit tetap jalan;
  `publish_stockbit.py` melaporkannya sebagai `bei_skipped`. Pindah profil dengan sengaja: `--bei-profile <id>`. Desk yang tidak menyebut
  `profile_id` = tidak diketahui (perilaku lama).
- Hanya hari `final` (atau `sementara` dengan `--allow-provisional`); `--bei-since` membuang hari sebelum tanggal itu (default: semua hari
  final desk). Tahanan rollback berlaku selama `sha256` ekspor sama. "Tahan dari web" di desk (`export/withheld`) mencabut berkas hari itu
  dan pekannya, ditandai `withheld_by=desk`; 404 = tahanan desk yang tercatat tetap berlaku.
- Ditolak (exit 1, tidak ada yang ditulis; dengan `--stockbit-only --with-bei` BEI dikembalikan utuh dan dilewati, Stockbit tetap ditulis) bila: nama/tanggal tidak sesuai pola atau tidak
  sesuai `files` di `export/days`, `build.categorize()` tidak memberi `bei-ringkasan|bei-detail|bei-pekan`, `ok` bukan true, sha256 tidak
  cocok, indeks menunjuk hari yang tidak terbit, kode/baris/nama di indeks tidak sesuai format 1, atau server mengekspor lebih sedikit hari
  final daripada `beiringkas_*` yang sudah terbit. `REDACTIONS` diterapkan setelah cek hash (juga ke indeks). Berkas `bei*` tidak pernah di-prune.
- `publish_stockbit.py` menjalankan `sync_idx.py --stockbit-only --no-build --with-bei` (+ `--stockbit-since <tgl>` dari desk; BEI tidak
  memakai batas itu) dalam alur VPS yang sama di atas: satu publish, satu `node local/vps.mjs push` sebelum commit, satu commit, satu tag,
  satu log rollback untuk keduanya; Worker Cloudflare tetap tidak disentuh. Allowlist ditambah `bei*.md`, `bei-index.json`, `.sync-bei.json`,
  `.bei-hold.json`; "tidak ada perubahan" dihitung atas berkas Stockbit dan BEI terhadap HEAD; penjaga hapus berlaku untuk keduanya (sebelum
  push VPS, pada `docs/` hasil build, dan di index; tahanan BEI dibaca dari `.bei-hold.json`, tahanan satu keluarga tidak pernah mengizinkan
  penghapusan berkas keluarga lain); cek build memeriksa kategori/tanggal `bei*`; pesan commit menambahkan `BEI: ringkasan <tgl>` (atau
  `BEI: tahan <tgl> dari web`) bila ada berkas BEI. Log mencatat `day_shas_bei` (sha ekspor hari BEI yang dikirim ke VPS, pendamping
  `day_shas`) dan hari BEI yang dicabut sebagai `withheld_bei` (rollback ditolak, seperti `withheld`). Ringkasan JSON selalu memuat
  `"supports": ["stockbit", "bei"]` (desk memakainya untuk tahu arsip ini menerbitkan BEI) dan `bei_skipped` (baris "BEI dilewati" dari
  sinkron) bila BEI dilewati sementara Stockbit tetap terbit.
- `rollback_stockbit.py` membalik rentang yang menyentuh berkas Stockbit/BEI dengan aturan VPS yang sama (revert/reset/restore, lalu
  `node local/vps.mjs push`); hari BEI yang dibawa publish ditahan di `.bei-hold.json` (cara restore: sha dari `day_shas_bei`, catatan lama
  `"*"`), dicatat sebagai `held_bei`. Putaran ulang ditolak bila berkas Stockbit/BEI selain `.stockbit-hold.json`/`.bei-hold.json` kotor.
- Chat: Digest Emiten tidak lagi diindeks (nama resmi emiten yang ditulisnya tetap dipakai untuk mengecek nama); `bei-ringkasan` dan
  `bei-pekan` prioritas normal, `bei-detail` `priority: low` dan hanya dibaca untuk pertanyaan ticker/"detail". Kata "bei", "ki",
  "keterbukaan" membaca keluarga Indonesia (ringkasan BEI dan rekap pekan; Analisis KI lama dibuang hanya bila berkas BEI
  yang dibaca mencakup setiap hari yang dicakupnya: `ki_07102026` mencakup 6–7 Oktober, jadi tetap ikut untuk "7 Oktober").
  Di samping ringkasan/rekap BEI, KI dikirim sebagai kepala buatan kode (pembuka, tabel update, judul tiap pembahasan;
  maksimal 14 KB); utuh bila diminta "KI lama"/"analisis KI"/`ki_…` atau seluruh temuan; "terbaru" memilih ringkasan BEI terbaru. Cakupan discovery bawaan: `bei-ringkasan`, `keterbukaan-informasi`, `stockbit-ringkasan`, `stockbit`.

---

## Cara host ulang

Semua opsi di bawah cukup memakai **isi folder `site/`** (dengan `index.html` di root).

### A. Claude Artifact (host saat ini, privat, butuh login claude.ai)

URL saat ini: https://claude.ai/artifact/6GLPJkECXVVEUdim73AQug

Langkah untuk Claude Code:
1. **Baca setiap file baru atau berubah di `needtobeindexed/` sebelum publish** (aturan tool Artifact: jangan publish isi yang belum dibaca).
   Berkas `idx-signal-desk/` besar (±16 MB); bagi ke beberapa subagent pembaca bila perlu.
2. `python3 build.py --fragment-index <scratchpad>/artifact/index.html`
3. Panggil tool `Artifact` (publish):
   - `file_path`: fragment tadi (bukan `site/index.html`, karena Artifact membungkus sendiri dengan `<html><head><body>`)
   - `url`: URL di atas, supaya link tetap sama. Kalau artifact sudah dihapus, jangan isi `url`, lalu isi `favicon: "🗂️"`.
   - `files`: satu entri per file di `site/files/`, dengan path publish = path relatif yang sama:
     ```json
     {
       "files/keterbukaan-informasi/2026-09-15/ki_20260915.md": {"from": "site/files/keterbukaan-informasi/2026-09-15/ki_20260915.md", "contentType": "text/plain"},
       "files/stockbit/2026-09-13/stockbit_review_2026-09-13_14.html": "site/files/stockbit/2026-09-13/stockbit_review_2026-09-13_14.html"
     }
     ```
     `.md` **wajib** `"contentType": "text/plain"` (persis, tanpa `; charset=...`). Selain itu publish ditolak.
     `files/kepemilikan/*.json` (kepemilikan, kepemilikan-laporan, kepemilikan-perubahan, harga) pakai `"contentType": "application/json"`.
     File yang sudah dihapus dari sumber harus dikirim sebagai `null` supaya ikut hilang.
4. Kalau mau diindeks mesin pencari, jangan pakai opsi ini karena artifact privat. Pakai B/C/D.

### B. GitHub Pages (gratis, publik)

```bash
python3 build.py --out docs          # atau BASE_URL=https://<user>.github.io/<repo> python3 build.py --out docs
git init && git add . && git commit -m "Arsip Riset IDX"
gh repo create arsip-riset-idx --public --source . --push
```
Lalu di GitHub: Settings → Pages → Source: *Deploy from a branch* → `main` / `/docs`.
Tiap update: build ulang, commit, push.

### C. Netlify / Cloudflare Pages / Vercel (satu perintah)

```bash
python3 build.py
npx netlify-cli deploy --dir site --prod                       # atau drag-drop folder site/ ke https://app.netlify.com/drop
npx wrangler pages deploy site --project-name arsip-riset-idx  # Cloudflare Pages
npx vercel deploy site --prod                                  # Vercel
```

### D. Server sendiri / lokal

```bash
python3 -m http.server -d site 8000     # atau copy site/ ke folder web nginx/apache mana pun
```
Membuka `site/index.html` langsung dengan dobel klik (`file://`) juga bisa, tapi dokumen >256 KB tidak bisa dibuka/dicari dari sana.

### Supaya mudah diindeks Google (host publik saja)

1. Build dengan `BASE_URL` domain final: `BASE_URL=https://domainmu python3 build.py`
2. Pastikan `https://domainmu/sitemap.xml` dan `robots.txt` bisa dibuka.
3. Daftarkan sitemap di Google Search Console.
   Sitemap berisi halaman utama dan setiap file mentah `files/…/*.md`, yang diindeks Google sebagai teks.

---

## Checklist agent saat ada file baru

1. Pastikan nama file mengikuti `stockbit_YYYYMMDD.md` / `ki_YYYYMMDD.md`. Kalau tidak, tanyakan atau tambah aturan di `CATEGORIES`.
   Data Signal Desk: jangan disalin manual, jalankan `python3 tools/sync_idx.py`.
2. `python3 build.py`, lalu cek baris output: kategori dan tanggal benar, bukan "Lainnya" dan bukan tanggal mtime.
3. Opsional: buka `site/index.html` dan cek dokumen baru tampil dan pencarian menemukannya.
4. Deploy ulang ke host yang dipakai (A/B/C/D). Untuk Artifact, publish ke `url` yang sama dan sertakan semua file di `site/files/`.

## Troubleshooting

| Gejala | Penyebab / solusi |
|---|---|
| (Lama, hanya Worker Cloudflare) `publish_chat.py` macet/timeout di `sync_chat_index.py` setelah deploy | DNS ISP (mis. XL) mengarahkan `*.workers.dev` ke halaman blokir. Skrip otomatis memakai IP dari DNS-over-HTTPS; pengunjung di jaringan itu tetap tidak bisa memakai chat sampai API dipindah ke domain sendiri. |
| Chat tidak menemukan dokumen baru, padahal tampil di situs | VPS belum diperbarui: `build.py --out docs` hanya memperbarui riwayat GitHub. Jalankan `node local/vps.mjs push` (atau publish dari desk). `tools/publish_chat.py` hanya untuk Worker Cloudflare lama yang tidak di-deploy lagi. |
| Dokumen masuk "Lainnya" | Nama file tidak cocok `prefixes`/`keywords`. Ganti nama file atau tambah kata kunci di `CATEGORIES`. |
| Tanggal salah / hari ini | Tidak ada pola tanggal di nama file, jadi dipakai mtime. Tambahkan `YYYYMMDD` ke nama. |
| Dokumen tampil sebagai teks mentah | CDN `cdnjs.cloudflare.com` diblokir / offline. Tunggu koneksi, atau ganti URL `LIBS` di `build.py`. |
| Ticker/daftar emiten tidak muncul | Heading harus `### KODE`, `### 1. KODE`, atau `### 01. KODE — Judul` (kode 4 huruf kapital). |
| Artifact publish error `contentType … not servable` | Untuk `.md` pakai `"text/plain"` persis. |
| Tab Kepemilikan Saham tidak muncul | `needtobeindexed/idx-signal-desk/kepemilikan.json` belum ada. Jalankan `python3 tools/sync_idx.py`. |
| "Data kepemilikan tidak bisa dimuat" | Dibuka dari `file://`, atau `files/kepemilikan/kepemilikan.json` tidak ikut di-upload. |
| Dokumen besar macet di "Memuat dokumen…" | Dibuka dari `file://`, atau `files/…` tidak ikut di-upload. Buka lewat server / sertakan semua `site/files/`. |
| `sync_idx.py`: "Signal Desk tidak bisa dihubungi" | Jalankan `idx-digest gui` di folder scraper, atau cek `--server`. |
| `sync_idx.py`: "Dilewati: profil aktif …" | Aktifkan profil yang sama di Signal Desk, atau `--profile <id>` untuk sengaja ganti sumber. |
| `build.py`: "Nama berkas ganda" | Nama berkas harus unik di seluruh `needtobeindexed/` termasuk subfolder. |
| Link "← Arsip Riset IDX" di file HTML rusak | Link itu relatif `../../../index.html`, jadi `index.html` harus di root host. |

## Audit web dan data

Lihat [laporan audit web](reports/security-audit-web-2026-09-20.md). Jalankan hanya di salinan terisolasi tanpa secret:

```bash
python3 -B -m unittest discover -s tests -p test_sync_security.py
NODE_PATH=/path/to/test-deps/node_modules node tests/web_security.cjs
```

Uji web memeriksa seluruh 963 emiten dalam data saat audit. Uji ini tidak menghubungi layanan model atau menjalankan sinkronisasi terhadap server asli. Uji DOM tidak menggantikan pemeriksaan CSP/sandbox di browser.

Unit test disimpan di `tests/` dan ikut Git; dependensi `node_modules/` dan cache `__pycache__/` diabaikan. Regresi kepemilikan mencakup periode tanpa KSEI,
variasi nama dan identitas ambigu, perubahan lembar/persen berlawanan, subtotal ≥5%, validasi kedua tanggal, pasangan DPS ganda, serta batas tanggal laporan perubahan.

```bash
python3 -B -m unittest discover -s tests -p 'test_*.py'
# Uji integrasi arsip menggunakan hasil build terbaru; build_worker tidak men-deploy.
python3 -B build.py
python3 -B tools/build_worker.py
node --test tests/*.mjs
# Pakai lokasi dependency uji berisi jsdom@26.1.0, marked@15.0.7, dompurify@3.4.15:
NODE_PATH=/path/to/test-deps/node_modules node tests/ownership_ui.cjs
NODE_PATH=/path/to/test-deps/node_modules node tests/web_security.cjs
```
