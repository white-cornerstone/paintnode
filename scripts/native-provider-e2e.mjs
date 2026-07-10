import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function executablePath(flag) {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) throw new Error(`${flag} requires a value`);
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  const resolved = realpathSync(value);
  accessSync(resolved, constants.X_OK);
  return resolved;
}

const codexPath = executablePath('--codex-path');
const antigravityPath = executablePath('--antigravity-path');
const env = {
  ...process.env,
  PAINTNODE_PROVIDER_QA_MODE: 'provider-e2e',
  PAINTNODE_QA_CODEX_BIN: codexPath,
  PAINTNODE_QA_ANTIGRAVITY_BIN: antigravityPath,
};

console.log('[provider-e2e] validating detection and no-cost capability/auth checks');
const test = spawnSync(
  'cargo',
  [
    'test',
    'explicit_provider_e2e_detects_and_checks_no_cost_capabilities',
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
