# AGENTS.md: Arsip Riset IDX

Dokumen kanonik untuk agent (Claude, Codex, dll.). Baca ini dulu; `README.md` hanya panduan cepat untuk manusia.
Rincian yang sangat dalam ada di docstring modul yang disebut di tiap bagian. Identifier kode ditulis apa adanya.

## 0. Aturan wajib

- `needtobeindexed/` adalah arsip riset milik pemilik. Jangan mengubah isinya dengan tangan.
  `needtobeindexed/idx-signal-desk/` hanya ditulis `tools/sync_idx.py`; `needtobeindexed/harga/harga.json` hanya `tools/sync_prices.py`.
- `site/` dan `docs/` adalah hasil `build.py`: jangan diedit, folder dihapus dan dibuat ulang tiap build. `docs/` di-commit (riwayat GitHub).
- Jangan menyentuh `.local/` (kunci mesin, SQLite chat, kata sandi), `.env*` selain `.env.chat.example`, `reports/private/`,
  `.stockbit-publish/`. Jangan mencetak isi secret.
- Python: hanya standard library, 3.9+. Node 22+ (`node:sqlite`). Tidak ada dependency npm saat runtime.
- Setelah build, cek baris output `kategori | tanggal | sumber -> path`: bukan "Lainnya", bukan tanggal mtime.
- Sebelum mengklaim selesai: `sh tools/test.sh` hijau (±4 menit, tanpa jaringan selain instalasi pustaka uji sekali).
- Jangan menjalankan `node local/vps.mjs push`, `tools/publish_stockbit.py` atau `tools/rollback_stockbit.py` sungguhan tanpa
  izin pemilik: ketiganya mengubah situs live dan/atau git remote.

## 1. Peta sistem

```
IDX Signal Desk (repo lain, http://127.0.0.1:8787, read-only GET)
   │  tools/sync_idx.py  (Stockbit, BEI, kepemilikan; staging + profil + tahanan)
   ▼
needtobeindexed/  ──► build.py ──► .local/site/ (server), site/ (manual), docs/ (riwayat git)
   │                 index.html = app.css + app.js + chat.js, files/<kategori>/<tanggal>/<berkas>
   ▼
tools/build_worker.py ──► aset chat (.local/assets): manifest, D*.json, D*.evidence.json, events, signals,
   (evidence_index, event_index, ksei_signals, archive_tables)    ksei_history, ownership, stockbit, claims, subjects, ...
   ▼
local/server.mjs (Node 22): situs statis + worker/index.mjs (ArchiveChat) + SQLite .local/chat.sqlite
   │  env.MODEL_FETCHER = local/claude-bridge.mjs ──► `claude -p` (login langganan Claude, tanpa API key)
   ▼
Produksi: Tencent Lighthouse ap-jakarta, Caddy (HTTPS) ──► 127.0.0.1:8018 (wajib kata sandi), domain arsip.seekingomega.capital
```

Tiga cara menjalankan server yang sama:
- **VPS Jakarta** (produksi, Mac boleh mati): `local/vps.mjs` mengirim kode + arsip, build di VPS, systemd menjalankan
  `node local/server.mjs` dari `/srv/arsip/app` dengan `ARSIP_ALLOW_VPS=1`.
- **Mac saja**: `node local/server.mjs` di `http://127.0.0.1:8017` (tanpa sandi, hanya loopback).
- **Tunnel**: `local/remote.mjs`; perangkat → Caddy di VPS → `127.0.0.1:18017` → tunnel SSH balik → Mac `127.0.0.1:8018` (sandi
  diperiksa di Mac). VPS tidak menyimpan login Claude maupun arsip.

## 2. Peta direktori

