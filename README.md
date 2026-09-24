# Arsip Riset IDX

Viewer Markdown statis untuk arsip riset pasar modal (Stockbit, Keterbukaan Informasi emiten BEI, Australia, dan Singapura, serta data IDX Signal Desk).
File sumber di `needtobeindexed/` tidak diubah. Markdown disalin mentah; HTML lama dibungkus dalam iframe terisolasi saat build.
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
Sumber build: `needtobeindexed/`, `build.py`, `chat.js`, dan `chat.config.json` (alamat API publik).

---

## Struktur

```
archivescrapingweb/
├── needtobeindexed/      # SUMBER: taruh file .md di sini (file .html lama juga masih didukung)
│   └── idx-signal-desk/  # DISALIN OTOMATIS oleh tools/sync_idx.py (jangan isi manual; isinya ditimpa)
│       ├── kepemilikan.json  # data tab Kepemilikan Saham
│       └── kepemilikan-perubahan.json  # laporan perubahan kepemilikan per emiten
├── build.py              # generator (Python 3.9+, stdlib saja)
├── report-frame.js       # pencarian dan navigasi lokal di laporan HTML terisolasi
├── report-shell.js       # pembungkus tepercaya untuk laporan HTML
├── tools/build_safety.py # batas aman sumber dan output build
├── chat.js               # antarmuka percakapan; digabung ke index.html saat build
├── chat.config.json      # alamat API publik; bukan secret
├── worker/               # API Cloudflare Worker + Durable Object
├── tools/build_worker.py # indeks pencarian, bagian sumber, dan indeks emiten untuk Worker
├── tools/evidence_index.py # pemisahan sumber tanpa AI, dengan lokasi dan hash isi
├── tools/event_index.py  # tabel aksi korporasi per emiten tanpa AI (events.json) untuk pertanyaan screening
├── tools/compare_chat_costs.mjs # pembanding alur lama/baru, simulasi atau API nyata
├── tools/chat_metrics.py # laporan biaya aktual melalui endpoint privat
├── tools/publish_chat.py # build dan perbarui backend + docs/ (tidak git push)
├── tools/chat_archive.py # pembaca arsip dan pemisah teks untuk build Worker (Python 3.9+, stdlib)
├── tools/sync_idx.py     # salin data dari IDX Signal Desk lokal (http://127.0.0.1:8787) lalu build
├── README.md             # file ini
├── AGENTS.md / CLAUDE.md # penunjuk ke README ini untuk agent
└── site/                 # HASIL BUILD, jangan diedit manual, dihapus & dibuat ulang tiap build
    ├── index.html        # aplikasi viewer + daftar dokumen + isi .md ≤256 KB tertanam (JSON)
    ├── files/<kategori>/<YYYY-MM-DD>/<nama-asli>.md   # salinan mentah
    ├── files/kepemilikan/kepemilikan.json            # salinan data kepemilikan, diambil viewer saat tab dibuka
    ├── files/kepemilikan/kepemilikan-perubahan.json  # laporan perubahan, diambil saat satu emiten dibuka
    ├── robots.txt
    ├── sitemap.xml       # hanya dibuat kalau BASE_URL di-set
    └── .nojekyll         # supaya GitHub Pages tidak memproses folder
```

## Konvensi nama file

| Pola nama | Kategori |
|---|---|
| `stockbit_YYYYMMDD.md` | Stockbit |
| `ki_YYYYMMDD.md` | Keterbukaan Informasi |
| `digest_YYYY-MM-DD_YYYY-MM-DD[_HHMM-HHMM].md` | Digest Emiten (dibuat `tools/sync_idx.py`) |
| `asx_YYYYMMDD.md` | Keterbukaan Informasi Australia (tanggal potret riset) |
| `sgx_YYYYMMDD.md` / `sgx_january-20september2026.md` | Keterbukaan Informasi Singapura (SGX); file kedua memakai 20 September 2026 sebagai tanggal penyusunan |
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

