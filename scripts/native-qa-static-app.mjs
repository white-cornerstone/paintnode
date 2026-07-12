import { spawnSync } from 'node:child_process';
import {
  accessSync, constants, lstatSync, readFileSync, realpathSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  parseJsonWithoutDuplicateKeys, qaBuildIdentitySha256, qaBuildProvenancePath, sha256File,
} from './native-qa-build-provenance.mjs';
import { readMacosStaticCodeIdentity } from './native-qa-code-identity.mjs';

function defaultBundleIdentifier(appBundle) {
  const result = spawnSync('plutil', [
    '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(appBundle, 'Contents/Info.plist'),
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not read QA app bundle identity: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

function assertRegularNotSymlink(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file.`);
}

export function readStaticQaApp({
  appBundle,
  expectedBundleId,
  requireStudyCapable = false,
  readBundleIdentifier = defaultBundleIdentifier,
  readStaticCodeIdentity = readMacosStaticCodeIdentity,
}) {
  if (!isAbsolute(appBundle)) throw new Error('--app-bundle must be an absolute path.');
  const bundle = realpathSync(appBundle);
  const executable = join(bundle, 'Contents/MacOS/PaintNode');
  accessSync(executable, constants.X_OK);
  assertRegularNotSymlink(executable, 'QA executable');
  const provenancePath = qaBuildProvenancePath(bundle);
  assertRegularNotSymlink(provenancePath, 'QA static provenance sidecar');
  const provenanceBytes = readFileSync(provenancePath);
  const provenance = parseJsonWithoutDuplicateKeys(provenanceBytes.toString('utf8'), 'QA build provenance');
  if (expectedBundleId && (provenance.bundleId !== expectedBundleId
    || readBundleIdentifier(bundle) !== expectedBundleId)) {
    throw new Error('QA app does not have the expected bundle identity.');
  }
  if (requireStudyCapable && (provenance.studyCapable !== true || Object.hasOwn(provenance, 'studySession'))) {
    throw new Error('Provider Free study launch requires study-capable static provenance without session fields.');
  }
  const executableSha256 = sha256File(executable);
  if (executableSha256 !== provenance.executableSha256) {
    throw new Error('QA executable fingerprint does not match static provenance.');
  }
  if (requireStudyCapable) {
    if (!/^[a-f0-9]{40,64}$/.test(provenance.codeIdentity?.cdHash ?? '')) {
      throw new Error('QA static provenance does not contain a valid macOS CDHash.');
    }
    const codeIdentity = readStaticCodeIdentity(executable);
    if (codeIdentity.cdHash !== provenance.codeIdentity?.cdHash) {
      throw new Error('QA executable CDHash does not match static provenance.');
    }
  }
  return Object.freeze({
    appBundle: bundle,
    executable,
    provenance: Object.freeze({ ...provenance }),
    provenanceSha256: createHash('sha256').update(provenanceBytes).digest('hex'),
    executableSha256,
    buildIdentitySha256: qaBuildIdentitySha256(provenance),
    codeIdentity: provenance.codeIdentity ? Object.freeze({ ...provenance.codeIdentity }) : null,
  });
}
