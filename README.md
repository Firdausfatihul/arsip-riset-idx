# Arsip Riset IDX

Arsip riset pasar modal (ringkasan Stockbit, keterbukaan BEI, ASX, SGX, kepemilikan saham KSEI) sebagai situs statis,
plus kotak **Tanya arsip** yang dijawab Claude dari isi arsip. Situs live: https://arsip.seekingomega.capital (VPS Jakarta,
wajib kata sandi).

Panduan lengkap untuk agent dan pengembang: **[AGENTS.md](AGENTS.md)**. Halaman ini hanya ringkasan.

## Build dan lihat lokal

```bash
python3 build.py                        # needtobeindexed/ -> site/ (Python 3.9+, stdlib saja)
python3 -m http.server -d site 8000     # situs saja, tanpa chat: http://localhost:8000
```

Cek baris output `kategori | tanggal | sumber -> path`: dokumen baru harus masuk kategori yang benar, bukan "Lainnya" dan
bukan tanggal hari ini. Nama berkas yang dikenali ada di AGENTS.md §3.

Dengan chat (Node 22, Claude Code CLI yang sudah login ke akun Claude):

```bash
claude                                  # sekali: /login, lalu keluar
node local/server.mjs --pin             # pertama kali di Mac ini: build + kunci mesin + jalan
node local/server.mjs --build           # berikutnya, setelah ada dokumen baru
# buka http://127.0.0.1:8017
```

## Menambah dan menerbitkan

- Data desk tidak disalin manual. Kepemilikan: `python3 tools/sync_idx.py`. Stockbit/BEI:
  `python3 tools/sync_idx.py --stockbit-only --with-bei` (biasanya dijalankan publish dari desk). Harga penutupan:
  `python3 tools/sync_prices.py`.
- Ringkasan Stockbit/BEI terbit dari IDX Signal Desk (tombol publish), yang menjalankan `tools/publish_stockbit.py`;
  batalkan dengan `tools/rollback_stockbit.py`.
- Perubahan lain (kode, dokumen manual): commit, lalu `node local/vps.mjs push` untuk memperbarui situs live.

## Hosting

| Mode | Perintah | Catatan |
|---|---|---|
| VPS Jakarta (produksi) | `node local/vps.mjs push`, `node local/vps.mjs status`, `node local/vps.mjs logs` | Mac boleh mati; Claude login di VPS |
| Mac saja | `node local/server.mjs` | `127.0.0.1:8017`, tanpa sandi |
| Tunnel lewat VPS | `node local/remote.mjs install` | Claude tetap di Mac; VPS hanya meneruskan HTTPS |

Kata sandi perangkat baru (mengeluarkan semua perangkat): `node local/vps.mjs password`.
Statistik pertanyaan dan biaya: `python3 tools/chat_metrics.py --days 7 --html reports/private/chat-statistics.html`.

## Tes

```bash
sh tools/test.sh                        # semua tes Python, Node dan DOM (±4 menit, tanpa jaringan kecuali instalasi pustaka uji pertama kali)
```

## Troubleshooting

| Gejala | Penyebab / solusi |
|---|---|
| Dokumen masuk "Lainnya" atau bertanggal hari ini | Nama berkas tidak cocok aturan; ganti nama atau tambah `CATEGORIES` di `build.py` |
| Dokumen besar macet di "Memuat dokumen…" | Dibuka dari `file://`; buka lewat server |
| Dokumen tampil sebagai teks mentah | CDN `cdnjs.cloudflare.com` diblokir; tunggu koneksi |
| Tab Kepemilikan Saham tidak muncul | `kepemilikan.json` belum ada: `python3 tools/sync_idx.py` |
| Chat tidak menemukan dokumen baru | Situs live belum diperbarui: `node local/vps.mjs push` |
| `sync_idx.py`: "Signal Desk tidak bisa dihubungi" | Jalankan `idx-digest gui` di repo desk, atau beri `--server` |
| `sync_idx.py`: "Dilewati: profil aktif …" | Aktifkan profil yang sama di desk, atau `--profile <id>` |
| Server berhenti dengan exit 78 | Kunci mesin/zona waktu gagal atau Claude belum login langganan (AGENTS.md §7, §9) |
| Chat "sedang membatasi" | Batas langganan Claude tercapai; tunggu jendela berikutnya |