- Satu halaman. Metadata semua dokumen, isi `.md` sampai 256 KB (`EMBED_LIMIT`), dan teks `.html` tertanam di
  `<script type="application/json" id="arsip-data">`.
- `.md` di atas 256 KB (digest besar; digest kecil tetap tertanam) **tidak ditanam**: viewer mengambil `files/…`
  dengan `fetch()` saat dokumen dibuka, dan mengambil semuanya (3 sekaligus) saat kotak cari pertama kali diisi ≥2 huruf.
  Selama itu catatan cari menulis "memuat isi N dokumen besar…". Yang gagal dimuat bisa dicoba lagi lewat tombol **Coba lagi**, saat dibuka ulang, atau saat mencari ≥30 detik kemudian.
  Ini jalan di server HTTP dan Claude Artifact. Dari `file://` (dobel klik) dokumen besar tidak bisa dibuka atau dicari; dokumen kecil tetap jalan.
- Library dari CDN (versi dikunci): `marked@15.0.7` (parser Markdown) dan `dompurify@3.4.15` (sanitasi) dari `cdnjs.cloudflare.com`.
  Kalau CDN gagal dimuat, dokumen tetap tampil sebagai teks mentah (`<pre>`).
- Font dari Google Fonts: IBM Plex Sans / Sans Condensed / Mono. Kalau gagal, pakai font sistem.
- Tab di atas: **Dokumen** (daftar dan pembaca) dan **Kepemilikan Saham** (hanya muncul kalau `kepemilikan.json` ada).
- Beranda memakai **tombol sumber + satu daftar**. Tombol selalu tersedia di atas daftar maupun pembaca:
  Stockbit → Indonesia (BEI) → Australia (ASX) → Singapura (SGX) → Digest Emiten.
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
  Tab kepemilikan: `#kepemilikan=<KODE>&dari=<YYYY-MM>&sampai=<YYYY-MM>` (kode kosong = daftar semua emiten;
  tanpa `dari`/`sampai` = bulan data pertama dan terakhir). Contoh: `#kepemilikan=BBRI&dari=2026-06`
- Rapikan otomatis setelah render Markdown:
  - `## Judul` → id slug (`[^a-z0-9]+` → `-`), masuk daftar isi. Kalau dokumen membagi bagian dengan `#` (lebih dari satu H1), daftar isi memakai H1.
  - `### 01. MNCN — Judul`, `### 1. FORU`, `### 2.1 ESTA — Judul`, `### FORU`, atau bagian bernomor `# 2. DOOH` → badge ticker, masuk grid "Emiten" dan pintasan pada kartu daftar. Nomor subbab bertingkat dikenali oleh generator dan pembaca; tautan lama ke judul subbab tetap dapat dibuka.
    Di dokumen tanpa H1 bagian, `## KODE` (format digest Signal Desk) juga jadi emiten, tapi tidak ikut daftar isi.
    Link `&s=foru` dicocokkan ke bagian pertama kode itu.
  - Paragraf `Label: isi` di dalam bagian emiten, atau yang labelnya kode 4 huruf → tabel label/isi (`<dl class="facts">`).
  - Paragraf berisi ≥3 entri `15 September 2026: ... 17 September: ...` → daftar jadwal.
  - Sel tabel yang isinya persis 4 huruf kapital → badge ticker.
