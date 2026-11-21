import { createCanvas } from '@napi-rs/canvas';

export const TTP_HELP = 'Format: /ttp <teks>. Contoh: /ttp besok libur! Maksimal 200 karakter.';

const segmenter = new Intl.Segmenter('id', { granularity: 'grapheme' });
const characters = (text) => Array.from(segmenter.segment(text), ({ segment }) => segment);

function wrapText(context, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ').filter(Boolean)) {
      if (line && context.measureText(`${line} ${word}`).width <= maxWidth) {
        line += ` ${word}`;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      for (const character of characters(word)) {
        if (line && context.measureText(line + character).width > maxWidth) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function createTextSticker(input) {
  const raw = String(input || '').trim();
  if (!raw || raw.length > 4000 || characters(raw).length > 200) throw new Error(TTP_HELP);
  const text = raw.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/gu, ' ');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) throw new Error(TTP_HELP);
  const canvas = createCanvas(512, 512);
  const context = canvas.getContext('2d');
  let lines;
  let fontSize;
  for (fontSize = 96; fontSize >= 20; fontSize -= 2) {
    context.font = `900 ${fontSize}px Arial, sans-serif`;
    lines = wrapText(context, text, 440);
    if (lines.length * fontSize * 1.3 <= 440 && lines.every((line) => context.measureText(line).width <= 440)) break;
  }
  if (fontSize < 20) throw new Error('Teks terlalu padat. Kurangi teks atau jumlah barisnya.');
  // Outline keeps the text readable against either light or dark chat backgrounds.
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.lineJoin = 'round';
  context.strokeStyle = '#111111';
  context.fillStyle = '#ffffff';
  context.lineWidth = Math.max(4, fontSize * 0.09);
  const lineHeight = fontSize * 1.3;
  const startY = 256 - (lines.length - 1) * lineHeight / 2;
  lines.forEach((line, index) => {
    context.strokeText(line, 256, startY + index * lineHeight);
    context.fillText(line, 256, startY + index * lineHeight);
  });
  return canvas.toBuffer('image/webp');
}
