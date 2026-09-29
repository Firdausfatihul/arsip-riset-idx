# Pembaruan workflow chat — 29 September 2026

Perubahan berfokus pada pemilihan bahan, kesinambungan percakapan, dan kejujuran evaluasi. Arsitektur tetap memakai jalur arsip dan agen yang sudah ada. Tidak ada classifier tambahan, layanan baru, atau putaran model tambahan untuk memperbaiki routing.

## Dasar pemeriksaan

Audit awal membandingkan empat snapshot laporan privat dengan pertanyaan fixture dan implementasi saat ini. Gabungan snapshot berisi 297 ID pertanyaan unik. Enam dapat dibuktikan sebagai tes produksi; 291 lainnya belum dapat ditentukan asalnya. Pertanyaan yang sama dengan fixture tidak otomatis merupakan tes, karena sebagian fixture berasal dari pertanyaan pengguna.

Klasifikasi yang dibuat ulang untuk satu halaman `questions-0` mencakup 287 ID: 6 tes dan 281 belum terklasifikasi. Ini bukan hitungan seluruh gabungan snapshot. Log yang hanya menyimpan status selesai tidak membuktikan jawaban benar.

## Perubahan

- **Mode normal:** sumber dan tanggal tetap membatasi pencarian topik, percobaan kata kunci ulang, serta tabel aksi korporasi. Tanggal terpisah dipasangkan ke sumber masing-masing. “Terbaru” memilih potret terbaru dari katalog sebelum mencari topik, sehingga tidak diam-diam mengambil dokumen lama yang kebetulan cocok.
- **Percakapan lanjutan:** konteks server menyimpan cakupan dan identitas dokumen. Rujukan seperti “dokumen di atas”, koreksi tanggal, perluasan “semua”, dan pemersempitan topik mempertahankan cakupan yang sesuai. Objek baru tidak otomatis mewarisi dokumen lama.
- **Ringkasan dan penemuan kandidat:** panggilan ekstraksi kata kunci yang sudah ada juga mengenali maksud ringkasan/eksplorasi. Permintaan tanpa ticker tetap dapat diproses. Tanpa sumber/tanggal, penemuan kandidat memakai potret KI Indonesia dan Stockbit terbaru, dengan cakupan disebutkan. Permintaan sumber tanpa tanggal memakai potret terbarunya; “semua” meminta perluasan. CSV dengan pasangan Markdown bernama sama tidak dibaca dua kali.
- **Mode agen:** “terbaru” tidak dibatasi ke hari ini tanpa permintaan pengguna. KSEI otomatis dipakai sesuai kebutuhan kepemilikan/relasi, bukan untuk setiap pertanyaan pengumuman/RUPS. Daftar utama kosong dapat memicu satu pencarian teks cadangan dengan ticker/topik yang sama, selama anggaran alat cukup. Batas empat putaran model dan 18 panggilan alat tetap berlaku.
- **Batas bukti:** hasil alat mempertahankan jumlah yang diterima/ditampilkan, jumlah total, halaman lanjutan, dan penanda pemangkasan. Prompt meminta kesimpulan langsung, temuan yang didukung, dan batas pemeriksaan. Bila daftar utama kosong tetapi model tetap mengklaim belum dipublikasikan/dilaksanakan, pemeriksaan kode menambahkan koreksi eksplisit. Koreksi ini tidak menjamin seluruh narasi model bebas salah.
- **Lintas bursa:** seluruh preview kandidat tetap diperiksa, dibagi menjadi panggilan berurutan di bawah batas ukuran pesan. ID kandidat divalidasi terhadap batch asal; hasil parsial tidak disimpan sebagai seleksi berhasil.
- **Evaluasi:** laporan memisahkan proses selesai, kasus dengan ekspektasi isi, kelulusan fixture, serta kegagalan sumber/fakta/rujukan. Evaluasi lokal diberi ID run dan asal `test`. Tes produksi memakai ledger ID permintaan persis; sisanya `unknown`, bukan otomatis pengguna riil. Parser rujukan evaluator agen menggunakan parser runtime, termasuk rentang ID.

## Integritas arsip

