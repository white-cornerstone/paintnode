export type WorkflowCandidateNavigationKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export function nextWorkflowCandidateIndex(
  key: WorkflowCandidateNavigationKey,
  currentIndex: number,
  candidateCount: number,
): number | null {
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 1) return null;
  const current = Number.isSafeInteger(currentIndex)
    ? Math.min(candidateCount - 1, Math.max(0, currentIndex))
    : 0;
  if (key === 'Home') return 0;
  if (key === 'End') return candidateCount - 1;
  return (current + (key === 'ArrowLeft' ? -1 : 1) + candidateCount) % candidateCount;
}
