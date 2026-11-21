# WhatsApp AI Bot

Bot WhatsApp berbasis `whatsapp-web.js` dengan provider AI DashScope dan Groq. Pengaturan provider, model, dan gaya jawaban bisa disesuaikan di `config.js`.

## Fitur

- Chat AI dengan riwayat percakapan per chat dan pilihan model.
- Membaca gambar, OCR, dan menerjemahkan teks dari gambar.
- Menganalisis PDF serta dokumen teks atau kode.
- Mentranskripsikan voice note dan menjawabnya; perlu FFmpeg.
- Mengirim voice note dari teks dengan Google TTS.
- Mencari gambar berdasarkan kata kunci.
- Mengunduh media melalui `yt-dlp` dari situs yang didukung.
- Reminder, polling, status AFK, memori per chat, dan utilitas WhatsApp.
- Perintah administrasi grup dan pengelolaan bot untuk owner.

## Persyaratan

- Node.js 18 atau lebih baru dan npm.
- FFmpeg untuk fitur voice note. Di Debian/Ubuntu: `sudo apt install ffmpeg`.
- API key provider untuk fitur AI. DashScope digunakan untuk chat, vision, dan ASR; Groq dapat digunakan untuk chat.
- Chromium dependencies di Linux tanpa desktop. Contoh Ubuntu: `sudo apt install libgbm1 libnss3 libatk-bridge2.0-0 libxkbcommon0 libasound2t64`.

## Instalasi

```bash
git clone https://github.com/jemtod/Whatsapp-bot.git
cd Whatsapp-bot
npm install
```

`npm install` menjalankan `postinstall`, yang mengunduh `yt-dlp` ke `bin/` dan menerapkan patch WhatsApp proyek. Jika pengunduhan gagal, periksa koneksi lalu jalankan `npm install` kembali.

## Konfigurasi

Buka `config.js` dan isi API key sebelum menjalankan bot:

```js
export const DASHSCOPE_API_KEY = 'PASTE_APIKEY_KAMU_DISINI';
export const GROQ_API_KEY = 'PASTE_APIKEY_KAMU_DISINI';
```

Ganti placeholder dengan key milikmu. Isi setidaknya satu provider yang ingin digunakan. Jangan commit atau membagikan key asli; `config.js` di repo harus tetap berisi placeholder.

Pengaturan lain yang umum diubah:

- `OWNER_NUMBERS`: nomor owner format internasional tanpa tanda `+`.
- `DASHSCOPE_BASE_URL`: endpoint OpenAI-compatible dari workspace DashScope.
- `DASHSCOPE_MODELS` dan `GROQ_MODELS`: model chat yang tersedia untuk akunmu.
- `DASHSCOPE_VISION_MODELS` dan `DASHSCOPE_ASR_MODELS`: model untuk gambar dan transkripsi.
- `MAX_HISTORY`, `MAX_TOKENS`, `VOICE_ENABLED`, `IMAGE_COUNT`, `TIMEZONE`, dan `SYSTEM_PROMPT`: perilaku bot.

Cookie yt-dlp, sesi WhatsApp di `.wwebjs_auth/`, dan data lokal tidak untuk dibagikan. Pola-pola file tersebut ada di `.gitignore`.

## Menjalankan

```bash
npm start
```

Scan QR di terminal melalui WhatsApp: **Pengaturan > Perangkat tertaut > Tautkan perangkat**. Sesi tersimpan di `.wwebjs_auth/`, sehingga QR biasanya cukup dipindai sekali. `runner.js` akan menjalankan ulang bot jika proses berhenti.

## Perintah

- `/ttp <teks>`: buat stiker tulisan putih dengan garis tepi hitam dan latar transparan, maksimal 200 karakter. Contoh: `/ttp besok libur!`. Bisa dipakai di chat pribadi dan grup.

Ketik `/help` atau `/menu` di chat untuk melihat bantuan bot.

### Chat dan media