- **Kepemilikan Saham** (`files/kepemilikan/kepemilikan.json`, ±2 MB, diambil dengan `fetch()` saat tab pertama dibuka):
  - Kontrol: cari (Enter membuka kode yang cocok), pilih emiten, **Dari** dan **Sampai** (tanggal file KSEI).
  - Tanpa emiten: tabel semua emiten, akumulasi >1% di tanggal Dari dan Sampai, perubahan (poin), jumlah pemegang >1%,
    jumlah pemegang saham (dengan perubahan %), free float resmi (dua yang terakhir dari laporan emiten terakhir sampai Sampai, bulannya ditulis),
    tren kecil. Bisa diurutkan per perubahan akumulasi atau per perubahan jumlah pemegang; 100 baris pertama, lalu "Tampilkan semua".
  - Satu emiten: kotak angka per tanggal Sampai dibanding Dari; grafik bulanan (akumulasi >1%, sisa <1%, free float resmi, jumlah pemegang)
    dengan rentang diarsir, klik bulan untuk mengubah rentang (sebelum rentang = Dari, sesudahnya = Sampai), panah + Enter dari keyboard;
    batang "siapa menambah, siapa mengurangi" antara Dari dan Sampai; tabel pemegang >1% dengan perubahan persen dan lembar serta tren kecil;
    **daftar pemegang saham (DPS) dari laporan emiten**: pemegang ≥5%/pengendali/afiliasi, direksi dan komisaris dengan lembar dan persen,
    dibanding laporan sebelumnya, plus jumlah pemegang saham dan total saham; **jenis pemilik (laporan BAE)** dengan jumlah pemegang per jenis
    (hanya ±30 emiten yang tabelnya terbaca); **laporan perubahan kepemilikan** (formulir KSEI/IDX dan surat BAE ≥5%, Jul 2023–):
    tanggal, pemegang, lembar/persen sebelum dan sesudah, transaksi, PDF, dan catatan "Perlu dicek" dari audit Signal Desk tanpa mengoreksi angka;
    laporan di rentang Dari–Sampai tampil, sisanya di balik "Laporan lain" (Sampai = bulan terakhir berarti tanpa batas akhir);
    tautan file KSEI dan laporan emiten di IDX.
  - Laporan emiten tidak terbit tiap bulan, jadi angka laporan memakai laporan terakhir sampai Sampai, dibanding laporan terakhir sampai Dari
    (atau laporan paling awal di dalam rentang). Laporan yang ada tetapi tabelnya belum terbaca Signal Desk ditandai, dengan tautan ke PDF-nya.
  - Semua grafik SVG buatan sendiri di `APP_JS`, tanpa library.
  - Pencarian di tab Dokumen: kalau yang dicari persis kode emiten, catatan di bawah kotak cari memberi tautan ke kepemilikannya.
- Pencarian mencocokkan judul, ringkasan, tanggal, nama file, kode saham, **dan isi teks** (tidak peka huruf besar-kecil).
  Jumlah kemunculan tampil di kartu hasil pencarian, dan kata yang dicari ditandai `<mark>` di dokumen yang sedang dibuka.
  - File `.md`: yang dicari isi mentahnya (`content`).
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

- Pencarian menemukan **semua dokumen** yang cocok dengan ticker/kata utuh; tidak memakai top-3/top-5.
  Pertanyaan tanpa ticker memakai satu panggilan kecil untuk menentukan istilah dari konteks percakapan.
  Pertanyaan hubungan Indonesia–ASX/SGX memakai variasi nama negara/bursa yang dikenali langsung, tanpa panggilan penentu istilah.
- Kode saham dicocokkan **peka huruf besar**: kata biasa "naik", "gold", "true" bukan ticker NAIK/GOLD/TRUE.
  Kode yang juga kata umum (`WORD_TICKERS` di `tools/chat_archive.py`) dalam huruf kecil hanya dibaca sebagai
  ticker setelah kata petunjuk (analisa, saham, emiten, dokumen, …) atau bila pertanyaan hanya berisi kode itu ("ship").
  Kode lain tetap dikenali dalam huruf kecil ("analisis soci").
- Permintaan satu dokumen ("ringkas keterbukaan informasi 22 September", "stockbit terbaru") membaca dokumen itu
  secara utuh berdasarkan kategori dan tanggal katalog, bukan mencari frasa di seluruh arsip. Tahun boleh dihilangkan
  bila seluruh arsip berada dalam satu tahun.
- Pertanyaan lanjutan tanpa objek baru ("analisa lebih dalam", "semua dokumen") memakai istilah pencarian giliran
  sebelumnya yang disimpan bersama riwayat server, tanpa menebak ulang.
