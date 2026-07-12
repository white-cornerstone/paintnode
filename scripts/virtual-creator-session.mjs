import { createHash, randomUUID as nodeRandomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const virtualRoot = join(root, 'docs', 'testing', 'creator-study', 'virtual-creators');
const profilesPath = join(virtualRoot, 'profiles.json');
const taskDeckPath = join(virtualRoot, 'task-deck.json');
const hintsPath = join(root, 'docs', 'testing', 'creator-study', 'facilitator-hints.json');
const materialRoot = join(root, 'docs', 'testing', 'creator-study', 'materials');
const appName = 'PaintNode Blueprint QA — Provider Free.app';
const sidecarName = `${appName}.paintnode-qa-build.json`;
const cleanStatusSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const observationSchemaPath = join(virtualRoot, 'observation.schema.json');

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

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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

function captureKitCheckout(repoRoot) {
  const canonical = existingDirectory(repoRoot, 'Virtual creator kit checkout');
  const gitSha = spawnSync('git', ['-C', canonical, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const status = spawnSync('git', ['-C', canonical, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  if (gitSha.status !== 0 || status.status !== 0 || status.stdout !== '') {
    throw new Error('Virtual creator kit checkout must be a clean Git worktree.');
  }
  return Object.freeze({ path: canonical, gitSha: gitSha.stdout.trim() });
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

function operatorDeck({ profile, sessionId, controlDir, projectDir, build, approvedCheckout, kitCheckout, tasks, instrument }) {
  const record = join(build.canonicalRoot, 'private-approved-build-record.json');
  const ledger = join(build.canonicalRoot, 'private-active-build-decisions.json');
  const deletedRehearsal = join(controlDir, 'deleted-rehearsal');
  const attestations = join(controlDir, 'checkout-attestations.jsonl');
  const setupReceipt = join(controlDir, 'setup-receipt.json');
  const cleanupReceipt = join(controlDir, 'cleanup-receipt.json');
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
    + 'set -euo pipefail\n'
    + `APPROVED_CHECKOUT=${shellQuote(approvedCheckout)}\nKIT_CHECKOUT=${shellQuote(kitCheckout.path)}\nKIT_GIT_SHA=${shellQuote(kitCheckout.gitSha)}\nCONTROL=${shellQuote(controlDir)}\nOBSERVATION=${shellQuote(join(controlDir, 'observation.blank.json'))}\nATTESTATIONS=${shellQuote(attestations)}\nSETUP_RECEIPT=${shellQuote(setupReceipt)}\nCLEANUP_RECEIPT=${shellQuote(cleanupReceipt)}\nEXPECTED_GIT_SHA=${shellQuote(build.provenance.gitSha)}\nAPP=${shellQuote(build.appBundle)}\nRECORD=${shellQuote(record)}\nLEDGER=${shellQuote(ledger)}\nPROJECT=${shellQuote(projectDir)}\nREHEARSAL=${shellQuote(deletedRehearsal)}\n`
    + 'test ! -e "$ATTESTATIONS"\n(umask 077; : > "$ATTESTATIONS")\n'
    + 'attest_checkout() {\n'
    + 'PHASE=$1\ncase "$PHASE" in fresh|resume|finalize) ;; *) return 64 ;; esac\n'
    + 'cd "$APPROVED_CHECKOUT"\n'
    + 'ACTUAL_GIT_SHA=$(git rev-parse HEAD)\n'
    + 'SOURCE_STATUS=$(git status --porcelain --untracked-files=all)\n'
    + 'SOURCE_STATUS_SHA256=$(printf %s "$SOURCE_STATUS" | shasum -a 256 | awk \'{print $1}\')\n'
    + 'test "$ACTUAL_GIT_SHA" = "$EXPECTED_GIT_SHA"\n'
    + 'test -z "$SOURCE_STATUS"\n'
    + `test "$SOURCE_STATUS_SHA256" = ${shellQuote(cleanStatusSha256)}\n`
    + 'ATTESTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\n'
    + 'printf \'{"phase":"%s","expectedGitSha":"%s","actualGitSha":"%s","sourceStatusSha256":"%s","attestedAt":"%s"}\\n\' "$PHASE" "$EXPECTED_GIT_SHA" "$ACTUAL_GIT_SHA" "$SOURCE_STATUS_SHA256" "$ATTESTED_AT" >> "$ATTESTATIONS"\n'
    + '}\n'
    + 'attest_checkout fresh\n'
    + 'npm run qa:creator-study:launch -- --app-bundle "$APP" --fresh-study-session\n'
    + '# Use Computer Use to verify: no document, no project, no workflow, no imported asset.\n'
    + 'SETUP_TMP="$SETUP_RECEIPT.tmp"\ntest ! -e "$SETUP_RECEIPT" && test ! -e "$SETUP_TMP"\n'
    + 'if (umask 077; npm run --silent qa:creator-study:setup -- --approved-build-record "$RECORD" --active-build-decisions "$LEDGER" --app-bundle "$APP" --project-dir "$PROJECT" --rehearsal-dir "$REHEARSAL" --visible-empty-state-attested > "$SETUP_TMP"); then mv "$SETUP_TMP" "$SETUP_RECEIPT"; else rm -f "$SETUP_TMP"; exit 1; fi\n'
    + 'chmod 600 "$SETUP_RECEIPT"\ncat "$SETUP_RECEIPT"\n'
    + '```\n\nKeep this terminal open because `attest_checkout` is reused before resume and finalization. Do not open the empty project before setup verification. Task 1 opens it.\n\n'
    + '## Moderator timing\n\nFollow the committed instrument algorithm, not a flat ladder:\n\n'
    + '1. On the initial checkpoint, after 90 seconds without progress ask exactly “What are you looking for?” Record a `neutral-probe` ID from the current task and checkpoint (for example `T1-C2-NP1`) with zero assist.\n'
    + '2. At 180 total seconds on that initial checkpoint, recompute the earliest incomplete checkpoint and deliver only its H1 verbatim.\n'
    + '3. Whenever a checkpoint completes, restart a 90-second interval from observed completion and recompute the earliest incomplete checkpoint before the next intervention. If the checkpoint changed, deliver its H1 after that restarted interval without another neutral probe; never deliver a stale H2.\n'
    + '4. Only when the same checkpoint remains incomplete for another 90 seconds may H2 be delivered. Only after a further 90 seconds on that same checkpoint may its exact takeover occur. A takeover forces task failure.\n'
    + '5. Record every checkpoint completion in `checkpointEvents` at the observed elapsed time. Record every intervention object with checkpoint, event type, exact delivered text, elapsed time, and assist increment. The validator replays the merged timeline and rejects stale-checkpoint interventions. Record every deviation from the closed instrument.\n\n'
    + tasks.map((task) => {
      const setup = task.task === 2
        ? '\nBefore selection, send exactly: “I am setting the test checkpoint for this task”. Then visibly select Branch recovery checkpoint and record a setup scenario event. When the planned branch failure appears, stop the creator task, send exactly “I am resetting the test checkpoint”, visibly reset to Standard checkpoint, record the reset event, then send: “Continue the same task.”\n'
        : task.task === 7
          ? '\nConfirm Square and Portrait are complete. Before selection, send exactly: “I am setting the test checkpoint for this task”. Then visibly select Format recovery checkpoint and record a setup scenario event. When Landscape fails, stop the creator task, send exactly “I am resetting the test checkpoint”, visibly reset to Standard checkpoint, record the reset event, then send: “Continue the same task.”\n'
          : task.task === 8
            ? '\nWhen PaintNode quits, run `attest_checkout resume` immediately before `npm run qa:creator-study:launch -- --app-bundle "$APP" --resume-study-session`, verify the same profile resumes, then send: “PaintNode has reopened in the same session. Continue the same task.”\n'
            : '';
      const addendum = task.creatorFacingAddendum === 'UPDATED_PRODUCT_PATH'
        ? `The updated Product image for this task is: ${join(materialRoot, 'product-b.png')}`
        : task.creatorFacingAddendum;
      const creatorMessage = addendum ? `${task.prompt}\n\n${addendum}` : task.prompt;
      return `## Task ${task.task} — ${task.title}\n${setup}\nPaste exactly:\n\n> ${creatorMessage.replaceAll('\n', '\n> ')}\n\nOperator stop condition: ${task.stopCondition}\n`;
    }).join('\n')
    + '\n## End and owner decision\n\n1. Save a nonempty native UI evidence reference for every task and fill the distinct external AI task ID/new-task/no-fork confirmations.\n2. Close PaintNode.\n3. Capture final attestation and cleanup without retaining a partial receipt:\n\n```sh\nattest_checkout finalize\nCLEANUP_TMP="$CLEANUP_RECEIPT.tmp"\ntest ! -e "$CLEANUP_RECEIPT" && test ! -e "$CLEANUP_TMP"\nif (umask 077; npm run --silent qa:creator-study:finalize-session > "$CLEANUP_TMP"); then mv "$CLEANUP_TMP" "$CLEANUP_RECEIPT"; else rm -f "$CLEANUP_TMP"; exit 1; fi\nchmod 600 "$CLEANUP_RECEIPT"\ncat "$CLEANUP_RECEIPT"\nshasum -a 256 "$ATTESTATIONS" "$SETUP_RECEIPT" "$CLEANUP_RECEIPT"\n```\n\nIf fresh launch or setup failed, close PaintNode, run `attest_checkout finalize`, capture `npm run --silent qa:creator-study:abort-session` through the same temporary-file/rename pattern, and reject the finalized attempt. Never start the next profile while native cleanup is unresolved.\n\n4. Copy the attestation rows plus receipt hashes/fields into lifecycle; require matching setup/cleanup profile hashes and verified finalization. Complete ownerReview only after live observation and evidence review. Accepted and rejected decisions both require a written rationale; accepted requires all eight tasks completed with traceable evidence. Mark exactly one terminal attempt per profile `selectedForAggregate: true`; superseded rejected attempts stay false.\n5. Validate from the exact clean kit checkout captured during packet preparation:\n\n```sh\ncd "$KIT_CHECKOUT"\ntest "$(git rev-parse HEAD)" = "$KIT_GIT_SHA"\ntest -z "$(git status --porcelain --untracked-files=all)"\nnpm run qa:virtual-creators:validate -- --validate-observation "$OBSERVATION"\n```\n\n6. Keep accepted and rejected virtual sessions in the synthetic aggregate; never copy them into real participant rows.\n\n'
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
    agentTask: {
      externalTaskId: null,
      newTaskConfirmed: false,
      noForkConfirmed: false,
    },
    lifecycle: {
      attemptStage: 'pending',
      checkoutAttestations: [],
      checkoutAttestationReceiptSha256: null,
      setupReceiptSha256: null,
      cleanupReceiptSha256: null,
      setupProfileSha256: null,
      cleanupProfileSha256: null,
      dataStoreRemoved: false,
      dataStoreRemovalVerified: false,
      finalized: false,
      cleanupReceiptRecordedAt: null,
    },
    tasks: Array.from({ length: 8 }, (_, index) => ({
      task: index + 1,
      outcome: 'not-run',
      elapsedWallMs: null,
      checkpointEvents: [],
      interventions: [],
      scenarioEvents: [],
      deviationIds: [],
      frictionFlags: [],
      uiEvidence: [],
      notes: '',
    })),
    findings: [],
    ownerReview: {
      observedLive: false,
      evidenceReviewed: false,
      decision: 'pending',
      selectedForAggregate: false,
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

function readSessionReceipt(path, label) {
  const metadata = statSync(path);
  if (lstatSync(path).isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must be a regular non-symlink file.`);
  }
  return readJson(path, label);
}

function verifyLifecycleEvidence(observation, observationPath) {
  const lifecycle = observation.lifecycle;
  if (lifecycle.attemptStage === 'prelaunch') {
    if (observation.ownerReview.decision !== 'rejected'
      || observation.ownerReview.selectedForAggregate
      || lifecycle.checkoutAttestations.length !== 0
      || lifecycle.checkoutAttestationReceiptSha256 !== null
      || lifecycle.setupReceiptSha256 !== null || lifecycle.cleanupReceiptSha256 !== null
      || lifecycle.setupProfileSha256 !== null || lifecycle.cleanupProfileSha256 !== null
      || lifecycle.dataStoreRemoved || lifecycle.dataStoreRemovalVerified || lifecycle.finalized
      || lifecycle.cleanupReceiptRecordedAt !== null) {
      throw new Error('Prelaunch rejection must not claim runtime or cleanup evidence.');
    }
    return;
  }
  if (lifecycle.attemptStage !== 'finalized') {
    throw new Error('A decided launched attempt must be finalized.');
  }

  const controlDir = dirname(observationPath);
  const attestationPath = join(controlDir, 'checkout-attestations.jsonl');
  const attestationMetadata = statSync(attestationPath);
  if (lstatSync(attestationPath).isSymbolicLink() || !attestationMetadata.isFile()
    || (attestationMetadata.mode & 0o077) !== 0) {
    throw new Error('Checkout attestation receipt must be a regular non-symlink file.');
  }
  const attestationBytes = readFileSync(attestationPath, 'utf8');
  const attestations = attestationBytes.trim().split('\n').map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Checkout attestation row ${index + 1} is invalid JSON.`); }
  });
  const phases = attestations.map(({ phase }) => phase);
  const expectedPhases = observation.ownerReview.decision === 'accepted'
    ? ['fresh', 'resume', 'finalize']
    : phases.includes('resume') ? ['fresh', 'resume', 'finalize'] : ['fresh', 'finalize'];
  if (JSON.stringify(phases) !== JSON.stringify(expectedPhases)
    || JSON.stringify(attestations) !== JSON.stringify(lifecycle.checkoutAttestations)
    || sha256File(attestationPath) !== lifecycle.checkoutAttestationReceiptSha256) {
    throw new Error('Checkout attestation phases, content, or receipt hash do not match.');
  }
  let priorAttestationTime = -1;
  for (const attestation of attestations) {
    const keys = Object.keys(attestation).sort();
    if (JSON.stringify(keys) !== JSON.stringify(['actualGitSha', 'attestedAt', 'expectedGitSha', 'phase', 'sourceStatusSha256'])
      || attestation.expectedGitSha !== observation.build.gitSha
      || attestation.actualGitSha !== observation.build.gitSha
      || attestation.sourceStatusSha256 !== cleanStatusSha256) {
      throw new Error('Runtime checkout attestation does not match the frozen clean build.');
    }
    const time = strictUtcTimestamp(attestation.attestedAt, 'Checkout attestation time');
    if (time <= priorAttestationTime) throw new Error('Checkout attestations must be in strict phase/time order.');
    priorAttestationTime = time;
  }

  let setupReceipt = null;
  if (lifecycle.setupReceiptSha256 !== null) {
    const setupPath = join(controlDir, 'setup-receipt.json');
    setupReceipt = readSessionReceipt(setupPath, 'Technical setup receipt');
    if (sha256File(setupPath) !== lifecycle.setupReceiptSha256
      || setupReceipt.schemaVersion !== 2
      || setupReceipt.receiptType !== 'paintnode-creator-study-technical-setup'
      || setupReceipt.scope !== 'technical-setup-only'
      || setupReceipt.technicalSetupReady !== true
      || setupReceipt.studyAuthorizationEvaluated !== false
      || setupReceipt.gitSha !== observation.build.gitSha
      || setupReceipt.bundleId !== observation.build.bundleId
      || setupReceipt.approvedBuildIdentity?.matched !== true
      || setupReceipt.approvalRecord?.validated !== true
      || setupReceipt.projectState !== 'empty' || setupReceipt.rehearsalState !== 'deleted'
      || setupReceipt.sessionReset?.isolatedProfile !== true
      || setupReceipt.sessionReset?.appBootObserved !== true
      || setupReceipt.sessionReset?.setupEvidenceConsumed !== true
      || setupReceipt.sessionReset?.profileSha256 !== lifecycle.setupProfileSha256) {
      throw new Error('Technical setup receipt is missing, mismatched, or not consumed evidence.');
    }
  } else if (observation.ownerReview.decision === 'accepted') {
    throw new Error('Accepted session requires a captured technical setup receipt.');
  }

  const cleanupPath = join(controlDir, 'cleanup-receipt.json');
  const cleanupReceipt = readSessionReceipt(cleanupPath, 'Native cleanup receipt');
  if (sha256File(cleanupPath) !== lifecycle.cleanupReceiptSha256
    || cleanupReceipt.profileSha256 !== lifecycle.cleanupProfileSha256
    || cleanupReceipt.finalized !== true
    || cleanupReceipt.dataStoreRemoved !== lifecycle.dataStoreRemoved
    || cleanupReceipt.dataStoreRemovalVerified !== lifecycle.dataStoreRemovalVerified
    || (setupReceipt && setupReceipt.sessionReset.profileSha256 !== cleanupReceipt.profileSha256)) {
    throw new Error('Native cleanup receipt does not match the recorded lifecycle.');
  }
  if (observation.ownerReview.decision === 'accepted'
    && (cleanupReceipt.aborted !== false || cleanupReceipt.dataStoreRemoved !== true
      || cleanupReceipt.dataStoreRemovalVerified !== true)) {
    throw new Error('Accepted session requires verified non-abort native data-store cleanup.');
  }
  const cleanupRecordedAt = strictUtcTimestamp(lifecycle.cleanupReceiptRecordedAt, 'Cleanup receipt record time');
  const reviewedAt = strictUtcTimestamp(observation.ownerReview.reviewedAt, 'Owner review time');
  if (cleanupRecordedAt < priorAttestationTime || reviewedAt < cleanupRecordedAt) {
    throw new Error('Cleanup receipt and owner review must follow final checkout attestation in time order.');
  }
}

function assertObservationSemantics(observation, { requireDecision = true, observationPath } = {}) {
  const decision = observation.ownerReview.decision;
  if (requireDecision && decision === 'pending') {
    throw new Error('Owner decision is still pending.');
  }
  if (decision === 'pending') return;

  if (observation.sessionId.slice(3, 6) !== observation.profileId) {
    throw new Error('Session ID and profile ID do not match.');
  }
  if (!observation.ownerReview.notes.trim()) {
    throw new Error('Owner rationale must contain non-whitespace text.');
  }
  if (observation.lifecycle.attemptStage === 'finalized'
    && observation.ownerReview.selectedForAggregate
    && (!observation.agentTask.externalTaskId?.trim()
      || observation.agentTask.externalTaskId !== observation.agentTask.externalTaskId.trim()
      || !observation.agentTask.newTaskConfirmed || !observation.agentTask.noForkConfirmed)) {
    throw new Error('Selected finalized attempt requires a distinct, confirmed external AI task ID.');
  }
  if (observation.lifecycle.attemptStage === 'finalized'
    && (!observation.ownerReview.observedLive || !observation.ownerReview.evidenceReviewed)) {
    throw new Error('Finalized attempt requires live owner observation and evidence review.');
  }
  verifyLifecycleEvidence(observation, observationPath);

  const invalidatingDeviations = new Set([
    'early-hint', 'out-of-order-hint', 'wording-changed', 'unlogged-assist',
    'silent-app-state-change', 'unauthorized-takeover', 'calibration-missing',
    'instrument-version-mismatch', 'instrument-hash-mismatch', 'instrument-change-unapproved',
  ]);
  const instrument = readJson(hintsPath, 'Facilitator instrument');
  const taskDeck = loadTaskDeck();
  const creatorMessages = new Map(taskDeck.map((task) => {
    const addendum = task.creatorFacingAddendum === 'UPDATED_PRODUCT_PATH'
      ? `The updated Product image for this task is: ${join(materialRoot, 'product-b.png')}`
      : task.creatorFacingAddendum;
    return [task.task, addendum ? `${task.prompt}\n\n${addendum}` : task.prompt];
  }));
  const hints = new Map(instrument.tasks.flatMap(({ checkpoints }) => checkpoints.flatMap((checkpoint) => [
    [`${checkpoint.id}-H1`, checkpoint.firstHint],
    [`${checkpoint.id}-H2`, checkpoint.secondHint],
  ])));
  const takeovers = new Map(instrument.takeoverActions.map(({ id, exactAction }) => [id, exactAction]));
  for (const task of observation.tasks) {
    if (task.deviationIds.includes('none') && task.deviationIds.length > 1) {
      throw new Error(`Task ${task.task} cannot combine the none deviation with another deviation.`);
    }
    const seenInterventionIds = new Set();
    let priorInterventionTime = -1;
    for (const intervention of task.interventions) {
      if (seenInterventionIds.has(intervention.id) || intervention.elapsedWallMs <= priorInterventionTime) {
        throw new Error(`Task ${task.task} interventions must have unique IDs in strictly increasing time order.`);
      }
      seenInterventionIds.add(intervention.id);
      priorInterventionTime = intervention.elapsedWallMs;
      if (!intervention.checkpointId.startsWith(`T${task.task}-`)
        || !intervention.id.startsWith(`${intervention.checkpointId}-`)) {
        throw new Error(`Task ${task.task} intervention identity does not match its checkpoint.`);
      }
      if (intervention.eventType === 'neutral-probe'
        && (intervention.exactText !== 'What are you looking for?'
          || intervention.assistIncrement !== 0 || intervention.elapsedWallMs < 90_000)) {
        throw new Error(`Task ${task.task} has an invalid neutral probe.`);
      }
      if (intervention.eventType === 'standard-hint' && intervention.assistIncrement !== 1) {
        throw new Error(`Task ${task.task} has a hint with an invalid assist increment.`);
      }
      if (intervention.eventType === 'standard-hint'
        && hints.get(intervention.id) !== intervention.exactText) {
        throw new Error(`Task ${task.task} has a hint that drifted from the closed instrument.`);
      }
      if (intervention.eventType === 'takeover'
        && (intervention.assistIncrement !== 1 || task.outcome !== 'failed')) {
        throw new Error(`Task ${task.task} takeover must increment assist and force failure.`);
      }
      if (intervention.eventType === 'takeover'
        && takeovers.get(intervention.id) !== intervention.exactText) {
        throw new Error(`Task ${task.task} has a takeover that drifted from the closed instrument.`);
      }
      if (intervention.eventType === 'takeover') {
        const prior = task.interventions.find(({ id }) => id === `${intervention.checkpointId}-H2`);
        if (!prior || intervention.elapsedWallMs < prior.elapsedWallMs + 90_000) {
          throw new Error(`Task ${task.task} takeover order or timing drifted from the closed instrument.`);
        }
      }
      if (intervention.eventType === 'verbatim-repeat') {
        const earlierText = task.interventions.some((candidate) => candidate.elapsedWallMs < intervention.elapsedWallMs
          && candidate.exactText === intervention.exactText);
        if (intervention.assistIncrement !== 0
          || (intervention.exactText !== creatorMessages.get(task.task) && !earlierText)) {
          throw new Error(`Task ${task.task} verbatim repeat added new or assisted information.`);
        }
      }
    }
    const checkpointIds = instrument.tasks.find(({ task: number }) => number === task.task)
      .checkpoints.map(({ id }) => id);
    let checkpointIndex = 0;
    let intervalStartedAt = 0;
    let moderatorStage = 'initial';
    let stageStartedAt = 0;
    let priorTimelineTime = -1;
    const timeline = [
      ...task.checkpointEvents.map((event) => ({ ...event, kind: 'checkpoint' })),
      ...task.interventions.map((event) => ({ ...event, kind: 'intervention' })),
    ].sort((left, right) => left.elapsedWallMs - right.elapsedWallMs);
    for (const event of timeline) {
      if (event.elapsedWallMs <= priorTimelineTime) {
        throw new Error(`Task ${task.task} moderator timeline must be strictly ordered.`);
      }
      priorTimelineTime = event.elapsedWallMs;
      const currentCheckpoint = checkpointIds[checkpointIndex];
      if (event.checkpointId !== currentCheckpoint) {
        throw new Error(`Task ${task.task} moderator event targeted a stale or out-of-order checkpoint.`);
      }
      if (event.kind === 'checkpoint') {
        checkpointIndex += 1;
        intervalStartedAt = event.elapsedWallMs;
        moderatorStage = 'after-progress';
        stageStartedAt = event.elapsedWallMs;
      } else if (event.eventType === 'neutral-probe') {
        if (moderatorStage !== 'initial' || event.elapsedWallMs < intervalStartedAt + 90_000) {
          throw new Error(`Task ${task.task} neutral probe order or timing drifted from the facilitator algorithm.`);
        }
        moderatorStage = 'probe';
        stageStartedAt = event.elapsedWallMs;
      } else if (event.eventType === 'standard-hint' && event.id.endsWith('-H1')) {
        const validInitial = moderatorStage === 'probe' && event.elapsedWallMs >= intervalStartedAt + 180_000;
        const validAfterProgress = moderatorStage === 'after-progress'
          && event.elapsedWallMs >= intervalStartedAt + 90_000;
        if (!validInitial && !validAfterProgress) {
          throw new Error(`Task ${task.task} H1 order or timing drifted from the facilitator algorithm.`);
        }
        moderatorStage = 'h1';
        stageStartedAt = event.elapsedWallMs;
      } else if (event.eventType === 'standard-hint' && event.id.endsWith('-H2')) {
        if (moderatorStage !== 'h1' || event.elapsedWallMs < stageStartedAt + 90_000) {
          throw new Error(`Task ${task.task} H2 order or timing drifted from the facilitator algorithm.`);
        }
        moderatorStage = 'h2';
        stageStartedAt = event.elapsedWallMs;
      } else if (event.eventType === 'takeover') {
        if (moderatorStage !== 'h2' || event.elapsedWallMs < stageStartedAt + 90_000) {
          throw new Error(`Task ${task.task} takeover order or timing drifted from the facilitator algorithm.`);
        }
        moderatorStage = 'takeover';
        stageStartedAt = event.elapsedWallMs;
      }
    }
    if (task.elapsedWallMs !== null && task.elapsedWallMs < priorTimelineTime) {
      throw new Error(`Task ${task.task} elapsed time ends before its moderator timeline.`);
    }
    const assist = task.interventions.reduce((sum, intervention) => sum + intervention.assistIncrement, 0);
    if ((task.outcome === 'completed-unaided' && assist !== 0)
      || (task.outcome === 'completed-assisted' && assist === 0)) {
      throw new Error(`Task ${task.task} outcome does not match its recorded assistance.`);
    }
    let priorScenarioTime = -1;
    if (![2, 7].includes(task.task) && task.scenarioEvents.length > 0) {
      throw new Error(`Task ${task.task} cannot contain operator scenario changes.`);
    }
    for (const event of task.scenarioEvents) {
      const expectedSpokenText = event.action === 'setup'
        ? 'I am setting the test checkpoint for this task'
        : 'I am resetting the test checkpoint';
      if (event.spokenText !== expectedSpokenText || event.elapsedWallMs <= priorScenarioTime
        || !event.expectedTrigger.trim() || !event.observedTrigger?.trim()) {
        throw new Error(`Task ${task.task} scenario events are incomplete or out of order.`);
      }
      priorScenarioTime = event.elapsedWallMs;
    }
  }

  if (decision === 'accepted') {
    for (const task of observation.tasks) {
      if (!['completed-unaided', 'completed-assisted'].includes(task.outcome)
        || task.elapsedWallMs === null || task.uiEvidence.length === 0
        || task.uiEvidence.some((entry) => !entry.trim()) || task.deviationIds.length === 0) {
        throw new Error(`Accepted session requires completed, timed, evidenced Task ${task.task}.`);
      }
      const invalid = task.deviationIds.find((id) => invalidatingDeviations.has(id));
      if (invalid) throw new Error(`Accepted session has invalidating deviation ${invalid} on Task ${task.task}.`);
      const requiredCheckpointCount = instrument.tasks.find(({ task: number }) => number === task.task).checkpoints.length;
      if (task.checkpointEvents.length !== requiredCheckpointCount) {
        throw new Error(`Accepted session requires every checkpoint completion for Task ${task.task}.`);
      }
    }
    for (const taskNumber of [2, 7]) {
      const scenarioEvents = observation.tasks[taskNumber - 1].scenarioEvents;
      const expectedScenario = taskNumber === 2 ? 'Branch recovery checkpoint' : 'Format recovery checkpoint';
      if (scenarioEvents.length !== 2
        || scenarioEvents[0].action !== 'setup'
        || scenarioEvents[0].scenario !== expectedScenario
        || scenarioEvents[0].spokenText !== 'I am setting the test checkpoint for this task'
        || scenarioEvents[1].action !== 'reset'
        || scenarioEvents[1].scenario !== 'Standard checkpoint'
        || scenarioEvents[1].spokenText !== 'I am resetting the test checkpoint'
        || scenarioEvents[1].elapsedWallMs <= scenarioEvents[0].elapsedWallMs
        || scenarioEvents.some(({ observedTrigger }) => !observedTrigger?.trim())) {
        throw new Error(`Accepted session requires recorded setup and reset scenario events for Task ${taskNumber}.`);
      }
    }
  }
}

export function validateVirtualCreatorObservation({ observationPath, requireDecision = true }) {
  const observationMetadata = statSync(observationPath);
  if (lstatSync(observationPath).isSymbolicLink() || !observationMetadata.isFile()
    || (observationMetadata.mode & 0o077) !== 0) {
    throw new Error('Virtual creator observation must be an owner-only regular non-symlink file.');
  }
  const observation = readJson(observationPath, 'Virtual creator observation');
  const schema = readJson(observationSchemaPath, 'Virtual creator observation schema');
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validate = ajv.compile(schema);
  if (!validate(observation)) {
    throw new Error(`Observation schema validation failed: ${ajv.errorsText(validate.errors)}`);
  }
  assertObservationSemantics(observation, { requireDecision, observationPath });
  return Object.freeze({
    valid: true,
    sessionId: observation.sessionId,
    profileId: observation.profileId,
    externalTaskId: observation.agentTask.externalTaskId,
    ownerDecision: observation.ownerReview.decision,
    selectedForAggregate: observation.ownerReview.selectedForAggregate,
  });
}

export function validateVirtualCreatorObservationSet({ controlRoot }) {
  const canonicalRoot = existingDirectory(controlRoot, 'Control root');
  const sessionDirs = readdirSync(canonicalRoot)
    .filter((name) => /^VC-V0[1-8]-/.test(name) && statSync(join(canonicalRoot, name)).isDirectory())
    .sort();
  if (sessionDirs.length < 8) throw new Error('Control root must contain at least eight virtual creator attempts.');
  const results = sessionDirs.map((name) => validateVirtualCreatorObservation({
    observationPath: join(canonicalRoot, name, 'observation.blank.json'),
  }));
  for (let index = 0; index < results.length; index += 1) {
    if (basename(sessionDirs[index]) !== results[index].sessionId) {
      throw new Error('Observation session ID must match its control directory.');
    }
  }
  const expectedProfiles = loadProfiles().map(({ id }) => id).sort();
  const selected = results.filter(({ selectedForAggregate }) => selectedForAggregate);
  const actualProfiles = selected.map(({ profileId }) => profileId).sort();
  if (JSON.stringify(actualProfiles) !== JSON.stringify(expectedProfiles)) {
    throw new Error('Observation set must select exactly one terminal attempt for each V01-V08 profile.');
  }
  const externalTaskIds = results.map(({ externalTaskId }) => externalTaskId).filter(Boolean);
  if (new Set(externalTaskIds).size !== externalTaskIds.length) {
    throw new Error('Every virtual creator must use a distinct external AI task ID.');
  }
  return Object.freeze({ valid: true, attemptCount: results.length, sessionCount: selected.length, results });
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
  kitCheckoutCapture = captureKitCheckout,
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
  const kitCheckout = kitCheckoutCapture(canonicalRepo);
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
      approvedCheckout: canonicalApprovedCheckout, kitCheckout, tasks, instrument,
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
      kitCheckout,
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
      : args.includes('--validate-observation')
        ? validateVirtualCreatorObservation({ observationPath: valueAfter(args, '--validate-observation') })
        : args.includes('--validate-control-root')
          ? validateVirtualCreatorObservationSet({ controlRoot: valueAfter(args, '--validate-control-root') })
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
