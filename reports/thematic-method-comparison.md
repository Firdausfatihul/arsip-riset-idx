# Metode pencarian lintas negara: pemeriksaan dan prototipe

Status: implementasi SQLite FTS5 dan seleksi kandidat sudah aktif di produksi.
Bagian hasil prototipe di bawah dipertahankan sebagai catatan pengukuran awal;
lihat hasil produksi pada akhir laporan.
Kapasitas 3.000 pertanyaan/hari, 120/IP/jam, 10 analisis bersamaan dan 5/IP telah aktif.

## Penyebab yang teramati

Permintaan lintas negara menemukan 44 dokumen (15.001.562 byte sumber), lalu gagal
pada pembacaan indeks sumber dengan kategori `subrequest_limit`. Panggilan model
hanya untuk mengubah pertanyaan menjadi istilah pencarian. Pengulangan setelah
pencatatan diagnostik mengonfirmasi kegagalan pada tahap `source_index`.

## Perbandingan

| Metode | Efek pada pembacaan berulang | Biaya tambahan | Penilaian |
|---|---|---|---|
| Naikkan kuota pengguna | Tidak mengurangi pembacaan file per pertanyaan | Dapat menambah total pemakaian | Sudah dilakukan untuk akses bersama; tidak menyelesaikan masalah cakupan |
| Tambah cache file saja | Membantu setelah cache terisi | Penyimpanan cache | Permintaan pertama masih dapat gagal; tidak memperbaiki pencarian yang terlalu luas |
| Naikkan paket hosting | Menambah ruang batas platform | Langganan dan pemakaian | Tidak otomatis menurunkan token atau memperbaiki relevansi |
| Indeks SQLite FTS5 persisten + seleksi kandidat dan verifikasi bukti | Query langsung di database; pembacaan file saat impor dokumen baru | Penyimpanan dan operasi SQL; tanpa API embedding | Rekomendasi untuk diuji end-to-end dan diterapkan |
| Pencarian vektor / graph penuh | Dapat membantu istilah implisit dan relasi multi-langkah | Proses embedding/ekstraksi, penyimpanan dan pemeliharaan tambahan | Belum diperlukan sebagai prasyarat untuk memperbaiki kegagalan ini |

## Hasil prototipe tanpa AI

- 50 dokumen, 13.370 bagian sumber dimasukkan ke SQLite FTS5.
- Ukuran database 28.262.400 byte (sekitar 27 MiB).
- Pembuatan indeks lokal sekitar 409 ms; bukan pengukuran impor Cloudflare.
- Query geografis ASX/SGX/Australia/Singapura: 168 bagian dari 29 dokumen.
- Jumlah isi mentah kandidat 626.546 byte; masih harus dipersempit sebelum sintesis.
- Lima query lokal: 2,62 / 1,91 / 0,91 / 4,51 / 0,73 ms. Bukan janji latensi publik.
- 0 pembacaan file eksternal per query setelah impor; 0 panggilan AI untuk indeks/query.
- Spot check bukti menemukan Orbit Marketing, ERA Graharealty, Marco Polo, KORIKA,
  dan Bintan Investment Management. Ini memeriksa keberadaan bahan, bukan membuktikan
  semuanya emiten BEI atau bahwa seluruh transaksi selesai.

## Rancangan awal dan batas implementasi

1. Tabel dokumen: ID stabil, hash, bursa, judul, tanggal dokumen, tautan sumber.
2. Tabel bagian: ID dokumen, section ID, urutan/baris, ticker, konteks, isi asli;
   indeks FTS5 menunjuk ke tabel ini. Tanggal kejadian tetap dipisahkan dari tanggal dokumen.
3. Impor melalui endpoint privat per dokumen/batch, hanya hash baru; dapat dilanjutkan
   dan tidak mengaktifkan dokumen sebelum jumlah serta hash bagian lolos pemeriksaan.
4. Untuk pertanyaan tematik, normalisasi nama negara/bursa dan cari kandidat tanpa AI
   bila maksudnya jelas. Pisahkan kandidat geografis dari bukti hubungan perusahaan.
5. Bila perlu model seleksi, berikan cuplikan semua kandidat dalam batch terbatas;
   gabungkan kandidat duplikat sambil mempertahankan semua lokasi sumber.
6. Ambil paragraf/section asli kandidat dan konteks sebelum/sesudah dari SQLite untuk
   sintesis. Periksa identitas perusahaan, emiten BEI vs perusahaan privat Indonesia,
   perusahaan berdomisili Singapura vs tercatat SGX, rencana vs transaksi selesai.
7. Catatan fakta dapat dipakai ulang per hash dokumen dan versi metode. Cache jawaban
   mencakup versi arsip. Tambahan dokumen tidak menghapus hasil baca dokumen lama.
8. Rekam kandidat ditemukan/terpilih, panggilan/token/biaya, cache, dan tahap kegagalan.
   Implementasi sederhana mempertahankan batas analisis dan meminta cakupan lebih sempit
   jika melampaui batas. Tidak menambahkan antrean/pekerjaan latar belakang atau checkpoint
   riset lintas permintaan. Jangan klaim screening lengkap setelah pemilihan cuplikan.

