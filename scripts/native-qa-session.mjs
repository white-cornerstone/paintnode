import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';

const SESSION_VERSION = 2;

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function assertProviderFreeStudyPlatform(platform, productVersion) {
  const major = Number.parseInt(String(productVersion).split('.')[0] ?? '', 10);
  if (platform !== 'darwin' || !Number.isInteger(major)) {
    throw new Error('Provider Free study isolation requires a readable macOS version and macOS 14 or newer.');
  }
  if (major < 14) throw new Error('Provider Free study isolation requires macOS 14 or newer.');
  return major;
}

function validateDataStoreIdentifier(value) {
  if (!Array.isArray(value) || value.length !== 16
    || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('Provider Free study profile identifier must contain exactly 16 bytes.');
  }
  return [...value];
}

function uuidBytes(uuid) {
  const hex = uuid.replaceAll('-', '');
  if (!/^[a-f0-9]{32}$/i.test(hex)) throw new Error('Could not generate a valid Provider Free study profile identifier.');
  return Array.from(Buffer.from(hex, 'hex'));
}

function validateHex(value, label) {
  if (!/^[a-f0-9]{64}$/.test(value || '')) throw new Error(`${label} must contain exactly 64 lowercase hexadecimal characters.`);
  return value;
}

function validateSession(value) {
  if (!value || value.version !== SESSION_VERSION) {
    throw new Error('Provider Free study session state has an unsupported version.');
  }
  const dataStoreIdentifier = validateDataStoreIdentifier(value.dataStoreIdentifier);
  const profileSha256 = sha256Hex(Uint8Array.from(dataStoreIdentifier));
  if (value.profileSha256 !== profileSha256) {
    throw new Error('Provider Free study profile fingerprint does not match its identifier.');
  }
  const bootNonce = validateHex(value.bootNonce, 'Provider Free study boot nonce');
  if (value.bootNonceSha256 !== sha256Hex(Buffer.from(bootNonce, 'hex'))) {
    throw new Error('Provider Free study boot nonce fingerprint does not match.');
  }
  if (typeof value.setupConsumed !== 'boolean') throw new Error('Provider Free setup-consumption state is invalid.');
  return Object.freeze({
    version: SESSION_VERSION,
    dataStoreIdentifier: Object.freeze(dataStoreIdentifier),
    profileSha256,
    bootNonce,
    bootNonceSha256: value.bootNonceSha256,
    setupConsumed: value.setupConsumed,
  });
}

export function studySessionBootEvidencePath(statePath) {
  return `${statePath}.boot.json`;
}

export function studySessionCleanupEvidencePath(statePath) {
  return `${statePath}.cleanup.json`;
}

export function createFreshProviderFreeStudySession(options = {}) {
  const dataStoreIdentifier = uuidBytes((options.randomUUID ?? randomUUID)());
  const bootNonce = (options.randomBytes ?? randomBytes)(32).toString('hex');
  return validateSession({
    version: SESSION_VERSION,
    dataStoreIdentifier,
    profileSha256: sha256Hex(Uint8Array.from(dataStoreIdentifier)),
    bootNonce,
    bootNonceSha256: sha256Hex(Buffer.from(bootNonce, 'hex')),
    setupConsumed: false,
  });
}

export function writeProviderFreeStudySession(path, session) {
  const valid = validateSession(session);
  writeFileSync(path, `${JSON.stringify(valid, null, 2)}\n`, { mode: 0o600 });
}

