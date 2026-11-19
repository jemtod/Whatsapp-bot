import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import * as YTDlpModule from 'yt-dlp-wrap';

const YTDlpWrap = YTDlpModule.default.default;

const binaryPath = path.resolve('bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

await mkdir(path.dirname(binaryPath), { recursive: true });
await YTDlpWrap.downloadFromGithub(binaryPath);
if (process.platform !== 'win32') await chmod(binaryPath, 0o755);
console.log(`yt-dlp terpasang di ${binaryPath}`);
