# Perbandingan biaya chat arsip

Mode: simulasi tanpa API berbayar. Model: qwen/qwen3.7-flash. Versi arsip: 4acc82e4706c949d.

| Kasus | Status | Dokumen | Panggilan | Input token | Output token | Token cache provider | Biaya tercatat USD | Input pesan byte |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| legacy | complete | 8 | 10 | — | — | — | — | 3279948 |
| indexed_first | complete | 8 | 1 | — | — | — | — | 29294 |
| indexed_other_question | complete | 8 | 1 | — | — | — | — | 25388 |
| indexed_same_question_other_user | complete | 8 | 0 | — | — | — | — | 0 |
| ambiguous_date | complete | 0 | 0 | — | — | — | — | 0 |

Cache aplikasi dimulai kosong; cache provider tidak dapat dipastikan kosong. Pertanyaan berbeda tetap menghasilkan jawaban baru. Baris pengulangan menggunakan cache aplikasi lintas pengguna. Angka biaya adalah biaya API model; bukan biaya hosting atau jaminan tarif pada masa depan. Jika missing_usage_calls > 0, biaya yang diketahui belum merupakan total lengkap.

Pengujian mempertahankan sumber asli. Pemeriksaan kualitas jawaban dilakukan terpisah dari penghitungan penghematan.
