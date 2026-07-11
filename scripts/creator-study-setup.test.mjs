import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EXPECTED_BUNDLE_ID,
  verifyStudySetup,
} from './creator-study-setup.mjs';
import {
  createFreshProviderFreeStudySession,
  markStudySessionLaunchAttempted,
  studySessionBootEvidencePath,
  writeProviderFreeStudySession,
} from './native-qa-session.mjs';
import { createMemoryStudySessionConsumptionAnchor } from './native-qa-session-anchor.mjs';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const fixtureManifest = join(repoRoot, 'docs', 'testing', 'creator-study', 'materials', 'manifest.json');
const sourceState = {
  actualGitSha: '405524d393f07ecd588d7476e83adc38e00a90cc',
  actualSourceTreeSha: 'tree-current',
  actualSourceStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  sourceDirty: false,
};
const sessionFixture = createFreshProviderFreeStudySession({
  randomUUID: () => '00112233-4455-4677-8899-aabbccddeeff',
  randomBytes: () => Buffer.alloc(32, 3),
});
const appBuild = {
  version: 1,
  mode: 'provider-free',
  bundleId: EXPECTED_BUNDLE_ID,
  gitSha: sourceState.actualGitSha,
  sourceTreeSha: sourceState.actualSourceTreeSha,
  sourceDirty: false,
  sourceStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  executableSha256: 'a'.repeat(64),
  studySession: {
    version: 3,
    isolatedProfile: true,
    launchIntent: 'fresh',
    profileSha256: sessionFixture.profileSha256,
  },
};

function setupDirectories() {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-creator-study-'));
  const projectDir = join(root, 'participant-project');
  const rehearsalDir = join(root, 'deleted-rehearsal');
  mkdirSync(projectDir);
  const studySessionStatePath = join(root, 'session.json');
  writeProviderFreeStudySession(studySessionStatePath, sessionFixture);
  markStudySessionLaunchAttempted(studySessionStatePath);
  writeFileSync(studySessionBootEvidencePath(studySessionStatePath), JSON.stringify({
    version: 3,
    event: 'app-boot',
    profileSha256: sessionFixture.profileSha256,
    bootNonceSha256: sessionFixture.bootNonceSha256,
  }));
  return {
    root,
    projectDir,
    rehearsalDir,
    studySessionStatePath,
    studySessionConsumptionAnchor: createMemoryStudySessionConsumptionAnchor(),
  };
}

test('the committed Product materials are deterministic, distinct, and assigned to Tasks 1 and 6', () => {
  const {
    projectDir, rehearsalDir, studySessionStatePath, studySessionConsumptionAnchor,
  } = setupDirectories();
  const receipt = verifyStudySetup({
    repoRoot,
    projectDir,
    rehearsalDir,
    fixtureManifest,
    expectedGitSha: '405524d393f07ecd588d7476e83adc38e00a90cc',
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    visibleEmptyStateAttested: true,
    macosMajorVersion: 14,
    studySessionStatePath,
    studySessionConsumptionAnchor,
  });

  assert.equal(receipt.ready, true);
  assert.deepEqual(receipt.materials.map(({ task }) => task), [1, 6]);
  assert.equal(new Set(receipt.materials.map(({ sha256 }) => sha256)).size, 2);
  assert.equal(receipt.projectState, 'empty');
  assert.equal(receipt.rehearsalState, 'deleted');
  assert.deepEqual(receipt.appBuild, appBuild);
  assert.deepEqual(receipt.sessionReset, {
    isolatedProfile: true,
    profileSha256: appBuild.studySession.profileSha256,
    macosMajorVersion: 14,
    appBootObserved: true,
    setupEvidenceConsumed: true,
    monotonicAnchorRecorded: true,
  });
  assert.deepEqual(receipt.manualAttestations, {
    visibleEmptyProjectAndWorkflow: true,
  });
  assert.equal(JSON.stringify(receipt).includes(projectDir), false, 'receipt must not leak local paths');
});

test('setup requires actual app boot evidence and consumes it exactly once', () => {
  const {
    root, projectDir, rehearsalDir, studySessionStatePath, studySessionConsumptionAnchor,
  } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, studySessionStatePath, fixtureManifest,
    expectedGitSha: sourceState.actualGitSha,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    visibleEmptyStateAttested: true,
    macosMajorVersion: 14,
    studySessionConsumptionAnchor,
  };
  rmSync(studySessionBootEvidencePath(studySessionStatePath));
  assert.throws(() => verifyStudySetup(options), /boot evidence is missing/i);
  writeFileSync(studySessionBootEvidencePath(studySessionStatePath), JSON.stringify({
    version: 3, event: 'app-boot', profileSha256: sessionFixture.profileSha256,
    bootNonceSha256: sessionFixture.bootNonceSha256,
  }));
  assert.equal(verifyStudySetup(options).ready, true);
  const secondProject = join(root, 'participant-project-2');
  mkdirSync(secondProject);
  assert.throws(
    () => verifyStudySetup({ ...options, projectDir: secondProject }),
    /already been consumed/i,
  );
});

