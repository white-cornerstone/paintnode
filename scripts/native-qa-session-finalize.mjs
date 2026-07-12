import { spawn as nodeSpawn } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyMacosRunningCodeIdentity } from './native-qa-code-identity.mjs';
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
const defaultStatePath = join(root, 'src-tauri', '.provider-free-study-session.json');

function waitForExit(child) {
  return new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

export async function runStudySessionCleanup({
  statePath = defaultStatePath,
  intent = 'finalize',
  randomBytes,
  spawn = nodeSpawn,
  attestRunningProcess = verifyMacosRunningCodeIdentity,
  readBundleIdentifier,
  readStaticCodeIdentity,
}) {
  const prepared = prepareStudySessionCleanup(statePath, { intent, randomBytes });
  if (!prepared.requiresNativeCleanup) {
    return abortStudySessionWithoutNativeCleanup(statePath, prepared);
  }
  const readOptions = { statePath, readBundleIdentifier, readStaticCodeIdentity };
  const binding = readStudySessionLaunchBinding(readOptions);
  const child = spawn(binding.app.executable, ['-ApplePersistenceIgnoreState', 'YES'], {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      PAINTNODE_PROVIDER_QA_MODE: 'provider-free',
      PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_PROFILE:
        providerFreeStudyProfileEnvironment(prepared.session),
      PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_NONCE: prepared.cleanupNonce,
      PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_EVIDENCE: prepared.evidencePath,
      PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_RELEASE: prepared.releasePath,
    },
  });
  const childExit = waitForExit(child);
  childExit.catch(() => {});
  try {
    attestRunningProcess(child.pid, binding.app.codeIdentity);
    writeFileSync(prepared.releasePath, `${prepared.cleanupNonceSha256}\n`, {
      flag: 'wx', mode: 0o600,
    });
    const { code, signal } = await childExit;
    if (code !== 0) {
      throw new Error(`Provider Free study profile cleanup failed with status ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`);
    }
    const afterCleanup = readExistingStudyApp({
      appBundle: binding.app.appBundle, readBundleIdentifier, readStaticCodeIdentity,
    });
    if (!sameStaticStudyApp(binding.app, afterCleanup)) {
      throw new Error('Provider Free static bundle changed during profile cleanup.');
    }
    return verifyAndFinalizeStudySessionCleanup(statePath, prepared);
  } catch (error) {
    child.kill?.();
    throw error;
  } finally {
    rmSync(prepared.releasePath, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const intent = process.argv.slice(2).includes('--abort') ? 'abort' : 'finalize';
    process.stdout.write(`${JSON.stringify(await runStudySessionCleanup({ intent }), null, 2)}\n`);
  } catch (error) {
    console.error(`[native-qa-session-finalize] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
