import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  listVirtualCreatorProfiles,
  prepareVirtualCreatorSession,
  validateVirtualCreatorObservation,
  validateVirtualCreatorObservationSet,
} from './virtual-creator-session.mjs';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const taskDeckPath = join(root, 'docs', 'testing', 'creator-study', 'virtual-creators', 'task-deck.json');

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), 'paintnode-normal-creators-'));
  const controlRoot = join(temp, 'control');
  const projectRoot = join(temp, 'projects');
  const appCheckout = join(temp, 'app');
  mkdirSync(controlRoot);
  mkdirSync(projectRoot);
  mkdirSync(appCheckout);
  chmodSync(controlRoot, 0o700);
  chmodSync(projectRoot, 0o700);
  execFileSync('git', ['init', '-q'], { cwd: appCheckout });
  execFileSync('git', ['config', 'user.email', 'test@paintnode.invalid'], { cwd: appCheckout });
  execFileSync('git', ['config', 'user.name', 'PaintNode Test'], { cwd: appCheckout });
  writeFileSync(join(appCheckout, 'README.md'), 'test checkout\n');
  execFileSync('git', ['add', 'README.md'], { cwd: appCheckout });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: appCheckout });
  return { temp, controlRoot, projectRoot, appCheckout };
}

function prepare(profileId = 'V01', suffix = '11111111-1111-4111-8111-111111111111', shared = fixture()) {
  return {
    shared,
    packet: prepareVirtualCreatorSession({
      profileId,
      controlRoot: shared.controlRoot,
      projectRoot: shared.projectRoot,
      appCheckout: shared.appCheckout,
      randomUUID: () => suffix,
      now: () => new Date('2026-07-12T01:02:03.000Z'),
    }),
  };
}

