import assert from 'node:assert/strict';
import test from 'node:test';

import {
  readMacosStaticCodeIdentity,
  verifyMacosRunningCodeIdentity,
} from './native-qa-code-identity.mjs';

test('static and dynamic macOS code identity use the exact approved CDHash', () => {
  const calls = [];
  const cdHash = 'a'.repeat(40);
  const run = (command, args) => {
    calls.push({ command, args });
    if (args.includes('--display')) return { status: 0, stdout: '', stderr: `CDHash=${cdHash}\n` };
    return { status: 0, stdout: '', stderr: '' };
  };
  const executable = '/approved/PaintNode QA.app/Contents/MacOS/PaintNode';
  assert.deepEqual(readMacosStaticCodeIdentity(executable, run), { cdHash });
  assert.deepEqual(verifyMacosRunningCodeIdentity(4242, { cdHash }, run), { cdHash, pid: 4242 });
  assert.deepEqual(calls[0].args, [
    '--verify', '--strict', '--verbose=2', '/approved/PaintNode QA.app',
  ]);
  assert.equal(calls.some(({ args }) => args.includes(executable) && args.includes('--display')), true);
  assert.equal(calls.some(({ args }) => args.includes('+4242')), true);
  assert.equal(calls.some(({ args }) => args.includes(`-R=cdhash H"${cdHash}"`)), true);
});

test('dynamic macOS code identity rejects a swapped interpreter process', () => {
  const cdHash = 'a'.repeat(40);
  assert.throws(() => verifyMacosRunningCodeIdentity(666, { cdHash }, () => ({
    status: 1, stdout: '', stderr: 'code failed to satisfy specified code requirement',
  })), /running code identity/i);
});