- `tools/evidence_index.py` membagi sumber secara deterministik saat build, tanpa API berbayar.
  Heading emiten dipertahankan sebagai bagian utuh; baris tabel membawa header, artikel HTML tetap utuh,
  dan skrip/data HTML tetap menjadi bagian sumber. Gabungan `content` seluruh bagian harus sama persis
  dengan sumber asli. Setiap bagian mempunyai lokasi, ticker, tanggal, dan hash dokumen.
- Worker mencari dan mengambil bagian terkait dari SQLite FTS5 jika seluruh versi arsip sudah diimpor.
  `source_documents`, `source_passages`, dan `source_fts` menyimpan sumber lengkap serta indeksnya.
  Jika indeks database belum lengkap, pencarian masih memakai Assets.
- Worker mengambil bagian terkait dari setiap dokumen. Bagian prosa tetangga dan rujukan internal
  disertakan untuk menjaga konteks. Kalau indeks hilang, versinya salah, atau tidak menemukan bagian
  meskipun dokumen cocok, Worker kembali ke dokumen asal tersebut. Pencocokan tetap berbasis teks:
  penyebutan hanya melalui alias/nama tanpa ticker dapat terlewat.
- Tanggal dokumen dipisahkan dari tanggal kejadian. Hanya tanggal ISO di awal record yang jelas
  diklasifikasikan sebagai tanggal kejadian; tanggal lainnya dicatat sebagai penyebutan tanggal.
  Filter tanggal hanya membuang record dengan tanggal pasti yang berbeda. Tanggal tidak pasti,
  rentang tanggal, dan bahan dengan tanggal relevan lain tetap dipertahankan. “Tanggal 17” tanpa
  bulan/tahun meminta penjelasan tanpa panggilan model; tanggal lengkap dari pertanyaan sebelumnya
  dapat menjadi konteks. Filter ini konservatif, bukan jaminan seluruh tanggal telah dikenali.
- Bahan sampai 350 KB (±100 ribu token) dibaca model sebagai teks asli dalam satu panggilan jawaban.
  Bahan di atas itu memakai catatan sumber bersama untuk unit di atas 24 KB, maksimal dua pembaca bersamaan.
  Catatan membahas bukti emiten tanpa pertanyaan atau riwayat pengguna. Jika model menyatakan catatan belum cukup, satu pemeriksaan tambahan atas
  maksimal dua dokumen lengkap diperbolehkan; seluruh batas biaya/koneksi tetap berlaku.
- Kalimat penyangkalan ("Tidak ada aksi korporasi seperti rights issue…", "belum merencanakan delisting") tidak
  dihitung sebagai kecocokan kata topik. Dokumen yang hanya menyebut topik dalam penyangkalan tidak dibaca.
- **Topik terlalu luas** (tanpa kode saham, bahan di atas 350 KB):
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
  Jawaban memakai rujukan `[D…]` yang ditautkan ke arsip, bukan URL hasil karangan model.
- Pembacaan gagal/terpotong tidak masuk cache. Retry pemotongan catatan hanya satu kali dan tetap memakai
  anggaran. Jawaban akhir yang mencapai batas panjang tetap ditampilkan dengan tanda terpotong, tidak masuk
  cache jawaban dan tidak menjadi riwayat percakapan. Rujukan `[D…]` di luar sumber yang diperiksa tidak
  menggagalkan jawaban; jawaban diberi catatan agar rujukan itu diabaikan.
- Tombol Hentikan memutus koneksi. Server menghentikan pekerjaan setelah mendeteksi pemutusan;
  provider masih dapat mengenakan biaya untuk pekerjaan yang sudah dikirim.

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
- Cache jawaban: 15 menit, kuncinya mencakup pertanyaan, riwayat, model, versi seluruh arsip dan
  instruksi. Pertanyaan dengan riwayat dibatasi ke klien yang sama; jawaban tanpa riwayat dapat
  digunakan lintas pengguna. Pertanyaan yang hanya mirip tidak dipaksa memakai jawaban yang sama.
