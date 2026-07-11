import { createHash } from 'node:crypto';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import {
  accessSync, constants, lstatSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  qaBuildIdentitySha256,
  qaBuildProvenancePath,
  parseJsonWithoutDuplicateKeys,
  sha256File,
} from './native-qa-build-provenance.mjs';
import {
  assertProviderFreeStudyPlatform,
  markStudySessionLaunchAttempted,
  providerFreeStudyBootEnvironment,
  providerFreeStudyProfileEnvironment,
  readProviderFreeStudySession,
  resolveProviderFreeStudySession,
  studySessionBootEvidencePath,
  studySessionLaunchEvidencePath,
} from './native-qa-session.mjs';

const EXPECTED_BUNDLE_ID = 'com.paintnode.editor.blueprintqa.provider.free';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultStatePath = join(root, 'src-tauri', '.provider-free-study-session.json');

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function defaultBundleIdentifier(appBundle) {
  const result = spawnSync('plutil', [
    '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', join(appBundle, 'Contents/Info.plist'),
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Could not read Provider Free app bundle identity: ${result.stderr || result.error}`);
  }
  return result.stdout.trim();
}

function assertRegularNotSymlink(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file.`);
}

export function readExistingStudyApp({ appBundle, readBundleIdentifier = defaultBundleIdentifier }) {
  if (!isAbsolute(appBundle)) throw new Error('--app-bundle must be an absolute path.');
  const bundle = realpathSync(appBundle);
  const executable = join(bundle, 'Contents/MacOS/PaintNode');
  accessSync(executable, constants.X_OK);
  assertRegularNotSymlink(executable, 'Provider Free executable');
  const provenancePath = qaBuildProvenancePath(bundle);
  assertRegularNotSymlink(provenancePath, 'Provider Free static provenance sidecar');
  const provenanceBytes = readFileSync(provenancePath);
  const provenance = parseJsonWithoutDuplicateKeys(provenanceBytes.toString('utf8'), 'QA build provenance');
  if (provenance.studyCapable !== true || Object.hasOwn(provenance, 'studySession')) {
    throw new Error('Provider Free study launch requires study-capable static provenance without session fields.');
  }
  if (provenance.mode !== 'provider-free' || provenance.bundleId !== EXPECTED_BUNDLE_ID
    || readBundleIdentifier(bundle) !== EXPECTED_BUNDLE_ID) {
    throw new Error('Provider Free study launch requires the approved Provider Free bundle identity.');
  }
  const executableSha256 = sha256File(executable);
  if (executableSha256 !== provenance.executableSha256) {
    throw new Error('Provider Free executable fingerprint does not match static provenance.');
  }
  return Object.freeze({
    appBundle: bundle,
    executable,
    provenance: Object.freeze({ ...provenance }),
    provenanceSha256: sha256Bytes(provenanceBytes),
    executableSha256,
    buildIdentitySha256: qaBuildIdentitySha256(provenance),
  });
}

export function sameStaticStudyApp(left, right) {
  return left.appBundle === right.appBundle
    && left.executable === right.executable
    && left.provenanceSha256 === right.provenanceSha256
    && left.executableSha256 === right.executableSha256
    && left.buildIdentitySha256 === right.buildIdentitySha256;
}

export function readStudySessionLaunchBinding({
  statePath = defaultStatePath,
  readBundleIdentifier = defaultBundleIdentifier,
}) {
  const session = readProviderFreeStudySession(statePath);
  const evidence = readLaunchEvidence(statePath);
  const app = readExistingStudyApp({ appBundle: evidence.appBundlePath, readBundleIdentifier });
  if (!evidenceMatchesApp(evidence, app, session)) {
    throw new Error('Provider Free launch binding does not match the preserved approved bundle and session.');
  }
  return Object.freeze({ session, evidence: Object.freeze({ ...evidence }), app });
}

function readLaunchEvidence(statePath) {
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(studySessionLaunchEvidencePath(statePath), 'utf8'));
  } catch {
    throw new Error('Provider Free create-only launch evidence is missing.');
  }
  if (evidence?.version !== 1 || evidence?.event !== 'study-launch'
    || evidence.launchIntent !== 'fresh' || !isAbsolute(evidence.appBundlePath ?? '')
    || !/^[a-f0-9]{64}$/.test(evidence.profileSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(evidence.provenanceSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(evidence.executableSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(evidence.buildIdentitySha256 ?? '')) {
    throw new Error('Provider Free launch evidence is malformed.');
  }
  return evidence;
}

function evidenceMatchesApp(evidence, app, session) {
  return evidence.appBundlePath === app.appBundle
    && evidence.profileSha256 === session.profileSha256
    && evidence.provenanceSha256 === app.provenanceSha256
    && evidence.executableSha256 === app.executableSha256
    && evidence.buildIdentitySha256 === app.buildIdentitySha256;
}

async function waitForCurrentBoot({ statePath, session, app, child, timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let launchError;
  child.once?.('error', (error) => { launchError = error; });
  while (Date.now() <= deadline) {
    if (launchError) throw new Error(`Provider Free study app could not launch: ${launchError.message}`);
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`Provider Free study app exited before verified boot (status ${child.exitCode}).`);
    }
    try {
      const evidence = JSON.parse(readFileSync(studySessionBootEvidencePath(statePath), 'utf8'));
      if (evidence?.version === 3 && evidence?.event === 'app-boot'
        && evidence.profileSha256 === session.profileSha256
        && evidence.bootNonceSha256 === session.bootNonceSha256
        && evidence.buildIdentitySha256 === app.buildIdentitySha256) {
        return;
      }
    } catch { /* native evidence is not ready yet */ }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, pollMs));
  }
  throw new Error('Timed out waiting for current-nonce Provider Free native boot evidence.');
}

