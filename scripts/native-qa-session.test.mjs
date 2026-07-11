import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  abortStudySessionWithoutNativeCleanup,
  applyStudySessionWindowIsolation,
  assertProviderFreeStudyPlatform,
  createFreshProviderFreeStudySession,
  markStudySessionLaunchAttempted,
  readProviderFreeStudySession,
  resolveProviderFreeStudySession,
  providerFreeStudyProfileEnvironment,
  prepareStudySessionCleanup,
  studySessionBootEvidencePath,
  studySessionConsumeLockPath,
  studySessionLaunchEvidencePath,
  verifyAndConsumeStudySessionBoot,
  verifyAndFinalizeStudySessionCleanup,
  studySessionBuildEvidence,
  studySessionBuildOnlyEvidence,
  writeProviderFreeStudySession,
} from './native-qa-session.mjs';
import { createMemoryStudySessionConsumptionAnchor } from './native-qa-session-anchor.mjs';

const FIRST_UUID = '00112233-4455-4677-8899-aabbccddeeff';
const SECOND_UUID = 'ffeeddcc-bbaa-4988-8776-554433221100';
const BUILD_IDENTITY = 'a'.repeat(64);
const PROVENANCE_IDENTITY = 'b'.repeat(64);
const EXECUTABLE_IDENTITY = 'c'.repeat(64);

function boot(session, statePath) {
  writeFileSync(studySessionBootEvidencePath(statePath), JSON.stringify({
    version: 3,
    event: 'app-boot',
    profileSha256: session.profileSha256,
    bootNonceSha256: session.bootNonceSha256,
    buildIdentitySha256: BUILD_IDENTITY,
  }));
  writeFileSync(studySessionLaunchEvidencePath(statePath), JSON.stringify({
    version: 1,
    event: 'study-launch',
    launchIntent: 'fresh',
    profileSha256: session.profileSha256,
    buildIdentitySha256: BUILD_IDENTITY,
    provenanceSha256: PROVENANCE_IDENTITY,
    executableSha256: EXECUTABLE_IDENTITY,
  }));
}

test('fresh study sessions receive distinct isolated WebKit profiles', () => {
  const first = createFreshProviderFreeStudySession({ randomUUID: () => FIRST_UUID });
  const second = createFreshProviderFreeStudySession({ randomUUID: () => SECOND_UUID });

  assert.deepEqual(first.dataStoreIdentifier, [
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x46, 0x77,
    0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff,
  ]);
  assert.notDeepEqual(first.dataStoreIdentifier, second.dataStoreIdentifier);
  assert.notEqual(first.profileSha256, second.profileSha256);
  assert.deepEqual(
    applyStudySessionWindowIsolation({ title: 'Provider Free' }, first),
    { title: 'Provider Free', create: false },
  );
});

test('resume reads the exact profile while build evidence omits the raw identifier', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-free-session-'));
  const statePath = join(root, 'session.json');
  const session = createFreshProviderFreeStudySession({ randomUUID: () => FIRST_UUID });
  writeProviderFreeStudySession(statePath, session);

  const resumed = readProviderFreeStudySession(statePath);
  assert.deepEqual(resumed, session);
  assert.equal(readFileSync(statePath, 'utf8').endsWith('\n'), true);

  const freshEvidence = studySessionBuildEvidence(session, 'fresh');
  const resumeEvidence = studySessionBuildEvidence(resumed, 'resume');
  assert.deepEqual(freshEvidence, {
    version: 3,
    isolatedProfile: true,
    launchIntent: 'fresh',
    profileSha256: session.profileSha256,
  });
  assert.equal(JSON.stringify(freshEvidence).includes(FIRST_UUID), false);
  assert.equal(JSON.stringify(freshEvidence).includes('dataStoreIdentifier'), false);
  assert.equal(resumeEvidence.launchIntent, 'resume');
  assert.equal(resumeEvidence.profileSha256, freshEvidence.profileSha256);
});

test('runtime profile environment is exact hex and remains outside provenance', () => {
  const session = createFreshProviderFreeStudySession({ randomUUID: () => FIRST_UUID });
  assert.equal(providerFreeStudyProfileEnvironment(session), FIRST_UUID.replaceAll('-', ''));
  assert.equal(JSON.stringify(studySessionBuildEvidence(session, 'fresh')).includes('00112233'), false);
});

test('session state rejects malformed or mismatched profile evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-free-session-invalid-'));
  const statePath = join(root, 'session.json');
  writeFileSync(statePath, JSON.stringify({
    version: 3,
    dataStoreIdentifier: Array(16).fill(0),
    profileSha256: 'f'.repeat(64),
    bootNonce: 'a'.repeat(64), bootNonceSha256: 'b'.repeat(64),
    launchAttempted: false, setupConsumed: false,
  }));
  assert.throws(() => readProviderFreeStudySession(statePath), /fingerprint/i);

  writeFileSync(statePath, JSON.stringify({
    version: 3,
    dataStoreIdentifier: Array(15).fill(0),
    profileSha256: 'f'.repeat(64),
    bootNonce: 'a'.repeat(64), bootNonceSha256: 'b'.repeat(64),
    launchAttempted: false, setupConsumed: false,
  }));
  assert.throws(() => readProviderFreeStudySession(statePath), /16 bytes/i);
});