- Pekerjaan dengan kunci sama yang datang bersamaan bergabung pada satu pekerjaan. Kegagalan
  atau pembatalan pemilik pekerjaan bersama dapat menggagalkan penunggu; hasil parsial tidak disimpan.
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
node tools/eval_chat.mjs --label nama      # uji akurasi 24 pertanyaan nyata (tests/eval/cases.json), API nyata, batas US$2
node tools/compare_chat_costs.mjs           # simulasi offline, tidak memanggil provider
node tools/compare_chat_costs.mjs --live    # perbandingan API nyata, batas cadangan konservatif US$1
python3 tools/chat_metrics.py --days 7 --out reports/private/chat-metrics.json --html reports/private/chat-statistics.html
```

Hasil pembanding berada di `reports/cache-comparison/`. Alur lama tetap tersedia sebagai
`converseLegacy` untuk kontrol pengujian, bukan pilihan dari browser publik. Mode nyata memakai
key khusus `.env.chat`; biaya aktual berasal dari respons provider. Batas US$1 adalah cadangan
konservatif berdasarkan byte dan tarif tertinggi endpoint yang diverifikasi pada 20 September 2026;
verifikasi ulang tarif sebelum menjalankan ulang jika harga/model berubah. Cache provider tidak
dipaksa kosong, sehingga laporan mencantumkan cached token dan hasil yang benar-benar ditagih.

Endpoint `GET /api/chat/metrics?days=7` memerlukan bearer `CHAT_METRICS_TOKEN`, secret terpisah dari
key OpenRouter. Nilainya disimpan lokal di `.env.chat.metrics` (izin 600, diabaikan Git), diunggah
sebagai secret Worker, dan tidak masuk frontend. Tanpa secret, endpoint menolak akses. Pengelola
memakai `tools/chat_metrics.py`; token tidak dicetak atau ditaruh pada URL. Laporan menyediakan
pertanyaan berulang, topik teratas, tren harian, token/biaya, hasil proses, dan cache hit. Teks pertanyaan
ditampilkan dengan escaping HTML. Laporan JSON/HTML privat disimpan di `reports/private/` yang
diabaikan Git. `--limit` (maksimal 500) dan `--offset` menyediakan halaman riwayat berikutnya.

### Batas keamanan dan biaya

Batas backend tetap berlaku walaupun JavaScript browser diubah:

| Lapisan | Batas |
|---|---|
| Pertanyaan | 600 karakter, normalisasi Unicode, hapus kontrol tak terlihat |
| HTTP body | 4.096 byte, JSON saja, unggahan maksimal 5 detik |
| Riwayat dari browser | Ditolak; hanya token konteks acak 256 bit |
| Topik | Maksimal 4 ticker/istilah, 4 MB bahan, 14 kelompok |
| Satu panggilan model | Maksimal 480.000 byte JSON pesan; tidak sama dengan jumlah token |
| Satu analisis | 8 MB total pesan termasuk retry, 20 panggilan, alokasi keluaran 36.000 token |
| Keluaran per panggilan | Catatan 1.800 token, retry sekali 3.600; jawaban akhir 5.000 |
| Anggaran global/hari UTC | 80 MB pesan model dan alokasi keluaran 500.000 token, dicadangkan sebelum setiap panggilan |
| Permintaan masuk termasuk invalid | 12/IP/menit dan 120 global/menit |
| Analisis diterima | 120/IP/jam, 3.000 global/hari |
| Koneksi | 4 unggahan, 10 analisis (maksimal 5/IP), batas keseluruhan 8 menit, pembaca lambat diputus setelah 10 detik |

Alokasi keluaran memakai batas maksimum, bukan tagihan aktual. Model, endpoint, dan
parameter tidak bisa dipilih pengguna. Pemeriksaan ulang sumber hanya memakai ID dokumen yang ditemukan server. Tidak ada tools/function calling, eksekusi shell,
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

**Memperbarui arsip dan chat setelah menambah dokumen:**

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

## Sinkron dari IDX Signal Desk (`tools/sync_idx.py`)

Menyalin data dari aplikasi lokal `idx-digest gui` (default `http://127.0.0.1:8787`, ubah dengan `--server` atau env `IDX_SIGNAL_DESK`)
ke `needtobeindexed/idx-signal-desk/`, lalu menjalankan `build.py` kalau ada yang berubah.

