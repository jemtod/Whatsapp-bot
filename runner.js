import { spawn } from 'node:child_process';

let stopping = false;
let restartAttempt = 0;

function startBot() {
  const bot = spawn(process.execPath, ['index.js'], {
    stdio: 'inherit',
    env: process.env,
  });

  const startedAt = Date.now();
  bot.on('exit', (code, signal) => {
    if (stopping) return;
    if (Date.now() - startedAt > 30000) restartAttempt = 0;
    const delay = Math.min(60000, 5000 * 2 ** restartAttempt);
    restartAttempt++;
    console.log(
      `Bot berhenti (${signal || `kode ${code}`}), mencoba lagi dalam ${delay / 1000} detik...`
    );
    setTimeout(startBot, delay);
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
  });
}

startBot();
