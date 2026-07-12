import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const virtualRoot = join(root, 'docs', 'testing', 'creator-study', 'virtual-creators');
const profilesPath = join(virtualRoot, 'profiles.json');
const taskDeckPath = join(virtualRoot, 'task-deck.json');
const observationSchemaPath = join(virtualRoot, 'observation.schema.json');
const materialRoot = join(root, 'docs', 'testing', 'creator-study', 'materials');
const appTitle = 'PaintNode Repo QA — repo-dev';
const appBundleId = 'com.paintnode.editor.qa.repo.dev';
const cleanStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
}

function isInside(parent, child) {
  const value = relative(parent, child);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function existingDirectory(path, label) {
  if (!isAbsolute(path ?? '')) throw new Error(`${label} must be an absolute path.`);
  if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} cannot be a symlink.`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory.`);
  return canonical;
}

function privateDirectory(path) {
  mkdirSync(path, { mode: 0o700 });
  return realpathSync(path);
}

function privateFile(path, value) {
  writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function strictUtcTimestamp(value, label) {
  const milliseconds = Date.parse(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value ?? '')
    || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a real UTC timestamp with millisecond precision.`);
  }
  return milliseconds;
}

function loadProfiles() {
  const document = readJson(profilesPath, 'Virtual creator profiles');
  if (document.schemaVersion !== 1 || document.recordType !== 'paintnode-virtual-creator-profiles'
    || document.syntheticOnly !== true || document.profiles?.length !== 8) {
    throw new Error('Virtual creator profile contract is unsupported.');
  }
  return document.profiles;
}

function loadTaskDeck() {
  const document = readJson(taskDeckPath, 'Virtual creator task deck');
  if (document.schemaVersion !== 2 || document.recordType !== 'paintnode-normal-app-virtual-creator-task-deck'
    || document.syntheticOnly !== true || document.runtimeMode !== 'repo-dev-real-providers'
    || document.tasks?.length !== 8) {
    throw new Error('Normal-app virtual creator task deck contract is unsupported.');
  }
  return document.tasks;
}

function captureCheckout(appCheckout) {
  const canonical = existingDirectory(appCheckout, 'App checkout');
  const gitSha = spawnSync('git', ['-C', canonical, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['-C', canonical, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  if (gitSha.status !== 0 || status.status !== 0) throw new Error('App checkout must be a readable Git worktree.');
  if (status.stdout !== '') throw new Error('App checkout must be clean, including untracked files.');
  return Object.freeze({
    path: canonical,
    gitSha: gitSha.stdout.trim(),
    sourceStatusSha256: sha256(status.stdout),
  });
}

function participantPrompt({ profile, projectDir, sessionId }) {
  return `# PaintNode virtual creator ${profile.id}\n\n`
    + `You are running an explicitly synthetic product-use session, \`${sessionId}\`. Act through the visible PaintNode UI using the assigned creative-working style. Do not claim to be a real person or generalize your experience to human creators.\n\n`
    + '## App handoff\n\n'
    + 'The operator will start the normal repository-built PaintNode app. Do not open an installed PaintNode, use Terminal, or launch the app yourself. Reply now without inspecting the desktop and wait for exactly `APP READY`. After that signal, use non-launching running-app discovery and attach only to **PaintNode Repo QA — repo-dev**. If it is not running, report exactly `BLOCKED — APP NOT RUNNING` and wait.\n\n'
    + 'This is the normal app path with real provider behavior. Use generation, editing, retry, save, and reopen features as a public user would. Do not inspect source code, tests, Git history, logs, operator files, or another creator session. Do not change provider settings unless a task explicitly asks you to. A provider or app error is real evidence: report it and use only recovery actions visible to a public user.\n\n'
    + `## Working style\n\n- Label: ${profile.label}\n- Creative-tool familiarity: ${profile.creativeToolFamiliarity}\n`
    + `- AI-workflow familiarity: ${profile.aiWorkflowFamiliarity}\n- Multi-format habit: ${profile.multiFormatHabit}\n`
    + `- Interaction constraint: ${profile.interactionConstraint}\n- Mental model: ${profile.mentalModel}\n`
    + `- Constraint: ${profile.behavioralConstraint}\n\n`
    + `## Supplied material\n\n- Your unique empty project folder: \`${projectDir}\`\n- Product A: \`${join(materialRoot, 'product-a.png')}\`\n\n`
    + 'The operator will send one task at a time. Do not read ahead. When finished, report only the completion or blocked state, visible evidence, actions taken, provider/app errors encountered, and confusing labels or state. Do not grade severity or make a milestone decision. Reply only `READY — WAITING FOR APP READY` now.\n';
}

function taskMessage(task) {
  const addendum = task.creatorFacingAddendum === 'UPDATED_PRODUCT_PATH'
    ? `Updated Product image: ${join(materialRoot, 'product-b.png')}`
    : task.creatorFacingAddendum;
  return addendum ? `${task.prompt}\n\n${addendum}` : task.prompt;
}

function operatorDeck({ profile, sessionId, controlDir, projectDir, checkout, tasks }) {
  const observation = join(controlDir, 'observation.blank.json');
  return `# Operator deck — ${sessionId}\n\n`
    + '> OPERATOR ONLY. Give the AI task only participant-start.md, APP READY / APP RESUMED, the current task prompt, and an intervention you actually record.\n\n'
    + '## Boundary\n\nThis is an owner-observed synthetic evaluation of the normal public-user workflow. It uses real subscription-backed provider calls. It is not a Provider Free QA run, a deterministic failure scenario, recruitment, or a qualifying human session for #85.\n\n'
    + `- Profile: ${profile.id} — ${profile.label}\n- Session: ${sessionId}\n- Unique project: ${projectDir}\n`
    + `- Pinned app checkout: ${checkout.path}\n- Pinned Git SHA: ${checkout.gitSha}\n- Expected window: ${appTitle}\n\n`
    + '## Before creating the AI task\n\n1. Confirm the unique project directory is empty.\n2. Confirm no other virtual creator task is active.\n3. From a terminal, pin and launch the normal repo app:\n\n'
    + '```sh\nset -euo pipefail\n'
    + `APP_CHECKOUT=${shellQuote(checkout.path)}\nEXPECTED_GIT_SHA=${shellQuote(checkout.gitSha)}\nPROJECT=${shellQuote(projectDir)}\nOBSERVATION=${shellQuote(observation)}\n`
    + 'cd "$APP_CHECKOUT"\ntest "$(git rev-parse HEAD)" = "$EXPECTED_GIT_SHA"\ntest -z "$(git status --porcelain --untracked-files=all)"\ntest -z "$(find "$PROJECT" -mindepth 1 -maxdepth 1 -print -quit)"\nnpm run qa:native:normal\n```\n'
    + '\n4. Use Computer Use to verify **PaintNode Repo QA — repo-dev** is running and no project/document is open. Do not target an installed production app.\n5. Create a brand-new, non-forked AI task. Paste participant-start.md. After its exact waiting reply, send `APP READY`.\n\n'
    + '## Moderation\n\nAllow the creator to act naturally. If it is stuck, first ask `What are you looking for?`; then give the smallest visible-UI hint needed and record the exact text. Never change hidden QA scenarios, inject failures, substitute fake outputs, use source knowledge to take over silently, or change provider settings for the creator. Natural provider/app failures remain part of the observation.\n\n'
    + tasks.map((task) => `## Task ${task.task} — ${task.title}\n\nPaste exactly:\n\n> ${taskMessage(task).replaceAll('\n', '\n> ')}\n\nStop condition: ${task.stopCondition}\n\nRecord: visible UI evidence, provider shown/used when visible, real errors/retries, elapsed time, and every intervention.\n`).join('\n')
    + '\n## Task 8 relaunch\n\nWhen the creator quits PaintNode, the `npm run qa:native:normal` command returns. Re-run the same pinned-checkout launch block, verify the same repo-dev window is running, then send `APP RESUMED` followed by `PaintNode has reopened. Continue the same task using your saved project.` Do not open the project for the creator.\n\n'
    + '## Finish\n\n1. Close the repo-dev app after Task 8 and verify it is no longer running. Preserve the unique project for evidence review.\n2. Fill observation.blank.json. Record the external AI task ID, new-task/no-fork confirmation, fresh/resume launch evidence, per-task UI/provider evidence, natural failures, interventions, and owner decision.\n3. An accepted run requires all eight tasks completed, visible UI evidence for every task, real-provider evidence for generation tasks 2, 5, 6, and 7, successful save/reopen, and live owner review. Reject incomplete or contaminated runs.\n4. Validate:\n\n'
    + '```sh\ncd "$APP_CHECKOUT"\ntest "$(git rev-parse HEAD)" = "$EXPECTED_GIT_SHA"\ntest -z "$(git status --porcelain --untracked-files=all)"\nnpm run qa:virtual-creators:validate -- --validate-observation "$OBSERVATION"\n```\n';
}

function blankObservation({ profile, sessionId, projectDir, checkout, tasks, planSha256 }) {
  return {
    schemaVersion: 2,
    recordType: 'paintnode-normal-app-virtual-creator-observation',
    syntheticOnly: true,
    runtime: {
      mode: 'repo-dev-real-providers',
      gitSha: checkout.gitSha,
      checkoutPath: checkout.path,
      sourceStatusSha256: checkout.sourceStatusSha256,
      bundleId: appBundleId,
      windowTitle: appTitle,
      providerBehavior: 'real-subscription-backed',
    },
    sessionId,
    profileId: profile.id,
    planSha256,
    isolation: {
      projectDir,
      projectWasEmptyAtStart: true,
      externalTaskId: null,
      newTaskConfirmed: false,
      noForkConfirmed: false,
      priorSessionContextShared: false,
    },
    lifecycle: {
      attemptStage: 'pending',
      launchEvents: [],
      appClosedAfterSession: false,
      projectPreservedForReview: true,
    },
    tasks: tasks.map((task) => ({
      task: task.task,
      outcome: 'not-run',
      elapsedWallMs: null,
      interventions: [],
      providerEvidence: [],
      uiEvidence: [],
      errors: [],
      notes: '',
    })),
    findings: [],
    ownerReview: {
      observedLive: false,
      evidenceReviewed: false,
      decision: 'pending',
      selectedForAggregate: false,
      standard: 'Accept only a complete, uncontaminated normal-app run with traceable visible evidence.',
      notes: '',
      reviewedAt: null,
    },
    limitations: [
      'This is an AI-operated synthetic evaluation, not evidence from a human creator.',
      'Real provider results are variable and cannot be compared as deterministic fixtures.',
      'Owner observation validates the record but does not make the AI task a qualifying creator for #85.',
    ],
  };
}

export function listVirtualCreatorProfiles() {
  return loadProfiles().map(({ id, label, interactionConstraint }) => ({ id, label, interactionConstraint }));
}

function compileValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, formats: {
    'date-time': (value) => {
      try { strictUtcTimestamp(value, 'date-time'); return true; } catch { return false; }
    },
  } });
  return ajv.compile(readJson(observationSchemaPath, 'Virtual creator observation schema'));
}