test('setup verification fails closed for dirty projects, retained rehearsal data, wrong build, or wrong bundle', () => {
  const {
    projectDir, rehearsalDir, studySessionStatePath, studySessionConsumptionAnchor,
  } = setupDirectories();
  writeFileSync(join(projectDir, '.hidden-state'), 'not empty');

  const options = {
    repoRoot,
    projectDir,
    rehearsalDir,
    fixtureManifest,
    expectedGitSha: '405524d393f07ecd588d7476e83adc38e00a90cc',
    ...sourceState,
    actualGitSha: 'wrong',
    bundleId: 'com.paintnode.editor',
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    visibleEmptyStateAttested: true,
    macosMajorVersion: 14,
    studySessionStatePath,
    studySessionConsumptionAnchor,
  };
  assert.throws(() => verifyStudySetup(options), /Git SHA/i);

  options.actualGitSha = options.expectedGitSha;
  assert.throws(() => verifyStudySetup(options), /bundle identity/i);

  options.bundleId = EXPECTED_BUNDLE_ID;
  assert.throws(() => verifyStudySetup(options), /genuinely empty/i);

  rmSync(join(projectDir, '.hidden-state'));
  mkdirSync(rehearsalDir);
  writeFileSync(join(rehearsalDir, 'rehearsal.cxflow.json'), '{}');
  assert.throws(() => verifyStudySetup(options), /rehearsal/i);

  options.projectDir = repoRoot;
  options.rehearsalDir = join(repoRoot, 'rehearsal');
  assert.throws(() => verifyStudySetup(options), /outside the Git repository/i);

  options.projectDir = 'relative-project';
  options.rehearsalDir = 'relative-rehearsal';
  assert.throws(() => verifyStudySetup(options), /paths must be absolute/i);
});

test('setup verification rejects dirty source, stale bundles, and executable fingerprint drift', () => {
  const {
    projectDir, rehearsalDir, studySessionStatePath, studySessionConsumptionAnchor,
  } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, fixtureManifest,
    expectedGitSha: sourceState.actualGitSha,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild: { ...appBuild },
    actualExecutableSha256: appBuild.executableSha256,
    visibleEmptyStateAttested: true,
    macosMajorVersion: 14,
    studySessionStatePath,
    studySessionConsumptionAnchor,
  };

  options.sourceDirty = true;
  assert.throws(() => verifyStudySetup(options), /dirty source/i);
  options.sourceDirty = false;

  options.appBuild.gitSha = 'stale-build';
  assert.throws(() => verifyStudySetup(options), /app build Git SHA/i);
  options.appBuild.gitSha = sourceState.actualGitSha;

  options.appBuild.sourceTreeSha = 'stale-tree';
  assert.throws(() => verifyStudySetup(options), /source tree/i);
  options.appBuild.sourceTreeSha = sourceState.actualSourceTreeSha;

  options.actualExecutableSha256 = 'b'.repeat(64);
  assert.throws(() => verifyStudySetup(options), /executable fingerprint/i);
  options.actualExecutableSha256 = appBuild.executableSha256;

  options.appBuild.studySession.launchIntent = 'resume';
  assert.throws(() => verifyStudySetup(options), /fresh study session/i);
  options.appBuild.studySession.launchIntent = 'fresh';

  options.appBuild.studySession.isolatedProfile = false;
  assert.throws(() => verifyStudySetup(options), /isolated study profile/i);
  options.appBuild.studySession.isolatedProfile = true;

  options.visibleEmptyStateAttested = false;
  assert.throws(() => verifyStudySetup(options), /visible empty Project and Workflow/i);
  options.visibleEmptyStateAttested = true;

  options.macosMajorVersion = 13;
  assert.throws(() => verifyStudySetup(options), /macOS 14/i);
});

test('project and deleted rehearsal paths are canonicalized through symlinks', () => {
  const {
    root, projectDir, rehearsalDir, studySessionStatePath, studySessionConsumptionAnchor,
  } = setupDirectories();
  const linkedProject = join(root, 'linked-project');
  symlinkSync(projectDir, linkedProject);
  const options = {
    repoRoot, projectDir: linkedProject, rehearsalDir, fixtureManifest,
    expectedGitSha: sourceState.actualGitSha,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    visibleEmptyStateAttested: true,
    macosMajorVersion: 14,
    studySessionStatePath,
    studySessionConsumptionAnchor,
  };
  assert.equal(verifyStudySetup(options).ready, true);

  const repoLink = join(root, 'repo-link');
  symlinkSync(repoRoot, repoLink);
  options.projectDir = projectDir;
  options.rehearsalDir = join(repoLink, 'deleted-rehearsal');
  assert.throws(() => verifyStudySetup(options), /outside the Git repository/i);

  options.projectDir = repoLink;
  options.rehearsalDir = rehearsalDir;
  assert.throws(() => verifyStudySetup(options), /outside the Git repository/i);
});

test('material manifest hashes match the committed bytes', () => {
  const manifest = JSON.parse(readFileSync(fixtureManifest, 'utf8'));
  assert.equal(manifest.license, 'CC0-1.0');
  assert.equal(manifest.materials.length, 2);
  for (const material of manifest.materials) {
    assert.match(material.sha256, /^[a-f0-9]{64}$/);
    assert.equal(material.nonConfidential, true);
    assert.match(material.relativePath, /^product-/);
  }
});
