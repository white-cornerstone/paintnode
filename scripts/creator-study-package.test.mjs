import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  FACILITATOR_ASSIST_EVENT_DEFINITIONS,
  FACILITATOR_ASSIST_EVENT_IDS,
  FACILITATOR_DEVIATION_DEFINITIONS,
  FINDING_CATEGORIES,
} from './creator-study-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const study = join(root, 'docs/testing/creator-study');

test('every private operational form is blank and warns to copy outside the repository', () => {
  const templates = [
    'private-study-authorization-log.md',
    'private-screener-and-recruitment-log.md',
    'private-session-observation.md',
    'private-intervention-log.md',
    'private-incident-and-invalid-session.md',
    'private-session-reset.md',
  ];
  for (const template of templates) {
    const content = readFileSync(join(study, 'templates', template), 'utf8');
    assert.match(content, /COPY OUTSIDE REPOSITORY/);
    assert.match(content, /PRIVATE ONLY/);
    assert.doesNotMatch(content, /P(?:0[1-9]|[1-9][0-9])|@|https?:\/\//, `${template} must not contain participant-shaped data`);
  }
});

test('repository templates contain headers only and no participant results', () => {
  const matrix = readFileSync(join(study, 'templates/de-identified-recruitment-matrix.csv'), 'utf8').trim().split('\n');
  assert.equal(matrix.length, 1);
  assert.doesNotMatch(matrix[0], /name|email|phone|contact|storage/i);

  const blank = JSON.parse(readFileSync(join(study, 'templates/synthesis-input.blank.json'), 'utf8'));
  assert.deepEqual(blank.participants, []);
  assert.deepEqual(blank.findings, []);
  assert.equal(blank.configuredProviderEvidenceRecorded, false);
  assert.equal(blank.requiredSignoffsRecorded, false);
});

test('privacy contract keeps identifiable and raw evidence out of repository-safe fields', () => {
  const fields = JSON.parse(readFileSync(join(study, 'privacy-fields.json'), 'utf8'));
  assert.ok(fields.privateOnly.some((field) => /recordings/i.test(field)));
  assert.ok(fields.privateOnly.some((field) => /storage path/i.test(field)));
  assert.ok(fields.privateOnly.some((field) => /participant code mapping/i.test(field)));
  assert.ok(fields.privateOnly.some((field) => /session date.*time zone.*delivery mode/i.test(field)));
  assert.ok(fields.privateOnly.some((field) => /facilitator.*observer.*technical operator/i.test(field)));
  assert.ok(fields.repositoryAllowed.every((field) => !/participant name|contact details|raw or potentially identifying quotes|approved storage path/i.test(field)));
});

test('Product materials include repository-owned provenance and a public-domain dedication', () => {
  const license = readFileSync(join(study, 'materials/LICENSE.md'), 'utf8');
  assert.match(license, /generated deterministically/i);
  assert.match(license, /no client,\s+participant, stock, or externally sourced material/i);
  assert.match(license, /CC0 1\.0 Universal/);
});

test('synthesis schema matches the shared finding categories and supports replacement records', () => {
  const schema = JSON.parse(readFileSync(join(study, 'synthesis-input.schema.json'), 'utf8'));
  assert.deepEqual(schema.$defs.finding.properties.category.enum, FINDING_CATEGORIES);
  assert.equal(schema.$defs.finding.properties.participantIds.minItems, 1);
  assert.equal(schema.$defs.finding.properties.participantIds.uniqueItems, true);
  assert.equal(schema.properties.participants.maxItems > 8, true);
  assert.equal(new RegExp(schema.$defs.participant.properties.id.pattern).test('P99'), true);
  assert.equal(schema.$defs.finding.properties.id.pattern, '^CB-[1-9][0-9]*$');
  assert.deepEqual(schema.$defs.finding.required, [
    'id', 'severity', 'participantIds', 'category', 'resolved', 'traceable',
    'blocksExit', 'exceptionApproved', 'exceptionRationaleRecorded',
  ]);
  for (const field of ['resolved', 'traceable', 'blocksExit', 'exceptionApproved', 'exceptionRationaleRecorded']) {
    assert.equal(schema.$defs.finding.properties[field].type, 'boolean');
  }
});

test('private handoff templates capture schema fields and concrete scheduling assignments', () => {
  const session = readFileSync(join(study, 'templates/private-session-observation.md'), 'utf8');
  const recruitment = readFileSync(join(study, 'templates/private-screener-and-recruitment-log.md'), 'utf8');
  const reset = readFileSync(join(study, 'templates/private-session-reset.md'), 'utf8');
  for (const field of [
    'acceptedWorkPreserved', 'participantIds', 'category', 'traceable', 'resolved',
    'blocksExit', 'exceptionApproved', 'exceptionRationaleRecorded',
  ]) {
    assert.match(session, new RegExp(`\\b${field}\\b`));
  }
  for (const label of [
    'Scheduled date', 'Scheduled start time', 'Time zone', 'Delivery mode',
    'Assigned facilitator', 'Named session observers', 'Technical session operator',
    'Accommodation setup confirmation',
  ]) {
    assert.match(recruitment, new RegExp(label));
  }
  assert.match(reset, /schedule, roles, delivery mode, and accommodation setup/i);
});

test('repository-safe decision handoff excludes private scheduling and identity fields', () => {
  const decision = readFileSync(join(study, 'templates/de-identified-study-decision.md'), 'utf8');
  for (const field of [
    'participantIds', 'category', 'traceable', 'resolved', 'blocksExit',
    'exceptionApproved', 'exceptionRationaleRecorded',
  ]) {
    assert.match(decision, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(decision, /Scheduled start time|Time zone|Assigned facilitator|Named session observers|Technical session operator|Private location or meeting reference/);
  assert.doesNotMatch(decision, /Exact hint used|Hint ID|Assist ordinal|Deviation ID/);
});

test('facilitator hint instrument covers Tasks 1-8 with exact closed assist semantics', () => {
  const instrument = JSON.parse(readFileSync(join(study, 'facilitator-hints.json'), 'utf8'));
  assert.equal(instrument.version, 1);
  assert.equal(instrument.participantVisibility, 'hidden-until-used');
  assert.deepEqual(instrument.timing, {
    neutralProbeAfterSeconds: 90,
    firstHintAfterTotalSeconds: 180,
    secondHintAfterAdditionalSeconds: 90,
    takeoverAfterAdditionalSeconds: 90,
  });
  assert.deepEqual(instrument.tasks.map(({ task }) => task), [1, 2, 3, 4, 5, 6, 7, 8]);
  const checkpoints = instrument.tasks.flatMap(({ checkpoints }) => checkpoints);
  assert.ok(instrument.tasks.every(({ checkpoints: taskCheckpoints }) => taskCheckpoints.length > 0));
  assert.equal(new Set(checkpoints.map(({ id }) => id)).size, checkpoints.length);
  for (const checkpoint of checkpoints) {
    assert.match(checkpoint.id, /^T[1-8]-C[1-9][0-9]*$/);
    assert.ok(checkpoint.completionCriterion.trim());
    assert.ok(checkpoint.firstHint.trim());
    assert.ok(checkpoint.secondHint.trim());
    assert.notEqual(checkpoint.firstHint, checkpoint.secondHint);
  }

  assert.deepEqual(instrument.assistEvents.map(({ id }) => id), FACILITATOR_ASSIST_EVENT_IDS);
  assert.deepEqual(instrument.assistEvents, FACILITATOR_ASSIST_EVENT_DEFINITIONS);
  assert.deepEqual(
    Object.fromEntries(instrument.assistEvents.map(({ id, assistIncrement, forcesTaskFailure }) => [
      id, { assistIncrement, forcesTaskFailure },
    ])),
    {
      'neutral-probe': { assistIncrement: 0, forcesTaskFailure: false },
      'standard-hint': { assistIncrement: 1, forcesTaskFailure: false },
      'verbatim-repeat': { assistIncrement: 0, forcesTaskFailure: false },
      takeover: { assistIncrement: 1, forcesTaskFailure: true },
      'unscripted-assist': { assistIncrement: 1, forcesTaskFailure: false },
    },
  );
  assert.deepEqual(instrument.deviations, FACILITATOR_DEVIATION_DEFINITIONS);
  assert.equal(new Set(instrument.deviations.map(({ id }) => id)).size, instrument.deviations.length);
  assert.ok(instrument.deviations.every(({ sessionValidity }) => ['valid', 'invalid'].includes(sessionValidity)));
});

test('private templates close hint logging, deviation validity, and calibration sign-off', () => {
  const intervention = readFileSync(join(study, 'templates/private-intervention-log.md'), 'utf8');
  const session = readFileSync(join(study, 'templates/private-session-observation.md'), 'utf8');
  const authorization = readFileSync(join(study, 'templates/private-study-authorization-log.md'), 'utf8');
  const reset = readFileSync(join(study, 'templates/private-session-reset.md'), 'utf8');
  for (const template of [intervention, session]) {
    for (const field of [
      'Hint ID', 'Exact hint used', 'Assist ordinal', 'Assist event type',
      'Deviation ID', 'Session validity effect',
    ]) assert.match(template, new RegExp(field));
  }
  assert.match(authorization, /Facilitator calibration and rehearsal sign-off/);
  assert.match(authorization, /before participant 1/i);
  assert.match(authorization, /after every approved instrument change/i);
  assert.match(reset, /calibration sign-off.*current instrument version/i);
});
