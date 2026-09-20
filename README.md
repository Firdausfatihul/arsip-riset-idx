# Arsip Riset IDX

Viewer Markdown statis untuk arsip riset pasar modal (Stockbit, Keterbukaan Informasi emiten BEI, Australia, dan Singapura, serta data IDX Signal Desk).
File di `needtobeindexed/` **tidak dikonversi**: file disalin apa adanya lalu dirender di browser.
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
Sumber kebenaran hanya `needtobeindexed/` + `build.py`. Selama dua itu ada, site bisa dibuat ulang.

---

## Struktur

```
archivescrapingweb/
├── needtobeindexed/      # SUMBER: taruh file .md di sini (file .html lama juga masih didukung)
│   └── idx-signal-desk/  # DISALIN OTOMATIS oleh tools/sync_idx.py (jangan isi manual; isinya ditimpa)
│       └── kepemilikan.json  # data tab Kepemilikan Saham
├── build.py              # generator (Python 3.8+, stdlib saja)
├── tools/sync_idx.py     # salin data dari IDX Signal Desk lokal (http://127.0.0.1:8787) lalu build
├── README.md             # file ini
├── AGENTS.md / CLAUDE.md # penunjuk ke README ini untuk agent
└── site/                 # HASIL BUILD, jangan diedit manual, dihapus & dibuat ulang tiap build
    ├── index.html        # aplikasi viewer + daftar dokumen + isi .md ≤256 KB tertanam (JSON)
    ├── files/<kategori>/<YYYY-MM-DD>/<nama-asli>.md   # salinan mentah
    ├── files/kepemilikan/kepemilikan.json            # salinan data kepemilikan, diambil viewer saat tab dibuka
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

Peringatan: folder `--out` **dihapus total** (`shutil.rmtree`) sebelum ditulis ulang. Jangan arahkan ke folder yang berisi file lain.

Output terminal menampilkan satu baris per dokumen: `kategori | tanggal | file sumber -> path di site`.
Cek baris ini untuk memastikan kategori dan tanggal terbaca benar.

## Cara kerja viewer (`site/index.html`)

- Satu halaman. Metadata semua dokumen, isi `.md` sampai 256 KB (`EMBED_LIMIT`), dan teks `.html` tertanam di
  `<script type="application/json" id="arsip-data">`.
- `.md` di atas 256 KB (digest besar; digest kecil tetap tertanam) **tidak ditanam**: viewer mengambil `files/…`
  dengan `fetch()` saat dokumen dibuka, dan mengambil semuanya (3 sekaligus) saat kotak cari pertama kali diisi ≥2 huruf.
  Selama itu catatan cari menulis "memuat isi N dokumen besar…". Yang gagal dimuat dicoba lagi saat dibuka ulang, atau saat mencari ≥30 detik kemudian.
  Ini jalan di server HTTP dan Claude Artifact. Dari `file://` (dobel klik) dokumen besar tidak bisa dibuka atau dicari; dokumen kecil tetap jalan.
- Library dari CDN (versi dikunci): `marked@15.0.7` (parser Markdown) dan `dompurify@3.2.4` (sanitasi) dari `cdnjs.cloudflare.com`.
  Kalau CDN gagal dimuat, dokumen tetap tampil sebagai teks mentah (`<pre>`).
- Font dari Google Fonts: IBM Plex Sans / Sans Condensed / Mono. Kalau gagal, pakai font sistem.
- Tab di atas: **Dokumen** (daftar dan pembaca) dan **Kepemilikan Saham** (hanya muncul kalau `kepemilikan.json` ada).
- Beranda: **Stockbit → Keterbukaan Informasi → Keterbukaan Informasi Australia → Keterbukaan Informasi Singapura (SGX)** sejajar dalam empat kolom saat area konten cukup lebar (≥1160 px); Digest Emiten sesudahnya. Area konten ≥840 px memakai tiga kolom, ≥760 px dua kolom, dan selebihnya satu kolom. Saat belum cukup untuk empat kolom, tautan kategori tampil di atas judul beranda agar semua sumber langsung terlihat dan bisa dituju tanpa mencari ke bawah.
- Routing lewat hash: `#doc=files/<kategori>/<tanggal>/<file>.md` dan opsional `&s=<id-bagian>`.
  Contoh: `#doc=files/keterbukaan-informasi/2026-09-14/pemeriksaan_55_emiten_14_September_2026.md&s=foru`
  Tab kepemilikan: `#kepemilikan=<KODE>&dari=<YYYY-MM>&sampai=<YYYY-MM>` (kode kosong = daftar semua emiten;
  tanpa `dari`/`sampai` = bulan data pertama dan terakhir). Contoh: `#kepemilikan=BBRI&dari=2026-06`
