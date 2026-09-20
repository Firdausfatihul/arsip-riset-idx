# Audit keamanan chat arsip — 20 September 2026

## Lingkup dan isolasi

Audit mencakup input HTTP, riwayat percakapan, pencarian dokumen, pemakaian OpenRouter,
kuota SQLite, pembacaan paralel, keluaran streaming, dan render jawaban browser.
Pengujian adversarial dilakukan pada salinan `git archive` commit `3e884d9`, di direktori
temporer terpisah. `.env.chat` dan kredensial Cloudflare tidak disalin. Seluruh jaringan
provider pada test diganti simulasi; attack test tidak dikirim ke situs publik.

Hash SHA-256 seluruh 52 berkas `needtobeindexed/` dicatat sebelum pengujian dan
cocok sesudah patch. Dokumen arsip tidak diedit. Patch sumber dipindahkan ke proyek
utama setelah tes terisolasi lulus; output frontend dibuat kembali dengan generator.

## Temuan yang direproduksi dan perbaikan

| Temuan sebelum patch | Bukti terisolasi | Perbaikan |
|---|---|---|
| Riwayat dapat dipalsukan | Pesan `assistant` buatan klien diterima | Riwayat dari klien ditolak; token acak mengacu riwayat server |
| Konteks pengguna terlalu besar | Tiga pesan pengguna, total sekitar 90 KB, diterima | Pertanyaan 600 karakter, body 4 KB, tiga pertukaran singkat dari server |
| Pencarian prototype menyebabkan crash | Kata `constructor` menghasilkan TypeError | Hanya own-property berupa array boleh menjadi posting pencarian |
| Model dapat merusak tampilan lewat CSS | `style="position:fixed;inset:0"` tetap ada setelah sanitasi lama | Allowlist tag/atribut, sanitasi fragment terpisah sebelum pemasangan DOM |
| Pembacaan dan biaya tidak dibatasi menyeluruh | Semua arsip sekitar 15,2 MB bisa dipilih; hanya final context diperiksa | Batas bahan, pesan per call, total input/output/call, dan anggaran global persisten |
| Unggahan lambat belum memiliki deadline | Pembacaan body menunggu tanpa timeout | Batas ukuran saat streaming, 5 detik, kuota ingress, maksimal empat unggahan |
| Pembacaan SOCI berurutan | 3,2 MB bahan, lima kelompok lama, 237 detik pada pengukuran sebelumnya | Dua pembaca, kelompok lebih kecil, streaming aktivitas, progress berdasarkan bagian selesai |

DOMPurify diperbarui dari 3.2.4 ke 3.4.15. Library CDN dikunci dengan SHA-384 SRI.
Versi lama memiliki advisori publik; tidak semua advisori cocok dengan konfigurasi
aplikasi ini. Audit tidak mengklaim seluruh advisori berhasil dieksploitasi di situs.

## Verifikasi otomatis

- `node --test tests/worker.mjs tests/security.mjs`: **34 tes lulus**.
- `tests/chat_ui.cjs`: input sebagai teks, sanitasi script/CSS/form/SVG/media/URL,
  streaming Unicode, link sumber, loading, pertanyaan lanjutan, retry, stop, reset.
- `tests/worker_runtime.cjs`: workerd asli + SQLite, delapan dokumen SOCI, sembilan
  kelompok baru, maksimal dua panggilan pembaca bersamaan, SSE bertahap, riwayat
  lanjutan server, dan penolakan riwayat palsu. Semua outbound diintersep lokal.
- Rekonstruksi seluruh 50 dokumen dari 184 bagian sama persis dengan hasil build.
- Uji batas: satu juta karakter, Unicode tersembunyi, pemalsuan model/token/role,
  URL metadata/SSRF dan path traversal dalam parameter, prototype key, MIME salah,
  body besar/lambat, flood invalid, kuota IP/global, anggaran antar-restart, token
  palsu/beda IP/kedaluwarsa, SQL injection sebagai data, SSE besar/rusak, pembatalan
  sebelum call, dua pembaca, serta kegagalan bagian tanpa menyatakan selesai.

Test tidak mengeksekusi payload destruktif di OS. SQL injection dicoba pada SQLite
`:memory:` dengan parameterized query. Skenario SSRF menguji penolakan parameter
URL dan endpoint tetap; tidak menghubungi layanan metadata atau host pihak ketiga.

## Batas perlindungan

- Ini audit terbatas, bukan jaminan bebas celah atau penetration test independen.
- Prompt injection dapat mengubah isi analisis model. Pemisahan instruksi/data
  mengurangi risiko, tetapi sanitasi tidak membuktikan model kebal. Model tidak
  memiliki tools/shell/file access, tidak menerima secret, dan tidak bisa mengubah
  batas biaya yang dipaksakan kode. Arsip tetap diberikan utuh sebagai data.
- Layanan publik tanpa akun bisa dihabiskan kuotanya oleh pengguna bermacam IP.
  CORS bukan autentikasi. Anggaran harian membatasi dampak pemakaian AI, bukan
  menjamin ketersediaan atau melindungi dari seluruh serangan volumetrik.
- Batas byte JSON bukan hitungan token persis. Anggaran keluaran memakai alokasi
  maksimum, termasuk retry; bukan nilai dolar/tagihan. Pembatalan tidak menjamin
  provider menggratiskan pekerjaan yang sudah berjalan.
- Riwayat server berisi tiga pertukaran ringkas, berlaku satu jam; pembersihan
  fisik dilakukan saat request berikutnya. IP berubah memerlukan Percakapan baru.
- Review ini fokus fitur chat dan jalur yang dipakainya; berkas HTML riset lama
  tetap menjadi konten publik milik pengelola, bukan kode yang diaudit menyeluruh.

## Rujukan

- [OWASP: LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
- [DOMPurify security advisories](https://github.com/cure53/DOMPurify/security/advisories)
- [OpenRouter reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
