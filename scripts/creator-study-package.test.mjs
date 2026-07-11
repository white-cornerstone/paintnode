import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assertFacilitatorCalibration,
  FACILITATOR_ASSIST_EVENT_DEFINITIONS,
  FACILITATOR_ASSIST_EVENT_IDS,
  FACILITATOR_DEVIATION_DEFINITIONS,
  FINDING_CATEGORIES,
  nextFacilitatorIntervention,
  RECRUITMENT_EXCEPTION_IDS,
} from './creator-study-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const study = join(root, 'docs/testing/creator-study');

test('every private operational form is blank and warns to copy outside the repository', () => {
  const templates = [
    'private-study-authorization-log.md',
    'private-approved-build-record.json',
    'private-active-build-decisions.json',
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

test('private active-build ledger starts blank and requires monotonic generations', () => {
  const ledger = JSON.parse(readFileSync(join(study, 'templates/private-active-build-decisions.json'), 'utf8'));
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(ledger.schemaVersion, 2);
  assert.equal(ledger.recordType, 'paintnode-creator-study-active-build-decisions');
  assert.equal(ledger.activeGeneration, 0);
  assert.deepEqual(ledger.decisions, []);
  assert.match(packageJson.scripts['qa:creator-study:decision-commitment'], /print-decision-commitment/);
});

test('private approved-build template freezes literal identity and change-control fields', () => {
  const record = JSON.parse(readFileSync(join(study, 'templates/private-approved-build-record.json'), 'utf8'));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.recordType, 'paintnode-creator-study-approved-build');
  assert.deepEqual(Object.keys(record.approvedBuild), [
    'version', 'mode', 'bundleId', 'gitSha', 'sourceTreeSha', 'sourceDirty',
    'sourceStatusSha256', 'executableSha256',
  ]);
  assert.equal(record.approvedBuild.gitSha, '');
  assert.equal(record.approvedBuild.sourceTreeSha, '');
  assert.equal(record.approvedBuild.executableSha256, '');
  assert.equal(record.approval.ownerApproved, false);
  assert.equal(record.approval.decisionReference, '');
  assert.equal(record.approval.approvalId, '');
  assert.equal(record.changeControl.rehearsalCompletedAt, '');
  assert.equal(record.changeControl.comparabilityDecision, '');
});

test('repository templates contain headers only and no participant results', () => {
  const matrix = readFileSync(join(study, 'templates/de-identified-recruitment-matrix.csv'), 'utf8').trim().split('\n');
  assert.equal(matrix.length, 1);
  assert.doesNotMatch(matrix[0], /name|email|phone|contact|storage/i);

  const blank = JSON.parse(readFileSync(join(study, 'templates/synthesis-input.blank.json'), 'utf8'));
  assert.deepEqual(blank.participants, []);
  assert.deepEqual(blank.findings, []);
  assert.equal(blank.schemaVersion, 2);
  assert.deepEqual(Object.keys(blank.recruitmentExceptions), RECRUITMENT_EXCEPTION_IDS);
  assert.equal('recruitmentDecisionDocumented' in blank, false);
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
  assert.ok(fields.privateOnly.some((field) => /approved-build record.*active-ledger paths.*approval date.*decision references.*ledger history.*change reason/i.test(field)));
  assert.ok(fields.repositoryAllowed.some((field) => /approved build identity match.*provenance.*executable/i.test(field)));
  assert.ok(fields.repositoryAllowed.some((field) => /active generation.*random non-derived approval ID/i.test(field)));
  assert.ok(fields.repositoryAllowed.every((field) => !/participant name|contact details|raw or potentially identifying quotes|approved storage path/i.test(field)));
  assert.ok(fields.repositoryAllowed.includes('versioned facilitator instrument, including approved hint and takeover text'));
  assert.ok(fields.privateOnly.includes('participant-linked delivered facilitator interventions, including IDs, exact delivered text, assist ordinals, timestamps, and deviation logs'));
});

test('Product materials include repository-owned provenance and a public-domain dedication', () => {
  const license = readFileSync(join(study, 'materials/LICENSE.md'), 'utf8');
  assert.match(license, /generated deterministically/i);
  assert.match(license, /no client,\s+participant, stock, or externally sourced material/i);
  assert.match(license, /CC0 1\.0 Universal/);
});

test('synthesis schema matches the shared finding categories and supports replacement records', () => {
  const schema = JSON.parse(readFileSync(join(study, 'synthesis-input.schema.json'), 'utf8'));
  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.match(schema.$id, /v2\.json$/);
  assert.deepEqual(Object.keys(schema.properties.recruitmentExceptions.properties), RECRUITMENT_EXCEPTION_IDS);
  assert.equal(schema.properties.recruitmentExceptions.additionalProperties, false);
  assert.equal('recruitmentDecisionDocumented' in schema.properties, false);
  for (const id of RECRUITMENT_EXCEPTION_IDS) {
    assert.deepEqual(schema.properties.recruitmentExceptions.properties[id].required, [
      'approved', 'rationaleRecorded', 'decisionReference',
    ]);
    assert.equal(schema.properties.recruitmentExceptions.properties[id].additionalProperties, false);
    assert.equal(
      schema.properties.recruitmentExceptions.properties[id].allOf[0].then
        .properties.rationaleRecorded.const,
      true,
    );
    assert.equal(
      schema.properties.recruitmentExceptions.properties[id].allOf[0].else
        .properties.decisionReference.const,
      null,
    );
  }
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
  const authorization = readFileSync(join(study, 'templates/private-study-authorization-log.md'), 'utf8');
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
  assert.match(session, /Approved-build decision reference/);
  assert.match(session, /Active build generation and approval ID/);
  assert.match(session, /Setup receipt approved identity match/);
  assert.match(reset, /approved-build decision reference/i);
  assert.match(reset, /active generation and complete private ledger head.*protected study-Mac anchor/i);
  assert.match(reset, /schedule, roles, delivery mode, and accommodation setup/i);
  assert.match(reset, /--fresh-study-session/);
  assert.match(reset, /Project visibly shows no open project\/imported assets/i);
  assert.match(reset, /--visible-empty-state-attested/);
  for (const id of RECRUITMENT_EXCEPTION_IDS) assert.match(authorization, new RegExp(`\\b${id}\\b`));
  assert.match(authorization, /one requirement never waives the other/i);
});

test('operations require a fresh isolated profile and preserve only same-session reopen', () => {
  const operations = readFileSync(join(study, 'README.md'), 'utf8');
  assert.match(operations, /--fresh-study-session/);
  assert.match(operations, /--resume-study-session/);
  assert.match(operations, /--study-capable --build-only/);
  assert.match(operations, /qa:creator-study:launch[\s\S]*--app-bundle/);
  assert.match(operations, /performs no Tauri, Vite, Quick Look, or other[\s\n]*build/i);
  assert.match(operations, /static provenance[\s\S]*neither is rewritten/i);
  assert.match(operations, /--visible-empty-state-attested/);
  assert.match(operations, /must never start a new participant/i);
  assert.match(operations, /qa:creator-study:finalize-session/);
  assert.match(operations, /qa:creator-study:abort-session/);
  assert.match(operations, /dataStoreRemoved: true/);
  assert.match(operations, /single-use/);
  assert.match(operations, /monotonic single-Mac anchor/);
  assert.match(operations, /build-only[\s\S]*does not allocate/i);
});

test('repository-safe decision handoff excludes private scheduling and identity fields', () => {
  const decision = readFileSync(join(study, 'templates/de-identified-study-decision.md'), 'utf8');
  for (const field of [
    'participantIds', 'category', 'traceable', 'resolved', 'blocksExit',
    'exceptionApproved', 'exceptionRationaleRecorded',
  ]) {
    assert.match(decision, new RegExp(`\\b${field}\\b`));
  }
  for (const field of [
    'cohortMix', 'keyboardOrAccessibilityCoverage', 'approved',
    'rationaleRecorded', 'decisionReference', 'applied',
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
  assert.deepEqual(instrument.progression, {
    checkpointSelection: 'earliest-incomplete',
    checkpointProgressResetsIntervalSeconds: 90,
    changedCheckpointHintLevel: 'first',
    unchangedCheckpointHintSequence: ['first', 'second', 'takeover'],
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

  assert.equal(instrument.takeoverActions.length, checkpoints.length);
  assert.deepEqual(
    instrument.takeoverActions.map(({ checkpointId }) => checkpointId),
    checkpoints.map(({ id }) => id),
  );
  for (const action of instrument.takeoverActions) {
    assert.match(action.id, /^T[1-8]-C[1-9][0-9]*-TO$/);
    assert.ok(action.exactAction.trim());
  }
});

test('checkpoint progress recomputes the hint ladder instead of delivering a stale second hint', () => {
  const instrument = JSON.parse(readFileSync(join(study, 'facilitator-hints.json'), 'utf8'));
  const first = nextFacilitatorIntervention({
    instrument, taskNumber: 1, completedCheckpointIds: [], previousIntervention: null,
  });
  assert.deepEqual(first, {
    type: 'standard-hint', checkpointId: 'T1-C1', interventionId: 'T1-C1-H1',
    hintLevel: 'first', exactText: instrument.tasks[0].checkpoints[0].firstHint,
  });

  const afterProgress = nextFacilitatorIntervention({
    instrument, taskNumber: 1, completedCheckpointIds: ['T1-C1'], previousIntervention: first,
  });
  assert.deepEqual(afterProgress, {
    type: 'standard-hint', checkpointId: 'T1-C2', interventionId: 'T1-C2-H1',
    hintLevel: 'first', exactText: instrument.tasks[0].checkpoints[1].firstHint,
  });

  const withoutProgress = nextFacilitatorIntervention({
    instrument, taskNumber: 1, completedCheckpointIds: [], previousIntervention: first,
  });
  assert.deepEqual(withoutProgress, {
    type: 'standard-hint', checkpointId: 'T1-C1', interventionId: 'T1-C1-H2',
    hintLevel: 'second', exactText: instrument.tasks[0].checkpoints[0].secondHint,
  });
  const takeover = nextFacilitatorIntervention({
    instrument, taskNumber: 1, completedCheckpointIds: [], previousIntervention: withoutProgress,
  });
  assert.deepEqual(takeover, {
    type: 'takeover', checkpointId: 'T1-C1', interventionId: 'T1-C1-TO',
    hintLevel: null, exactText: instrument.takeoverActions[0].exactAction,
  });
  const afterSecondHintProgress = nextFacilitatorIntervention({
    instrument, taskNumber: 1, completedCheckpointIds: ['T1-C1'],
    previousIntervention: withoutProgress,
  });
  assert.deepEqual(afterSecondHintProgress, afterProgress);
});

test('calibration pins exact instrument bytes and detects arbitrary version-preserving mutation', () => {
  const bytes = readFileSync(join(study, 'facilitator-hints.json'));
  const pinned = readFileSync(join(study, 'facilitator-hints.sha256'), 'utf8').trim();
  assert.match(pinned, /^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pinned);

  const approvedGitChangeReference = 'fc2d2306f2ce466c0c0d7f941bccc9d7447aeadc';
  const signoff = {
    instrumentVersion: 1,
    instrumentSha256: pinned,
    approvedGitChangeReference,
    calibrationCompleted: true,
  };
  assert.deepEqual(assertFacilitatorCalibration({
    instrumentBytes: bytes,
    pinnedSha256: pinned,
    instrumentVersion: 1,
    approvedGitChangeReference,
    signoff,
  }), signoff);

  const mutated = JSON.parse(bytes);
  mutated.tasks[0].checkpoints[0].firstHint = 'Click anything until the task works.';
  assert.equal(mutated.version, 1);
  const mutatedBytes = `${JSON.stringify(mutated, null, 2)}\n`;
  assert.throws(
    () => assertFacilitatorCalibration({
      instrumentBytes: mutatedBytes,
      pinnedSha256: pinned,
      instrumentVersion: 1,
      approvedGitChangeReference,
      signoff,
    }),
    /SHA-256/i,
  );
  assert.throws(() => assertFacilitatorCalibration({
    instrumentBytes: bytes,
    pinnedSha256: pinned,
    instrumentVersion: 1,
    approvedGitChangeReference: 'different-approved-change',
    signoff,
  }), /Git change reference/i);
});

test('private templates close hint logging, deviation validity, and calibration sign-off', () => {
  const intervention = readFileSync(join(study, 'templates/private-intervention-log.md'), 'utf8');
  const session = readFileSync(join(study, 'templates/private-session-observation.md'), 'utf8');
  const authorization = readFileSync(join(study, 'templates/private-study-authorization-log.md'), 'utf8');
  const reset = readFileSync(join(study, 'templates/private-session-reset.md'), 'utf8');
  for (const template of [intervention, session]) {
    for (const field of [
      'Hint ID', 'Exact hint used', 'Assist ordinal', 'Assist event type',
      'Takeover action ID', 'Exact takeover action', 'Deviation ID', 'Session validity effect',
    ]) assert.match(template, new RegExp(field));
  }
  assert.match(intervention, /For a takeover[\s\S]*N\/A[\s\S]*Takeover action ID/);
  assert.match(authorization, /Facilitator calibration and rehearsal sign-off/);
  assert.match(authorization, /before participant 1/i);
  assert.match(authorization, /after every approved instrument change/i);
  assert.match(authorization, /Instrument SHA-256/);
  assert.match(authorization, /Approved Git SHA\/change reference/);
  assert.match(reset, /calibration sign-off.*current instrument version, SHA-256, and approved Git change reference/i);
});
