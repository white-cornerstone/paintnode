import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { qaBuildProvenancePath, writeQaBuildProvenance } from './native-qa-build-provenance.mjs';
import {
  launchExistingProviderFreeStudyApp,
  readExistingStudyApp,
} from './native-qa-study-launch.mjs';
import {
  readProviderFreeStudySession,
  studySessionBootEvidencePath,
} from './native-qa-session.mjs';
import { runStudySessionCleanup } from './native-qa-session-finalize.mjs';
import { consumeQaOnlyStudySession } from './creator-study-qa-consume.mjs';
import {
  createFreshProviderFreeStudySession,
  markStudySessionLaunchAttempted,
  studySessionCleanupReleasePath,
  studySessionLaunchEvidencePath,
  writeProviderFreeStudySession,
} from './native-qa-session.mjs';

const FIRST_UUID = '00112233-4455-4677-8899-aabbccddeeff';
const CODE_HASH = 'd'.repeat(40);
const fakeAppReads = {
  readBundleIdentifier: () => 'com.paintnode.editor.blueprintqa.provider.free',
  readStaticCodeIdentity: () => ({ cdHash: CODE_HASH }),
};
const fakeAttest = (pid, identity) => {
  assert.equal(pid, 4242);
  assert.deepEqual(identity, { cdHash: CODE_HASH });
};

function studyBundle() {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-study-launch-'));
  const appBundle = join(root, 'PaintNode Blueprint QA — Provider Free.app');
  const executable = join(appBundle, 'Contents/MacOS/PaintNode');
  mkdirSync(join(appBundle, 'Contents/MacOS'), { recursive: true });
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  writeQaBuildProvenance({
    appBundle,
    mode: 'provider-free',
    bundleId: 'com.paintnode.editor.blueprintqa.provider.free',
    studyCapable: true,
    codeIdentity: { cdHash: CODE_HASH },
    sourceState: {
      gitSha: 'a'.repeat(40), sourceTreeSha: 'b'.repeat(40), sourceDirty: false,
      sourceStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  });
  return { root, appBundle, executable };
}

function writeBootEvidence(env) {
  const profileBytes = Buffer.from(env.PAINTNODE_PROVIDER_FREE_STUDY_PROFILE, 'hex');
  const bootNonce = Buffer.from(env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_NONCE, 'hex');
  writeFileSync(env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_EVIDENCE, JSON.stringify({
    version: 3,
    event: 'app-boot',
    profileSha256: createHash('sha256').update(profileBytes).digest('hex'),
    bootNonceSha256: createHash('sha256').update(bootNonce).digest('hex'),
    buildIdentitySha256: env.PAINTNODE_PROVIDER_FREE_STUDY_BUILD_IDENTITY,
  }), { flag: 'wx' });
}

test('launch-existing fresh returns after boot without rebuilding or mutating static provenance', async () => {
  const { root, appBundle, executable } = studyBundle();
  const statePath = join(root, 'session.json');
  const provenancePath = qaBuildProvenancePath(appBundle);
  const beforeProvenance = readFileSync(provenancePath);
  const beforeExecutable = readFileSync(executable);
  let unrefCalled = false;
  let spawnedExecutable;
  let spawnedEnv;

  const receipt = await launchExistingProviderFreeStudyApp({
    appBundle,
    statePath,
    fresh: true,
    platform: 'darwin',
    productVersion: '14.6',
    randomUUID: () => FIRST_UUID,
    ...fakeAppReads,
    attestRunningProcess: fakeAttest,
    afterLaunchRelease: () => writeBootEvidence(spawnedEnv),
    spawn(executablePath, _args, options) {
      spawnedExecutable = executablePath;
      spawnedEnv = options.env;
      return { pid: 4242, exitCode: null, unref() { unrefCalled = true; } };
    },
  });

  assert.equal(spawnedExecutable, realpathSync(executable));
  assert.equal(unrefCalled, true);
  assert.equal(receipt.launchIntent, 'fresh');
  assert.equal(receipt.appBootObserved, true);
  assert.equal(receipt.appStillRunning, true);
  assert.deepEqual(readFileSync(provenancePath), beforeProvenance);
  assert.deepEqual(readFileSync(executable), beforeExecutable);
  assert.equal(readProviderFreeStudySession(statePath).setupConsumed, false);
});

test('launch-existing rejects generic, dynamic, or executable-drifted bundles', () => {
  const { appBundle, executable } = studyBundle();
  assert.equal(readExistingStudyApp({ appBundle, ...fakeAppReads }).provenance.studyCapable, true);

  const provenancePath = qaBuildProvenancePath(appBundle);
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  writeFileSync(provenancePath, JSON.stringify({ ...provenance, studySession: { launchIntent: 'fresh' } }));
  assert.throws(() => readExistingStudyApp({ appBundle, ...fakeAppReads }), /static provenance/i);
  writeFileSync(provenancePath, JSON.stringify(provenance));
  writeFileSync(executable, '#!/bin/sh\nexit 9\n');
  assert.throws(() => readExistingStudyApp({ appBundle, ...fakeAppReads }), /executable fingerprint/i);

  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  const valid = JSON.stringify(provenance);
  writeFileSync(provenancePath, valid.replace('{', '{"studyCapable":false,'));
  assert.throws(() => readExistingStudyApp({ appBundle, ...fakeAppReads }), /duplicate field studyCapable/i);
});

test('fresh launch rejects child exit, hung boot, executable swap, and swap-restore forgery', async () => {
  for (const failure of ['exit', 'timeout', 'swap', 'swap-restore']) {
    const { root, appBundle, executable } = studyBundle();
    const statePath = join(root, 'session.json');
    await assert.rejects(() => launchExistingProviderFreeStudyApp({
      appBundle,
      statePath,
      fresh: true,
      platform: 'darwin',
      productVersion: '14.6',
      randomUUID: () => FIRST_UUID,
      ...fakeAppReads,
      attestRunningProcess: failure === 'swap-restore'
        ? () => { throw new Error('Provider Free running code identity does not match the approved CDHash'); }
        : fakeAttest,
      bootTimeoutMs: 2,
      bootPollMs: 1,
      afterLaunchRelease: failure === 'swap' ? ({ env }) => writeBootEvidence(env) : undefined,
      spawn(_executablePath, _args, options) {
        if (failure === 'swap' || failure === 'swap-restore') {
          const approvedBytes = readFileSync(executable);
          const profileBytes = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_PROFILE, 'hex');
          const bootNonce = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_NONCE, 'hex');
          writeFileSync(options.env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_EVIDENCE, JSON.stringify({
            version: 3, event: 'app-boot',
            profileSha256: createHash('sha256').update(profileBytes).digest('hex'),
            bootNonceSha256: createHash('sha256').update(bootNonce).digest('hex'),
            buildIdentitySha256: options.env.PAINTNODE_PROVIDER_FREE_STUDY_BUILD_IDENTITY,
          }));
          writeFileSync(executable, '#!/bin/sh\nexit 7\n');
          if (failure === 'swap-restore') writeFileSync(executable, approvedBytes);
        }
        return {
          pid: failure === 'swap-restore' ? 666 : 4242,
          exitCode: failure === 'exit' ? 9 : null,
          kill() {},
          unref() {},
        };
      },
    }), failure === 'exit' ? /exited before verified boot/i
      : failure === 'timeout' ? /timed out/i
        : failure === 'swap-restore' ? /running code identity/i : /fingerprint|changed during launch/i);
  }
});

