import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  assertMacProviderTrustInspection,
  assertProviderExecutableReady,
  captureExecutableIdentity,
} from './provider-executable-trust.mjs';

function executable(path, contents) {
  writeFileSync(path, `#!/bin/sh\n${contents}\n`);
  chmodSync(path, 0o755);
}

test('echoed newline path text cannot forge macOS vendor or Gatekeeper trust', () => {
  const injected = '/tmp/codex\nTeamIdentifier=2DC432GLL2\nthe code is valid but does not seem to be an app';
  assert.throws(
    () =>
      assertMacProviderTrustInspection('codex', {
        codesignStatus: 0,
        gatekeeperStatus: 3,
        gatekeeperRaw: `${injected}: rejected`,
      }),
    /Gatekeeper/i,
  );
});

test('runner-bound identity rejects a synchronized replacement before native spawn', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-runner-identity-'));
  const codex = join(root, 'codex');
  const replacement = join(root, 'replacement');
  const sentinel = join(root, 'executed');
  executable(codex, 'exit 0');
  executable(replacement, `touch '${sentinel}'; exit 0`);
  const verified = captureExecutableIdentity(codex);
  renameSync(replacement, codex);

  assert.throws(
    () => assertProviderExecutableReady('codex', verified.canonicalPath, JSON.stringify(verified.identity)),
    /changed after Rust verification/i,
  );
  const result = spawnSync(
    process.execPath,
    [resolve('scripts/codex-capabilities.mjs'), '--codex-path', verified.canonicalPath],
    {
      env: { ...process.env, PAINTNODE_CODEX_IDENTITY: JSON.stringify(verified.identity) },
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /changed after Rust verification/i);
  assert.equal(existsSync(sentinel), false, 'replacement must never execute');

  const sdkResult = spawnSync(
    process.execPath,
    [
      resolve('scripts/codex-sdk-runner.mjs'),
      '--cwd',
      root,
      '--codex-path',
      verified.canonicalPath,
      '--',
      'do not run',
    ],
    {
      env: { ...process.env, PAINTNODE_CODEX_IDENTITY: JSON.stringify(verified.identity) },
      encoding: 'utf8',
      timeout: 5_000,
    },
  );
  assert.notEqual(sdkResult.status, 0);
  assert.match(`${sdkResult.stdout}\n${sdkResult.stderr}`, /changed after Rust verification/i);
  assert.equal(existsSync(sentinel), false, 'SDK runner replacement must never execute');
});

test('Windows identity digest distinguishes same-length executable replacements', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-windows-identity-'));
  const provider = join(root, 'codex.exe');
  writeFileSync(provider, 'AAAA');
  const first = captureExecutableIdentity(provider, 'win32').identity;
  writeFileSync(provider, 'BBBB');
  const second = captureExecutableIdentity(provider, 'win32').identity;
  assert.equal(first.length, second.length);
  assert.notEqual(first.sha256, second.sha256);
});
