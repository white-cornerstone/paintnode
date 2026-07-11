import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateStudySynthesis } from './creator-study-synthesis.mjs';

const outcomes = Array.from({ length: 8 }, (_, index) => ({
  task: index + 1,
  outcome: 'unaided success',
  seconds: 60 + index,
  neutralProbes: 0,
  directAssists: 0,
  wrongTurns: 0,
  repeatedActions: 0,
  errorLoops: 0,
  recoveryAttempts: 0,
  seq: 6,
  acceptedWorkPreserved: index === 7 ? true : null,
}));

function testOnlyParticipant(index, overrides = {}) {
  return {
    id: `TEST-${index}`,
    testOnly: true,
    valid: true,
    invalidReasonCategory: null,
    multiFormatRegular: index <= 4,
    aiExperience: index <= 2 ? 'weekly' : index <= 4 ? 'occasional' : 'never',
    keyboardOrAccessibilityCoverage: index === 1,
    tasks: structuredClone(outcomes),
    ...overrides,
  };
}

function passingInput() {
  return {
    schemaVersion: 2,
    testOnly: true,
    participants: Array.from({ length: 8 }, (_, index) => testOnlyParticipant(index + 1)),
    findings: [],
    recruitmentExceptions: {
      cohortMix: { approved: false, rationaleRecorded: false, decisionReference: null },
      keyboardOrAccessibilityCoverage: { approved: false, rationaleRecorded: false, decisionReference: null },
    },
    configuredProviderEvidenceRecorded: true,
    requiredSignoffsRecorded: true,
    outstandingNonBlockingActions: [],
  };
}

function approveRecruitmentException(input, exception, suffix) {
  input.recruitmentExceptions[exception] = {
    approved: true,
    rationaleRecorded: true,
    decisionReference: `TEST-DEC-${suffix}`,
  };
}

function testFinding(overrides = {}) {
  return {
    id: 'TEST-F8',
    severity: 'S3',
    participantIds: ['TEST-1'],
    category: 'copy-clarity',
    resolved: false,
    traceable: true,
    blocksExit: false,
    exceptionApproved: false,
    exceptionRationaleRecorded: false,
    ...overrides,
  };
}

test('calculator reports exact denominators, median/range, cohort mix, thresholds, and pass mapping', () => {
  const input = passingInput();
  input.participants.forEach((participant, index) => { participant.tasks[0].seconds = 50 + (index * 10); });
  const result = calculateStudySynthesis(input);

  assert.equal(result.schemaVersion, 2);
  assert.equal(result.validSessions, 8);
  assert.equal(result.fullJourney.unaided.count, 8);
  assert.equal(result.fullJourney.unaided.denominator, 8);
  assert.equal(result.fullJourney.unaided.percent, 100);
  assert.deepEqual(result.tasks[0].seconds, { median: 85, min: 50, max: 120, recorded: 8 });
  assert.deepEqual(result.tasks[0].seq, { median: 6, min: 6, max: 6, recorded: 8 });
  assert.deepEqual(result.cohort, {
    multiFormatRegular: 4,
    aiWeekly: 2,
    aiOccasionalOrNonUser: 6,
    keyboardOrAccessibilityCoverage: 1,
  });
  assert.deepEqual(result.participantBurden[0], {
    participantId: 'TEST-1',
    neutralProbes: 0,
    directAssists: 0,
    wrongTurns: 0,
    repeatedActions: 0,
    errorLoops: 0,
    recoveryAttempts: 0,
  });
  assert.equal(result.thresholds.met, true);
  assert.equal(result.recommendation, 'pass');
  assert.deepEqual(result.warnings, []);
});

