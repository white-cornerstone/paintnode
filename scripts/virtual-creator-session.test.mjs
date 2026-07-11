import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  listVirtualCreatorProfiles,
  prepareVirtualCreatorSession,
} from './virtual-creator-session.mjs';

const root = join(import.meta.dirname, '..');
const kit = join(root, 'docs/testing/creator-study/virtual-creators');

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'paintnode-virtual-creators-'));
  const controlRoot = join(base, 'control');
  const projectRoot = join(base, 'projects');
  const buildControlRoot = join(base, 'build-control');
  mkdirSync(controlRoot);
  mkdirSync(projectRoot);
  mkdirSync(join(buildControlRoot, 'build'), { recursive: true });
  mkdirSync(join(buildControlRoot, 'build', 'PaintNode Blueprint QA — Provider Free.app'));
  writeJson(join(buildControlRoot, 'build', 'PaintNode Blueprint QA — Provider Free.app.paintnode-qa-build.json'), {
    version: 1,
    mode: 'provider-free',
    bundleId: 'com.paintnode.editor.blueprintqa.provider.free',
    gitSha: '4f7b24fcb234eb7ec67ad62e8969bab2a1c05264',
    sourceTreeSha: 'b8581ca404a363ddb11c8258064e0e3a8d3284b3',
    sourceDirty: false,
    sourceStatusSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    executableSha256: '8e2ac9a38bdc8215ca56587f40169f45eac65b230af77db2b1ca2c4381c8d80d',
    studyCapable: true,
  });
  writeJson(join(buildControlRoot, 'private-approved-build-record.json'), {});
  writeJson(join(buildControlRoot, 'private-active-build-decisions.json'), {});
  return {
    base,
    controlRoot,
    projectRoot,
    buildControlRoot,
    approvedCheckout: root,
    checkoutCapture: () => root,
  };
}

test('defines eight distinct synthetic behavioral lenses without claiming human representation', () => {
  const profiles = listVirtualCreatorProfiles();
  assert.equal(profiles.length, 8);
  assert.deepEqual(profiles.map(({ id }) => id), ['V01', 'V02', 'V03', 'V04', 'V05', 'V06', 'V07', 'V08']);
  assert.equal(new Set(profiles.map(({ label }) => label)).size, 8);
  assert.equal(profiles.find(({ id }) => id === 'V02').interactionConstraint, 'keyboard-only');
  assert.equal(profiles.find(({ id }) => id === 'V03').interactionConstraint, 'accessibility-tree-and-keyboard');
});

test('virtual task deck pins all eight real creator-facing prompts without copying hidden setup into prompts', () => {
  const protocol = readFileSync(join(root, 'docs/testing/creative-blueprint-creator-study.md'), 'utf8')
    .replace(/(^|\n)>\s?/g, ' ')
    .replace(/\s+/g, ' ');
  const deck = JSON.parse(readFileSync(join(kit, 'task-deck.json'), 'utf8'));
  assert.equal(deck.syntheticOnly, true);
  assert.deepEqual(deck.tasks.map(({ task }) => task), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const task of deck.tasks) {
    assert.ok(protocol.includes(task.prompt), `Task ${task.task} prompt drifted from the real protocol`);
    assert.doesNotMatch(task.prompt, /Branch recovery checkpoint|Format recovery checkpoint|Promote this candidate|QA Fake/i);
  }
});

