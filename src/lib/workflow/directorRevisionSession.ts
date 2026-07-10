import type { WorkflowDirectorSessionToken } from './directorProposalSession';
import type {
  WorkflowDirectorPatchIssue,
  WorkflowDirectorPatchOperation,
  WorkflowDirectorPatchProposal,
  WorkflowDirectorPatchProposalResult,
} from './directorPatch';
import type { WorkflowGraphRevision } from './domain';
import type { WorkflowGraphV2 } from './schema';

export interface WorkflowDirectorRevisionRequest {
  readonly instruction: string;
  readonly graph: WorkflowGraphV2;
  readonly sourceGraphRevision: WorkflowGraphRevision;
  readonly session: WorkflowDirectorSessionToken;
}

export interface WorkflowDirectorRevisionRequester {
  readonly label: string;
  readonly providerFree: true;
  request(request: WorkflowDirectorRevisionRequest, signal?: AbortSignal): Promise<unknown>;
}

export interface WorkflowDirectorRevisionTarget {
  readonly pendingDirectorPatchProposal: WorkflowDirectorPatchProposal | null;
  readonly canUndoDirectorPatch: boolean;
  readonly canRedoDirectorPatch: boolean;
  captureDirectorSession(): WorkflowDirectorSessionToken;
  graphSnapshot(): WorkflowGraphV2;
  createDirectorPatchProposal(response: unknown): WorkflowDirectorPatchProposalResult;
  rejectDirectorPatchProposal(): void;
  acceptDirectorPatchProposal(): WorkflowDirectorPatchProposal;
  undoDirectorPatch(): boolean;
  redoDirectorPatch(): boolean;
}

export interface WorkflowDirectorRevisionPreview {
  readonly instruction: string;
  readonly session: WorkflowDirectorSessionToken;
  readonly result: WorkflowDirectorPatchProposalResult;
}

export interface WorkflowDirectorRevisionOperationView {
  readonly index: number;
  readonly kind: WorkflowDirectorPatchOperation['op'];
  readonly label: string;
  readonly detail: string;
}

export interface WorkflowDirectorRevisionViewModel {
  readonly canAccept: boolean;
  readonly summary: string;
  readonly operations: readonly WorkflowDirectorRevisionOperationView[];
  readonly nodeChanges: WorkflowDirectorPatchProposal['nodeChanges'];
  readonly connectionChanges: WorkflowDirectorPatchProposal['edgeChanges'];
  readonly requirementChanges: WorkflowDirectorPatchProposal['requirementChanges'];
  readonly downstreamStaleness: WorkflowDirectorPatchProposal['downstreamStaleness'];
  readonly validationIssues: readonly WorkflowDirectorPatchIssue[];
}

export class WorkflowDirectorRevisionCancelledError extends Error {
  constructor() {
    super('The provider-free Director revision request was cancelled.');
    this.name = 'WorkflowDirectorRevisionCancelledError';
  }
}

function sameSession(
  left: WorkflowDirectorSessionToken,
  right: WorkflowDirectorSessionToken,
): boolean {
  return left.sessionIdentity === right.sessionIdentity
    && left.mutationIdentity === right.mutationIdentity
    && left.graphRevision === right.graphRevision
    && left.storeRevision === right.storeRevision;
}

function awaitRevisionResponse(
  operation: Promise<unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(new WorkflowDirectorRevisionCancelledError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      complete();
    };
    const onAbort = (): void => finish(() => reject(new WorkflowDirectorRevisionCancelledError()));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (response) => finish(() => resolve(response)),
      (error) => finish(() => reject(error)),
    );
  });
}

function operationView(
  operation: WorkflowDirectorPatchOperation,
  index: number,
): WorkflowDirectorRevisionOperationView {
  if (operation.op === 'add-node') {
    return {
      index: index + 1,
      kind: operation.op,
      label: 'Add node',
      detail: `${operation.node.title ?? operation.node.id} (${operation.node.type})`,
    };
  }
  if (operation.op === 'remove-node') {
    return { index: index + 1, kind: operation.op, label: 'Remove node', detail: operation.nodeId };
  }
  if (operation.op === 'configure-node') {
    return {
      index: index + 1,
      kind: operation.op,
      label: 'Configure node',
      detail: `${operation.nodeId}: ${Object.keys(operation.changes).sort().join(', ')}`,
    };
  }
  if (operation.op === 'move-node') {
    return {
      index: index + 1,
      kind: operation.op,
      label: 'Move node',
      detail: `${operation.nodeId} to ${operation.position.x}, ${operation.position.y}`,
    };
  }
  if (operation.op === 'add-edge') {
    return {
      index: index + 1,
      kind: operation.op,
      label: 'Add connection',
      detail: `${operation.edge.source.nodeId}.${operation.edge.source.portId} → ${operation.edge.target.nodeId}.${operation.edge.target.portId}`,
    };
  }
  return { index: index + 1, kind: operation.op, label: 'Remove connection', detail: operation.edgeId };
}