test('not attempted remains in the denominator and missing values produce warnings', () => {
  const input = passingInput();
  input.participants[0].tasks[2] = {
    task: 3,
    outcome: 'not attempted',
    seconds: null,
    neutralProbes: 0,
    directAssists: 0,
    wrongTurns: 0,
    repeatedActions: 0,
    errorLoops: 0,
    recoveryAttempts: 0,
    seq: null,
    acceptedWorkPreserved: null,
  };
  const result = calculateStudySynthesis(input);

  assert.equal(result.tasks[2].unaided.count, 7);
  assert.equal(result.tasks[2].unaided.denominator, 8);
  assert.equal(result.tasks[2].failedOrNotAttempted, 1);
  assert.equal(result.tasks[2].seconds.recorded, 7);
  assert.ok(result.warnings.some((warning) => /Task 3.*seconds/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /Task 3.*SEQ/i.test(warning)));
  assert.equal(result.recommendation, 'insufficient evidence');
});

test('accepted-work preservation is boolean or null and remains Task 8 only', () => {
  for (const invalid of ['true', 1, { observed: true }]) {
    const input = passingInput();
    input.participants[0].tasks[7].acceptedWorkPreserved = invalid;
    assert.throws(
      () => calculateStudySynthesis(input),
      /acceptedWorkPreserved.*boolean or null/i,
    );
  }

  const invalidEarlierTaskType = passingInput();
  invalidEarlierTaskType.participants[0].tasks[0].acceptedWorkPreserved = 'false';
  assert.throws(
    () => calculateStudySynthesis(invalidEarlierTaskType),
    /acceptedWorkPreserved.*boolean or null/i,
  );

  const booleanOnEarlierTask = passingInput();
  booleanOnEarlierTask.participants[0].tasks[0].acceptedWorkPreserved = false;
  assert.throws(
    () => calculateStudySynthesis(booleanOnEarlierTask),
    /only for Task 8/i,
  );
});

test('insufficient evidence, blocker, conditional, and severity mappings are deterministic', () => {
  const insufficient = passingInput();
  insufficient.participants = insufficient.participants.slice(0, 5);
  assert.equal(calculateStudySynthesis(insufficient).recommendation, 'insufficient evidence');

  const blocked = passingInput();
  blocked.findings.push(testFinding({
    id: 'TEST-F1', severity: 'S0', participantIds: ['TEST-1'],
    category: 'wrong-lineage', resolved: false, traceable: true,
  }));
  assert.equal(calculateStudySynthesis(blocked).recommendation, 'block');

  const conditional = passingInput();
  conditional.outstandingNonBlockingActions.push('TEST-ONLY copy refinement');
  assert.equal(calculateStudySynthesis(conditional).recommendation, 'conditional');

  const missingProvider = passingInput();
  missingProvider.configuredProviderEvidenceRecorded = false;
  const missingProviderResult = calculateStudySynthesis(missingProvider);
  assert.equal(missingProviderResult.recommendation, 'insufficient evidence');
  assert.ok(missingProviderResult.warnings.some((warning) => /configured-provider evidence/i.test(warning)));
});

test('critical thresholds, even medians, and invalid-session exclusion are explicit', () => {
  const input = passingInput();
  input.participants[0].tasks[4].seconds = 40;
  input.participants[1].tasks[4].seconds = 80;
  input.participants[0].valid = false;
  input.participants[0].invalidReasonCategory = 'wrong-or-unusable-build';
  input.participants[4].multiFormatRegular = true;
  input.participants[4].aiExperience = 'weekly';
  input.participants[1].keyboardOrAccessibilityCoverage = true;
  let result = calculateStudySynthesis(input);
  assert.equal(result.validSessions, 7);
  assert.equal(result.invalidSessions, 1);
  assert.deepEqual(result.tasks[4].seconds, { median: 64, min: 64, max: 80, recorded: 7 });

  input.participants[1].tasks[4].outcome = 'failure';
  input.participants[2].tasks[4].outcome = 'failure';
  result = calculateStudySynthesis(input);
  assert.equal(result.tasks[4].criticalAtMostOneAssist.count, 5);
  assert.equal(result.recommendation, 'block');

});

