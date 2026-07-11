import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
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
  verifyAndConsumeStudySessionBoot,
} from './native-qa-session.mjs';
import { createMemoryStudySessionConsumptionAnchor } from './native-qa-session-anchor.mjs';

const FIRST_UUID = '00112233-4455-4677-8899-aabbccddeeff';

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
    sourceState: {
      gitSha: 'a'.repeat(40), sourceTreeSha: 'b'.repeat(40), sourceDirty: false,
      sourceStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  });
  return { root, appBundle, executable };
}

test('launch-existing fresh returns after boot without rebuilding or mutating static provenance', async () => {
  const { root, appBundle, executable } = studyBundle();
  const statePath = join(root, 'session.json');
  const provenancePath = qaBuildProvenancePath(appBundle);
  const beforeProvenance = readFileSync(provenancePath);
  const beforeExecutable = readFileSync(executable);
  let unrefCalled = false;
  let spawnedExecutable;

  const receipt = await launchExistingProviderFreeStudyApp({
    appBundle,
    statePath,
    fresh: true,
    platform: 'darwin',
    productVersion: '14.6',
    randomUUID: () => FIRST_UUID,
    readBundleIdentifier: () => 'com.paintnode.editor.blueprintqa.provider.free',
    spawn(executablePath, _args, options) {
      spawnedExecutable = executablePath;
      const profileBytes = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_PROFILE, 'hex');
      const bootNonce = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_NONCE, 'hex');
      writeFileSync(options.env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_EVIDENCE, JSON.stringify({
        version: 3,
        event: 'app-boot',
        profileSha256: createHash('sha256').update(profileBytes).digest('hex'),
        bootNonceSha256: createHash('sha256').update(bootNonce).digest('hex'),
        buildIdentitySha256: options.env.PAINTNODE_PROVIDER_FREE_STUDY_BUILD_IDENTITY,
      }));
      return { exitCode: null, unref() { unrefCalled = true; } };
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
  const readBundleIdentifier = () => 'com.paintnode.editor.blueprintqa.provider.free';
  assert.equal(readExistingStudyApp({ appBundle, readBundleIdentifier }).provenance.studyCapable, true);

  const provenancePath = qaBuildProvenancePath(appBundle);
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  writeFileSync(provenancePath, JSON.stringify({ ...provenance, studySession: { launchIntent: 'fresh' } }));
  assert.throws(() => readExistingStudyApp({ appBundle, readBundleIdentifier }), /static provenance/i);
  writeFileSync(provenancePath, JSON.stringify(provenance));
  writeFileSync(executable, '#!/bin/sh\nexit 9\n');
  assert.throws(() => readExistingStudyApp({ appBundle, readBundleIdentifier }), /executable fingerprint/i);

  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  const valid = JSON.stringify(provenance);
  writeFileSync(provenancePath, valid.replace('{', '{"studyCapable":false,'));
  assert.throws(() => readExistingStudyApp({ appBundle, readBundleIdentifier }), /duplicate field studyCapable/i);
});

test('fresh launch rejects child exit, hung boot, and executable swap', async () => {
  for (const failure of ['exit', 'timeout', 'swap']) {
    const { root, appBundle, executable } = studyBundle();
    const statePath = join(root, 'session.json');
    await assert.rejects(() => launchExistingProviderFreeStudyApp({
      appBundle,
      statePath,
      fresh: true,
      platform: 'darwin',
      productVersion: '14.6',
      randomUUID: () => FIRST_UUID,
      readBundleIdentifier: () => 'com.paintnode.editor.blueprintqa.provider.free',
      bootTimeoutMs: 2,
      bootPollMs: 1,
      spawn(_executablePath, _args, options) {
        if (failure === 'swap') {
          const profileBytes = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_PROFILE, 'hex');
          const bootNonce = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_NONCE, 'hex');
          writeFileSync(options.env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_EVIDENCE, JSON.stringify({
            version: 3, event: 'app-boot',
            profileSha256: createHash('sha256').update(profileBytes).digest('hex'),
            bootNonceSha256: createHash('sha256').update(bootNonce).digest('hex'),
            buildIdentitySha256: options.env.PAINTNODE_PROVIDER_FREE_STUDY_BUILD_IDENTITY,
          }));
          writeFileSync(executable, '#!/bin/sh\nexit 7\n');
        }
        return {
          exitCode: failure === 'exit' ? 9 : null,
          kill() {},
          unref() {},
        };
      },
    }), failure === 'exit' ? /exited before verified boot/i
      : failure === 'timeout' ? /timed out/i : /fingerprint|changed during launch/i);
  }
});