export async function requestWorkflowDirectorRevisionPreview(
  requester: WorkflowDirectorRevisionRequester,
  target: WorkflowDirectorRevisionTarget,
  instruction: string,
  signal?: AbortSignal,
): Promise<WorkflowDirectorRevisionPreview> {
  const normalizedInstruction = instruction.trim();
  if (!normalizedInstruction) throw new Error('Describe the revision before requesting a patch.');
  if (normalizedInstruction.length > 1_000) {
    throw new Error('Director revision instructions must be 1,000 characters or fewer.');
  }
  if (!requester.providerFree) throw new Error('This checkpoint accepts only an injected provider-free revision requester.');
  if (signal?.aborted) throw new WorkflowDirectorRevisionCancelledError();
  const session = target.captureDirectorSession();
  const graph = target.graphSnapshot();
  const request: WorkflowDirectorRevisionRequest = Object.freeze({
    instruction: normalizedInstruction,
    graph,
    sourceGraphRevision: Object.freeze({ graphId: graph.id, revision: session.graphRevision }),
    session,
  });
  let operation: Promise<unknown>;
  try {
    operation = Promise.resolve(requester.request(request, signal));
  } catch (error) {
    operation = Promise.reject(error);
  }
  const response = await awaitRevisionResponse(operation, signal);
  if (signal?.aborted) throw new WorkflowDirectorRevisionCancelledError();
  if (!sameSession(session, target.captureDirectorSession())) {
    throw new Error('The workflow changed while the Director revision was being prepared. Request the revision again.');
  }
  const result = target.createDirectorPatchProposal(response);
  return Object.freeze({ instruction: normalizedInstruction, session, result });
}

export function rejectWorkflowDirectorRevisionPreview(
  preview: WorkflowDirectorRevisionPreview,
  target: WorkflowDirectorRevisionTarget,
): boolean {
  if (!preview.result.proposal || target.pendingDirectorPatchProposal !== preview.result.proposal) return false;
  target.rejectDirectorPatchProposal();
  return true;
}

export function acceptWorkflowDirectorRevisionPreview(
  preview: WorkflowDirectorRevisionPreview,
  target: WorkflowDirectorRevisionTarget,
  currentInstruction: string = preview.instruction,
): WorkflowDirectorPatchProposal {
  if (currentInstruction.trim() !== preview.instruction) {
    if (preview.result.proposal && target.pendingDirectorPatchProposal === preview.result.proposal) {
      target.rejectDirectorPatchProposal();
    }
    throw new Error('The Director revision instruction changed after this preview. Request the revision again.');
  }
  if (!preview.result.proposal || target.pendingDirectorPatchProposal !== preview.result.proposal) {
    throw new Error('This Director revision preview is stale. Request a new revision before accepting.');
  }
  return target.acceptDirectorPatchProposal();
}

export function createWorkflowDirectorRevisionViewModel(
  result: WorkflowDirectorPatchProposalResult,
): WorkflowDirectorRevisionViewModel {
  const proposal = result.proposal;
  return Object.freeze({
    canAccept: proposal !== null,
    summary: proposal?.patch.summary ?? 'The revision response did not pass validation.',
    operations: Object.freeze(proposal?.patch.operations.map(operationView) ?? []),
    nodeChanges: proposal?.nodeChanges ?? Object.freeze([]),
    connectionChanges: proposal?.edgeChanges ?? Object.freeze([]),
    requirementChanges: proposal?.requirementChanges ?? Object.freeze([]),
    downstreamStaleness: proposal?.downstreamStaleness ?? Object.freeze([]),
    validationIssues: result.issues,
  });
}