test('cohort-mix and keyboard/accessibility gaps require independent closed approvals', () => {
  const scenario = ({ cohortGap, accessibilityGap, cohortApproval, accessibilityApproval }) => {
    const input = passingInput();
    if (cohortGap) input.participants.forEach((participant) => { participant.multiFormatRegular = false; });
    if (accessibilityGap) input.participants.forEach((participant) => { participant.keyboardOrAccessibilityCoverage = false; });
    if (cohortApproval) approveRecruitmentException(input, 'cohortMix', '1');
    if (accessibilityApproval) approveRecruitmentException(input, 'keyboardOrAccessibilityCoverage', '2');
    return calculateStudySynthesis(input);
  };

  assert.equal(scenario({}).recommendation, 'pass');

  const cohortMissing = scenario({ cohortGap: true });
  assert.equal(cohortMissing.recommendation, 'insufficient evidence');
  assert.match(cohortMissing.warnings.join('\n'), /cohort mix/i);
  assert.doesNotMatch(cohortMissing.warnings.join('\n'), /keyboard\/accessibility/i);

  const accessibilityMissing = scenario({ accessibilityGap: true });
  assert.equal(accessibilityMissing.recommendation, 'insufficient evidence');
  assert.doesNotMatch(accessibilityMissing.warnings.join('\n'), /cohort mix/i);
  assert.match(accessibilityMissing.warnings.join('\n'), /keyboard\/accessibility/i);

  const neitherApproved = scenario({ cohortGap: true, accessibilityGap: true });
  assert.equal(neitherApproved.recommendation, 'insufficient evidence');
  assert.match(neitherApproved.warnings.join('\n'), /cohort mix/i);
  assert.match(neitherApproved.warnings.join('\n'), /keyboard\/accessibility/i);

  const cohortOnly = scenario({
    cohortGap: true, accessibilityGap: true, cohortApproval: true,
  });
  assert.equal(cohortOnly.recommendation, 'insufficient evidence');
  assert.doesNotMatch(cohortOnly.warnings.join('\n'), /cohort mix/i);
  assert.match(cohortOnly.warnings.join('\n'), /keyboard\/accessibility/i);
  assert.equal(cohortOnly.recruitmentExceptions.cohortMix.applied, true);
  assert.equal(cohortOnly.recruitmentExceptions.keyboardOrAccessibilityCoverage.applied, false);

  const accessibilityOnly = scenario({
    cohortGap: true, accessibilityGap: true, accessibilityApproval: true,
  });
  assert.equal(accessibilityOnly.recommendation, 'insufficient evidence');
  assert.match(accessibilityOnly.warnings.join('\n'), /cohort mix/i);
  assert.doesNotMatch(accessibilityOnly.warnings.join('\n'), /keyboard\/accessibility/i);

  const bothApproved = scenario({
    cohortGap: true, accessibilityGap: true, cohortApproval: true, accessibilityApproval: true,
  });
  assert.equal(bothApproved.recommendation, 'pass');
  assert.deepEqual(
    Object.fromEntries(Object.entries(bothApproved.recruitmentExceptions)
      .map(([id, exception]) => [id, {
        requirementMet: exception.requirementMet,
        approved: exception.approved,
        decisionReference: exception.decisionReference,
        rationaleRecorded: exception.rationaleRecorded,
        applied: exception.applied,
        effectiveComplete: exception.effectiveComplete,
      }])),
    {
      cohortMix: {
        requirementMet: false, approved: true, decisionReference: 'TEST-DEC-1',
        rationaleRecorded: true, applied: true, effectiveComplete: true,
      },
      keyboardOrAccessibilityCoverage: {
        requirementMet: false, approved: true, decisionReference: 'TEST-DEC-2',
        rationaleRecorded: true, applied: true, effectiveComplete: true,
      },
    },
  );

  assert.equal(scenario({ cohortGap: true, cohortApproval: true }).recommendation, 'pass');
  assert.equal(scenario({ accessibilityGap: true, accessibilityApproval: true }).recommendation, 'pass');
  assert.equal(scenario({ cohortGap: true, accessibilityApproval: true }).recommendation, 'insufficient evidence');
  assert.equal(scenario({ accessibilityGap: true, cohortApproval: true }).recommendation, 'insufficient evidence');

  const unusedApproval = scenario({ cohortApproval: true });
  assert.equal(unusedApproval.recommendation, 'pass');
  assert.equal(unusedApproval.recruitmentExceptions.cohortMix.applied, false);
});

