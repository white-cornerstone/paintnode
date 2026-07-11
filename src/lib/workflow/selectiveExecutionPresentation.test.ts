import { describe, expect, it } from 'vitest';
import type { WorkflowNodePreflight, WorkflowSelectiveExecutionOutcome } from './selectiveExecution';
import {
  selectiveExecutionOutcomeSummary,
  selectiveExecutionPreviewSummary,
  selectiveExecutionRunAvailability,
} from './selectiveExecutionPresentation';

function entry(
  nodeId: string,
  state: WorkflowNodePreflight['state'],
  message: string,
): WorkflowNodePreflight {
  return {
    nodeId,
    state,
    willExecute: state === 'planned' || state === 'stale',
    reason: { code: state === 'blocked' ? 'UPSTREAM_BLOCKED' : 'CONTEXT_SATISFIED', message },
  };
}

describe('selective execution presentation', () => {
  it('summarizes every preflight state and exposes the first blocked reason', () => {
    const preflight = [
      entry('planned', 'planned', 'Will run.'),
      entry('cached', 'cached', 'Will reuse.'),
      entry('blocked', 'blocked', 'Required Product input is missing.'),
      entry('stale', 'stale', 'Material changed.'),
    ];

    expect(selectiveExecutionPreviewSummary(preflight)).toBe('Planned 1 · Cached 1 · Blocked 1 · Stale 1');
    expect(selectiveExecutionRunAvailability(preflight)).toEqual({
      enabled: false,
      reason: 'Required Product input is missing.',
    });
  });

  it('allows a cached-only preview to be explicitly confirmed', () => {
    expect(selectiveExecutionRunAvailability([
      entry('cached', 'cached', 'Verified cached result.'),
    ])).toEqual({ enabled: true, reason: 'Preview is ready to run.' });
  });

  it('keeps executed, cached, blocked, cancelled, and failed outcomes distinct', () => {
    const outcome: WorkflowSelectiveExecutionOutcome = {
      executedNodeIds: ['generate-square', 'generate-banner'],
      cachedNodeIds: ['generate-portrait'],
      results: {},
      failures: {
        'generate-story': { code: 'EXECUTOR_FAILED', message: 'Safe failure.' },
      },
      blockedNodeIds: ['output-story'],
      cancelledNodeIds: ['generate-social'],
    };

    expect(selectiveExecutionOutcomeSummary(outcome)).toBe(
      'Executed 2 · Cached 1 · Blocked 1 · Cancelled 1 · Failed 1',
    );
  });
});
