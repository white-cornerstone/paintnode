import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

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
    assert.doesNotMatch(content, /P0[1-8]|@|https?:\/\//, `${template} must not contain participant-shaped data`);
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
  assert.ok(fields.repositoryAllowed.every((field) => !/participant name|contact details|raw or potentially identifying quotes|approved storage path/i.test(field)));
});

test('Product materials include repository-owned provenance and a public-domain dedication', () => {
  const license = readFileSync(join(study, 'materials/LICENSE.md'), 'utf8');
  assert.match(license, /generated deterministically/i);
  assert.match(license, /no client,\s+participant, stock, or externally sourced material/i);
  assert.match(license, /CC0 1\.0 Universal/);
});
