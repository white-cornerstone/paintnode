import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';

import {
  assertMacProviderSignature,
  assertProviderCapabilityOutput,
  providerCapabilityArgs,
  resolveProviderLaunch,
  runProviderCommand,
  terminateProviderTree,
} from './provider-qa-preflight.mjs';

function executable(path, contents = '#!/bin/sh\nexit 0\n') {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

test('Codex npm launchers are unwrapped to the signed native executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-preflight-'));
  const packageRoot = join(root, 'lib', 'node_modules', '@openai', 'codex');
  const wrapper = join(packageRoot, 'bin', 'codex.js');
  const publicPath = join(root, 'bin', 'codex');
  const native = join(
    packageRoot,
    'node_modules',
    '@openai',
    'codex-darwin-arm64',
    'vendor',
    'aarch64-apple-darwin',
    'bin',
    'codex',
  );

  mkdirSync(join(packageRoot, 'bin'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(native, '..'), { recursive: true });
  executable(wrapper, '#!/usr/bin/env node\n');
  executable(native);
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '9.8.7' }));
  symlinkSync(wrapper, publicPath);

  const resolved = resolveProviderLaunch('codex', publicPath, {
    platform: 'darwin',
    arch: 'arm64',
  });

  assert.equal(resolved.requestedPath, publicPath);
  assert.equal(resolved.launchPath, realpathSync(native));
  assert.equal(resolved.versionHint, '9.8.7');
  assert.equal(resolved.unwrapped, true);
});

test('direct provider executables remain direct and relative paths fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-preflight-'));
  const agy = join(root, 'agy');
  executable(agy);

  const canonicalAgy = realpathSync(agy);
  assert.deepEqual(resolveProviderLaunch('antigravity', agy), {
    provider: 'antigravity',
    requestedPath: agy,
    resolvedPath: canonicalAgy,
    launchPath: canonicalAgy,
    versionHint: null,
    unwrapped: false,
  });
  assert.throws(() => resolveProviderLaunch('codex', 'codex'), /absolute path/i);
});

test('macOS signature validation rejects revoked or unexpected provider identities', () => {
  const validCodex = [
    'Identifier=codex',
    'Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)',
    'TeamIdentifier=2DC432GLL2',
  ].join('\n');

  assert.doesNotThrow(() =>
    assertMacProviderSignature('codex', '/trusted/codex', {
      codesignStatus: 0,
      codesignOutput: validCodex,
      gatekeeperStatus: 3,
      gatekeeperOutput: '/trusted/codex: rejected (the code is valid but does not seem to be an app)',
    }),
  );
  assert.throws(
    () =>
      assertMacProviderSignature('codex', '/stale/codex', {
        codesignStatus: 0,
        codesignOutput: validCodex,
        gatekeeperStatus: 3,
        gatekeeperOutput: '/stale/codex: CSSMERR_TP_CERT_REVOKED',
      }),
    /revoked/i,
  );
  assert.throws(
    () =>
      assertMacProviderSignature('antigravity', '/fake/agy', {
        codesignStatus: 0,
        codesignOutput: 'Identifier=cli\nTeamIdentifier=NOT_GOOGLE',
        gatekeeperStatus: 0,
        gatekeeperOutput: '',
      }),
    /EQHXZ8M8AV/,
  );
  assert.throws(
    () =>
      assertMacProviderSignature('codex', '/untrusted/codex', {
        codesignStatus: 0,
        codesignOutput: validCodex,
        gatekeeperStatus: 3,
        gatekeeperOutput: '/untrusted/codex: rejected (source=Unnotarized Developer ID)',
      }),
    /Gatekeeper rejected/i,
  );
});

test('provider doctor uses no-cost auth and capability commands only', () => {
  assert.deepEqual(providerCapabilityArgs('codex'), ['login', 'status']);
  assert.deepEqual(providerCapabilityArgs('antigravity'), ['models']);
  assert.doesNotThrow(() => assertProviderCapabilityOutput('codex', 'Logged in using ChatGPT'));
  assert.doesNotThrow(() => assertProviderCapabilityOutput('antigravity', 'Gemini 3.1 Pro (High)'));
  assert.throws(() => assertProviderCapabilityOutput('codex', 'Not logged in'), /not authenticated/i);
  assert.throws(() => assertProviderCapabilityOutput('codex', 'No longer logged in.'), /not authenticated/i);
  assert.throws(() => assertProviderCapabilityOutput('codex', 'Last logged in: yesterday'), /not authenticated/i);
  assert.throws(() => assertProviderCapabilityOutput('codex', 'warning only'), /not authenticated/i);
  assert.throws(() => assertProviderCapabilityOutput('antigravity', 'No models available'), /no available models/i);
  assert.throws(() => assertProviderCapabilityOutput('antigravity', 'Authentication required'), /no available models/i);
  assert.throws(() => assertProviderCapabilityOutput('antigravity', 'Failed to fetch models'), /no available models/i);
  assert.throws(
    () => assertProviderCapabilityOutput('antigravity', 'warning: model service unavailable'),
    /no available models/i,
  );
  assert.throws(() => assertProviderCapabilityOutput('antigravity', '  '), /no available models/i);
});

test('Windows tree termination falls back and surfaces taskkill failure', () => {
  const signals = [];
  const child = {
    pid: 42,
    kill(signal) {
      signals.push(signal);
      return true;
    },
  };
  const result = terminateProviderTree(child, 'win32', () => ({
    status: 1,
    error: new Error('taskkill denied'),
    stderr: 'access denied',
  }));

  assert.deepEqual(signals, ['SIGKILL']);
  assert.match(result.cleanupError, /taskkill/i);
  assert.equal(result.immediateProcessKillRequested, true);
});

test('timed-out provider checks kill the whole Unix process group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'paintnode-provider-timeout-'));
  const provider = join(root, 'hanging-provider');
  const pids = join(root, 'pids');
  executable(
    provider,
    `#!/bin/sh\necho "$$" > '${pids}'\nsh -c 'while :; do sleep 1; done' &\necho "$!" >> '${pids}'\nwhile :; do sleep 1; done\n`,
  );

  await assert.rejects(
    runProviderCommand('codex', provider, ['--version'], 1_000, { platform: 'darwin' }),
    /timed out/i,
  );

  const recorded = readFileSync(pids, 'utf8').trim().split(/\s+/).map(Number);
  assert.equal(recorded.length, 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const pid of recorded) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
});
