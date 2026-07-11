import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const BUILD_PROVENANCE_SUFFIX = '.paintnode-qa-build.json';

export function qaBuildProvenancePath(appBundle) {
  return `${realpathSync(appBundle)}${BUILD_PROVENANCE_SUFFIX}`;
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Could not inspect QA build source: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function captureSourceState(root) {
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  return Object.freeze({
    gitSha: git(root, ['rev-parse', 'HEAD']),
    sourceTreeSha: git(root, ['rev-parse', 'HEAD^{tree}']),
    sourceDirty: status.length > 0,
    sourceStatusSha256: createHash('sha256').update(status).digest('hex'),
  });
}

export function captureCleanSourceState(root) {
  const state = captureSourceState(root);
  if (state.sourceDirty) throw new Error('QA study build source is dirty; commit or remove every change before building evidence.');
  return state;
}

export function writeQaBuildProvenance({ appBundle, mode, bundleId, sourceState }) {
  const bundle = realpathSync(appBundle);
  const executable = join(bundle, 'Contents/MacOS/PaintNode');
  accessSync(executable, constants.X_OK);
  const provenance = Object.freeze({
    version: 1,
    mode,
    bundleId,
    gitSha: sourceState.gitSha,
    sourceTreeSha: sourceState.sourceTreeSha,
    sourceDirty: sourceState.sourceDirty,
    sourceStatusSha256: sourceState.sourceStatusSha256,
    executableSha256: sha256File(executable),
  });
  const output = qaBuildProvenancePath(bundle);
  writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

export function readQaBuildProvenance(appBundle) {
  return JSON.parse(readFileSync(qaBuildProvenancePath(appBundle), 'utf8'));
}
