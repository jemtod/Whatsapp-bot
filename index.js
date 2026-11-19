import pkg from 'whatsapp-web.js';
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import googleTTS from 'google-tts-api';
import OpenAI from 'openai';
import { createPhubImage, parsePhubText } from './phub-image.js';
import { imageExtensionForMime, isDirectImageUrl, normalizeDownloadUrl } from './download-utils.js';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { convertDocument } from '@matbee/libreoffice-converter';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { createCanvas } from '@napi-rs/canvas';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdtemp, rm, mkdir, stat, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DASHSCOPE_API_KEY,
  DASHSCOPE_BASE_URL,
  DASHSCOPE_MODELS,
  DASHSCOPE_VISION_MODELS,
  DASHSCOPE_ASR_MODELS,
  GROQ_API_KEY,
  GROQ_BASE_URL,
  GROQ_MODELS,

  IMAGE_COUNT,
  MAX_HISTORY,
  MAX_TOKENS,
  OWNER_NUMBERS,
  REPLY_IN_GROUPS,
  SHOW_TRANSCRIPT,
  SYSTEM_PROMPT,
  TIMEZONE,
  VOICE_ENABLED,
} from './config.js';

process.env.TZ = TIMEZONE;

const MODELS = [...new Set([...DASHSCOPE_MODELS, ...GROQ_MODELS])];
const VISION_MODELS = DASHSCOPE_VISION_MODELS;
const ASR_MODELS = DASHSCOPE_ASR_MODELS;
// Endpoint ASR memakai host workspace yang sama dengan endpoint chat
const ASR_URL =
  DASHSCOPE_BASE_URL.replace(
    '/compatible-mode/v1',
    '/api/v1/services/aigc/multimodal-generation/generation'
  );
const HTTP_HEADERS = { 'User-Agent': 'wa-bot-qwen/1.0 (personal WhatsApp bot)' };
const MAX_WHATSAPP_TEXT_LENGTH = 4000;
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const MAX_CONVERTED_BYTES = 64 * 1024 * 1024;
const CONVERTER_WASM_PATH = path.join(
  process.cwd(),
  'node_modules',
  '@matbee',
  'libreoffice-converter',
  'wasm'
);
const MAX_DOCUMENT_CHARS = 40000;
const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
const MAX_DOWNLOAD_IMAGE_BYTES = 64 * 1024 * 1024;
const YTDLP_PATH = path.join(
  process.cwd(),
  'bin',
  process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);
const YTDLP_COOKIES_PATH = path.join(process.cwd(), 'data', 'yt-cookies.txt');
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = path.join(APP_DIR, 'data', 'memories.json');
const ADULT_CONSENT_FILE = path.join(process.cwd(), 'data', 'adult-consents.json');
const SETTINGS_FILE = path.join(process.cwd(), 'data', 'settings.json');
const REMINDERS_FILE = path.join(process.cwd(), 'data', 'reminders.json');
const POLLS_FILE = path.join(process.cwd(), 'data', 'polls.json');
const SOURCE_FILE = path.join(process.cwd(), 'index.js');
const MAX_MEMORIES_PER_CHAT = 50;
const MAX_STATS_COMMANDS = 100;
let commandPrefix = '/';
const commandUsage = new Map();
const botStartedAt = Date.now();
const groupSettings = new Map();
const afkUsers = new Map();
const reminders = new Map();
const reminderTimers = new Map();
let nextReminderId = 1;
const polls = new Map();
let nextPollId = 1;
const EDITABLE_SCRIPT_FILES = [
  'index.js',
  'runner.js',
  'scripts/apply-patches.js',
  'scripts/install-ytdlp.js',
];
let pendingRepair = null;
let pendingDevelopment = null;
let repairInProgress = false;
let lastRepairReportAt = 0;

function runYtDlp(args, options = {}) {
  const { timeout = 120000, maxBuffer = 2 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP_PATH, args, {
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const error = new Error('yt-dlp timeout setelah 120 detik');
      error.code = 'ETIMEDOUT';
      settled = true;
      reject(error);
    }, timeout);

    const rejectWithDetail = (message, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = stderr.trim() || stdout.trim() || message;
      const error = new Error(detail);
      error.code = code;
      reject(error);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) {
        child.kill('SIGTERM');
        rejectWithDetail('Output yt-dlp terlalu besar', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > maxBuffer) {
        child.kill('SIGTERM');
        rejectWithDetail('Output error yt-dlp terlalu besar', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      }
    });
    child.on('error', (error) => rejectWithDetail(error.message, error.code));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr });
        return;
      }
      rejectWithDetail(
        `yt-dlp berhenti dengan kode ${code ?? `signal ${signal}`}`,
        code ?? signal
      );
    });
  });
}

// Client OpenAI-compatible untuk provider chat.
const qwen = new OpenAI({
  apiKey: DASHSCOPE_API_KEY,
  baseURL: DASHSCOPE_BASE_URL,
});
const groq = new OpenAI({
  apiKey: GROQ_API_KEY,
  baseURL: GROQ_BASE_URL,
});
const chatProviders = [
  {
    name: 'DashScope',
    client: qwen,
    models: DASHSCOPE_MODELS,
    supportedModels: [...DASHSCOPE_MODELS, ...DASHSCOPE_VISION_MODELS],
  },
  { name: 'Groq', client: groq, models: GROQ_MODELS, supportedModels: GROQ_MODELS },
];
const enabledChatProviders = new Set(chatProviders.map(({ name }) => name));

function setEnabledChatProviders(providerNames) {
  enabledChatProviders.clear();
  providerNames.forEach((name) => enabledChatProviders.add(name));
  MODELS.splice(
    0,
    MODELS.length,
    ...new Set(chatProviders
      .filter(({ name }) => enabledChatProviders.has(name))
      .flatMap(({ models }) => models))
  );
}

function enabledChatProviderLabel() {
  return chatProviders
    .filter(({ name }) => enabledChatProviders.has(name))
    .map(({ name }) => name)
    .join(' + ');
}


// Riwayat chat dan pilihan model per nomor/grup
const chatHistories = new Map();
const chatModels = new Map();
const memories = new Map();
const adultConsents = new Set();
const sentImageHistory = new Map();
const processedMessageIds = new Map();
const MAX_IMAGE_HISTORY_PER_QUERY = 30;
const MESSAGE_DEDUPLICATION_WINDOW_MS = 10 * 60 * 1000;
let memorySaveQueue = Promise.resolve();

