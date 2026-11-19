import { isIP } from 'node:net';

const IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
]);

const IMAGE_SUFFIXES = new Set(IMAGE_EXTENSIONS.values());

export function normalizeDownloadUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
    const isLocalHostname = hostname === 'localhost' ||
      /\.(?:localhost|local|internal|test|invalid)$/.test(hostname);

    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !hostname ||
      isIP(hostname) ||
      !hostname.includes('.') ||
      isLocalHostname
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function imageExtensionForMime(value) {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return IMAGE_EXTENSIONS.get(mime) || null;
}

export function isDirectImageUrl(value) {
  try {
    const url = new URL(value);
    const pathExtension = url.pathname.toLowerCase().split('.').pop().replace(/^jpeg$/, 'jpg');
    const queryExtension = (url.searchParams.get('format') || url.searchParams.get('fm') || '')
      .toLowerCase()
      .replace(/^jpeg$/, 'jpg');
    return IMAGE_SUFFIXES.has(pathExtension) || IMAGE_SUFFIXES.has(queryExtension);
  } catch {
    return false;
  }
}
