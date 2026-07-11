import { spawnSync } from 'node:child_process';
import { accessSync, constants, realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

import { captureSourceState, writeQaBuildProvenance } from './native-qa-build-provenance.mjs';
import {
  applyStudySessionWindowIsolation,
  assertProviderFreeStudyPlatform,
  providerFreeStudyBootEnvironment,
  providerFreeStudyProfileEnvironment,
  resolveProviderFreeStudySession,
  studySessionBuildEvidence,
} from './native-qa-session.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const buildSourceState = captureSourceState(root);

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

function executablePath(flag) {
  const value = valueAfter(flag);
  if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
  const resolved = realpathSync(value);
  accessSync(resolved, constants.X_OK);
  return resolved;
}

const mode = valueAfter('--mode');
if (!['provider-free', 'provider-e2e'].includes(mode)) {
  throw new Error('--mode must be provider-free or provider-e2e');
}

const freshStudySession = args.includes('--fresh-study-session');
const resumeStudySession = args.includes('--resume-study-session');
const buildOnly = args.includes('--build-only');
const studySessionPath = join(root, 'src-tauri', '.provider-free-study-session.json');
const studySessionLaunch = resolveProviderFreeStudySession({
  mode,
  fresh: freshStudySession,
  resume: resumeStudySession,
  statePath: studySessionPath,
});
const studySession = studySessionLaunch?.session ?? null;
const studySessionEvidence = studySessionLaunch
  ? studySessionBuildEvidence(
    studySessionLaunch.session,
    buildOnly ? 'build-only' : studySessionLaunch.launchIntent,
  )
  : null;
if (studySession) {
  const version = spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error(`Could not read macOS version: ${version.stderr || version.error}`);
  assertProviderFreeStudyPlatform(process.platform, version.stdout.trim());
}

const suffix = mode === 'provider-free' ? 'Provider Free' : 'Provider E2E';
const slug = mode.replaceAll('-', '.');
const productName = `PaintNode Blueprint QA — ${suffix}`;
const env = {
  ...process.env,
  PAINTNODE_PROVIDER_QA_MODE: mode,
  PAINTNODE_QUICKLOOK_ARCHS: process.arch === 'arm64' ? 'arm64' : 'x86_64',
};
if (mode === 'provider-e2e') {
  env.PAINTNODE_QA_CODEX_BIN = executablePath('--codex-path');
  env.PAINTNODE_QA_ANTIGRAVITY_BIN = executablePath('--antigravity-path');
}
if (studySession) {
  env.PAINTNODE_PROVIDER_FREE_STUDY_PROFILE = providerFreeStudyProfileEnvironment(studySession);
  if (studySessionLaunch?.launchIntent === 'fresh' && !buildOnly) {
    Object.assign(env, providerFreeStudyBootEnvironment(studySession, studySessionPath));
  }
}

const configPath = join(root, 'src-tauri', '.tauri.qa.json');
const windowConfig = {
  title: productName,
  width: 1440,
  height: 960,
  minWidth: 800,
  minHeight: 560,
  resizable: true,
  fullscreen: false,
  devtools: false,
  titleBarStyle: 'Overlay',
  hiddenTitle: true,
};
writeFileSync(
  configPath,
  JSON.stringify(
    {
      productName,
      identifier: `com.paintnode.editor.blueprintqa.${slug}`,
      app: {
        windows: [
          studySession ? applyStudySessionWindowIsolation(windowConfig, studySession) : windowConfig,
        ],
      },
      bundle: { createUpdaterArtifacts: false },
    },
    null,
    2,
  ),
);

console.log(`[native-qa] building ${productName}`);
const build = spawnSync(
  join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri'),
  ['build', '--debug', '--bundles', 'app', '--config', configPath],
  { cwd: root, env, stdio: 'inherit', shell: process.platform === 'win32' },
);
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

if (process.platform !== 'darwin') {
  throw new Error('Computer Use native QA currently requires the macOS app bundle');
}
const appBundle = join(
  root,
  'src-tauri',
  'target',
  'debug',
  'bundle',
  'macos',
  `${productName}.app`,
);
const executable = join(appBundle, 'Contents', 'MacOS', 'PaintNode');
accessSync(executable, constants.X_OK);

const finalSourceState = captureSourceState(root);
if (JSON.stringify(finalSourceState) !== JSON.stringify(buildSourceState)) {
  throw new Error('QA build source changed while the app was building; discard this bundle and build again.');
}
writeQaBuildProvenance({
  appBundle,
  mode,
  bundleId: `com.paintnode.editor.blueprintqa.${slug}`,
  sourceState: finalSourceState,
  studySession: studySessionEvidence,
});

if (buildOnly) {
  console.log(`[native-qa] built ${appBundle} without launching it`);
  process.exit(0);
}

console.log(`[native-qa] launching ${executable}`);
const app = spawnSync(executable, ['-ApplePersistenceIgnoreState', 'YES'], {
  cwd: root,
  env,
  stdio: 'inherit',
});
if (app.error) throw app.error;
process.exit(app.status ?? 0);
