import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';

const SESSION_VERSION = 3;

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
  if (typeof value.launchAttempted !== 'boolean') throw new Error('Provider Free launch-attempt state is invalid.');
  if (typeof value.setupConsumed !== 'boolean') throw new Error('Provider Free setup-consumption state is invalid.');
  if (value.setupConsumed && !value.launchAttempted) {
    throw new Error('Provider Free setup cannot be consumed before a launch attempt.');
  }
  return Object.freeze({
    version: SESSION_VERSION,
    dataStoreIdentifier: Object.freeze(dataStoreIdentifier),
    profileSha256,
    bootNonce,
    bootNonceSha256: value.bootNonceSha256,
    launchAttempted: value.launchAttempted,
    setupConsumed: value.setupConsumed,
  });
}

export function studySessionBootEvidencePath(statePath) {
  return `${statePath}.boot.json`;
}

export function studySessionCleanupEvidencePath(statePath) {
  return `${statePath}.cleanup.json`;
}

export function studySessionLaunchEvidencePath(statePath) {
  return `${statePath}.launch.json`;
}

export function studySessionConsumeLockPath(statePath) {
  return `${statePath}.consume.lock`;
}

function removeInactiveConsumeLock(statePath) {
  const lockPath = studySessionConsumeLockPath(statePath);
  if (!existsSync(lockPath)) return;
  let ownerPid = Number.NaN;
  try { ownerPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10); } catch { /* stale */ }
  if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && ownerPid !== process.pid) {
    try {
      process.kill(ownerPid, 0);
      throw new Error('Provider Free setup evidence is currently being consumed by another process.');
    } catch (error) {
      if (error instanceof Error && error.message.includes('currently being consumed')) throw error;
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  rmSync(lockPath, { force: true });
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
    launchAttempted: false,
    setupConsumed: false,
  });
}

export function writeProviderFreeStudySession(path, session, options = {}) {
  const valid = validateSession(session);
  writeFileSync(path, `${JSON.stringify(valid, null, 2)}\n`, {
    mode: 0o600,
    ...(options.createOnly ? { flag: 'wx' } : {}),
  });
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
  if (!['fresh', 'resume'].includes(launchIntent)) {
    throw new Error('Provider Free live study launch intent must be fresh or resume.');
  }
  return Object.freeze({
    version: SESSION_VERSION,
    isolatedProfile: true,
    launchIntent,
    profileSha256: valid.profileSha256,
  });
}

export function studySessionBuildOnlyEvidence() {
  return Object.freeze({
    version: SESSION_VERSION,
    isolatedProfile: false,
    launchIntent: 'build-only',
  });
}

export function resolveProviderFreeStudySession({
  mode,
  fresh = false,
  resume = false,
  buildOnly = false,
  statePath,
  randomUUID: randomUUIDOverride,
  randomBytes: randomBytesOverride,
}) {
  if (fresh && resume) throw new Error('Choose either a fresh or resumed study session, not both.');
  if (!fresh && !resume) return null;
  if (mode !== 'provider-free') throw new Error('Study session isolation is available only in Provider Free mode.');
  if (!statePath) throw new Error('Provider Free study session state path is required.');
  if (buildOnly) return Object.freeze({ session: null, launchIntent: 'build-only' });
  if (fresh) {
    if (existsSync(statePath)) {
      throw new Error('The prior Provider Free study session must be finalized before a fresh session can start.');
    }
    rmSync(studySessionBootEvidencePath(statePath), { force: true });
    rmSync(studySessionCleanupEvidencePath(statePath), { force: true });
    rmSync(studySessionLaunchEvidencePath(statePath), { force: true });
    removeInactiveConsumeLock(statePath);
    const session = createFreshProviderFreeStudySession({
      randomUUID: randomUUIDOverride,
      randomBytes: randomBytesOverride,
    });
    try {
      writeProviderFreeStudySession(statePath, session, { createOnly: true });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error('The prior Provider Free study session must be finalized before a fresh session can start.');
      }
      throw error;
    }
    return Object.freeze({ session, launchIntent: 'fresh' });
  }
  const session = readProviderFreeStudySession(statePath);
  if (!session.setupConsumed) throw new Error('A study session can resume only after its one-time setup evidence was consumed.');
  return Object.freeze({ session, launchIntent: 'resume' });
}