export function readProviderFreeStudySession(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read the Provider Free study session. Start a fresh study session first. ${error instanceof Error ? error.message : error}`);
  }
  return validateSession(parsed);
}

export function studySessionBuildEvidence(session, launchIntent) {
  const valid = validateSession(session);
  if (!['fresh', 'resume', 'build-only'].includes(launchIntent)) {
    throw new Error('Provider Free study launch intent must be fresh, resume, or build-only.');
  }
  return Object.freeze({
    version: SESSION_VERSION,
    isolatedProfile: true,
    launchIntent,
    profileSha256: valid.profileSha256,
  });
}

export function resolveProviderFreeStudySession({
  mode,
  fresh = false,
  resume = false,
  statePath,
  randomUUID: randomUUIDOverride,
  randomBytes: randomBytesOverride,
}) {
  if (fresh && resume) throw new Error('Choose either a fresh or resumed study session, not both.');
  if (!fresh && !resume) return null;
  if (mode !== 'provider-free') throw new Error('Study session isolation is available only in Provider Free mode.');
  if (!statePath) throw new Error('Provider Free study session state path is required.');
  if (fresh) {
    if (existsSync(statePath)) {
      throw new Error('The prior Provider Free study session must be finalized before a fresh session can start.');
    }
    rmSync(studySessionBootEvidencePath(statePath), { force: true });
    rmSync(studySessionCleanupEvidencePath(statePath), { force: true });
    const session = createFreshProviderFreeStudySession({
      randomUUID: randomUUIDOverride,
      randomBytes: randomBytesOverride,
    });
    writeProviderFreeStudySession(statePath, session);
    return Object.freeze({ session, launchIntent: 'fresh' });
  }
  const session = readProviderFreeStudySession(statePath);
  if (!session.setupConsumed) throw new Error('A study session can resume only after its one-time setup evidence was consumed.');
  return Object.freeze({ session, launchIntent: 'resume' });
}

export function providerFreeStudyProfileEnvironment(session) {
  const valid = validateSession(session);
  return valid.dataStoreIdentifier.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function providerFreeStudyBootEnvironment(session, statePath) {
  const valid = validateSession(session);
  return Object.freeze({
    PAINTNODE_PROVIDER_FREE_STUDY_BOOT_NONCE: valid.bootNonce,
    PAINTNODE_PROVIDER_FREE_STUDY_BOOT_EVIDENCE: studySessionBootEvidencePath(statePath),
  });
}

export function verifyAndConsumeStudySessionBoot({ statePath, profileSha256 }) {
  const lockPath = `${statePath}.consume.lock`;
  let lock;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  } catch {
    throw new Error('Provider Free setup evidence is already being consumed.');
  }
  try {
    const session = readProviderFreeStudySession(statePath);
    if (session.setupConsumed) throw new Error('Provider Free setup evidence has already been consumed.');
    if (session.profileSha256 !== profileSha256) throw new Error('Provider Free boot profile does not match build provenance.');
    let evidence;
    try {
      evidence = JSON.parse(readFileSync(studySessionBootEvidencePath(statePath), 'utf8'));
    } catch {
      throw new Error('Provider Free app boot evidence is missing; build-only or unlaunched bundles cannot pass setup.');
    }
    if (evidence?.version !== SESSION_VERSION || evidence?.event !== 'app-boot'
      || evidence.profileSha256 !== session.profileSha256
      || evidence.bootNonceSha256 !== session.bootNonceSha256) {
      throw new Error('Provider Free app boot evidence is stale or mismatched.');
    }
    writeProviderFreeStudySession(statePath, { ...session, setupConsumed: true });
    return Object.freeze({ appBootObserved: true, setupEvidenceConsumed: true });
  } finally {
    if (lock !== undefined) closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

export function prepareStudySessionCleanup(statePath, options = {}) {
  const session = readProviderFreeStudySession(statePath);
  const cleanupNonce = (options.randomBytes ?? randomBytes)(32).toString('hex');
  rmSync(studySessionCleanupEvidencePath(statePath), { force: true });
  return Object.freeze({
    session,
    cleanupNonce,
    cleanupNonceSha256: sha256Hex(Buffer.from(cleanupNonce, 'hex')),
    evidencePath: studySessionCleanupEvidencePath(statePath),
  });
}

export function verifyAndFinalizeStudySessionCleanup(statePath, prepared) {
  const session = readProviderFreeStudySession(statePath);
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(prepared.evidencePath, 'utf8'));
  } catch {
    throw new Error('Provider Free study cleanup evidence is missing.');
  }
  if (evidence?.version !== SESSION_VERSION || evidence?.event !== 'profile-removed'
    || evidence.profileSha256 !== session.profileSha256
    || evidence.cleanupNonceSha256 !== prepared.cleanupNonceSha256) {
    throw new Error('Provider Free study cleanup evidence is stale or mismatched.');
  }
  rmSync(statePath, { force: true });
  rmSync(studySessionBootEvidencePath(statePath), { force: true });
  rmSync(prepared.evidencePath, { force: true });
  return Object.freeze({ profileSha256: session.profileSha256, dataStoreRemoved: true, finalized: true });
}

export function applyStudySessionWindowIsolation(windowConfig, session) {
  validateSession(session);
  return { ...windowConfig, create: false };
}
