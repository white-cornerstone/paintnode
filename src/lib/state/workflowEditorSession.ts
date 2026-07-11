import type { WorkflowEditableResultIdentity } from '../workflow/editorRoundTrip';
import type { WorkflowEditorRevisionSourceV1 } from '../workflow/schema';

const workflowRoundTripBrand: unique symbol = Symbol('paintnode.workflowRoundTripAuthority');

export interface WorkflowRoundTripAuthorityInput {
  id: string;
  workflowId: string;
  workflowSavedPath: string | null;
  projectIdentity: string;
  sessionIdentity: number;
  mutationIdentity: number;
  storeRevision: number;
  graphRevision: number;
  materialKey: string;
  identity: WorkflowEditableResultIdentity;
  source: WorkflowEditorRevisionSourceV1;
  candidate?: { branchGroupId: string; candidateId: string };
  promotion?: { reviewNodeId: string; promotionId: string };
}

export type WorkflowRoundTripAuthority = Readonly<WorkflowRoundTripAuthorityInput> & {
  readonly [workflowRoundTripBrand]: true;
};

const authorities = new Map<object, WorkflowRoundTripAuthority>();

export function bindWorkflowRoundTripAuthority(session: object, input: WorkflowRoundTripAuthorityInput): void {
  authorities.set(session, Object.freeze({
    ...structuredClone(input),
    [workflowRoundTripBrand]: true as const,
  }));
}

export function workflowRoundTripAuthority(session: object): WorkflowRoundTripAuthority | null {
  return authorities.get(session) ?? null;
}

export function clearWorkflowRoundTripAuthority(session: object): void {
  authorities.delete(session);
}

export function workflowRoundTripSessionsForWorkflow(workflowId: string): object[] {
  return [...authorities.entries()]
    .filter(([, authority]) => authority.workflowId === workflowId)
    .map(([session]) => session);
}

export function hasWorkflowRoundTripSessions(): boolean {
  return authorities.size > 0;
}