| Path | Jenis | Isi |
|---|---|---|
| `needtobeindexed/` | sumber | `.md`, `.html`, `.csv` arsip; `needtobeindexed/idx-signal-desk/` (sinkron desk), `needtobeindexed/harga/` (harga) |
| `build.py` | sumber | generator situs: `CATEGORIES`, tanggal dari nama, payload `arsip-data`, CSP |
| `app.css`, `app.js` | sumber | gaya dan aplikasi viewer (daftar, pembaca, `#emiten=`, tab Kepemilikan); ditanam inline |
| `chat.js` | sumber | kotak Tanya arsip; digabung setelah `app.js` (`PAGE_JS`) |
| `report-frame.js`, `report-shell.js` | sumber | pembungkus iframe laporan HTML lama |
| `worker/` | sumber | logika chat (nama "worker" warisan Cloudflare; kini dijalankan Node) |
| `local/` | sumber | server Node, jembatan Claude, VPS, tunnel, `cli.mjs`, `sqlite-storage.mjs` |
| `tools/` | sumber | sinkron, publish/rollback desk, aset chat, statistik, `test.sh` |
| `tests/` | sumber | semua tes; `tests/helpers/` fixture bersama; `tests/golden/` snapshot |
| `removed-from-archive/` | arsip | berkas yang dikeluarkan dari arsip; biarkan |
| `site/`, `docs/` | hasil build | `docs/` dilacak git, `site/` diabaikan |
| `.local/` | privat | `.local/site/`, `.local/assets/`, `chat.sqlite`, `machine-lock.json`, `boundary.key`, `vps.json`, `remote.json`, `known_hosts` |
| `.env.chat` | privat | `DATACAT_API_KEY`, `CHAT_METRICS_TOKEN` (lihat `.env.chat.example`) |
| `.stockbit-publish/` | privat | `log.jsonl` publish/rollback (dibaca desk) |
| `reports/` | privat | diabaikan git; `reports/private/` statistik |

## 3. Nama berkas → kategori dan tanggal

Kategori dari `CATEGORIES` di `build.py`: `prefixes` dicocokkan dengan kata pertama nama (pemisah `_ - . spasi`), lalu `keywords`
di mana pun; urutan dict = urutan tampil. Tes `tests/test_build_golden.py` mengunci semua aturan di bawah.

| Pola | Kategori | Catatan |
|---|---|---|
| `sbringkas_` / `sbdetail_` / `sbpekan_` + `<tgl>_<tgl>.md` | `stockbit-ringkasan` / `stockbit-detail` / `stockbit-pekan` | dari desk (`sync_idx.py`) |
| `beiringkas_` / `beidetail_` / `beipekan_` + `<tgl>_<tgl>.md` | `bei-ringkasan` / `bei-detail` / `bei-pekan` | dari desk |
| `stockbit_DDMMYYYY.md`, `stockbit_*.html` | `stockbit` | laporan lama manual |
| `ki_*.md`, nama dengan "keterbukaan/pemeriksaan/emiten/disclosure" | `keterbukaan-informasi` | Analisis KI (legacy), tanpa tombol |
| `asx_*` / `sgx_*`, `keterbukaan_sg_DDMMYYYY_*` | `keterbukaan-australia` / `keterbukaan-singapura` | |
| `digest_*.md` | `digest-emiten` | pensiun: `unlisted`, tidak di daftar/chat; `#doc=` lama jalan |
| lainnya | `lainnya` | ganti nama atau tambah aturan |

Tanggal (`parse_dates`): `YYYY-MM-DD_YYYY-MM-DD`; `YYYY-MM-DD[_DD]`; `DD[-DD]_NamaBulan_YYYY` (Indonesia/Inggris);
nama bulan saja → rentang dicari di ±5.000 karakter awal isi (`refine_from_text`); 8 digit `YYYYMMDD` atau `DDMMYYYY`
(satu tanggal + rentang di judul yang dimulai di tanggal itu → rentang). Tanpa pola → mtime (hindari). Nama berkas harus
unik di seluruh `needtobeindexed/`.

## 4. Viewer (`index.html`)

- Satu halaman. `<script type="application/json" id="arsip-data">` memuat metadata dan isi `.md`/`.csv` ≤256 KB
  (`EMBED_LIMIT`); yang lebih besar, serta semua detail Stockbit/BEI (`ALWAYS_LAZY`), diambil `fetch()` saat dibuka atau saat
  mencari ≥2 huruf. Dari `file://` dokumen besar tidak bisa dibuka.
- Route hash: `#doc=files/<kategori>/<tanggal>/<berkas>&s=<id-bagian>`, `#<kategori>` (mis. `#keterbukaan-singapura`),
  `#emiten=KODE` (Keterbukaan resmi BEI dari `bei-index.json` di atas, Diskusi Stockbit dari `stockbit-index.json` di bawah),
  `#pengguna=<akun>`, `#kepemilikan=KODE&dari=YYYY-MM&sampai=YYYY-MM`.
- Tombol sumber (urutan `nav` di `CATEGORIES`); pencarian lintas semua sumber, teks dan kode, `<mark>` di dokumen terbuka.
- Rapikan Markdown: `## Judul` → daftar isi; `### 01. KODE — Judul`, `### 2.1 KODE`, `### KODE`, `# 2. KODE` → badge emiten;
  `Label: isi` → `dl.facts`; ≥3 entri bertanggal → daftar jadwal. CSV jadi tabel bisa diurutkan, nilai tetap teks.