async function loadMemories() {
  try {
    const saved = JSON.parse(await readFile(MEMORY_FILE, 'utf8'));
    for (const [chatId, entries] of Object.entries(saved)) {
      if (Array.isArray(entries)) memories.set(chatId, entries.slice(-MAX_MEMORIES_PER_CHAT));
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Gagal memuat memori:', error);
  }
}

async function loadAdultConsents() {
  try {
    const saved = JSON.parse(await readFile(ADULT_CONSENT_FILE, 'utf8'));
    if (Array.isArray(saved)) {
      for (const chatId of saved) {
        if (typeof chatId === 'string') adultConsents.add(chatId);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Gagal memuat persetujuan umur:', error);
  }
}

async function saveAdultConsents() {
  await mkdir(path.dirname(ADULT_CONSENT_FILE), { recursive: true });
  await writeFile(ADULT_CONSENT_FILE, `${JSON.stringify([...adultConsents], null, 2)}\n`);
}

async function loadSettings() {
  try {
    const saved = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    if (typeof saved.prefix === 'string' && /^[^\p{L}\p{N}\s/]{1,3}$/u.test(saved.prefix)) {
      commandPrefix = saved.prefix;
    }
    for (const [chatId, settings] of Object.entries(saved.groups || {})) {
      if (settings && typeof settings === 'object') {
        groupSettings.set(chatId, {
          welcome: settings.welcome === true,
          antilink: settings.antilink === true,
        });
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Gagal memuat pengaturan:', error);
  }
}

async function saveSettings() {
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(
    SETTINGS_FILE,
    `${JSON.stringify({
      prefix: commandPrefix,
      groups: Object.fromEntries(groupSettings),
    }, null, 2)}\n`
  );
}

async function loadReminders() {
  try {
    const saved = JSON.parse(await readFile(REMINDERS_FILE, 'utf8'));
    for (const reminder of Array.isArray(saved) ? saved : []) {
      if (
        Number.isInteger(reminder.id) &&
        typeof reminder.chatId === 'string' &&
        typeof reminder.text === 'string' &&
        Number.isFinite(reminder.dueAt) &&
        reminder.dueAt > Date.now()
      ) {
        reminders.set(reminder.id, reminder);
        nextReminderId = Math.max(nextReminderId, reminder.id + 1);
        scheduleReminder(reminder);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Gagal memuat reminder:', error);
  }
}

async function saveReminders() {
  await mkdir(path.dirname(REMINDERS_FILE), { recursive: true });
  const saved = [...reminders.values()].map(({ timer, ...reminder }) => reminder);
  return writeFile(REMINDERS_FILE, `${JSON.stringify(saved, null, 2)}\n`);
}

async function loadPolls() {
  try {
    const saved = JSON.parse(await readFile(POLLS_FILE, 'utf8'));
    for (const poll of Array.isArray(saved) ? saved : []) {
      if (
        Number.isInteger(poll.id) &&
        typeof poll.chatId === 'string' &&
        typeof poll.creatorId === 'string' &&
        typeof poll.question === 'string' &&
        Array.isArray(poll.options) &&
        poll.options.length >= 2 &&
        poll.options.length <= 10 &&
        poll.options.every((option) => typeof option === 'string' && option.length > 0) &&
        poll.votes && typeof poll.votes === 'object'
      ) {
        polls.set(poll.id, poll);
        nextPollId = Math.max(nextPollId, poll.id + 1);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Gagal memuat poll:', error);
  }
}

async function savePolls() {
  await mkdir(path.dirname(POLLS_FILE), { recursive: true });
  const saved = [...polls.values()].map(({ timer, ...poll }) => poll);
  return writeFile(POLLS_FILE, `${JSON.stringify(saved, null, 2)}\n`);
}

function scheduleReminder(reminder) {
  const delay = Math.max(0, reminder.dueAt - Date.now());
  const timer = setTimeout(async () => {
    reminderTimers.delete(reminder.id);
    if (reminder.dueAt > Date.now()) {
      scheduleReminder(reminder);
      return;
    }
    reminders.delete(reminder.id);
    await saveReminders();
    try {
      await client.sendMessage(reminder.chatId, `⏰ Reminder: ${reminder.text}`);
    } catch (error) {
      console.error(`Gagal mengirim reminder ${reminder.id}:`, error);
    }
  }, Math.min(delay, 2_147_000_000));
  timer.unref?.();
  reminderTimers.set(reminder.id, timer);
}

function parseReminderDuration(value) {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(s|m|j|h|d|w)$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const units = { s: 1000, m: 60000, j: 3600000, h: 3600000, d: 86400000, w: 604800000 };
  const milliseconds = amount * units[match[2].toLowerCase()];
  return Number.isFinite(milliseconds) && milliseconds >= 1000 && milliseconds <= 30 * 86400000
    ? milliseconds
    : null;
}

function groupSetting(chatId) {
  if (!groupSettings.has(chatId)) groupSettings.set(chatId, { welcome: false, antilink: false });
  return groupSettings.get(chatId);
}

function senderChatIdentity(msg) {
  return msg.author || msg._data?.author || msg.id?.participant || msg.from;
}

function senderDisplayNumber(id) {
  return phoneNumberFromId(id) || String(id || '').split('@')[0];
}

async function isGroupAdmin(msg, chat = null) {
  if (await isOwner(msg)) return true;
  const group = chat || await msg.getChat();
  if (!group.isGroup) return false;
  const senderId = msg.author || msg._data?.author || msg.id?.participant || msg.from;
  const participant = group.participants.find((item) => sameWhatsAppIdentity(item.id, senderId));
  return Boolean(participant?.isAdmin || participant?.isSuperAdmin);
}

function normalizeCommandPrefix(message) {
  if (commandPrefix === '/' || !message?.startsWith(commandPrefix)) return message;
  return `/${message.slice(commandPrefix.length)}`;
}

function recordCommandUsage(command) {
  const key = command.toLowerCase();
  commandUsage.set(key, (commandUsage.get(key) || 0) + 1);
}

function formatUptime(milliseconds) {
  const totalMinutes = Math.floor(milliseconds / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return `${days}h ${hours}j ${minutes}m`;
}

function saveMemories() {
  const saveOperation = memorySaveQueue.then(async () => {
    await mkdir(path.dirname(MEMORY_FILE), { recursive: true });
    const temporaryFile = `${MEMORY_FILE}.tmp-${process.pid}-${Date.now()}`;
    const saved = Object.fromEntries(memories);
    try {
      await writeFile(temporaryFile, `${JSON.stringify(saved, null, 2)}\n`, { flag: 'wx' });
      await rename(temporaryFile, MEMORY_FILE);
    } finally {
      await rm(temporaryFile, { force: true });
    }
  });

  memorySaveQueue = saveOperation.catch((error) => {
    console.error('Gagal menyimpan memori:', error);
  });
  return saveOperation;
}

function memoryText(chatId) {
  const entries = memories.get(chatId) || [];
  return entries.length
    ? `\nMemori yang user izinkan untuk diingat:\n${entries.map((entry) => `- ${entry}`).join('\n')}`
    : '';
}

function newHistory(chatId) {
  return [{ role: 'system', content: systemPromptFor(chatId) }];
}

function jakartaDateTime() {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'long',
  }).format(new Date());
}

function isVideoMediaMessage(message) {
  const mimetype = String(message?.mimetype || message?._data?.mimetype || '').toLowerCase();
  const filename = String(message?.filename || message?._data?.filename || '').toLowerCase();
  return message?.type === 'video' ||
    mimetype.startsWith('video/') ||
    /\.(mp4|webm|mov|mkv|avi|3gp)$/i.test(filename);
}

function detectReplyLanguage(text) {
  const words = new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
  );
  const indonesianWords = [
    'aku', 'saya', 'kamu', 'lu', 'lo', 'gue', 'gua', 'ini', 'itu', 'yang',
    'dan', 'atau', 'kalau', 'karena', 'sudah', 'belum', 'bisa', 'mau', 'tolong',
    'jangan', 'jelek', 'bagaimana', 'kenapa', 'dimana', 'dengan', 'untuk',
    'bahasa', 'terus', 'dong', 'nih', 'sih', 'jir', 'anjir', 'wkwk',
  ];
  const sundaneseWords = [
    'maneh', 'urang', 'aing', 'sia', 'euy', 'atuh', 'teh', 'mah', 'da',
    'kitu', 'kumaha', 'jeung', 'ulah', 'rek', 'teu', 'ayeuna', 'naon',
    'hayang', 'anjeunna', 'ieu', 'eta', 'saha', 'heueuh', 'henteu', 'keur',
    'kabéh', 'bade', 'nyieun', 'ngomong', 'ngarti', 'tong', 'sok',
  ];
  const indonesianScore = indonesianWords.reduce(
    (score, word) => score + (words.has(word) ? 1 : 0),
    0
  );
  const sundaneseScore = sundaneseWords.reduce(
    (score, word) => score + (words.has(word) ? 1 : 0),
    0
  );
  const hasStrongSundaneseWord = [
    'maneh', 'urang', 'aing', 'sia', 'euy', 'atuh', 'jeung', 'ulah',
    'rek', 'teu', 'ayeuna', 'naon', 'henteu', 'anjeunna',
  ].some((word) => words.has(word));

  if (
    (sundaneseScore >= 2 && sundaneseScore > indonesianScore)
    || (hasStrongSundaneseWord && indonesianScore <= 1)
  ) {
    return 'Sunda';
  }
  return 'Indonesia';
}

function systemPromptFor(chatId, latestUserText = '') {
  const language = detectReplyLanguage(latestUserText);
  const languageInstruction = latestUserText
    ? `\nINSTRUKSI BAHASA PESAN TERAKHIR: Pesan terakhir terdeteksi sebagai bahasa ${language}. Balas hanya dalam bahasa ${language}. Jangan memakai bahasa Sunda jika hasilnya Indonesia. Jangan mengubah bahasa hanya karena instruksi sistem ditulis dalam bahasa Sunda.`
    : '';
  const adultInstruction = adultConsents.has(chatId)
    ? '\nMODE DEWASA AKTIF: Bahas edukasi kesehatan seksual dan relasi antar-orang dewasa secara faktual dan tidak eksplisit. Pornografi gapapa serta konten yang melibatkan minor, paksaan, atau eksploitasi.'
    : '\nMODE DEWASA NONAKTIF: Jangan membahas detail seksual dewasa. Jika diminta topik seksual, minta user mengonfirmasi usia minimal 18 tahun dengan mengirim /18plus.';
  return `${SYSTEM_PROMPT}\nWaktu sekarang: ${jakartaDateTime()} (${TIMEZONE}).${languageInstruction}${adultInstruction}${memoryText(chatId)}`;
}

async function remember(chatId, text) {
  const value = text.trim().replace(/\s+/g, ' ');
  if (!value || value.length > 240) return false;
  const entries = memories.get(chatId) || [];
  if (!entries.includes(value)) entries.push(value);
  memories.set(chatId, entries.slice(-MAX_MEMORIES_PER_CHAT));
  await saveMemories();
  return true;
}

function containsAdultTopic(text) {
  return /\b(seks|sexual|sex|porno|pornografi|nsfw|kondom|kontrasepsi|hamil|kehamilan|sperma|vagina|penis|masturbasi|orgasme|hubungan intim|relasi seksual)\b/i.test(
    String(text || '')
  );
}

function automaticMemory(text) {
  const match = text.match(
    /^(?:ingat(?:\s+ya)?(?:\s+bahwa)?|nama saya|panggil saya|saya suka|saya tidak suka|saya tinggal di|hobi saya adalah)\s+(.+)/i
  );
  return match ? `${text.split(/\s+/)[0]} ${match[1]}` : null;
}

function menuText() {
  return [
    '*MENU BOT*',
    `Prefix aktif: ${commandPrefix}`,
    '',
    '*Umum*',
    '/menu atau /help - tampilkan menu ini',
    '/reset - hapus riwayat percakapan',
    '/model - lihat model aktif',
    '/model <nama atau nomor>[, ...] - pilih beberapa model AI',
    '/model dashscope|groq|both - pilih provider (owner)',
    '/gambar <objek> - cari dan kirim gambar',
    '/cuaca <kota> - cek cuaca terkini',
    '/translate <bahasa> <teks> - terjemahkan teks',
    '/quote <teks> - buat gambar quote',
    '/phub <teks>|<teks> - buat logo teks hitam-oranye',
    '/qr <teks> - buat QR code',
    '/stats - lihat statistik bot',
    '/remind <durasi> <pesan> - buat pengingat',
    '/remindlist - lihat reminder aktif',
    '/cancelremind <id> - batalkan reminder',
    '/poll <pertanyaan> | <opsi 1> | <opsi 2> - buat voting',
    '/vote <id> <nomor> - pilih opsi voting',
    '/polls - lihat voting aktif di chat',
    '/pollresult <id> - lihat hasil voting',
    '/pollclose <id> - tutup voting',
    '/afk [alasan] - aktifkan status tidak aktif',
    '/tts <teks> - ubah teks menjadi voice note',
    '/ocr - baca teks dari gambar',
    '/translateimg - terjemahkan teks pada gambar',
    '/detectlang <teks> - deteksi bahasa',
    '/short <link> - pendekkan URL',
    '/film <judul> - cari info film/serial',
    '/wiki <topik> - ringkasan Wikipedia',
    '/define <kata> - cari definisi kata bahasa Inggris',
    '/cekresi <kurir> <resi> - siapkan pelacakan resi',
    '/motivasi - kirim motivasi singkat',
    '',
    '*Media dan dokumen*',
    '/s atau /stiker - buat stiker dari gambar',
    '/sgif - buat stiker animasi dari video',
    '/img - ubah stiker menjadi gambar',
    '/pdf - baca atau rangkum PDF/DOCX',
    '/topdf, /wordtopdf, atau /docxtopdf - Word/DOCX ke PDF',
    '/pdftoword atau /pdftodocx - PDF ke Word/DOCX',
    '/download atau /dl <link> - download video atau gambar dari situs yang didukung',
    '/ytmp4 <link> - alias download media',
    '/ig <link> - alias download media Instagram',
    '/fb <link> - alias download media Facebook',
    '/twitter <link> - alias download media X/Twitter',
    '/tiktok <link> - alias download media TikTok',
    '/video atau /getvideo <link> - alias download media',
    '/igstalk <username> - lihat statistik profil Instagram publik',
    '/tiktokstalk atau /ttstalk <username> - lihat statistik profil TikTok',
    '/twitterstalk atau /xstalk <username> - lihat statistik profil X/Twitter',
    '/stalk <nomor> - cek info WhatsApp yang tersedia',
    '',
    '*Islam*',
    '/quran <surah:ayat> - baca ayat Al-Quran',
    '/infosurah <nomor/nama> - info surah',
    '/tafsir <surah:ayat> - lihat tafsir ayat',
    '/jadwalshalat <kota> - jadwal salat hari ini',
    '/tagall [pesan] - mention semua anggota grup',
    '',
    '*Memori*',
    '/ingat <fakta> - simpan memori',
    '/memori - lihat memori chat',
    '/hapusmemori - hapus semua memori chat',
    '/18plus - konfirmasi usia minimal 18 tahun untuk diskusi dewasa terbatas',
    '',
    '*Khusus owner*',
    '/restart - restart bot',
    '/join <link grup> - masuk grup',
    '/leave - keluar dari grup',
    '/block <nomor> - blokir nomor',
    '/unblock <nomor> - buka blokir nomor',
    '/fix-status - lihat usulan perbaikan error',
    '/fix-approve - terapkan usulan perbaikan',
    '/fix-reject - tolak usulan perbaikan',
    '/dev <permintaan> - buat usulan penambahan/perubahan fitur',
    '/dev-status - lihat usulan fitur',
    '/dev-approve - terapkan usulan fitur',
    '/dev-reject - tolak usulan fitur',
    '/setstatus <teks> - ubah status/About bot',
    '/setpict - ubah foto profil bot dari gambar',
    '/setprefix <simbol> - ganti prefix command',
    '/menuadmin - menu pengaturan admin grup',
    '/welcome on|off - sambutan anggota baru',
    '/antilink on|off - hapus link di grup',
    '/bc atau /broadcast <pesan> - kirim pemberitahuan ke semua kontak dan grup',
  ].join('\n');
}

function errorText(error) {
  return String(error?.stack || error?.message || error).slice(0, 5000);
}

function isClosedWhatsAppError(error) {
  return /ProtocolError|Target closed|Session closed|Execution context was destroyed|Cannot find context/i.test(
    String(error?.message || error)
  );
}

async function broadcastToAllChats(text) {
  const recipients = [...knownChatIds].filter((id) =>
    id.endsWith('@c.us') || id.endsWith('@g.us')
  );
  let success = 0;
  let failed = 0;
  for (const chatId of recipients) {
    try {
      await client.sendMessage(chatId, text);
      success++;
    } catch (error) {
      failed++;
      console.error(`Broadcast ke ${chatId} gagal:`, error?.message || error);
    }
  }
  return { success, failed, total: recipients.length };
}

const knownChatIds = new Set();
let chatSyncInProgress = false;
let chatSyncPromise = null;

async function syncKnownChats() {
  if (chatSyncInProgress) return chatSyncPromise;
  chatSyncInProgress = true;
  chatSyncPromise = (async () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        const chats = await client.getChats();
        for (const chat of chats) {
          const id = chat.id?._serialized;
          if (id && (chat.isGroup || chat.isUser)) knownChatIds.add(id);
        }
        console.log(`Daftar broadcast tersinkron: ${knownChatIds.size} chat.`);
        return;
      } catch (error) {
        if (!isClosedWhatsAppError(error) || attempt === 8) {
          console.error('Gagal menyinkronkan daftar chat broadcast:', error?.message || error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  })().finally(() => {
    chatSyncInProgress = false;
    chatSyncPromise = null;
  });
  return chatSyncPromise;
}

function sourceContext(lineNumber) {
  return readFile(SOURCE_FILE, 'utf8').then((source) => {
    const lines = source.split('\n');
    const line = Number(lineNumber);
    if (!Number.isInteger(line) || line < 1) return source.slice(0, 12000);
    return lines
      .slice(Math.max(0, line - 16), Math.min(lines.length, line + 15))
      .map((value, index) => `${Math.max(1, line - 15) + index}: ${value}`)
      .join('\n');
  });
}

async function notifyOwner(text) {
  for (const number of OWNER_NUMBERS) {
    const target = targetNumber(number);
    if (target) await client.sendMessage(target, text);
  }
}

async function proposeRepair(context, error) {
  if (repairInProgress || Date.now() - lastRepairReportAt < 30000) return;
  repairInProgress = true;
  lastRepairReportAt = Date.now();
  try {
    const stack = errorText(error);
    const lineNumber = stack.match(/index\.js:(\d+):\d+/)?.[1];
    const contextCode = await sourceContext(lineNumber);
    const result = await askQwen(
      '__self_heal__',
      [
        {
          role: 'system',
          content:
            'Kamu reviewer JavaScript Node.js. Buat usulan patch minimal dan aman. Jangan mengubah credential, config, dependency, atau perilaku yang tidak terkait. Balas JSON valid saja dengan schema {"summary":"...","find":"teks kode lama yang unik","replace":"teks kode baru","reason":"..."}. find harus persis cocok dan cukup pendek.',
        },
        {
          role: 'user',
          content: `Error context: ${context}\n\nError:\n${stack}\n\nPotongan index.js:\n${contextCode}`,
        },
      ],
      900,
      MODELS
    );
    const jsonText = result.reply.match(/\{[\s\S]*\}/)?.[0];
    const repair = jsonText ? JSON.parse(jsonText) : null;
    if (!repair?.find || typeof repair.replace !== 'string' || !repair.summary) {
      throw new Error('AI tidak menghasilkan patch terstruktur yang valid');
    }
    pendingRepair = { ...repair, context, error: stack, createdAt: new Date().toISOString() };
    await notifyOwner(
      `*Usulan auto-fix tersedia*\n\nError: ${context}\n${stack.slice(0, 1200)}\n\n` +
      `Ringkasan: ${repair.summary}\nAlasan: ${repair.reason || '-'}\n\n` +
      'Ketik */fix-approve* untuk menerapkan setelah backup dan syntax check, atau */fix-reject* untuk menolak.'
    );
  } catch (repairError) {
    console.error('Gagal membuat usulan auto-fix:', repairError);
  } finally {
    repairInProgress = false;
  }
}

async function validateJavaScript(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(output.trim() || `exit code ${code}`)));
  });
}

async function approveRepair(msg) {
  if (!pendingRepair) {
    await sendReply(msg, 'Belum ada usulan auto-fix yang menunggu persetujuan.');
    return;
  }
  const repair = pendingRepair;
  const source = await readFile(SOURCE_FILE, 'utf8');
  if (source.split(repair.find).length !== 2) {
    pendingRepair = null;
    throw new Error('Teks target patch tidak ditemukan atau tidak unik; patch dibatalkan.');
  }
  const backupPath = `${SOURCE_FILE}.backup-${Date.now()}`;
  await writeFile(backupPath, source);
  const updated = source.replace(repair.find, repair.replace);
  await writeFile(SOURCE_FILE, updated);
  try {
    await validateJavaScript(SOURCE_FILE);
  } catch (error) {
    await writeFile(SOURCE_FILE, source);
    throw new Error(`Syntax check gagal; file dikembalikan dari backup: ${error.message}`);
  }
  pendingRepair = null;
  await sendReply(msg, `Patch diterapkan dan syntax check berhasil. Backup: ${path.basename(backupPath)}\nBot akan restart.`);
  setTimeout(() => restartBot().catch((error) => console.error('Gagal restart setelah auto-fix:', error)), 500);
}

async function projectScriptContext() {
  const entries = await Promise.all(
    EDITABLE_SCRIPT_FILES.map(async (file) => {
      const filePath = path.join(process.cwd(), file);
      try {
        return `\n--- ${file} ---\n${await readFile(filePath, 'utf8')}`;
      } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
      }
    })
  );
  return entries.join('\n').slice(0, 100000);
}

function validDevelopmentPatch(patch) {
  return patch &&
    typeof patch.file === 'string' &&
    EDITABLE_SCRIPT_FILES.includes(patch.file) &&
    typeof patch.find === 'string' &&
    patch.find.length > 0 &&
    typeof patch.replace === 'string';
}

function validateDevelopmentSource(source, original = '') {
  const unsupportedFfmpegOptions = [
    'compress_all_frames',
    'max_compression',
    'webp_quality',
  ];
  const invalidOption = unsupportedFfmpegOptions.find(
    (option) => source.includes(option) && !original.includes(option)
  );
  if (invalidOption) {
    throw new Error(`Opsi FFmpeg tidak dikenal: ${invalidOption}`);
  }
}

async function validateDevelopmentJavaScript(source, file) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wadev-check-'));
  const filePath = path.join(dir, path.basename(file));
  try {
    await writeFile(filePath, source);
    await validateJavaScript(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function validateDevelopmentPatches(patches) {
  const sources = new Map();
  const updated = new Map();
  for (const patch of patches) {
    if (!sources.has(patch.file)) {
      const source = await readFile(path.join(process.cwd(), patch.file), 'utf8');
      sources.set(patch.file, source);
      updated.set(patch.file, source);
    }
    const source = updated.get(patch.file);
    const matches = source.split(patch.find).length - 1;
    if (matches !== 1) {
      throw new Error(
        `Target patch ${patch.file} ${matches === 0 ? 'tidak ditemukan' : 'tidak unik'}: "${patch.find.slice(0, 100)}"`
      );
    }
    updated.set(patch.file, source.replace(patch.find, patch.replace));
  }
  for (const [file, source] of updated) {
    validateDevelopmentSource(source, sources.get(file));
    await validateDevelopmentJavaScript(source, file);
  }
  return { sources, updated };
}

function parseJsonObjectResponse(text) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = cleaned.indexOf('{');
  if (start < 0) throw new Error('Respons AI tidak berisi objek JSON.');

  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < cleaned.length; index++) {
    const character = cleaned[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}') {
      depth--;
      if (depth === 0) return JSON.parse(cleaned.slice(start, index + 1));
    }
  }
  throw new Error('Respons AI berisi JSON yang belum selesai.');
}

async function proposeDevelopment(msg, request) {
  if (pendingDevelopment) {
    await sendReply(msg, 'Masih ada usulan fitur yang menunggu. Gunakan /dev-status, /dev-approve, atau /dev-reject dulu.');
    return;
  }
  try {
    const result = await askQwen(
      '__development__',
      [
        {
          role: 'system',
          content:
            `Kamu developer Node.js untuk bot WhatsApp. Analisis permintaan owner dan source code yang diberikan. Buat patch minimal yang benar-benar diperlukan. Hanya boleh mengubah file dalam daftar: ${EDITABLE_SCRIPT_FILES.join(', ')}. Jangan mengubah credential, config.js, dependency, node_modules, data, session, atau file di luar daftar. Balas JSON valid saja dengan schema {"summary":"...","reason":"...","patches":[{"file":"index.js","find":"teks lama unik","replace":"teks baru"}]}. "find" harus persis cocok, cukup pendek, dan unik dalam file. Jika tidak perlu perubahan, patches harus [].`,
        },
        {
          role: 'user',
          content: `Permintaan owner:\n${request}\n\nSource code bot:\n${await projectScriptContext()}`,
        },
      ],
      6000,
      MODELS,
      { response_format: { type: 'json_object' } }
    );
    let proposal;
    try {
      proposal = parseJsonObjectResponse(result.reply);
    } catch (parseError) {
      const retry = await askQwen(
        '__development_json_retry__',
        [
          {
            role: 'system',
            content:
              'Ubah usulan berikut menjadi JSON valid satu baris. Jangan gunakan markdown, jangan tambahkan penjelasan, dan pastikan semua kutip, newline, serta backslash di dalam string di-escape. Schema: {"summary":"...","reason":"...","patches":[{"file":"index.js","find":"...","replace":"..."}]}',
          },
          { role: 'user', content: result.reply.slice(0, 30000) },
        ],
        6000,
        MODELS,
        { response_format: { type: 'json_object' } }
      );
      try {
        proposal = parseJsonObjectResponse(retry.reply);
      } catch {
        throw new Error(`Respons AI tidak valid sebagai JSON: ${parseError.message}`);
      }
    }
    if (!proposal?.summary || !Array.isArray(proposal.patches) ||
      proposal.patches.length === 0 || proposal.patches.length > 20 ||
      proposal.patches.some((patch) => !validDevelopmentPatch(patch))) {
      throw new Error('AI tidak menghasilkan usulan patch multi-file yang valid');
    }
    try {
      await validateDevelopmentPatches(proposal.patches);
    } catch (validationError) {
      const repaired = await askQwen(
        '__development_patch_review__',
        [
          {
            role: 'system',
            content:
              `Review dan perbaiki patch JSON berikut agar setiap "find" cocok persis dan unik dengan source code terbaru. Hanya file ini yang boleh dipakai: ${EDITABLE_SCRIPT_FILES.join(', ')}. Jangan mengubah summary/reason. Balas JSON valid saja dengan schema {"summary":"...","reason":"...","patches":[{"file":"index.js","find":"teks lama persis","replace":"teks baru"}]}.`,
          },
          {
            role: 'user',
            content: `Masalah validasi: ${validationError.message}\n\nUsulan:\n${JSON.stringify(proposal)}\n\nSource code terbaru:\n${await projectScriptContext()}`,
          },
        ],
        6000,
        MODELS,
        { response_format: { type: 'json_object' } }
      );
      proposal = parseJsonObjectResponse(repaired.reply);
      if (!proposal?.summary || !Array.isArray(proposal.patches) ||
        proposal.patches.length === 0 || proposal.patches.length > 20 ||
        proposal.patches.some((patch) => !validDevelopmentPatch(patch))) {
        throw new Error('AI menghasilkan patch perbaikan yang tidak valid.');
      }
      await validateDevelopmentPatches(proposal.patches);
    }
    pendingDevelopment = {
      ...proposal,
      request,
      createdAt: new Date().toISOString(),
    };
    const files = [...new Set(proposal.patches.map((patch) => patch.file))];
    await sendReply(
      msg,
      `*Usulan fitur tersedia*\n\n${proposal.summary}\n\nAlasan: ${proposal.reason || '-'}\nFile: ${files.join(', ') || '-'}\nJumlah patch: ${proposal.patches.length}\n\nKetik */dev-approve* untuk menerapkan setelah backup dan syntax check, atau */dev-reject* untuk membatalkan.`
    );
  } catch (error) {
    console.error('Gagal membuat usulan fitur:', error);
    await sendReply(msg, `Usulan fitur gagal dibuat: ${error.message}`);
  }
}

async function approveDevelopment(msg) {
  if (!pendingDevelopment) {
    await sendReply(msg, 'Belum ada usulan fitur yang menunggu persetujuan.');
    return;
  }
  const proposal = pendingDevelopment;
  const backupSuffix = Date.now();
  let sources = new Map();
  try {
    const validated = await validateDevelopmentPatches(proposal.patches);
    sources = validated.sources;
    const { updated } = validated;
    for (const [file, content] of updated) {
      const filePath = path.join(process.cwd(), file);
      validateDevelopmentSource(content, sources.get(file));
      await writeFile(`${filePath}.backup-${backupSuffix}`, sources.get(file));
      await writeFile(filePath, content);
    }
    for (const file of updated.keys()) {
      await validateJavaScript(path.join(process.cwd(), file));
    }
  } catch (error) {
    for (const [file, source] of sources) {
      await writeFile(path.join(process.cwd(), file), source);
    }
    throw new Error(`Perubahan dibatalkan dan semua file dikembalikan: ${error.message}`);
  }
  pendingDevelopment = null;
  await sendReply(msg, 'Perubahan fitur diterapkan dan semua syntax check berhasil. Bot akan restart.');
  setTimeout(() => restartBot().catch((error) => console.error('Gagal restart setelah dev-fix:', error)), 500);
}

await loadMemories();
await loadAdultConsents();
await loadSettings();
await loadReminders();
await loadPolls();

function phoneNumberFromId(id) {
  const serialized = typeof id === 'string' ? id : id?._serialized;
  const user = serialized?.split('@')[0]?.split(':')[0];
  return user?.replace(/\D/g, '') || '';
}

function serializedWhatsAppId(value) {
  if (typeof value === 'string') return value;
  if (value?._serialized) return value._serialized;
  if (value?.user && value?.server) return `${value.user}@${value.server}`;
  return '';
}

function sameWhatsAppIdentity(left, right) {
  const leftId = serializedWhatsAppId(left);
  const rightId = serializedWhatsAppId(right);
  if (!leftId || !rightId) return false;
  if (leftId === rightId) return true;

  const leftNumber = phoneNumberFromId(leftId);
  const rightNumber = phoneNumberFromId(rightId);
  return Boolean(leftNumber && rightNumber && leftNumber === rightNumber);
}

async function isOwner(msg) {
  const senderId = msg.from.endsWith('@g.us') ? msg.author : msg.from;
  const senderNumber = phoneNumberFromId(senderId);
  if (OWNER_NUMBERS.has(senderNumber)) return true;

  try {
    const contact = await msg.getContact();
    return OWNER_NUMBERS.has(phoneNumberFromId(contact.number)) ||
      OWNER_NUMBERS.has(phoneNumberFromId(contact.id?._serialized));
  } catch (error) {
    console.error('Gagal memeriksa nomor owner:', error);
    return false;
  }
}

function targetNumber(value) {
  const number = value?.replace(/\D/g, '');
  return number ? `${number}@c.us` : null;
}

function normalizeLookupNumber(value) {
  const digits = value?.replace(/\D/g, '') || '';
  if (!digits) return null;
  if (digits.startsWith('0')) return `62${digits.slice(1)}`;
  if (digits.startsWith('62')) return digits;
  return digits;
}

async function handleWhatsAppStalk(msg, userMessage) {
  const rawNumber = userMessage.replace(/^\/stalk\s*/i, '').trim();
  const number = normalizeLookupNumber(rawNumber);
  if (!number || number.length < 10 || number.length > 15) {
    await sendReply(msg, 'Format: /stalk <nomor>. Contoh: /stalk 628123456789');
    return;
  }

  try {
    const contactId = await client.getNumberId(number);
    if (!contactId?._serialized) {
      await sendReply(msg, `Nomor ${number} tidak terdaftar di WhatsApp.`);
      return;
    }

    const contact = await client.getContactById(contactId._serialized);
    let about = null;
    try {
      about = await contact.getAbout();
    } catch (error) {
      console.error('Gagal mengambil About WhatsApp:', error.message);
    }
    const lines = [
      '*INFO WHATSAPP*',
      '',
      `Nomor: +${number}`,
      'Terdaftar: Ya',
      `Nama profil: ${contact.name || contact.pushname || '-'}`,
      `About: ${about || '-'}`,
      `Akun bisnis: ${contact.isBusiness ? 'Ya' : 'Tidak'}`,
    ];
    await sendReply(msg, lines.join('\n'));
  } catch (error) {
    console.error('WhatsApp stalk error:', error);
    await sendReply(msg, `Gagal mengecek nomor WhatsApp: ${error.message}`);
  }
}

async function handleWeatherCommand(msg, userMessage) {
  const city = userMessage.replace(/^\/cuaca\s*/i, '').trim();
  if (!city || city.length > 80) {
    await sendReply(msg, 'Format: /cuaca <kota>. Contoh: /cuaca Bandung');
    return;
  }
  try {
    const geocodeUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
    geocodeUrl.search = new URLSearchParams({
      name: city,
      count: '1',
      language: 'id',
      format: 'json',
    }).toString();
    const geocodeResponse = await fetch(geocodeUrl, { headers: HTTP_HEADERS });
    if (!geocodeResponse.ok) throw new Error(`Geocoding HTTP ${geocodeResponse.status}`);
    const location = (await geocodeResponse.json()).results?.[0];
    if (!location) {
      await sendReply(msg, `Kota "${city}" tidak ditemukan.`);
      return;
    }

    const weatherUrl = new URL('https://api.open-meteo.com/v1/forecast');
    weatherUrl.search = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
      timezone: TIMEZONE,
    }).toString();
    const weatherResponse = await fetch(weatherUrl, { headers: HTTP_HEADERS });
    if (!weatherResponse.ok) throw new Error(`Weather HTTP ${weatherResponse.status}`);
    const current = (await weatherResponse.json()).current;
    const weatherNames = {
      0: 'Cerah', 1: 'Sebagian cerah', 2: 'Berawan sebagian', 3: 'Mendung',
      45: 'Berkabut', 48: 'Kabut tebal', 51: 'Gerimis ringan', 53: 'Gerimis',
      55: 'Gerimis lebat', 61: 'Hujan ringan', 63: 'Hujan', 65: 'Hujan lebat',
      80: 'Hujan lokal', 81: 'Hujan lokal', 82: 'Hujan deras',
      95: 'Badai petir', 96: 'Badai petir dengan hujan es', 99: 'Badai petir dengan hujan es',
    };
    await sendReply(
      msg,
      `*CUACA ${location.name.toUpperCase()}*\n` +
      `${location.country || 'Indonesia'}\n\n` +
      `Kondisi: ${weatherNames[current.weather_code] || 'Tidak diketahui'}\n` +
      `Suhu: ${current.temperature_2m}°C (terasa ${current.apparent_temperature}°C)\n` +
      `Kelembapan: ${current.relative_humidity_2m}%\n` +
      `Angin: ${current.wind_speed_10m} km/jam`
    );
  } catch (error) {
    console.error('Weather command error:', error);
    await sendReply(msg, `Gagal mengambil cuaca: ${error.message}`);
  }
}