test('study isolation is opt-in for Provider Free and resumed state fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-free-launch-'));
  const statePath = join(root, 'session.json');
  assert.equal(resolveProviderFreeStudySession({ mode: 'provider-free', statePath }), null);
  assert.equal(resolveProviderFreeStudySession({ mode: 'provider-e2e', statePath }), null);
  assert.throws(
    () => resolveProviderFreeStudySession({ mode: 'provider-e2e', fresh: true, statePath }),
    /only in Provider Free mode/i,
  );
  assert.throws(
    () => resolveProviderFreeStudySession({ mode: 'provider-free', resume: true, statePath }),
    /Start a fresh study session first/i,
  );

  const fresh = resolveProviderFreeStudySession({
    mode: 'provider-free', fresh: true, statePath, randomUUID: () => FIRST_UUID,
  });
  markStudySessionLaunchAttempted(statePath);
  assert.throws(
    () => resolveProviderFreeStudySession({ mode: 'provider-free', fresh: true, statePath }),
    /prior.*finalized/i,
  );
  boot(fresh.session, statePath);
  assert.deepEqual(verifyAndConsumeStudySessionBoot({
    statePath, profileSha256: fresh.session.profileSha256,
    buildIdentitySha256: BUILD_IDENTITY,
    provenanceSha256: PROVENANCE_IDENTITY,
    executableSha256: EXECUTABLE_IDENTITY,
    consumptionAnchor: createMemoryStudySessionConsumptionAnchor(),
  }), {
    appBootObserved: true,
    setupEvidenceConsumed: true,
    monotonicAnchorRecorded: true,
  });
  assert.throws(
    () => verifyAndConsumeStudySessionBoot({
      statePath,
      profileSha256: fresh.session.profileSha256,
      buildIdentitySha256: BUILD_IDENTITY,
      provenanceSha256: PROVENANCE_IDENTITY,
      executableSha256: EXECUTABLE_IDENTITY,
      consumptionAnchor: createMemoryStudySessionConsumptionAnchor([fresh.session.profileSha256]),
    }),
    /already been consumed/i,
  );
  const resume = resolveProviderFreeStudySession({ mode: 'provider-free', resume: true, statePath });
  assert.equal(fresh.launchIntent, 'fresh');
  assert.equal(resume.launchIntent, 'resume');
  assert.equal(resume.session.profileSha256, fresh.session.profileSha256);
  assert.equal(resume.session.setupConsumed, true);
});

test('losing concurrent fresh claim cannot delete winner lifecycle evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-free-claim-race-'));
  const statePath = join(root, 'session.json');
  let winner;
  assert.throws(() => resolveProviderFreeStudySession({
    mode: 'provider-free',
    fresh: true,
    statePath,
    randomUUID: () => SECOND_UUID,
    beforeFreshStateClaim() {
      winner = resolveProviderFreeStudySession({
        mode: 'provider-free', fresh: true, statePath, randomUUID: () => FIRST_UUID,
      });
      boot(winner.session, statePath);
    },
  }), /prior.*finalized/i);
  assert.equal(readProviderFreeStudySession(statePath).profileSha256, winner.session.profileSha256);
  assert.equal(existsSync(studySessionBootEvidencePath(statePath)), true);
  assert.equal(existsSync(studySessionLaunchEvidencePath(statePath)), true);
});

test('snapshot rollback cannot replay consumption outside the monotonic single-Mac anchor', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-free-rollback-'));
  const statePath = join(root, 'session.json');
  const anchor = createMemoryStudySessionConsumptionAnchor();
  const fresh = resolveProviderFreeStudySession({
    mode: 'provider-free', fresh: true, statePath, randomUUID: () => FIRST_UUID,
  });
  markStudySessionLaunchAttempted(statePath);
  boot(fresh.session, statePath);
  const stateSnapshot = readFileSync(statePath);
  const bootSnapshot = readFileSync(studySessionBootEvidencePath(statePath));
  verifyAndConsumeStudySessionBoot({
    statePath, profileSha256: fresh.session.profileSha256,
    buildIdentitySha256: BUILD_IDENTITY, consumptionAnchor: anchor,
    provenanceSha256: PROVENANCE_IDENTITY, executableSha256: EXECUTABLE_IDENTITY,
  });
  writeFileSync(statePath, stateSnapshot);
  writeFileSync(studySessionBootEvidencePath(statePath), bootSnapshot);
  assert.throws(() => verifyAndConsumeStudySessionBoot({
    statePath, profileSha256: fresh.session.profileSha256,
    buildIdentitySha256: BUILD_IDENTITY, consumptionAnchor: anchor,
    provenanceSha256: PROVENANCE_IDENTITY, executableSha256: EXECUTABLE_IDENTITY,
  }), /monotonic single-Mac anchor.*already consumed/i);
});