test('resume uses the same preserved bundle without fresh boot evidence', async () => {
  const { root, appBundle } = studyBundle();
  const statePath = join(root, 'session.json');
  const spawnFresh = (_executablePath, _args, options) => {
    const profileBytes = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_PROFILE, 'hex');
    const bootNonce = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_NONCE, 'hex');
    writeFileSync(options.env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_EVIDENCE, JSON.stringify({
      version: 3, event: 'app-boot',
      profileSha256: createHash('sha256').update(profileBytes).digest('hex'),
      bootNonceSha256: createHash('sha256').update(bootNonce).digest('hex'),
      buildIdentitySha256: options.env.PAINTNODE_PROVIDER_FREE_STUDY_BUILD_IDENTITY,
    }));
    return { exitCode: null, unref() {} };
  };
  const fresh = await launchExistingProviderFreeStudyApp({
    appBundle, statePath, fresh: true, platform: 'darwin', productVersion: '14.6',
    randomUUID: () => FIRST_UUID,
    readBundleIdentifier: () => 'com.paintnode.editor.blueprintqa.provider.free',
    spawn: spawnFresh,
  });
  verifyAndConsumeStudySessionBoot({
    statePath,
    profileSha256: fresh.profileSha256,
    buildIdentitySha256: fresh.buildIdentitySha256,
    provenanceSha256: readExistingStudyApp({
      appBundle,
      readBundleIdentifier: () => 'com.paintnode.editor.blueprintqa.provider.free',
    }).provenanceSha256,
    executableSha256: readExistingStudyApp({
      appBundle,
      readBundleIdentifier: () => 'com.paintnode.editor.blueprintqa.provider.free',
    }).executableSha256,
    consumptionAnchor: createMemoryStudySessionConsumptionAnchor(),
  });
  const bootBefore = readFileSync(studySessionBootEvidencePath(statePath));
  let resumeEnv;
  const resumed = await launchExistingProviderFreeStudyApp({
    appBundle, statePath, resume: true, platform: 'darwin', productVersion: '14.6',
    readBundleIdentifier: () => 'com.paintnode.editor.blueprintqa.provider.free',
    spawn(_executablePath, _args, options) {
      resumeEnv = options.env;
      return { exitCode: null, unref() {} };
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
  const spawnBoot = (_executablePath, _args, options) => {
    const profileBytes = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_PROFILE, 'hex');
    const bootNonce = Buffer.from(options.env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_NONCE, 'hex');
    writeFileSync(options.env.PAINTNODE_PROVIDER_FREE_STUDY_BOOT_EVIDENCE, JSON.stringify({
      version: 3, event: 'app-boot',
      profileSha256: createHash('sha256').update(profileBytes).digest('hex'),
      bootNonceSha256: createHash('sha256').update(bootNonce).digest('hex'),
      buildIdentitySha256: options.env.PAINTNODE_PROVIDER_FREE_STUDY_BUILD_IDENTITY,
    }));
    return { exitCode: null, unref() {} };
  };
  const options = {
    appBundle, statePath, fresh: true, platform: 'darwin', productVersion: '14.6',
    randomUUID: () => FIRST_UUID,
    readBundleIdentifier: () => 'com.paintnode.editor.blueprintqa.provider.free',
    spawn: spawnBoot,
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
    readBundleIdentifier: () => 'com.paintnode.editor.blueprintqa.provider.free',
  }), /non-symlink/i);
});

test('launch-existing source contains no build tool invocation', () => {
  const source = readFileSync(new URL('./native-qa-study-launch.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /tauri\s+build|vite\s+build|build:quicklook|npm\s+run\s+build/);
  const finalizeSource = readFileSync(new URL('./native-qa-session-finalize.mjs', import.meta.url), 'utf8');
  assert.match(finalizeSource, /readStudySessionLaunchBinding/);
  assert.doesNotMatch(finalizeSource, /target\/debug\/bundle\/macos/);
});
