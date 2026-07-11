import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const EXPECTED_BUNDLE_ID = 'com.paintnode.editor.blueprintqa.provider.free';
export const EXPECTED_BUNDLE_NAME = 'PaintNode Blueprint QA — Provider Free';

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isInside(parent, candidate) {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
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

function assertRehearsalDeleted(rehearsalDir) {
  if (existsSync(rehearsalDir)) {
    throw new Error('The separate rehearsal project must be deleted before participant setup is ready.');
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
  bundleId,
}) {
  if (!projectDir || !rehearsalDir) throw new Error('Project and rehearsal paths are required.');
  if (![projectDir, rehearsalDir, fixtureManifest].every(isAbsolute)) {
    throw new Error('Project, rehearsal, and fixture-manifest paths must be absolute.');
  }
  if (!expectedGitSha || actualGitSha !== expectedGitSha) {
    throw new Error(`Git SHA mismatch: expected ${expectedGitSha || '(missing)'}, received ${actualGitSha || '(missing)'}.`);
  }
  if (bundleId !== EXPECTED_BUNDLE_ID) {
    throw new Error(`Wrong bundle identity: expected ${EXPECTED_BUNDLE_ID}.`);
  }
  if (isInside(repoRoot, projectDir) || isInside(repoRoot, rehearsalDir)) {
    throw new Error('Participant and rehearsal projects must be outside the Git repository.');
  }
  if (resolve(projectDir) === resolve(rehearsalDir)) {
    throw new Error('Participant and rehearsal projects must use separate paths.');
  }
  assertEmptyProject(projectDir);
  assertRehearsalDeleted(rehearsalDir);
  verifyScenarioControls(repoRoot);
  const materials = verifyMaterials(fixtureManifest);

  return Object.freeze({
    schemaVersion: 1,
    ready: true,
    gitSha: actualGitSha,
    bundleId,
    bundleName: EXPECTED_BUNDLE_NAME,
    projectState: 'empty',
    rehearsalState: 'deleted',
    scenarioControls: ['standard', 'branch-recovery', 'format-recovery'],
    materials,
    manualChecksStillRequired: [
      'fresh app state',
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

function readBundleId(appBundle) {
  if (!isAbsolute(appBundle)) throw new Error('--app-bundle must be an absolute path.');
  const bundle = realpathSync(appBundle);
  accessSync(join(bundle, 'Contents/MacOS/PaintNode'), constants.X_OK);
  const plist = join(bundle, 'Contents/Info.plist');
  const result = spawnSync('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not read QA app bundle identity: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

function currentGitSha(repoRoot) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Could not read the current Git SHA.');
  return result.stdout.trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const receipt = verifyStudySetup({
      repoRoot: scriptRoot,
      projectDir: valueAfter(args, '--project-dir'),
      rehearsalDir: valueAfter(args, '--rehearsal-dir'),
      expectedGitSha: valueAfter(args, '--expected-sha'),
      actualGitSha: currentGitSha(scriptRoot),
      bundleId: readBundleId(valueAfter(args, '--app-bundle')),
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    console.error(`[creator-study-setup] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
