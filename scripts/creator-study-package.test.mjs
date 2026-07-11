import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { FINDING_CATEGORIES, RECRUITMENT_EXCEPTION_IDS } from './creator-study-contract.mjs';

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
  assert.match(reset, /schedule, roles, delivery mode, and accommodation setup/i);
  for (const id of RECRUITMENT_EXCEPTION_IDS) assert.match(authorization, new RegExp(`\\b${id}\\b`));
  assert.match(authorization, /one requirement never waives the other/i);
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
});
