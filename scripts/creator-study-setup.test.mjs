import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EXPECTED_BUNDLE_ID,
  verifyStudySetup,
} from './creator-study-setup.mjs';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const fixtureManifest = join(repoRoot, 'docs', 'testing', 'creator-study', 'materials', 'manifest.json');
const sourceState = {
  actualGitSha: '405524d393f07ecd588d7476e83adc38e00a90cc',
  actualSourceTreeSha: 'b'.repeat(40),
  actualSourceStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  sourceDirty: false,
};
const appBuild = {
  version: 1,
  mode: 'provider-free',
  bundleId: EXPECTED_BUNDLE_ID,
  gitSha: sourceState.actualGitSha,
  sourceTreeSha: sourceState.actualSourceTreeSha,
  sourceDirty: false,
  sourceStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  executableSha256: 'a'.repeat(64),
};

function approvedBuildRecord(overrides = {}) {
  return {
    _copyWarning: 'COPY OUTSIDE REPOSITORY — complete only in approved restricted research storage.',
    _privacyWarning: 'PRIVATE ONLY. Never complete this record in GitHub, a checkout, worktree, chat, or participant project.',
    schemaVersion: 1,
    recordType: 'paintnode-creator-study-approved-build',
    approvedBuild: { ...appBuild },
    approval: {
      ownerApproved: true,
      approvedAt: '2026-07-11T09:30:00.000Z',
      decisionReference: 'CB-M2-BUILD-BASELINE-01',
    },
    changeControl: {
      kind: 'initial',
      replacesDecisionReference: null,
      reason: null,
      rehearsalCompletedAt: '2026-07-11T09:00:00.000Z',
      comparabilityDecision: 'baseline',
    },
    ...overrides,
  };
}

function writeApprovedBuildRecord(root, record = approvedBuildRecord()) {
  const path = join(root, 'approved-build.private.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function setupDirectories() {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-creator-study-'));
  const projectDir = join(root, 'participant-project');
  const rehearsalDir = join(root, 'deleted-rehearsal');
  mkdirSync(projectDir);
  const approvedBuildRecordPath = writeApprovedBuildRecord(root);
  return { root, projectDir, rehearsalDir, approvedBuildRecordPath };
}

test('the committed Product materials are deterministic, distinct, and assigned to Tasks 1 and 6', () => {
  const { projectDir, rehearsalDir, approvedBuildRecordPath } = setupDirectories();
  const receipt = verifyStudySetup({
    repoRoot,
    projectDir,
    rehearsalDir,
    approvedBuildRecordPath,
    fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
  });

  assert.equal(receipt.ready, true);
  assert.deepEqual(receipt.materials.map(({ task }) => task), [1, 6]);
  assert.equal(new Set(receipt.materials.map(({ sha256 }) => sha256)).size, 2);
  assert.equal(receipt.projectState, 'empty');
  assert.equal(receipt.rehearsalState, 'deleted');
  assert.deepEqual(receipt.approvedBuildIdentity, { matched: true, ...appBuild });
  assert.deepEqual(receipt.approvalRecord, {
    schemaVersion: 1,
    validated: true,
    changeKind: 'initial',
  });
  assert.equal(JSON.stringify(receipt).includes(projectDir), false, 'receipt must not leak local paths');
  assert.equal(JSON.stringify(receipt).includes(approvedBuildRecordPath), false, 'receipt must not leak private record paths');
  assert.equal(JSON.stringify(receipt).includes('CB-M2-BUILD-BASELINE-01'), false, 'receipt must not leak private decision references');
  assert.equal(JSON.stringify(receipt).includes('2026-07-11T09:30:00.000Z'), false, 'receipt must not leak private approval dates');
});

test('setup verification fails closed for dirty projects, retained rehearsal data, wrong build, or wrong bundle', () => {
  const { projectDir, rehearsalDir, approvedBuildRecordPath } = setupDirectories();
  writeFileSync(join(projectDir, '.hidden-state'), 'not empty');

  const options = {
    repoRoot,
    projectDir,
    rehearsalDir,
    approvedBuildRecordPath,
    fixtureManifest,
    ...sourceState,
    actualGitSha: 'wrong',
    bundleId: 'com.paintnode.editor',
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
  };
  assert.throws(() => verifyStudySetup(options), /Git SHA/i);

  options.actualGitSha = sourceState.actualGitSha;
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
  const { projectDir, rehearsalDir, approvedBuildRecordPath } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, approvedBuildRecordPath, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild: { ...appBuild },
    actualExecutableSha256: appBuild.executableSha256,
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
});

