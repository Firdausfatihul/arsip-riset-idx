# Indeks emiten, cache, dan perbandingan biaya

Implementasi mempertahankan seluruh 50 dokumen asli. Saat pertanyaan diajukan, semua dokumen
yang cocok diperiksa di indeks; yang dikirim ke model adalah bagian terkait dan konteks sumber.
Tidak memakai pembatasan top-k. Cache sumber dan catatan tersedia lintas pengguna, tanpa
riwayat percakapan. Dokumen lama tetap; penambahan dokumen baru tidak memaksa pembacaan
ulang catatan dokumen lama. Cache jawaban mencakup versi arsip agar tambahan baru tidak terlewat.

## Bukti

- `live.md` / `live.json`: model OpenRouter asli, pertanyaan dan sumber sama untuk kontrol
  versus alur baru; usage/cost langsung dari provider. Cache provider tidak dipaksa kosong.
- `offline.md` / `offline.json`: ukuran bahan dan jumlah panggilan tanpa biaya API.
- `production-smoke.json`: pemeriksaan backend publik, cache jawaban, klarifikasi tanggal,
  dan penolakan metrik tanpa autentikasi.
- `provider-pricing.json`: metadata endpoint/harga saat pengukuran; jangan gunakan sebagai
  janji tarif masa depan.

44 pengujian Node memeriksa kontrol lama, batas keamanan, rekonstruksi seluruh dokumen,
cache lintas pengguna, invalidasi, tanggal, fallback, dan statistik. Pengujian terpisah
workerd/SQLite dan DOM memeriksa integrasi serta tampilan.

## Batas penilaian kualitas

Penghematan biaya tidak membuktikan setiap pernyataan model benar. Angka sumber SOCI
(7.059.000.000 saham, free float 14,09%, fasilitas US$54,9 juta, modal anak usaha US$500.000)
tetap tersedia dalam bagian asli. Catatan bersifat ringkasan dan dapat kehilangan detail;
permintaan detail memakai teks asli jika muat, dan model dapat meminta pemeriksaan ulang
terbatas ke dokumen lengkap. Rujukan jawaban di luar daftar sumber ditolak.

Tanggal dokumen bukan tanggal kejadian. Tidak ditemukan pada bahan yang diperiksa bukan
bukti tidak ada kejadian. Filter tanggal menyimpan record bertanggal tidak pasti.
Tes biaya ini hanya contoh SOCI, bukan benchmark menyeluruh atas semua pertanyaan/emiten.

Statistik pertanyaan pengguna sesungguhnya disimpan di backend privat dan diekspor hanya
ke `reports/private/`, bukan folder laporan yang dipublikasikan ini. Retensi detail 365 hari.

Pemeriksaan jawaban tanggal 17 September juga menemukan keterbatasan model: ia sempat
menggeneralisasi ketiadaan digest pada periode tertentu dari delapan dokumen yang cocok
dengan SOCI, padahal katalog keseluruhan memiliki dokumen lain pada periode tersebut.
Anggap keterangan ketiadaan hanya berlaku pada bahan terpilih yang diperiksa, dan cek
sumber untuk klaim cakupan. Pemeriksaan ID rujukan bukan pemeriksaan kebenaran seluruh kalimat.

Instruksi jawaban selanjutnya diperketat untuk tidak memperluas ticker tanpa nama
dalam sumber, tidak menafsirkan tag bersama sebagai hubungan bisnis, dan tidak
menggeneralisasi cakupan katalog. Perubahan instruksi otomatis membatalkan cache
jawaban terkait. Pengujian tambahan sempat menerima HTTP 429 dari provider; catatannya dipertahankan
di `provider-limited-followup.*`. Pengulangan terakhir berhasil dan tercatat di
`live.*`: biaya pertanyaan umum SOCI turun dari US$0,0992252 menjadi US$0,00045715
(sekitar 99,54%), dengan delapan dokumen cocok tetap ditelusuri. Waktu pengujian
turun dari 96,49 detik menjadi 20,77 detik. Pertanyaan bertanggal pada pengulangan
terakhir mendapat cache respons provider (HIT), sehingga biaya tercatat nol; ini
bukan janji bahwa pertanyaan berbeda selalu gratis. Pertanyaan yang sama dari
pengguna lain mendapat cache aplikasi tanpa panggilan model. Permintaan yang gagal
atau tidak memiliki usage lengkap tidak dilaporkan sebagai panggilan gratis.
