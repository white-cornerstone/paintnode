import { describe, expect, it, vi } from 'vitest';
import {
  WorkflowReviewRefreshGate,
  createWorkflowReviewRefreshIdentity,
} from './boardRunContext';

function identity(overrides: Record<string, unknown> = {}) {
  return createWorkflowReviewRefreshIdentity({
    workflowId: 'workflow-one',
    workflowRevision: 12,
    projectIdentity: 'project:one',
    executionOptionsIdentity: JSON.stringify({
      provider: 'codex',
      qaMode: null,
      qaScenario: 'success',
      options: { model: 'gpt-image-1', effort: 'medium' },
      keepAiDebugArtifacts: false,
    }),
    assetIdentity: [['asset-1', 'assets/one.png', true]],
    ...overrides,
  });
}

describe('Board Review verification refresh gate', () => {
  it('schedules exactly once per model/run-options or provider-free QA scenario identity', () => {
    const gate = new WorkflowReviewRefreshGate();
    const refreshAndEvict = vi.fn();
    const refresh = (contextIdentity: string) => {
      if (gate.shouldRefresh(contextIdentity)) refreshAndEvict();
    };
    const initial = identity();
    refresh(initial);
    refresh(initial);
    expect(refreshAndEvict).toHaveBeenCalledTimes(1);

    const modelChanged = identity({
      executionOptionsIdentity: JSON.stringify({
        provider: 'codex', qaMode: null, qaScenario: 'success',
        options: { model: 'gpt-image-2', effort: 'high' }, keepAiDebugArtifacts: false,
      }),
    });
    refresh(modelChanged);
    refresh(modelChanged);
    expect(refreshAndEvict).toHaveBeenCalledTimes(2);

    const qaScenarioChanged = identity({
      executionOptionsIdentity: JSON.stringify({
        provider: 'qa-fake', qaMode: 'provider-free', qaScenario: 'branch-one-failure',
        options: {}, keepAiDebugArtifacts: false,
      }),
    });
    refresh(qaScenarioChanged);
    refresh(qaScenarioChanged);
    expect(refreshAndEvict).toHaveBeenCalledTimes(3);
  });

  it('does not refresh again when transient Review verification state writes without context changes', () => {
    const gate = new WorkflowReviewRefreshGate();
    const context = identity();
    expect(gate.shouldRefresh(context)).toBe(true);
    // reviewVerifications is intentionally not part of the material/context identity.
    expect(gate.shouldRefresh(context)).toBe(false);
  });
});
