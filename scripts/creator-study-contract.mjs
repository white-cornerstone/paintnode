import { createHash } from 'node:crypto';

export const FINDING_CATEGORY_DEFINITIONS = Object.freeze([
  { id: 'privacy', integrityBlocker: true },
  { id: 'data-integrity', integrityBlocker: true },
  { id: 'wrong-lineage', integrityBlocker: true },
  { id: 'accepted-direction', integrityBlocker: true },
  { id: 'editor-return', integrityBlocker: true },
  { id: 'save-reopen', integrityBlocker: true },
  { id: 'keyboard-accessibility', integrityBlocker: true },
  { id: 'provider-invocation', integrityBlocker: true },
  { id: 'critical-task-impossible', integrityBlocker: true },
  { id: 'required-input-comprehension', integrityBlocker: false },
  { id: 'copy-clarity', integrityBlocker: false },
  { id: 'navigation-discovery', integrityBlocker: false },
  { id: 'recovery-clarity', integrityBlocker: false },
  { id: 'repeated-error-burden', integrityBlocker: false },
  { id: 'performance', integrityBlocker: false },
]);

export const FINDING_CATEGORIES = Object.freeze(FINDING_CATEGORY_DEFINITIONS.map(({ id }) => id));
export const INTEGRITY_BLOCKING_FINDING_CATEGORIES = new Set(
  FINDING_CATEGORY_DEFINITIONS.filter(({ integrityBlocker }) => integrityBlocker).map(({ id }) => id),
);

export function isIntegrityBlockingFindingCategory(category) {
  return INTEGRITY_BLOCKING_FINDING_CATEGORIES.has(category);
}

export const FACILITATOR_ASSIST_EVENT_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'neutral-probe', assistIncrement: 0, forcesTaskFailure: false }),
  Object.freeze({ id: 'standard-hint', assistIncrement: 1, forcesTaskFailure: false }),
  Object.freeze({ id: 'verbatim-repeat', assistIncrement: 0, forcesTaskFailure: false }),
  Object.freeze({ id: 'takeover', assistIncrement: 1, forcesTaskFailure: true }),
  Object.freeze({ id: 'unscripted-assist', assistIncrement: 1, forcesTaskFailure: false }),
]);

export const FACILITATOR_ASSIST_EVENT_IDS = Object.freeze(
  FACILITATOR_ASSIST_EVENT_DEFINITIONS.map(({ id }) => id),
);

export const FACILITATOR_DEVIATION_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'none', sessionValidity: 'valid' }),
  Object.freeze({ id: 'late-timing', sessionValidity: 'valid' }),
  Object.freeze({ id: 'verbatim-repeat', sessionValidity: 'valid' }),
  Object.freeze({ id: 'approved-accommodation', sessionValidity: 'valid' }),
  Object.freeze({ id: 'early-hint', sessionValidity: 'invalid' }),
  Object.freeze({ id: 'out-of-order-hint', sessionValidity: 'invalid' }),
  Object.freeze({ id: 'wording-changed', sessionValidity: 'invalid' }),
  Object.freeze({ id: 'unlogged-assist', sessionValidity: 'invalid' }),
  Object.freeze({ id: 'silent-app-state-change', sessionValidity: 'invalid' }),
  Object.freeze({ id: 'unauthorized-takeover', sessionValidity: 'invalid' }),
  Object.freeze({ id: 'calibration-missing', sessionValidity: 'invalid' }),
  Object.freeze({ id: 'instrument-version-mismatch', sessionValidity: 'invalid' }),
  Object.freeze({ id: 'instrument-hash-mismatch', sessionValidity: 'invalid' }),
  Object.freeze({ id: 'instrument-change-unapproved', sessionValidity: 'invalid' }),
]);

export const RECRUITMENT_EXCEPTION_DEFINITIONS = Object.freeze([
  { id: 'cohortMix', requirement: 'Required multi-format and AI-experience cohort mix' },
  { id: 'keyboardOrAccessibilityCoverage', requirement: 'Keyboard/accessibility cohort coverage' },
]);

export const RECRUITMENT_EXCEPTION_IDS = Object.freeze(
  RECRUITMENT_EXCEPTION_DEFINITIONS.map(({ id }) => id),
);

export function nextFacilitatorIntervention({
  instrument,
  taskNumber,
  completedCheckpointIds,
  previousIntervention,
}) {
  const task = instrument?.tasks?.find(({ task: candidate }) => candidate === taskNumber);
  if (!task) throw new Error(`Unknown facilitator task: ${taskNumber}`);
  const completed = new Set(completedCheckpointIds ?? []);
  const checkpoint = task.checkpoints.find(({ id }) => !completed.has(id));
  if (!checkpoint) return null;

  const sameCheckpoint = previousIntervention?.checkpointId === checkpoint.id;
  if (!sameCheckpoint) {
    return Object.freeze({
      type: 'standard-hint',
      checkpointId: checkpoint.id,
      interventionId: `${checkpoint.id}-H1`,
      hintLevel: 'first',
      exactText: checkpoint.firstHint,
    });
  }
  if (previousIntervention.type === 'standard-hint' && previousIntervention.hintLevel === 'first') {
    return Object.freeze({
      type: 'standard-hint',
      checkpointId: checkpoint.id,
      interventionId: `${checkpoint.id}-H2`,
      hintLevel: 'second',
      exactText: checkpoint.secondHint,
    });
  }
  if (previousIntervention.type === 'standard-hint' && previousIntervention.hintLevel === 'second') {
    const takeover = instrument.takeoverActions?.find(({ checkpointId }) => checkpointId === checkpoint.id);
    if (!takeover) throw new Error(`Missing takeover action for ${checkpoint.id}`);
    return Object.freeze({
      type: 'takeover',
      checkpointId: checkpoint.id,
      interventionId: takeover.id,
      hintLevel: null,
      exactText: takeover.exactAction,
    });
  }
  return null;
}

export function assertFacilitatorCalibration({
  instrumentBytes,
  pinnedSha256,
  instrumentVersion,
  approvedGitChangeReference,
  signoff,
}) {
  const actualSha256 = createHash('sha256').update(instrumentBytes).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(pinnedSha256 ?? '') || actualSha256 !== pinnedSha256) {
    throw new Error('Facilitator instrument SHA-256 does not match the committed pin.');
  }
  if (signoff?.instrumentVersion !== instrumentVersion) {
    throw new Error('Facilitator calibration instrument version does not match.');
  }
  if (signoff.instrumentSha256 !== pinnedSha256) {
    throw new Error('Facilitator calibration instrument SHA-256 does not match.');
  }
  if (!approvedGitChangeReference
    || signoff.approvedGitChangeReference !== approvedGitChangeReference) {
    throw new Error('Facilitator calibration approved Git change reference does not match.');
  }
  if (signoff.calibrationCompleted !== true) {
    throw new Error('Facilitator calibration and rehearsal is incomplete.');
  }
  return Object.freeze({
    instrumentVersion,
    instrumentSha256: actualSha256,
    approvedGitChangeReference,
    calibrationCompleted: true,
  });
}
