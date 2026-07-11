import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

const CDHASH_PATTERN = /^[a-f0-9]{40,64}$/;

function validCodeIdentity(value) {
  if (!value || !CDHASH_PATTERN.test(value.cdHash ?? '')) {
    throw new Error('Approved macOS code identity must contain a CDHash.');
  }
  return Object.freeze({ cdHash: value.cdHash });
}

export function readMacosStaticCodeIdentity(executable, run = spawnSync) {
  const appBundle = dirname(dirname(dirname(executable)));
  const verify = run('codesign', ['--verify', '--strict', '--verbose=2', appBundle], {
    encoding: 'utf8',
  });
  if (verify.status !== 0) {
    throw new Error(`Approved Provider Free executable has invalid static code identity: ${verify.stderr || verify.error}`);
  }
  const display = run('codesign', ['--display', '--verbose=4', executable], { encoding: 'utf8' });
  if (display.status !== 0) {
    throw new Error(`Could not read approved Provider Free code identity: ${display.stderr || display.error}`);
  }
  const match = `${display.stdout ?? ''}\n${display.stderr ?? ''}`.match(/(?:^|\n)CDHash=([a-f0-9]{40,64})(?:\n|$)/i);
  return validCodeIdentity({ cdHash: match?.[1]?.toLowerCase() });
}

export function verifyMacosRunningCodeIdentity(pid, expected, run = spawnSync) {
  const identity = validCodeIdentity(expected);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Running Provider Free process ID is invalid.');
  const result = run('codesign', [
    '--verify', '--strict', '--verbose=2', `-R=cdhash H"${identity.cdHash}"`, `+${pid}`,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`Provider Free running code identity does not match the approved CDHash: ${result.stderr || result.error}`);
  }
  return Object.freeze({ ...identity, pid });
}