test('forge-then-exec-approved cannot reuse pre-attestation boot evidence', async () => {
  const { root, appBundle } = studyBundle();
  const statePath = join(root, 'session.json');
  let attestations = 0;
  await assert.rejects(() => launchExistingProviderFreeStudyApp({
    appBundle,
    statePath,
    fresh: true,
    platform: 'darwin',
    productVersion: '14.6',
    randomUUID: () => FIRST_UUID,
    ...fakeAppReads,
    attestRunningProcess(pid, identity) {
      attestations += 1;
      fakeAttest(pid, identity);
    },
    bootTimeoutMs: 2,
    bootPollMs: 1,
    spawn(_executablePath, _args, options) {
      writeBootEvidence(options.env);
      return { pid: 4242, exitCode: null, kill() {}, unref() {} };
    },
  }), /timed out/i);
  assert.equal(attestations, 1, 'pre-release forgery must not reach post-boot re-attestation');
  assert.equal(existsSync(studySessionBootEvidencePath(statePath)), false);
});

test('resume uses the same preserved bundle without fresh boot evidence', async () => {
  const { root, appBundle } = studyBundle();
  const statePath = join(root, 'session.json');
  let freshEnv;
  const spawnFresh = (_executablePath, _args, options) => {
    freshEnv = options.env;
    return { pid: 4242, exitCode: null, unref() {} };
  };
  const fresh = await launchExistingProviderFreeStudyApp({
    appBundle, statePath, fresh: true, platform: 'darwin', productVersion: '14.6',
    randomUUID: () => FIRST_UUID,
    ...fakeAppReads,
    attestRunningProcess: fakeAttest,
    spawn: spawnFresh,
    afterLaunchRelease: () => writeBootEvidence(freshEnv),
  });
  const qaReceipt = consumeQaOnlyStudySession({ appBundle, statePath, ...fakeAppReads });
  assert.equal(qaReceipt.qaOnly, true);
  assert.equal(qaReceipt.technicalSetupReady, true);
  assert.equal(qaReceipt.studyAuthorizationEvaluated, false);
  const bootBefore = readFileSync(studySessionBootEvidencePath(statePath));
  let resumeEnv;
  const resumed = await launchExistingProviderFreeStudyApp({
    appBundle, statePath, resume: true, platform: 'darwin', productVersion: '14.6',
    ...fakeAppReads,
    attestRunningProcess: fakeAttest,
    spawn(_executablePath, _args, options) {
      resumeEnv = options.env;
      return { pid: 4242, exitCode: null, unref() {} };
    },
  });
  assert.equal(resumed.launchIntent, 'resume');
  assert.equal(resumed.profileSha256, fresh.profileSha256);
  assert.equal('PAINTNODE_PROVIDER_FREE_STUDY_BOOT_NONCE' in resumeEnv, false);
  assert.deepEqual(readFileSync(studySessionBootEvidencePath(statePath)), bootBefore);
});

