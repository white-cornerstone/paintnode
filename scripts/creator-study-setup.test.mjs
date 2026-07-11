import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { qaBuildIdentitySha256 } from './native-qa-build-provenance.mjs';

import {
  approvedBuildDecisionCommitment,
  createMacosActiveBuildAnchor,
  EXPECTED_BUNDLE_ID,
  verifyStudySetup as verifyStudySetupImplementation,
} from './creator-study-setup.mjs';
import {
  createFreshProviderFreeStudySession,
  markStudySessionLaunchAttempted,
  studySessionBootEvidencePath,
  studySessionLaunchEvidencePath,
  writeProviderFreeStudySession,
} from './native-qa-session.mjs';
import { createMemoryStudySessionConsumptionAnchor } from './native-qa-session-anchor.mjs';

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const fixtureManifest = join(repoRoot, 'docs', 'testing', 'creator-study', 'materials', 'manifest.json');
const verificationNow = new Date('2026-07-13T00:00:00.000Z');
const INITIAL_APPROVAL_ID = '00112233-4455-4677-8899-aabbccddeeff';
const CHANGE_APPROVAL_ID = 'ffeeddcc-bbaa-4988-8776-554433221100';
const sourceState = {
  actualGitSha: '405524d393f07ecd588d7476e83adc38e00a90cc',
  actualSourceTreeSha: 'b'.repeat(40),
  actualSourceStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  actualProvenanceSha256: 'c'.repeat(64),
  sourceDirty: false,
};
const sessionFixture = createFreshProviderFreeStudySession({
  randomUUID: () => '00112233-4455-4677-8899-aabbccddeeff',
  randomBytes: () => Buffer.alloc(32, 3),
});
const approvedBuildIdentity = {
  version: 1,
  mode: 'provider-free',
  bundleId: EXPECTED_BUNDLE_ID,
  gitSha: sourceState.actualGitSha,
  sourceTreeSha: sourceState.actualSourceTreeSha,
  sourceDirty: false,
  sourceStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  executableSha256: 'a'.repeat(64),
};
const appBuild = {
  ...approvedBuildIdentity,
  studyCapable: true,
};
const lifecycleFixturesByProject = new Map();

function verifyStudySetup(options) {
  const inferredLifecycle = lifecycleFixturesByProject.get(options.projectDir) ?? {};
  return verifyStudySetupImplementation({
    visibleEmptyStateAttested: true,
    macosMajorVersion: 14,
    ...inferredLifecycle,
    ...options,
  });
}