test('recruitment exception approvals require closed rationale and decision-reference state', () => {
  const legacyVersion = passingInput();
  legacyVersion.schemaVersion = 1;
  assert.throws(() => calculateStudySynthesis(legacyVersion), /schemaVersion 2/i);

  const generic = passingInput();
  generic.recruitmentDecisionDocumented = true;
  assert.throws(() => calculateStudySynthesis(generic), /unsupported field.*recruitmentDecisionDocumented/i);

  for (const record of [
    { approved: true, rationaleRecorded: false, decisionReference: 'TEST-DEC-1' },
    { approved: true, rationaleRecorded: true, decisionReference: null },
    { approved: false, rationaleRecorded: true, decisionReference: null },
    { approved: false, rationaleRecorded: false, decisionReference: 'TEST-DEC-1' },
    { approved: true, rationaleRecorded: true, decisionReference: 'private/path' },
  ]) {
    const input = passingInput();
    input.recruitmentExceptions.cohortMix = record;
    assert.throws(
      () => calculateStudySynthesis(input),
      /cohortMix.*approval|cohortMix.*decision reference/i,
    );
  }

  const missingRecord = passingInput();
  delete missingRecord.recruitmentExceptions.keyboardOrAccessibilityCoverage;
  assert.throws(
    () => calculateStudySynthesis(missingRecord),
    /recruitmentExceptions.*keyboardOrAccessibilityCoverage/i,
  );

  const sharedDecision = passingInput();
  approveRecruitmentException(sharedDecision, 'cohortMix', '4');
  approveRecruitmentException(sharedDecision, 'keyboardOrAccessibilityCoverage', '4');
  assert.throws(
    () => calculateStudySynthesis(sharedDecision),
    /distinct de-identified decision references/i,
  );
});

test('S1 integrity rules and approved non-integrity exceptions map separately', () => {
  const integrity = passingInput();
  integrity.findings.push(testFinding({
    id: 'TEST-F2', severity: 'S1', participantIds: ['TEST-1'],
    category: 'save-reopen', resolved: false, traceable: true, exceptionApproved: true,
  }));
  assert.equal(calculateStudySynthesis(integrity).recommendation, 'block');

  const missingRationale = passingInput();
  missingRationale.findings.push(testFinding({
    id: 'TEST-F2B', severity: 'S1', participantIds: ['TEST-1'],
    category: 'copy-clarity', resolved: false, traceable: true, exceptionApproved: true,
  }));
  assert.equal(calculateStudySynthesis(missingRationale).recommendation, 'block');

  const approvedException = passingInput();
  approvedException.findings.push(testFinding({
    id: 'TEST-F3', severity: 'S1', participantIds: ['TEST-1'],
    category: 'copy-clarity', resolved: false, traceable: true,
    exceptionApproved: true, exceptionRationaleRecorded: true,
  }));
  const result = calculateStudySynthesis(approvedException);
  assert.equal(result.recommendation, 'pass');
  assert.equal(result.severityCounts.S1, 1);
  assert.equal(result.findings[0].frequency, 1);
});

test('accessibility recruitment limits and explicitly blocking S2 burden are preserved', () => {
  const accessibilityGap = passingInput();
  accessibilityGap.participants.forEach((participant) => { participant.keyboardOrAccessibilityCoverage = false; });
  assert.equal(calculateStudySynthesis(accessibilityGap).recommendation, 'insufficient evidence');
  approveRecruitmentException(accessibilityGap, 'keyboardOrAccessibilityCoverage', '3');
  assert.equal(calculateStudySynthesis(accessibilityGap).recommendation, 'pass');

  const repeatedBurden = passingInput();
  repeatedBurden.findings.push(testFinding({
    id: 'TEST-F4', severity: 'S2', participantIds: ['TEST-1', 'TEST-2', 'TEST-3'],
    category: 'repeated-error-burden', resolved: false, traceable: true, blocksExit: true,
  }));
  assert.equal(calculateStudySynthesis(repeatedBurden).recommendation, 'block');
});

