import type {
  WorkflowNodePreflight,
  WorkflowSelectiveExecutionOutcome,
} from './selectiveExecution';

export interface WorkflowSelectiveRunAvailability {
  enabled: boolean;
  reason: string;
}

export function selectiveExecutionPreviewSummary(
  preflight: readonly Readonly<WorkflowNodePreflight>[],
): string {
  const count = (state: WorkflowNodePreflight['state']) => preflight.filter((entry) => entry.state === state).length;
  return [
    `Planned ${count('planned')}`,
    `Cached ${count('cached')}`,
    `Blocked ${count('blocked')}`,
    `Stale ${count('stale')}`,
  ].join(' · ');
}

export function selectiveExecutionRunAvailability(
  preflight: readonly Readonly<WorkflowNodePreflight>[],
): WorkflowSelectiveRunAvailability {
  const blocked = preflight.find((entry) => entry.state === 'blocked');
  if (blocked) return { enabled: false, reason: blocked.reason.message };
  if (preflight.length === 0) {
    return { enabled: false, reason: 'No workflow nodes are available for this selective run.' };
  }
  return { enabled: true, reason: 'Preview is ready to run.' };
}

export function selectiveExecutionOutcomeSummary(
  outcome: Readonly<WorkflowSelectiveExecutionOutcome>,
): string {
  return [
    `Executed ${outcome.executedNodeIds.length}`,
    `Cached ${outcome.cachedNodeIds.length}`,
    `Blocked ${outcome.blockedNodeIds.length}`,
    `Cancelled ${outcome.cancelledNodeIds.length}`,
    `Failed ${Object.keys(outcome.failures).length}`,
  ].join(' · ');
}
