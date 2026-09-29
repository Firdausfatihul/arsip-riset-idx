# Optimasi alur chat — 29 September 2026

Optimasi yang dirilis menghapus pekerjaan berulang dan memperbaiki identitas cache tanpa mengganti model, batas sumber, jumlah kandidat, pemeriksaan fakta, atau prompt catatan. Satu calon perubahan dengan penghematan besar—catatan dokumen yang dapat dipakai ulang setelah sumber pendamping ditambahkan—ditahan karena evaluasi belum menunjukkan kualitas faktual yang setara.

## Pemeriksaan awal

Baseline kode: `ccc1da70c4dd8a5c869f24ee9769d23a8263af8e`. Korpus pembanding: 59 dokumen, versi `65c635fd022bc96f`. Snapshot metrik tujuh hari memuat 289 masukan dan 280 analisis, biaya diketahui US$0,363110998, serta 10 panggilan tanpa usage. Asal seluruh masukan snapshot masih `unknown`; kesamaan kalimat dengan fixture bukan bukti pertanyaan itu tes. Hanya satu event normal pada snapshot memakai v6, sehingga rata-rata seluruh versi tidak digunakan sebagai ukuran performa kode terbaru.

Semua percobaan dalam laporan ini adalah tes lokal yang ditandai `origin:test`. Pertanyaan SGX berurutan merupakan benchmark sintetis. Tidak ada permintaan evaluasi yang memakai endpoint chat atau kuota agen produksi. Jawaban lengkap, receipts, prompt percobaan, dan pemeriksaan sumber tersimpan di `reports/private/optimization-audit-20260929/`.

## Perubahan yang dirilis

- **Agen dengan pertanyaan identik bersamaan:** satu pekerjaan model, satu rangkaian permintaan data, dan satu reservasi kuota. Hasil diberikan kepada setiap klien dengan token percakapan masing-masing. Pembatalan penunggu tidak membatalkan pemilik. Jika pemilik gagal atau dibatalkan, penunggu aktif boleh mencoba sekali dengan model, sinyal, dan kuotanya sendiri. Jawaban kontekstual tetap terpisah antarklien.
- **Identitas jawaban agen:** mempertahankan huruf besar/kecil, tanggal efektif pada prompt, model, instruksi/skema alat, versi dokumen, fingerprint data turunan, dan riwayat. `NAIK` sebagai kode saham tidak bertabrakan dengan kata biasa `naik`.
- **Identitas data:** builder menulis manifest sekali setelah semua aset selesai. `asset_hashes` berisi SHA-256 byte akhir events, ownership, signals, dan ksei_history; `data_version` menggabungkannya. Versi dokumen tetap terpisah. Jawaban normal bergantung pada events; catatan sumber tidak dibuang hanya karena data kepemilikan berubah. Pemeriksaan rilis menemukan urutan anggota kelompok KSEI berbeda antarproses Python; generator kini mengurutkannya sebelum menyusun sinyal agar data sama tidak menghasilkan invalidasi cache palsu.
- **Alat dan HTTP agen:** permintaan identik setelah validasi berbagi promise. Hasil alat berikutnya merujuk ID panggilan pertama, sementara bukti aslinya tetap ada. Query dan periode berbeda tetap terpisah. Kegagalan dapat dicoba kembali dalam batas panggilan yang sama. Cache respons datacat/web memakai versi format tersendiri, sehingga perubahan prompt agen tidak membuang respons mentah yang masih berlaku. TTL, batas penyimpanan 300 KB, dan larangan menyimpan 404 dipertahankan.
- **Normal:** pemeriksaan dokumen asli memakai pilihan dokumen yang sudah divalidasi; tidak memanggil model penentu istilah untuk kedua kali. Ticker dan cakupan diparsing sekali. Pembacaan bukti, penentuan cakupan, instruksi catatan, dan pembacaan dokumen lengkap dipisahkan menjadi fungsi kecil.
- **Cache normal:** identitas bahan dokumen utuh terpisah dari judul sumber pendamping. Catatan tetap dibedakan oleh instruksi/fokus aktual. Versi catatan terpisah dari versi routing. Seleksi lintas negara bergantung pada identitas dokumen/bagian dan preview, tanpa label D sementara yang dapat bergeser saat build.
- **Kode dan evaluasi:** fungsi `userTerms` yang tidak dipakai dihapus; parser rujukan normal, agen, dan evaluator disatukan. Semua biaya primer dan percobaan ulang dipertahankan, termasuk gagal. Statistik jumlah alat juga disimpan bila proses gagal sebelum jawaban akhir. `final_usage` tetap membedakan percobaan terakhir dari total biaya.

## Penghematan yang dapat dibuktikan

| Skenario offline | Sebelum | Sesudah | Pemeriksaan |
|---|---:|---:|---|
| Dua pertanyaan agen identik bersamaan | 6 panggilan model, 2 HTTP, 2 kuota | 3 panggilan model, 1 HTTP, 1 kuota | Jawaban dan rujukan sama; konteks klien terpisah |
| Pemeriksaan dokumen asli yang telah dipilih | Mengulang penentuan istilah | Tidak ada panggilan penentu istilah tambahan | Dokumen, istilah, batas pembacaan dipertahankan |
| Label D berubah tetapi kandidat lintas negara sama | Seleksi model diulang | Hasil seleksi dapat dipakai ulang | Perubahan isi/model/urutan tetap membatalkan cache |