test('private-only fields fail closed before calculation', () => {
  const input = passingInput();
  input.participants[0].email = 'forbidden@example.invalid';
  assert.throws(() => calculateStudySynthesis(input), /private-only field.*email/i);

  const unsupported = passingInput();
  unsupported.participants[0].rawObservation = 'must remain private';
  assert.throws(() => calculateStudySynthesis(unsupported), /unsupported field.*rawObservation/i);
});

test('calculator rejects participant-shaped production data marked as test-only inconsistently', () => {
  const input = passingInput();
  input.testOnly = false;
  assert.throws(() => calculateStudySynthesis(input), /TEST-.*test-only/i);
});

test('outcome labels cannot disguise direct facilitator assistance', () => {
  const input = passingInput();
  input.participants[0].tasks[0].directAssists = 1;
  assert.throws(() => calculateStudySynthesis(input), /outcome conflicts.*direct-assist/i);
});

test('finding categories are typed and integrity variants cannot bypass blockers', () => {
  const input = passingInput();
  input.findings.push(testFinding({
    id: 'TEST-F5', severity: 'S1', participantIds: ['TEST-1'],
    category: 'save_reopen', resolved: false, traceable: true,
    exceptionApproved: true, exceptionRationaleRecorded: true,
  }));
  assert.throws(() => calculateStudySynthesis(input), /finding category/i);
});

test('finding IDs are unique and every finding references at least one participant', () => {
  const duplicate = passingInput();
  duplicate.findings.push(
    testFinding({ id: 'TEST-F6', severity: 'S2', participantIds: ['TEST-1'] }),
    testFinding({ id: 'TEST-F6', severity: 'S3', participantIds: ['TEST-2'] }),
  );
  assert.throws(() => calculateStudySynthesis(duplicate), /finding IDs.*unique/i);

  const emptyReferences = passingInput();
  emptyReferences.findings.push(testFinding({
    id: 'TEST-F7', severity: 'S3', participantIds: [],
    category: 'copy-clarity', resolved: false, traceable: true,
  }));
  assert.throws(() => calculateStudySynthesis(emptyReferences), /at least one participant/i);
});

test('eight valid sessions plus invalid replacements remain representable', () => {
  const input = passingInput();
  input.participants.push(
    testOnlyParticipant(9, { valid: false, invalidReasonCategory: 'wrong-or-unusable-build' }),
    testOnlyParticipant(10, { valid: false, invalidReasonCategory: 'facilitator-deviation' }),
  );
  input.testOnly = false;
  input.participants.forEach((participant, index) => {
    participant.id = `P${String(index + 1).padStart(2, '0')}`;
    delete participant.testOnly;
  });
  const result = calculateStudySynthesis(input);
  assert.equal(result.recruitedSessions, 10);
  assert.equal(result.validSessions, 8);
  assert.equal(result.invalidSessions, 2);
  assert.equal(result.recommendation, 'pass');
});

test('every finding requires the complete closed handoff contract', () => {
  for (const field of ['blocksExit', 'exceptionApproved', 'exceptionRationaleRecorded']) {
    const input = passingInput();
    const finding = testFinding();
    delete finding[field];
    input.findings.push(finding);
    assert.throws(() => calculateStudySynthesis(input), new RegExp(`missing required field.*${field}`, 'i'));
  }

  const nonBoolean = passingInput();
  nonBoolean.findings.push(testFinding({ traceable: 'yes' }));
  assert.throws(() => calculateStudySynthesis(nonBoolean), /finding handoff fields.*boolean/i);
});

test('resolved findings cannot remain explicitly marked as exit blockers', () => {
  const input = passingInput();
  input.findings.push(testFinding({ resolved: true, blocksExit: true }));
  assert.throws(() => calculateStudySynthesis(input), /resolved finding.*blocksExit/i);
});
