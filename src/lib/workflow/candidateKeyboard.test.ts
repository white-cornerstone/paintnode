import { describe, expect, it } from 'vitest';
import { nextWorkflowCandidateIndex } from './candidateKeyboard';

describe('Campaign candidate keyboard navigation', () => {
  it('supports roving arrows with wraparound and first/last shortcuts', () => {
    expect(nextWorkflowCandidateIndex('ArrowRight', 0, 3)).toBe(1);
    expect(nextWorkflowCandidateIndex('ArrowRight', 2, 3)).toBe(0);
    expect(nextWorkflowCandidateIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(nextWorkflowCandidateIndex('Home', 2, 3)).toBe(0);
    expect(nextWorkflowCandidateIndex('End', 0, 3)).toBe(2);
  });

  it('does nothing without candidates and clamps a stale selection', () => {
    expect(nextWorkflowCandidateIndex('ArrowRight', 0, 0)).toBeNull();
    expect(nextWorkflowCandidateIndex('ArrowLeft', 99, 3)).toBe(1);
  });
});
