import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

import { preflightProvider } from './provider-qa-preflight.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function executablePath(flag) {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${flag} requires a value`);
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  return value;
}

console.log('[provider-e2e] fail-closed signature, version, auth, and capability preflight');
const codex = await preflightProvider('codex', executablePath('--codex-path'));
const antigravity = await preflightProvider('antigravity', executablePath('--antigravity-path'));
const codexPath = codex.launchPath;
const antigravityPath = antigravity.launchPath;
console.log(`[provider-e2e] Codex ready: ${codex.version} (${codexPath})`);
console.log(`[provider-e2e] Antigravity ready: ${antigravity.version} (${antigravityPath})`);

const env = {
  ...process.env,
  PAINTNODE_PROVIDER_QA_MODE: 'provider-e2e',
  PAINTNODE_PROVIDER_QA_PREFLIGHT: 'provider-doctor-v1',
  PAINTNODE_QA_CODEX_BIN: codexPath,
  PAINTNODE_QA_CODEX_VERSION: codex.version,
  PAINTNODE_QA_ANTIGRAVITY_BIN: antigravityPath,
  PAINTNODE_QA_ANTIGRAVITY_VERSION: antigravity.version,
};

console.log('[provider-e2e] validating PaintNode resolver with the preflighted native executables');
const test = spawnSync(
  'cargo',
  [
    'test',
    'explicit_provider_e2e_accepts_provider_doctor_handoff',
    '--manifest-path',
    join(root, 'src-tauri', 'Cargo.toml'),
    '--',
    '--ignored',
    '--nocapture',
    '--test-threads=1',
  ],
  { cwd: root, env, stdio: 'inherit' },
);
if (test.error) throw test.error;
if (test.status !== 0) process.exit(test.status ?? 1);

if (args.includes('--preflight-only')) {
  console.log('[provider-e2e] provider doctor and PaintNode handoff passed; no app was built or launched');
  process.exit(0);
}

console.log('[provider-e2e] checks passed; building the uniquely identified repo QA app');
const app = spawnSync(
  process.execPath,
  [
    join(root, 'scripts', 'native-qa-app.mjs'),
    '--mode',
    'provider-e2e',
    '--codex-path',
    codexPath,
    '--antigravity-path',
    antigravityPath,
  ],
  { cwd: root, env, stdio: 'inherit' },
);
if (app.error) throw app.error;
process.exit(app.status ?? 0);
