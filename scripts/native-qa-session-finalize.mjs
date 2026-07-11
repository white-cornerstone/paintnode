import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abortStudySessionWithoutNativeCleanup,
  prepareStudySessionCleanup,
  providerFreeStudyProfileEnvironment,
  verifyAndFinalizeStudySessionCleanup,
} from './native-qa-session.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const statePath = join(root, 'src-tauri', '.provider-free-study-session.json');
const intent = process.argv.slice(2).includes('--abort') ? 'abort' : 'finalize';
const prepared = prepareStudySessionCleanup(statePath, { intent });
if (!prepared.requiresNativeCleanup) {
  process.stdout.write(`${JSON.stringify(
    abortStudySessionWithoutNativeCleanup(statePath, prepared),
    null,
    2,
  )}\n`);
  process.exit(0);
}
const executable = join(
  root,
  'src-tauri/target/debug/bundle/macos/PaintNode Blueprint QA — Provider Free.app/Contents/MacOS/PaintNode',
);
accessSync(executable, constants.X_OK);
const cleanup = spawnSync(executable, ['-ApplePersistenceIgnoreState', 'YES'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PAINTNODE_PROVIDER_QA_MODE: 'provider-free',
    PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_PROFILE:
      providerFreeStudyProfileEnvironment(prepared.session),
    PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_NONCE: prepared.cleanupNonce,
    PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_EVIDENCE: prepared.evidencePath,
  },
});
if (cleanup.error) throw cleanup.error;
if (cleanup.status !== 0) {
  throw new Error(`Provider Free study profile cleanup failed with status ${cleanup.status ?? 'unknown'}${cleanup.signal ? ` (${cleanup.signal})` : ''}.`);
}
process.stdout.write(`${JSON.stringify(
  verifyAndFinalizeStudySessionCleanup(statePath, prepared),
  null,
  2,
)}\n`);
