import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FINDING_CATEGORIES,
  isIntegrityBlockingFindingCategory,
} from './creator-study-contract.mjs';

const OUTCOMES = new Set(['unaided success', 'assisted success', 'failure', 'not attempted']);
const SEVERITIES = new Set(['S0', 'S1', 'S2', 'S3', 'S4']);
const CRITICAL_TASKS = new Set([3, 4, 5, 7, 8]);
const FINDING_CATEGORY_SET = new Set(FINDING_CATEGORIES);
const AI_EXPERIENCE = new Set(['never', 'occasional', 'monthly', 'weekly', 'daily']);
const INVALID_REASONS = new Set(['withdrawn-consent', 'wrong-or-unusable-build', 'provider-invocation', 'prior-exposure', 'facilitator-deviation']);
const FORBIDDEN_KEYS = /(^|_)(name|email|phone|contact|employer|client|medical|credential|storagePath|storageLocation|participantMapping|rawQuote|recordingPath|observerNames?)$/i;
const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'testOnly', 'participants', 'findings', 'recruitmentDecisionDocumented', 'configuredProviderEvidenceRecorded', 'requiredSignoffsRecorded', 'outstandingNonBlockingActions']);
const PARTICIPANT_KEYS = new Set(['id', 'testOnly', 'valid', 'invalidReasonCategory', 'multiFormatRegular', 'aiExperience', 'keyboardOrAccessibilityCoverage', 'tasks']);
const TASK_KEYS = new Set(['task', 'outcome', 'seconds', 'neutralProbes', 'directAssists', 'wrongTurns', 'repeatedActions', 'errorLoops', 'recoveryAttempts', 'seq', 'acceptedWorkPreserved']);
const FINDING_KEYS = new Set(['id', 'severity', 'participantIds', 'category', 'resolved', 'traceable', 'exceptionApproved', 'exceptionRationaleRecorded', 'blocksExit']);

function ratio(count, denominator) {
  return { count, denominator, percent: denominator === 0 ? null : Number(((count / denominator) * 100).toFixed(1)) };
}

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return { median: null, min: null, max: null, recorded: 0 };
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { median, min: sorted[0], max: sorted.at(-1), recorded: sorted.length };
}

function assertNoPrivateFields(value, path = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoPrivateFields(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key)) throw new Error(`Private-only field is forbidden in synthesis input: ${path}.${key}`);
    assertNoPrivateFields(child, `${path}.${key}`);
  }
}

function assertKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported field(s): ${unexpected.join(', ')}.`);
}

function requireKeys(value, required, label) {
  const missing = required.filter((key) => !(key in value));
  if (missing.length > 0) throw new Error(`${label} is missing required field(s): ${missing.join(', ')}.`);
}

function validate(input) {
  assertNoPrivateFields(input);
  assertKeys(input, TOP_LEVEL_KEYS, 'Synthesis input');
  requireKeys(input, ['schemaVersion', 'participants', 'findings', 'recruitmentDecisionDocumented', 'configuredProviderEvidenceRecorded', 'requiredSignoffsRecorded', 'outstandingNonBlockingActions'], 'Synthesis input');
  if (input.schemaVersion !== 1 || !Array.isArray(input.participants) || !Array.isArray(input.findings)) {
    throw new Error('Synthesis input must use schemaVersion 1 with participants and findings arrays.');
  }
  if (input.participants.length > 99 || new Set(input.participants.map((participant) => participant.id)).size !== input.participants.length) {
    throw new Error('Synthesis input may contain at most 99 uniquely coded participant records.');
  }
  for (const flag of ['recruitmentDecisionDocumented', 'configuredProviderEvidenceRecorded', 'requiredSignoffsRecorded']) {
    if (typeof input[flag] !== 'boolean') throw new Error(`${flag} must be boolean.`);
  }
  if (!Array.isArray(input.outstandingNonBlockingActions) || input.outstandingNonBlockingActions.some((action) => typeof action !== 'string' || !action.trim())) {
    throw new Error('outstandingNonBlockingActions must contain non-empty strings.');
  }
  for (const participant of input.participants) {
    assertKeys(participant, PARTICIPANT_KEYS, `Participant ${participant.id || '(missing)'}`);
    requireKeys(participant, ['id', 'valid', 'invalidReasonCategory', 'multiFormatRegular', 'aiExperience', 'keyboardOrAccessibilityCoverage', 'tasks'], `Participant ${participant.id || '(missing)'}`);
    if (String(participant.id).startsWith('TEST-') && (!input.testOnly || !participant.testOnly)) {
      throw new Error('TEST- records must remain explicitly test-only.');
    }
    if (input.testOnly && !/^TEST-[1-9][0-9]*$/.test(participant.id)) throw new Error(`Invalid test-only participant code: ${participant.id}`);
    if (!input.testOnly && !/^P(?:0[1-9]|[1-9][0-9])$/.test(participant.id)) throw new Error(`Invalid participant code: ${participant.id}`);
    if (typeof participant.valid !== 'boolean' || !AI_EXPERIENCE.has(participant.aiExperience)) {
      throw new Error(`${participant.id} has invalid validity or AI-experience data.`);
    }
    if ((participant.valid && participant.invalidReasonCategory !== null)
      || (!participant.valid && !INVALID_REASONS.has(participant.invalidReasonCategory))) {
      throw new Error(`${participant.id} has an invalid invalid-session reason.`);
    }
    if (!Array.isArray(participant.tasks) || participant.tasks.length !== 8) {
      throw new Error(`${participant.id} must contain exactly eight task records.`);
    }
    const taskIds = participant.tasks.map((task) => task.task);
    if (new Set(taskIds).size !== 8 || taskIds.some((task) => task < 1 || task > 8)) {
      throw new Error(`${participant.id} task records must be numbered 1 through 8 exactly once.`);
    }
    for (const task of participant.tasks) {
      assertKeys(task, TASK_KEYS, `${participant.id} Task ${task.task}`);
      requireKeys(task, ['task', 'outcome', 'seconds', 'neutralProbes', 'directAssists', 'wrongTurns', 'repeatedActions', 'errorLoops', 'recoveryAttempts', 'seq', 'acceptedWorkPreserved'], `${participant.id} Task ${task.task}`);
      if (!OUTCOMES.has(task.outcome)) throw new Error(`${participant.id} Task ${task.task} has an invalid outcome.`);
      if (task.seconds !== null && (!Number.isFinite(task.seconds) || task.seconds < 0)) throw new Error(`${participant.id} Task ${task.task} seconds are invalid.`);
      if (![task.neutralProbes, task.directAssists, task.wrongTurns, task.repeatedActions, task.errorLoops, task.recoveryAttempts]
        .every((value) => Number.isInteger(value) && value >= 0)) {
        throw new Error(`${participant.id} Task ${task.task} observation counts are invalid.`);
      }
      if ((task.outcome === 'unaided success' && task.directAssists !== 0)
        || (task.outcome === 'assisted success' && task.directAssists < 1)) {
        throw new Error(`${participant.id} Task ${task.task} outcome conflicts with its direct-assist count.`);
      }
      if (task.acceptedWorkPreserved !== null && typeof task.acceptedWorkPreserved !== 'boolean') {
        throw new Error(`${participant.id} Task ${task.task} acceptedWorkPreserved must be boolean or null.`);
      }
      if (task.task !== 8 && task.acceptedWorkPreserved !== null) {
        throw new Error(`${participant.id} may record accepted-work preservation only for Task 8.`);
      }
      if (task.seq !== null && (!Number.isInteger(task.seq) || task.seq < 1 || task.seq > 7)) {
        throw new Error(`${participant.id} Task ${task.task} SEQ must be 1 through 7 or null.`);
      }
    }
  }
  if (new Set(input.findings.map((finding) => finding.id)).size !== input.findings.length) {
    throw new Error('Finding IDs must be unique.');
  }
  for (const finding of input.findings) {
    assertKeys(finding, FINDING_KEYS, `Finding ${finding.id || '(missing)'}`);
    requireKeys(finding, [
      'id', 'severity', 'participantIds', 'category', 'resolved', 'traceable',
      'blocksExit', 'exceptionApproved', 'exceptionRationaleRecorded',
    ], `Finding ${finding.id || '(missing)'}`);
    if (!SEVERITIES.has(finding.severity) || !finding.id || !Array.isArray(finding.participantIds)) {
      throw new Error('Every finding needs an ID, S0-S4 severity, and participantIds.');
    }
    if ((input.testOnly && !/^TEST-F[0-9A-Z-]*$/.test(finding.id))
      || (!input.testOnly && !/^CB-[1-9][0-9]*$/.test(finding.id))) {
      throw new Error(`Finding ID is invalid: ${finding.id}`);
    }
    if (!FINDING_CATEGORY_SET.has(finding.category)) {
      throw new Error(`Finding category is invalid: ${finding.category}`);
    }
    if (![finding.resolved, finding.traceable, finding.blocksExit, finding.exceptionApproved, finding.exceptionRationaleRecorded]
      .every((value) => typeof value === 'boolean')) {
      throw new Error(`Finding handoff fields must be boolean: ${finding.id}`);
    }
    if (finding.resolved && finding.blocksExit) {
      throw new Error(`Resolved finding ${finding.id} cannot keep blocksExit=true.`);
    }
    if (!finding.exceptionApproved && finding.exceptionRationaleRecorded) {
      throw new Error(`Finding ${finding.id} cannot record an exception rationale without an approved exception.`);
    }
    if (finding.severity !== 'S1' && (finding.exceptionApproved || finding.exceptionRationaleRecorded)) {
      throw new Error(`Only S1 findings may record an exception decision: ${finding.id}`);
    }
    if (finding.participantIds.length === 0) throw new Error(`Finding ${finding.id} must reference at least one participant.`);
    if (typeof finding.resolved !== 'boolean' || typeof finding.traceable !== 'boolean'
      || finding.participantIds.some((id) => !input.participants.some((participant) => participant.id === id))) {
      throw new Error(`Finding ${finding.id} has invalid traceability or participant references.`);
    }
    if (new Set(finding.participantIds).size !== finding.participantIds.length) {
      throw new Error(`Finding ${finding.id} contains duplicate participant references.`);
    }
  }
}

export function calculateStudySynthesis(input) {
  validate(input);
  const valid = input.participants.filter((participant) => participant.valid);
  const warnings = [];
  const tasks = Array.from({ length: 8 }, (_, index) => {
    const task = index + 1;
    const rows = valid.map((participant) => participant.tasks.find((record) => record.task === task));
    const unaided = rows.filter((row) => row.outcome === 'unaided success').length;
    const assisted = rows.filter((row) => row.outcome === 'assisted success').length;
    const failedOrNotAttempted = rows.filter((row) => row.outcome === 'failure' || row.outcome === 'not attempted').length;
    const seconds = distribution(rows.map((row) => row.seconds));
    const seq = distribution(rows.map((row) => row.seq));
    if (seconds.recorded !== rows.length) warnings.push(`Task ${task} is missing seconds for ${rows.length - seconds.recorded} valid session(s).`);
    if (seq.recorded !== rows.length) warnings.push(`Task ${task} is missing SEQ for ${rows.length - seq.recorded} valid session(s).`);
    const criticalSuccess = rows.filter((row) =>
      ['unaided success', 'assisted success'].includes(row.outcome) && row.directAssists <= 1).length;
    return {
      task,
      critical: CRITICAL_TASKS.has(task),
      unaided: ratio(unaided, rows.length),
      assisted,
      failedOrNotAttempted,
      criticalAtMostOneAssist: ratio(criticalSuccess, rows.length),
      seconds,
      seq,
    };
  });

  const fullUnaided = valid.filter((participant) => participant.tasks.every((task) => task.outcome === 'unaided success')).length;
  const fullCompleted = valid.filter((participant) => participant.tasks.every((task) =>
    task.outcome === 'unaided success' || task.outcome === 'assisted success')).length;
  const cohort = {
    multiFormatRegular: valid.filter((participant) => participant.multiFormatRegular).length,
    aiWeekly: valid.filter((participant) => participant.aiExperience === 'weekly').length,
    aiOccasionalOrNonUser: valid.filter((participant) => ['occasional', 'never'].includes(participant.aiExperience)).length,
    keyboardOrAccessibilityCoverage: valid.filter((participant) => participant.keyboardOrAccessibilityCoverage).length,
  };
  const persistenceRows = valid.map((participant) => participant.tasks.find((task) => task.task === 8));
  const persistencePreserved = persistenceRows.filter((task) => task.acceptedWorkPreserved === true).length;
  if (persistenceRows.some((task) => task.acceptedWorkPreserved === null)) {
    warnings.push('Task 8 accepted-work preservation is missing for one or more valid sessions.');
  }
  const participantBurden = valid.map((participant) => ({
    participantId: participant.id,
    neutralProbes: participant.tasks.reduce((sum, task) => sum + task.neutralProbes, 0),
    directAssists: participant.tasks.reduce((sum, task) => sum + task.directAssists, 0),
    wrongTurns: participant.tasks.reduce((sum, task) => sum + task.wrongTurns, 0),
    repeatedActions: participant.tasks.reduce((sum, task) => sum + task.repeatedActions, 0),
    errorLoops: participant.tasks.reduce((sum, task) => sum + task.errorLoops, 0),
    recoveryAttempts: participant.tasks.reduce((sum, task) => sum + task.recoveryAttempts, 0),
  }));

  const thresholdChecks = {
    fullJourneyUnaided75: valid.length > 0 && (fullUnaided / valid.length) >= 0.75,
    criticalTasks85: tasks.filter((task) => task.critical).every((task) => (task.criticalAtMostOneAssist.percent ?? 0) >= 85),
    criticalMedianSeq5: tasks.filter((task) => task.critical).every((task) => (task.seq.median ?? 0) >= 5),
    acceptedWorkAndReopen100: valid.length > 0 && persistencePreserved === valid.length,
  };
  const blockerFindings = input.findings.filter((finding) => {
    if (finding.resolved) return false;
    if (finding.blocksExit) return true;
    if (finding.severity === 'S0') return true;
    if (finding.severity !== 'S1') return false;
    return isIntegrityBlockingFindingCategory(finding.category) || finding.participantIds.length >= 2
      || !finding.exceptionApproved || !finding.exceptionRationaleRecorded;
  });
  const traceabilityComplete = input.findings.every((finding) => finding.traceable);
  const cohortComplete = cohort.multiFormatRegular >= 4 && cohort.aiWeekly >= 2 && cohort.aiOccasionalOrNonUser >= 2;
  const accessibilityComplete = cohort.keyboardOrAccessibilityCoverage >= 1 || input.recruitmentDecisionDocumented;
  if (valid.length < 6) warnings.push(`Only ${valid.length} valid session(s); at least six real sessions are required.`);
  if (valid.length > 8) warnings.push(`${valid.length} valid sessions exceed the approved cohort maximum of eight.`);
  if (!traceabilityComplete) warnings.push('One or more findings are not traceable to de-identified session evidence.');
  if (!cohortComplete && !input.recruitmentDecisionDocumented) warnings.push('Required multi-format and AI-experience cohort mix is incomplete without a documented recruitment decision.');
  if (!accessibilityComplete) warnings.push('Keyboard/accessibility coverage is missing without a documented recruitment decision.');
  if (!input.configuredProviderEvidenceRecorded) warnings.push('Separate configured-provider evidence is not recorded.');
  if (!input.requiredSignoffsRecorded) warnings.push('Required Product, Design, Engineering, and Accessibility sign-offs are not recorded.');
  const evidenceSufficient = warnings.length === 0;
  const thresholdsMet = Object.values(thresholdChecks).every(Boolean);

  let recommendation;
  if (!evidenceSufficient) recommendation = 'insufficient evidence';
  else if (!thresholdsMet || blockerFindings.length > 0) recommendation = 'block';
  else if (input.outstandingNonBlockingActions?.length > 0) recommendation = 'conditional';
  else recommendation = 'pass';

  return {
    schemaVersion: 1,
    recruitedSessions: input.participants.length,
    validSessions: valid.length,
    invalidSessions: input.participants.length - valid.length,
    fullJourney: { unaided: ratio(fullUnaided, valid.length), assistedOrUnaided: ratio(fullCompleted, valid.length) },
    tasks,
    participantBurden,
    cohort,
    preservationAndReopen: ratio(persistencePreserved, valid.length),
    severityCounts: Object.fromEntries([...SEVERITIES].map((severity) => [severity, input.findings.filter((finding) => finding.severity === severity).length])),
    findings: input.findings.map((finding) => ({
      id: finding.id,
      participantIds: [...finding.participantIds],
      severity: finding.severity,
      category: finding.category,
      integrityBlocker: isIntegrityBlockingFindingCategory(finding.category),
      frequency: new Set(finding.participantIds).size,
      resolved: finding.resolved,
      traceable: finding.traceable,
      declaredBlocksExit: finding.blocksExit,
      exceptionApproved: finding.exceptionApproved,
      exceptionRationaleRecorded: finding.exceptionRationaleRecorded,
      blocksExit: blockerFindings.includes(finding),
    })),
    blockerFindingIds: blockerFindings.map((finding) => finding.id),
    thresholds: { ...thresholdChecks, met: thresholdsMet },
    warnings,
    recommendation,
    milestoneMayClose: recommendation === 'pass',
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0 || !args[index + 1]) throw new Error(`${flag} requires a value`);
  return args[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const inputPath = valueAfter(process.argv.slice(2), '--input');
    const result = calculateStudySynthesis(JSON.parse(readFileSync(inputPath, 'utf8')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(`[creator-study-synthesis] ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
