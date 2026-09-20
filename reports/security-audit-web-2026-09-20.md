# Audit web dan data — 20 September 2026

## Cakupan dan metode

Baseline fd8d647: generator, viewer Markdown, enam laporan HTML lama, routing/pencarian, data kepemilikan 963 emiten, sinkron IDX Signal Desk, pembacaan SQLite lokal, build Worker dan konfigurasi hosting yang dapat diperiksa. Pengujian berbahaya dilakukan di salinan git archive terpisah tanpa secret, dengan fixture dan jaringan model simulasi. Tidak ada flood atau payload serangan ke produksi, tidak ada sinkron ke server asli. Semua 52 berkas sumber dilindungi dengan hash.

## Temuan dan perbaikan

| Temuan | Bukti dan penanganan |
|---|---|
| Laporan HTML memiliki hak origin halaman utama | Enam laporan sebelumnya memakai iframe tanpa sandbox. Sekarang laporan asli berada dalam srcdoc opaque; hanya wrapper tepercaya berada di origin situs. CSP membatasi skrip berdasarkan hash. Bukan temuan bahwa laporan yang ada mengandung malware. |
| Markdown mengizinkan style/form yang tidak diperlukan | Fixture membuktikan sanitasi lama mempertahankan elemen tersebut. Allowlist tag/atribut dan validasi URL kini membuangnya. |
| Kegagalan penjagaan profil terjadi setelah penulisan | Fixture perubahan profil mereproduksi file tujuan sudah berubah sebelum error. Sekarang staging, pemeriksaan perubahan bersamaan, lalu commit dan rollback pada exception. |
| Berkas sementara dapat mengikuti symlink | Canary di lingkungan terisolasi dapat ditimpa melalui nama .tmp yang dapat ditebak. mkstemp acak, os.replace, dan penolakan target symlink menutup jalur tersebut. |
| Output build dan sumber symlink kurang dibatasi | Validasi tujuan menolak akar/sumber/symlink/folder yang bukan hasil build; sumber di luar folder dan symlink ditolak. |
| Struktur data kepemilikan tidak divalidasi | Skema/tipe/batas ukuran/ticker unik diperiksa; kunci peta memakai objek tanpa prototype. Angka dan teks berbahaya diuji. |
| Routing dan embedding JSON perlu diperketat | Peta tanpa prototype, pencarian 128 karakter, escape < > & pada JSON mencegah nama properti bawaan dan keluarnya data dari script. |

Arsip HTML untuk model dibuka kembali dari pembungkus agar model tetap menerima seluruh sumber penelitian asli, termasuk data riset dalam script. Tidak ada pemotongan isi untuk membuat sandbox.

## Hasil pengujian sebelum deploy

- 13 unittest Python: batas filesystem, symlink, kegagalan profil, commit/rollback, perubahan bersamaan, tanggal/path, transport, redaksi, SQLite read-only, rekonstruksi HTML, embedding JSON.
- 8 skenario jsdom: CSP/hash struktural, Markdown/payload URL, routing, seluruh 963 emiten dan grafik, payload nama/investor, penolakan skema rusak, enam wrapper, pesan antarframe/copy fallback.
- 34 uji backend chat/security lulus, ditambah uji UI chat dan workerd + SQLite dengan provider simulasi; 8 dokumen SOCI dalam 9 kelompok, puncak dua pembaca.
- Seluruh 50 dokumen/184 bagian dapat direkonstruksi dari sumber, tanpa perubahan isi penelitian.
- Key khusus OpenRouter tidak ditemukan pada 153 blob sepanjang riwayat Git yang diperiksa; pola kredensial tidak ditemukan dalam berkas terlacak saat audit. Ini bukan bukti ketiadaan semua bentuk secret.

## Akun dan hosting (pemeriksaan baca saja)

- GitHub Pages: main/docs, HTTPS enforced, HTTP beralih ke HTTPS, CNAME menunjuk GitHub Pages yang benar.
- GitHub pemilik: 2FA aktif; Actions default read dan tidak boleh menyetujui PR.
- Cabang main belum memiliki branch protection/ruleset. Rekomendasi: lindungi dari force-push/delete dan tentukan apakah PR wajib; jangan mengubah alur kerja tanpa pilihan pemilik.
- Cloudflare dashboard Authentication menunjukkan **Two-Factor Authentication Inactive**. Pemilik perlu mengaktifkan TOTP/security key dan menyimpan recovery codes sendiri; audit tidak mengubah kredensial.
- Respons GitHub Pages belum menyediakan HSTS, X-Frame-Options/frame-ancestors, nosniff, atau Referrer-Policy header pada saat audit. Meta CSP/referrer ditambahkan di HTML, tetapi tidak menggantikan seluruh header. Menambah edge proxy/beralih host memerlukan keputusan konfigurasi terpisah.

## Batas audit

Tidak membuktikan ketiadaan semua celah, ketahanan terhadap kompromi akun/mesin, atau kebenaran isi riset/model. Prompt injection masih dapat memengaruhi jawaban; batas kode membatasi kapabilitas dan biaya. API publik masih dapat dihabiskan kuotanya dengan banyak IP. Sinkron multi-file tidak atomik terhadap mati listrik/SIGKILL. Hak admin/token Cloudflare tidak diaudit menyeluruh; endpoint pengaturan tertentu ditolak oleh scope OAuth yang tersedia. CSP/sandbox perlu verifikasi browser produksi terpisah dari jsdom.

## Penerapan

Diterapkan melalui commit `812f27e`; GitHub Pages berhasil pada run `35521050511`. Versi halaman `20260920225358`, HTML publik identik dengan `docs/index.html`. Worker versi `20e01b51-8676-491a-a8bc-4e2ec5560e42`; `/api/chat/config` mengembalikan 200 dan ready true.

Verifikasi Chrome pada situs publik: halaman utama dan Markdown 19 September beserta daftar isi/ticker tampil; laporan HTML 13–14 September memiliki sandbox `allow-scripts allow-popups`, filter tabel menyusut dari 3.108 baris menjadi 11 untuk BESS, dan pencarian halaman utama berhasil memberi mark di child frame. Tautan tanggal 01 Agu membuka detail di laporan lama. Laporan dinamis 15–19 Agustus merender 62 catatan dan filter DOOH menghasilkan dua. Modul kepemilikan memuat data dan tabel. Tidak ada error/warning konsol pada alur yang diperiksa. Tombol salin diuji di jsdom; clipboard pengguna tidak diubah pada verifikasi publik. Tidak ada panggilan model berbayar tambahan pada audit lanjutan ini.

Semua 52 hash sumber tetap sama setelah deploy. Perubahan chat/cache lain yang muncul selama audit dipertahankan di working tree dan tidak termasuk baseline audit ini.
