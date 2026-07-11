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
