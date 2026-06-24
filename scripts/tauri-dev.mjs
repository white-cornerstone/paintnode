// Launch `tauri dev` on an automatically-chosen free port, so it never collides with
// other dev servers. We pick a free port, point Vite at it (TAURI_DEV_PORT, read by
// vite.config.ts) and override Tauri's devUrl to match via a throwaway config file.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function findFreePort(start, end) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > end) return reject(new Error(`No free port in ${start}-${end}`));
      const srv = createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

const port = await findFreePort(1420, 1520);
const devUrl = `http://localhost:${port}`;
console.log(`[tauri:dev] using free port ${port} (${devUrl})`);

// Override only devUrl; everything else comes from tauri.conf.json.
const overridePath = join(root, 'src-tauri', '.tauri.dev.json');
writeFileSync(overridePath, JSON.stringify({ build: { devUrl } }, null, 2));

const isWin = process.platform === 'win32';
const tauriBin = join(root, 'node_modules', '.bin', isWin ? 'tauri.cmd' : 'tauri');

const child = spawn(tauriBin, ['dev', '--config', overridePath], {
  stdio: 'inherit',
  shell: isWin,
  env: { ...process.env, TAURI_DEV_PORT: String(port) },
});
child.on('exit', (code) => process.exit(code ?? 0));
