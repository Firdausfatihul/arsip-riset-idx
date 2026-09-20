# Audit fungsi dan kemudahan baca — 20 September 2026

## Desain yang disetujui dan diterapkan

Tombol sumber di atas, lalu satu daftar untuk sumber yang dipilih. Urutan:
Stockbit, Indonesia (BEI), Australia (ASX), Singapura (SGX), Digest Emiten.

- Mulai 768 px, kelima tombol satu baris; di bawahnya dua kolom. Australia dan
  Singapura berada di baris kedua, Digest memenuhi baris ketiga.
- Tombol sumber selalu tersedia di daftar maupun pembaca. Pencarian berlaku
  untuk semua sumber dan tidak menyembunyikan pilihan sumber saat hasil kosong.
- Beranda awal memilih Stockbit. Klik sumber menghapus pencarian dan membuka
  satu daftar; tombol Hapus pencarian memulihkan sumber terakhir.
- Sidebar yang menduplikasi daftar dihapus. Jumlah entri dokumen pada navigasi
  dan daftar berkurang dari 100 menjadi 50, dengan semua 50 dokumen tetap tersedia.
- Teks utama 18 px, ringkasan dan tabel laporan 16 px, metadata utama 14 px.
  Area aplikasi maksimal 1200 px dan teks laporan maksimal 68ch.
- Tombol sumber minimal 52 px; input dan kontrol utama minimal 44 px.
- Daftar isi dapat ditutup. Di bawah 1440 px mula-mula tertutup; mulai 1440 px
  terbuka di samping teks. Tabel lebar memiliki area geser sendiri.
- Warna teks sekunder diperjelas di mode terang dan gelap. Rasio warna `faint`
  terhadap `ground` dihitung 4,76:1 pada mode terang dan 7,66:1 pada mode gelap.
  Ini pemeriksaan pasangan warna tersebut, bukan sertifikasi aksesibilitas seluruh situs.

## Bug yang ditemukan dan diperbaiki

1. **Dua fungsi JavaScript bernama `link` saling menimpa.** Fungsi sumber eksternal
   menggantikan pembuat rute dokumen sehingga tautan daftar isi menjadi kosong.
   Dipisahkan menjadi `docRoute` dan `sourceLink`.
2. **Tautan bagian bawaan Markdown keluar dari pembaca.** Fragmen seperti
   `#kode-5ly` kini diarahkan ke dokumen yang sama dengan parameter `s`.
3. **Fragmen bagian yang tidak valid dapat merusak selector.** Pencarian tujuan
   kini membandingkan ID secara langsung, tanpa menyisipkan fragmen ke selector CSS.
4. **Kegagalan memuat membutuhkan jalan pemulihan yang jelas.** Dokumen besar dan
   kepemilikan kini menampilkan tombol Coba lagi dengan pesan sederhana.

## Pemeriksaan yang selesai

Total **151 pemeriksaan fungsi lulus**, terdiri dari 123 pemeriksaan utama dan
28 pemeriksaan navigasi serta kondisi gagal. Aplikasi dijalankan melalui jsdom,
dengan parser dan sanitizer versi yang sama dengan situs. Permintaan data
diarahkan ke hasil build lokal; kegagalan jaringan disimulasikan.

| Area | Bukti dan cakupan |
| --- | --- |
| Dokumen | 44 Markdown dirender; 6 HTML membuka iframe dengan path yang benar. |
| Daftar isi | 2.463 tautan memiliki rute dokumen dan ID tujuan yang valid. |
| Tautan bagian asli | 67 fragmen Markdown dirutekan; tujuan pada tiga dokumen yang memakainya diperiksa. |
| Pilihan sumber | Kelima sumber bisa dipilih; satu daftar aktif; klik sumber dengan hash yang sama menghapus pencarian. |
| Pencarian | Isi SGX ditemukan, hasil kosong, hapus pencarian, sorotan teks, dan tautan ke kepemilikan BBRI. |
| Kepemilikan | 963 emiten; daftar awal 100, tampilkan semua, cari, Enter, pilihan emiten, periode, pengurutan, grafik, sumber laporan. |
| Kasus periode | Periode terbalik dinormalisasi, bulan yang sama, kode tidak ditemukan, dan pemilihan bulan grafik dengan Enter. |
| Kondisi gagal | Kegagalan dokumen besar dan kepemilikan lalu retry berhasil; library CDN tidak tersedia menampilkan Markdown mentah. |
| Kode | Python, JavaScript, dan CSS berhasil diparse; tidak ditemukan import Python atau fungsi tingkat atas yang tak dirujuk setelah pembersihan. |
| Keutuhan arsip | Metadata dan isi tertanam sama dengan sebelum perubahan. Semua salinan Markdown dan JSON kepemilikan identik byte dengan sumber. |
| Build | `site/` dan `docs/` dibangun dari generator; versi sama, canonical docs sesuai domain, CNAME dipertahankan. |

Arsip: 12 Stockbit, 6 Indonesia, 1 Australia, 1 Singapura, 30 Digest. Data
kepemilikan mencakup Februari–Agustus 2026. SGX tetap memakai 20 September 2026
sebagai tanggal penyusunan, dengan potret arsip sampai 19 September sesuai dokumen.

Ukuran `site/index.html` berubah dari 2.867.044 menjadi 2.848.529 byte. Tidak ada
framework atau dependency runtime baru. Elemen daftar disimpan sekali untuk
pencarian, helper Python yang tidak dipakai dibuang, dan CSS/sidebar lama dihapus.
Ukuran file lebih kecil belum membuktikan peningkatan waktu muat di perangkat nyata.

## Batas verifikasi

- jsdom memeriksa perilaku DOM; tidak menghitung tata letak atau merender layar.
  Aturan responsif versi baru sudah ditinjau, tetapi belum mendapat verifikasi visual.
- Pratinjau file lokal melalui alat browser diblokir oleh kebijakan keamanan URL.
  Pembatasan itu tidak dilewati. Pemeriksaan Chrome pada situs publik sebelumnya
  mengukur versi lama; hasilnya tidak dianggap sebagai verifikasi desain baru.
- Belum diuji pada perangkat fisik, Safari/iOS, pembesaran 200%, atau pembaca layar.
- Interaksi di dalam enam laporan HTML lama, layanan statistik Claude Artifact,
  endpoint IDX Signal Desk aktif, serta tujuan tautan eksternal tidak diuji langsung.
  `tools/sync_idx.py` ditinjau dan diperiksa sintaksnya; sinkronisasi tidak dijalankan.
- Perubahan lokal ini belum dipublish.

## Saran berikutnya

1. Setelah pratinjau tersedia, periksa layar 320, 390, 768, 1024, 1440, dan 1920 px,
   mode terang/gelap, pembesaran 200%, serta keyboard. Pastikan tombol SGX terlihat,
   tidak ada teks terpotong, dan hanya tabel lebar yang perlu digeser.
2. Uji dengan 2–3 pembaca berusia lanjut: cari sumber SGX, buka satu kasus, lalu
   cari BBRI dan buka kepemilikannya. Catat bagian yang membutuhkan petunjuk.
   Gunakan temuan itu untuk memilih perubahan berikutnya.
3. Jika waktu pencarian dokumen besar terasa lambat di HP nyata, ukur dahulu
   sebelum menambahkan indeks terpisah atau worker. Arsitektur statis saat ini
   tetap sederhana dan sudah mempertahankan pemuatan bertahap serta cache render.