Angka panggilan di atas bukan estimasi persentase penghematan tagihan seluruh situs. Manfaatnya bergantung pada frekuensi pertanyaan bersamaan, ekspansi sumber, dan penomoran ulang. Tidak ada pengurangan biaya yang dijanjikan untuk setiap pertanyaan baru.

## Calon optimasi catatan yang ditahan

Probe dengan korpus asli dan model tiruan menjalankan `ringkas SGX` lalu `ringkas SGX dan Stockbit`. Kedua pertanyaan membaca dua dokumen SGX yang sama, lalu tambahan Stockbit 28 September. Calon perubahan mengurangi pembuatan catatan dari 6+7 menjadi 6+1. Bahan mentah tetap sama; input catatan pertanyaan kedua turun 87,6%, dari 1.355.974 menjadi 167.919 byte.

Namun biaya murah bukan bukti jawaban setara. Pada A/B model nyata, satu jawaban calon versi baru selesai menurut provider tetapi hanya berisi 65 kata dan salinan fakta sistem; versi lama memberi ringkasan kedua sumber. Pemeriksaan awal hanya memeriksa pilihan sumber dan ID rujukan, sehingga salah menganggap hasil tersebut lulus. Fixture benchmark kini juga memeriksa keberadaan isi dari kedua sumber. Laporan asli tetap disimpan, dengan audit isi terpisah.

Uji ulang menghasilkan jawaban substantif, tetapi audit terbatas menemukan kesalahan dari catatan antara: kepemilikan Z4D menggabungkan pembelian beberapa pihak, V2Y mengubah pencairan pinjaman menjadi konversi saham selesai, dan beberapa nama/status salah. Sebagian juga terjadi pada baseline. Karena perubahan fokus catatan mengubah masukan model, sampel ini belum mendukung klaim kualitas setara. Fokus catatan dikembalikan persis ke baseline; catatan dengan fokus berbeda tetap dihitung ulang. Tidak ditambahkan lapisan model, percobaan ulang otomatis, atau aturan khusus emiten untuk menutupi hasil ini.

## Biaya validasi nyata

| Run lokal | Panggilan model | Biaya provider |
|---|---:|---:|
| Baseline normal, dua pertanyaan | 19 | US$0,065667800 |
| Calon fokus catatan baru, dua pertanyaan | 15 | US$0,033909600 |
| Uji ulang calon fokus catatan baru, dua pertanyaan | 16 | US$0,030125190 |
| Agen TOWR pada implementasi rilis | 3 | US$0,000327356 |
| **Total** | **53** | **US$0,130029946** |

Seluruh panggilan di atas mempunyai usage provider. Cache respons provider dimatikan; prompt cache provider tetap aktif dan tingkat hit berbeda antarrun. Karena itu perbedaan biaya A/B tidak dipromosikan sebagai penghematan dengan kualitas setara. Run agen selesai dengan rujukan yang tersedia dan tanpa galat, tetapi tidak mempunyai fixture fakta lengkap.

## Validasi rilis

Setelah build selesai, **141/141 tes JavaScript dan 31/31 tes Python lulus**, ditambah integrasi native workerd/SQLite dan tes DOM. Pemeriksaan sintaks serta `git diff --check` bersih. Tes meliputi pembatalan dua arah, pemulihan penunggu, isolasi riwayat, perubahan isi data, identitas query/tanggal, kegagalan alat, ekspansi dokumen, batas penyimpanan, dan penghitungan biaya semua percobaan.

Uji generator pada dua proses Python dengan seed berbeda menghasilkan byte yang identik setelah perbaikan urutan. Dibanding hasil lama, nilai numerik, jumlah sinyal, dan himpunan anggota/pihak sama; hanya urutan dan teks daftar yang berubah. Tetap ada 563 emiten bersinyal, 1.418 sinyal, dan 40 kelompok.

Probe implementasi rilis dengan keluaran model tiruan yang dibekukan menunjukkan **seluruh 13 pesan catatan, dua pesan jawaban akhir, dan pilihan sumber identik dengan baseline** pada pasangan SGX. Ini membuktikan masukan dipertahankan untuk skenario tersebut, bukan jaminan seluruh keluaran model faktual. Perubahan fokus catatan yang dievaluasi di atas tidak ikut rilis.

Build: **59 dokumen, 204 bagian, 49.990 kata indeks, 2.910 aksi korporasi**. Versi dokumen tetap `65c635fd022bc96f`; hash setiap aset turunan telah dibandingkan dengan byte file akhir. Fingerprint data turunan: `0e522fee2e477f95a9339d7a13af99fdeb427c6f8ebbe07c2120a1c24b792d25`. Isi arsip sumber tidak berubah. Pipeline rilis: `issuer-cache-v7`, agen `agent-v5.8`.

Worker di-deploy sebagai versi `69d50fe9-dd44-46aa-9ca0-26789e6cb7e1`. Sinkronisasi produksi memverifikasi **59/59 dokumen siap, 16.450 records, tanpa pending**. Situs dan endpoint konfigurasi diperiksa kembali; dokumen SGX lama yang telah dikeluarkan tetap tidak dipublikasikan.
