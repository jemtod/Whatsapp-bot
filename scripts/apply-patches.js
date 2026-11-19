import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const patchPackageBin = path.resolve(
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'patch-package.cmd' : 'patch-package'
);

console.log('Menerapkan patch whatsapp-web.js...');
try {
  const { stdout, stderr } = await execFileAsync(
    patchPackageBin,
    ['--patch-dir', 'patch-files', '--error-on-fail'],
    { timeout: 120000, maxBuffer: 2 * 1024 * 1024 }
  );
  if (stdout.trim()) process.stdout.write(stdout);
  if (stderr.trim()) process.stderr.write(stderr);
  console.log('Patch whatsapp-web.js selesai.');
} catch (error) {
  if (error.code === 'ETIMEDOUT') {
    throw new Error('Penerapan patch melebihi batas 120 detik.');
  }
  const detail = [error.stdout, error.stderr, error.message]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .trim();
  throw new Error(`Gagal menerapkan patch:\n${detail}`);
}