function assertObservationSemantics(observation, { observationPath, requireDecision = true } = {}) {
  const validate = compileValidator();
  if (!validate(observation)) {
    throw new Error(`Virtual creator observation is invalid: ${ajvErrors(validate.errors)}`);
  }
  const profiles = loadProfiles();
  if (!profiles.some(({ id }) => id === observation.profileId)) throw new Error('Observation profile is unknown.');
  const planPath = join(dirname(observationPath), 'session-plan.json');
  const planRaw = readFileSync(planPath);
  if (sha256(planRaw) !== observation.planSha256) throw new Error('Observation does not match its immutable session plan.');
  const plan = JSON.parse(planRaw);
  for (const [key, expected] of Object.entries({
    sessionId: observation.sessionId,
    profileId: observation.profileId,
    projectDir: observation.isolation.projectDir,
    gitSha: observation.runtime.gitSha,
  })) {
    if (plan[key] !== expected) throw new Error(`Observation ${key} does not match its session plan.`);
  }
  if (observation.runtime.checkoutPath !== plan.checkoutPath) throw new Error('Observation checkout path does not match its session plan.');
  if (requireDecision && observation.ownerReview.decision === 'pending') throw new Error('Owner review decision is required.');
  if (observation.ownerReview.decision === 'accepted') {
    const requiredProviderTasks = new Set([2, 5, 6, 7]);
    for (const task of observation.tasks) {
      if (!['completed-unaided', 'completed-assisted'].includes(task.outcome)) {
        throw new Error(`Accepted observation requires Task ${task.task} to be completed.`);
      }
      if (task.uiEvidence.length === 0) throw new Error(`Accepted observation requires Task ${task.task} UI evidence.`);
      if (requiredProviderTasks.has(task.task) && task.providerEvidence.length === 0) {
        throw new Error(`Accepted observation requires Task ${task.task} real-provider evidence.`);
      }
    }
    const phases = observation.lifecycle.launchEvents.map(({ phase }) => phase);
    if (phases.join(',') !== 'fresh,resume') throw new Error('Accepted observation requires ordered fresh and resume launch evidence.');
    for (const event of observation.lifecycle.launchEvents) {
      if (event.gitSha !== observation.runtime.gitSha || event.windowTitle !== appTitle || !event.operatorVerifiedRunning) {
        throw new Error('Launch evidence does not match the pinned normal repo app.');
      }
    }
  }
  return observation;
}