Pembacaan sumber oleh builder mempertahankan CRLF dan BOM untuk merekonstruksi CSV persis. Masalah rekonstruksi bukan penghapusan BOM. Tes offset menyesuaikan satuan Unicode Python, sementara rekonstruksi isi tetap dibandingkan persis. Tidak ada isi `needtobeindexed/` yang diubah.

Ekspektasi tes lama yang bergantung pada tanggal “terbaru”, ID dokumen yang bergeser, dokumen SGX yang sudah dikeluarkan, serta teks label UI lama diselaraskan dengan katalog/perilaku yang sebenarnya.

## Validasi dan batas hasil

Uji offline mencakup pemisahan sumber, pasangan tanggal, follow-up, discovery tanpa kata kunci, deduplikasi CSV, cache, otorisasi, batas alat, fallback agen, pemangkasan bukti, dan klasifikasi laporan. Integrasi native workerd/SQLite memeriksa streaming, cache, konteks percakapan, metrik privat, serta seleksi lintas bursa yang terbagi; semua jaringan model pada tes ini dicegat lokal. Tes DOM memeriksa rujukan, sanitasi, streaming Unicode, retry, pembatalan, dan percakapan baru.

Hasil akhir: **121/121 tes JavaScript dan 28/28 tes Python lulus**, ditambah integrasi native dan tes DOM lulus. Satu run yang bertabrakan dengan pembangunan ulang aset mengalami ENOENT; suite diulang setelah build selesai dan hasil akhir di atas bersih.

Tiga kasus normal dengan model nyata selesai dan memilih sumber yang diharapkan: pasangan Stockbit/KI berbeda tanggal, ringkasan SGX tanpa tanggal, dan eksplorasi Stockbit tanpa ticker. Dua lolos fixture awal; ringkasan SGX gagal pemeriksaan rujukan karena placeholder D1. Perbaikan pemetaan diterapkan hanya pada catatan yang sudah diketahui berasal dari satu dokumen, tidak dengan menebak pengganti rujukan jawaban akhir.

Rerun SGX setelah perbaikan **lulus pemeriksaan sumber dan ID rujukan**, menghasilkan 207 kata, dua dokumen, dan tidak terpotong. Dengan rerun ini ketiga skenario normal memiliki hasil lulus untuk cakupan fixture masing-masing; fakta setiap kalimat belum diaudit seluruhnya.

Dua kasus agen dengan model nyata selesai. TOWR memakai daftar pengumuman terbaru tanpa filter hari ini atau KSEI otomatis. BBCA memicu pencarian teks cadangan, tetapi masih melampaui bukti saat menyimpulkan status publikasi. Satu rerun setelah perbaikan prompt tetap menunjukkan masalah itu; hasil tersebut mendorong koreksi deterministik di atas. Rerun juga mengungkap bahwa evaluator lama melewatkan rujukan rentang yang tidak sah; parser evaluator diperbaiki. Laporan lama dipertahankan sebagai bukti kegagalan, tidak ditulis ulang menjadi lulus.

Fixture dan pemeriksaan rujukan belum merupakan audit seluruh kebenaran fakta atau kelengkapan pasar. Output “singkat” juga tidak selalu mengikuti target panjang. Artefak berisi pertanyaan/jawaban dan tanda pengenal tes disimpan di `reports/private/workflow-update-20260929/`, tidak dipublikasikan.

Biaya provider tercatat untuk empat eksekusi normal dan tiga eksekusi agen: **US$0,121233009**. Ini biaya validasi yang benar-benar dilaporkan provider, bukan estimasi penghematan atau rata-rata biaya produksi.

## Rilis

Worker di-deploy sebagai versi `f9ca588d-c03a-44ef-bfbe-d4b23c5e822a`. Indeks setelah sinkronisasi: **59/59 dokumen siap, 16.450 records, tanpa pending**. Katalog hasil build tetap 59 dokumen dan data kepemilikan 963 emiten/7 bulan. Versi pipeline normal `issuer-cache-v6`, agen `agent-v5.7`; cache jawaban lama tidak dipakai untuk perilaku baru.