- HTML lama: `srcdoc` dengan `sandbox="allow-scripts allow-popups"` tanpa `allow-same-origin`; pencarian lewat `postMessage`.
- Pustaka CDN dikunci versi + SRI: `marked@15.0.7`, `dompurify@3.4.15` (`LIBS`). CDN gagal → teks mentah.
- **Tab Kepemilikan** (data dari `sync_idx.py`; `files/kepemilikan/*.json` dimuat lazy, divalidasi skema sebelum render):
  sumbu bulan laporan emiten (sejak Mei 2023) + KSEI >1% (sejak Feb 2026); perubahan per pemegang dari **lembar** antara dua
  snapshot KSEI valid; struktur pemegang (HHI, sisa, free float, persentil); DPS laporan emiten; jenis pemilik BAE; laporan
  perubahan kepemilikan. Angka "terverifikasi" mengikuti `comparable()`/`blockholders()`/`derivable()`/`written_blockholders()`
  di `tools/sync_idx.py`; yang tidak lolos tampil sebagai titik kosong tanpa garis, ditandai ⚠. Bulan tanpa data bukan nol.
  Rekening kustodian/nominee: `CUSTODIANS`/`NOMINEE` di `tools/ksei_signals.py` (tab menambah `BANK OF SINGAPORE`, lihat
  `build.py`). Harga penutupan per snapshot dari `harga.json`; tanpa harga dipakai lot.

## 5. Alur chat (`worker/core.mjs` `converse`)

Kontrak HTTP: `POST /api/chat` (`{question, context?, mode?:"agentic"}`), `GET /api/chat/config`. Jawaban di-stream.
Browser tidak pernah mengirim riwayat; server menyimpan konteks (token acak). Urutan rute:

| Rute | Pemicu | Modul | Panggilan model |
|---|---|---|---|
| Klarifikasi | tanggal tidak lengkap/terbalik, rentang terlalu banyak dokumen | `retrieval.mjs` | 0 |
| Cache jawaban | pertanyaan + riwayat + versi arsip sama (15 menit) | `cache.mjs` | 0 |
| Dokumen per tanggal/sumber | "ringkas KI 22 September", "baca SGX" (`documentRequest`) | `document-material.mjs` | 1 (+catatan bila >240 KB) |
| Rute tabel | tanpa ticker, tanpa tanggal/sumber, bukan lanjutan: rumor jarang (`RARE`), akun Stockbit, nama orang/grup di `entities.json` | `tables.mjs` (`tableRoute`) | 1 (4.500 token) |
| Ticker/topik | kode saham (`directTickers`, peka huruf besar; kata umum di `WORD_TICKERS` (`tools/chat_archive.py`) butuh kata petunjuk) atau topik | `retrieval.mjs`, `stockbit.mjs` | 1 jawaban; +1 JSON istilah bila tanpa ticker; +catatan bila >240 KB |
| Topik terlalu luas | tanpa ticker, bahan >240 KB: aksi korporasi → `events.json`; >4 MB / >6 unit besar → daftar emiten | `screening.mjs` | 1 / 0 |
| Lintas bursa | Indonesia + ASX/SGX + kata hubungan (`crossMarketQuery`) | `thematic.mjs` | 1 seleksi + 1 jawaban |
| Mode agen | kotak centang, `DATACAT_API_KEY` ada | `agent.mjs`, `facts.mjs`, `signals.mjs` | ≤4 langkah + jawaban |

Bahan:
- Ticker: anggaran byte per keluarga `STOCKBIT_TICKER_BUDGET` 90 KB, `BEI_TICKER_BUDGET` 70 KB, `LEGACY_TICKER_BUDGET` 60 KB
  (hari terbaru utuh, hari lama satu baris listing). Ringkasan yang tercakup detail hari sama tidak dikirim dua kali.
  Salinan model tanpa URL/ID (`modelText`); angka tetap dicek terhadap teks asli.
- **[A2]** (`mentionsBlock`): kode disebut pengumuman emiten lain dalam huruf kecil/nama resmi; maks 8 baris, 4 KB; tidak
  ditambahkan bila pertanyaan menyebut tanggal/sumber. **[H]** (`relationBlock`): 2+ ticker dengan kata hubungan (`RELATION`) →
  nama persis yang tercatat di kedua emiten, bertier kuat/sedang/lemah.