function acceptObservation(packet, externalTaskId) {
  const path = join(packet.controlDir, 'observation.blank.json');
  const observation = JSON.parse(readFileSync(path, 'utf8'));
  observation.isolation.externalTaskId = externalTaskId;
  observation.isolation.newTaskConfirmed = true;
  observation.isolation.noForkConfirmed = true;
  observation.lifecycle.attemptStage = 'finalized';
  observation.lifecycle.appClosedAfterSession = true;
  observation.lifecycle.launchEvents = [
    { phase: 'fresh', gitSha: observation.runtime.gitSha, windowTitle: 'PaintNode Repo QA — repo-dev', operatorVerifiedRunning: true, recordedAt: '2026-07-12T01:03:00.000Z' },
    { phase: 'resume', gitSha: observation.runtime.gitSha, windowTitle: 'PaintNode Repo QA — repo-dev', operatorVerifiedRunning: true, recordedAt: '2026-07-12T02:03:00.000Z' },
  ];
  for (const task of observation.tasks) {
    task.outcome = 'completed-unaided';
    task.elapsedWallMs = 1000 * task.task;
    task.uiEvidence = [`screenshot-task-${task.task}.png`];
    if ([2, 5, 6, 7].includes(task.task)) task.providerEvidence = [`real provider result visible for Task ${task.task}`];
  }
  observation.ownerReview = {
    observedLive: true,
    evidenceReviewed: true,
    decision: 'accepted',
    selectedForAggregate: true,
    standard: observation.ownerReview.standard,
    notes: 'Complete normal-app run observed and accepted.',
    reviewedAt: '2026-07-12T02:10:00.000Z',
  };
  writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`);
  return { path, observation };
}

test('defines eight distinct synthetic behavioral lenses', () => {
  const profiles = listVirtualCreatorProfiles();
  assert.equal(profiles.length, 8);
  assert.equal(new Set(profiles.map(({ id }) => id)).size, 8);
  assert.ok(profiles.some(({ interactionConstraint }) => interactionConstraint === 'keyboard-only'));
});

test('task deck uses normal real-provider behavior without deterministic failure controls', () => {
  const deck = JSON.parse(readFileSync(taskDeckPath, 'utf8'));
  assert.equal(deck.schemaVersion, 2);
  assert.equal(deck.runtimeMode, 'repo-dev-real-providers');
  assert.equal(deck.tasks.length, 8);
  const text = JSON.stringify(deck).toLowerCase();
  assert.equal(text.includes('planned failure'), false);
  assert.equal(text.includes('checkpoint reset'), false);
  assert.equal(text.includes('fake output'), false);
  assert.match(deck.tasks[1].prompt, /normal generation flow/i);
  assert.match(deck.tasks[6].prompt, /revise or regenerate only the Landscape/i);
});

test('prepares isolated normal-app materials pinned to a clean checkout', () => {
  const { packet } = prepare();
  assert.equal(packet.sessionId, 'VC-V01-11111111-1111-4111-8111-111111111111');
  assert.equal(statSync(packet.controlDir).mode & 0o777, 0o700);
  assert.equal(statSync(packet.projectDir).mode & 0o777, 0o700);
  const participant = readFileSync(join(packet.controlDir, 'participant-start.md'), 'utf8');
  const operator = readFileSync(join(packet.controlDir, 'operator-deck.md'), 'utf8');
  const plan = JSON.parse(readFileSync(join(packet.controlDir, 'session-plan.json'), 'utf8'));
  assert.match(participant, /PaintNode Repo QA — repo-dev/);
  assert.match(participant, /real provider behavior/i);
  assert.doesNotMatch(participant, /Provider Free/);
  assert.match(operator, /npm run qa:native:normal/);
  assert.doesNotMatch(operator, /npm run tauri:dev/);
  assert.match(operator, /Never change hidden QA scenarios, inject failures, substitute fake outputs/i);
  assert.equal(plan.runtimeMode, 'repo-dev-real-providers');
  assert.equal(plan.bundleId, 'com.paintnode.editor.qa.repo.dev');
});

test('validates a complete owner-accepted normal-app observation', () => {
  const { packet } = prepare();
  const { path } = acceptObservation(packet, 'codex-task-v01');
  const observation = validateVirtualCreatorObservation({ observationPath: path });
  assert.equal(observation.ownerReview.decision, 'accepted');
  assert.equal(observation.runtime.providerBehavior, 'real-subscription-backed');
});

test('rejects accepted observations without real provider evidence or resume proof', () => {
  const { packet } = prepare();
  const { path, observation } = acceptObservation(packet, 'codex-task-v01');
  observation.tasks[1].providerEvidence = [];
  writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`);
  assert.throws(() => validateVirtualCreatorObservation({ observationPath: path }), /Task 2 real-provider evidence/);
  observation.tasks[1].providerEvidence = ['visible real direction'];
  observation.lifecycle.launchEvents.pop();
  writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`);
  assert.throws(() => validateVirtualCreatorObservation({ observationPath: path }), /launchEvents|fresh and resume/);
});

test('rejects Provider Free or synthetic fixture observations under the v2 contract', () => {
  const { packet } = prepare();
  const path = join(packet.controlDir, 'observation.blank.json');
  const observation = JSON.parse(readFileSync(path, 'utf8'));
  observation.runtime.mode = 'provider-free';
  observation.runtime.bundleId = 'com.paintnode.editor.blueprintqa.provider.free';
  writeFileSync(path, `${JSON.stringify(observation, null, 2)}\n`);
  assert.throws(() => validateVirtualCreatorObservation({ observationPath: path, requireDecision: false }), /invalid/);
});

test('requires clean external roots and a clean pinned app checkout', () => {
  const shared = fixture();
  writeFileSync(join(shared.appCheckout, 'dirty.txt'), 'dirty');
  assert.throws(() => prepare('V01', '11111111-1111-4111-8111-111111111111', shared), /must be clean/);
  assert.throws(() => prepareVirtualCreatorSession({
    profileId: 'V01',
    controlRoot: root,
    projectRoot: shared.projectRoot,
    appCheckout: shared.appCheckout,
  }), /outside the Git repository|must be clean/);
});

test('validates exactly one selected attempt per profile with unique task and project IDs', () => {
  const shared = fixture();
  for (let index = 1; index <= 8; index += 1) {
    const id = `V0${index}`;
    const uuid = `0000000${index}-0000-4000-8000-00000000000${index}`;
    const { packet } = prepare(id, uuid, shared);
    acceptObservation(packet, `external-task-${id}`);
  }
  const observations = validateVirtualCreatorObservationSet({ controlRoot: shared.controlRoot });
  assert.equal(observations.length, 8);
  const v08 = observations.find(({ profileId }) => profileId === 'V08');
  const v08Path = join(dirname(join(shared.controlRoot, v08.sessionId, 'observation.blank.json')), 'observation.blank.json');
  const duplicate = JSON.parse(readFileSync(v08Path, 'utf8'));
  duplicate.isolation.externalTaskId = 'external-task-V01';
  writeFileSync(v08Path, `${JSON.stringify(duplicate, null, 2)}\n`);
  assert.throws(() => validateVirtualCreatorObservationSet({ controlRoot: shared.controlRoot }), /distinct external AI task IDs/);
});