```bash
python3 tools/sync_idx.py                 # sekali
python3 tools/sync_idx.py --watch 15      # tiap 15 menit, biarkan jalan di tab Terminal
python3 tools/sync_idx.py --fragment-index <scratchpad>/artifact/index.html   # sekalian siapkan publish Artifact
```

- `digest_<awal>_<akhir>[_HHMM-HHMM].md`: satu per jendela di *Library → Summary Windows*, isi = `POST /api/share/render`
  (format md, semua digest per emiten). Baris judul diganti supaya tiap berkas bisa dibedakan.
  Akhiran jam dipakai kalau jendela tidak 00:00–23:59 (mis. `_0000-1959`).
- `kepemilikan.json`: semua bulan KSEI sekaligus, dari `GET /api/ownership` dan `/api/ownership/<KODE>?profile_id=…`:
  per emiten per bulan akumulasi >1%, pemegang >1% (baris dengan nama investor sama dijumlahkan), catatan data KSEI, free float resmi,
  jumlah pemegang, daftar pemegang saham (nama, peran, lembar, persen; tanpa alamat) dan jenis pemilik BAE dari laporan emiten bulan yang sama. Tiap investor punya nomor yang sama lintas bulan: nama sama, atau nama mirip dengan
  jumlah lembar persis sama di bulan data sebelumnya (KSEI kadang menulis `TASPEN` / `PT TASPEN (PERSERO)`), jadi viewer bisa membandingkan
  dua bulan mana pun. Bentuknya dijelaskan di docstring `ownership_data()`; kalau diubah, naikkan `OWNERSHIP_FORMAT`.
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
- Berkas yang tidak lagi dihasilkan server dihapus dari folder itu (hanya pola `digest_*.md` / `kepemilikan_*.md`, dan tidak pernah kalau server mengembalikan daftar kosong).
- Profil: yang pertama kali disinkron dicatat di `.sync.json`. Kalau profil aktif di Signal Desk berbeda, sinkron dilewati (exit 2)
  supaya data profil lain tidak menimpa. Profil aktif dicek lagi sebelum menghapus berkas lama dan sebelum menyimpan status. Ganti sengaja dengan `--profile <id>`.
- Sinkron menyusun hasil di direktori sementara terlebih dahulu. Penjagaan profil dan keberhasilan seluruh pengambilan diperiksa sebelum menulis tujuan. Perubahan bersamaan pada tujuan membatalkan commit; kegagalan commit biasa dipulihkan dari snapshot. Ini bukan transaksi atomik terhadap mati listrik/SIGKILL di tengah beberapa berkas. Berkas sementara memakai nama acak dan tujuan symlink ditolak.
- HTTP hanya diizinkan untuk loopback; server jauh harus HTTPS, tanpa kredensial di URL dan tanpa redirect. Respons maksimal 32 MB. Path ledger lokal hanya dipakai untuk server loopback dan SQLite dibuka read-only.
- Exit code: 0 ok, 1 server tidak bisa dihubungi / HTTP error / data tak terduga, 2 profil beda, 3 build gagal.
  Mode `--watch` terus jalan walau satu putaran gagal. Dengan `--fragment-index`, build selalu dijalankan supaya fragment Artifact ikut kode terbaru.
- Publish ke Artifact tetap lewat Claude Code (skrip tidak bisa memanggil tool Artifact): minta "publish" setelah sinkron.
  Untuk host yang bisa di-deploy dari skrip (Cloudflare Pages dll.), jalankan perintah deploy setelah sinkron.

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
     `files/kepemilikan/kepemilikan.json` pakai `"contentType": "application/json"`.
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
| Chat tidak menemukan dokumen baru, padahal tampil di situs | Worker belum diperbarui: `build.py --out docs` hanya memperbarui situs. Jalankan `python3 tools/publish_chat.py`. |
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
