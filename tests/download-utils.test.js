import test from 'node:test';
import assert from 'node:assert/strict';
import { imageExtensionForMime, isDirectImageUrl, normalizeDownloadUrl } from '../download-utils.js';

test('accepts HTTPS links from different yt-dlp providers', () => {
  assert.equal(normalizeDownloadUrl('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
  assert.equal(normalizeDownloadUrl('https://www.reddit.com/r/videos/comments/abc'), 'https://www.reddit.com/r/videos/comments/abc');
  assert.equal(normalizeDownloadUrl('https://pbs.twimg.com/media/photo.jpg?format=jpg'), 'https://pbs.twimg.com/media/photo.jpg?format=jpg');
});

test('rejects insecure, local, and credential-bearing links', () => {
  assert.equal(normalizeDownloadUrl('http://example.com/video'), null);
  assert.equal(normalizeDownloadUrl('file:///etc/passwd'), null);
  assert.equal(normalizeDownloadUrl('https://localhost/video'), null);
  assert.equal(normalizeDownloadUrl('https://192.168.1.2/video'), null);
  assert.equal(normalizeDownloadUrl('https://user:password@example.com/video'), null);
});

test('maps supported downloaded image types to WhatsApp-friendly extensions', () => {
  assert.equal(imageExtensionForMime('image/jpeg; charset=binary'), 'jpg');
  assert.equal(imageExtensionForMime('image/png'), 'png');
  assert.equal(imageExtensionForMime('image/webp'), 'webp');
  assert.equal(imageExtensionForMime('image/gif'), 'gif');
  assert.equal(imageExtensionForMime('image/svg+xml'), null);
  assert.equal(imageExtensionForMime('text/html'), null);
});

test('recognizes direct image links with query strings', () => {
  assert.equal(isDirectImageUrl('https://cdn.example/photo.jpg?size=large'), true);
  assert.equal(isDirectImageUrl('https://cdn.example/photo.jpeg'), true);
  assert.equal(isDirectImageUrl('https://cdn.example/photo.webp'), true);
  assert.equal(isDirectImageUrl('https://cdn.example/media?id=2&format=jpg'), true);
  assert.equal(isDirectImageUrl('https://instagram.com/p/abc/'), false);
});