export async function launchExistingProviderFreeStudyApp({
  appBundle,
  statePath = defaultStatePath,
  fresh = false,
  resume = false,
  platform = process.platform,
  productVersion,
  randomUUID,
  randomBytes,
  readBundleIdentifier = defaultBundleIdentifier,
  spawn = nodeSpawn,
  bootTimeoutMs = 20_000,
  bootPollMs = 50,
}) {
  if (fresh === resume) throw new Error('Choose exactly one of --fresh-study-session or --resume-study-session.');
  let version = productVersion;
  if (version === undefined) {
    const result = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Could not read macOS version: ${result.stderr || result.error}`);
    version = result.stdout.trim();
  }
  assertProviderFreeStudyPlatform(platform, version);

  const before = readExistingStudyApp({ appBundle, readBundleIdentifier });
  const launch = resolveProviderFreeStudySession({
    mode: 'provider-free', fresh, resume, buildOnly: false, statePath, randomUUID, randomBytes,
  });
  const session = launch.session;
  if (resume) {
    const prior = readLaunchEvidence(statePath);
    if (!evidenceMatchesApp(prior, before, session)) {
      throw new Error('Resume must use the same preserved approved bundle and fresh-session evidence.');
    }
  }
  const preSpawn = readExistingStudyApp({ appBundle, readBundleIdentifier });
  if (!sameStaticStudyApp(before, preSpawn)) throw new Error('Provider Free static bundle changed before launch.');

  if (fresh) {
    writeFileSync(studySessionLaunchEvidencePath(statePath), `${JSON.stringify({
      version: 1,
      event: 'study-launch',
      launchIntent: 'fresh',
      profileSha256: session.profileSha256,
      appBundlePath: before.appBundle,
      provenanceSha256: before.provenanceSha256,
      executableSha256: before.executableSha256,
      buildIdentitySha256: before.buildIdentitySha256,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }

  const env = {
    ...process.env,
    PAINTNODE_PROVIDER_QA_MODE: 'provider-free',
    PAINTNODE_PROVIDER_FREE_STUDY_PROFILE: providerFreeStudyProfileEnvironment(session),
  };
  if (fresh) {
    Object.assign(env, providerFreeStudyBootEnvironment(session, statePath), {
      PAINTNODE_PROVIDER_FREE_STUDY_BUILD_IDENTITY: before.buildIdentitySha256,
    });
    markStudySessionLaunchAttempted(statePath);
  }
  const child = spawn(before.executable, ['-ApplePersistenceIgnoreState', 'YES'], {
    cwd: root,
    env,
    detached: true,
    stdio: 'ignore',
  });
  try {
    if (fresh) {
      await waitForCurrentBoot({
        statePath, session, app: before, child, timeoutMs: bootTimeoutMs, pollMs: bootPollMs,
      });
      const afterBoot = readExistingStudyApp({ appBundle, readBundleIdentifier });
      if (!sameStaticStudyApp(before, afterBoot)) throw new Error('Provider Free static bundle changed during launch.');
    } else {
      const afterSpawn = readExistingStudyApp({ appBundle, readBundleIdentifier });
      if (!sameStaticStudyApp(before, afterSpawn)) throw new Error('Provider Free static bundle changed during resume.');
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      throw new Error(`Provider Free study app exited before launch returned (status ${child.exitCode}).`);
    }
    child.unref();
    return Object.freeze({
      launchIntent: launch.launchIntent,
      profileSha256: session.profileSha256,
      buildIdentitySha256: before.buildIdentitySha256,
      appBootObserved: fresh,
      appStillRunning: true,
    });
  } catch (error) {
    child.kill?.();
    throw error;
  }
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const receipt = await launchExistingProviderFreeStudyApp({
      appBundle: valueAfter(args, '--app-bundle'),
      fresh: args.includes('--fresh-study-session'),
      resume: args.includes('--resume-study-session'),
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    console.error(`[native-qa-study-launch] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
