import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const BUILD_PROVENANCE_SUFFIX = '.paintnode-qa-build.json';

export function parseJsonWithoutDuplicateKeys(serialized, label = 'JSON document') {
  let index = 0;
  const skipWhitespace = () => {
    while (/\s/.test(serialized[index] ?? '')) index += 1;
  };
  const parseString = () => {
    const start = index;
    if (serialized[index] !== '"') throw new Error(`${label} must contain valid JSON.`);
    index += 1;
    while (index < serialized.length) {
      if (serialized[index] === '\\') index += 2;
      else if (serialized[index] === '"') {
        index += 1;
        return JSON.parse(serialized.slice(start, index));
      } else index += 1;
    }
    throw new Error(`${label} must contain valid JSON.`);
  };
  const parseValue = () => {
    skipWhitespace();
    if (serialized[index] === '{') {
      index += 1;
      const keys = new Set();
      skipWhitespace();
      if (serialized[index] === '}') { index += 1; return; }
      while (index < serialized.length) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new Error(`${label} contains duplicate field ${key}.`);
        keys.add(key);
        skipWhitespace();
        if (serialized[index] !== ':') throw new Error(`${label} must contain valid JSON.`);
        index += 1;
        parseValue();
        skipWhitespace();
        if (serialized[index] === '}') { index += 1; return; }
        if (serialized[index] !== ',') throw new Error(`${label} must contain valid JSON.`);
        index += 1;
      }
      throw new Error(`${label} must contain valid JSON.`);
    }
    if (serialized[index] === '[') {
      index += 1;
      skipWhitespace();
      if (serialized[index] === ']') { index += 1; return; }
      while (index < serialized.length) {
        parseValue();
        skipWhitespace();
        if (serialized[index] === ']') { index += 1; return; }
        if (serialized[index] !== ',') throw new Error(`${label} must contain valid JSON.`);
        index += 1;
      }
      throw new Error(`${label} must contain valid JSON.`);
    }
    if (serialized[index] === '"') { parseString(); return; }
    const start = index;
    while (index < serialized.length && !/[\s,\]}]/.test(serialized[index])) index += 1;
    if (start === index) throw new Error(`${label} must contain valid JSON.`);
  };
  parseValue();
  skipWhitespace();
  if (index !== serialized.length) throw new Error(`${label} must contain valid JSON.`);
  try {
    return JSON.parse(serialized);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

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

export function qaBuildIdentity(provenance) {
  if (!provenance || provenance.version !== 1
    || !['normal', 'provider-free', 'provider-e2e'].includes(provenance.mode)
    || typeof provenance.bundleId !== 'string'
    || !/^[a-f0-9]{40}$/.test(provenance.gitSha ?? '')
    || !/^[a-f0-9]{40}$/.test(provenance.sourceTreeSha ?? '')
    || typeof provenance.sourceDirty !== 'boolean'
    || !/^[a-f0-9]{64}$/.test(provenance.sourceStatusSha256 ?? '')
    || !/^[a-f0-9]{64}$/.test(provenance.executableSha256 ?? '')) {
    throw new Error('QA build provenance does not contain a valid static identity.');
  }
  return Object.freeze({
    version: provenance.version,
    mode: provenance.mode,
    bundleId: provenance.bundleId,
    gitSha: provenance.gitSha,
    sourceTreeSha: provenance.sourceTreeSha,
    sourceDirty: provenance.sourceDirty,
    sourceStatusSha256: provenance.sourceStatusSha256,
    executableSha256: provenance.executableSha256,
    studyCapable: provenance.studyCapable === true,
    codeIdentityCdHash: provenance.studyCapable === true ? provenance.codeIdentity?.cdHash : null,
  });
}

export function qaBuildIdentitySha256(provenance) {
  return createHash('sha256').update(JSON.stringify(qaBuildIdentity(provenance))).digest('hex');
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

export function writeQaBuildProvenance({
  appBundle, mode, bundleId, sourceState, studyCapable = false, codeIdentity = null,
  studySession = null,
}) {
  const bundle = realpathSync(appBundle);
  const executable = join(bundle, 'Contents/MacOS/PaintNode');
  accessSync(executable, constants.X_OK);
  if (studyCapable && !/^[a-f0-9]{40,64}$/.test(codeIdentity?.cdHash ?? '')) {
    throw new Error('Study-capable QA build provenance requires the approved macOS CDHash.');
  }
  const provenance = Object.freeze({
    version: 1,
    mode,
    bundleId,
    gitSha: sourceState.gitSha,
    sourceTreeSha: sourceState.sourceTreeSha,
    sourceDirty: sourceState.sourceDirty,
    sourceStatusSha256: sourceState.sourceStatusSha256,
    executableSha256: sha256File(executable),
    ...(studyCapable ? { studyCapable: true } : {}),
    ...(studyCapable ? { codeIdentity: Object.freeze({ cdHash: codeIdentity.cdHash }) } : {}),
    ...(studySession ? { studySession: Object.freeze({ ...studySession }) } : {}),
  });
  const output = qaBuildProvenancePath(bundle);
  writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

export function readQaBuildProvenance(appBundle) {
  return parseJsonWithoutDuplicateKeys(
    readFileSync(qaBuildProvenancePath(appBundle), 'utf8'),
    'QA build provenance',
  );
}