| Perintah | Fungsi |
| --- | --- |
| `/reset` | Hapus riwayat chat AI saat ini |
| `/model` | Lihat provider dan model aktif |
| `/model <nama atau nomor>` | Pilih model untuk chat |
| `/gambar <objek>` | Cari dan kirim gambar |
| `/download <tautan>` atau `/dl <tautan>` | Unduh video atau gambar dari tautan yang didukung |
| `/ocr` | Baca teks dari gambar yang dikirim atau dibalas |
| `/translateimg` | Terjemahkan teks pada gambar |
| `/tts <teks>` | Ubah teks menjadi voice note |
| `/translate <bahasa> <teks>` | Terjemahkan teks |
| `/quote <teks>` | Buat gambar quote |
| `/qr <teks atau tautan>` | Buat QR code |

### Utilitas

| Perintah | Fungsi |
| --- | --- |
| `/remind <durasi> <pesan>` | Buat pengingat, misalnya `/remind 2j rapat` |
| `/remindlist` | Lihat pengingat aktif |
| `/cancelremind <id>` | Batalkan pengingat |
| `/poll <pertanyaan> \| <opsi 1> \| <opsi 2>` | Buat polling dengan 2-10 opsi |
| `/vote <id> <nomor opsi>` | Berikan suara |
| `/polls` | Lihat polling aktif |
| `/pollresult <id>` | Lihat hasil polling |
| `/pollclose <id>` | Tutup polling sesuai izin |
| `/afk [alasan]` | Aktifkan status AFK; kirim pesan lagi untuk kembali |
| `/ingat <fakta>` | Simpan fakta untuk chat ini |
| `/memori` | Lihat memori chat |
| `/hapusmemori` | Hapus memori chat |
| `/stats` | Lihat uptime dan statistik perintah |
| `/stalk <nomor>` | Lihat informasi WhatsApp yang tersedia |
| `/tiktokstalk <username>` atau `/ttstalk <username>` | Lihat informasi profil TikTok yang tersedia |
| `/phub <teks>\|<teks>` | Buat logo teks |
| `/help` atau `/menu` | Tampilkan bantuan |

Bot juga memiliki perintah `/cuaca`, `/detectlang`, `/short`, `/film`, `/wiki`, `/define`, `/cekresi`, dan `/motivasi`.

### Owner dan admin grup

Perintah berikut hanya untuk owner. Nomor owner ditentukan oleh `OWNER_NUMBERS` di `config.js`.

| Perintah | Fungsi |
| --- | --- |
| `/restart` | Mulai ulang proses bot |
| `/join <tautan grup>` | Bergabung lewat tautan undangan |
| `/leave` | Keluar dari grup saat ini |
| `/block <nomor>` / `/unblock <nomor>` | Blokir atau buka blokir nomor |
| `/setprefix <simbol>` | Ubah prefix perintah |
| `/model dashscope`, `/model groq`, `/model both` | Pilih provider chat aktif |
| `/menuadmin` | Lihat pengaturan admin grup |
| `/welcome on\|off` | Atur sambutan anggota baru |
| `/antilink on\|off` | Atur penghapusan tautan di grup |

## Catatan

- Jika model pilihan gagal, bot dapat mencoba model lain dari provider yang aktif. Fitur vision dan transkripsi menggunakan model DashScope yang dikonfigurasi.
- Dukungan unduh mengikuti situs yang didukung versi `yt-dlp` terpasang. Tautan privat atau konten yang memerlukan login mungkin tidak dapat diunduh.
- Fitur yang memerlukan login situs dapat memakai cookie Netscape lokal di `data/yt-cookies.txt`. Jangan commit file cookie.
- Memori, pengaturan, polling, reminder, dan sesi disimpan secara lokal.
- `whatsapp-web.js` adalah library tidak resmi. Gunakan akun WhatsApp yang sesuai untuk bot.

## Lisensi

Proyek ini menggunakan [MIT License](./LICENSE).
