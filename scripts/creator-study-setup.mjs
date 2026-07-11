import { createHash } from 'node:crypto';
import {
  accessSync, closeSync, constants, existsSync, lstatSync, openSync, readFileSync,
  readdirSync, realpathSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { captureSourceState, readQaBuildProvenance, sha256File } from './native-qa-build-provenance.mjs';
import { verifyAndConsumeStudySessionBoot } from './native-qa-session.mjs';
import { createMacKeychainStudySessionConsumptionAnchor } from './native-qa-session-anchor.mjs';

export const EXPECTED_BUNDLE_ID = 'com.paintnode.editor.blueprintqa.provider.free';
export const EXPECTED_BUNDLE_NAME = 'PaintNode Blueprint QA — Provider Free';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_BUILD_RECORD_TYPE = 'paintnode-creator-study-approved-build';
const ACTIVE_BUILD_DECISIONS_TYPE = 'paintnode-creator-study-active-build-decisions';
const CLEAN_STATUS_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DECISION_REFERENCE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{2,63}$/;
const APPROVAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ACTIVE_ANCHOR_SERVICE = 'com.paintnode.creator-study.active-build';
const ACTIVE_ANCHOR_ACCOUNT = 'creative-blueprint-mvp';
const ACTIVE_ANCHOR_LOCK_PATH = join(tmpdir(), 'paintnode-creator-study-active-build.lock');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function pathEntryExists(path) {
  try { lstatSync(path); return true; } catch { return false; }
}

function canonicalExisting(path, label) {
  try { return realpathSync(path); } catch { throw new Error(`${label} must exist and resolve without a broken symlink.`); }
}

function canonicalDeletedPath(path) {
  const requested = resolve(path);
  if (pathEntryExists(requested)) throw new Error('The separate rehearsal project must be deleted before participant setup is ready.');
  const suffix = [];
  let ancestor = requested;
  while (!pathEntryExists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Could not resolve the deleted rehearsal path.');
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  return join(realpathSync(ancestor), ...suffix);
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label} has unsupported field ${key}.`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) throw new Error(`${label} is missing required field ${key}.`);
  }
  return value;
}

function parseJsonWithoutDuplicateKeys(serialized, label) {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(serialized[index] ?? '')) index += 1;
  };
  const parseString = () => {
    const start = index;
    if (serialized[index] !== '"') throw new Error(`${label} must contain valid JSON.`);
    index += 1;
    while (index < serialized.length) {
      if (serialized[index] === '\\') {
        index += 2;
      } else if (serialized[index] === '"') {
        index += 1;
        return JSON.parse(serialized.slice(start, index));
      } else {
        index += 1;
      }
    }
    throw new Error(`${label} must contain valid JSON.`);
  };
  const parseValue = () => {
    skipWhitespace();
    if (serialized[index] === '{') {
      index += 1;
      const keys = new Set();
      skipWhitespace();
      if (serialized[index] === '}') { index += 1; return; }
      while (index < serialized.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error(`${label} contains duplicate field ${key}.`);
        keys.add(key);
        skipWhitespace();
        if (serialized[index] !== ':') throw new Error(`${label} must contain valid JSON.`);
        index += 1;
        parseValue();
        skipWhitespace();
        if (serialized[index] === '}') { index += 1; return; }
        if (serialized[index] !== ',') throw new Error(`${label} must contain valid JSON.`);
        index += 1;
      }
      throw new Error(`${label} must contain valid JSON.`);
    }
    if (serialized[index] === '[') {
      index += 1;
      skipWhitespace();
      if (serialized[index] === ']') { index += 1; return; }
      while (index < serialized.length) {
        parseValue();
        skipWhitespace();
        if (serialized[index] === ']') { index += 1; return; }
        if (serialized[index] !== ',') throw new Error(`${label} must contain valid JSON.`);
        index += 1;
      }
      throw new Error(`${label} must contain valid JSON.`);
    }
    if (serialized[index] === '"') { parseString(); return; }
    const start = index;
    while (index < serialized.length && !/[\s,\]}]/.test(serialized[index])) index += 1;
    if (start === index) throw new Error(`${label} must contain valid JSON.`);
  };
  parseValue();
  skipWhitespace();
  if (index !== serialized.length) throw new Error(`${label} must contain valid JSON.`);
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function validTimestamp(value, label) {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new Error(`${label} must be a strict UTC timestamp with millisecond precision.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must identify a real calendar instant.`);
  }
  return milliseconds;
}

function validDecisionReference(value, label) {
  if (typeof value !== 'string' || !DECISION_REFERENCE_PATTERN.test(value)) {
    throw new Error(`${label} must be a non-identifying 3–64 character uppercase reference using only letters, numbers, dots, underscores, or hyphens.`);
  }
  return value;
}

function validApprovalId(value, label) {
  if (typeof value !== 'string' || !APPROVAL_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a random lowercase UUIDv4 unrelated to private record contents.`);
  }
  return value;
}

