import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

import { readStudySessionLaunchBinding } from './native-qa-study-launch.mjs';
import { verifyAndConsumeStudySessionBoot } from './native-qa-session.mjs';
import { createMemoryStudySessionConsumptionAnchor } from './native-qa-session-anchor.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const defaultStatePath = join(root, 'src-tauri', '.provider-free-study-session.json');

export function consumeQaOnlyStudySession({
  appBundle,
  statePath = defaultStatePath,
  readBundleIdentifier,
  readStaticCodeIdentity,
  consumptionAnchor = createMemoryStudySessionConsumptionAnchor(),
}) {
  const binding = readStudySessionLaunchBinding({
    statePath, readBundleIdentifier, readStaticCodeIdentity,
  });
  if (binding.app.appBundle !== realpathSync(appBundle)) {
    throw new Error('QA-only consumption must use the exact preserved bundle from launch evidence.');
  }
  const consumed = verifyAndConsumeStudySessionBoot({
    statePath,
    profileSha256: binding.session.profileSha256,
    buildIdentitySha256: binding.app.buildIdentitySha256,
    provenanceSha256: binding.app.provenanceSha256,
    executableSha256: binding.app.executableSha256,
    consumptionAnchor,
  });
  return Object.freeze({
    qaOnly: true,
    technicalSetupReady: true,
    studyAuthorizationEvaluated: false,
    profileSha256: binding.session.profileSha256,
    buildIdentitySha256: binding.app.buildIdentitySha256,
    ...consumed,
    warning: 'QA-only receipt: never use as participant setup, recruitment authorization, consent, or study evidence.',
  });
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = consumeQaOnlyStudySession({
      appBundle: valueAfter(process.argv.slice(2), '--app-bundle'),
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } catch (error) {
    console.error(`[creator-study-qa-consume] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