export function markStudySessionLaunchAttempted(statePath) {
  const session = readProviderFreeStudySession(statePath);
  if (session.setupConsumed) throw new Error('A consumed Provider Free study session cannot start a new first launch.');
  if (!session.launchAttempted) {
    writeProviderFreeStudySession(statePath, { ...session, launchAttempted: true });
  }
  return readProviderFreeStudySession(statePath);
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

export function verifyAndConsumeStudySessionBoot({
  statePath, profileSha256, buildIdentitySha256, provenanceSha256,
  executableSha256, consumptionAnchor,
}) {
  if (!consumptionAnchor?.hasConsumed || !consumptionAnchor?.consume) {
    throw new Error('Provider Free setup requires a separately protected single-Mac consumption anchor.');
  }
  const lockPath = studySessionConsumeLockPath(statePath);
  let lock;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
    writeSync(lock, `${process.pid}\n`);
  } catch {
    throw new Error('Provider Free setup evidence is already being consumed.');
  }
  try {
    const session = readProviderFreeStudySession(statePath);
    if (!session.launchAttempted) throw new Error('Provider Free app launch was not attempted.');
    if (session.setupConsumed) throw new Error('Provider Free setup evidence has already been consumed.');
    if (consumptionAnchor.hasConsumed(session.profileSha256)) {
      throw new Error('The monotonic single-Mac anchor reports this Provider Free setup evidence was already consumed.');
    }
    if (session.profileSha256 !== profileSha256) throw new Error('Provider Free boot profile does not match build provenance.');
    let evidence;
    try {
      evidence = JSON.parse(readFileSync(studySessionBootEvidencePath(statePath), 'utf8'));
    } catch {
      throw new Error('Provider Free app boot evidence is missing; build-only or unlaunched bundles cannot pass setup.');
    }
    if (evidence?.version !== SESSION_VERSION || evidence?.event !== 'app-boot'
      || evidence.profileSha256 !== session.profileSha256
      || evidence.bootNonceSha256 !== session.bootNonceSha256
      || evidence.buildIdentitySha256 !== buildIdentitySha256) {
      throw new Error('Provider Free app boot evidence is stale or mismatched.');
    }
    let launch;
    try {
      launch = JSON.parse(readFileSync(studySessionLaunchEvidencePath(statePath), 'utf8'));
    } catch {
      throw new Error('Provider Free create-only launch evidence is missing.');
    }
    if (launch?.version !== 1 || launch?.event !== 'study-launch'
      || launch.launchIntent !== 'fresh' || launch.profileSha256 !== session.profileSha256
      || launch.buildIdentitySha256 !== buildIdentitySha256
      || launch.provenanceSha256 !== provenanceSha256
      || launch.executableSha256 !== executableSha256) {
      throw new Error('Provider Free launch evidence is stale or mismatched.');
    }
    consumptionAnchor.consume(session.profileSha256, session.bootNonceSha256);
    writeProviderFreeStudySession(statePath, { ...session, setupConsumed: true });
    return Object.freeze({
      appBootObserved: true,
      setupEvidenceConsumed: true,
      monotonicAnchorRecorded: true,
    });
  } finally {
    if (lock !== undefined) closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

export function prepareStudySessionCleanup(statePath, options = {}) {
  const session = readProviderFreeStudySession(statePath);
  const intent = options.intent ?? 'finalize';
  if (!['abort', 'finalize'].includes(intent)) throw new Error('Study session cleanup intent must be abort or finalize.');
  if (intent === 'finalize' && !session.setupConsumed) {
    throw new Error('Only a session with consumed setup evidence can be finalized; use the supported abort command instead.');
  }
  if (intent === 'abort' && session.setupConsumed) {
    throw new Error('A session with consumed setup evidence must use finalize, not abort.');
  }
  const cleanupNonce = (options.randomBytes ?? randomBytes)(32).toString('hex');
  rmSync(studySessionCleanupEvidencePath(statePath), { force: true });
  return Object.freeze({
    session,
    cleanupNonce,
    cleanupNonceSha256: sha256Hex(Buffer.from(cleanupNonce, 'hex')),
    evidencePath: studySessionCleanupEvidencePath(statePath),
    intent,
    requiresNativeCleanup: session.launchAttempted,
  });
}

function removeStudySessionLifecycleFiles(statePath, evidencePath) {
  rmSync(statePath, { force: true });
  rmSync(studySessionBootEvidencePath(statePath), { force: true });
  rmSync(evidencePath, { force: true });
  rmSync(studySessionLaunchEvidencePath(statePath), { force: true });
  removeInactiveConsumeLock(statePath);
}

export function abortStudySessionWithoutNativeCleanup(statePath, prepared) {
  const session = readProviderFreeStudySession(statePath);
  if (prepared.intent !== 'abort' || prepared.requiresNativeCleanup || session.launchAttempted) {
    throw new Error('A launched Provider Free study session requires verified native data-store cleanup.');
  }
  if (session.profileSha256 !== prepared.session.profileSha256) {
    throw new Error('Provider Free study abort state changed after cleanup preparation.');
  }
  removeStudySessionLifecycleFiles(statePath, prepared.evidencePath);
  return Object.freeze({
    profileSha256: session.profileSha256,
    dataStoreRemoved: false,
    dataStoreCreated: false,
    aborted: true,
    finalized: true,
  });
}

export function verifyAndFinalizeStudySessionCleanup(statePath, prepared) {
  const session = readProviderFreeStudySession(statePath);
  if (!prepared.requiresNativeCleanup || !session.launchAttempted) {
    throw new Error('Native data-store cleanup evidence is not applicable to an unlaunched session.');
  }
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
  removeStudySessionLifecycleFiles(statePath, prepared.evidencePath);
  return Object.freeze({
    profileSha256: session.profileSha256,
    dataStoreRemoved: true,
    dataStoreRemovalVerified: true,
    aborted: prepared.intent === 'abort',
    finalized: true,
  });
}

export function applyStudySessionWindowIsolation(windowConfig, session) {
  if (session !== undefined) validateSession(session);
  return { ...windowConfig, create: false };
}
