import { spawnSync } from 'node:child_process';

const SERVICE = 'com.paintnode.editor.blueprintqa.provider.free.study-consumption-v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function validFingerprint(value, label) {
  if (!SHA256_PATTERN.test(value ?? '')) {
    throw new Error(`${label} must contain exactly 64 lowercase hexadecimal characters.`);
  }
  return value;
}

export function createMemoryStudySessionConsumptionAnchor(initialProfiles = []) {
  const consumed = new Set(initialProfiles.map((profile) => validFingerprint(profile, 'Consumed profile')));
  return Object.freeze({
    hasConsumed(profileSha256) {
      return consumed.has(validFingerprint(profileSha256, 'Provider Free study profile fingerprint'));
    },
    consume(profileSha256) {
      const profile = validFingerprint(profileSha256, 'Provider Free study profile fingerprint');
      if (consumed.has(profile)) {
        throw new Error('The monotonic single-Mac anchor reports this Provider Free setup evidence was already consumed.');
      }
      consumed.add(profile);
    },
  });
}

function keychainItemExists(run, profileSha256) {
  const result = run('security', [
    'find-generic-password', '-s', SERVICE, '-a', profileSha256,
  ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.status === 0) return true;
  if (result.status === 44 || /could not be found/i.test(result.stderr ?? '')) return false;
  throw new Error(`Could not read the Provider Free single-Mac consumption anchor: ${result.stderr || result.error || `status ${result.status}`}`);
}

export function createMacKeychainStudySessionConsumptionAnchor(options = {}) {
  const run = options.spawnSync ?? spawnSync;
  return Object.freeze({
    hasConsumed(profileSha256) {
      const profile = validFingerprint(profileSha256, 'Provider Free study profile fingerprint');
      return keychainItemExists(run, profile);
    },
    consume(profileSha256, bootNonceSha256) {
      const profile = validFingerprint(profileSha256, 'Provider Free study profile fingerprint');
      const boot = validFingerprint(bootNonceSha256, 'Provider Free study boot nonce fingerprint');
      if (keychainItemExists(run, profile)) {
        throw new Error('The monotonic single-Mac anchor reports this Provider Free setup evidence was already consumed.');
      }
      const result = run('security', [
        'add-generic-password',
        '-s', SERVICE,
        '-a', profile,
        '-w', JSON.stringify({ version: 1, bootNonceSha256: boot }),
      ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
      if (result.status !== 0) {
        if (keychainItemExists(run, profile)) {
          throw new Error('The monotonic single-Mac anchor reports this Provider Free setup evidence was already consumed.');
        }
        throw new Error(`Could not update the Provider Free single-Mac consumption anchor: ${result.stderr || result.error || `status ${result.status}`}`);
      }
    },
  });
}
