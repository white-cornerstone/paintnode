import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { captureSourceState, readQaBuildProvenance, sha256File } from './native-qa-build-provenance.mjs';
import { verifyAndConsumeStudySessionBoot } from './native-qa-session.mjs';

export const EXPECTED_BUNDLE_ID = 'com.paintnode.editor.blueprintqa.provider.free';
export const EXPECTED_BUNDLE_NAME = 'PaintNode Blueprint QA — Provider Free';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
  fixtureManifest = join(scriptRoot, 'docs/testing/creator-study/materials/manifest.json'),
  expectedGitSha,
  actualGitSha,
  actualSourceTreeSha,
  actualSourceStatusSha256,
  sourceDirty,
  bundleId,
  appBuild,
  actualExecutableSha256,
  visibleEmptyStateAttested,
  macosMajorVersion,
  studySessionStatePath,
}) {
  if (!projectDir || !rehearsalDir) throw new Error('Project and rehearsal paths are required.');
  if (![projectDir, rehearsalDir, fixtureManifest].every(isAbsolute)) {
    throw new Error('Project, rehearsal, and fixture-manifest paths must be absolute.');
  }
  if (!expectedGitSha || actualGitSha !== expectedGitSha) {
    throw new Error(`Git SHA mismatch: expected ${expectedGitSha || '(missing)'}, received ${actualGitSha || '(missing)'}.`);
  }
  if (sourceDirty) throw new Error('Creator-study readiness cannot use dirty source.');
  if (bundleId !== EXPECTED_BUNDLE_ID) {
    throw new Error(`Wrong bundle identity: expected ${EXPECTED_BUNDLE_ID}.`);
  }
  if (!appBuild || appBuild.version !== 1 || appBuild.mode !== 'provider-free' || appBuild.bundleId !== EXPECTED_BUNDLE_ID) {
    throw new Error('Provider Free app build provenance is missing or invalid.');
  }
  if (appBuild.sourceDirty) throw new Error('Provider Free app was built from dirty source.');
  if (appBuild.gitSha !== actualGitSha || appBuild.gitSha !== expectedGitSha) {
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
  const studySession = appBuild.studySession;
  if (!studySession || studySession.version !== 2 || studySession.isolatedProfile !== true
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

  const canonicalRepo = canonicalExisting(repoRoot, 'Git repository');
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
  const launchEvidence = verifyAndConsumeStudySessionBoot({
    statePath: studySessionStatePath,
    profileSha256: studySession.profileSha256,
  });

  return Object.freeze({
    schemaVersion: 1,
    ready: true,
    gitSha: actualGitSha,
    bundleId,
    bundleName: EXPECTED_BUNDLE_NAME,
    appBuild: Object.freeze({ ...appBuild }),
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
    const sourceState = captureSourceState(scriptRoot);
    const app = readAppBundle(valueAfter(args, '--app-bundle'));
    const receipt = verifyStudySetup({
      repoRoot: scriptRoot,
      projectDir: valueAfter(args, '--project-dir'),
      rehearsalDir: valueAfter(args, '--rehearsal-dir'),
      expectedGitSha: valueAfter(args, '--expected-sha'),
      actualGitSha: sourceState.gitSha,
      actualSourceTreeSha: sourceState.sourceTreeSha,
      actualSourceStatusSha256: sourceState.sourceStatusSha256,
      sourceDirty: sourceState.sourceDirty,
      visibleEmptyStateAttested: args.includes('--visible-empty-state-attested'),
      macosMajorVersion: readMacosMajorVersion(),
      studySessionStatePath: join(scriptRoot, 'src-tauri', '.provider-free-study-session.json'),
      ...app,
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    console.error(`[creator-study-setup] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