test('prepares owner-only, isolated session materials and an empty separate project', () => {
  const env = fixture();
  try {
    const result = prepareVirtualCreatorSession({
      profileId: 'V02',
      ...env,
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
    });
    assert.equal(result.sessionId, 'VC-V02-11111111-1111-4111-8111-111111111111');
    assert.equal(statSync(result.controlDir).mode & 0o777, 0o700);
    assert.equal(statSync(result.projectDir).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(result.projectDir), []);
    for (const path of [result.participantStartPath, result.operatorDeckPath, result.observationPath, result.planPath]) {
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }

    const participant = readFileSync(result.participantStartPath, 'utf8');
    assert.match(participant, /already-open native \*\*PaintNode Blueprint QA — Provider Free\*\*/);
    assert.match(participant, /Do not use Terminal/);
    assert.match(participant, /keyboard-only/);
    assert.match(participant, new RegExp(result.projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(participant, /Branch recovery checkpoint|Format recovery checkpoint|takeover|H1:|operator-deck|V01|V03/);
    assert.doesNotMatch(participant, /product-b\.png/i);
    assert.doesNotMatch(participant, new RegExp(result.controlDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const operator = readFileSync(result.operatorDeckPath, 'utf8');
    assert.match(operator, /OPERATOR ONLY/);
    assert.match(operator, /Branch recovery checkpoint/);
    assert.match(operator, /Format recovery checkpoint/);
    assert.match(operator, /--fresh-study-session/);
    assert.match(operator, /--resume-study-session/);
    assert.match(operator, /finalize-session/);
    assert.match(operator, /ownerReview/);
    assert.match(operator, /product-b\.png/i);
    assert.match(operator, /APPROVED_CHECKOUT=/);
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
});

test('virtual observation validates only as synthetic evidence and requires complete owner decisions', () => {
  const env = fixture();
  try {
    const result = prepareVirtualCreatorSession({
      profileId: 'V01',
      ...env,
      randomUUID: () => '22222222-2222-4222-8222-222222222222',
    });
    const observation = JSON.parse(readFileSync(result.observationPath, 'utf8'));
    const virtualSchema = JSON.parse(readFileSync(join(kit, 'observation.schema.json'), 'utf8'));
    const humanSchema = JSON.parse(readFileSync(join(root, 'docs/testing/creator-study/synthesis-input.schema.json'), 'utf8'));
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const validateVirtual = ajv.compile(virtualSchema);
    const validateHuman = ajv.compile(humanSchema);
    assert.equal(validateVirtual(observation), true, JSON.stringify(validateVirtual.errors));
    assert.equal(validateHuman(observation), false, 'Synthetic observation must not validate as human study input');
    assert.equal('participants' in observation, false);
    assert.equal(JSON.stringify(observation).includes('S0'), false);
    assert.equal(JSON.stringify(observation).includes('SEQ'), false);

    observation.tasks[1].task = 1;
    assert.equal(validateVirtual(observation), false, 'Task rows must remain in exact 1-8 order');
    observation.tasks[1].task = 2;

    observation.ownerReview.decision = 'accepted';
    assert.equal(validateVirtual(observation), false, 'Accepted owner decision requires live observation, evidence review, and timestamp');
    observation.ownerReview.observedLive = true;
    observation.ownerReview.evidenceReviewed = true;
    observation.ownerReview.reviewedAt = '2026-07-12T01:02:03.000Z';
    assert.equal(validateVirtual(observation), true, JSON.stringify(validateVirtual.errors));
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
});

test('allocates unique directories and rejects unknown, in-repo, or nested roots', () => {
  const env = fixture();
  try {
    const first = prepareVirtualCreatorSession({
      profileId: 'V04',
      ...env,
      randomUUID: () => '33333333-3333-4333-8333-333333333333',
    });
    const second = prepareVirtualCreatorSession({
      profileId: 'V04',
      ...env,
      randomUUID: () => '44444444-4444-4444-8444-444444444444',
    });
    assert.notEqual(first.controlDir, second.controlDir);
    assert.notEqual(first.projectDir, second.projectDir);

    assert.throws(() => prepareVirtualCreatorSession({
      profileId: 'V99',
      ...env,
      randomUUID: () => '55555555-5555-4555-8555-555555555555',
    }), /Unknown virtual creator profile/);

    const nestedProject = join(env.controlRoot, 'nested-projects');
    mkdirSync(nestedProject);
    assert.throws(() => prepareVirtualCreatorSession({
      profileId: 'V01',
      ...env,
      projectRoot: nestedProject,
      randomUUID: () => '66666666-6666-4666-8666-666666666666',
    }), /separate and non-nested/);

    assert.throws(() => prepareVirtualCreatorSession({
      profileId: 'V01',
      ...env,
      controlRoot: join(root, 'docs'),
      randomUUID: () => '77777777-7777-4777-8777-777777777777',
    }), /outside the Git repository/);
  } finally {
    rmSync(env.base, { recursive: true, force: true });
  }
});
