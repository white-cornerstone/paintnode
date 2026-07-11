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
]);

export const RECRUITMENT_EXCEPTION_DEFINITIONS = Object.freeze([
  { id: 'cohortMix', requirement: 'Required multi-format and AI-experience cohort mix' },
  { id: 'keyboardOrAccessibilityCoverage', requirement: 'Keyboard/accessibility cohort coverage' },
]);

export const RECRUITMENT_EXCEPTION_IDS = Object.freeze(
  RECRUITMENT_EXCEPTION_DEFINITIONS.map(({ id }) => id),
);
