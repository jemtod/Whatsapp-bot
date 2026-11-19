// Nomor WhatsApp owner, format internasional tanpa tanda +.
export const OWNER_NUMBERS = new Set(['6281234567890']);

export const DASHSCOPE_API_KEY =
  'PASTE_APIKEY_KAMU_DISINI';
export const DASHSCOPE_BASE_URL =
  'https://ws-fsnc58x0acmzngu8.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
export const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
export const GROQ_API_KEY =
  'PASTE_APIKEY_KAMU_DISINI';
export const GROQ_MODELS = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
];
export const DASHSCOPE_MODELS = [
  'qwen-plus-character',
  'qwen-flash-character',
];
// Model vision harus sudah diaktifkan di workspace (Model Studio > Models). Dicoba berurutan sampai ada yang berhasil.
export const DASHSCOPE_VISION_MODELS = [
  'qwen-mt-image-2.0',
  'kimi-k3.1-pro',
];

export const DASHSCOPE_ASR_MODELS = [
  'qwen-audio-3.1-asr-flash',
  'fun-asr-flash-2026-06-15',
];
export const REPLY_IN_GROUPS = false;
export const MAX_HISTORY = 8;
export const MAX_TOKENS = 500;
export const VOICE_ENABLED = true;
export const SHOW_TRANSCRIPT = true;
export const IMAGE_COUNT = 1;
export const TIMEZONE = 'Asia/Jakarta';
export const SYSTEM_PROMPT = [
  'Kamu adalah asisten AI yang membantu pengguna melalui WhatsApp.',
  'Jawab dengan jelas, sopan, dan sesuai bahasa yang digunakan pengguna. Sesuaikan panjang jawaban dengan kebutuhan.',
  'Jika tidak mengetahui jawaban atau informasi kurang, sampaikan dengan jujur dan minta klarifikasi seperlunya.',
  'Jangan mengaku telah melakukan tindakan yang belum dilakukan. Untuk permintaan teknis, berikan langkah atau contoh yang dapat digunakan.'
].join(' ');
