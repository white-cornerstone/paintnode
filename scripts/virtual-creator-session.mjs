import { randomUUID as nodeRandomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const virtualRoot = join(root, 'docs', 'testing', 'creator-study', 'virtual-creators');
const profilesPath = join(virtualRoot, 'profiles.json');
const taskDeckPath = join(virtualRoot, 'task-deck.json');
const hintsPath = join(root, 'docs', 'testing', 'creator-study', 'facilitator-hints.json');
const materialRoot = join(root, 'docs', 'testing', 'creator-study', 'materials');
const appName = 'PaintNode Blueprint QA — Provider Free.app';
const sidecarName = `${appName}.paintnode-qa-build.json`;

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

function loadProfiles() {
  const document = readJson(profilesPath, 'Virtual creator profiles');
  if (document.schemaVersion !== 1 || document.recordType !== 'paintnode-virtual-creator-profiles'
    || document.syntheticOnly !== true || !Array.isArray(document.profiles)) {
    throw new Error('Virtual creator profile contract is unsupported.');
  }
  return document.profiles;
}

function loadTaskDeck() {
  const document = readJson(taskDeckPath, 'Virtual creator task deck');
  if (document.schemaVersion !== 1 || document.recordType !== 'paintnode-virtual-creator-task-deck'
    || document.syntheticOnly !== true || !Array.isArray(document.tasks) || document.tasks.length !== 8) {
    throw new Error('Virtual creator task deck contract is unsupported.');
  }
  return document.tasks;
}

function loadBuild(buildControlRoot) {
  const canonicalRoot = existingDirectory(buildControlRoot, 'Build-control root');
  if (isInside(root, canonicalRoot)) throw new Error('Build-control root must be outside the Git repository.');
  const appBundle = join(canonicalRoot, 'build', appName);
  const sidecarPath = join(canonicalRoot, 'build', sidecarName);
  if (!statSync(appBundle).isDirectory()) throw new Error('Preserved Provider Free app bundle is missing.');
  const provenance = readJson(sidecarPath, 'Preserved Provider Free provenance');
  if (provenance?.mode !== 'provider-free'
    || provenance?.bundleId !== 'com.paintnode.editor.blueprintqa.provider.free'
    || provenance?.studyCapable !== true
    || !/^[a-f0-9]{40}$/.test(provenance.gitSha ?? '')
    || !/^[a-f0-9]{64}$/.test(provenance.executableSha256 ?? '')) {
    throw new Error('Preserved Provider Free provenance is not a study-capable approved-build identity.');
  }
  for (const name of ['private-approved-build-record.json', 'private-active-build-decisions.json']) {
    if (!statSync(join(canonicalRoot, name)).isFile()) throw new Error(`Build-control record is missing: ${name}`);
  }
  return Object.freeze({ canonicalRoot, appBundle, provenance });
}

function captureApprovedCheckout(approvedCheckout, expectedGitSha) {
  const canonical = existingDirectory(approvedCheckout, 'Approved checkout');
  const gitSha = spawnSync('git', ['-C', canonical, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['-C', canonical, 'status', '--porcelain'], { encoding: 'utf8' });
  if (gitSha.status !== 0 || status.status !== 0) {
    throw new Error('Approved checkout must be a readable Git worktree.');
  }
  if (gitSha.stdout.trim() !== expectedGitSha) {
    throw new Error('Approved checkout HEAD does not match the frozen build Git SHA.');
  }
  if (status.stdout !== '') throw new Error('Approved checkout must be clean.');
  return canonical;
}

function participantPrompt({ profile, projectDir, sessionId }) {
  const productA = join(materialRoot, 'product-a.png');
  return `# Virtual creator session ${profile.id}\n\n`
    + `This is an explicitly synthetic PaintNode interaction probe, session \`${sessionId}\`. `
    + 'Do not claim to be a real creator or infer human-population results.\n\n'
    + 'Operate only the already-open native **PaintNode Blueprint QA — Provider Free** app through Computer Use. '
    + 'Do not use a browser version of PaintNode. Do not use Terminal, inspect the repository, source code, tests, Git history, issues, prior task transcripts, operator materials, logs, saved results, or any other virtual session. '
    + 'Infer behavior only from the visible app and the task prompt currently supplied by the operator.\n\n'
    + `## Behavioral lens\n\n- Label: ${profile.label}\n- Creative-tool familiarity: ${profile.creativeToolFamiliarity}\n`
    + `- AI-workflow familiarity: ${profile.aiWorkflowFamiliarity}\n- Multi-format habit: ${profile.multiFormatHabit}\n`
    + `- Interaction constraint: ${profile.interactionConstraint}\n- Mental model: ${profile.mentalModel}\n`
    + `- Constraint: ${profile.behavioralConstraint}\n\n`
    + `## Supplied material\n\n- Empty project folder: \`${projectDir}\`\n- Product A: \`${productA}\`\n\n`
    + 'The operator will send exactly one task prompt at a time. Do not read ahead or invent future tasks. '
    + 'Complete the visible task using your assigned interaction constraint. If blocked, state what is visibly blocking you and wait for a standardized operator message. '
    + 'When a task is complete, report only: completion or blocked state, visible evidence, actions taken, and any confusing label or state. '
    + 'Do not grade severity, use human-study metrics, or propose a milestone decision. Wait now for Task 1.\n';
}

function renderHintAppendix(instrument) {
  const lines = ['## Standardized intervention appendix', ''];
  for (const task of instrument.tasks) {
    lines.push(`### Task ${task.task}`, '');
    for (const checkpoint of task.checkpoints) {
      const takeover = instrument.takeoverActions.find((entry) => entry.checkpointId === checkpoint.id);
      lines.push(
        `- ${checkpoint.id} H1: ${checkpoint.firstHint}`,
        `- ${checkpoint.id} H2: ${checkpoint.secondHint}`,
        `- ${takeover.id}: ${takeover.exactAction}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

function operatorDeck({ profile, sessionId, controlDir, projectDir, build, approvedCheckout, tasks, instrument }) {
  const record = join(build.canonicalRoot, 'private-approved-build-record.json');
  const ledger = join(build.canonicalRoot, 'private-active-build-decisions.json');
  const deletedRehearsal = join(controlDir, 'deleted-rehearsal');
  return `# Operator deck — ${sessionId}\n\n`
    + '> OPERATOR ONLY. Never paste this whole file into the virtual creator task. Send only participant-start.md, then one task prompt or approved intervention at a time.\n\n'
    + '## Validity boundary\n\nThis is owner-observed synthetic evaluation. It is not recruitment, consented participant research, accessibility representation, or #85 exit evidence. '
    + 'The owner must observe the live run and explicitly accept or reject the final record.\n\n'
    + '## Isolation\n\n- Run one virtual session at a time; the native lifecycle state is intentionally single-session.\n'
    + '- Start a brand-new AI task with no forked conversation or prior session context.\n'
    + '- Give that task only participant-start.md and the current task/intervention message.\n'
    + '- Never provide this control directory, prior observations, profile matrix, source code, GitHub context, or hidden hint ladder.\n'
    + `- Profile: ${profile.id} — ${profile.label}\n- Session: ${sessionId}\n- Project: ${projectDir}\n\n`
    + '## Native setup\n\nRun from the exact feature checkout at the approved Git SHA. Do not rebuild the app.\n\n'
    + '```sh\n'
    + `APPROVED_CHECKOUT=${JSON.stringify(approvedCheckout)}\nAPP=${JSON.stringify(build.appBundle)}\nRECORD=${JSON.stringify(record)}\nLEDGER=${JSON.stringify(ledger)}\nPROJECT=${JSON.stringify(projectDir)}\nREHEARSAL=${JSON.stringify(deletedRehearsal)}\n`
    + 'cd "$APPROVED_CHECKOUT"\n'
    + 'npm run qa:creator-study:launch -- --app-bundle "$APP" --fresh-study-session\n'
    + '# Use Computer Use to verify: no document, no project, no workflow, no imported asset.\n'
    + 'npm run qa:creator-study:setup -- --approved-build-record "$RECORD" --active-build-decisions "$LEDGER" --app-bundle "$APP" --project-dir "$PROJECT" --rehearsal-dir "$REHEARSAL" --visible-empty-state-attested\n'
    + '```\n\nDo not open the empty project before setup verification. Task 1 opens it.\n\n'
    + '## Moderator timing\n\nUse the committed instrument timing: neutral probe after 90 seconds, H1 after 180 total seconds, H2 after another 90 seconds, and takeover after another 90 seconds. '
    + 'Send exact text only and record every intervention ID in observation.blank.json.\n\n'
    + tasks.map((task) => {
      const setup = task.task === 2
        ? '\nBefore sending: visibly select Branch recovery checkpoint. When the planned branch failure appears, stop the creator task, visibly reset to Standard checkpoint, then send: “The test checkpoint has been reset. Continue the same task.”\n'
        : task.task === 7
          ? '\nBefore sending: confirm Square and Portrait are complete, then visibly select Format recovery checkpoint. When Landscape fails, stop the creator task, visibly reset to Standard checkpoint, then send: “The test checkpoint has been reset. Continue the same task.”\n'
          : task.task === 8
            ? '\nWhen PaintNode quits, run the same preserved bundle with `--resume-study-session`, verify the same profile resumes, then send: “PaintNode has reopened in the same session. Continue the same task.”\n'
            : task.task === 6
              ? `\nReveal Product B only with this task: \`${join(materialRoot, 'product-b.png')}\`.\n`
              : '';
      return `## Task ${task.task} — ${task.title}\n${setup}\nPaste exactly:\n\n> ${task.prompt}\n\nOperator stop condition: ${task.stopCondition}\n`;
    }).join('\n')
    + '\n## End and owner decision\n\n1. Save visible evidence references in observation.blank.json.\n2. Close PaintNode.\n3. Run `npm run qa:creator-study:finalize-session`; require `dataStoreRemoved: true`.\n4. Complete ownerReview only after live observation and evidence review.\n5. Keep accepted and rejected virtual sessions in the synthetic aggregate; never copy them into real participant rows.\n\n'
    + renderHintAppendix(instrument) + '\n';
}

function blankObservation({ profile, sessionId, build }) {
  return {
    schemaVersion: 1,
    recordType: 'paintnode-virtual-creator-observation',
    syntheticOnly: true,
    sessionId,
    profileId: profile.id,
    build: {
      gitSha: build.provenance.gitSha,
      bundleId: build.provenance.bundleId,
      executableSha256: build.provenance.executableSha256,
    },
    tasks: Array.from({ length: 8 }, (_, index) => ({
      task: index + 1,
      outcome: 'not-run',
      elapsedWallMs: null,
      interventionIds: [],
      frictionFlags: [],
      uiEvidence: [],
      notes: '',
    })),
    findings: [],
    ownerReview: {
      observedLive: false,
      evidenceReviewed: false,
      decision: 'pending',
      standard: 'Accept only when the live native run is complete, evidence is traceable, cleanup is verified, and the result meets the owner-defined product standard.',
      notes: '',
      reviewedAt: null,
    },
    limitations: [
      'This record describes an AI-operated synthetic interaction probe, not a real creator session.',
      'Owner review validates the recorded run but does not create independent human-participant evidence.',
      'This record cannot satisfy recruitment, consent, accessibility representation, or the #85 participant count.',
    ],
  };
}

export function listVirtualCreatorProfiles() {
  return loadProfiles().map(({ id, label, interactionConstraint }) => ({ id, label, interactionConstraint }));
}

export function prepareVirtualCreatorSession({
  profileId,
  controlRoot,
  projectRoot,
  buildControlRoot,
  approvedCheckout,
  repoRoot = root,
  randomUUID = nodeRandomUUID,
  checkoutCapture = captureApprovedCheckout,
}) {
  const canonicalRepo = realpathSync(repoRoot);
  const canonicalControlRoot = existingDirectory(controlRoot, 'Control root');
  const canonicalProjectRoot = existingDirectory(projectRoot, 'Project root');
  for (const [label, value] of [['Control root', canonicalControlRoot], ['Project root', canonicalProjectRoot]]) {
    if (isInside(canonicalRepo, value)) throw new Error(`${label} must be outside the Git repository.`);
  }
  if (isInside(canonicalControlRoot, canonicalProjectRoot) || isInside(canonicalProjectRoot, canonicalControlRoot)) {
    throw new Error('Control and project roots must be separate and non-nested.');
  }
  const profiles = loadProfiles();
  const profile = profiles.find(({ id }) => id === profileId);
  if (!profile) throw new Error(`Unknown virtual creator profile: ${profileId}`);
  const build = loadBuild(buildControlRoot);
  const canonicalApprovedCheckout = checkoutCapture(approvedCheckout, build.provenance.gitSha);
  const uuid = randomUUID().toLowerCase();
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid)) {
    throw new Error('Session allocation requires a lowercase UUID.');
  }
  const sessionId = `VC-${profile.id}-${uuid}`;
  let controlDir;
  let projectDir;
  try {
    controlDir = privateDirectory(join(canonicalControlRoot, sessionId));
    projectDir = privateDirectory(join(canonicalProjectRoot, sessionId));
    const tasks = loadTaskDeck();
    const instrument = readJson(hintsPath, 'Facilitator instrument');
    const observation = blankObservation({ profile, sessionId, build });
    const participantStartPath = join(controlDir, 'participant-start.md');
    const operatorDeckPath = join(controlDir, 'operator-deck.md');
    const observationPath = join(controlDir, 'observation.blank.json');
    const planPath = join(controlDir, 'session-plan.json');
    privateFile(participantStartPath, participantPrompt({ profile, projectDir, sessionId }));
    privateFile(operatorDeckPath, operatorDeck({
      profile, sessionId, controlDir, projectDir, build,
      approvedCheckout: canonicalApprovedCheckout, tasks, instrument,
    }));
    privateFile(observationPath, `${JSON.stringify(observation, null, 2)}\n`);
    privateFile(planPath, `${JSON.stringify({
      schemaVersion: 1,
      recordType: 'paintnode-virtual-creator-session-plan',
      syntheticOnly: true,
      sessionId,
      profileId: profile.id,
      controlDir,
      projectDir,
      approvedCheckout: canonicalApprovedCheckout,
      buildControlRoot: build.canonicalRoot,
      appBundle: build.appBundle,
      deletedRehearsalDir: join(controlDir, 'deleted-rehearsal'),
    }, null, 2)}\n`);
    return Object.freeze({
      sessionId,
      profileId: profile.id,
      controlDir,
      projectDir,
      participantStartPath,
      operatorDeckPath,
      observationPath,
      planPath,
    });
  } catch (error) {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    if (controlDir) rmSync(controlDir, { recursive: true, force: true });
    throw error;
  }
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const output = args.includes('--list-profiles')
      ? listVirtualCreatorProfiles()
      : prepareVirtualCreatorSession({
        profileId: valueAfter(args, '--profile'),
        controlRoot: valueAfter(args, '--control-root'),
        projectRoot: valueAfter(args, '--project-root'),
        buildControlRoot: valueAfter(args, '--build-control-root'),
        approvedCheckout: valueAfter(args, '--approved-checkout'),
      });
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (error) {
    console.error(`[virtual-creator-session] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