test('project and deleted rehearsal paths are canonicalized through symlinks', () => {
  const { root, projectDir, rehearsalDir, approvedBuildRecordPath } = setupDirectories();
  const linkedProject = join(root, 'linked-project');
  symlinkSync(projectDir, linkedProject);
  const options = {
    repoRoot, projectDir: linkedProject, rehearsalDir, approvedBuildRecordPath, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
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

test('approved build record is mandatory, private, strict, and cannot dynamically approve current HEAD', () => {
  const { root, projectDir, rehearsalDir, approvedBuildRecordPath } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, approvedBuildRecordPath, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
  };

  options.approvedBuildRecordPath = join(root, 'missing.json');
  assert.throws(() => verifyStudySetup(options), /approved-build record.*exist/i);

  options.approvedBuildRecordPath = join(root, 'malformed.json');
  writeFileSync(options.approvedBuildRecordPath, '{not json');
  assert.throws(() => verifyStudySetup(options), /approved-build record.*JSON/i);

  options.approvedBuildRecordPath = join(root, 'unknown-field.json');
  writeApprovedBuildRecord(root, { ...approvedBuildRecord(), privateStoragePath: '/secret/private/location' });
  options.approvedBuildRecordPath = join(root, 'approved-build.private.json');
  assert.throws(() => verifyStudySetup(options), /unsupported field.*privateStoragePath/i);

  options.approvedBuildRecordPath = join(repoRoot, 'docs/testing/creator-study/templates/private-approved-build-record.json');
  assert.throws(() => verifyStudySetup(options), /outside the Git repository/i);

  const externalLink = join(root, 'record-link.json');
  symlinkSync(options.approvedBuildRecordPath, externalLink);
  options.approvedBuildRecordPath = externalLink;
  assert.throws(() => verifyStudySetup(options), /outside the Git repository/i);

  options.approvedBuildRecordPath = approvedBuildRecordPath;
  writeFileSync(approvedBuildRecordPath, `${JSON.stringify(approvedBuildRecord({ approvedBuild: { ...appBuild, gitSha: 'f'.repeat(40) } }))}\n`);
  assert.throws(() => verifyStudySetup(options), /approved Git SHA/i);
});

test('every approved build identity and provenance mismatch fails closed', () => {
  const { root, projectDir, rehearsalDir } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
  };
  const mismatches = [
    ['bundleId', 'wrong.bundle', /approved bundle identity/i],
    ['sourceTreeSha', 'f'.repeat(40), /approved source tree/i],
    ['sourceStatusSha256', 'b'.repeat(64), /approved source status/i],
    ['executableSha256', 'c'.repeat(64), /approved executable/i],
    ['mode', 'provider-e2e', /approved provenance mode/i],
    ['version', 2, /approved provenance version/i],
    ['sourceDirty', true, /approved dirty source/i],
  ];
  for (const [field, value, pattern] of mismatches) {
    const approvedBuildRecordPath = writeApprovedBuildRecord(root, approvedBuildRecord({
      approvedBuild: { ...appBuild, [field]: value },
    }));
    assert.throws(() => verifyStudySetup({ ...options, approvedBuildRecordPath }), pattern);
  }
});

test('mid-study build changes require owner approval, reason, rehearsal, replacement, and comparability decision', () => {
  const { root, projectDir, rehearsalDir } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
  };
  const validChange = approvedBuildRecord({
    approval: {
      ownerApproved: true,
      approvedAt: '2026-07-12T09:30:00.000Z',
      decisionReference: 'CB-M2-BUILD-CHANGE-02',
    },
    changeControl: {
      kind: 'mid-study',
      replacesDecisionReference: 'CB-M2-BUILD-BASELINE-01',
      reason: 'Fixes an approved session-blocking integrity defect.',
      rehearsalCompletedAt: '2026-07-12T09:00:00.000Z',
      comparabilityDecision: 'comparable',
    },
  });
  const invalidChanges = [
    [{ approval: { ...validChange.approval, ownerApproved: false } }, /owner approval/i],
    [{ changeControl: { ...validChange.changeControl, reason: '' } }, /change reason/i],
    [{ changeControl: { ...validChange.changeControl, replacesDecisionReference: null } }, /replaces.*reference/i],
    [{ changeControl: { ...validChange.changeControl, rehearsalCompletedAt: '' } }, /rehearsal/i],
    [{ changeControl: { ...validChange.changeControl, rehearsalCompletedAt: '2026-07-12T10:00:00.000Z' } }, /approval.*after.*rehearsal/i],
    [{ changeControl: { ...validChange.changeControl, replacesDecisionReference: validChange.approval.decisionReference } }, /new decision reference/i],
    [{ changeControl: { ...validChange.changeControl, comparabilityDecision: 'unknown' } }, /comparability/i],
  ];
  for (const [override, pattern] of invalidChanges) {
    const record = {
      ...validChange,
      ...override,
      approval: override.approval ?? validChange.approval,
      changeControl: override.changeControl ?? validChange.changeControl,
    };
    const approvedBuildRecordPath = writeApprovedBuildRecord(root, record);
    assert.throws(() => verifyStudySetup({ ...options, approvedBuildRecordPath }), pattern);
  }

  const approvedBuildRecordPath = writeApprovedBuildRecord(root, validChange);
  const receipt = verifyStudySetup({ ...options, approvedBuildRecordPath });
  assert.equal(receipt.approvalRecord.changeKind, 'mid-study');
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(validChange.changeControl.reason), false);
  assert.equal(serialized.includes(validChange.approval.decisionReference), false);
  assert.equal(serialized.includes(validChange.changeControl.replacesDecisionReference), false);
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
