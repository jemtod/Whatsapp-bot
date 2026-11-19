import test from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createPhubImage, parsePhubText, PHUB_HEIGHT, PHUB_WIDTH } from '../phub-image.js';

test('parses two trimmed text fields', () => {
  assert.deepEqual(parsePhubText(' Jemtod | Dev '), { left: 'Jemtod', right: 'Dev' });
});

test('rejects missing, extra, empty and multiline fields', () => {
  for (const input of ['', 'Nama', 'Nama|', '|Label', 'a|b|c', 'a\nb|c']) {
    assert.throws(() => parsePhubText(input));
  }
  assert.throws(() => parsePhubText(`${'x'.repeat(33)}|Dev`), /32 karakter/);
});

test('renders a readable 16:9 PNG with white name and orange label panel', async () => {
  const png = createPhubImage('Jemtod|Dev');
  const image = await loadImage(png);
  assert.equal(image.width, PHUB_WIDTH);
  assert.equal(image.height, PHUB_HEIGHT);

  const canvas = createCanvas(PHUB_WIDTH, PHUB_HEIGHT);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, PHUB_WIDTH, PHUB_HEIGHT);
  let orangePixels = 0;
  let whitePixels = 0;
  let blackPixels = 0;
  for (let index = 0; index < data.length; index += 4) {
    const [red, green, blue] = data.subarray(index, index + 3);
    if (red > 220 && green > 90 && green < 190 && blue < 80) orangePixels++;
    if (red > 240 && green > 240 && blue > 240) whitePixels++;
    if (red < 20 && green < 20 && blue < 20) blackPixels++;
  }
  assert.ok(orangePixels > 30000);
  assert.ok(whitePixels > 10000);
  assert.ok(blackPixels > 500000);
});

test('shrinks longer text to fit the canvas without changing labels', async () => {
  const png = createPhubImage(`${'KomunitasDev'.repeat(2)}|BuildTogether`);
  const image = await loadImage(png);
  assert.equal(image.width, PHUB_WIDTH);
});
