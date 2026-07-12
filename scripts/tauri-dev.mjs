// Launch `tauri dev` on an automatically-chosen free port, so it never collides with
// other dev servers. We pick a free port, point Vite at it (TAURI_DEV_PORT, read by
// vite.config.ts) and override Tauri's devUrl to match via a throwaway config file.
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { accessSync, constants, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

function executablePath(args, flag) {
  const value = valueAfter(args, flag);
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  const resolved = realpathSync(value);
  accessSync(resolved, constants.X_OK);
  return resolved;
}

const args = process.argv.slice(2);
const providerFree = args.includes('--qa-provider-free');
const providerE2e = args.includes('--qa-provider-e2e');
if (providerFree && providerE2e) {
  throw new Error('Choose either provider-free or provider-e2e native QA, not both');
}

let qaEnvironment = {};
let qaLabel = 'repo-dev';
if (providerFree) {
  qaLabel = 'provider-free';
  qaEnvironment = { PAINTNODE_PROVIDER_QA_MODE: 'provider-free' };
} else if (providerE2e) {
  qaLabel = 'provider-e2e';
  qaEnvironment = {
    PAINTNODE_PROVIDER_QA_MODE: 'provider-e2e',
    PAINTNODE_QA_CODEX_BIN: executablePath(args, '--codex-path'),
    PAINTNODE_QA_ANTIGRAVITY_BIN: executablePath(args, '--antigravity-path'),
    PAINTNODE_QA_GROK_BIN: executablePath(args, '--grok-path'),
  };
}

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

// Give every repo-built app an isolated identity and an unmistakable window title.
// This prevents Computer Use from targeting an installed production PaintNode.
const overridePath = join(root, 'src-tauri', '.tauri.dev.json');
const baseConfig = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const baseWindow = baseConfig.app.windows[0];
writeFileSync(
  overridePath,
  JSON.stringify(
    {
      productName: 'PaintNode Repo QA',
      identifier: `com.paintnode.editor.qa.${qaLabel.replaceAll('-', '.')}`,
      build: { devUrl },
      app: {
        windows: [
          {
            ...baseWindow,
            title: `PaintNode Repo QA — ${qaLabel}`,
          },
        ],
      },
    },
    null,
    2,
  ),
);

const isWin = process.platform === 'win32';
const tauriBin = join(root, 'node_modules', '.bin', isWin ? 'tauri.cmd' : 'tauri');

const child = spawn(tauriBin, ['dev', '--config', overridePath], {
  stdio: 'inherit',
  shell: isWin,
  env: { ...process.env, ...qaEnvironment, TAURI_DEV_PORT: String(port) },
});
child.on('exit', (code) => process.exit(code ?? 0));