- Rapikan otomatis setelah render Markdown:
  - `## Judul` → id slug (`[^a-z0-9]+` → `-`), masuk daftar isi. Kalau dokumen membagi bagian dengan `#` (lebih dari satu H1), daftar isi memakai H1.
  - `### 01. MNCN — Judul`, `### 1. FORU`, `### FORU`, atau bagian bernomor `# 2. DOOH` → badge ticker, masuk grid "Emiten".
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
    (hanya ±30 emiten yang tabelnya terbaca); tautan file KSEI dan laporan emiten di IDX.
  - Laporan emiten tidak terbit tiap bulan, jadi angka laporan memakai laporan terakhir sampai Sampai, dibanding laporan terakhir sampai Dari
    (atau laporan paling awal di dalam rentang). Laporan yang ada tetapi tabelnya belum terbaca Signal Desk ditandai, dengan tautan ke PDF-nya.
  - Semua grafik SVG buatan sendiri di `APP_JS`, tanpa library.
  - Pencarian di tab Dokumen: kalau yang dicari persis kode emiten, catatan di bawah kotak cari memberi tautan ke kepemilikannya.
- Pencarian mencocokkan judul, ringkasan, tanggal, nama file, kode saham, **dan isi teks** (tidak peka huruf besar-kecil).
  Jumlah kemunculan tampil di sidebar, dan kata yang dicari ditandai `<mark>` di dokumen yang sedang dibuka.
  - File `.md`: yang dicari isi mentahnya (`content`).
  - File `.html`: yang dicari teks yang tampil (tanpa `<script>`/`<style>`) plus nilai string data JSON di `<script>`
    (mis. `const records=[{"summary": "..."}]`), disimpan sebagai `text` (lihat `html_text()` di `build.py`).
    Temuan juga ditandai di dalam iframe kalau satu origin. Kalau tidak, hanya jumlahnya yang tampil.
- File `.html` di `needtobeindexed/` disalin ke `files/…` apa adanya (plus satu bar navigasi "← Arsip Riset IDX" setelah `<body>`)
  dan dibuka di dalam viewer lewat `<iframe>`. Bar itu menyembunyikan dirinya saat di-iframe dari halaman yang sama, dan tetap tampil saat file dibuka langsung.
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
- Disamarkan otomatis (di digest dan kepemilikan): nomor HP Indonesia (`08…`, `+62 8…`) dan kode akses rapat (`Passcode: …`, `pwd=…`),
  karena arsip bisa dibagikan lewat link. Nama, alamat, dan angka dari pengumuman tidak diubah. Setelah mengubah pola di `REDACTIONS`, jalankan sekali dengan `--force`.
- Hanya endpoint baca. `/api/share/export` sengaja **tidak** dipakai karena menulis berkas ke `data/share/` scraper. Skrip tidak memicu scraping.
- Hemat: jendela yang `updated_at`/jumlah emitennya sama tidak dirender ulang; kepemilikan hanya diambil ulang kalau ringkasan `/api/ownership`
  atau file KSEI aktif di ledger berubah.
  Status disimpan di `needtobeindexed/idx-signal-desk/.sync.json`. `--force` merender ulang semuanya.
- Berkas yang tidak lagi dihasilkan server dihapus dari folder itu (hanya pola `digest_*.md` / `kepemilikan_*.md`, dan tidak pernah kalau server mengembalikan daftar kosong).
- Profil: yang pertama kali disinkron dicatat di `.sync.json`. Kalau profil aktif di Signal Desk berbeda, sinkron dilewati (exit 2)
  supaya data profil lain tidak menimpa. Profil aktif dicek lagi sebelum menghapus berkas lama dan sebelum menyimpan status. Ganti sengaja dengan `--profile <id>`.
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
