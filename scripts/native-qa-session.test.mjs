import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyStudySessionWindowIsolation,
  assertProviderFreeStudyPlatform,
  createFreshProviderFreeStudySession,
  readProviderFreeStudySession,
  resolveProviderFreeStudySession,
  providerFreeStudyProfileEnvironment,
  prepareStudySessionCleanup,
  studySessionBootEvidencePath,
  verifyAndConsumeStudySessionBoot,
  verifyAndFinalizeStudySessionCleanup,
  studySessionBuildEvidence,
  writeProviderFreeStudySession,
} from './native-qa-session.mjs';

const FIRST_UUID = '00112233-4455-4677-8899-aabbccddeeff';
const SECOND_UUID = 'ffeeddcc-bbaa-4988-8776-554433221100';

function boot(session, statePath) {
  writeFileSync(studySessionBootEvidencePath(statePath), JSON.stringify({
    version: 2,
    event: 'app-boot',
    profileSha256: session.profileSha256,
    bootNonceSha256: session.bootNonceSha256,
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
    version: 2,
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
    version: 2,
    dataStoreIdentifier: Array(16).fill(0),
    profileSha256: 'f'.repeat(64),
    bootNonce: 'a'.repeat(64), bootNonceSha256: 'b'.repeat(64), setupConsumed: false,
  }));
  assert.throws(() => readProviderFreeStudySession(statePath), /fingerprint/i);

  writeFileSync(statePath, JSON.stringify({
    version: 2,
    dataStoreIdentifier: Array(15).fill(0),
    profileSha256: 'f'.repeat(64),
    bootNonce: 'a'.repeat(64), bootNonceSha256: 'b'.repeat(64), setupConsumed: false,
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
  assert.throws(
    () => resolveProviderFreeStudySession({ mode: 'provider-free', fresh: true, statePath }),
    /prior.*finalized/i,
  );
  boot(fresh.session, statePath);
  assert.deepEqual(verifyAndConsumeStudySessionBoot({
    statePath, profileSha256: fresh.session.profileSha256,
  }), { appBootObserved: true, setupEvidenceConsumed: true });
  assert.throws(
    () => verifyAndConsumeStudySessionBoot({ statePath, profileSha256: fresh.session.profileSha256 }),
    /already been consumed/i,
  );
  const resume = resolveProviderFreeStudySession({ mode: 'provider-free', resume: true, statePath });
  assert.equal(fresh.launchIntent, 'fresh');
  assert.equal(resume.launchIntent, 'resume');
  assert.equal(resume.session.profileSha256, fresh.session.profileSha256);
  assert.equal(resume.session.setupConsumed, true);
});

test('build-only cannot produce boot evidence and cleanup finalization releases the next session', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-free-lifecycle-'));
  const statePath = join(root, 'session.json');
  const fresh = resolveProviderFreeStudySession({
    mode: 'provider-free', fresh: true, statePath, randomUUID: () => FIRST_UUID,
  });
  assert.equal(studySessionBuildEvidence(fresh.session, 'build-only').launchIntent, 'build-only');
  assert.throws(
    () => verifyAndConsumeStudySessionBoot({ statePath, profileSha256: fresh.session.profileSha256 }),
    /boot evidence is missing/i,
  );
  boot(fresh.session, statePath);
  verifyAndConsumeStudySessionBoot({ statePath, profileSha256: fresh.session.profileSha256 });
  const cleanup = prepareStudySessionCleanup(statePath, { randomBytes: () => Buffer.alloc(32, 7) });
  writeFileSync(cleanup.evidencePath, JSON.stringify({
    version: 2,
    event: 'profile-removed',
    profileSha256: fresh.session.profileSha256,
    cleanupNonceSha256: cleanup.cleanupNonceSha256,
  }));
  assert.deepEqual(verifyAndFinalizeStudySessionCleanup(statePath, cleanup), {
    profileSha256: fresh.session.profileSha256, dataStoreRemoved: true, finalized: true,
  });
  assert.equal(existsSync(statePath), false);
  const next = resolveProviderFreeStudySession({
    mode: 'provider-free', fresh: true, statePath, randomUUID: () => SECOND_UUID,
  });
  assert.notEqual(next.session.profileSha256, fresh.session.profileSha256);
});

test('study isolation fails closed where persistent WebKit data stores are unavailable', () => {
  assert.equal(assertProviderFreeStudyPlatform('darwin', '14.0'), 14);
  assert.equal(assertProviderFreeStudyPlatform('darwin', '26.1.2'), 26);
  assert.throws(() => assertProviderFreeStudyPlatform('darwin', '13.6.9'), /macOS 14/i);
  assert.throws(() => assertProviderFreeStudyPlatform('linux', '6.0'), /macOS 14/i);
  assert.throws(() => assertProviderFreeStudyPlatform('darwin', 'unknown'), /version/i);
});
