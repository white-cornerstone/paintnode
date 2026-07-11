import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  abortStudySessionWithoutNativeCleanup,
  prepareStudySessionCleanup,
  providerFreeStudyProfileEnvironment,
  verifyAndFinalizeStudySessionCleanup,
} from './native-qa-session.mjs';
import {
  readExistingStudyApp,
  readStudySessionLaunchBinding,
  sameStaticStudyApp,
} from './native-qa-study-launch.mjs';

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
const binding = readStudySessionLaunchBinding({ statePath });
const cleanup = spawnSync(binding.app.executable, ['-ApplePersistenceIgnoreState', 'YES'], {
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
const afterCleanup = readExistingStudyApp({ appBundle: binding.app.appBundle });
if (!sameStaticStudyApp(binding.app, afterCleanup)) {
  throw new Error('Provider Free static bundle changed during profile cleanup.');
}
process.stdout.write(`${JSON.stringify(
  verifyAndFinalizeStudySessionCleanup(statePath, prepared),
  null,
  2,
)}\n`);
