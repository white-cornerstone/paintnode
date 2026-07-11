import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const SESSION_VERSION = 1;

export function assertProviderFreeStudyPlatform(platform, productVersion) {
  const major = Number.parseInt(String(productVersion).split('.')[0] ?? '', 10);
  if (platform !== 'darwin' || !Number.isInteger(major)) {
    throw new Error('Provider Free study isolation requires a readable macOS version and macOS 14 or newer.');
  }
  if (major < 14) throw new Error('Provider Free study isolation requires macOS 14 or newer.');
  return major;
}

function profileSha256(dataStoreIdentifier) {
  return createHash('sha256').update(Uint8Array.from(dataStoreIdentifier)).digest('hex');
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

function validateSession(value) {
  if (!value || value.version !== SESSION_VERSION) {
    throw new Error('Provider Free study session state has an unsupported version.');
  }
  const dataStoreIdentifier = validateDataStoreIdentifier(value.dataStoreIdentifier);
  const expectedFingerprint = profileSha256(dataStoreIdentifier);
  if (value.profileSha256 !== expectedFingerprint) {
    throw new Error('Provider Free study profile fingerprint does not match its identifier.');
  }
  return Object.freeze({
    version: SESSION_VERSION,
    dataStoreIdentifier: Object.freeze(dataStoreIdentifier),
    profileSha256: expectedFingerprint,
  });
}

export function createFreshProviderFreeStudySession(options = {}) {
  const dataStoreIdentifier = uuidBytes((options.randomUUID ?? randomUUID)());
  return validateSession({
    version: SESSION_VERSION,
    dataStoreIdentifier,
    profileSha256: profileSha256(dataStoreIdentifier),
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
  if (!['fresh', 'resume'].includes(launchIntent)) {
    throw new Error('Provider Free study launch intent must be fresh or resume.');
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
}) {
  if (fresh && resume) throw new Error('Choose either a fresh or resumed study session, not both.');
  if (!fresh && !resume) return null;
  if (mode !== 'provider-free') {
    throw new Error('Study session isolation is available only in Provider Free mode.');
  }
  if (!statePath) throw new Error('Provider Free study session state path is required.');
  if (fresh) {
    const session = createFreshProviderFreeStudySession({ randomUUID: randomUUIDOverride });
    writeProviderFreeStudySession(statePath, session);
    return Object.freeze({ session, launchIntent: 'fresh' });
  }
  return Object.freeze({ session: readProviderFreeStudySession(statePath), launchIntent: 'resume' });
}

export function providerFreeStudyProfileEnvironment(session) {
  const valid = validateSession(session);
  return valid.dataStoreIdentifier.map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function applyStudySessionWindowIsolation(windowConfig, session) {
  validateSession(session);
  return { ...windowConfig, create: false };
}