function canonicalApprovedBuildDecision(record) {
  return {
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
}

function readApprovedBuildRecord(recordPath, canonicalRepo) {
  if (!recordPath) throw new Error('An absolute private approved-build record path is required.');
  if (!isAbsolute(recordPath)) throw new Error('The approved-build record path must be absolute.');
  const canonicalRecord = canonicalExisting(recordPath, 'Approved-build record');
  if (isInside(canonicalRepo, canonicalRecord)) {
    throw new Error('The completed approved-build record must be outside the Git repository.');
  }
  if (!statSync(canonicalRecord).isFile()) throw new Error('Approved-build record must be a regular file.');
  let serialized;
  try {
    serialized = readFileSync(canonicalRecord, 'utf8');
  } catch (error) {
    throw new Error(`Could not read approved-build record: ${error instanceof Error ? error.message : error}`);
  }
  const parsed = parseJsonWithoutDuplicateKeys(serialized, 'Approved-build record');
  const record = exactObject(
    parsed,
    ['_copyWarning', '_privacyWarning', 'schemaVersion', 'recordType', 'approvedBuild', 'approval', 'changeControl'],
    'Approved-build record',
  );
  if (typeof record._copyWarning !== 'string' || !record._copyWarning.includes('COPY OUTSIDE REPOSITORY')
    || typeof record._privacyWarning !== 'string' || !record._privacyWarning.includes('PRIVATE ONLY')) {
    throw new Error('Approved-build record must retain its copy-outside-repository and private-only warnings.');
  }
  if (record.schemaVersion !== 1 || record.recordType !== APPROVED_BUILD_RECORD_TYPE) {
    throw new Error('Approved-build record schema or record type is unsupported.');
  }
  const approvedBuild = exactObject(
    record.approvedBuild,
    ['version', 'mode', 'bundleId', 'gitSha', 'sourceTreeSha', 'sourceDirty', 'sourceStatusSha256', 'executableSha256'],
    'Approved-build identity',
  );
  if (approvedBuild.version !== 1) throw new Error('Approved provenance version must be 1.');
  if (approvedBuild.mode !== 'provider-free') throw new Error('Approved provenance mode must be provider-free.');
  if (approvedBuild.bundleId !== EXPECTED_BUNDLE_ID) throw new Error('Approved bundle identity is not the Provider Free study app.');
  if (!GIT_SHA_PATTERN.test(approvedBuild.gitSha || '')) throw new Error('Approved Git SHA must be a literal 40-character lowercase hexadecimal commit.');
  if (!GIT_SHA_PATTERN.test(approvedBuild.sourceTreeSha || '')) throw new Error('Approved source tree must be a literal 40-character lowercase hexadecimal tree identity.');
  if (approvedBuild.sourceDirty !== false) throw new Error('Approved dirty source is forbidden.');
  if (approvedBuild.sourceStatusSha256 !== CLEAN_STATUS_SHA256) throw new Error('Approved source status must identify an empty clean status.');
  if (!SHA256_PATTERN.test(approvedBuild.executableSha256 || '')) throw new Error('Approved executable fingerprint must be a SHA-256 value.');

  const approval = exactObject(
    record.approval,
    ['ownerApproved', 'approvedAt', 'decisionReference', 'approvalId'],
    'Approved-build owner decision',
  );
  if (approval.ownerApproved !== true) throw new Error('Approved-build owner approval must be recorded as true.');
  const approvedAt = validTimestamp(approval.approvedAt, 'Approved-build approval date');
  validDecisionReference(approval.decisionReference, 'Approved-build decision reference');
  validApprovalId(approval.approvalId, 'Approved-build approval ID');

  const change = exactObject(
    record.changeControl,
    ['kind', 'replacesDecisionReference', 'reason', 'rehearsalCompletedAt', 'comparabilityDecision'],
    'Approved-build change control',
  );
  const rehearsalCompletedAt = validTimestamp(change.rehearsalCompletedAt, 'Approved-build rehearsal completion');
  if (rehearsalCompletedAt >= approvedAt) {
    throw new Error('Approved-build owner approval must occur after the recorded rehearsal.');
  }
  if (change.kind === 'initial') {
    if (change.replacesDecisionReference !== null || change.reason !== null || change.comparabilityDecision !== 'baseline') {
      throw new Error('Initial approved-build change control must use null replacement/reason and baseline comparability.');
    }
  } else if (change.kind === 'mid-study') {
    validDecisionReference(change.replacesDecisionReference, 'Mid-study replaces decision reference');
    if (change.replacesDecisionReference === approval.decisionReference) {
      throw new Error('Mid-study build change requires a new decision reference distinct from the replaced approval.');
    }
    if (typeof change.reason !== 'string' || change.reason.trim() === '') {
      throw new Error('Mid-study build change reason is required.');
    }
    if (!['comparable', 'restart-required'].includes(change.comparabilityDecision)) {
      throw new Error('Mid-study comparability decision must be comparable or restart-required.');
    }
  } else {
    throw new Error('Approved-build change kind must be initial or mid-study.');
  }
  const decisionRecordSha256 = sha256(JSON.stringify(canonicalApprovedBuildDecision(record)));
  return Object.freeze({
    schemaVersion: record.schemaVersion,
    approvedBuild: Object.freeze({ ...approvedBuild }),
    changeKind: change.kind,
    approvedAt,
    rehearsalCompletedAt,
    decisionReference: approval.decisionReference,
    approvalId: approval.approvalId,
    replacesDecisionReference: change.replacesDecisionReference,
    decisionRecordSha256,
  });
}

export function approvedBuildDecisionCommitment({
  repoRoot = scriptRoot,
  approvedBuildRecordPath,
}) {
  const canonicalRepo = canonicalExisting(repoRoot, 'Git repository');
  const approval = readApprovedBuildRecord(approvedBuildRecordPath, canonicalRepo);
  return Object.freeze({
    ledgerSchemaVersion: 2,
    decisionRecordSha256: approval.decisionRecordSha256,
  });
}

function readActiveBuildDecisions(decisionsPath, canonicalRepo, approval) {
  if (!decisionsPath || !isAbsolute(decisionsPath)) {
    throw new Error('An absolute private active-build-decisions path is required.');
  }
  const canonicalDecisions = canonicalExisting(decisionsPath, 'Active-build decisions');
  if (isInside(canonicalRepo, canonicalDecisions)) {
    throw new Error('The completed active-build decisions must be outside the Git repository.');
  }
  if (!statSync(canonicalDecisions).isFile()) throw new Error('Active-build decisions must be a regular file.');
  let serialized;
  try {
    serialized = readFileSync(canonicalDecisions, 'utf8');
  } catch (error) {
    throw new Error(`Could not read active-build decisions: ${error instanceof Error ? error.message : error}`);
  }
  const parsed = parseJsonWithoutDuplicateKeys(serialized, 'Active-build decisions');
  const ledger = exactObject(
    parsed,
    ['_copyWarning', '_privacyWarning', 'schemaVersion', 'recordType', 'activeGeneration', 'decisions'],
    'Active-build decisions',
  );
  if (typeof ledger._copyWarning !== 'string' || !ledger._copyWarning.includes('COPY OUTSIDE REPOSITORY')
    || typeof ledger._privacyWarning !== 'string' || !ledger._privacyWarning.includes('PRIVATE ONLY')) {
    throw new Error('Active-build decisions must retain their copy-outside-repository and private-only warnings.');
  }
  if (ledger.schemaVersion !== 2 || ledger.recordType !== ACTIVE_BUILD_DECISIONS_TYPE) {
    throw new Error('Active-build decisions schema or record type is unsupported.');
  }
  if (!Number.isSafeInteger(ledger.activeGeneration) || ledger.activeGeneration < 1
    || !Array.isArray(ledger.decisions) || ledger.decisions.length !== ledger.activeGeneration) {
    throw new Error('Active-build decisions must contain one contiguous entry per positive generation.');
  }
  const approvalIds = new Set();
  const references = new Set();
  const decisionCommitments = new Set();
  let previousApprovedAt = Number.NEGATIVE_INFINITY;
  const decisions = ledger.decisions.map((entry, index) => {
    const decision = exactObject(
      entry,
      ['generation', 'approvalId', 'decisionReference', 'approvedAt', 'decisionRecordSha256'],
      `Active-build decision generation ${index + 1}`,
    );
    if (decision.generation !== index + 1) throw new Error('Active-build decision generations must be contiguous and ordered.');
    validApprovalId(decision.approvalId, 'Active-build approval ID');
    validDecisionReference(decision.decisionReference, 'Active-build decision reference');
    const approvedAt = validTimestamp(decision.approvedAt, 'Active-build decision approval date');
    if (!SHA256_PATTERN.test(decision.decisionRecordSha256 || '')) {
      throw new Error('Active-build canonical decision commitment must be a SHA-256 value.');
    }
    if (approvedAt <= previousApprovedAt) {
      throw new Error('Active-build decision approval dates must increase strictly across generations.');
    }
    previousApprovedAt = approvedAt;
    if (approvalIds.has(decision.approvalId) || references.has(decision.decisionReference)
      || decisionCommitments.has(decision.decisionRecordSha256)) {
      throw new Error('Active-build approval IDs, decision references, and canonical commitments must be unique across generations.');
    }
    approvalIds.add(decision.approvalId);
    references.add(decision.decisionReference);
    decisionCommitments.add(decision.decisionRecordSha256);
    return Object.freeze({ ...decision, approvedAtMilliseconds: approvedAt });
  });
  const active = decisions.at(-1);
  if (active.approvalId !== approval.approvalId
    || active.decisionReference !== approval.decisionReference
    || active.approvedAtMilliseconds !== approval.approvedAt
    || active.decisionRecordSha256 !== approval.decisionRecordSha256) {
    throw new Error('Approved-build record is not the current active private decision.');
  }
  if (ledger.activeGeneration === 1) {
    if (approval.changeKind !== 'initial') throw new Error('The first active build decision must use initial change control.');
  } else {
    const previous = decisions.at(-2);
    if (approval.changeKind !== 'mid-study'
      || approval.replacesDecisionReference !== previous.decisionReference) {
      throw new Error('Active mid-study decision must replace the immediately preceding private decision.');
    }
    if (approval.rehearsalCompletedAt <= previous.approvedAtMilliseconds) {
      throw new Error('Mid-study rehearsal must occur after the preceding build approval.');
    }
  }
  const chainEntries = decisions.map(({
    generation, approvalId, decisionReference, approvedAt, decisionRecordSha256,
  }) => ({
    generation, approvalId, decisionReference, approvedAt, decisionRecordSha256,
  }));
  const decisionChainSha256 = sha256(JSON.stringify(chainEntries));
  const previousDecisionChainSha256 = chainEntries.length > 1
    ? sha256(JSON.stringify(chainEntries.slice(0, -1)))
    : null;
  return Object.freeze({
    schemaVersion: ledger.schemaVersion,
    activeGeneration: ledger.activeGeneration,
    activeHead: Object.freeze({
      approvalId: active.approvalId,
      decisionReference: active.decisionReference,
      approvedAt: active.approvedAt,
      decisionRecordSha256: active.decisionRecordSha256,
      decisionChainSha256,
    }),
    previousHead: decisions.length > 1 ? Object.freeze({
      approvalId: decisions.at(-2).approvalId,
      decisionReference: decisions.at(-2).decisionReference,
      approvedAt: decisions.at(-2).approvedAt,
      decisionRecordSha256: decisions.at(-2).decisionRecordSha256,
      decisionChainSha256: previousDecisionChainSha256,
    }) : null,
  });
}

function validateActiveBuildAnchor(value) {
  const anchor = exactObject(
    value,
    [
      'version', 'activeGeneration', 'approvalId', 'decisionReference', 'approvedAt',
      'decisionRecordSha256', 'decisionChainSha256',
    ],
    'Protected active-build anchor',
  );
  if (anchor.version !== 3 || !Number.isSafeInteger(anchor.activeGeneration)
    || anchor.activeGeneration < 1) {
    throw new Error('Protected active-build anchor version or generation is invalid.');
  }
  validApprovalId(anchor.approvalId, 'Protected active-build approval ID');
  validDecisionReference(anchor.decisionReference, 'Protected active-build decision reference');
  validTimestamp(anchor.approvedAt, 'Protected active-build approval date');
  if (!SHA256_PATTERN.test(anchor.decisionRecordSha256 || '')) {
    throw new Error('Protected active-build canonical decision commitment must be a SHA-256 value.');
  }
  if (!SHA256_PATTERN.test(anchor.decisionChainSha256 || '')) {
    throw new Error('Protected active-build decision-chain commitment must be a SHA-256 value.');
  }
  return Object.freeze({ ...anchor });
}

function sameActiveBuildHead(anchor, head) {
  return anchor.approvalId === head.approvalId
    && anchor.decisionReference === head.decisionReference
    && anchor.approvedAt === head.approvedAt
    && anchor.decisionRecordSha256 === head.decisionRecordSha256
    && anchor.decisionChainSha256 === head.decisionChainSha256;
}

function processIsActive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

function runWithActiveBuildLock(lockPath, callback) {
  let lock;
  const createLock = () => {
    const descriptor = openSync(lockPath, 'wx', 0o600);
    try {
      writeSync(descriptor, `${process.pid}\n`);
      return descriptor;
    } catch (error) {
      closeSync(descriptor);
      rmSync(lockPath, { force: true });
      throw error;
    }
  };
  const acquire = () => {
    try {
      lock = createLock();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let ownerPid = Number.NaN;
      try { ownerPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10); } catch { /* stale */ }
      let lockAgeMilliseconds = 0;
      try { lockAgeMilliseconds = Date.now() - statSync(lockPath).mtimeMs; } catch { /* stale */ }
      const ownerMayStillBeWriting = !Number.isSafeInteger(ownerPid)
        && lockAgeMilliseconds >= 0
        && lockAgeMilliseconds < 60_000;
      if (processIsActive(ownerPid) || ownerMayStillBeWriting) {
        throw new Error('Protected active-build anchor is currently being advanced by another setup process.');
      }
      rmSync(lockPath, { force: true });
      lock = createLock();
    }
  };
  acquire();
  try {
    return callback();
  } finally {
    if (lock !== undefined) closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

export function createMacosActiveBuildAnchor(
  run = spawnSync,
  platform = process.platform,
  lockPath = ACTIVE_ANCHOR_LOCK_PATH,
) {
  let exclusive = false;
  return Object.freeze({
    runExclusive(callback) {
      if (platform !== 'darwin') {
        throw new Error('The protected active-build anchor requires the study Mac keychain.');
      }
      return runWithActiveBuildLock(lockPath, () => {
        exclusive = true;
        try {
          return callback();
        } finally {
          exclusive = false;
        }
      });
    },
    read() {
      if (platform !== 'darwin') {
        throw new Error('The protected active-build anchor requires the study Mac keychain.');
      }
      const result = run('security', [
        'find-generic-password', '-a', ACTIVE_ANCHOR_ACCOUNT,
        '-s', ACTIVE_ANCHOR_SERVICE, '-w',
      ], { encoding: 'utf8' });
      if (result.status === 0) {
        return validateActiveBuildAnchor(parseJsonWithoutDuplicateKeys(
          result.stdout.trim(),
          'Protected active-build anchor',
        ));
      }
      if (result.status === 44 || /could not be found/i.test(result.stderr || '')) return null;
      throw new Error(`Could not read protected active-build anchor: ${result.stderr || result.error || `status ${result.status}`}`);
    },
    write(anchor) {
      if (!exclusive) {
        throw new Error('Protected active-build anchor writes require the exclusive process lock.');
      }
      const valid = validateActiveBuildAnchor(anchor);
      const result = run('security', [
        'add-generic-password', '-U', '-a', ACTIVE_ANCHOR_ACCOUNT,
        '-s', ACTIVE_ANCHOR_SERVICE, '-w', JSON.stringify(valid),
      ], { encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(`Could not update protected active-build anchor: ${result.stderr || result.error || `status ${result.status}`}`);
      }
    },
  });
}

function activeBuildTransition(activeDecision, current, stored) {
  if (stored === null) {
    if (current.activeGeneration !== 1) {
      throw new Error('Protected active-build anchor cannot start after generation 1.');
    }
    return true;
  }
  if (stored.activeGeneration > current.activeGeneration) {
    throw new Error('Protected active-build anchor rejects rolled-back private decision files.');
  }
  if (stored.activeGeneration === current.activeGeneration) {
    if (!sameActiveBuildHead(stored, current)) {
      throw new Error('Protected active-build anchor conflicts with this generation private decision head.');
    }
    return false;
  }
  if (stored.activeGeneration === current.activeGeneration - 1) {
    if (!activeDecision.previousHead || !sameActiveBuildHead(stored, activeDecision.previousHead)) {
      throw new Error('Protected active-build anchor does not match the immediately preceding private decision head.');
    }
    return true;
  }
  throw new Error('Protected active-build anchor cannot skip decision generations.');
}

function prepareActiveBuildAnchor(activeDecision, anchorStore) {
  if (!anchorStore || typeof anchorStore.read !== 'function' || typeof anchorStore.write !== 'function'
    || typeof anchorStore.runExclusive !== 'function') {
    throw new Error('A protected active-build anchor store is required.');
  }
  const storedValue = anchorStore.read();
  const stored = storedValue === null ? null : validateActiveBuildAnchor(storedValue);
  const current = Object.freeze({
    version: 3,
    activeGeneration: activeDecision.activeGeneration,
    ...activeDecision.activeHead,
  });
  activeBuildTransition(activeDecision, current, stored);
  return Object.freeze({
    activeGeneration: current.activeGeneration,
    approvalId: current.approvalId,
    commit() {
      anchorStore.runExclusive(() => {
        const latestValue = anchorStore.read();
        const latest = latestValue === null ? null : validateActiveBuildAnchor(latestValue);
        if (activeBuildTransition(activeDecision, current, latest)) anchorStore.write(current);
        const verifiedValue = anchorStore.read();
        const verified = verifiedValue === null ? null : validateActiveBuildAnchor(verifiedValue);
        if (!verified || verified.activeGeneration !== current.activeGeneration
          || !sameActiveBuildHead(verified, current)) {
          throw new Error('Protected active-build anchor update could not be verified after writing.');
        }
      });
    },
  });
}

function pngDimensions(bytes) {
  const signature = '89504e470d0a1a0a';
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== signature) {
    throw new Error('Study material is not a valid PNG.');
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function assertEmptyProject(projectDir) {
  if (!existsSync(projectDir) || !statSync(projectDir).isDirectory()) {
    throw new Error('Participant project folder must already exist as a directory.');
  }
  if (readdirSync(projectDir).length !== 0) {
    throw new Error('Participant project folder must be genuinely empty, including hidden files.');
  }
}

function verifyScenarioControls(repoRoot) {
  const board = readFileSync(join(repoRoot, 'src/lib/components/WorkflowBoard.svelte'), 'utf8');
  const executor = readFileSync(join(repoRoot, 'src/lib/integrations/providerFreeQaWorkflowExecutor.ts'), 'utf8');
  for (const label of ['Standard checkpoint', 'Branch recovery checkpoint', 'Format recovery checkpoint']) {
    if (!board.includes(label)) throw new Error(`Provider-free QA control is missing: ${label}`);
  }
  if (!executor.includes('format-recovery-checkpoint') || !executor.includes('branch-one-failure')) {
    throw new Error('Provider-free QA failure controls are incomplete.');
  }
}

function verifyMaterials(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== 1 || manifest.license !== 'CC0-1.0' || manifest.materials?.length !== 2) {
    throw new Error('Creator-study material manifest must contain exactly two CC0 Product PNGs.');
  }
  const materials = manifest.materials.map((material) => {
    const path = join(dirname(manifestPath), material.relativePath);
    const bytes = readFileSync(path);
    const dimensions = pngDimensions(bytes);
    const actualHash = sha256(bytes);
    if (actualHash !== material.sha256) throw new Error(`Material hash mismatch: ${material.relativePath}`);
    if (dimensions.width !== material.width || dimensions.height !== material.height) {
      throw new Error(`Material dimensions mismatch: ${material.relativePath}`);
    }
    if (!material.nonConfidential || ![1, 6].includes(material.task)) {
      throw new Error(`Material assignment is invalid: ${material.relativePath}`);
    }
    return { task: material.task, label: material.label, sha256: actualHash, ...dimensions };
  }).sort((a, b) => a.task - b.task);
  if (materials[0].task !== 1 || materials[1].task !== 6 || materials[0].sha256 === materials[1].sha256) {
    throw new Error('Tasks 1 and 6 require two distinct Product PNGs.');
  }
  return materials;
}

export function verifyStudySetup({
  repoRoot = scriptRoot,
  projectDir,
  rehearsalDir,
  approvedBuildRecordPath,
  activeBuildDecisionsPath,
  fixtureManifest = join(scriptRoot, 'docs/testing/creator-study/materials/manifest.json'),
  actualGitSha,
  actualSourceTreeSha,
  actualSourceStatusSha256,
  sourceDirty,
  bundleId,
  appBuild,
  actualExecutableSha256,
  now = new Date(),
  activeBuildAnchor,
  visibleEmptyStateAttested,
  macosMajorVersion,
  studySessionStatePath,
  studySessionConsumptionAnchor,
}) {
  if (!projectDir || !rehearsalDir) throw new Error('Project and rehearsal paths are required.');
  if (![projectDir, rehearsalDir, approvedBuildRecordPath, activeBuildDecisionsPath, fixtureManifest].every((path) => typeof path === 'string' && isAbsolute(path))) {
    throw new Error('Project, rehearsal, approved-build-record, active-build-decisions, and fixture-manifest paths must be absolute.');
  }
  const canonicalRepo = canonicalExisting(repoRoot, 'Git repository');
  const approval = readApprovedBuildRecord(approvedBuildRecordPath, canonicalRepo);
  const nowMilliseconds = now instanceof Date ? now.getTime() : Number.NaN;
  if (!Number.isFinite(nowMilliseconds)) throw new Error('Setup verification requires a valid current time.');
  if (approval.approvedAt > nowMilliseconds) {
    throw new Error('Approved-build owner approval cannot be in the future.');
  }
  const activeDecision = readActiveBuildDecisions(activeBuildDecisionsPath, canonicalRepo, approval);
  const protectedAnchor = prepareActiveBuildAnchor(activeDecision, activeBuildAnchor);
  const approved = approval.approvedBuild;
  if (actualGitSha !== approved.gitSha) {
    throw new Error(`Approved Git SHA mismatch: expected ${approved.gitSha}, received ${actualGitSha || '(missing)'}.`);
  }
  if (sourceDirty) throw new Error('Creator-study readiness cannot use dirty source.');
  if (bundleId !== EXPECTED_BUNDLE_ID) {
    throw new Error(`Wrong bundle identity: expected ${EXPECTED_BUNDLE_ID}.`);
  }
  if (!appBuild || appBuild.version !== 1 || appBuild.mode !== 'provider-free' || appBuild.bundleId !== EXPECTED_BUNDLE_ID) {
    throw new Error('Provider Free app build provenance is missing or invalid.');
  }
  if (appBuild.sourceDirty) throw new Error('Provider Free app was built from dirty source.');
  if (appBuild.gitSha !== actualGitSha || appBuild.gitSha !== approved.gitSha) {
    throw new Error('Provider Free app build Git SHA does not match the approved checkout.');
  }
  if (!actualSourceTreeSha || appBuild.sourceTreeSha !== actualSourceTreeSha) {
    throw new Error('Provider Free app source tree fingerprint does not match the checkout.');
  }
  if (!actualSourceStatusSha256 || appBuild.sourceStatusSha256 !== actualSourceStatusSha256) {
    throw new Error('Provider Free app source status fingerprint does not match the clean checkout.');
  }
  if (!/^[a-f0-9]{64}$/.test(actualExecutableSha256 || '')
    || appBuild.executableSha256 !== actualExecutableSha256) {
    throw new Error('Provider Free app executable fingerprint does not match its build provenance.');
  }
  if (approved.bundleId !== bundleId) throw new Error('Approved bundle identity does not match the app bundle.');
  if (approved.sourceTreeSha !== actualSourceTreeSha || approved.sourceTreeSha !== appBuild.sourceTreeSha) {
    throw new Error('Approved source tree does not match the checkout and app provenance.');
  }
  if (approved.sourceStatusSha256 !== actualSourceStatusSha256
    || approved.sourceStatusSha256 !== appBuild.sourceStatusSha256) {
    throw new Error('Approved source status does not match the checkout and app provenance.');
  }
  if (approved.executableSha256 !== actualExecutableSha256
    || approved.executableSha256 !== appBuild.executableSha256) {
    throw new Error('Approved executable fingerprint does not match the app executable and provenance.');
  }
  const studySession = appBuild.studySession;
  if (!studySession || studySession.version !== 3 || studySession.isolatedProfile !== true
    || !/^[a-f0-9]{64}$/.test(studySession.profileSha256 || '')) {
    throw new Error('Provider Free app does not use a valid isolated study profile. Start it with --fresh-study-session.');
  }
  if (studySession.launchIntent !== 'fresh') {
    throw new Error('Creator-study setup requires a fresh study session launch, not a resumed session.');
  }
  if (visibleEmptyStateAttested !== true) {
    throw new Error('The operator must attest the visible empty Project and Workflow state.');
  }
  if (!Number.isInteger(macosMajorVersion) || macosMajorVersion < 14) {
    throw new Error('Provider Free study isolation requires macOS 14 or newer.');
  }

  const canonicalProject = canonicalExisting(projectDir, 'Participant project folder');
  const canonicalRehearsal = canonicalDeletedPath(rehearsalDir);
  const canonicalManifest = canonicalExisting(fixtureManifest, 'Fixture manifest');
  if (isInside(canonicalRepo, canonicalProject) || isInside(canonicalRepo, canonicalRehearsal)) {
    throw new Error('Participant and rehearsal projects must be outside the Git repository.');
  }
  if (canonicalProject === canonicalRehearsal || isInside(canonicalProject, canonicalRehearsal)) {
    throw new Error('Participant and rehearsal projects must use separate paths.');
  }
  if (!isInside(canonicalRepo, canonicalManifest)) throw new Error('Fixture manifest must resolve inside the Git repository.');
  assertEmptyProject(canonicalProject);
  verifyScenarioControls(canonicalRepo);
  const materials = verifyMaterials(canonicalManifest);
  if (!studySessionStatePath || !isAbsolute(studySessionStatePath)) {
    throw new Error('Provider Free study session state path must be absolute.');
  }
  protectedAnchor.commit();
  const launchEvidence = verifyAndConsumeStudySessionBoot({
    statePath: studySessionStatePath,
    profileSha256: studySession.profileSha256,
    consumptionAnchor: studySessionConsumptionAnchor,
  });

  return Object.freeze({
    schemaVersion: 1,
    ready: true,
    gitSha: actualGitSha,
    bundleId,
    bundleName: EXPECTED_BUNDLE_NAME,
    approvedBuildIdentity: Object.freeze({ matched: true, ...approved }),
    approvalRecord: Object.freeze({
      schemaVersion: approval.schemaVersion,
      validated: true,
      changeKind: approval.changeKind,
      activeGeneration: protectedAnchor.activeGeneration,
      approvalId: protectedAnchor.approvalId,
    }),
    projectState: 'empty',
    rehearsalState: 'deleted',
    sessionReset: Object.freeze({
      isolatedProfile: true,
      profileSha256: studySession.profileSha256,
      macosMajorVersion,
      ...launchEvidence,
    }),
    manualAttestations: Object.freeze({ visibleEmptyProjectAndWorkflow: true }),
    scenarioControls: ['standard', 'branch-recovery', 'format-recovery'],
    materials,
    manualChecksStillRequired: [
      'visible rehearsal of both failure checkpoints',
      'editor return, save/reopen, and Place',
      'private study authorization and recording state',
    ],
  });
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

function readAppBundle(appBundle) {
  if (!isAbsolute(appBundle)) throw new Error('--app-bundle must be an absolute path.');
  const bundle = realpathSync(appBundle);
  accessSync(join(bundle, 'Contents/MacOS/PaintNode'), constants.X_OK);
  const plist = join(bundle, 'Contents/Info.plist');
  const result = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not read QA app bundle identity: ${result.stderr || result.error}`);
  return {
    bundleId: result.stdout.trim(),
    appBuild: readQaBuildProvenance(bundle),
    actualExecutableSha256: sha256File(join(bundle, 'Contents/MacOS/PaintNode')),
  };
}

function readMacosMajorVersion() {
  if (process.platform !== 'darwin') throw new Error('Creator-study native setup requires macOS 14 or newer.');
  const result = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not read macOS version: ${result.stderr || result.error}`);
  const major = Number.parseInt(result.stdout.trim().split('.')[0] ?? '', 10);
  if (!Number.isInteger(major)) throw new Error('Could not parse the macOS version.');
  return major;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--print-decision-commitment')) {
      process.stdout.write(`${JSON.stringify(approvedBuildDecisionCommitment({
        repoRoot: scriptRoot,
        approvedBuildRecordPath: valueAfter(args, '--approved-build-record'),
      }), null, 2)}\n`);
    } else {
      const sourceState = captureSourceState(scriptRoot);
      const app = readAppBundle(valueAfter(args, '--app-bundle'));
      const receipt = verifyStudySetup({
        repoRoot: scriptRoot,
        projectDir: valueAfter(args, '--project-dir'),
        rehearsalDir: valueAfter(args, '--rehearsal-dir'),
        approvedBuildRecordPath: valueAfter(args, '--approved-build-record'),
        activeBuildDecisionsPath: valueAfter(args, '--active-build-decisions'),
        actualGitSha: sourceState.gitSha,
        actualSourceTreeSha: sourceState.sourceTreeSha,
        actualSourceStatusSha256: sourceState.sourceStatusSha256,
        sourceDirty: sourceState.sourceDirty,
        activeBuildAnchor: createMacosActiveBuildAnchor(),
        visibleEmptyStateAttested: args.includes('--visible-empty-state-attested'),
        macosMajorVersion: readMacosMajorVersion(),
        studySessionStatePath: join(scriptRoot, 'src-tauri', '.provider-free-study-session.json'),
        studySessionConsumptionAnchor: createMacKeychainStudySessionConsumptionAnchor(),
        ...app,
      });
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    }
  } catch (error) {
    console.error(`[creator-study-setup] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