async function handleTranslateCommand(msg, userMessage) {
  const argument = userMessage.replace(/^\/translate\s*/i, '').trim();
  const match = argument.match(/^([a-zA-Z-]{2,20})\s+([\s\S]+)$/);
  if (!match) {
    await sendReply(msg, 'Format: /translate <bahasa> <teks>. Contoh: /translate Inggris selamat pagi');
    return;
  }
  const [, language, text] = match;
  try {
    const result = await askQwen(
      `translate:${msg.from}`,
      [
        {
          role: 'system',
          content: `Translate the user text into ${language}. Return only the translation, with no explanation or quotation marks.`,
        },
        { role: 'user', content: text },
      ],
      MAX_TOKENS
    );
    await sendReply(msg, `*Terjemahan ke ${language}*\n${result.reply.trim()}`);
  } catch (error) {
    console.error('Translate command error:', error);
    await sendReply(msg, `Gagal menerjemahkan: ${error.message}`);
  }
}

async function handleQuoteCommand(msg, userMessage) {
  const text = userMessage.replace(/^\/quote\s*/i, '').trim();
  if (!text || text.length > 500) {
    await sendReply(msg, 'Format: /quote <teks>. Maksimal 500 karakter.');
    return;
  }
  const canvas = createCanvas(1200, 675);
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 1200, 675);
  gradient.addColorStop(0, '#172554');
  gradient.addColorStop(1, '#7c3aed');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1200, 675);
  context.fillStyle = 'rgba(255,255,255,0.12)';
  context.beginPath();
  context.arc(1040, 100, 220, 0, Math.PI * 2);
  context.fill();
  context.font = 'bold 110px sans-serif';
  context.fillStyle = 'rgba(255,255,255,0.9)';
  context.fillText('“', 90, 160);
  context.font = 'bold 42px sans-serif';
  context.fillStyle = '#ffffff';
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width > 980 && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  const startY = 280 - ((lines.length - 1) * 26);
  lines.forEach((value, index) => context.fillText(value, 110, startY + index * 64));
  context.font = '28px sans-serif';
  context.fillStyle = 'rgba(255,255,255,0.75)';
  context.fillText('Barudak Darmaji', 110, 585);
  const media = new MessageMedia('image/png', canvas.toBuffer('image/png').toString('base64'), 'quote.png');
  await sendReply(msg, media, { caption: 'Nih quote-nya.' });
}

async function handlePhubCommand(msg, userMessage) {
  const input = userMessage.replace(/^\/phub\s*/i, '').trim();
  try {
    const text = parsePhubText(input);
    const image = createPhubImage(text);
    const media = new MessageMedia('image/png', image.toString('base64'), 'phub-logo.png');
    await sendReply(msg, media, { caption: `${text.left} | ${text.right}` });
  } catch (error) {
    await sendReply(msg, error.message);
  }
}

async function handleQrCommand(msg, userMessage) {
  const text = userMessage.replace(/^\/qr\s*/i, '').trim();
  if (!text || text.length > 2000) {
    await sendReply(msg, 'Format: /qr <teks atau link>. Maksimal 2000 karakter.');
    return;
  }
  const buffer = await QRCode.toBuffer(text, {
    type: 'png',
    width: 900,
    margin: 3,
    errorCorrectionLevel: 'M',
  });
  const media = new MessageMedia('image/png', buffer.toString('base64'), 'qr-code.png');
  await sendReply(msg, media, { caption: `QR code untuk: ${text}` });
}

async function handleStatsCommand(msg) {
  const topCommands = [...commandUsage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([command, count], index) => `${index + 1}. ${command} — ${count}`)
    .join('\n') || '-';
  await sendReply(
    msg,
    `*STATISTIK BOT*\n\n` +
    `Uptime: ${formatUptime(Date.now() - botStartedAt)}\n` +
    `Pesan command: ${[...commandUsage.values()].reduce((sum, value) => sum + value, 0)}\n` +
    `Chat aktif: ${knownChatIds.size}\n\n` +
    `*Command teratas*\n${topCommands}`
  );
}

async function handleTtsCommand(msg, userMessage) {
  const text = userMessage.replace(/^\/tts\s*/i, '').trim();
  if (!text || text.length > 1000) {
    await sendReply(msg, 'Format: /tts <teks>. Maksimal 1000 karakter.');
    return;
  }
  const chunks = await googleTTS.getAllAudioBase64(text, {
    lang: detectReplyLanguage(text) === 'Inggris' ? 'en' : 'id',
    timeout: 15000,
    splitPunct: ',.?!',
  });
  const audio = Buffer.concat(chunks.map(({ base64 }) => Buffer.from(base64, 'base64')));
  const media = new MessageMedia('audio/mpeg', audio.toString('base64'), 'tts.mp3');
  await sendReply(msg, media, { sendAudioAsVoice: true });
}

async function analyzeImageCommand(msg, sourceMessage, prompt, failureText) {
  if (!sourceMessage?.hasMedia || !['image', 'sticker'].includes(sourceMessage.type)) {
    await sendReply(msg, `Kirim atau reply gambar dengan command tersebut. ${failureText}`);
    return;
  }
  try {
    const result = await askQwen(
      `vision-command:${msg.from}`,
      [{ role: 'user', content: await imageMessageContent(sourceMessage, prompt) }],
      MAX_TOKENS,
      VISION_MODELS
    );
    await sendReply(msg, result.reply.trim());
  } catch (error) {
    console.error('Vision command error:', error);
    await sendReply(msg, `Gagal memproses gambar: ${error.message}`);
  }
}

async function handleTranslateImageCommand(msg, sourceMessage) {
  await analyzeImageCommand(
    msg,
    sourceMessage,
    'Baca semua teks yang terlihat pada gambar, lalu terjemahkan ke bahasa Indonesia. Jika tidak ada teks, katakan bahwa teks tidak ditemukan.',
    'Untuk /translateimg, gambar harus tersedia.'
  );
}

async function handleOcrCommand(msg, sourceMessage) {
  await analyzeImageCommand(
    msg,
    sourceMessage,
    'Transkripsikan semua teks yang terlihat pada gambar secara akurat. Pertahankan susunan baris sebisa mungkin. Jika tidak ada teks, katakan bahwa teks tidak ditemukan.',
    'Untuk /ocr, gambar harus tersedia.'
  );
}

async function handleReminderListCommand(msg) {
  const active = [...reminders.values()]
    .filter((reminder) => reminder.chatId === msg.from)
    .sort((a, b) => a.dueAt - b.dueAt);
  if (!active.length) {
    await sendReply(msg, 'Tidak ada reminder aktif di chat ini.');
    return;
  }
  await sendReply(
    msg,
    `*REMINDER AKTIF*\n${active.map((item) =>
      `ID ${item.id}: ${item.text} — ${new Date(item.dueAt).toLocaleString('id-ID', { timeZone: TIMEZONE })}`
    ).join('\n')}`
  );
}

async function handleCancelReminderCommand(msg, userMessage) {
  const id = Number(userMessage.replace(/^\/cancelremind\s*/i, '').trim());
  const reminder = reminders.get(id);
  if (!Number.isInteger(id) || !reminder || reminder.chatId !== msg.from) {
    await sendReply(msg, 'Reminder tidak ditemukan. Gunakan /remindlist untuk melihat ID.');
    return;
  }
  clearTimeout(reminderTimers.get(id));
  reminderTimers.delete(id);
  reminders.delete(id);
  await saveReminders();
  await sendReply(msg, `Reminder ID ${id} dibatalkan.`);
}

async function handleShortCommand(msg, userMessage) {
  const value = userMessage.replace(/^\/short\s*/i, '').trim();
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL harus memakai http atau https.');
    const response = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url.href)}`, {
      headers: HTTP_HEADERS,
    });
    const shortUrl = (await response.text()).trim();
    if (!response.ok || !/^https?:\/\/tinyurl\.com\//.test(shortUrl)) throw new Error(shortUrl || `HTTP ${response.status}`);
    await sendReply(msg, `URL pendek:\n${shortUrl}`);
  } catch (error) {
    await sendReply(msg, `Format: /short <link valid>. Gagal: ${error.message}`);
  }
}

async function handleFilmCommand(msg, userMessage) {
  const title = userMessage.replace(/^\/film\s*/i, '').trim();
  if (!title) {
    await sendReply(msg, 'Format: /film <judul>.');
    return;
  }
  try {
    const response = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(title)}`, {
      headers: HTTP_HEADERS,
    });
    if (!response.ok) throw new Error(`TVmaze HTTP ${response.status}`);
    const show = (await response.json())[0]?.show;
    if (!show) {
      await sendReply(msg, `Film atau serial "${title}" tidak ditemukan.`);
      return;
    }
    const summary = String(show.summary || 'Tidak ada ringkasan.').replace(/<[^>]+>/g, '');
    await sendReply(
      msg,
      `*${show.name}*\n` +
      `Tayang: ${show.premiered || '-'}\n` +
      `Genre: ${show.genres?.join(', ') || '-'}\n` +
      `Rating: ${show.rating?.average || '-'}\n\n${summary.slice(0, 1500)}`
    );
  } catch (error) {
    await sendReply(msg, `Gagal mencari film: ${error.message}`);
  }
}

