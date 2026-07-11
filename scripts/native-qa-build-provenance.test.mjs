import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  captureCleanSourceState,
  qaBuildProvenancePath,
  writeQaBuildProvenance,
} from './native-qa-build-provenance.mjs';

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test('source capture rejects tracked and untracked dirty state', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-build-source-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'Test Only');
  writeFileSync(join(root, 'tracked.txt'), 'clean\n');
  git(root, 'add', 'tracked.txt');
  git(root, 'commit', '-qm', 'fixture');

  const clean = captureCleanSourceState(root);
  assert.match(clean.gitSha, /^[a-f0-9]{40}$/);
  assert.match(clean.sourceTreeSha, /^[a-f0-9]{40}$/);

  writeFileSync(join(root, 'untracked.txt'), 'dirty\n');
  assert.throws(() => captureCleanSourceState(root), /source is dirty/i);
});

test('bundle provenance fingerprints the actual executable and source state', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-build-bundle-'));
  const appBundle = join(root, 'Provider Free.app');
  const executable = join(appBundle, 'Contents/MacOS/PaintNode');
  mkdirSync(join(appBundle, 'Contents/MacOS'), { recursive: true });
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);

  const provenance = writeQaBuildProvenance({
    appBundle,
    mode: 'provider-free',
    bundleId: 'com.paintnode.editor.blueprintqa.provider.free',
    sourceState: {
      gitSha: 'a'.repeat(40), sourceTreeSha: 'b'.repeat(40), sourceDirty: false,
      sourceStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    },
  });
  assert.match(provenance.executableSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    JSON.parse(readFileSync(qaBuildProvenancePath(appBundle), 'utf8')),
    provenance,
  );
});

test('native QA build writes provenance before launching the built executable', () => {
  const source = readFileSync(new URL('./native-qa-app.mjs', import.meta.url), 'utf8');
  assert.match(source, /captureSourceState\(root\)/);
  assert.match(source, /writeQaBuildProvenance/);
  assert.ok(source.indexOf('writeQaBuildProvenance({') < source.indexOf("console.log(`[native-qa] launching"));
});