- Dokumen: berkas desk lewat `deskDigest`, `DIGEST_BUDGET` normal 72 KB, ringkas 27 KB, luas/detail 120 KB, menyeluruh
  (`EXHAUSTIVE`) 165 KB; berkas lain utuh. KI lama hanya dibuang bila BEI terpilih mencakup seluruh rentangnya.
- `RAW_LIMIT` 240 KB (±130k token Claude): di bawahnya teks asli dalam satu panggilan; di atasnya unit >24 KB jadi catatan
  (`NOTE_VERSION`, maks 2 pembaca paralel). Batas pesan: `LIMITS.message` 480 KB, `LIMITS.documentMessage` 320 KB.
- Token jawaban: 6.500 (`ANSWER_TOKENS`); 12.000 luas/detail; 24.000 menyeluruh bila bahan ≤180 KB; rute tabel 4.500.

Pemeriksa setelah jawaban (kode, bukan model): rujukan `[D…]/[K…]/[O…]` di luar sumber diberi catatan (`citations.mjs`);
angka yang tidak ada di bahan (`unverifiedNumbers`); nama emiten yang tidak sesuai arsip (`wrongNames`, nama dari "PT … Tbk
(KODE)" di `events.json`); sinyal KSEI `wajib` yang tidak dibahas ditambahkan (`signals.mjs` `coverage`); rute tabel menambah
maks 8 klaim yang tidak dibahas (`claimTail`). Hitungan ("FAKTA TERHITUNG SISTEM") selalu dari kode.

Mode agen: alat baca-saja `cari_arsip`, `data_kepemilikan`, `datacat_cari`, `datacat_daftar`, `datacat_detail`, `cari_teks`,
`tulis_jawaban` (host `quant.renr.ai`, path tetap). Batas `AGENT`: 4 langkah, 18 alat, 6 KB/hasil, 70 KB total, jawaban 2.000
token, 44 koneksi keluar. Kuota `agenticDaily` (`worker/index.mjs`: `CHAT_AGENTIC_DAILY`, bawaan 100/hari UTC). Permintaan isi dokumen dialihkan ke alur biasa.

## 6. Penyimpanan dan cache (`.local/chat.sqlite`)

| Tabel | Isi |
|---|---|
| `requests`, `ingress`, `budget`, `agentic_requests` | kuota per IP/global, anggaran byte/token harian yang dicadangkan sebelum panggilan |
| `conversations` | konteks percakapan: 3 pertukaran terakhir, 1 jam, maks 20 giliran, terikat hash IP |
| `evidence_cache` (+ view `issuer_evidence`) | `source`, `notes`, `answer`, data agen; LRU 512 entri / 16 MB, entri ≤1 MB |
| `source_documents`, `source_passages`, `source_fts` | indeks FTS5 lossless, diisi saat start (`SourceStore.importPending`), versi lama dipangkas |
| `analysis_usage`, `question_events` | statistik 365 hari: token, status, teks pertanyaan, hash klien (bukan IP) |

Kunci cache: `source`/`notes` berdasarkan hash dokumen, istilah, versi parser (`PIPELINE`, `NOTE_VERSION`), tanpa teks
pengguna, tanpa kedaluwarsa waktu. `answer` 15 menit, kunci mencakup pertanyaan, riwayat, `MODEL`, `manifest.version`,
`retrieval_version`, `data_version`, hash `events.json`/`stockbit.json`; dengan riwayat dibatasi ke klien yang sama.
Mode agen: jawaban dan data datacat 6 jam, `cari_teks` 24 jam. `MODEL` (`'qwen/qwen3.7-flash'`) adalah label lama yang
masuk setiap kunci; jangan diubah tanpa alasan (semua cache akan hilang). Pekerjaan dengan kunci sama bergabung (`once`).

## 7. Jembatan model (`local/claude-bridge.mjs`)

- Format pesan OpenAI/OpenRouter dari `OpenRouter` (`worker/core.mjs`) diterjemahkan ke satu proses `claude -p` per panggilan,
  dari folder kosong, dengan `--safe-mode`, `--tools ""`, `--setting-sources ""`, `--strict-mcp-config`,
  `--no-session-persistence`, `--disable-slash-commands`, `--model`, `--effort`, `--system-prompt-file`,
  `--input-format stream-json`, `--output-format stream-json`.
- Lingkungan bersih (`cliEnv`): hanya HOME, PATH, bahasa, proxy, `CLAUDE_CONFIG_DIR`. `ANTHROPIC_API_KEY`, token OAuth,
  Bedrock/Vertex dan variabel sesi Claude Code tidak diteruskan. Start ditolak (exit 78, `LOCK_FAILED`) bila
  `claude auth status` bukan login langganan (`authMethod` `claude.ai`); status tidak terbaca → exit 1 (systemd mengulang).
- Bawaan `MODEL_DEFAULT` `sonnet`, `EFFORT_DEFAULT` `medium` (`local/server.mjs`); VPS saat ini sonnet/medium
  (`node local/vps.mjs setup --model … --effort …` lalu `apply`). Effort valid: low, medium, high, xhigh, max.
- Thinking tidak dibatasi (effort menentukan); `CLAUDE_CODE_MAX_OUTPUT_TOKENS` = anggaran teks + 64.000; teks dihentikan
  sebagai "length" di ±8 karakter/token anggaran. Catatan, panggilan JSON, dan seluruh mode agen memakai `--thinking disabled`.
- Cache prompt: giliran pertama diberi breakpoint, TTL `5m` (`ARSIP_CLAUDE_CACHE_TTL=1h` untuk yang lama); penanda giliran
  HMAC stabil dengan `boundary.key` (dibawa `vps.mjs push`) agar bahan sama memakai cache yang sama; panggilan dengan awalan
  yang sedang ditulis menunggu (`prefixWait`).
- Mode agen memakai protokol teks JSON `{content, tool_calls}` (bukan tool use asli).
- Error CLI: batas pemakaian → 429, bahan terlalu panjang → 413. Biaya ditagih 0 (langganan); token dan estimasi harga API dicatat.
- `--concurrency N` (bawaan 4, maks 8) proses `claude` bersamaan → N/2 analisis serentak.

## 8. Batas yang berlaku di VPS/Mac (`local/server.mjs` env + `worker/`)

| Lapisan | Batas |
|---|---|
| Pertanyaan / body | 600 karakter (normalisasi Unicode) / 4.096 byte JSON, unggahan ≤5 detik |
| Permintaan masuk | 12/IP/menit, 120 global/menit |
| Analisis diterima | `CHAT_HOURLY_PER_IP` 300/jam, `CHAT_DAILY_REQUESTS` 3.000/hari UTC |
| Serentak | `CHAT_CONCURRENT_REQUESTS` = `CHAT_CONCURRENT_PER_IP` = concurrency/2 (bawaan 2) |
| Satu analisis | `LIMITS`: 8 MB pesan, 20 panggilan, alokasi keluaran 36.000 token, maks 4 istilah, bahan ≤4 MB |
| Harian | `CHAT_DAILY_BYTES` 300 MB, `CHAT_DAILY_OUTPUT_TOKENS` 3.000.000 (dicadangkan sebelum panggilan) |
| Mode agen | `CHAT_AGENTIC_DAILY` 100/hari untuk seluruh situs (`agenticDaily`; di VPS lewat `.local/server.env`) |
| Sandi jarak jauh | 5 gagal/alamat/15 menit, 30 gagal total/jam; sesi 30 hari (`local/remote-auth.mjs`) |

## 9. Deploy, publish, rollback

**VPS** (`local/vps.mjs`, dari Mac lewat SSH, host key dipatok di `.local/known_hosts`):
`setup` (sekali; `.local/vps.json`), `bootstrap` (root: zona Asia/Jakarta, Node 22.17.1 checksum, Caddy, swap, user `arsip`,
Claude Code, systemd), `login` (interaktif `claude auth login`), `push`, `apply`, `status`, `logs [--follow]`, `password`,
`metrics`. `push` mengirim `git ls-files --cached --others --exclude-standard` kecuali `SKIP`
(`docs|reports|tests|site|output|removed-from-archive|.local|.stockbit-publish`, `.env*`, `__pycache__`), dan dari `.env.chat`
hanya dua key. Build di `app.new` selagi server lama melayani (`buildScript`: `--pin` hanya push pertama), lalu
`swapScript` (pindah `chat.sqlite*`, `.env.chat`; `app.old`), restart; gagal → `restoreScript`. Kunci mesin VPS: zona
Indonesia + `/etc/machine-id` + metadata Tencent (region `ap-jakarta`, `instance-id`); gagal → exit 78, systemd
tidak mengulang (`RestartPreventExitStatus=78`).

**Mac** (`local/server.mjs`): `--pin` (pertama kali), `--build` (setelah dokumen baru), `--build-only`, `--repin`, `--port`,
`--host --allow-lan`, `--model`, `--effort`, `--concurrency`. Kunci mesin menolak container, zona non-Indonesia, ID mesin beda.
**Tunnel** (`local/remote.mjs`): `setup`, `install`/`uninstall` (LaunchAgent), `status`, `password`, `tunnel`.

**Publish dari desk** (`tools/publish_stockbit.py`, cwd = akar arsip): preflight (cabang main, tidak ada yang di-stage, hanya
berkas Stockbit/BEI dan `docs/` yang berubah, tidak ada commit belum dipush, disk ≥1,5 GB)
→ `python3 -B tools/sync_idx.py --stockbit-only --no-build --with-bei` → cek kategori/tanggal di build sementara
→ `python3 -B build.py --out docs` → `node local/vps.mjs push` **sebelum** commit → commit `Stockbit: ringkasan <tgl>` (+ `BEI: …`) → push → tag `stockbit-publish-YYYYMMDD-HHMMSS`.
Exit: 0 ok/tidak berubah, 1 lain-lain, 2 preflight, 3 sinkron, 4 cek build, 5 push VPS gagal (situs lama), 6 VPS baru tanpa
commit (`vps_not_committed`), 7 berkas `sb*`/`bei*` akan terhapus tanpa tahanan desk, 8 push git gagal (`push_failed`).
Status log: `published`, `vps_failed`, `vps_not_committed`, `push_failed`, `gagal`, `tidak ada perubahan`.
**Rollback** (`tools/rollback_stockbit.py [--tag …] [--dry-run]`): revert (published), reset (push_failed lokal), restore
(vps_not_committed), lalu `vps.mjs push`; hari yang dibatalkan ditahan di `.stockbit-hold.json`/`.bei-hold.json`
(`{"format":1,"days":{tgl:{"sha256":…}}}`; sha `"*"` = semua versi hari itu, `withheld_by: "desk"` = tahanan desk). Publish yang mencabut hari tahanan
desk tidak bisa di-rollback (exit 2). Rincian lengkap: docstring kedua skrip dan `tools/desk_files.py`.

**Kontrak desk** (repo IDX Signal Desk; jangan diubah tanpa mengubah desk):
- Desk menjalankan `python -B tools/publish_stockbit.py` dan `python -B tools/rollback_stockbit.py` dari akar arsip (path tetap).
- Desk mencari string `--stockbit-since`, `--allow-provisional`, `--with-bei` di teks `tools/publish_stockbit.py` dan
  `tools/sync_idx.py`; ketiganya harus tetap ada di kedua berkas.
- Desk membaca `.stockbit-publish/log.jsonl` (`target`, `status`, `files`, `day_shas`, `day_shas_bei`, `withheld`,
  `withheld_bei`, `interim`), `needtobeindexed/idx-signal-desk/.sync-bei.json`, format tag, dan baris JSON terakhir
  (`supports: ["stockbit","bei"]`, `bei_skipped`, `vps`). `tests/test_desk_roundtrip.py` mengunci semuanya.
- VPS: unit systemd `ExecStart=${NODE} local/server.mjs`; jangan memindah `local/server.mjs` (butuh `bootstrap` ulang).

## 10. Sinkron dan harga

- `tools/sync_idx.py` (desk `--server`, bawaan `http://127.0.0.1:8787`, hanya GET, HTTPS wajib untuk non-loopback):
  kepemilikan (`kepemilikan.json`, `kepemilikan-laporan.json`, `kepemilikan-perubahan.json`; ledger KSEI dibuka read-only),
  Stockbit (`--stockbit-only`/`--with-stockbit`, sejak `STOCKBIT_SINCE`) dan BEI (`--bei-only`/`--with-bei`) lewat satu
  `sync_family`. Hanya hari `final` (kecuali `--allow-provisional`); sha256 ekspor dicek; `llm_calls` harus 0; tahanan rollback
  dan "Tahan dari web" desk (ekspor `withheld`) dihormati; BEI dipatok ke `profile_id` di `.sync-bei.json`. `REDACTIONS`
  menyamarkan nomor HP dan kode akses rapat. Tulis lewat staging; exit 0 ok, 1 server/data/ditolak, 2 profil beda, 3 build gagal.
  Format data: docstring `ownership_data()`, `filing_rows()`; naikkan `OWNERSHIP_FORMAT`/`REPORTS_FORMAT` bila bentuk berubah.
- `tools/sync_prices.py`: `Close 1D` dari dataset broksum (`BROKSUM_DIR`) per tanggal snapshot KSEI (as-of ≤7 hari) →
  `needtobeindexed/harga/harga.json`. Jalankan setelah ada bulan KSEI baru, lalu build.

## 11. Invarian keamanan (dari audit 20 September 2026; jangan dilonggarkan tanpa alasan tertulis)

- Chat: browser tidak bisa mengirim riwayat, model, URL, dokumen, atau pengaturan token; riwayat dirujuk token acak 256 bit.
  Validasi input dan batas byte/token/panggilan dicadangkan sebelum setiap panggilan, disimpan di SQLite (bertahan restart).
- Model tanpa shell/berkas/alat (bridge `--tools ""`); mode agen hanya alat baca-saja dengan host/path tetap; secret tidak
  pernah masuk prompt atau ke browser. Dokumen dan hasil alat adalah data, bukan instruksi.
- Pencarian: hanya own-property berupa array yang menjadi posting (`constructor` aman); peta tanpa prototype.
- Render: jawaban model dan Markdown lewat allowlist tag/atribut + validasi URL (style, form, SVG, media, event handler
  dibuang); SRI untuk CDN; CSP meta dengan hash skrip hasil build; JSON tertanam meng-escape `<`, `>`, `&`; iframe laporan
  tanpa `allow-same-origin`; `Referrer-Policy: no-referrer`.
- Server: hanya loopback; listener jarak jauh wajib sesi bertanda HMAC (`__Host-` cookie, `SameSite=Strict`); origin chat hanya
  alamat server sendiri; IP klien dari socket (Mac) atau entri terakhir `X-Forwarded-For` dari Caddy, diberikan sebagai
  argumen `ArchiveChat.fetch(request, address)`, tidak pernah dari header klien. Chat aktif hanya bila `env.MODEL_FETCHER` ada.
- Statistik: teks pertanyaan + hash klien, tanpa IP mentah, riwayat model, atau key; laporan HTML meng-escape teks.
- Build/sinkron: sumber atau tujuan symlink ditolak (`tools/build_safety.py`), tujuan build harus folder hasil build; sinkron
  menulis lewat staging (nama acak, `os.replace`) dan memeriksa profil/perubahan bersamaan sebelum commit.
- Batas yang diakui: prompt injection masih dapat memengaruhi isi jawaban; ini bukan penetration test; sinkron multi-berkas
  tidak atomik terhadap mati listrik/SIGKILL. Uji serangan hanya offline (`tests/security.mjs`, `tests/web_security.cjs`,
  `tests/test_sync_security.py`), tidak pernah ke situs publik.

## 12. Mau mengubah X? Edit di sini

| Tugas | Tempat |
|---|---|
| Sumber/kategori baru, aturan nama/tanggal | `CATEGORIES`, `parse_dates` di `build.py`; `tools/desk_files.py` untuk keluarga desk |
| Tampilan atau perilaku viewer | `app.css`, `app.js` (lalu `UPDATE_GOLDEN=1`, lihat §13) |
| Kotak chat di browser | `chat.js` |
| Rute chat, anggaran, aturan jawaban | `worker/core.mjs` (`converse`, `ANSWER_RULES`, `RAW_LIMIT`, `PIPELINE`) |
| Pemilihan dokumen/tanggal/cakupan | `worker/retrieval.mjs` |
| Bahan dokumen utuh / digest desk | `worker/document-material.mjs` |
| Anggaran ticker Stockbit/BEI/legacy | `worker/stockbit.mjs` |
| Blok [A2]/[H], rute tabel | `worker/tables.mjs`; tabelnya `tools/archive_tables.py` |
| Screening aksi korporasi, cek angka/nama | `worker/screening.mjs`; tabel `tools/event_index.py` |
| Sinyal KSEI | `tools/ksei_signals.py`, `worker/signals.mjs` |
| Mode agen | `worker/agent.mjs`, `worker/facts.mjs` |
| Pemisahan sumber (evidence) | `tools/evidence_index.py` |
| Kuota/batas server | env di `local/server.mjs`, `LIMITS` di `worker/core.mjs`, `worker/index.mjs` |
| Pemanggilan `claude -p` | `local/claude-bridge.mjs` |
| Deploy VPS | `local/vps.mjs` |
| Publish/rollback desk | `tools/publish_stockbit.py`, `tools/rollback_stockbit.py`, `tools/desk_files.py` |
| Sinkron desk / kepemilikan | `tools/sync_idx.py` |
| Statistik pertanyaan/biaya | `tools/chat_metrics.py` (`node local/vps.mjs metrics`, atau `--from-file`) |

Setiap mengubah prompt/aturan yang memengaruhi jawaban tersimpan, naikkan `PIPELINE` (atau `NOTE_VERSION` untuk catatan).

## 13. Tes

`sh tools/test.sh` membangun situs dan aset dari `needtobeindexed/` ke folder sementara (`ARSIP_TEST_SITE`,
`ARSIP_TEST_ASSETS`), memasang `jsdom@26.1.0 marked@15.0.7 dompurify@3.4.15` sekali ke `~/.cache/arsip-test-deps`, lalu
menjalankan `python3 -B -m unittest discover -s tests -p 'test_*.py'`, `node --test tests/*.mjs`, dan tiap `tests/*.cjs`.

| Invarian | Tes |
|---|---|
| Aturan nama/tanggal, output build, hash `index.html` | `tests/test_build_golden.py` (`tests/golden/build.json`) |
| Aset chat (manifest, hash, pengecualian, tabel) | `tests/test_worker_assets_golden.py` (`tests/golden/worker.json`) |
| Viewer, `#doc=`, `#emiten=`, kepemilikan, payload jahat | `tests/doc_viewer.cjs`, `tests/bei_viewer.cjs`, `tests/stockbit_viewer.cjs`, `tests/ownership_ui.cjs`, `tests/web_security.cjs` |
| Kotak chat | `tests/chat_ui.cjs` |
| Rute dan bahan chat | `tests/accuracy.mjs`, `tests/reading_budget.mjs`, `tests/doc_material_tokens.mjs`, `tests/ticker_material.mjs`, `tests/tables.mjs`, `tests/workflow.mjs` |
| Keamanan chat, cache, indeks sumber | `tests/security.mjs`, `tests/cache.mjs`, `tests/source-store.mjs` |
| Mode agen, sinyal | `tests/agent.mjs`, `tests/agent_optimization.mjs`, `tests/signals_validity.mjs`, `tests/test_ksei_signals.py` |
| Bridge, kunci mesin, CLI lokal | `tests/local_server.mjs`, `tests/server_startup.mjs` (dilewati di luar zona Indonesia) |
| Push VPS, statistik VPS | `tests/vps_push.mjs`, `tests/vps_metrics.mjs`, `tests/test_chat_metrics.py` |
| Sinkron desk end to end | `tests/test_sync_e2e.py`, `tests/test_stockbit_sync.py`, `tests/test_bei_sync.py`, `tests/test_sync_security.py` |
| Publish/rollback, kontrak desk | `tests/test_desk_roundtrip.py`, `tests/test_stockbit_publish.py`, `tests/test_bei_publish.py`, `tests/test_desk_files.py` |
| Kepemilikan | `tests/test_ownership_sync.py`, `tests/test_ownership_corpus.py`, `tests/test_sync_prices.py` |
| Dokumen ini | `tests/test_agents_doc.py` (setiap path dan perintah di AGENTS.md ada) |

Golden: setelah perubahan yang disengaja pada `build.py`/`app.css`/`app.js`/`chat.js`/`report-*.js` atau aset chat, jalankan
`UPDATE_GOLDEN=1 python3 -B -m unittest discover -s tests -p 'test_*_golden.py'` dan periksa diff-nya.
Build bisa dibandingkan byte demi byte dengan `PYTHONHASHSEED=0 BUILD_ID=<tetap>`. Biaya token offline:
`node tools/bench_tokens.mjs` (`--bridge` untuk A/B nyata lewat Claude; tidak dijalankan `tools/test.sh`).

## 14. Sudah pensiun (kode ada di riwayat git)

- Cloudflare Workers + Durable Object (`publish_chat.py`, `wrangler.jsonc`): chat kini `local/server.mjs` di VPS.
- OpenRouter/Qwen sebagai model dan evaluatornya: kini `claude -p`; hanya nama kelas `OpenRouter` dan label `MODEL` tersisa.
- `chat.config.json`: alamat API kini selalu `/api/chat` satu origin (`CHAT_API_URL` hanya untuk uji).
- Claude Artifact (`--fragment-index`, penghitung pengunjung): situs tidak lagi dipublikasikan sebagai Artifact.
- GitHub Pages sebagai host: `docs/` tetap dibangun dan di-commit sebagai riwayat saja.
- `site/` yang dilacak git dan status log `deployed_*`: hanya `docs/`; catatan lama `worker_version_*` tetap terbaca rollback.
- Digest Emiten (`digest_*.md`) dan Analisis KI manual: tetap dibangun untuk tautan lama, tidak diperbarui.
- `SECURITY_REVIEW.md` dan `reports/` yang dilacak: invarian yang masih berlaku ada di §11.