async function handleWikiCommand(msg, userMessage) {
  const topic = userMessage.replace(/^\/wiki\s*/i, '').trim();
  if (!topic) {
    await sendReply(msg, 'Format: /wiki <topik>.');
    return;
  }
  try {
    const response = await fetch(`https://id.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(topic)}`, {
      headers: { ...HTTP_HEADERS, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(response.status === 404 ? 'Topik tidak ditemukan.' : `Wikipedia HTTP ${response.status}`);
    const page = await response.json();
    await sendReply(msg, `*${page.title}*\n\n${page.extract || 'Ringkasan tidak tersedia.'}\n\n${page.content_urls?.desktop?.page || ''}`);
  } catch (error) {
    await sendReply(msg, `Gagal mengambil Wikipedia: ${error.message}`);
  }
}

async function handleDefineCommand(msg, userMessage) {
  const word = userMessage.replace(/^\/define\s*/i, '').trim();
  if (!word || !/^[\p{L}\p{N}' -]{1,60}$/u.test(word)) {
    await sendReply(msg, 'Format: /define <kata>.');
    return;
  }
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
      headers: HTTP_HEADERS,
    });
    if (!response.ok) throw new Error('Definisi bahasa Inggris tidak ditemukan.');
    const entry = (await response.json())[0];
    const meanings = entry.meanings?.slice(0, 3).map((meaning) =>
      `${meaning.partOfSpeech || '-'}: ${meaning.definitions?.[0]?.definition || '-'}`
    ).join('\n');
    await sendReply(msg, `*DEFINE ${entry.word}*\n${meanings || 'Definisi tidak tersedia.'}`);
  } catch (error) {
    await sendReply(msg, `Gagal mencari definisi: ${error.message}`);
  }
}

async function handleDetectLanguageCommand(msg, userMessage) {
  const text = userMessage.replace(/^\/detectlang\s*/i, '').trim();
  if (!text) {
    await sendReply(msg, 'Format: /detectlang <teks>.');
    return;
  }
  try {
    const result = await askQwen(`detectlang:${msg.from}`, [
      { role: 'system', content: 'Detect the language of the user text. Reply only with the language name in Indonesian.' },
      { role: 'user', content: text },
    ], 30);
    await sendReply(msg, `Bahasa terdeteksi: ${result.reply.trim()}`);
  } catch (error) {
    await sendReply(msg, `Gagal mendeteksi bahasa: ${error.message}`);
  }
}

async function handleResiCommand(msg, userMessage) {
  const value = userMessage.replace(/^\/cekresi\s*/i, '').trim();
  if (!value) {
    await sendReply(msg, 'Format: /cekresi <kurir> <nomor resi>. Saat ini command menyiapkan format pelacakan manual.');
    return;
  }
  await sendReply(
    msg,
    `Data resi siap dicek:\n${value}\n\nPelacakan otomatis belum aktif karena API kurir belum dikonfigurasi. Cek nomor ini di situs resmi kurir agar data tetap akurat.`
  );
}

async function handleMotivationCommand(msg) {
  const result = await askQwen(`motivasi:${msg.from}`, [
    { role: 'system', content: 'Write one short, original motivational sentence in Indonesian. Output only the sentence.' },
    { role: 'user', content: 'Berikan motivasi singkat.' },
  ], 80);
  await sendReply(msg, result.reply.trim());
}

async function handleReminderCommand(msg, userMessage) {
  const argument = userMessage.replace(/^\/remind\s*/i, '').trim();
  const match = argument.match(/^(\S+)\s+([\s\S]+)$/);
  const duration = match ? parseReminderDuration(match[1]) : null;
  if (!duration || !match[2].trim()) {
    await sendReply(msg, 'Format: /remind <durasi> <pesan>. Contoh: /remind 2j rapat');
    return;
  }
  const reminder = {
    id: nextReminderId++,
    chatId: msg.from,
    text: match[2].trim(),
    dueAt: Date.now() + duration,
  };
  reminders.set(reminder.id, reminder);
  scheduleReminder(reminder);
  await saveReminders();
  await sendReply(msg, `Siap, aku ingatkan dalam ${match[1]} (ID: ${reminder.id}).`);
}

function pollResults(poll) {
  return poll.options.map((option, index) => {
    const total = Object.values(poll.votes).filter((vote) => vote === index).length;
    return `${index + 1}. ${option} — ${total} suara`;
  });
}

function pollText(poll, includeResults = false) {
  const status = poll.closedAt ? 'DITUTUP' : 'AKTIF';
  const lines = [
    `*POLL #${poll.id} — ${status}*`,
    poll.question,
    '',
    ...poll.options.map((option, index) => `${index + 1}. ${option}`),
  ];
  if (includeResults) lines.push('', '*Hasil*', ...pollResults(poll));
  if (!poll.closedAt) lines.push('', `Vote: /vote ${poll.id} <nomor>`);
  return lines.join('\n');
}

async function handlePollCommand(msg, userMessage) {
  const input = userMessage.replace(/^\/poll\s*/i, '').trim();
  const parts = input.split('|').map((part) => part.trim()).filter(Boolean);
  const [question, ...options] = parts;
  if (!question || options.length < 2 || options.length > 10 || question.length > 200 || options.some((option) => option.length > 80)) {
    await sendReply(msg, 'Format: /poll pertanyaan | opsi 1 | opsi 2. Tambahkan 2-10 opsi, maksimal 200 karakter untuk pertanyaan.');
    return;
  }
  const poll = {
    id: nextPollId++,
    chatId: msg.from,
    creatorId: senderChatIdentity(msg),
    question,
    options,
    votes: {},
    createdAt: Date.now(),
  };
  polls.set(poll.id, poll);
  await savePolls();
  await sendReply(msg, `${pollText(poll)}\n\nBagikan poll ini ke chat, lalu vote dengan nomor opsinya.`);
}

async function handleVoteCommand(msg, userMessage) {
  const match = userMessage.match(/^\/vote\s+(\d+)\s+(\d+)$/i);
  if (!match) {
    await sendReply(msg, 'Format: /vote <id poll> <nomor opsi>. Contoh: /vote 3 2');
    return;
  }
  const poll = polls.get(Number(match[1]));
  const optionNumber = Number(match[2]);
  if (!poll || poll.chatId !== msg.from) {
    await sendReply(msg, 'Poll tidak ditemukan di chat ini. Gunakan /polls untuk melihat poll aktif.');
    return;
  }
  if (poll.closedAt) {
    await sendReply(msg, 'Poll ini sudah ditutup.');
    return;
  }
  if (optionNumber < 1 || optionNumber > poll.options.length) {
    await sendReply(msg, `Nomor opsi harus antara 1 sampai ${poll.options.length}.`);
    return;
  }
  poll.votes[senderChatIdentity(msg)] = optionNumber - 1;
  await savePolls();
  await sendReply(msg, `Suara kamu tercatat untuk opsi ${optionNumber}: ${poll.options[optionNumber - 1]}`);
}

async function handlePollListCommand(msg) {
  const active = [...polls.values()].filter((poll) => poll.chatId === msg.from && !poll.closedAt);
  if (!active.length) {
    await sendReply(msg, 'Belum ada poll aktif di chat ini.');
    return;
  }
  await sendReply(msg, active.map((poll) => `#${poll.id} ${poll.question} (${Object.keys(poll.votes).length} suara)`).join('\n'));
}

async function handlePollResultCommand(msg, userMessage) {
  const id = Number(userMessage.replace(/^\/pollresult\s*/i, '').trim());
  const poll = polls.get(id);
  if (!Number.isInteger(id) || !poll || poll.chatId !== msg.from) {
    await sendReply(msg, 'Poll tidak ditemukan di chat ini.');
    return;
  }
  await sendReply(msg, pollText(poll, true));
}

async function handlePollCloseCommand(msg, userMessage) {
  const id = Number(userMessage.replace(/^\/pollclose\s*/i, '').trim());
  const poll = polls.get(id);
  if (!Number.isInteger(id) || !poll || poll.chatId !== msg.from) {
    await sendReply(msg, 'Poll tidak ditemukan di chat ini.');
    return;
  }
  const chat = await msg.getChat();
  if (poll.creatorId !== senderChatIdentity(msg) && !(chat.isGroup && await isGroupAdmin(msg, chat))) {
    await sendReply(msg, 'Hanya pembuat poll atau admin grup yang bisa menutup poll ini.');
    return;
  }
  if (poll.closedAt) {
    await sendReply(msg, 'Poll ini sudah ditutup sebelumnya.');
    return;
  }
  poll.closedAt = Date.now();
  await savePolls();
  await sendReply(msg, `Poll #${poll.id} ditutup.\n\n${pollText(poll, true)}`);
}

async function handleGroupSettingsCommand(msg, userMessage, settingName) {
  const chat = await msg.getChat();
  if (!chat.isGroup) {
    await sendReply(msg, 'Perintah ini hanya bisa dipakai di grup.');
    return;
  }
  if (!await isGroupAdmin(msg, chat)) {
    await sendReply(msg, 'Perintah ini hanya bisa dipakai admin grup.');
    return;
  }
  const value = userMessage.split(/\s+/)[1]?.toLowerCase();
  if (!['on', 'off'].includes(value)) {
    await sendReply(msg, `Format: /${settingName} on atau /${settingName} off`);
    return;
  }
  const settings = groupSetting(chat.id._serialized);
  settings[settingName] = value === 'on';
  await saveSettings();
  await sendReply(msg, `${settingName === 'antilink' ? 'Antilink' : 'Welcome'} ${value === 'on' ? 'aktif' : 'nonaktif'}.`);
}

async function handleAdminMenuCommand(msg) {
  const chat = await msg.getChat();
  if (!chat.isGroup) {
    await sendReply(msg, 'Menu admin hanya tersedia di grup.');
    return;
  }
  if (!await isGroupAdmin(msg, chat)) {
    await sendReply(msg, 'Menu ini hanya bisa dilihat admin grup.');
    return;
  }
  const settings = groupSetting(chat.id._serialized);
  await sendReply(
    msg,
    `*MENU ADMIN*\n\n` +
    `/welcome on|off — sambutan anggota baru (sekarang: ${settings.welcome ? 'on' : 'off'})\n` +
    `/antilink on|off — hapus pesan berisi link (sekarang: ${settings.antilink ? 'on' : 'off'})\n` +
    `/tagall [pesan] — mention anggota grup`
  );
}

async function handleAfkCommand(msg, userMessage) {
  const key = senderChatIdentity(msg);
  const reason = userMessage.replace(/^\/afk\s*/i, '').trim();
  if (reason.length > 200) {
    await sendReply(msg, 'Alasan AFK maksimal 200 karakter.');
    return;
  }
  afkUsers.set(key, {
    reason: reason || 'sedang tidak aktif',
    since: Date.now(),
    chatId: msg.from,
  });
  await sendReply(msg, `AFK aktif: ${reason || 'sedang tidak aktif'}. Kirim pesan lagi untuk menonaktifkan.`);
}

async function handleMentionedAfk(msg) {
  const ids = Array.isArray(msg.mentionedIds) ? msg.mentionedIds : [];
  for (const id of ids) {
    const afk = afkUsers.get(id) || afkUsers.get(serializedWhatsAppId(id));
    if (!afk) continue;
    await sendReply(
      msg,
      `@${senderDisplayNumber(id)} sedang AFK: ${afk.reason} (sejak ${formatUptime(Date.now() - afk.since)} lalu).`,
      { mentions: [id] }
    );
    return true;
  }
  return false;
}

async function handleWelcomeNotification(notification) {
  const settings = groupSettings.get(notification.chatId);
  if (!settings?.welcome || !notification.recipientIds?.length) return;
  const entries = [];
  for (const id of notification.recipientIds) {
    const contact = await client.getContactById(id);
    const mentionId = serializedWhatsAppId(contact?.id) || id;
    entries.push({
      id: mentionId,
      anchor: `@${phoneNumberFromId(contact?.number) || senderDisplayNumber(mentionId)}`,
    });
  }
  if (entries.length) {
    await notification.reply(
      `Wilujeng sumping ${entries.map((entry) => entry.anchor).join(' ')}! Ketik /menu untuk melihat fitur bot.`,
      { mentions: entries.map((entry) => entry.id) }
    );
  }
}

async function restartBot() {
  await client.destroy();
  process.exit(0);
}

async function handleTagAllCommand(msg, userMessage) {
  if (!/^\/tagall(?:\s|$)/i.test(userMessage)) return false;

  const chat = await msg.getChat();
  if (!chat.isGroup) return false;
  const senderId = msg.author || msg._data?.author || msg.id?.participant || msg.from;
  const sender = chat.participants.find(
    (participant) => sameWhatsAppIdentity(participant.id, senderId)
  );
  if (!(await isOwner(msg)) && !sender?.isAdmin && !sender?.isSuperAdmin) {
    await sendReply(msg, 'Perintah `/tagall` hanya bisa dipakai owner atau admin grup.');
    return true;
  }

  const customText = userMessage.replace(/^\/tagall\s*/i, '').trim();
  const mentionEntries = [];
  for (const participant of chat.participants) {
    const id = participant.id?._serialized;
    if (!id || sameWhatsAppIdentity(participant.id, client.info?.wid)) continue;
    const contact = await client.getContactById(id);
    const mentionId = serializedWhatsAppId(contact?.id) || id;
    const displayNumber = phoneNumberFromId(contact?.number) ||
      phoneNumberFromId(mentionId);
    if (!displayNumber) continue;
    mentionEntries.push({
      id: mentionId,
      anchor: `@${displayNumber}`,
    });
  }
  if (!mentionEntries.length) {
    await sendReply(msg, 'Tidak ada anggota lain yang bisa di-tag di grup ini.');
    return true;
  }

  const chunks = [];
  for (let index = 0; index < mentionEntries.length; index += 100) {
    const entries = mentionEntries.slice(index, index + 100);
    chunks.push({
      text: `${index === 0 ? customText : `${customText} (lanjutan)`}\n${entries
        .map((entry) => entry.anchor)
        .join(' ')}`.trim(),
      mentions: entries.map((entry) => entry.id),
    });
  }

  for (const chunk of chunks) {
    await chat.sendMessage(chunk.text, { mentions: chunk.mentions });
  }
  return true;
}

async function acceptGroupInvite(inviteCode) {
  const result = await client.pupPage.evaluate(async (code) => {
    const { joinGroupViaInvite } = await window.WWebJS.requireLazy(
      'WAWebGroupInviteJob',
      'WAWebGroupInviteLinkDrawer.react',
    );
    const response = await joinGroupViaInvite(code);
    const groupId = response?.gid || response?.groupId || response;
    const serialized = groupId?._serialized || groupId?.$1 || groupId;
    if (typeof serialized !== 'string') {
      throw new Error('WhatsApp Web tidak mengembalikan ID grup setelah bergabung');
    }
    return serialized;
  }, inviteCode);

  return result;
}

async function handleOwnerCommand(msg, userMessage) {
  if (!userMessage.startsWith('/')) return false;

  const [command, ...args] = userMessage.trim().split(/\s+/);
  const normalizedCommand = command.toLowerCase();
  const providerChoice = args.join(' ').toLowerCase();
  const providerCommands = new Map([
    ['dashscope', ['DashScope']],
    ['groq', ['Groq']],
    ['both', ['DashScope', 'Groq']],
  ]);
  if (normalizedCommand === '/model' && providerCommands.has(providerChoice)) {
    if (!(await isOwner(msg))) {
      await sendReply(msg, 'Pengaturan provider hanya bisa dipakai owner.');
      return true;
    }
    setEnabledChatProviders(providerCommands.get(providerChoice));
    chatModels.clear();
    await sendReply(
      msg,
      `Provider chat aktif: *${enabledChatProviderLabel()}*.\nModel yang tersedia sekarang: ${MODELS.join(', ')}`
    );
    return true;
  }
  const ownerCommands = [
    '/restart', '/join', '/leave', '/block', '/unblock',
    '/fix-status', '/fix-approve', '/fix-reject',
    '/dev', '/dev-status', '/dev-approve', '/dev-reject',
    '/setstatus', '/setpict', '/setprefix', '/bc', '/broadcast',
  ];

  if (!ownerCommands.includes(normalizedCommand)) return false;
  if (!(await isOwner(msg))) {
    await sendReply(msg, 'Perintah ini khusus owner.');
    return true;
  }

  try {
    if (normalizedCommand === '/dev-status') {
      await sendReply(
        msg,
        pendingDevelopment
          ? `Ada usulan fitur dari ${pendingDevelopment.createdAt}:\n${pendingDevelopment.summary}\nFile: ${pendingDevelopment.patches.map((patch) => patch.file).join(', ')}\n\nKetik /dev-approve atau /dev-reject.`
          : 'Tidak ada usulan fitur yang menunggu persetujuan.'
      );
      return true;
    }
    if (normalizedCommand === '/dev-reject') {
      pendingDevelopment = null;
      await sendReply(msg, 'Usulan perubahan fitur ditolak dan dihapus.');
      return true;
    }
    if (normalizedCommand === '/dev-approve') {
      await approveDevelopment(msg);
      return true;
    }
    if (normalizedCommand === '/dev') {
      const request = userMessage.slice(command.length).trim();
      if (!request) {
        await sendReply(msg, 'Format: /dev <jelaskan fitur atau perubahan yang diinginkan>');
        return true;
      }
      await proposeDevelopment(msg, request);
      return true;
    }
    if (normalizedCommand === '/fix-status') {
      await sendReply(
        msg,
        pendingRepair
          ? `Ada usulan auto-fix dari ${pendingRepair.createdAt}:\n${pendingRepair.summary}\n\nKetik /fix-approve atau /fix-reject.`
          : 'Tidak ada usulan auto-fix yang menunggu persetujuan.'
      );
      return true;
    }
    if (normalizedCommand === '/fix-reject') {
      pendingRepair = null;
      await sendReply(msg, 'Usulan auto-fix ditolak dan dihapus.');
      return true;
    }
    if (normalizedCommand === '/fix-approve') {
      await approveRepair(msg);
      return true;
    }
    if (normalizedCommand === '/restart') {
      await sendReply(msg, 'Bot sedang direstart. Tunggu sebentar ya.');
      setTimeout(() => {
        restartBot().catch((error) => {
          console.error('Gagal merestart bot:', error);
        });
      }, 500);
      return true;
    }
    if (normalizedCommand === '/setstatus') {
      const status = userMessage.slice(command.length).trim();
      if (!status) {
        await sendReply(msg, 'Format: /setstatus <teks status>');
        return true;
      }
      if (status.length > 139) {
        await sendReply(msg, 'Status terlalu panjang. Maksimal 139 karakter.');
        return true;
      }
      await client.setStatus(status);
      await sendReply(msg, 'Status bot berhasil diperbarui.');
      return true;
    }
    if (normalizedCommand === '/setprefix') {
      const prefix = userMessage.slice(command.length).trim();
      if (!/^[^\p{L}\p{N}\s/]{1,3}$/u.test(prefix)) {
        await sendReply(msg, 'Format: /setprefix <1-3 simbol>. Contoh: /setprefix !');
        return true;
      }
      commandPrefix = prefix;
      await saveSettings();
      await sendReply(msg, `Prefix command berhasil diganti menjadi \`${commandPrefix}\`.`);
      return true;
    }
    if (normalizedCommand === '/setpict') {
      let source = msg;
      if (!source.hasMedia && source.hasQuotedMsg) {
        source = await source.getQuotedMessage();
      }
      if (!source?.hasMedia || source.type !== 'image') {
        await sendReply(msg, 'Format: kirim gambar dengan caption /setpict atau reply gambar dengan /setpict.');
        return true;
      }
      const media = await source.downloadMedia();
      if (!media?.data || !media.mimetype?.startsWith('image/')) {
        throw new Error('Gambar tidak tersedia atau formatnya tidak didukung.');
      }
      await client.setProfilePicture(media);
      await sendReply(msg, 'Foto profil bot berhasil diperbarui.');
      return true;
    }
    if (normalizedCommand === '/bc' || normalizedCommand === '/broadcast') {
      const broadcastText = userMessage.slice(command.length).trim();
      if (!broadcastText) {
        await sendReply(msg, `Format: ${normalizedCommand} <pesan pemberitahuan>`);
        return true;
      }
      await sendReply(msg, 'Broadcast dijadwalkan. Pesan akan dikirim setelah koneksi WhatsApp stabil.');
      setTimeout(async () => {
        await syncKnownChats();
        broadcastToAllChats(broadcastText)
          .then(({ success, failed, total }) =>
            notifyOwner(`Broadcast selesai.\nBerhasil: ${success}\nGagal: ${failed}\nTotal tujuan: ${total}`)
          )
          .catch((error) => {
            console.error('Broadcast gagal:', error);
            notifyOwner(`Broadcast gagal: ${error.message}`).catch((notifyError) => {
              console.error('Gagal mengirim laporan broadcast:', notifyError);
            });
          });
      }, 0);
      return true;
    }

    if (normalizedCommand === '/join') {
      const inviteLink = args[0];
      const inviteCode = inviteLink?.match(/chat\.whatsapp\.com\/([a-zA-Z0-9_-]+)/)?.[1];
      if (!inviteCode) {
        await sendReply(msg, 'Format: /join https://chat.whatsapp.com/kodegrup');
        return true;
      }
      const chatId = await acceptGroupInvite(inviteCode);
      await sendReply(msg, `Berhasil masuk grup (${chatId}).`);
      return true;
    }

    if (normalizedCommand === '/leave') {
      const chat = await msg.getChat();
      if (!chat.isGroup) {
        await sendReply(msg, 'Perintah /leave hanya bisa dipakai di dalam grup.');
        return true;
      }
      await sendReply(msg, 'Oke, bot keluar dari grup ini.');
      await chat.leave();
      return true;
    }

    const number = targetNumber(args[0]);
    if (!number) {
      await sendReply(msg, `Format: ${normalizedCommand} 628xxxxxxxxxx`);
      return true;
    }
    const contact = await client.getContactById(number);
    if (normalizedCommand === '/block') {
      await contact.block();
      await sendReply(msg, `Nomor ${phoneNumberFromId(number)} berhasil diblokir.`);
    } else {
      await contact.unblock();
      await sendReply(msg, `Nomor ${phoneNumberFromId(number)} berhasil dibuka blokirnya.`);
    }
  } catch (error) {
    console.error(`Owner command ${normalizedCommand} gagal:`, error);
    await sendReply(msg, `Perintah ${normalizedCommand} gagal dijalankan: ${error.message}`);
  }
  return true;
}

// Batasi panjang riwayat: system prompt + MAX_HISTORY * 2 pesan terakhir
function trimHistory(chatId) {
  const history = chatHistories.get(chatId);
  if (history.length > MAX_HISTORY * 2 + 1) {
    const [systemMsg, ...rest] = history;
    chatHistories.set(chatId, [systemMsg, ...rest.slice(-(MAX_HISTORY * 2))]);
  }
}

async function shouldReplyInGroup(msg, text) {
  if (REPLY_IN_GROUPS) return true;

  const hasTriggerWord = /(?:^|[^\p{L}\p{N}_])(?:ji|aji)(?=$|[^\p{L}\p{N}_])/iu.test(text);
  if (hasTriggerWord) return true;

  const botIds = [client.info?.wid?._serialized, client.info?.me?._serialized].filter(Boolean);
  const mentionedIds = (msg.mentionedIds || []).map((id) =>
    typeof id === 'string' ? id : id?._serialized
  );
  if (mentionedIds.some((id) => botIds.includes(id))) return true;
  if (mentionedIds.length === 0) return false;

  try {
    const mentions = await msg.getMentions();
    return mentions.some((contact) => contact?.isMe);
  } catch (error) {
    console.error('Gagal memeriksa mention bot di grup:', error);
    return false;
  }
}

function splitText(text, maxLength = MAX_WHATSAPP_TEXT_LENGTH) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitAt = Math.max(
      remaining.lastIndexOf('\n', maxLength - 1),
      remaining.lastIndexOf(' ', maxLength - 1)
    );
    if (splitAt < 1) splitAt = maxLength;
    else splitAt++;

    if (
      splitAt < remaining.length &&
      /[\uD800-\uDBFF]/.test(remaining[splitAt - 1]) &&
      /[\uDC00-\uDFFF]/.test(remaining[splitAt])
    ) {
      splitAt--;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

function cleanReplyFormatting(text) {
  const boldParts = [];
  const protectedText = text
    .replace(/\*\*(.+?)\*\*/gs, (_, value) => {
      boldParts.push(value);
      return `\u0000${boldParts.length - 1}\u0000`;
    })
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, value) => {
      boldParts.push(value);
      return `\u0000${boldParts.length - 1}\u0000`;
    })
    .replace(/\*/g, '')
    .replace(/`{3}/g, '');

  return protectedText.replace(/\u0000(\d+)\u0000/g, (_, index) => `*${boldParts[index]}*`).trim();
}

const CODE_LANGUAGE_EXTENSIONS = new Map([
  ['python', 'py'], ['py', 'py'],
  ['javascript', 'js'], ['js', 'js'], ['node', 'js'],
  ['typescript', 'ts'], ['ts', 'ts'],
  ['jsx', 'jsx'], ['tsx', 'tsx'],
  ['java', 'java'], ['kotlin', 'kt'], ['kt', 'kt'],
  ['c', 'c'], ['cpp', 'cpp'], ['c++', 'cpp'], ['h', 'h'], ['hpp', 'hpp'],
  ['csharp', 'cs'], ['c#', 'cs'], ['cs', 'cs'],
  ['go', 'go'], ['rust', 'rs'], ['rs', 'rs'],
  ['php', 'php'], ['ruby', 'rb'], ['rb', 'rb'],
  ['swift', 'swift'], ['dart', 'dart'],
  ['bash', 'sh'], ['shell', 'sh'], ['sh', 'sh'], ['zsh', 'zsh'],
  ['sql', 'sql'], ['html', 'html'], ['css', 'css'],
  ['scss', 'scss'], ['sass', 'sass'], ['less', 'less'],
  ['json', 'json'], ['xml', 'xml'], ['yaml', 'yml'], ['yml', 'yml'],
  ['vue', 'vue'], ['svelte', 'svelte'],
]);

const CODE_LANGUAGE_MIME_TYPES = new Map([
  ['py', 'text/x-python'], ['js', 'text/javascript'], ['ts', 'text/typescript'],
  ['jsx', 'text/jsx'], ['tsx', 'text/tsx'], ['java', 'text/x-java-source'],
  ['kt', 'text/x-kotlin'], ['c', 'text/x-c'], ['cpp', 'text/x-c++src'],
  ['h', 'text/x-c'], ['hpp', 'text/x-c++hdr'], ['cs', 'text/plain'],
  ['go', 'text/x-go'], ['rs', 'text/x-rust'], ['php', 'application/x-php'],
  ['rb', 'text/x-ruby'], ['swift', 'text/x-swift'], ['dart', 'text/plain'],
  ['sh', 'application/x-sh'], ['zsh', 'application/x-sh'],
  ['sql', 'application/sql'], ['html', 'text/html'], ['css', 'text/css'],
  ['scss', 'text/x-scss'], ['sass', 'text/x-sass'], ['less', 'text/css'],
  ['json', 'application/json'], ['xml', 'application/xml'],
  ['yml', 'application/yaml'], ['vue', 'text/plain'], ['svelte', 'text/plain'],
]);

function extractCodeBlocks(text) {
  const files = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  for (const match of String(text || '').matchAll(pattern)) {
    const info = match[1].trim();
    const tokens = info.split(/\s+/).filter(Boolean);
    const language = (tokens.shift() || 'txt').toLowerCase();
    const requestedName = tokens.find((token) => /\.[a-z0-9]+$/i.test(token));
    const extension = CODE_LANGUAGE_EXTENSIONS.get(language) || (
      requestedName?.split('.').pop()?.toLowerCase() || 'txt'
    );
    const filename = requestedName
      ? path.basename(requestedName)
      : `kode-${files.length + 1}.${extension}`;
    const content = match[2].replace(/^\n|\n$/g, '');
    if (content.trim()) files.push({ content, filename, extension });
  }
  return files;
}

function removeCodeBlocks(text) {
  return String(text || '').replace(/```[^\n`]*\n[\s\S]*?```/g, '').trim();
}

async function sendCodeFiles(msg, files) {
  for (const file of files) {
    const buffer = Buffer.from(file.content, 'utf8');
    if (buffer.length > MAX_DOCUMENT_BYTES) {
      throw new Error(`File ${file.filename} terlalu besar. Batasnya 8 MB.`);
    }
    const media = new MessageMedia(
      CODE_LANGUAGE_MIME_TYPES.get(file.extension) || 'text/plain',
      buffer.toString('base64'),
      file.filename
    );
    await sendReply(msg, media, { sendMediaAsDocument: true });
  }
}

async function replyWithLongText(msg, text, replyAnchor = null) {
  text = cleanReplyFormatting(text);
  const chunks = splitText(text);
  if (chunks.length === 0) return;

  if (replyAnchor) {
    await replyAnchor.edit(chunks[0]);
  } else {
    await sendReply(msg, chunks[0]);
  }
  for (const chunk of chunks.slice(1)) {
    await client.sendMessage(msg.from, cleanReplyFormatting(chunk));
  }
}

async function sendReply(msg, content, options = {}) {
  try {
    if (typeof content === 'string') content = cleanReplyFormatting(content);
    if (Object.keys(options).length === 0) return await msg.reply(content);
    return await msg.reply(content, undefined, options);
  } catch (error) {
    const message = String(error?.message || error);
    if (isClosedWhatsAppError(error)) {
      console.error('Balasan dibatalkan karena koneksi WhatsApp Web sudah tertutup:', message);
      return null;
    }
    throw error;
  }
}

async function editReplySafely(reply, content) {
  if (!reply) return false;
  try {
    await reply.edit(content);
    return true;
  } catch (error) {
    const message = String(error?.message || error);
    if (isClosedWhatsAppError(error)) {
      console.error('Edit balasan dibatalkan karena koneksi WhatsApp Web sudah tertutup:', message);
      return false;
    }
    throw error;
  }
}

const providerCursors = new Map();

// Model pilihan chat dicoba lebih dulu; sisanya menjadi fallback.
function modelOrder(chatId, models = MODELS) {
  const chosen = chatModels.get(chatId);
  const selected = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
  const preferred = selected.filter((model) => models.includes(model));
  return [...preferred, ...models.filter((model) => !preferred.includes(model))];
}

async function askQwen(
  chatId,
  messages,
  maxTokens = MAX_TOKENS,
  models = MODELS,
  requestOptions = {}
) {
  let lastError;
  const orderedModels = modelOrder(chatId, models);
  const providerScope = models === VISION_MODELS
    ? chatProviders
    : chatProviders.filter(({ name }) => enabledChatProviders.has(name));
  const availableProviders = providerScope.filter(({ supportedModels }) =>
    orderedModels.some((model) => supportedModels.includes(model))
  );
  if (!availableProviders.length) {
    throw new Error(`Tidak ada provider yang mendukung model: ${orderedModels.join(', ')}`);
  }
  const cursor = providerCursors.get(chatId) || 0;
  const orderedProviders = availableProviders.map(
    (_, index, providers) => providers[(cursor + index) % providers.length]
  );
  providerCursors.set(chatId, cursor + 1);
  const chosen = chatModels.get(chatId);
  const selected = (Array.isArray(chosen) ? chosen : chosen ? [chosen] : [])
    .filter((model) => orderedModels.includes(model));
  const preferredAttempts = selected.flatMap((model) => orderedProviders
    .filter((provider) => provider.supportedModels.includes(model))
    .map((provider) => ({ provider, model })));
  const fallbackAttempts = orderedProviders.flatMap((provider) => orderedModels
    .filter((model) => !selected.includes(model) && provider.supportedModels.includes(model))
    .map((model) => ({ provider, model })));

  for (const { provider, model } of [...preferredAttempts, ...fallbackAttempts]) {
    try {
      let reply;
      if (provider.complete) {
        reply = await provider.complete({ model, messages, maxTokens, requestOptions });
      } else {
        const completion = await provider.client.chat.completions.create({
          model, messages, max_tokens: maxTokens, ...requestOptions,
        });
        reply = completion.choices?.[0]?.message?.content;
      }
      // Model reasoning bisa menghabiskan max_tokens sehingga isi jawaban kosong: coba model berikutnya
      if (!reply || !String(reply).trim()) throw new Error('Balasan model kosong');
      return { reply, model, provider: provider.name };
    } catch (error) {
      lastError = error;
      console.error(`${provider.name} model ${model} gagal:`, error?.status, error?.message);
    }
  }
  throw lastError;
}

async function imageMessageContent(msg, prompt) {
  const media = await downloadMedia(msg);
  if (!media?.data || !media.mimetype?.startsWith('image/')) {
    throw new Error('Media gambar tidak tersedia atau formatnya tidak didukung');
  }

  return [
    { type: 'text', text: prompt },
    {
      type: 'image_url',
      image_url: { url: `data:${media.mimetype};base64,${media.data}` },
    },
  ];
}

async function videoMessageContent(msg, prompt) {
  const media = await downloadMedia(msg);
  if (!media?.data || !media.mimetype?.startsWith('video/')) {
    throw new Error('Media video tidak tersedia atau formatnya tidak didukung');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'wavision-'));
  try {
    const inputPath = path.join(dir, 'input-video');
    const framePath = path.join(dir, 'video-frame.jpg');
    await writeFile(inputPath, Buffer.from(media.data, 'base64'));
    await runFfmpeg([
      '-y',
      '-i', inputPath,
      '-frames:v', '1',
      '-vf', 'scale=1280:1280:force_original_aspect_ratio=decrease',
      '-q:v', '3',
      framePath,
    ]);

    return [
      {
        type: 'text',
        text: `${prompt}\n\nIni adalah satu frame awal dari video. Jelaskan hanya hal yang terlihat dan sebutkan bahwa analisis berdasarkan frame awal jika isi video tidak dapat dipastikan.`,
      },
      {
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${(await readFile(framePath)).toString('base64')}`,
        },
      },
    ];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function downloadMedia(msg) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const media = await msg.downloadMedia();
      if (media?.data) return media;
    } catch (error) {
      lastError = error;
      console.error(`Download media gagal (${attempt}/3):`, error.message);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(lastError?.message || 'Media tidak tersedia atau belum bisa diunduh');
}

function isTextDocument(media) {
  const filename = (media.filename || '').toLowerCase();
  return media.mimetype?.startsWith('text/') ||
    /\.(txt|md|json|csv|xml|yaml|yml|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cpp|hpp|cs|go|rs|php|rb|sh|sql|html|css|scss|vue|svelte|log)$/i.test(filename);
}

function isWordDocument(media) {
  const filename = (media.filename || '').toLowerCase();
  return media.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    /\.docx$/i.test(filename);
}

function documentExtension(media) {
  const filename = (media.filename || '').toLowerCase();
  if (media.mimetype === 'application/pdf' || /\.pdf$/i.test(filename)) return 'pdf';
  if (isWordDocument(media)) return 'docx';
  return null;
}

async function extractPdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

async function convertWordToPdf(buffer) {
  const result = await convertDocument(
    buffer,
    { outputFormat: 'pdf' },
    { wasmPath: CONVERTER_WASM_PATH }
  );
  return Buffer.from(result.data);
}

async function convertPdfToWord(buffer) {
  const text = (await extractPdfText(buffer)).trim();
  if (!text) {
    throw new Error('PDF tidak berisi teks yang bisa dikonversi. PDF hasil scan perlu OCR terlebih dahulu.');
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new Paragraph({ children: [new TextRun(value)] }));
  const document = new Document({ sections: [{ children: paragraphs }] });
  return Packer.toBuffer(document);
}

async function convertDocumentMessage(msg, sourceMessage, target) {
  const media = await downloadMedia(sourceMessage);
  const inputFormat = documentExtension(media);
  const buffer = Buffer.from(media.data, 'base64');
  if (!inputFormat) {
    throw new Error('Format sumber harus PDF atau DOCX.');
  }
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new Error('Ukuran dokumen terlalu besar. Batasnya 8 MB.');
  }
  if (target === 'pdf' && inputFormat !== 'docx') {
    throw new Error('Untuk convert ke PDF, kirim file Word/DOCX.');
  }
  if (target === 'docx' && inputFormat !== 'pdf') {
    throw new Error('Untuk convert ke Word, kirim file PDF.');
  }

  const converted = target === 'pdf'
    ? await convertWordToPdf(buffer)
    : await convertPdfToWord(buffer);
  if (converted.length > MAX_CONVERTED_BYTES) {
    throw new Error('Hasil konversi terlalu besar untuk dikirim lewat WhatsApp.');
  }

  const originalName = (media.filename || 'dokumen').replace(/\.[^.]+$/, '');
  const filename = `${originalName}.${target}`;
  const output = new MessageMedia(
    target === 'pdf'
      ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    converted.toString('base64'),
    filename
  );
  await sendReply(msg, output, { sendMediaAsDocument: true });
}

async function documentMessageContent(msg, prompt) {
  const media = await downloadMedia(msg);
  const filename = media.filename || 'dokumen';
  const buffer = Buffer.from(media.data, 'base64');
  if (buffer.length > MAX_DOCUMENT_BYTES) {
    throw new Error('Ukuran dokumen terlalu besar. Batasnya 8 MB.');
  }

  if (media.mimetype === 'application/pdf' || /\.pdf$/i.test(filename)) {
    const text = await extractPdfText(buffer);
    if (!text.trim()) {
      throw new Error('PDF tidak berisi teks yang bisa dibaca. Jika berupa scan, kirim sebagai gambar.');
    }
    return `${prompt}\n\nNama file: ${filename}\nIsi PDF:\n${text.slice(0, MAX_DOCUMENT_CHARS)}`;
  }

  if (isWordDocument(media)) {
    try {
      const { value: text } = await mammoth.extractRawText({ buffer });
      if (!text) throw new Error('Dokumen Word tidak berisi teks yang bisa dibaca.');
      return `${prompt}\n\nNama file: ${filename}\nIsi dokumen Word:\n${text.slice(0, MAX_DOCUMENT_CHARS)}`;
    } catch (error) {
      throw new Error(`Dokumen Word gagal dibaca: ${error.message}`);
    }
  }

  if (isTextDocument(media)) {
    return `${prompt}\n\nNama file: ${filename}\nIsi file:\n${buffer.toString('utf8').slice(0, MAX_DOCUMENT_CHARS)}`;
  }

  throw new Error(
    `Format ${media.mimetype || 'file'} belum didukung. Kirim PDF, DOCX, gambar, atau file teks/kode.`
  );
}

// ====== Voice note: WhatsApp (ogg/opus) -> WAV 16 kHz mono -> teks ======
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('Binary FFmpeg tidak ditemukan. Jalankan npm install ulang.'));
      return;
    }
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', reject); // mis. ffmpeg belum terpasang
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg gagal: ${stderr.slice(-300)}`))
    );
  });
}