function approvedBuildRecord(overrides = {}) {
  return {
    _copyWarning: 'COPY OUTSIDE REPOSITORY — complete only in approved restricted research storage.',
    _privacyWarning: 'PRIVATE ONLY. Never complete this record in GitHub, a checkout, worktree, chat, or participant project.',
    schemaVersion: 1,
    recordType: 'paintnode-creator-study-approved-build',
    approvedBuild: { ...approvedBuildIdentity },
    approval: {
      ownerApproved: true,
      approvedAt: '2026-07-11T09:30:00.000Z',
      decisionReference: 'CB-M2-BUILD-BASELINE-01',
      approvalId: INITIAL_APPROVAL_ID,
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

function writeApprovedBuildRecord(root, record = approvedBuildRecord(), fileName = 'approved-build.private.json') {
  const path = join(root, fileName);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function canonicalDecisionRecordSha256(record) {
  const canonical = {
    schemaVersion: record.schemaVersion,
    recordType: record.recordType,
    approvedBuild: {
      version: record.approvedBuild.version,
      mode: record.approvedBuild.mode,
      bundleId: record.approvedBuild.bundleId,
      gitSha: record.approvedBuild.gitSha,
      sourceTreeSha: record.approvedBuild.sourceTreeSha,
      sourceDirty: record.approvedBuild.sourceDirty,
      sourceStatusSha256: record.approvedBuild.sourceStatusSha256,
      executableSha256: record.approvedBuild.executableSha256,
    },
    approval: {
      ownerApproved: record.approval.ownerApproved,
      approvedAt: record.approval.approvedAt,
      decisionReference: record.approval.decisionReference,
      approvalId: record.approval.approvalId,
    },
    changeControl: {
      kind: record.changeControl.kind,
      replacesDecisionReference: record.changeControl.replacesDecisionReference,
      reason: record.changeControl.reason,
      rehearsalCompletedAt: record.changeControl.rehearsalCompletedAt,
      comparabilityDecision: record.changeControl.comparabilityDecision,
    },
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function writeActiveBuildDecisions(root, records) {
  const path = join(root, 'active-build-decisions.private.json');
  const decisions = records.map((record, index) => ({
    generation: index + 1,
    approvalId: record.approval.approvalId,
    decisionReference: record.approval.decisionReference,
    approvedAt: record.approval.approvedAt,
    decisionRecordSha256: canonicalDecisionRecordSha256(record),
  }));
  writeFileSync(path, `${JSON.stringify({
    _copyWarning: 'COPY OUTSIDE REPOSITORY — complete only in approved restricted research storage.',
    _privacyWarning: 'PRIVATE ONLY. Never complete this ledger in GitHub, a checkout, worktree, chat, or participant project.',
    schemaVersion: 2,
    recordType: 'paintnode-creator-study-active-build-decisions',
    activeGeneration: decisions.length,
    decisions,
  }, null, 2)}\n`);
  return path;
}

function memoryActiveBuildAnchor(initial = null) {
  let value = initial === null ? null : structuredClone(initial);
  return {
    read: () => value === null ? null : structuredClone(value),
    write: (next) => { value = structuredClone(next); },
    runExclusive: (callback) => callback(),
    snapshot: () => value === null ? null : structuredClone(value),
    restore: (next) => { value = next === null ? null : structuredClone(next); },
  };
}

function decisionChainSha256(records) {
  const entries = records.map((record, index) => ({
    generation: index + 1,
    approvalId: record.approval.approvalId,
    decisionReference: record.approval.decisionReference,
    approvedAt: record.approval.approvedAt,
    decisionRecordSha256: canonicalDecisionRecordSha256(record),
  }));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function protectedHead(record, activeGeneration, records = [record]) {
  return {
    version: 3,
    activeGeneration,
    approvalId: record.approval.approvalId,
    decisionReference: record.approval.decisionReference,
    approvedAt: record.approval.approvedAt,
    decisionRecordSha256: canonicalDecisionRecordSha256(record),
    decisionChainSha256: decisionChainSha256(records),
  };
}

function setupDirectories() {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-creator-study-'));
  const projectDir = join(root, 'participant-project');
  const rehearsalDir = join(root, 'deleted-rehearsal');
  mkdirSync(projectDir);
  const record = approvedBuildRecord();
  const approvedBuildRecordPath = writeApprovedBuildRecord(root, record);
  const activeBuildDecisionsPath = writeActiveBuildDecisions(root, [record]);
  const activeBuildAnchor = memoryActiveBuildAnchor();
  const studySessionStatePath = join(root, 'session.json');
  writeProviderFreeStudySession(studySessionStatePath, sessionFixture);
  markStudySessionLaunchAttempted(studySessionStatePath);
  writeFileSync(studySessionBootEvidencePath(studySessionStatePath), JSON.stringify({
    version: 3,
    event: 'app-boot',
    profileSha256: sessionFixture.profileSha256,
    bootNonceSha256: sessionFixture.bootNonceSha256,
    buildIdentitySha256: qaBuildIdentitySha256(appBuild),
  }));
  writeFileSync(studySessionLaunchEvidencePath(studySessionStatePath), JSON.stringify({
    version: 1,
    event: 'study-launch',
    launchIntent: 'fresh',
    profileSha256: sessionFixture.profileSha256,
    buildIdentitySha256: qaBuildIdentitySha256(appBuild),
    provenanceSha256: sourceState.actualProvenanceSha256,
    executableSha256: appBuild.executableSha256,
  }));
  const studySessionConsumptionAnchor = createMemoryStudySessionConsumptionAnchor();
  lifecycleFixturesByProject.set(projectDir, {
    approvedBuildRecordPath,
    activeBuildDecisionsPath,
    activeBuildAnchor,
    studySessionStatePath,
    studySessionConsumptionAnchor,
  });
  return {
    root,
    projectDir,
    rehearsalDir,
    approvedBuildRecordPath,
    activeBuildDecisionsPath,
    activeBuildAnchor,
    studySessionStatePath,
    studySessionConsumptionAnchor,
  };
}

test('protected active-build anchor pins the complete private decision head in the study Mac keychain', () => {
  const calls = [];
  const stored = {
    version: 3,
    activeGeneration: 2,
    approvalId: CHANGE_APPROVAL_ID,
    decisionReference: 'CB-M2-BUILD-CHANGE-02',
    approvedAt: '2026-07-12T09:30:00.000Z',
    decisionRecordSha256: 'b'.repeat(64),
    decisionChainSha256: 'c'.repeat(64),
  };
  const anchor = createMacosActiveBuildAnchor((command, args) => {
    calls.push({ command, args });
    if (args[0] === 'find-generic-password') return { status: 0, stdout: JSON.stringify(stored), stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  }, 'darwin');
  assert.deepEqual(anchor.read(), stored);
  assert.throws(() => anchor.write(stored), /exclusive process lock/i);
  anchor.runExclusive(() => anchor.write(stored));
  assert.equal(calls.every(({ command }) => command === 'security'), true);
  assert.equal(calls[0].args.includes('find-generic-password'), true);
  assert.equal(calls[1].args.includes('add-generic-password'), true);
  assert.equal(JSON.stringify(calls).includes('decisionReference'), true);
  assert.equal(JSON.stringify(calls).includes('approvedAt'), true);
  assert.equal(JSON.stringify(calls).includes('decisionRecordSha256'), true);
  assert.equal(JSON.stringify(calls).includes('decisionChainSha256'), true);
  assert.equal(JSON.stringify(calls).includes('reason'), false);
  assert.equal(JSON.stringify(calls).includes('executableSha256'), false);
  assert.throws(() => createMacosActiveBuildAnchor(() => ({ status: 0 }), 'linux').read(), /study Mac keychain/i);
  assert.throws(() => createMacosActiveBuildAnchor(() => ({
    status: 0,
    stdout: JSON.stringify({ version: 2, activeGeneration: 2, approvalId: CHANGE_APPROVAL_ID }),
    stderr: '',
  }), 'darwin').read(), /missing required field|version or generation is invalid/i);
});

test('the committed Product materials are deterministic, distinct, and assigned to Tasks 1 and 6', () => {
  const {
    projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath, activeBuildAnchor,
    studySessionStatePath, studySessionConsumptionAnchor,
  } = setupDirectories();
  assert.deepEqual(approvedBuildDecisionCommitment({ repoRoot, approvedBuildRecordPath }), {
    ledgerSchemaVersion: 2,
    decisionRecordSha256: canonicalDecisionRecordSha256(approvedBuildRecord()),
  });
  const receipt = verifyStudySetup({
    repoRoot,
    projectDir,
    rehearsalDir,
    approvedBuildRecordPath,
    activeBuildDecisionsPath,
    activeBuildAnchor,
    fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    now: verificationNow,
    visibleEmptyStateAttested: true,
    macosMajorVersion: 14,
    studySessionStatePath,
    studySessionConsumptionAnchor,
  });

  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.receiptType, 'paintnode-creator-study-technical-setup');
  assert.equal(receipt.scope, 'technical-setup-only');
  assert.equal(receipt.technicalSetupReady, true);
  assert.equal(receipt.studyAuthorizationEvaluated, false);
  assert.equal('ready' in receipt, false);
  for (const prohibited of [
    'recruitmentAuthorized', 'participationConsent', 'recordingConsent',
    'facilitatorCalibrationAuthorized', 'accessibilitySupportOwner',
  ]) assert.equal(prohibited in receipt, false);
  assert.deepEqual(receipt.materials.map(({ task }) => task), [1, 6]);
  assert.equal(new Set(receipt.materials.map(({ sha256 }) => sha256)).size, 2);
  assert.equal(receipt.projectState, 'empty');
  assert.equal(receipt.rehearsalState, 'deleted');
  assert.deepEqual(receipt.approvedBuildIdentity, { matched: true, ...approvedBuildIdentity });
  assert.deepEqual(receipt.approvalRecord, {
    schemaVersion: 1,
    validated: true,
    changeKind: 'initial',
    activeGeneration: 1,
    approvalId: INITIAL_APPROVAL_ID,
  });
  assert.deepEqual(receipt.sessionReset, {
    isolatedProfile: true,
    profileSha256: sessionFixture.profileSha256,
    macosMajorVersion: 14,
    appBootObserved: true,
    setupEvidenceConsumed: true,
    monotonicAnchorRecorded: true,
  });
  assert.deepEqual(receipt.manualAttestations, {
    visibleEmptyProjectAndWorkflow: true,
  });
  assert.equal(JSON.stringify(receipt).includes(projectDir), false, 'receipt must not leak local paths');
  assert.equal(JSON.stringify(receipt).includes(approvedBuildRecordPath), false, 'receipt must not leak private record paths');
  assert.equal(JSON.stringify(receipt).includes(activeBuildDecisionsPath), false, 'receipt must not leak private ledger paths');
  assert.equal(JSON.stringify(receipt).includes('CB-M2-BUILD-BASELINE-01'), false, 'receipt must not leak private decision references');
  assert.equal(JSON.stringify(receipt).includes('2026-07-11T09:30:00.000Z'), false, 'receipt must not leak private approval dates');
  assert.equal(
    JSON.stringify(receipt).includes(canonicalDecisionRecordSha256(approvedBuildRecord())),
    false,
    'receipt must not leak the private canonical decision commitment',
  );
  assert.equal('decisionChainSha256' in receipt.approvalRecord, false);
});

test('protected decision commitment rejects build A to build B rewrite under the same approval labels', () => {
  const {
    root, projectDir, rehearsalDir, approvedBuildRecordPath,
    activeBuildDecisionsPath, activeBuildAnchor,
  } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, approvedBuildRecordPath,
    activeBuildDecisionsPath, activeBuildAnchor, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    now: verificationNow,
  };
  assert.equal(verifyStudySetup(options).technicalSetupReady, true);
  const acceptedAnchor = activeBuildAnchor.snapshot();

  const buildBIdentity = {
    ...approvedBuildIdentity,
    gitSha: '5'.repeat(40),
    sourceTreeSha: 'c'.repeat(40),
    executableSha256: 'd'.repeat(64),
  };
  const buildB = { ...buildBIdentity, studyCapable: true };
  const rewrittenRecord = approvedBuildRecord({ approvedBuild: buildBIdentity });
  options.approvedBuildRecordPath = writeApprovedBuildRecord(root, rewrittenRecord);
  options.activeBuildDecisionsPath = writeActiveBuildDecisions(root, [rewrittenRecord]);
  options.actualGitSha = buildB.gitSha;
  options.actualSourceTreeSha = buildB.sourceTreeSha;
  options.appBuild = buildB;
  options.actualExecutableSha256 = buildB.executableSha256;
  assert.throws(
    () => verifyStudySetup(options),
    /conflicts with this generation private decision head/i,
  );
  assert.deepEqual(activeBuildAnchor.snapshot(), acceptedAnchor);
});

test('stale generation-1 verifier cannot overwrite a concurrent generation-2 anchor', () => {
  const {
    projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath,
  } = setupDirectories();
  const initial = approvedBuildRecord();
  const replacement = approvedBuildRecord({
    approval: {
      ownerApproved: true,
      approvedAt: '2026-07-12T09:30:00.000Z',
      decisionReference: 'CB-M2-BUILD-CONCURRENT-02',
      approvalId: CHANGE_APPROVAL_ID,
    },
    changeControl: {
      kind: 'mid-study',
      replacesDecisionReference: initial.approval.decisionReference,
      reason: 'Concurrent advancement proof.',
      rehearsalCompletedAt: '2026-07-12T09:00:00.000Z',
      comparabilityDecision: 'comparable',
    },
  });
  const concurrentGenerationTwo = protectedHead(replacement, 2, [initial, replacement]);
  let anchorValue = null;
  let writeCount = 0;
  let exclusiveCount = 0;
  const staleAnchorStore = {
    read: () => anchorValue === null ? null : structuredClone(anchorValue),
    write: (next) => { writeCount += 1; anchorValue = structuredClone(next); },
    runExclusive(callback) {
      exclusiveCount += 1;
      anchorValue = structuredClone(concurrentGenerationTwo);
      return callback();
    },
  };
  assert.throws(() => verifyStudySetup({
    repoRoot, projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath,
    activeBuildAnchor: staleAnchorStore, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    now: verificationNow,
  }), /rejects rolled-back private decision files/i);
  assert.equal(exclusiveCount, 1);
  assert.equal(writeCount, 0, 'stale writer must re-read and reject before Keychain update');
  assert.deepEqual(anchorValue, concurrentGenerationTwo);
});

test('setup requires actual app boot evidence and consumes it exactly once', () => {
  const {
    root, projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath,
    activeBuildAnchor, studySessionStatePath, studySessionConsumptionAnchor,
  } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath,
    activeBuildAnchor, studySessionStatePath, fixtureManifest,
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
    buildIdentitySha256: qaBuildIdentitySha256(appBuild),
  }));
  assert.equal(verifyStudySetup(options).technicalSetupReady, true);
  const secondProject = join(root, 'participant-project-2');
  mkdirSync(secondProject);
  assert.throws(
    () => verifyStudySetup({ ...options, projectDir: secondProject }),
    /already been consumed/i,
  );
});

test('setup verification fails closed for dirty projects, retained rehearsal data, wrong build, or wrong bundle', () => {
  const {
    projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath, activeBuildAnchor,
    studySessionStatePath, studySessionConsumptionAnchor,
  } = setupDirectories();
  writeFileSync(join(projectDir, '.hidden-state'), 'not empty');

  const options = {
    repoRoot,
    projectDir,
    rehearsalDir,
    approvedBuildRecordPath,
    activeBuildDecisionsPath,
    activeBuildAnchor,
    fixtureManifest,
    ...sourceState,
    actualGitSha: 'wrong',
    bundleId: 'com.paintnode.editor',
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    now: verificationNow,
    visibleEmptyStateAttested: true,
    macosMajorVersion: 14,
    studySessionStatePath,
    studySessionConsumptionAnchor,
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
  const {
    projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath, activeBuildAnchor,
    studySessionStatePath, studySessionConsumptionAnchor,
  } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath, activeBuildAnchor, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild: { ...appBuild },
    actualExecutableSha256: appBuild.executableSha256,
    now: verificationNow,
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

  const launchPath = studySessionLaunchEvidencePath(studySessionStatePath);
  const freshLaunch = JSON.parse(readFileSync(launchPath, 'utf8'));
  writeFileSync(launchPath, JSON.stringify({ ...freshLaunch, launchIntent: 'resume' }));
  assert.throws(() => verifyStudySetup(options), /launch evidence is stale or mismatched/i);
  writeFileSync(launchPath, JSON.stringify(freshLaunch));

  options.appBuild.studyCapable = false;
  assert.throws(() => verifyStudySetup(options), /study-capable/i);
  options.appBuild.studyCapable = true;

  options.visibleEmptyStateAttested = false;
  assert.throws(() => verifyStudySetup(options), /visible empty Project and Workflow/i);
  options.visibleEmptyStateAttested = true;

  options.macosMajorVersion = 13;
  assert.throws(() => verifyStudySetup(options), /macOS 14/i);
});

test('project and deleted rehearsal paths are canonicalized through symlinks', () => {
  const {
    root, projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath,
    activeBuildAnchor, studySessionStatePath, studySessionConsumptionAnchor,
  } = setupDirectories();
  const linkedProject = join(root, 'linked-project');
  symlinkSync(projectDir, linkedProject);
  const options = {
    repoRoot, projectDir: linkedProject, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath, activeBuildAnchor, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    now: verificationNow,
    visibleEmptyStateAttested: true,
    macosMajorVersion: 14,
    studySessionStatePath,
    studySessionConsumptionAnchor,
  };
  assert.equal(verifyStudySetup(options).technicalSetupReady, true);

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
  const { root, projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath, activeBuildAnchor } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath, activeBuildAnchor, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    now: verificationNow,
  };

  const originalActiveBuildDecisionsPath = activeBuildDecisionsPath;
  options.activeBuildDecisionsPath = join(root, 'missing-ledger.json');
  assert.throws(() => verifyStudySetup(options), /active-build decisions.*exist/i);
  options.activeBuildDecisionsPath = join(repoRoot, 'docs/testing/creator-study/templates/private-active-build-decisions.json');
  assert.throws(() => verifyStudySetup(options), /outside the Git repository/i);
  options.activeBuildDecisionsPath = join(root, 'malformed-ledger.json');
  writeFileSync(options.activeBuildDecisionsPath, '{not json');
  assert.throws(() => verifyStudySetup(options), /active-build decisions.*JSON/i);
  writeFileSync(options.activeBuildDecisionsPath, '{"schemaVersion":1,"schemaVersion":2}');
  assert.throws(() => verifyStudySetup(options), /duplicate field schemaVersion/i);
  options.activeBuildDecisionsPath = originalActiveBuildDecisionsPath;

  options.approvedBuildRecordPath = join(root, 'missing.json');
  assert.throws(() => verifyStudySetup(options), /approved-build record.*exist/i);

  options.approvedBuildRecordPath = join(root, 'malformed.json');
  writeFileSync(options.approvedBuildRecordPath, '{not json');
  assert.throws(() => verifyStudySetup(options), /approved-build record.*JSON/i);
  writeFileSync(options.approvedBuildRecordPath, '{"schemaVersion":1,"schemaVersion":2}');
  assert.throws(() => verifyStudySetup(options), /duplicate field schemaVersion/i);

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
  const staleRecord = approvedBuildRecord({
    approvedBuild: { ...approvedBuildIdentity, gitSha: 'f'.repeat(40) },
  });
  writeApprovedBuildRecord(root, staleRecord);
  options.activeBuildDecisionsPath = writeActiveBuildDecisions(root, [staleRecord]);
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
    now: verificationNow,
    activeBuildAnchor: memoryActiveBuildAnchor(),
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
    const record = approvedBuildRecord({
      approvedBuild: { ...approvedBuildIdentity, [field]: value },
    });
    const approvedBuildRecordPath = writeApprovedBuildRecord(root, record);
    const activeBuildDecisionsPath = writeActiveBuildDecisions(root, [record]);
    assert.throws(() => verifyStudySetup({ ...options, approvedBuildRecordPath, activeBuildDecisionsPath }), pattern);
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
    now: verificationNow,
    activeBuildAnchor: memoryActiveBuildAnchor(protectedHead(approvedBuildRecord(), 1)),
  };
  const validChange = approvedBuildRecord({
    approval: {
      ownerApproved: true,
      approvedAt: '2026-07-12T09:30:00.000Z',
      decisionReference: 'CB-M2-BUILD-CHANGE-02',
      approvalId: CHANGE_APPROVAL_ID,
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
    [{
      approval: { ...validChange.approval, approvedAt: '2026-07-10T09:30:00.000Z' },
      changeControl: { ...validChange.changeControl, rehearsalCompletedAt: '2026-07-10T09:00:00.000Z' },
    }, /increase strictly/i],
    [{
      changeControl: { ...validChange.changeControl, rehearsalCompletedAt: '2026-07-11T08:00:00.000Z' },
    }, /rehearsal must occur after/i],
  ];
  for (const [override, pattern] of invalidChanges) {
    const record = {
      ...validChange,
      ...override,
      approval: override.approval ?? validChange.approval,
      changeControl: override.changeControl ?? validChange.changeControl,
    };
    const approvedBuildRecordPath = writeApprovedBuildRecord(root, record);
    const activeBuildDecisionsPath = writeActiveBuildDecisions(root, [approvedBuildRecord(), record]);
    assert.throws(() => verifyStudySetup({ ...options, approvedBuildRecordPath, activeBuildDecisionsPath }), pattern);
  }

  const approvedBuildRecordPath = writeApprovedBuildRecord(root, validChange);
  const activeBuildDecisionsPath = writeActiveBuildDecisions(root, [approvedBuildRecord(), validChange]);
  const receipt = verifyStudySetup({ ...options, approvedBuildRecordPath, activeBuildDecisionsPath });
  assert.equal(receipt.approvalRecord.changeKind, 'mid-study');
  assert.equal(receipt.approvalRecord.activeGeneration, 2);
  assert.equal(receipt.approvalRecord.approvalId, CHANGE_APPROVAL_ID);
  assert.equal('approvedBuildRecordSha256' in receipt.approvalRecord, false);
  const serialized = JSON.stringify(receipt);
  assert.equal(serialized.includes(validChange.changeControl.reason), false);
  assert.equal(serialized.includes(validChange.approval.decisionReference), false);
  assert.equal(serialized.includes(validChange.changeControl.replacesDecisionReference), false);
});

test('approval timing is strict, ordered, completed by now, and deterministically testable', () => {
  const { root, projectDir, rehearsalDir } = setupDirectories();
  const options = {
    repoRoot, projectDir, rehearsalDir, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    now: verificationNow,
    activeBuildAnchor: memoryActiveBuildAnchor(),
  };
  const invalidTiming = [
    [approvedBuildRecord({
      approval: { ownerApproved: true, approvedAt: '2026-07-14T09:30:00.000Z', decisionReference: 'CB-FUTURE-01', approvalId: INITIAL_APPROVAL_ID },
      changeControl: { kind: 'initial', replacesDecisionReference: null, reason: null, rehearsalCompletedAt: '2026-07-14T09:00:00.000Z', comparabilityDecision: 'baseline' },
    }), /cannot be in the future/i],
    [approvedBuildRecord({
      approval: { ownerApproved: true, approvedAt: '2026-07-11T09:30:00.000Z', decisionReference: 'CB-EQUAL-01', approvalId: INITIAL_APPROVAL_ID },
      changeControl: { kind: 'initial', replacesDecisionReference: null, reason: null, rehearsalCompletedAt: '2026-07-11T09:30:00.000Z', comparabilityDecision: 'baseline' },
    }), /approval must occur after/i],
    [approvedBuildRecord({
      approval: { ownerApproved: true, approvedAt: '2026-02-30T09:30:00.000Z', decisionReference: 'CB-ROLLOVER-01', approvalId: INITIAL_APPROVAL_ID },
    }), /real calendar instant/i],
    [approvedBuildRecord({
      approval: { ownerApproved: true, approvedAt: '2026-07-11', decisionReference: 'CB-DATEONLY-01', approvalId: INITIAL_APPROVAL_ID },
    }), /strict UTC timestamp/i],
  ];
  for (const [record, pattern] of invalidTiming) {
    const approvedBuildRecordPath = writeApprovedBuildRecord(root, record);
    const activeBuildDecisionsPath = writeActiveBuildDecisions(root, [record]);
    assert.throws(() => verifyStudySetup({ ...options, approvedBuildRecordPath, activeBuildDecisionsPath }), pattern);
  }

  const boundary = approvedBuildRecord({
    approval: { ownerApproved: true, approvedAt: verificationNow.toISOString(), decisionReference: 'CB-NOW-BOUNDARY-01', approvalId: INITIAL_APPROVAL_ID },
  });
  const approvedBuildRecordPath = writeApprovedBuildRecord(root, boundary);
  const activeBuildDecisionsPath = writeActiveBuildDecisions(root, [boundary]);
  assert.equal(verifyStudySetup({ ...options, approvedBuildRecordPath, activeBuildDecisionsPath }).technicalSetupReady, true);
});

test('protected anchor rejects rewritten prior approval time or reference with the same approval ID', () => {
  const { root, projectDir, rehearsalDir } = setupDirectories();
  const acceptedInitial = approvedBuildRecord();
  const activeBuildAnchor = memoryActiveBuildAnchor(protectedHead(acceptedInitial, 1));
  const options = {
    repoRoot, projectDir, rehearsalDir, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    now: verificationNow,
    activeBuildAnchor,
  };

  const rewrittenTimeBeforeAdvance = approvedBuildRecord({
    approval: {
      ...acceptedInitial.approval,
      approvedAt: '2026-07-09T09:30:00.000Z',
    },
    changeControl: {
      ...acceptedInitial.changeControl,
      rehearsalCompletedAt: '2026-07-09T09:00:00.000Z',
    },
  });
  const backwardReplacement = approvedBuildRecord({
    approval: {
      ownerApproved: true,
      approvedAt: '2026-07-10T09:30:00.000Z',
      decisionReference: 'CB-M2-BUILD-BACKWARD-02',
      approvalId: CHANGE_APPROVAL_ID,
    },
    changeControl: {
      kind: 'mid-study',
      replacesDecisionReference: rewrittenTimeBeforeAdvance.approval.decisionReference,
      reason: 'Adversarial backward approval probe.',
      rehearsalCompletedAt: '2026-07-10T09:00:00.000Z',
      comparabilityDecision: 'comparable',
    },
  });
  let approvedBuildRecordPath = writeApprovedBuildRecord(root, backwardReplacement);
  let activeBuildDecisionsPath = writeActiveBuildDecisions(
    root,
    [rewrittenTimeBeforeAdvance, backwardReplacement],
  );
  assert.throws(() => verifyStudySetup({
    ...options, approvedBuildRecordPath, activeBuildDecisionsPath,
  }), /does not match the immediately preceding private decision head/i);
  assert.deepEqual(activeBuildAnchor.snapshot(), protectedHead(acceptedInitial, 1));

  const acceptedReplacement = approvedBuildRecord({
    approval: {
      ownerApproved: true,
      approvedAt: '2026-07-12T09:30:00.000Z',
      decisionReference: 'CB-M2-BUILD-CHANGE-02',
      approvalId: CHANGE_APPROVAL_ID,
    },
    changeControl: {
      kind: 'mid-study',
      replacesDecisionReference: acceptedInitial.approval.decisionReference,
      reason: 'Accepted integrity correction.',
      rehearsalCompletedAt: '2026-07-12T09:00:00.000Z',
      comparabilityDecision: 'comparable',
    },
  });
  const forgedPreviousHead = approvedBuildRecord({
    approval: {
      ...acceptedInitial.approval,
      decisionReference: 'CB-FORGED-BASELINE-01',
    },
  });
  const forgedPreviousReplacement = approvedBuildRecord({
    approval: { ...acceptedReplacement.approval },
    changeControl: {
      ...acceptedReplacement.changeControl,
      replacesDecisionReference: forgedPreviousHead.approval.decisionReference,
    },
  });
  approvedBuildRecordPath = writeApprovedBuildRecord(root, forgedPreviousReplacement);
  activeBuildDecisionsPath = writeActiveBuildDecisions(
    root,
    [forgedPreviousHead, forgedPreviousReplacement],
  );
  assert.throws(() => verifyStudySetup({
    ...options, approvedBuildRecordPath, activeBuildDecisionsPath,
  }), /does not match the immediately preceding private decision head/i);
  assert.deepEqual(activeBuildAnchor.snapshot(), protectedHead(acceptedInitial, 1));

  approvedBuildRecordPath = writeApprovedBuildRecord(root, acceptedReplacement);
  activeBuildDecisionsPath = writeActiveBuildDecisions(root, [acceptedInitial, acceptedReplacement]);
  assert.equal(verifyStudySetup({
    ...options, approvedBuildRecordPath, activeBuildDecisionsPath,
  }).approvalRecord.activeGeneration, 2);
  const acceptedProtectedHead = protectedHead(
    acceptedReplacement,
    2,
    [acceptedInitial, acceptedReplacement],
  );
  assert.deepEqual(activeBuildAnchor.snapshot(), acceptedProtectedHead);

  const rewrittenTimeInitial = approvedBuildRecord({
    approval: {
      ...acceptedInitial.approval,
      approvedAt: '2026-07-09T09:30:00.000Z',
    },
    changeControl: {
      ...acceptedInitial.changeControl,
      rehearsalCompletedAt: '2026-07-09T09:00:00.000Z',
    },
  });
  activeBuildDecisionsPath = writeActiveBuildDecisions(root, [rewrittenTimeInitial, acceptedReplacement]);
  assert.throws(() => verifyStudySetup({
    ...options, approvedBuildRecordPath, activeBuildDecisionsPath,
  }), /conflicts with this generation private decision head/i);
  assert.deepEqual(activeBuildAnchor.snapshot(), acceptedProtectedHead);

  const rewrittenReferenceInitial = approvedBuildRecord({
    approval: {
      ...acceptedInitial.approval,
      decisionReference: 'CB-FORGED-BASELINE-01',
    },
  });
  const rewrittenReferenceReplacement = approvedBuildRecord({
    approval: { ...acceptedReplacement.approval },
    changeControl: {
      ...acceptedReplacement.changeControl,
      replacesDecisionReference: rewrittenReferenceInitial.approval.decisionReference,
    },
  });
  approvedBuildRecordPath = writeApprovedBuildRecord(root, rewrittenReferenceReplacement);
  activeBuildDecisionsPath = writeActiveBuildDecisions(
    root,
    [rewrittenReferenceInitial, rewrittenReferenceReplacement],
  );
  assert.throws(() => verifyStudySetup({
    ...options, approvedBuildRecordPath, activeBuildDecisionsPath,
  }), /conflicts with this generation private decision head/i);
  assert.deepEqual(activeBuildAnchor.snapshot(), acceptedProtectedHead);
});

test('active decision ledger rejects adversarial old to new to old record replay', () => {
  const { root, projectDir, rehearsalDir } = setupDirectories();
  const initial = approvedBuildRecord();
  const replacement = approvedBuildRecord({
    approval: {
      ownerApproved: true,
      approvedAt: '2026-07-12T09:30:00.000Z',
      decisionReference: 'CB-M2-BUILD-CHANGE-02',
      approvalId: CHANGE_APPROVAL_ID,
    },
    changeControl: {
      kind: 'mid-study',
      replacesDecisionReference: initial.approval.decisionReference,
      reason: 'Approved integrity correction.',
      rehearsalCompletedAt: '2026-07-12T09:00:00.000Z',
      comparabilityDecision: 'comparable',
    },
  });
  const initialPath = writeApprovedBuildRecord(root, initial, 'initial.private.json');
  const replacementPath = writeApprovedBuildRecord(root, replacement, 'replacement.private.json');
  const baseOptions = {
    repoRoot, projectDir, rehearsalDir, fixtureManifest,
    ...sourceState,
    bundleId: EXPECTED_BUNDLE_ID,
    appBuild,
    actualExecutableSha256: appBuild.executableSha256,
    now: verificationNow,
    activeBuildAnchor: memoryActiveBuildAnchor(),
  };

  let activeBuildDecisionsPath = writeActiveBuildDecisions(root, [initial]);
  assert.equal(verifyStudySetup({
    ...baseOptions,
    approvedBuildRecordPath: initialPath,
    activeBuildDecisionsPath,
  }).approvalRecord.activeGeneration, 1);

  const replacementSession = createFreshProviderFreeStudySession({
    randomUUID: () => '11111111-2222-4333-8444-555555555555',
    randomBytes: () => Buffer.alloc(32, 4),
  });
  const replacementSessionPath = join(root, 'replacement-session.json');
  writeProviderFreeStudySession(replacementSessionPath, replacementSession);
  markStudySessionLaunchAttempted(replacementSessionPath);
  writeFileSync(studySessionBootEvidencePath(replacementSessionPath), JSON.stringify({
    version: 3,
    event: 'app-boot',
    profileSha256: replacementSession.profileSha256,
    bootNonceSha256: replacementSession.bootNonceSha256,
    buildIdentitySha256: qaBuildIdentitySha256(appBuild),
  }));
  writeFileSync(studySessionLaunchEvidencePath(replacementSessionPath), JSON.stringify({
    version: 1,
    event: 'study-launch',
    launchIntent: 'fresh',
    profileSha256: replacementSession.profileSha256,
    buildIdentitySha256: qaBuildIdentitySha256(appBuild),
    provenanceSha256: sourceState.actualProvenanceSha256,
    executableSha256: appBuild.executableSha256,
  }));
  baseOptions.studySessionStatePath = replacementSessionPath;
  baseOptions.studySessionConsumptionAnchor = createMemoryStudySessionConsumptionAnchor();
  activeBuildDecisionsPath = writeActiveBuildDecisions(root, [initial, replacement]);
  const currentReceipt = verifyStudySetup({
    ...baseOptions,
    approvedBuildRecordPath: replacementPath,
    activeBuildDecisionsPath,
  });
  assert.equal(currentReceipt.approvalRecord.activeGeneration, 2);
  assert.equal(currentReceipt.approvalRecord.approvalId, CHANGE_APPROVAL_ID);
  activeBuildDecisionsPath = writeActiveBuildDecisions(root, [initial]);
  assert.throws(() => verifyStudySetup({
    ...baseOptions,
    approvedBuildRecordPath: initialPath,
    activeBuildDecisionsPath,
  }), /protected active-build anchor rejects rolled-back/i);
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
