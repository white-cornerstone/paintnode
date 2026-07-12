import type { WorkflowDirectorRevisionTarget } from './directorRevisionSession';

export function createWorkflowDirectorRevisionHistoryState(
  target: WorkflowDirectorRevisionTarget,
) {
  let mutationIdentity = -1;
  let canUndo = false;
  let canRedo = false;
  const sync = (): void => {
    const currentMutationIdentity = target.captureDirectorSession().mutationIdentity;
    if (currentMutationIdentity === mutationIdentity) return;
    mutationIdentity = currentMutationIdentity;
    canUndo = target.canUndoDirectorPatch;
    canRedo = target.canRedoDirectorPatch;
  };
  return {
    get canUndo(): boolean { sync(); return canUndo; },
    get canRedo(): boolean { sync(); return canRedo; },
  };
}