test('concurrent fresh launch and symlinked static provenance fail closed', async () => {
  const { root, appBundle } = studyBundle();
  const statePath = join(root, 'session.json');
  let spawnEnv;
  const spawnBoot = (_executablePath, _args, options) => {
    spawnEnv = options.env;
    return { pid: 4242, exitCode: null, unref() {} };
  };
  const options = {
    appBundle, statePath, fresh: true, platform: 'darwin', productVersion: '14.6',
    randomUUID: () => FIRST_UUID,
    ...fakeAppReads,
    attestRunningProcess: fakeAttest,
    spawn: spawnBoot,
    afterLaunchRelease: () => writeBootEvidence(spawnEnv),
  };
  const results = await Promise.allSettled([
    launchExistingProviderFreeStudyApp(options),
    launchExistingProviderFreeStudyApp(options),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(results.filter(({ status }) => status === 'rejected').length, 1);
  const winner = results.find(({ status }) => status === 'fulfilled').value;
  assert.equal(readProviderFreeStudySession(statePath).profileSha256, winner.profileSha256,
    'the losing concurrent fresh launch must not overwrite the winning create-only state');

  const provenancePath = qaBuildProvenancePath(appBundle);
  const realSidecar = `${provenancePath}.real`;
  writeFileSync(realSidecar, readFileSync(provenancePath));
  rmSync(provenancePath);
  symlinkSync(realSidecar, provenancePath);
  assert.throws(() => readExistingStudyApp({
    appBundle,
    ...fakeAppReads,
  }), /non-symlink/i);
});

test('cleanup rejects swap-and-restore forged evidence before releasing trusted cleanup', async () => {
  const { root, appBundle, executable } = studyBundle();
  const statePath = join(root, 'session.json');
  const app = readExistingStudyApp({ appBundle, ...fakeAppReads });
  const session = createFreshProviderFreeStudySession({
    randomUUID: () => FIRST_UUID,
    randomBytes: () => Buffer.alloc(32, 3),
  });
  writeProviderFreeStudySession(statePath, session);
  markStudySessionLaunchAttempted(statePath);
  writeFileSync(studySessionLaunchEvidencePath(statePath), JSON.stringify({
    version: 1,
    event: 'study-launch',
    launchIntent: 'fresh',
    profileSha256: session.profileSha256,
    appBundlePath: app.appBundle,
    provenanceSha256: app.provenanceSha256,
    executableSha256: app.executableSha256,
    buildIdentitySha256: app.buildIdentitySha256,
  }));
  const approvedBytes = readFileSync(executable);
  await assert.rejects(() => runStudySessionCleanup({
    statePath,
    intent: 'abort',
    randomBytes: () => Buffer.alloc(32, 9),
    ...fakeAppReads,
    attestRunningProcess() {
      throw new Error('Provider Free running code identity does not match the approved CDHash');
    },
    spawn(_executablePath, _args, options) {
      writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      const cleanupNonce = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_NONCE, 'hex');
      writeFileSync(options.env.PAINTNODE_PROVIDER_FREE_STUDY_CLEANUP_EVIDENCE, JSON.stringify({
        version: 3,
        event: 'profile-removed',
        profileSha256: session.profileSha256,
        cleanupNonceSha256: createHash('sha256').update(cleanupNonce).digest('hex'),
      }));
      writeFileSync(executable, approvedBytes);
      const child = new EventEmitter();
      child.pid = 666;
      child.kill = () => {};
      return child;
    },
  }), /running code identity/i);
  assert.equal(readProviderFreeStudySession(statePath).profileSha256, session.profileSha256);
  assert.equal(existsSync(studySessionCleanupReleasePath(statePath)), false);
  assert.deepEqual(readFileSync(executable), approvedBytes);
});

test('launch-existing source contains no build tool invocation', () => {
  const source = readFileSync(new URL('./native-qa-study-launch.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /tauri\s+build|vite\s+build|build:quicklook|npm\s+run\s+build/);
  const finalizeSource = readFileSync(new URL('./native-qa-session-finalize.mjs', import.meta.url), 'utf8');
  assert.match(finalizeSource, /readStudySessionLaunchBinding/);
  assert.doesNotMatch(finalizeSource, /target\/debug\/bundle\/macos/);
  const qaConsumeSource = readFileSync(new URL('./creator-study-qa-consume.mjs', import.meta.url), 'utf8');
  assert.match(qaConsumeSource, /qaOnly:\s*true/);
  assert.match(qaConsumeSource, /studyAuthorizationEvaluated:\s*false/);
  assert.doesNotMatch(qaConsumeSource, /createMacKeychain|security|active-build/i);
});
