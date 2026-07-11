import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';

const CDHASH_PATTERN = /^[a-f0-9]{40,64}$/;

function validCodeIdentity(value) {
  if (!value || !CDHASH_PATTERN.test(value.cdHash ?? '')) {
    throw new Error('Approved macOS code identity must contain a CDHash.');
  }
  return Object.freeze({ cdHash: value.cdHash });
}

function codeIdentityFromDisplay(result, label) {
  if (result.status !== 0) {
    throw new Error(`Could not read ${label} code identity: ${result.stderr || result.error}`);
  }
  const match = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.match(/(?:^|\n)CDHash=([a-f0-9]{40,64})(?:\n|$)/i);
  return validCodeIdentity({ cdHash: match?.[1]?.toLowerCase() });
}

export function signMacosQaAppBundle(appBundle, run = spawnSync) {
  const result = run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appBundle], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`Could not apply the complete local QA app signature: ${result.stderr || result.error}`);
  }
  return Object.freeze({ appBundle });
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
  return codeIdentityFromDisplay(display, 'approved Provider Free');
}

export function verifyMacosRunningCodeIdentity(pid, expected, run = spawnSync) {
  const identity = validCodeIdentity(expected);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Running Provider Free process ID is invalid.');
  const dynamic = run('codesign', ['--verify', `+${pid}`], { encoding: 'utf8' });
  if (dynamic.status !== 0) {
    throw new Error(`Provider Free running code identity is invalid: ${dynamic.stderr || dynamic.error}`);
  }
  const running = codeIdentityFromDisplay(
    run('codesign', ['--display', '--verbose=4', `+${pid}`], { encoding: 'utf8' }),
    'running Provider Free',
  );
  if (running.cdHash !== identity.cdHash) {
    throw new Error('Provider Free running code identity does not match the approved CDHash.');
  }
  return Object.freeze({ ...identity, pid });
}