FTS5 mengatasi pembacaan puluhan file saat query, tetapi tidak dengan sendirinya
memahami hubungan implisit. Alias, pencarian lanjutan, dan verifikasi sumber tetap
perlu diuji. Target awal: 1-2 panggilan AI pada bahan yang muat; hasil luas dapat
memerlukan batch tambahan. Ini target awal; hasil produksi tercantum di bawah.

## Sumber teknis

- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
- https://developers.cloudflare.com/workers/platform/limits/
- https://www.sqlite.org/fts5.html

## Simulasi biaya model, bukan tagihan hasil uji

Metadata endpoint OpenRouter diperiksa langsung. Pada tier dasar: input
US$0.03/juta token dan output US$0.13/juta token.
Dua panggilan, masing-masing 20.000 token input + 1.000 token output, menghasilkan
US$0.001460/pertanyaan atau US$1.46/1.000 pertanyaan. Harga bertingkat
naik mulai 32.000 token prompt per panggilan; simulasi ini tidak berlaku jika
melewati tier itu, membutuhkan batch tambahan, atau tarif provider berubah.
Belum termasuk biaya hosting/SQL. Cache jawaban aplikasi tidak membuat panggilan
model baru, sedangkan permintaan database tetap ada.

Metadata harga: https://openrouter.ai/api/v1/models/qwen/qwen3.7-flash/endpoints

## Implementasi dan pengujian produksi

Versi Worker akhir: `8a609fce-44f8-4bef-8f63-ef4e7aa56ac3`.
Indeks produksi mengonfirmasi **50/50 dokumen, 13.370 bagian**, tanpa dokumen pending.
Mengulang sinkronisasi melewati seluruh dokumen lama. File sumber tidak berubah.

Implementasi memakai SQLite yang sudah ada, satu endpoint impor privat, dan skrip
sinkronisasi yang dipanggil oleh proses publish. Tidak menambah layanan, embedding,
graph, scheduler, atau sistem pekerjaan riset latar belakang.

Pencarian geografis menemukan 168 kandidat dari 29 dokumen; model seleksi memilih
11 kandidat untuk pemeriksaan, dengan 6 dokumen bukti. Teks asli dan tetangga dipakai
untuk sintesis; pemilihan cuplikan tetap dapat melewatkan hubungan lain. Seleksi dapat
dipakai kembali lintas pertanyaan dan pengguna, sedangkan konteks percakapan tetap
terpisah. ID rujukan akhir dibatasi ke dokumen bukti yang diberikan kepada model.

| Pengukuran nyata | Panggilan AI | Input token | Output token | USD tercatat | Detik |
|---|---:|---:|---:|---:|---:|
| first_two_stage_test | 2 | 53480 | 1838 | 0.00494642 | 26.65 |
| current_release_reusing_candidates | 1 | 9788 | 3098 | 0.00069638 | 44.40 |
| current_release_answer_cache | 0 | 0 | 0 | 0.00000000 | 0.50 |

Pengukuran pertama dua tahap dilakukan sebelum penyempurnaan instruksi jawaban dan
alokasi reasoning akhir; versi terakhir menggunakan hasil seleksi kandidat yang sama.
Jangan menganggap ketiga baris sebagai tiga pengujian cold dengan konfigurasi identik.
Biaya hosting/SQL tidak termasuk. Semua tiga pengukuran mempunyai usage lengkap.
Hasil asli berikut receipt/statistik pertanyaan disimpan privat; ringkasan tanpa
identitas pengguna ada di `thematic-production-results.json`.

Iterasi awal setelah FTS, sebelum seleksi kandidat, selesai tetapi terlalu banyak
memuat rekening kustodian sebagai hubungan perusahaan: 7 panggilan, 90,88 detik,
biaya tercatat US$0,01482848 dan satu receipt belum lengkap. Audit generation terpisah
menemukan tambahan US$0,00443490 untuk panggilan terpotong, sehingga biaya aktual
iterasi tersebut US$0,01926338. Perbaikan stream sekarang membaca receipt usage
setelah penanda length sebelum retry; catatan historis tetap ditandai belum lengkap.

49 pengujian Node lulus, termasuk hash/rollback impor, pemisahan versi, pencarian
seluruh korpus tanpa fetch file, cache kandidat lintas pertanyaan, serta receipt
setelah keluaran terpotong. Pengujian workerd/SQLite asli dengan provider simulasi
juga lulus. Endpoint impor tanpa token ditolak.

Pemeriksaan manual jawaban dipakai untuk memperjelas bursa vs domisili, arah transaksi,
rekening kustodian vs pengendali, dan pihak privat. Ini tidak membuat model menjadi
validator fakta: klasifikasi status emiten/bursa, status terkini, dan hubungan kontrol
masih perlu dicocokkan dengan sumber; keluaran dapat tetap mengandung inferensi yang
terlalu kuat atau melewatkan kandidat. Uji di atas membuktikan alur selesai, rujukan
berasal dari dokumen yang diberikan, dan pemakaian tercatat, bukan audit menyeluruh
kebenaran setiap kalimat atau cakupan semua hubungan Indonesia–ASX/SGX.
