import { createCanvas } from '@napi-rs/canvas';

export const PHUB_WIDTH = 1440;
export const PHUB_HEIGHT = 810;

export function parsePhubText(input) {
  const parts = String(input || '').trim().split('|');
  if (parts.length !== 2) {
    throw new Error('Format: /phub <teks putih>|<teks di kotak oranye>. Contoh: /phub Jemtod|Dev');
  }
  const [left, right] = parts.map((part) => part.trim());
  if (!left || !right) throw new Error('Kedua bagian teks harus diisi. Contoh: /phub Jemtod|Dev');
  if ([left, right].some((part) => Array.from(part).length > 32 || /[\r\n\x00-\x1f\x7f]/u.test(part))) {
    throw new Error('Setiap bagian teks maksimal 32 karakter dan harus satu baris.');
  }
  return { left, right };
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.quadraticCurveTo(x + width, y, x + width, y + r);
  context.lineTo(x + width, y + height - r);
  context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  context.lineTo(x + r, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - r);
  context.lineTo(x, y + r);
  context.quadraticCurveTo(x, y, x + r, y);
  context.closePath();
}

export function createPhubImage(input) {
  const { left, right } = typeof input === 'string' ? parsePhubText(input) : input;
  const canvas = createCanvas(PHUB_WIDTH, PHUB_HEIGHT);
  const context = canvas.getContext('2d');
  context.fillStyle = '#080808';
  context.fillRect(0, 0, PHUB_WIDTH, PHUB_HEIGHT);

  const gap = 18;
  const padding = 44;
  let fontSize = 220;
  let leftWidth;
  let rightWidth;
  let badgeWidth;
  for (; fontSize >= 48; fontSize -= 2) {
    context.font = `700 ${fontSize}px Arial, sans-serif`;
    leftWidth = context.measureText(left).width;
    rightWidth = context.measureText(right).width;
    badgeWidth = rightWidth + padding * 2;
    if (leftWidth + gap + badgeWidth <= PHUB_WIDTH - 96) break;
  }
  if (fontSize < 48) throw new Error('Teks terlalu panjang untuk gambar. Coba nama yang lebih pendek.');

  const textHeight = fontSize * 1.16;
  const badgeHeight = textHeight;
  const totalWidth = leftWidth + gap + badgeWidth;
  const startX = (PHUB_WIDTH - totalWidth) / 2;
  const centerY = PHUB_HEIGHT / 2;
  const badgeX = startX + leftWidth + gap;

  roundedRect(context, badgeX, centerY - badgeHeight / 2, badgeWidth, badgeHeight, 24);
  context.fillStyle = '#f7931e';
  context.fill();

  context.font = `700 ${fontSize}px Arial, sans-serif`;
  context.textBaseline = 'middle';
  context.textAlign = 'left';
  context.fillStyle = '#ffffff';
  context.fillText(left, startX, centerY, leftWidth + 2);
  context.fillStyle = '#080808';
  context.fillText(right, badgeX + padding, centerY, rightWidth + 2);

  return canvas.toBuffer('image/png');
}