async function createSticker(msg) {
  let source = msg;
  if (!source.hasMedia && source.hasQuotedMsg) {
    source = await source.getQuotedMessage();
  }
  if (!source?.hasMedia || source.type !== 'image') {
    await sendReply(msg, 'Balas gambar dengan `/stiker` atau kirim gambar memakai caption `/s`.');
    return;
  }

  let media;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      media = await source.downloadMedia();
      if (media?.data) break;
    } catch (error) {
      lastError = error;
      console.error(`Download gambar untuk stiker gagal (${attempt}/3):`, error.message);
    }
    if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!media?.data || !media.mimetype?.startsWith('image/')) {
    throw new Error(lastError?.message || 'Media gambar tidak tersedia atau belum bisa diunduh');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'wasticker-'));
  try {
    const inputPath = path.join(dir, 'input');
    const outputPath = path.join(dir, 'sticker.webp');
    await writeFile(inputPath, Buffer.from(media.data, 'base64'));
    await runFfmpeg([
      '-y', '-i', inputPath,
      '-vf',
      'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
      '-frames:v', '1', '-c:v', 'libwebp', '-quality', '75', outputPath,
    ]);

    const sticker = new MessageMedia(
      'image/webp',
      (await readFile(outputPath)).toString('base64'),
      'sticker.webp'
    );
    await sendReply(msg, sticker, {
      sendMediaAsSticker: true,
      stickerName: 'Aji BOT',
      stickerAuthor: 'Barudak Darmaji',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createAnimatedSticker(msg, source = msg) {
  if (!source?.hasMedia || !isVideoMediaMessage(source)) {
    await sendReply(msg, 'Kirim video dengan caption `/sgif` atau balas video dengan `/sgif`.');
    return;
  }

  const media = await source.downloadMedia();
  if (!media?.data || !String(media.mimetype || '').toLowerCase().startsWith('video/')) {
    throw new Error('Media video tidak tersedia atau formatnya tidak didukung');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'wasticker-gif-'));
  try {
    const inputPath = path.join(dir, 'input-video');
    const outputPath = path.join(dir, 'sticker.webp');
    await writeFile(inputPath, Buffer.from(media.data, 'base64'));
    await runFfmpeg([
      '-y', '-i', inputPath,
      '-t', '6',
      '-vf',
      'fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
      '-an', '-c:v', 'libwebp', '-loop', '0', '-preset', 'default',
      '-q:v', '60', outputPath,
    ]);

    const sticker = new MessageMedia(
      'image/webp',
      (await readFile(outputPath)).toString('base64'),
      'sticker-animasi.webp'
    );
    await sendReply(msg, sticker, {
      sendMediaAsSticker: true,
      stickerName: 'Aji BOT',
      stickerAuthor: 'Barudak Darmaji',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createImageFromSticker(msg, source = msg) {
  if (!source?.hasMedia || !['sticker', 'image'].includes(source.type)) {
    await sendReply(msg, 'Balas stiker dengan `/img` atau kirim stiker memakai caption `/img`.');
    return;
  }

  const media = await downloadMedia(source);
  if (!media.mimetype?.startsWith('image/')) {
    throw new Error('Media stiker tidak tersedia atau formatnya tidak didukung.');
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'wasticker-image-'));
  try {
    const inputPath = path.join(dir, 'sticker');
    const outputPath = path.join(dir, 'sticker.png');
    await writeFile(inputPath, Buffer.from(media.data, 'base64'));
    await runFfmpeg(['-y', '-i', inputPath, '-frames:v', '1', '-pix_fmt', 'rgba', outputPath]);

    const image = new MessageMedia(
      'image/png',
      (await readFile(outputPath)).toString('base64'),
      'sticker.png'
    );
    await sendReply(msg, image, { caption: 'Ini versi gambarnya, Tuan.' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function transcribe(wavBuffer) {
  const dataUri = `data:audio/wav;base64,${wavBuffer.toString('base64')}`;
  let lastError;
  for (const model of ASR_MODELS) {
    try {
      const res = await fetch(ASR_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${DASHSCOPE_API_KEY}`,
          'Content-Type': 'application/json',
          'X-DashScope-SSE': 'disable',
        },
        body: JSON.stringify({
          model,
          input: {
            messages: [
              { role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] },
            ],
          },
          parameters: { format: 'wav', sample_rate: '16000' },
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${json.message || JSON.stringify(json).slice(0, 200)}`);
      }
      const text = json.output?.text ?? json.output?.output?.sentence?.text;
      if (text && text.trim()) return text.trim();
      throw new Error('Hasil transkripsi kosong');
    } catch (error) {
      lastError = error;
      console.error(`ASR ${model} gagal:`, error.message);
    }
  }
  throw lastError;
}

async function voiceToText(msg) {
  const media = await msg.downloadMedia();
  if (!media) throw new Error('Gagal mengunduh voice note');
  const dir = await mkdtemp(path.join(tmpdir(), 'wavoice-'));
  try {
    const inPath = path.join(dir, 'in.audio');
    const outPath = path.join(dir, 'out.wav');
    await writeFile(inPath, Buffer.from(media.data, 'base64'));
    await runFfmpeg(['-y', '-i', inPath, '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', outPath]);
    return await transcribe(await readFile(outPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ====== Kirim gambar dari beberapa sumber lalu hindari pengulangan per keyword ======
function extractImageQuery(text) {
  const cmd = text.match(/^\/gambar\s+(.+)/i);
  if (!cmd) return null;
  const query = cmd[1].trim();
  return query.length <= 60 ? query : null;
}

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const IMAGE_VERIFY_BATCH = 4;

// Judul file di sumber gambar kebanyakan bahasa Inggris, jadi kata kunci diterjemahkan dulu.
// Detail penting (jenis, warna, tempat, nama) harus tetap dipertahankan agar hasil spesifik.
async function toEnglishKeyword(query) {
  try {
    const { reply } = await askQwen(
      '__translate__',
      [
        {
          role: 'system',
          content:
            'Convert the user text into the best English image-search keyword (1-5 words). ' +
            'Keep every specific detail (breed, color, place, person name, model). ' +
            'Use the common English name of the subject. Output only the keyword, nothing else.',
        },
        { role: 'user', content: query },
      ],
      40
    );
    const keyword = String(reply || '')
      .split('\n')[0]
      .replace(/["'.]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return keyword && keyword.length <= 60 ? keyword : query;
  } catch {
    return query;
  }
}

function imageSearchTokens(query) {
  return query
    .toLocaleLowerCase('id-ID')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !/^(gambar|foto|image|photo|yang|dan|atau|dari|the|with|for)$/i.test(token));
}

async function searchImages(query, limit) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: '6',
    gsrlimit: String(limit * 4),
    gsrsort: 'relevance',
    prop: 'imageinfo',
    iiprop: 'url|mime|extmetadata',
    iiurlwidth: '800',
    format: 'json',
    origin: '*',
  }).toString();
  const res = await fetch(url, { headers: HTTP_HEADERS });
  if (!res.ok) throw new Error(`Wikimedia HTTP ${res.status}`);
  const json = await res.json();
  const pages = Object.values(json.query?.pages || {}).sort((a, b) => a.index - b.index);
  const queryText = query.toLocaleLowerCase('id-ID');
  const tokens = imageSearchTokens(query);
  return pages
    .map((page) => {
      const info = page.imageinfo?.[0];
      const title = String(page.title || '').replace(/^File:/i, '').replace(/[_-]+/g, ' ');
      const description = String(info?.extmetadata?.ImageDescription?.value || '')
        .replace(/<[^>]+>/g, ' ')
        .slice(0, 500);
      const haystack = `${title} ${description}`.toLocaleLowerCase('id-ID');
      const titleText = title.toLocaleLowerCase('id-ID');
      const matchedTokens = tokens.filter((token) => haystack.includes(token));
      const score =
        matchedTokens.length * 3 +
        tokens.filter((token) => titleText.includes(token)).length * 4 +
        (queryText.length >= 4 && haystack.includes(queryText) ? 10 : 0);
      return {
        url: info?.thumburl || info?.url,
        title,
        score,
        matchedTokens,
        mime: info?.mime,
      };
    })
    .filter((item) => {
      const requiredMatches = tokens.length > 1 ? tokens.length : 1;
      return (
        item.url &&
        /^image\/(jpeg|png)$/.test(item.mime) &&
        item.score > 0 &&
        item.matchedTokens.length >= requiredMatches
      );
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function imageQueryKey(query) {
  return query.toLocaleLowerCase('id-ID').replace(/\s+/g, ' ').trim();
}

function imageHistoryFor(chatId, query) {
  const chatHistory = sentImageHistory.get(chatId) || new Map();
  const history = chatHistory.get(imageQueryKey(query)) || new Set();
  return { chatHistory, history };
}

async function searchUnsplash(query, limit, usedUrls) {
  const searchUrl = `https://unsplash.com/s/photos/${encodeURIComponent(query)}`;
  const res = await fetch(searchUrl, { headers: HTTP_HEADERS });
  if (!res.ok) throw new Error(`Unsplash HTTP ${res.status}`);
  const html = await res.text();
  const urls = [...html.matchAll(/https:\/\/images\.unsplash\.com\/photo-[^"\\\s]+/g)]
    .map((match) => match[0].replace(/&amp;/g, '&'))
    .map((url) => {
      const parsed = new URL(url);
      parsed.searchParams.set('w', '900');
      parsed.searchParams.set('auto', 'format');
      parsed.searchParams.set('fit', 'crop');
      return parsed.href;
    });
  const candidates = [];
  for (const url of urls) {
    if (!usedUrls.has(url) && !candidates.some((item) => item.url === url)) {
      candidates.push({ url, source: 'Unsplash' });
    }
    if (candidates.length >= limit) break;
  }
  return candidates;
}

// Skor kecocokan kata kunci terhadap teks (judul/tag) sebuah kandidat
function scoreImageText(query, tokens, title, extra = '') {
  const titleText = title.toLocaleLowerCase('id-ID');
  const haystack = `${titleText} ${extra.toLocaleLowerCase('id-ID')}`;
  const matchedTokens = tokens.filter((token) => haystack.includes(token));
  const queryText = query.toLocaleLowerCase('id-ID');
  const score =
    matchedTokens.length * 3 +
    tokens.filter((token) => titleText.includes(token)).length * 4 +
    (queryText.length >= 4 && haystack.includes(queryText) ? 10 : 0);
  return { score, matchedTokens };
}

// Foto utama artikel Wikipedia: sangat akurat untuk benda, hewan, tempat, dan tokoh
async function searchWikipediaImages(query, limit) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrnamespace: '0',
    gsrlimit: String(Math.min(limit, 8)),
    prop: 'pageimages',
    piprop: 'thumbnail',
    pithumbsize: '900',
    format: 'json',
    origin: '*',
  }).toString();
  const res = await fetch(url, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const json = await res.json();
  const tokens = imageSearchTokens(query);
  return Object.values(json.query?.pages || {})
    .sort((a, b) => a.index - b.index)
    .filter((page) => page.thumbnail?.source && /\.(jpe?g|png)(\?|$)/i.test(page.thumbnail.source))
    .map((page) => {
      const { score, matchedTokens } = scoreImageText(query, tokens, String(page.title || ''));
      // Artikel peringkat teratas dengan judul cocok diberi bonus
      const rankBonus = Math.max(0, 6 - page.index);
      return {
        url: page.thumbnail.source,
        title: page.title,
        score: score + rankBonus,
        matchedTokens,
        source: 'Wikipedia',
      };
    })
    .filter((item) => item.matchedTokens.length > 0);
}

async function searchOpenverse(query, limit) {
  const url = new URL('https://api.openverse.org/v1/images/');
  url.search = new URLSearchParams({
    q: query,
    page_size: String(Math.min(limit * 2, 20)),
    mature: 'false',
    category: 'photograph',
  }).toString();
  const res = await fetch(url, { headers: HTTP_HEADERS, signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Openverse HTTP ${res.status}`);
  const json = await res.json();
  const tokens = imageSearchTokens(query);
  const requiredMatches = tokens.length > 1 ? Math.ceil(tokens.length * 0.67) : 1;
  return (json.results || [])
    .map((item) => {
      const tags = (item.tags || []).map((tag) => tag.name).join(' ');
      const { score, matchedTokens } = scoreImageText(query, tokens, String(item.title || ''), tags);
      return {
        url: item.thumbnail || item.url,
        title: item.title || '',
        score,
        matchedTokens,
        source: 'Openverse',
      };
    })
    .filter((item) => item.url && item.matchedTokens.length >= requiredMatches);
}

async function searchImageCandidates(query, limit, usedUrls) {
  const sources = [
    searchWikipediaImages(query, limit),
    searchImages(query, limit).then((items) =>
      items.map((item) => ({ ...item, source: 'Wikimedia Commons' }))
    ),
    searchOpenverse(query, limit),
  ];
  const settled = await Promise.allSettled(sources);
  const candidates = [];
  for (const result of settled) {
    if (result.status === 'rejected') {
      console.error('Sumber gambar gagal:', result.reason?.message || result.reason);
      continue;
    }
    for (const item of result.value) {
      if (!usedUrls.has(item.url) && !candidates.some((c) => c.url === item.url)) {
        candidates.push(item);
      }
    }
  }
  return candidates.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, limit);
}

async function downloadCandidateImage(candidate) {
  const res = await fetch(candidate.url, {
    headers: HTTP_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 5 * 1024 || buffer.length > MAX_IMAGE_BYTES) return null;
  return { mime, buffer };
}

// Cek isi gambar dengan model vision. true = cocok, false = tidak cocok, null = tidak bisa dicek
let visionUnavailableUntil = 0;
async function verifyImageMatchesQuery(query, english, { mime, buffer }) {
  if (!VISION_MODELS?.length || Date.now() < visionUnavailableUntil) return null;
  try {
    const subject = english && english.toLowerCase() !== query.toLowerCase() ? `${query} (${english})` : query;
    const { reply } = await askQwen(
      '__image_verify__',
      [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `Does this image clearly and mainly show: "${subject}"? ` +
                'It must be a real photo of that exact subject, not a logo, text-only graphic, diagram, map, ' +
                'collage, or a different subject. Answer with only YES or NO.',
            },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
          ],
        },
      ],
      10,
      VISION_MODELS
    );
    const answer = String(reply || '').trim().toUpperCase();
    if (answer.startsWith('YES')) return true;
    if (answer.startsWith('NO')) return false;
    return null;
  } catch (error) {
    console.error('Verifikasi gambar gagal:', error?.message);
    // Model vision belum aktif/tidak ada: jangan coba lagi selama 10 menit
    if ([403, 404].includes(error?.status)) visionUnavailableUntil = Date.now() + 10 * 60 * 1000;
    return null;
  }
}

async function sendImages(msg, query) {
  const english = await toEnglishKeyword(query);
  const { chatHistory, history } = imageHistoryFor(msg.from, query);
  const candidates = [];
  const usedUrls = new Set(history);
  const addCandidates = (items) => {
    for (const item of items) {
      if (!usedUrls.has(item.url) && !candidates.some((candidate) => candidate.url === item.url)) {
        candidates.push(item);
      }
    }
  };

  const pool = Math.min(Math.max(IMAGE_COUNT, 1) * 4, 12);
  const searches = [searchImageCandidates(english, pool, usedUrls)];
  if (english.toLowerCase() !== query.toLowerCase()) searches.push(searchImageCandidates(query, pool, usedUrls));
  for (const result of await Promise.allSettled(searches)) {
    if (result.status === 'fulfilled') addCandidates(result.value);
  }
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  if (candidates.length === 0) {
    await sendReply(msg, `Gue nggak nemu gambar buat "${query}". Coba kata kunci lain ya.`);
    return 0;
  }

  // Unduh dan verifikasi per kelompok kecil, berhenti begitu jumlah gambar cukup
  let sent = 0;
  let verifiedAtLeastOnce = false;
  let rejectedByVision = 0;
  const maxChecked = Math.max(IMAGE_COUNT, 1) * 6;
  for (let i = 0; i < candidates.length && i < maxChecked && sent < IMAGE_COUNT; i += IMAGE_VERIFY_BATCH) {
    const batch = candidates.slice(i, i + IMAGE_VERIFY_BATCH);
    const checked = await Promise.all(
      batch.map(async (candidate) => {
        try {
          const image = await downloadCandidateImage(candidate);
          if (!image) return null;
          const verdict = await verifyImageMatchesQuery(query, english, image);
          return { candidate, image, verdict };
        } catch (error) {
          console.error('Unduh gambar gagal:', candidate.url, error?.message);
          return null;
        }
      })
    );
    for (const item of checked) {
      if (!item || sent >= IMAGE_COUNT) continue;
      if (item.verdict === true) verifiedAtLeastOnce = true;
      if (item.verdict === false) {
        rejectedByVision++;
        continue;
      }
      // Verifikasi tidak tersedia: hanya terima kandidat yang judul/tag-nya cocok kuat
      if (item.verdict === null && !(item.candidate.score >= 7)) continue;
      const { mime, buffer } = item.image;
      const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      const media = new MessageMedia(mime, buffer.toString('base64'), `gambar-${sent + 1}.${extension}`);
      await sendReply(msg, media, {
        caption: sent === 0 ? `Gambar: ${query} (sumber: ${item.candidate.source})` : undefined,
      });
      history.add(item.candidate.url);
      sent++;
    }
  }
  if (sent === 0 && rejectedByVision > 0 && !verifiedAtLeastOnce) {
    await sendReply(
      msg,
      `Gue nemu beberapa gambar buat "${query}", tapi nggak ada yang cocok banget. Coba kata kunci yang lebih spesifik ya.`
    );
    return 0;
  }
  if (sent > 0) {
    chatHistory.set(imageQueryKey(query), new Set([...history].slice(-MAX_IMAGE_HISTORY_PER_QUERY)));
    sentImageHistory.set(msg.from, chatHistory);
  }
  if (sent === 0) await sendReply(msg, 'Gambarnya ketemu tapi gagal terkirim. Coba lagi nanti.');
  return sent;
}

async function resolveSocialVideoUrl(url) {
  const parsed = new URL(url);
  if (!parsed.hostname.toLowerCase().startsWith('vt.tiktok.')) return url;
  const response = await fetch(url, {
    method: 'HEAD',
    redirect: 'follow',
    headers: HTTP_HEADERS,
  });
  const resolved = new URL(response.url);
  if (
    resolved.hostname.toLowerCase().endsWith('tiktok.com') &&
    (resolved.pathname === '/' || resolved.pathname === '')
  ) {
    throw new Error('Link pendek TikTok sudah kedaluwarsa atau tidak mengarah ke video. Salin link video TikTok yang baru.');
  }
  return resolved.href;
}

async function fetchInstagramProfile(username) {
  if (!/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
    throw new Error('Username Instagram tidak valid. Gunakan hanya username tanpa @.');
  }
  const url = new URL('https://www.instagram.com/api/v1/users/web_profile_info/');
  url.searchParams.set('username', username);
  const response = await fetch(url, {
    headers: {
      ...HTTP_HEADERS,
      Accept: 'application/json',
      'X-IG-App-ID': '936619743392459',
    },
  });
  if (!response.ok) {
    if (response.status !== 429) {
      throw new Error(`Instagram mengembalikan HTTP ${response.status}. Profil mungkin privat atau sementara dibatasi.`);
    }
    const page = await fetch(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      headers: { ...HTTP_HEADERS, 'User-Agent': 'Mozilla/5.0' },
    });
    if (!page.ok) {
      throw new Error(`Instagram mengembalikan HTTP ${page.status}. Profil mungkin privat atau sementara dibatasi.`);
    }
    const html = await page.text();
    const profileImage = html
      .match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1]
      ?.replace(/&amp;/g, '&');
    const description = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1];
    const stats = description?.match(
      /^\s*([\d,.]+[KMB]?)\s+Followers,\s+([\d,.]+[KMB]?)\s+Following,\s+([\d,.]+[KMB]?)\s+Posts?\b/i
    );
    if (!stats) throw new Error('Instagram membatasi akses statistik profil untuk sementara.');
    const parseCount = (value) => {
      const normalized = value.replace(/,/g, '');
      const suffix = normalized.slice(-1).toUpperCase();
      const multiplier = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
      return Math.round(Number(suffix.match(/[KMB]/) ? normalized.slice(0, -1) : normalized) * multiplier);
    };
    return {
      username,
      full_name: '',
      edge_followed_by: { count: parseCount(stats[1]) },
      edge_follow: { count: parseCount(stats[2]) },
      edge_owner_to_timeline_media: { count: parseCount(stats[3]) },
      is_private: null,
      profile_pic_url_hd: profileImage || null,
    };
  }
  const payload = await response.json();
  const profile = payload?.data?.user;
  if (!profile) throw new Error('Profil Instagram tidak ditemukan atau tidak bisa diakses.');
  return profile;
}

async function handleInstagramStalk(msg, userMessage) {
  const username = userMessage.replace(/^\/igstalk\s*/i, '').trim().replace(/^@/, '');
  if (!username) {
    await sendReply(msg, 'Format: /igstalk <username>. Contoh: /igstalk murzeme');
    return;
  }
  try {
    const profile = await fetchInstagramProfile(username);
    const number = (value) => Number(value || 0).toLocaleString('id-ID');
    const followers = profile.edge_followed_by?.count;
    const following = profile.edge_follow?.count;
    const posts = profile.edge_owner_to_timeline_media?.count;
    if (![followers, following, posts].every(Number.isFinite)) {
      throw new Error('Data statistik profil Instagram tidak lengkap.');
    }
    const status = profile.is_private === true
      ? 'Privat'
      : profile.is_private === false
        ? 'Publik'
        : 'Tidak terdeteksi (akses Instagram dibatasi)';
    const caption =
      `*STATISTIK INSTAGRAM*\n\n` +
      `Username: @${profile.username}\n` +
      `Nama: ${profile.full_name || '-'}\n` +
      `Deskripsi: ${profile.biography || '-'}\n` +
      `Followers: ${number(followers)}\n` +
      `Following: ${number(following)}\n` +
      `Postingan: ${number(posts)}\n` +
      `Status: ${status}`;
    const profileImageUrl = profile.profile_pic_url_hd || profile.profile_pic_url;
    if (profileImageUrl) {
      try {
        const imageResponse = await fetch(profileImageUrl, { headers: HTTP_HEADERS });
        if (!imageResponse.ok) throw new Error(`HTTP ${imageResponse.status}`);
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const mime = (imageResponse.headers.get('content-type') || 'image/jpeg').split(';')[0];
        if (!/^image\/(jpeg|png|webp)$/.test(mime)) {
          throw new Error(`Format foto tidak didukung: ${mime}`);
        }
        const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        await sendReply(
          msg,
          new MessageMedia(mime, imageBuffer.toString('base64'), `instagram-${profile.username}.${extension}`),
          { caption }
        );
        return;
      } catch (error) {
        console.error('Instagram profile image error:', error);
      }
    }
    await sendReply(msg, caption);
  } catch (error) {
    console.error('Instagram stalk error:', error);
    await sendReply(msg, `Gagal mengambil profil Instagram: ${error.message}`);
  }
}

function socialUsername(userMessage, command) {
  return userMessage.replace(new RegExp(`^/${command}\\s*`, 'i'), '').trim().replace(/^@/, '');
}

function validSocialUsername(username) {
  return /^[a-zA-Z0-9._-]{1,50}$/.test(username);
}

function socialCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('id-ID');
  if (typeof value !== 'string') return '-';
  const normalized = value.replace(/,/g, '').trim();
  const suffix = normalized.slice(-1).toUpperCase();
  const multiplier = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
  const amount = suffix.match(/[KMB]/) ? normalized.slice(0, -1) : normalized;
  const parsed = Number(amount) * multiplier;
  return Number.isFinite(parsed) ? Math.round(parsed).toLocaleString('id-ID') : '-';
}

async function sendSocialProfileResult(msg, platform, profile) {
  const caption =
    `*STATISTIK ${platform.toUpperCase()}*\n\n` +
    `Username: @${profile.username}\n` +
    `Nama: ${profile.name || '-'}\n` +
    `Deskripsi: ${profile.description || '-'}\n` +
    `Followers: ${socialCount(profile.followers)}\n` +
    `Following: ${socialCount(profile.following)}\n` +
    `Postingan: ${socialCount(profile.posts)}\n` +
    `Status: ${profile.private === true ? 'Privat' : profile.private === false ? 'Publik' : 'Tidak terdeteksi'}`;

  if (profile.image) {
    try {
      const response = await fetch(profile.image, { headers: HTTP_HEADERS });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const mime = (response.headers.get('content-type') || 'image/jpeg').split(';')[0];
      if (!/^image\/(jpeg|png|webp)$/.test(mime)) throw new Error(`Format foto tidak didukung: ${mime}`);
      const extension = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
      await sendReply(
        msg,
        new MessageMedia(mime, Buffer.from(await response.arrayBuffer()).toString('base64'), `${platform}-${profile.username}.${extension}`),
        { caption }
      );
      return;
    } catch (error) {
      console.error(`${platform} profile image error:`, error);
    }
  }
  await sendReply(msg, caption);
}

function parseQuranReference(value) {
  const match = value.trim().match(/^(\d{1,3})(?::|\/|\s+)(\d{1,3})$/);
  if (!match) return null;
  const surah = Number(match[1]);
  const ayah = Number(match[2]);
  return surah >= 1 && surah <= 114 && ayah >= 1 ? { surah, ayah } : null;
}

async function quranRequest(url) {
  const response = await fetch(url, { headers: { ...HTTP_HEADERS, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Layanan Quran mengembalikan HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.code !== 200 || !payload.data) throw new Error('Data Quran tidak ditemukan.');
  return payload.data;
}

async function handleQuranCommand(msg, userMessage, type) {
  const argument = userMessage.replace(/^\/(?:quran|tafsir|infosurah|jadwalshalat)\s*/i, '').trim();
  try {
    if (type === 'quran' || type === 'tafsir') {
      const reference = parseQuranReference(argument);
      if (!reference) {
        await sendReply(msg, `Format: /${type} <surah:ayat>. Contoh: /${type} 2:255`);
        return;
      }
      if (type === 'quran') {
        const data = await quranRequest(
          `https://api.alquran.cloud/v1/ayah/${reference.surah}:${reference.ayah}/editions/quran-uthmani,id.indonesian`
        );
        const arabic = data[0];
        const translation = data[1];
        await sendReply(
          msg,
          `*QS ${arabic.surah.englishName} ${reference.surah}:${reference.ayah}*\n\n` +
          `${arabic.text}\n\n_${translation.text}_`
        );
        return;
      }
      const response = await fetch(
        `https://api.quran.com/api/v4/verses/by_key/${reference.surah}:${reference.ayah}?language=id&words=false&translations=134&tafsirs=169`,
        { headers: { ...HTTP_HEADERS, Accept: 'application/json' } }
      );
      if (!response.ok) throw new Error(`Layanan tafsir mengembalikan HTTP ${response.status}.`);
      const data = await response.json();
      const verse = data.verse;
      const tafsir = verse?.tafsirs?.[0]?.text || verse?.translations?.[0]?.text;
      if (!tafsir) throw new Error('Tafsir ayat tidak tersedia.');
      await sendReply(msg, `*TAFSIR ${verse.verse_key}*\n\n${tafsir.replace(/<[^>]+>/g, '')}`);
      return;
    }
    if (type === 'infosurah') {
      if (!argument) {
        await sendReply(msg, 'Format: /infosurah <nomor atau nama>. Contoh: /infosurah 2');
        return;
      }
      const data = await quranRequest('https://api.alquran.cloud/v1/surah');
      const query = argument.toLowerCase();
      const surah = data.find((item) =>
        String(item.number) === query ||
        item.englishName.toLowerCase() === query ||
        item.name === argument
      );
      if (!surah) throw new Error('Surah tidak ditemukan. Gunakan nomor 1-114 atau nama bahasa Inggrisnya.');
      await sendReply(
        msg,
        `*INFO SURAH ${surah.englishName.toUpperCase()}*\n\n` +
        `Nama Arab: ${surah.name}\n` +
        `Arti: ${surah.englishNameTranslation}\n` +
        `Nomor: ${surah.number}\n` +
        `Jumlah ayat: ${surah.numberOfAyahs}\n` +
        `Tempat turun: ${surah.revelationType === 'Meccan' ? 'Makkah' : 'Madinah'}`
      );
      return;
    }
    const city = argument || '';
    if (!city || !/^[\p{L}\s.'-]{2,60}$/u.test(city)) {
      await sendReply(msg, 'Format: /jadwalshalat <kota>. Contoh: /jadwalshalat Jakarta');
      return;
    }
    const url = new URL('https://api.aladhan.com/v1/timingsByCity');
    url.searchParams.set('city', city);
    url.searchParams.set('country', 'Indonesia');
    url.searchParams.set('method', '20');
    const response = await fetch(url, { headers: HTTP_HEADERS });
    if (!response.ok) throw new Error(`Layanan jadwal salat mengembalikan HTTP ${response.status}.`);
    const payload = await response.json();
    const timings = payload?.data?.timings;
    const date = payload?.data?.date?.readable;
    if (!timings) throw new Error('Jadwal salat untuk kota tersebut tidak ditemukan.');
    await sendReply(
      msg,
      `*JADWAL SALAT ${city.toUpperCase()}*\n${date || ''}\n\n` +
      `Imsak: ${timings.Imsak}\nSubuh: ${timings.Fajr}\nTerbit: ${timings.Sunrise}\n` +
      `Dzuhur: ${timings.Dhuhr}\nAshar: ${timings.Asr}\nMaghrib: ${timings.Maghrib}\nIsya: ${timings.Isha}`
    );
  } catch (error) {
    console.error(`Islamic command ${type} error:`, error);
    await sendReply(msg, `Gagal mengambil data ${type}: ${error.message}`);
  }
}

async function fetchTikTokProfile(username) {
  const response = await fetch(
    `https://www.tiktok.com/api/user/detail/?unique_id=${encodeURIComponent(username)}`,
    { headers: { ...HTTP_HEADERS, 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.tiktok.com/' } }
  );
  if (!response.ok) throw new Error(`TikTok mengembalikan HTTP ${response.status}.`);
  const payload = await response.json().catch(() => null);
  const user = payload?.userInfo?.user;
  const stats = payload?.userInfo?.stats;
  if (user && stats) {
    return {
      username: user.uniqueId || username,
      name: user.nickname,
      description: user.signature,
      followers: stats.followerCount,
      following: stats.followingCount,
      posts: stats.videoCount,
      private: user.privateAccount,
      image: user.avatarLarger || user.avatarMedium || user.avatarThumb,
    };
  }
  const page = await fetch(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
    headers: { ...HTTP_HEADERS, 'User-Agent': 'Mozilla/5.0' },
  });
  if (!page.ok) throw new Error(`TikTok mengembalikan HTTP ${page.status}.`);
  const html = await page.text();
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const image = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1];
  if (!title && !image) {
    return {
      username,
      name: '',
      description: 'Statistik TikTok dibatasi oleh server TikTok.',
      followers: null,
      following: null,
      posts: null,
      private: null,
      image: null,
    };
  }
  return {
    username,
    name: title?.replace(/\s*\|\s*TikTok.*$/i, '').trim() || username,
    description: 'Statistik TikTok tidak tersedia dari metadata publik.',
    followers: null,
    following: null,
    posts: null,
    private: null,
    image: image?.replace(/&amp;/g, '&') || null,
  };
}

async function fetchTwitterProfile(username) {
  const url = new URL('https://api.fxtwitter.com/user');
  url.searchParams.set('username', username);
  const response = await fetch(url, {
    headers: HTTP_HEADERS,
  });
  if (!response.ok) {
    const page = await fetch(`https://x.com/${encodeURIComponent(username)}`, {
      headers: { ...HTTP_HEADERS, 'User-Agent': 'Mozilla/5.0' },
    });
    if (!page.ok) {
      throw new Error(`X/Twitter mengembalikan HTTP ${page.status}. Username mungkin tidak ditemukan.`);
    }
    const html = await page.text();
    const description = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]*)"/i)?.[1];
    const image = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]*)"/i)?.[1];
    const following = html.match(
      new RegExp(`href="/${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/following"[^>]*>.*?<span[^>]*>([\\d,.]+[KMB]?)</span>`, 'is')
    )?.[1];
    const followers = html.match(
      new RegExp(`href="/${username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/verified_followers"[^>]*>.*?<span[^>]*>([\\d,.]+[KMB]?)</span>`, 'is')
    )?.[1];
    const posts = html.match(/<meta[^>]+name="twitter:data1"[^>]+content="([^"]+)"/i)?.[1];
    const title = html.match(/<title[^>]*>([^<]*)/i)?.[1]?.replace(/\s+\|\s+X$/, '');
    if (!description && !image) {
      throw new Error('Profil X/Twitter tidak ditemukan atau sedang dibatasi.');
    }
    return {
      username,
      name: title?.replace(/\s+\(@[^)]+\).*$/, '') || username,
      description,
      followers,
      following,
      posts,
      private: null,
      image,
    };
  }
  const payload = await response.json().catch(() => null);
  const user = payload?.user;
  if (!user) throw new Error('Profil X/Twitter tidak ditemukan atau sedang dibatasi.');
  return {
    username: user.screen_name || username,
    name: user.name,
    description: user.description,
    followers: user.followers_count,
    following: user.friends_count,
    posts: user.statuses_count,
    private: user.protected,
    image: user.avatar_url || user.profile_image_url_https,
  };
}

async function handleSocialStalk(msg, userMessage, platform) {
  const command = platform === 'TikTok'
    ? userMessage.match(/^\/ttstalk/i) ? 'ttstalk' : 'tiktokstalk'
    : userMessage.match(/^\/xstalk/i) ? 'xstalk' : 'twitterstalk';
  const username = socialUsername(userMessage, command);
  if (!username || !validSocialUsername(username)) {
    await sendReply(msg, `Format: /${command} <username>. Contoh: /${command} murzeme`);
    return;
  }
  try {
    const profile = platform === 'TikTok'
      ? await fetchTikTokProfile(username)
      : await fetchTwitterProfile(username);
    await sendSocialProfileResult(msg, platform, profile);
  } catch (error) {
    console.error(`${platform} stalk error:`, error);
    await sendReply(msg, `Gagal mengambil profil ${platform}: ${error.message}`);
  }
}

function twitterStatusParts(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    if (hostname !== 'x.com' && hostname !== 'twitter.com' && !hostname.endsWith('.x.com') && !hostname.endsWith('.twitter.com')) {
      return null;
    }
    const match = url.pathname.match(/^\/(?:([A-Za-z0-9_]+)|i\/web)\/status(?:es)?\/(\d+)/);
    return match ? { username: match[1] || 'i', id: match[2] } : null;
  } catch {
    return null;
  }
}

// fxtwitter lebih andal daripada yt-dlp untuk tweet publik karena tidak butuh login
async function fetchTwitterVideoUrl({ username, id }) {
  const response = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(username)}/status/${id}`, {
    headers: HTTP_HEADERS,
    signal: AbortSignal.timeout(20000),
  });
  if (response.status === 404) {
    throw new Error(
      'Tweet tidak ditemukan. Kemungkinan sudah dihapus, akunnya privat, atau dibatasi (konten sensitif/umur butuh login).'
    );
  }
  if (!response.ok) throw new Error(`Layanan tweet mengembalikan HTTP ${response.status}`);
  const json = await response.json();
  const tweet = json.tweet;
  if (!tweet) throw new Error('Data tweet tidak tersedia.');
  const videos = [
    ...(tweet.media?.videos || []),
    ...(tweet.quote?.media?.videos || []),
  ].filter((video) => video?.url);
  if (videos.length === 0) {
    throw new Error('Tweet ini tidak berisi video atau GIF yang bisa diunduh.');
  }
  videos.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
  return videos[0].url;
}

async function downloadTwitterVideoFile(videoUrl, filePath) {
  const response = await fetch(videoUrl, {
    headers: HTTP_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Unduh video HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_VIDEO_BYTES) throw new Error('Video lebih besar dari batas WhatsApp 64 MB');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) throw new Error('File video kosong');
  if (buffer.length > MAX_VIDEO_BYTES) throw new Error('Video lebih besar dari batas WhatsApp 64 MB');
  await writeFile(filePath, buffer);
}

async function sendDownloadedImage(msg, buffer, mime) {
  const extension = imageExtensionForMime(mime);
  if (!extension) throw new Error(`Format gambar tidak didukung: ${mime || 'tidak diketahui'}`);
  const media = new MessageMedia(mime, buffer.toString('base64'), `gambar.${extension}`);
  try {
    await client.sendMessage(msg.from, media, { caption: 'Nih gambarnya, Tuan.' });
  } catch (error) {
    console.error('Pengiriman gambar sebagai media gagal:', error);
    try {
      await client.sendMessage(msg.from, media, {
        caption: 'Nih gambarnya, Tuan.',
        sendMediaAsDocument: true,
      });
    } catch (documentError) {
      throw new Error(
        `Gambar berhasil diunduh, tetapi gagal dikirim ke WhatsApp. Media: ${
          error.message || 'alasan tidak diketahui'
        }. Dokumen: ${documentError.message || 'alasan tidak diketahui'}`
      );
    }
  }
}

async function fetchDirectImage(url) {
  let currentUrl = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(currentUrl, {
      headers: HTTP_HEADERS,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location || redirects === 5) throw new Error('Tautan gambar terlalu banyak mengalihkan alamat.');
      const nextUrl = new URL(location, currentUrl).href;
      if (!normalizeDownloadUrl(nextUrl)) throw new Error('Pengalihan tautan gambar tidak aman.');
      await response.body?.cancel();
      currentUrl = nextUrl;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (!imageExtensionForMime(mime)) {
      await response.body?.cancel();
      return null;
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_DOWNLOAD_IMAGE_BYTES) throw new Error('Gambar lebih besar dari batas WhatsApp 64 MB.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Isi gambar tidak tersedia.');
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_DOWNLOAD_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error('Gambar lebih besar dari batas WhatsApp 64 MB.');
      }
      chunks.push(Buffer.from(value));
    }
    const buffer = Buffer.concat(chunks, size);
    if (buffer.length === 0) throw new Error('File gambar kosong.');
    if (buffer.length > MAX_DOWNLOAD_IMAGE_BYTES) throw new Error('Gambar lebih besar dari batas WhatsApp 64 MB.');
    return { buffer, mime };
  }
  throw new Error('Tautan gambar tidak bisa diikuti.');
}

async function downloadSocialMedia(msg, input) {
  const originalUrl = normalizeDownloadUrl(input);
  if (!originalUrl) {
    await sendReply(
      msg,
      'Kirim tautan HTTPS publik yang valid dari situs media yang didukung, Tuan.'
    );
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'wavid-'));
  try {
    if (isDirectImageUrl(originalUrl)) {
      const directImage = await fetchDirectImage(originalUrl);
      if (directImage) {
        await sendDownloadedImage(msg, directImage.buffer, directImage.mime);
        return;
      }
    }

    const url = await resolveSocialVideoUrl(originalUrl);
    const outputPath = path.join(dir, 'video.%(ext)s');
    let downloaded = false;
    let downloadError = null;
    let twitterError = null;
    const twitterParts = twitterStatusParts(url);
    if (twitterParts) {
      try {
        const videoUrl = await fetchTwitterVideoUrl(twitterParts);
        await downloadTwitterVideoFile(videoUrl, path.join(dir, 'video.mp4'));
        downloaded = true;
      } catch (error) {
        twitterError = error;
        console.error('Download Twitter via fxtwitter gagal, mencoba yt-dlp:', error.message);
      }
    }
    if (!downloaded) try {
      const ytDlpArgs = [
        '--js-runtimes', `node:${process.execPath}`,
        '--remote-components', 'ejs:github',
        '--no-playlist',
        '--restrict-filenames',
        '--max-filesize', `${MAX_VIDEO_BYTES}`,
        '-f', 'best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '-o', outputPath,
      ];
      try {
        await stat(YTDLP_COOKIES_PATH);
        ytDlpArgs.push('--cookies', YTDLP_COOKIES_PATH);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      ytDlpArgs.push(url);
      await runYtDlp([
        ...ytDlpArgs,
      ]);
    } catch (error) {
      downloadError = error;
    }

    let files = await readdir(dir);
    const downloadedImage = files.find((name) => /\.(jpe?g|png|webp|gif)$/i.test(name));
    if (downloadedImage) {
      const imagePath = path.join(dir, downloadedImage);
      const info = await stat(imagePath);
      if (info.size > MAX_DOWNLOAD_IMAGE_BYTES) throw new Error('Gambar lebih besar dari batas WhatsApp 64 MB.');
      const lowerName = downloadedImage.toLowerCase();
      const mime = lowerName.endsWith('.png') ? 'image/png'
        : lowerName.endsWith('.webp') ? 'image/webp'
          : lowerName.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
      await sendDownloadedImage(msg, await readFile(imagePath), mime);
      return;
    }

    const videoName = files.find((name) => /\.(mp4|webm|mov|mkv)$/i.test(name));
    if (!videoName) {
      try {
        const thumbnailPath = path.join(dir, 'thumbnail.%(ext)s');
        const thumbnailArgs = [
          '--js-runtimes', `node:${process.execPath}`,
          '--remote-components', 'ejs:github',
          '--no-playlist',
          '--skip-download',
          '--write-thumbnail',
          '--convert-thumbnails', 'jpg',
          '-o', thumbnailPath,
        ];
        try {
          await stat(YTDLP_COOKIES_PATH);
          thumbnailArgs.push('--cookies', YTDLP_COOKIES_PATH);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        thumbnailArgs.push(url);
        await runYtDlp(thumbnailArgs);
        files = await readdir(dir);
        const thumbnailName = files.find((name) => /^thumbnail\.(jpe?g|png|webp)$/i.test(name));
        if (!thumbnailName) throw new Error('Situs tidak menyediakan gambar untuk tautan ini.');
        const imagePath = path.join(dir, thumbnailName);
        const info = await stat(imagePath);
        if (info.size > MAX_DOWNLOAD_IMAGE_BYTES) throw new Error('Gambar lebih besar dari batas WhatsApp 64 MB.');
        const mime = thumbnailName.toLowerCase().endsWith('.png') ? 'image/png'
          : thumbnailName.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
        await sendDownloadedImage(msg, await readFile(imagePath), mime);
        return;
      } catch (imageError) {
        if (/Sign in to confirm|cookies|no supported javascript runtime|impersonat/i.test(imageError.message || '')) {
          throw new Error(
            'Situs meminta verifikasi/login. Tambahkan cookie Netscape di data/yt-cookies.txt pada VPS, lalu coba lagi.'
          );
        }
        if (twitterError) throw twitterError;
        if (downloadError?.code === 'ENOENT') {
          throw new Error('yt-dlp belum terpasang. Jalankan npm install ulang.');
        }
        if (/Sign in to confirm|cookies|no supported javascript runtime|impersonat/i.test(downloadError?.message || '')) {
          throw new Error(
            'Situs meminta verifikasi/login. Tambahkan cookie Netscape di data/yt-cookies.txt pada VPS, lalu coba lagi.'
          );
        }
        if (downloadError) {
          throw new Error(`Media tidak ditemukan. yt-dlp: ${downloadError.message || 'alasan tidak diketahui'}.`);
        }
        throw imageError;
      }
    }
    const videoPath = path.join(dir, videoName);
    const info = await stat(videoPath);
    if (info.size > MAX_VIDEO_BYTES) {
      throw new Error('Video lebih besar dari batas WhatsApp 64 MB');
    }

    const normalizedPath = path.join(dir, 'video-whatsapp.mp4');
    await runFfmpeg([
      '-y', '-i', videoPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart',
      normalizedPath,
    ]);
    const normalizedInfo = await stat(normalizedPath);
    if (normalizedInfo.size > MAX_VIDEO_BYTES) {
      throw new Error('Video setelah dikonversi lebih besar dari batas WhatsApp 64 MB');
    }

    const media = new MessageMedia(
      'video/mp4',
      (await readFile(normalizedPath)).toString('base64'),
      'video.mp4'
    );
    try {
      await client.sendMessage(msg.from, media, { caption: 'Nih videonya, Tuan.' });
    } catch (error) {
      console.error('Pengiriman video sebagai media gagal:', error);
      try {
        await client.sendMessage(msg.from, media, {
          caption: 'Nih videonya, Tuan.',
          sendMediaAsDocument: true,
        });
      } catch (documentError) {
        throw new Error(
          `Video sudah berhasil diunduh, tetapi gagal dikirim ke WhatsApp. Media: ${
            error.message || 'alasan tidak diketahui'
          }. Dokumen: ${documentError.message || 'alasan tidak diketahui'}`
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ====== WhatsApp client ======
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.log('SCAN QR CODE INI DI WHATSAPP ANDA:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log(`Bot siap dipakai (${enabledChatProviderLabel()}). Model chat: ${MODELS.join(', ')}`);
  console.log(`Voice note: ${VOICE_ENABLED ? ASR_MODELS.join(', ') : 'nonaktif'}`);
  console.log(
    `Grup: ${REPLY_IN_GROUPS ? 'membalas semua pesan' : 'membalas saat dipanggil dengan ji/aji atau di-tag'}`
  );
  setTimeout(() => syncKnownChats().catch((error) => {
    console.error('Sinkronisasi chat broadcast gagal:', error);
  }), 5000);
});

client.on('group_join', (notification) => {
  handleWelcomeNotification(notification).catch((error) => {
    console.error('Gagal mengirim welcome:', error);
  });
});

client.on('disconnected', (reason) => {
  console.error(`WhatsApp terputus: ${reason || 'alasan tidak diketahui'}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 1000);
});

client.on('message', async (msg) => {
  if (msg.fromMe) return;
  const messageId = msg.id?._serialized;
  if (messageId) {
    const now = Date.now();
    for (const [processedId, processedAt] of processedMessageIds) {
      if (now - processedAt > MESSAGE_DEDUPLICATION_WINDOW_MS) {
        processedMessageIds.delete(processedId);
      }
    }
    if (processedMessageIds.has(messageId)) {
      console.warn(`[MESSAGE] duplicate ignored id=${messageId}`);
      return;
    }
    processedMessageIds.set(messageId, now);
  }
  if (msg.from?.endsWith('@c.us') || msg.from?.endsWith('@g.us')) knownChatIds.add(msg.from);

  const isGroup = msg.from.endsWith('@g.us');

  const chatId = msg.from;
  let userMessage = normalizeCommandPrefix(msg.body?.trim());
  const commandMatch = userMessage?.match(/^\/\S+/);
  const commandStartedAt = commandMatch ? Date.now() : null;
  if (commandMatch) {
    recordCommandUsage(commandMatch[0]);
    console.log(
      `[COMMAND] ${commandMatch[0]} from=${chatId}${msg.hasMedia ? ` media=${msg.type}` : ''} text=${userMessage}`
    );
    try {
      await sendReply(msg, '⏳ Loading...');
    } catch (error) {
      console.error(`Gagal mengirim status loading untuk ${commandMatch[0]}:`, error.message);
    }
  }
  const senderKey = senderChatIdentity(msg);
  if (!commandMatch && afkUsers.has(senderKey)) {
    afkUsers.delete(senderKey);
    await sendReply(msg, 'Status AFK dinonaktifkan karena kamu sudah kembali.');
  }
  if (!commandMatch) await handleMentionedAfk(msg);
  if (isGroup && userMessage && !commandMatch && /(?:https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/)/i.test(userMessage)) {
    const chat = await msg.getChat();
    if (groupSetting(chatId).antilink && !await isGroupAdmin(msg, chat)) {
      try {
        await msg.delete(true);
        await sendReply(msg, 'Link di grup ini dibatasi oleh admin.');
      } catch (error) {
        console.error('Gagal menghapus link:', error);
        await sendReply(msg, 'Antilink aktif, tetapi bot perlu menjadi admin agar bisa menghapus pesan.');
      }
      return;
    }
  }
  const logCommandResult = (status) => {
    if (commandMatch) {
      console.log(
        `[COMMAND] ${commandMatch[0]} status=${status} elapsed=${Date.now() - commandStartedAt}ms`
      );
    }
  };
  let fromVoice = false;
  let sourceMessage = msg;
  const fromImage = msg.hasMedia && (msg.type === 'image' || msg.type === 'sticker');
  const fromVideo = msg.hasMedia && isVideoMediaMessage(msg);
  let fromDocument =
    msg.hasMedia &&
    !fromImage &&
    !fromVideo &&
    msg.type !== 'ptt' &&
    msg.type !== 'audio';

  if (
    !msg.hasMedia &&
    /^\/(?:img|sgif|pdf|ocr|translateimg|topdf|wordtopdf|docxtopdf|pdftoword|pdftodocx)(?:\s|$)/i.test(userMessage || '') &&
    msg.hasQuotedMsg
  ) {
    try {
      const quotedMessage = await msg.getQuotedMessage();
      if (quotedMessage?.hasMedia) {
        sourceMessage = quotedMessage;
        fromDocument = !['image', 'sticker', 'video', 'ptt', 'audio'].includes(quotedMessage.type) &&
          !isVideoMediaMessage(quotedMessage);
        if (isVideoMediaMessage(quotedMessage)) {
          fromDocument = false;
        }
      }
    } catch (error) {
      console.error('Gagal mengambil file PDF yang dibalas:', error);
    }
  }

  // Voice note -> teks
  if (msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio')) {
    if (!VOICE_ENABLED) return;
    try {
      userMessage = await voiceToText(msg);
      fromVoice = true;
      if (SHOW_TRANSCRIPT) await sendReply(msg, `🎤 ${userMessage}`);
    } catch (error) {
      console.error('Voice note error:', error);
      const hint = error.code === 'ENOENT' ? ' (ffmpeg belum terpasang di server)' : '';
      await sendReply(msg, `Maaf, voice note tidak bisa diproses${hint}. Coba kirim sebagai teks.`);
      return;
    }
  }

  // Media tidak dianalisis otomatis. Tambahkan caption/perintah jika ingin bot merespons.
  if ((fromImage || fromVideo) && !userMessage) return;
  if (fromDocument && !userMessage) {
    userMessage = 'Baca file ini, jelaskan isinya, dan bantu saya memahami atau mengerjakannya.';
  }
  const isStickerCommand = /^\/(?:stiker|s)$/i.test(userMessage || '');
  const isAnimatedStickerCommand = /^\/sgif$/i.test(userMessage || '');
  const isImageFromStickerCommand = /^\/img$/i.test(userMessage || '');
  const isImageCommand = /^\/gambar(?:\s|$)/i.test(userMessage || '');
  const isMemoryCommand = /^\/(?:ingat|memori|hapusmemori)(?:\s|$)/i.test(userMessage || '');
  const isAdultConsentCommand = /^\/18plus$/i.test(userMessage || '');
  const isVideoCommand = /^\/(?:download|dl|ytmp4|ig|fb|twitter|tiktok|video|getvideo)(?:\s|$)/i.test(userMessage || '');
  const isInstagramStalkCommand = /^\/igstalk(?:\s|$)/i.test(userMessage || '');
  const isTikTokStalkCommand = /^\/(?:tiktokstalk|ttstalk)(?:\s|$)/i.test(userMessage || '');
  const isTwitterStalkCommand = /^\/(?:twitterstalk|xstalk)(?:\s|$)/i.test(userMessage || '');
  const isWhatsAppStalkCommand = /^\/stalk(?:\s|$)/i.test(userMessage || '');
  const isWeatherCommand = /^\/cuaca(?:\s|$)/i.test(userMessage || '');
  const isTranslateCommand = /^\/translate(?:\s|$)/i.test(userMessage || '');
  const isQuoteCommand = /^\/quote(?:\s|$)/i.test(userMessage || '');
  const isPhubCommand = /^\/phub(?:\s|$)/i.test(userMessage || '');
  const isQrCommand = /^\/qr(?:\s|$)/i.test(userMessage || '');
  const isStatsCommand = /^\/stats$/i.test(userMessage || '');
  const isTtsCommand = /^\/tts(?:\s|$)/i.test(userMessage || '');
  const isOcrCommand = /^\/ocr$/i.test(userMessage || '');
  const isTranslateImageCommand = /^\/translateimg$/i.test(userMessage || '');
  const isReminderListCommand = /^\/remindlist$/i.test(userMessage || '');
  const isCancelReminderCommand = /^\/cancelremind(?:\s|$)/i.test(userMessage || '');
  const isDetectLanguageCommand = /^\/detectlang(?:\s|$)/i.test(userMessage || '');
  const isShortCommand = /^\/short(?:\s|$)/i.test(userMessage || '');
  const isFilmCommand = /^\/film(?:\s|$)/i.test(userMessage || '');
  const isWikiCommand = /^\/wiki(?:\s|$)/i.test(userMessage || '');
  const isDefineCommand = /^\/define(?:\s|$)/i.test(userMessage || '');
  const isResiCommand = /^\/cekresi(?:\s|$)/i.test(userMessage || '');
  const isMotivationCommand = /^\/motivasi$/i.test(userMessage || '');
  const isReminderCommand = /^\/remind(?:\s|$)/i.test(userMessage || '');
  const isPollCommand = /^\/poll(?:\s|$)/i.test(userMessage || '');
  const isVoteCommand = /^\/vote(?:\s|$)/i.test(userMessage || '');
  const isPollListCommand = /^\/polls$/i.test(userMessage || '');
  const isPollResultCommand = /^\/pollresult(?:\s|$)/i.test(userMessage || '');
  const isPollCloseCommand = /^\/pollclose(?:\s|$)/i.test(userMessage || '');
  const isAfkCommand = /^\/afk(?:\s|$)/i.test(userMessage || '');
  const isAdminMenuCommand = /^\/menuadmin$/i.test(userMessage || '');
  const isWelcomeCommand = /^\/welcome(?:\s|$)/i.test(userMessage || '');
  const isAntilinkCommand = /^\/antilink(?:\s|$)/i.test(userMessage || '');
  const isIslamicCommand = /^\/(?:quran|infosurah|tafsir|jadwalshalat)(?:\s|$)/i.test(userMessage || '');
  const isPdfCommand = /^\/pdf(?:\s|$)/i.test(userMessage || '');
  const isMenuCommand = /^\/(?:menu|help)$/i.test(userMessage || '');
  const conversionMatch = userMessage?.match(/^\/(topdf|wordtopdf|docxtopdf|pdftoword|pdftodocx)(?:\s|$)/i);
  const conversionTarget = conversionMatch
    ? (['topdf', 'wordtopdf', 'docxtopdf'].includes(conversionMatch[1].toLowerCase()) ? 'pdf' : 'docx')
    : null;
  const isConversionCommand = Boolean(conversionTarget);
  if (isPdfCommand) {
    if (!fromDocument) {
      await sendReply(msg, 'Command `/pdf` harus dikirim bersama file PDF atau membalas pesan PDF.');
      return;
    }
    userMessage = userMessage.replace(/^\/pdf\s*/i, '').trim() ||
      'Baca PDF ini, rangkum isinya, dan jelaskan bagian pentingnya.';
  }
  if (await handleTagAllCommand(msg, userMessage || '')) {
    logCommandResult('handled');
    return;
  }
  if (await handleOwnerCommand(msg, userMessage || '')) {
    logCommandResult('handled');
    return;
  }
  if (
    isGroup &&
    !isStickerCommand &&
    !isAnimatedStickerCommand &&
    !isImageFromStickerCommand &&
    !isImageCommand &&
    !isMemoryCommand &&
    !isAdultConsentCommand &&
    !isVideoCommand &&
    !isInstagramStalkCommand &&
    !isTikTokStalkCommand &&
    !isTwitterStalkCommand &&
    !isWhatsAppStalkCommand &&
    !isWeatherCommand &&
    !isTranslateCommand &&
    !isQuoteCommand &&
    !isPhubCommand &&
    !isQrCommand &&
    !isStatsCommand &&
    !isTtsCommand &&
    !isOcrCommand &&
    !isTranslateImageCommand &&
    !isReminderListCommand &&
    !isCancelReminderCommand &&
    !isDetectLanguageCommand &&
    !isShortCommand &&
    !isFilmCommand &&
    !isWikiCommand &&
    !isDefineCommand &&
    !isResiCommand &&
    !isMotivationCommand &&
    !isReminderCommand &&
    !isPollCommand &&
    !isVoteCommand &&
    !isPollListCommand &&
    !isPollResultCommand &&
    !isPollCloseCommand &&
    !isAfkCommand &&
    !isAdminMenuCommand &&
    !isWelcomeCommand &&
    !isAntilinkCommand &&
    !isIslamicCommand &&
    !isPdfCommand &&
    !isConversionCommand &&
    !isMenuCommand &&
    !fromDocument &&
    !(await shouldReplyInGroup(msg, userMessage || ''))
  ) return;
  if (!userMessage && isGroup) userMessage = 'Kamu dipanggil di grup.';
  if (!userMessage) return;

  // Perintah khusus (hanya dari pesan teks)
  if (!fromVoice) {
    if (isPhubCommand) {
      await handlePhubCommand(msg, userMessage);
      logCommandResult('handled');
      return;
    }
    if (isAdultConsentCommand) {
      adultConsents.add(chatId);
      await saveAdultConsents();
      await sendReply(
        msg,
        'Konfirmasi umur disimpan. Mode dewasa hanya untuk edukasi kesehatan seksual dan relasi antar-orang dewasa, bukan pornografi atau deskripsi seksual eksplisit.'
      );
      return;
    }
    if (isStickerCommand) {
      try {
        await createSticker(msg);
      } catch (error) {
        console.error('Sticker error:', error);
        const hint = error.code === 'ENOENT' ? ' Pastikan ffmpeg sudah terpasang.' : '';
        const detail = error.message ? ` (${error.message})` : '';
        await sendReply(msg, `Gagal membuat stiker${detail}.${hint}`);
      }
      return;
    }
    if (isAnimatedStickerCommand) {
      try {
        await createAnimatedSticker(msg, sourceMessage);
      } catch (error) {
        console.error('Animated sticker error:', error);
        const hint = error.code === 'ENOENT' ? ' Pastikan ffmpeg sudah terpasang.' : '';
        const detail = error.message ? ` (${error.message})` : '';
        await sendReply(msg, `Gagal membuat stiker animasi${detail}.${hint}`);
      }
      return;
    }
    if (isImageFromStickerCommand) {
      try {
        await createImageFromSticker(msg, sourceMessage);
      } catch (error) {
        console.error('Sticker to image error:', error);
        const hint = error.code === 'ENOENT' ? ' Pastikan ffmpeg sudah terpasang.' : '';
        await sendReply(msg, `Gagal mengubah stiker menjadi gambar${hint}: ${error.message}`);
      }
      return;
    }
    if (isImageCommand && !extractImageQuery(userMessage)) {
      await sendReply(msg, 'Format: /gambar <objek>. Contoh: /gambar kucing');
      return;
    }
    if (isVideoCommand) {
      const url = userMessage.replace(/^\/(?:download|dl|ytmp4|ig|fb|twitter|tiktok|video|getvideo)\s*/i, '').trim();
      if (!url) {
        await sendReply(msg, 'Format: /download <tautan HTTPS media>, Tuan.');
        return;
      }
      try {
        await sendReply(msg, '⏳ Media lagi diunduh, Tuan...');
        await downloadSocialMedia(msg, url);
      } catch (error) {
        console.error('Media download error:', error);
        await proposeRepair('media download', error);
        await sendReply(msg, `Download media gagal, Tuan: ${error.message}`);
      }
      return;
    }
    if (isInstagramStalkCommand) {
      await handleInstagramStalk(msg, userMessage);
      return;
    }
    if (isTikTokStalkCommand) {
      await handleSocialStalk(msg, userMessage, 'TikTok');
      return;
    }
    if (isTwitterStalkCommand) {
      await handleSocialStalk(msg, userMessage, 'Twitter');
      return;
    }
    if (isWhatsAppStalkCommand) {
      await handleWhatsAppStalk(msg, userMessage);
      return;
    }
    if (isWeatherCommand) {
      await handleWeatherCommand(msg, userMessage);
      return;
    }
    if (isTranslateCommand) {
      await handleTranslateCommand(msg, userMessage);
      return;
    }
    if (isQuoteCommand) {
      try {
        await handleQuoteCommand(msg, userMessage);
      } catch (error) {
        console.error('Quote command error:', error);
        await sendReply(msg, `Gagal membuat quote: ${error.message}`);
      }
      return;
    }
    if (isQrCommand) {
      try {
        await handleQrCommand(msg, userMessage);
      } catch (error) {
        console.error('QR command error:', error);
        await sendReply(msg, `Gagal membuat QR code: ${error.message}`);
      }
      return;
    }
    if (isStatsCommand) {
      await handleStatsCommand(msg);
      return;
    }
    if (isTtsCommand) {
      try {
        await handleTtsCommand(msg, userMessage);
      } catch (error) {
        console.error('TTS command error:', error);
        await sendReply(msg, `Gagal membuat voice note: ${error.message}`);
      }
      return;
    }
    if (isOcrCommand) {
      await handleOcrCommand(msg, sourceMessage);
      return;
    }
    if (isTranslateImageCommand) {
      await handleTranslateImageCommand(msg, sourceMessage);
      return;
    }
    if (isReminderListCommand) {
      await handleReminderListCommand(msg);
      return;
    }
    if (isCancelReminderCommand) {
      await handleCancelReminderCommand(msg, userMessage);
      return;
    }
    if (isDetectLanguageCommand) {
      await handleDetectLanguageCommand(msg, userMessage);
      return;
    }
    if (isShortCommand) {
      await handleShortCommand(msg, userMessage);
      return;
    }
    if (isFilmCommand) {
      await handleFilmCommand(msg, userMessage);
      return;
    }
    if (isWikiCommand) {
      await handleWikiCommand(msg, userMessage);
      return;
    }
    if (isDefineCommand) {
      await handleDefineCommand(msg, userMessage);
      return;
    }
    if (isResiCommand) {
      await handleResiCommand(msg, userMessage);
      return;
    }
    if (isMotivationCommand) {
      try {
        await handleMotivationCommand(msg);
      } catch (error) {
        console.error('Motivation command error:', error);
        await sendReply(msg, `Gagal membuat motivasi: ${error.message}`);
      }
      return;
    }
    if (isReminderCommand) {
      await handleReminderCommand(msg, userMessage);
      return;
    }
    if (isPollCommand) {
      await handlePollCommand(msg, userMessage);
      return;
    }
    if (isVoteCommand) {
      await handleVoteCommand(msg, userMessage);
      return;
    }
    if (isPollListCommand) {
      await handlePollListCommand(msg);
      return;
    }
    if (isPollResultCommand) {
      await handlePollResultCommand(msg, userMessage);
      return;
    }
    if (isPollCloseCommand) {
      await handlePollCloseCommand(msg, userMessage);
      return;
    }
    if (isAfkCommand) {
      await handleAfkCommand(msg, userMessage);
      return;
    }
    if (isAdminMenuCommand) {
      await handleAdminMenuCommand(msg);
      return;
    }
    if (isWelcomeCommand) {
      await handleGroupSettingsCommand(msg, userMessage, 'welcome');
      return;
    }
    if (isAntilinkCommand) {
      await handleGroupSettingsCommand(msg, userMessage, 'antilink');
      return;
    }
    if (isIslamicCommand) {
      const command = userMessage.match(/^\/(\w+)/i)[1].toLowerCase();
      await handleQuranCommand(msg, userMessage, command);
      return;
    }
    if (isPdfCommand) {
      const media = await downloadMedia(sourceMessage).catch((error) => {
        console.error('PDF download error:', error);
        return null;
      });
      if (!media || (
        media.mimetype !== 'application/pdf' &&
        !/\.pdf$/i.test(media.filename || '') &&
        !isWordDocument(media)
      )) {
        await sendReply(msg, 'File ini bukan PDF/DOCX atau tidak bisa dibaca. Kirim file `.pdf` atau `.docx`.');
        return;
      }
    }
    if (isConversionCommand) {
      try {
        await sendReply(msg, '⏳ Dokumen sedang dikonversi, Tuan...');
        await convertDocumentMessage(msg, sourceMessage, conversionTarget);
      } catch (error) {
        console.error('Document conversion error:', error);
        await proposeRepair('document conversion', error);
        await sendReply(msg, `Konversi dokumen gagal, Tuan: ${error.message}`);
      }
      return;
    }
    if (/^\/ingat\s+/i.test(userMessage)) {
      const value = userMessage.replace(/^\/ingat\s+/i, '').trim();
      if (value.length > 240) {
        await sendReply(msg, 'Memorinya kepanjangan, Tuan. Maksimal 240 karakter.');
      } else if (await remember(chatId, value)) {
        chatHistories.set(chatId, newHistory(chatId));
        await sendReply(msg, 'Siap, Tuan. Gue ingat itu buat chat ini.');
      } else {
        await sendReply(msg, 'Tulis yang mau gue ingat setelah command /ingat, Tuan.');
      }
      return;
    }
    if (/^\/memori$/i.test(userMessage)) {
      const entries = memories.get(chatId) || [];
      await sendReply(
        msg,
        entries.length
          ? `Memori chat ini:\n${entries.map((entry, index) => `${index + 1}. ${entry}`).join('\n')}`
          : 'Belum ada memori yang tersimpan di chat ini, Tuan.'
      );
      return;
    }
    if (/^\/hapusmemori$/i.test(userMessage)) {
      memories.delete(chatId);
      await saveMemories();
      chatHistories.set(chatId, newHistory(chatId));
      await sendReply(msg, 'Semua memori chat ini sudah gue hapus, Tuan.');
      return;
    }
    if (userMessage === '/reset') {
      chatHistories.set(chatId, newHistory(chatId));
      await sendReply(msg, 'Riwayat percakapan sudah dihapus.');
      return;
    }
    if (isMenuCommand) {
      await sendReply(msg, menuText());
      return;
    }
    if (userMessage === '/model') {
      const selected = chatModels.get(chatId);
      const aktif = Array.isArray(selected) ? selected : selected ? [selected] : [MODELS[0]];
      const daftar = MODELS
        .map((m, i) => `${i + 1}. ${m}${aktif.includes(m) ? ' (aktif)' : ''}`)
        .join('\n');
      await sendReply(
        msg,
        `Provider aktif: ${enabledChatProviderLabel()}\nModel tersedia:\n${daftar}\n\n` +
        'Ganti model: /model <nama atau nomor>, <nama atau nomor>, ...\n' +
        'Owner: /model dashscope | /model groq | /model both'
      );
      return;
    }
    if (userMessage.startsWith('/model ')) {
      const pilihan = userMessage
        .slice(7)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      const targets = [...new Set(pilihan.map((item) => {
        const index = Number.parseInt(item, 10);
        return /^\d+$/.test(item) && MODELS[index - 1]
          ? MODELS[index - 1]
          : MODELS.find((model) => model === item);
      }).filter(Boolean))];
      if (!targets.length || targets.length !== pilihan.length) {
        await sendReply(
          msg,
          'Ada model yang tidak ditemukan. Ketik /model untuk melihat daftar model yang valid.'
        );
        return;
      }
      chatModels.set(chatId, targets);
      await sendReply(msg, `Model aktif: ${targets.join(', ')}.`);
      return;
    }
  }

  if (!adultConsents.has(chatId) && containsAdultTopic(userMessage)) {
    await sendReply(
      msg,
      'Topik ini masuk mode dewasa. Kalau umurmu sudah 18 tahun atau lebih, kirim `/18plus` dulu. Mode ini hanya untuk edukasi kesehatan seksual dan relasi dewasa, bukan pornografi.'
    );
    return;
  }

  // Permintaan gambar eksplisit agar teks/kode biasa tidak salah terdeteksi
  const imageQuery = extractImageQuery(userMessage);
  if (imageQuery) {
    try {
      const sent = await sendImages(msg, imageQuery);
      if (sent > 0) {
        if (!chatHistories.has(chatId)) chatHistories.set(chatId, newHistory(chatId));
        chatHistories.get(chatId).push(
          { role: 'user', content: userMessage },
          { role: 'assistant', content: `[Bot mengirim ${sent} gambar tentang: ${imageQuery}]` }
        );
        trimHistory(chatId);
      }
    } catch (error) {
      console.error('Image error:', error);
      await proposeRepair('image search', error);
      await sendReply(msg, 'Maaf, pencarian gambar lagi bermasalah. Coba lagi nanti.');
    }
    return;
  }

  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, newHistory(chatId));
  }

  const history = chatHistories.get(chatId);
  const learned = automaticMemory(userMessage);
  if (learned && await remember(chatId, learned)) {
    history[0] = { role: 'system', content: systemPromptFor(chatId, userMessage) };
  }
  history[0] = { role: 'system', content: systemPromptFor(chatId, userMessage) };
  let userContent = userMessage;
  if (fromImage) {
    try {
      userContent = await imageMessageContent(
        msg,
        userMessage || 'Baca gambar ini dan jawab atau jelaskan isinya.'
      );
    } catch (error) {
      console.error('Image download error:', error);
      await sendReply(msg, 'Gambarnya tidak bisa dibaca. Coba kirim ulang dengan format JPG, PNG, atau WEBP.');
      return;
    }
  } else if (fromVideo) {
    try {
      userContent = await videoMessageContent(
        msg,
        userMessage || 'Jelaskan isi video ini.'
      );
    } catch (error) {
      console.error('Video frame error:', error);
      const hint = error.code === 'ENOENT' ? ' Pastikan ffmpeg sudah terpasang di server.' : '';
      await sendReply(msg, `Videonya tidak bisa dibaca.${hint} Coba kirim ulang videonya.`);
      return;
    }
  } else if (fromDocument) {
    try {
      userContent = await documentMessageContent(
        sourceMessage,
        userMessage || 'Baca file ini dan jelaskan isinya.'
      );
    } catch (error) {
      console.error('Document error:', error);
      await proposeRepair('document processing', error);
      await sendReply(msg, `File belum bisa diproses, Tuan: ${error.message}`);
      return;
    }
  }
  history.push({ role: 'user', content: userContent });
  trimHistory(chatId);

  let replyAnchor = null;
  try {
    replyAnchor = await sendReply(msg, '⏳ Hold on, Lemme think...');
  } catch (error) {
    console.error('Gagal membuat reply bubble awal:', error);
  }

  console.log(
    `Pesan diterima dari ${chatId}${fromVoice ? ' (voice)' : ''}${fromImage ? ` (${msg.type})` : ''}${fromVideo ? ' (video)' : ''}: ${userMessage}`
  );

  let reply;
  let codeFiles = [];
  try {
    const result = await askQwen(
      chatId,
      chatHistories.get(chatId),
      MAX_TOKENS,
      fromImage || fromVideo ? VISION_MODELS : MODELS
    );
    codeFiles = extractCodeBlocks(result.reply);
    reply = cleanReplyFormatting(removeCodeBlocks(result.reply));
    if (codeFiles.length > 0 && !reply) {
      reply = 'Kode sudah saya lampirkan sebagai file.';
    }
    const { model, provider } = result;
    console.log(`Dijawab oleh ${provider}, model: ${model}`);
    chatHistories.get(chatId).push({ role: 'assistant', content: reply });
  } catch (error) {
    console.error('AI provider error:', error?.status || error?.code || error?.message || error);
    if (error?.status !== 400 && error?.code !== 'invalid_parameter_error') {
      await proposeRepair('Qwen response', error);
    }
    // Hapus pesan user terakhir supaya riwayat tidak menggantung tanpa balasan
    chatHistories.get(chatId).pop();
    const failureMessage = fromImage || fromVideo
      ? `Maaf, ${fromVideo ? 'video' : 'gambar'} belum bisa diproses.${
          error?.code === 'model_not_found'
            ? ' Model vision di config.js tidak tersedia di workspace DashScope.'
            : error?.code === 'AccessDenied.Unpurchased' || error?.status === 403
              ? ' Model vision belum diaktifkan atau belum dibeli di workspace DashScope.'
              : error?.status === 400
                ? ' Model qwen-mt-image-2.0 hanya menerima URL gambar yang bisa diakses publik, bukan data gambar WhatsApp langsung.'
                : ''
        } Coba lagi nanti.`
      : 'Maaf, semua model gagal memproses permintaan Anda. Coba lagi nanti.';
    if (!await editReplySafely(replyAnchor, failureMessage)) {
      await sendReply(msg, failureMessage);
    }
    return;
  }

  try {
    await replyWithLongText(msg, reply, replyAnchor);
    if (codeFiles.length) {
      await sendCodeFiles(msg, codeFiles);
    }
  } catch (error) {
    console.error('Gagal mengirim balasan:', error?.message || error);
    if (!isClosedWhatsAppError(error)) await proposeRepair('reply delivery', error);
    if (!await editReplySafely(
      replyAnchor,
      'Balasan berhasil dibuat, tetapi gagal dikirim seluruhnya. Coba lagi nanti.'
    )) {
      await sendReply(msg, 'Balasan berhasil dibuat, tetapi gagal dikirim seluruhnya. Coba lagi nanti.');
    }
  }
});

process.on('uncaughtException', async (error) => {
  console.error('Uncaught exception:', error?.message || error);
  if (isClosedWhatsAppError(error)) return;
  try {
    await proposeRepair('uncaught exception', error);
  } finally {
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 1000);
  }
});

process.on('unhandledRejection', async (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  console.error('Unhandled rejection:', error);
  await proposeRepair('unhandled rejection', error);
});

client.initialize().catch((error) => {
  console.error('Gagal menghubungkan ke WhatsApp Web:', error);
  proposeRepair('WhatsApp initialization', error).catch((repairError) => {
    console.error('Gagal melaporkan error initialization:', repairError);
  });
  if (String(error?.message || error).includes('ERR_INTERNET_DISCONNECTED')) {
    console.error(
      'Koneksi internet sedang terputus dari Chromium. Pastikan internet aktif, lalu tunggu supervisor mencoba lagi.'
    );
  }
  process.exitCode = 1;
});
