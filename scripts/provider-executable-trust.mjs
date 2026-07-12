import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';

const PROVIDER_TEAMS = {
  codex: '2DC432GLL2',
  antigravity: 'EQHXZ8M8AV',
  grok: '5Y6N3AJ54S',
};

function structuredGatekeeperPair(raw, key, value) {
  const marker = `<key>${key}</key>`;
  const index = raw.indexOf(marker);
  return index >= 0 && raw.slice(index + marker.length).trimStart().startsWith(value);
}

export function assertSafeExecutablePath(provider, path) {
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error(`${provider} executable path contains unsafe control characters.`);
  }
}

export function assertMacProviderTrustInspection(provider, inspection) {
  if (!PROVIDER_TEAMS[provider]) throw new Error(`Unsupported provider ${provider}.`);
  if (inspection.codesignStatus !== 0) {
    throw new Error(`${provider} executable failed its pinned macOS code-signature requirement.`);
  }
  const raw = inspection.gatekeeperRaw;
  const accepted =
    inspection.gatekeeperStatus === 0 && structuredGatekeeperPair(raw, 'assessment:verdict', '<true/>');
  const validStandaloneCli =
    inspection.gatekeeperStatus !== 0 &&
    structuredGatekeeperPair(raw, 'assessment:verdict', '<false/>') &&
    structuredGatekeeperPair(raw, 'assessment:cserror', '<integer>-67002</integer>');
  if (!accepted && !validStandaloneCli) {
    throw new Error(`${provider} executable was rejected by macOS Gatekeeper.`);
  }
}

export function inspectMacProviderTrust(provider, path) {
  assertSafeExecutablePath(provider, path);
  const team = PROVIDER_TEAMS[provider];
  if (!team) throw new Error(`Unsupported provider ${provider}.`);
  const requirement = `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`;
  const codesign = spawnSync(
    '/usr/bin/codesign',
    ['--verify', '--strict', '--verbose=2', '-R', requirement, path],
    { encoding: 'utf8', timeout: 15_000 },
  );
  const gatekeeper = spawnSync(
    '/usr/sbin/spctl',
    ['--assess', '--type', 'execute', '--verbose=4', '--raw', path],
    { encoding: 'utf8', timeout: 15_000 },
  );
  for (const [label, result] of [
    ['codesign verification', codesign],
    ['Gatekeeper inspection', gatekeeper],
  ]) {
    if (result.error) throw new Error(`${provider} ${label} failed before launch: ${result.error.message}`);
  }
  assertMacProviderTrustInspection(provider, {
    codesignStatus: codesign.status,
    gatekeeperStatus: gatekeeper.status,
    gatekeeperRaw: gatekeeper.stdout ?? '',
  });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function captureExecutableIdentity(path, platform = process.platform) {
  const canonicalPath = realpathSync(path);
  const stat = statSync(canonicalPath, { bigint: true });
  const identity = { version: 1, length: stat.size.toString() };
  if (platform === 'win32') {
    identity.sha256 = sha256(canonicalPath);
  } else {
    identity.unix = {
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
      changedSeconds: (stat.ctimeNs / 1_000_000_000n).toString(),
      changedNanoseconds: (stat.ctimeNs % 1_000_000_000n).toString(),
    };
  }
  return { canonicalPath, identity };
}

function identitiesMatch(actual, expected) {
  if (actual.version !== expected?.version || actual.length !== expected?.length) return false;
  if (actual.sha256 !== undefined || expected?.sha256 !== undefined) return actual.sha256 === expected?.sha256;
  return (
    actual.unix?.device === expected?.unix?.device &&
    actual.unix?.inode === expected?.unix?.inode &&
    actual.unix?.changedSeconds === expected?.unix?.changedSeconds &&
    actual.unix?.changedNanoseconds === expected?.unix?.changedNanoseconds
  );
}

export function assertProviderExecutableReady(provider, path, serializedIdentity) {
  assertSafeExecutablePath(provider, path);
  if (!serializedIdentity) throw new Error(`${provider} executable identity is required before launch.`);
  let expected;
  try {
    expected = JSON.parse(serializedIdentity);
  } catch {
    throw new Error(`${provider} executable identity is malformed.`);
  }
  const captured = captureExecutableIdentity(path);
  const pathChanged = process.platform !== 'win32' && captured.canonicalPath !== path;
  if (pathChanged || !identitiesMatch(captured.identity, expected)) {
    throw new Error(`${provider} executable changed after Rust verification.`);
  }
  if (process.platform === 'darwin') inspectMacProviderTrust(provider, path);
  const afterTrust = captureExecutableIdentity(path);
  const pathChangedDuringTrust = process.platform !== 'win32' && afterTrust.canonicalPath !== path;
  if (pathChangedDuringTrust || !identitiesMatch(afterTrust.identity, expected)) {
    throw new Error(`${provider} executable changed during launch trust verification.`);
  }
}