test('build-only allocates no live state and unlaunched failure can be aborted', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-free-lifecycle-'));
  const statePath = join(root, 'session.json');
  const buildOnly = resolveProviderFreeStudySession({
    mode: 'provider-free', fresh: true, buildOnly: true, statePath,
  });
  assert.deepEqual(buildOnly, { session: null, launchIntent: 'build-only' });
  assert.deepEqual(studySessionBuildOnlyEvidence(), {
    version: 3, isolatedProfile: false, launchIntent: 'build-only',
  });
  assert.equal(existsSync(statePath), false);

  const fresh = resolveProviderFreeStudySession({
    mode: 'provider-free', fresh: true, statePath, randomUUID: () => FIRST_UUID,
  });
  const prepared = prepareStudySessionCleanup(statePath, {
    intent: 'abort', randomBytes: () => Buffer.alloc(32, 7),
  });
  assert.equal(prepared.requiresNativeCleanup, false);
  assert.deepEqual(abortStudySessionWithoutNativeCleanup(statePath, prepared), {
    profileSha256: fresh.session.profileSha256,
    dataStoreRemoved: false,
    dataStoreCreated: false,
    aborted: true,
    finalized: true,
  });
  assert.equal(existsSync(statePath), false);
});

test('pre-setup launch abort requires native data-store cleanup and releases the next session', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-free-pre-setup-abort-'));
  const statePath = join(root, 'session.json');
  const fresh = resolveProviderFreeStudySession({
    mode: 'provider-free', fresh: true, statePath, randomUUID: () => FIRST_UUID,
  });
  markStudySessionLaunchAttempted(statePath);
  boot(fresh.session, statePath);
  const cleanup = prepareStudySessionCleanup(statePath, {
    intent: 'abort', randomBytes: () => Buffer.alloc(32, 7),
  });
  assert.equal(cleanup.requiresNativeCleanup, true);
  writeFileSync(studySessionConsumeLockPath(statePath), 'stale setup crash lock');
  writeFileSync(cleanup.evidencePath, JSON.stringify({
    version: 3,
    event: 'profile-removed',
    profileSha256: fresh.session.profileSha256,
    cleanupNonceSha256: cleanup.cleanupNonceSha256,
  }));
  assert.deepEqual(verifyAndFinalizeStudySessionCleanup(statePath, cleanup), {
    profileSha256: fresh.session.profileSha256,
    dataStoreRemoved: true,
    dataStoreRemovalVerified: true,
    aborted: true,
    finalized: true,
  });
  assert.equal(existsSync(statePath), false);
  assert.equal(existsSync(studySessionConsumeLockPath(statePath)), false);
  const next = resolveProviderFreeStudySession({
    mode: 'provider-free', fresh: true, statePath, randomUUID: () => SECOND_UUID,
  });
  assert.notEqual(next.session.profileSha256, fresh.session.profileSha256);
});

test('consumed same-session resume ends through normal verified finalization', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-free-finalize-'));
  const statePath = join(root, 'session.json');
  const fresh = resolveProviderFreeStudySession({
    mode: 'provider-free', fresh: true, statePath, randomUUID: () => FIRST_UUID,
  });
  markStudySessionLaunchAttempted(statePath);
  boot(fresh.session, statePath);
  verifyAndConsumeStudySessionBoot({
    statePath,
    profileSha256: fresh.session.profileSha256,
    buildIdentitySha256: BUILD_IDENTITY,
    provenanceSha256: PROVENANCE_IDENTITY,
    executableSha256: EXECUTABLE_IDENTITY,
    consumptionAnchor: createMemoryStudySessionConsumptionAnchor(),
  });
  assert.equal(resolveProviderFreeStudySession({
    mode: 'provider-free', resume: true, statePath,
  }).launchIntent, 'resume');
  const cleanup = prepareStudySessionCleanup(statePath, {
    intent: 'finalize', randomBytes: () => Buffer.alloc(32, 9),
  });
  assert.equal(cleanup.requiresNativeCleanup, true);
  writeFileSync(cleanup.evidencePath, JSON.stringify({
    version: 3,
    event: 'profile-removed',
    profileSha256: fresh.session.profileSha256,
    cleanupNonceSha256: cleanup.cleanupNonceSha256,
  }));
  assert.deepEqual(verifyAndFinalizeStudySessionCleanup(statePath, cleanup), {
    profileSha256: fresh.session.profileSha256,
    dataStoreRemoved: true,
    dataStoreRemovalVerified: true,
    aborted: false,
    finalized: true,
  });
});

test('study isolation fails closed where persistent WebKit data stores are unavailable', () => {
  assert.equal(assertProviderFreeStudyPlatform('darwin', '14.0'), 14);
  assert.equal(assertProviderFreeStudyPlatform('darwin', '26.1.2'), 26);
  assert.throws(() => assertProviderFreeStudyPlatform('darwin', '13.6.9'), /macOS 14/i);
  assert.throws(() => assertProviderFreeStudyPlatform('linux', '6.0'), /macOS 14/i);
  assert.throws(() => assertProviderFreeStudyPlatform('darwin', 'unknown'), /version/i);
});