function ajvErrors(errors) {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
}

export function validateVirtualCreatorObservation({ observationPath, requireDecision = true }) {
  const canonical = realpathSync(observationPath);
  return assertObservationSemantics(readJson(canonical, 'Virtual creator observation'), {
    observationPath: canonical,
    requireDecision,
  });
}

export function validateVirtualCreatorObservationSet({ controlRoot }) {
  const canonicalRoot = existingDirectory(controlRoot, 'Control root');
  const observations = readdirSync(canonicalRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(canonicalRoot, entry.name, 'observation.blank.json'))
    .filter((path) => { try { return statSync(path).isFile(); } catch { return false; } })
    .map((path) => validateVirtualCreatorObservation({ observationPath: path }));
  const selected = observations.filter(({ ownerReview }) => ownerReview.selectedForAggregate);
  if (selected.some(({ ownerReview }) => ownerReview.decision !== 'accepted')) {
    throw new Error('Only owner-accepted sessions can be selected for the aggregate.');
  }
  const profileIds = selected.map(({ profileId }) => profileId);
  const externalTaskIds = selected.map(({ isolation }) => isolation.externalTaskId);
  const projectDirs = selected.map(({ isolation }) => isolation.projectDir);
  const expected = loadProfiles().map(({ id }) => id).sort();
  if (profileIds.slice().sort().join(',') !== expected.join(',')) throw new Error('Selected set must contain exactly one terminal attempt for every profile.');
  if (new Set(externalTaskIds).size !== externalTaskIds.length) throw new Error('Selected sessions must use distinct external AI task IDs.');
  if (new Set(projectDirs).size !== projectDirs.length) throw new Error('Selected sessions must use distinct project directories.');
  return observations;
}

export function prepareVirtualCreatorSession({
  profileId,
  controlRoot,
  projectRoot,
  appCheckout = root,
  randomUUID = nodeRandomUUID,
  now = () => new Date(),
}) {
  const profile = loadProfiles().find(({ id }) => id === profileId);
  if (!profile) throw new Error(`Unknown virtual creator profile: ${profileId}`);
  const tasks = loadTaskDeck();
  const canonicalControlRoot = existingDirectory(controlRoot, 'Control root');
  const canonicalProjectRoot = existingDirectory(projectRoot, 'Project root');
  if (isInside(root, canonicalControlRoot) || isInside(root, canonicalProjectRoot)) throw new Error('Control and project roots must be outside the Git repository.');
  if (isInside(canonicalControlRoot, canonicalProjectRoot) || isInside(canonicalProjectRoot, canonicalControlRoot)) throw new Error('Control and project roots cannot contain each other.');
  const checkout = captureCheckout(appCheckout);
  const sessionId = `VC-${profile.id}-${randomUUID()}`;
  const controlDir = privateDirectory(join(canonicalControlRoot, sessionId));
  const projectDir = privateDirectory(join(canonicalProjectRoot, sessionId));
  if (readdirSync(projectDir).length !== 0) throw new Error('Allocated project must be empty.');
  const plan = {
    schemaVersion: 2,
    recordType: 'paintnode-normal-app-virtual-creator-session-plan',
    syntheticOnly: true,
    runtimeMode: 'repo-dev-real-providers',
    sessionId,
    profileId: profile.id,
    projectDir,
    checkoutPath: checkout.path,
    gitSha: checkout.gitSha,
    sourceStatusSha256: checkout.sourceStatusSha256,
    appTitle,
    bundleId: appBundleId,
    createdAt: now().toISOString(),
  };
  const planRaw = `${JSON.stringify(plan, null, 2)}\n`;
  const planSha256 = sha256(planRaw);
  privateFile(join(controlDir, 'session-plan.json'), planRaw);
  privateFile(join(controlDir, 'participant-start.md'), participantPrompt({ profile, projectDir, sessionId }));
  privateFile(join(controlDir, 'operator-deck.md'), operatorDeck({ profile, sessionId, controlDir, projectDir, checkout, tasks }));
  privateFile(join(controlDir, 'observation.blank.json'), `${JSON.stringify(blankObservation({ profile, sessionId, projectDir, checkout, tasks, planSha256 }), null, 2)}\n`);
  return { sessionId, controlDir, projectDir, gitSha: checkout.gitSha, planSha256 };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`${flag} requires a value.`);
  return args[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--list-profiles')) {
      console.log(JSON.stringify(listVirtualCreatorProfiles(), null, 2));
    } else if (args.includes('--validate-observation')) {
      console.log(JSON.stringify(validateVirtualCreatorObservation({ observationPath: valueAfter(args, '--validate-observation') }), null, 2));
    } else if (args.includes('--validate-control-root')) {
      const observations = validateVirtualCreatorObservationSet({ controlRoot: valueAfter(args, '--validate-control-root') });
      console.log(JSON.stringify({ valid: true, observations: observations.length }, null, 2));
    } else {
      const result = prepareVirtualCreatorSession({
        profileId: valueAfter(args, '--profile'),
        controlRoot: valueAfter(args, '--control-root'),
        projectRoot: valueAfter(args, '--project-root'),
        appCheckout: args.includes('--app-checkout') ? valueAfter(args, '--app-checkout') : root,
      });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
