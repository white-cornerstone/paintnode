import type { WorkflowEditableResultIdentity } from '../workflow/editorRoundTrip';
import type { WorkflowEditorRevisionSourceV1 } from '../workflow/schema';

const workflowRoundTripBrand: unique symbol = Symbol('paintnode.workflowRoundTripAuthority');
const workflowRoundTripSessionCapability: unique symbol = Symbol('paintnode.workflowRoundTripSessionCapability');

export interface WorkflowRoundTripAuthorityInput {
  id: string;
  workflowId: string;
  workflowSavedPath: string | null;
  projectIdentity: string;
  sessionIdentity: number;
  mutationIdentity: number;
  storeRevision: number;
  graphRevision: number;
  contextKey: string;
  materialKey: string;
  identity: WorkflowEditableResultIdentity;
  source: WorkflowEditorRevisionSourceV1;
  candidate?: { branchGroupId: string; candidateId: string };
  promotion?: { reviewNodeId: string; promotionId: string };
}

export type WorkflowRoundTripAuthority = Readonly<WorkflowRoundTripAuthorityInput> & {
  readonly [workflowRoundTripBrand]: true;
};

type CapableSession = object & { readonly [workflowRoundTripSessionCapability]?: object };

class WorkflowRoundTripSessionCapability {}

interface AuthorityEntry {
  authority: WorkflowRoundTripAuthority;
  documentAnchor: object;
}

const authorities = new Map<object, AuthorityEntry>();

function sessionDocumentAnchor(session: object): object {
  const documentAnchor = (session as { doc?: unknown }).doc;
  if (!documentAnchor || typeof documentAnchor !== 'object') {
    throw new Error('Workflow return authority requires a document-backed session.');
  }
  return documentAnchor;
}

function sessionCapability(session: object, create: boolean): object | null {
  const capable = session as CapableSession;
  const existing = capable[workflowRoundTripSessionCapability];
  if (existing) return existing;
  if (!create) return null;
  const capability = Object.freeze(new WorkflowRoundTripSessionCapability());
  Object.defineProperty(session, workflowRoundTripSessionCapability, {
    value: capability,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return capability;
}

export function bindWorkflowRoundTripAuthority(session: object, input: WorkflowRoundTripAuthorityInput): void {
  authorities.set(sessionCapability(session, true)!, {
    authority: Object.freeze({
      ...structuredClone(input),
      [workflowRoundTripBrand]: true as const,
    }),
    documentAnchor: sessionDocumentAnchor(session),
  });
}

export function workflowRoundTripAuthority(session: object): WorkflowRoundTripAuthority | null {
  const capability = sessionCapability(session, false);
  const entry = capability ? authorities.get(capability) : null;
  if (!entry) return null;
  try {
    return sessionDocumentAnchor(session) === entry.documentAnchor ? entry.authority : null;
  } catch {
    return null;
  }
}

export function clearWorkflowRoundTripAuthority(session: object): void {
  const capability = sessionCapability(session, false);
  const entry = capability ? authorities.get(capability) : null;
  if (!capability || !entry) return;
  try {
    if (sessionDocumentAnchor(session) === entry.documentAnchor) authorities.delete(capability);
  } catch {
    // A forged or malformed session cannot clear another document's authority.
  }
}

export function workflowRoundTripSessionsForWorkflow(workflowId: string): object[] {
  return [...authorities.entries()]
    .filter(([, entry]) => entry.authority.workflowId === workflowId)
    .map(([capability]) => capability);
}

export function hasWorkflowRoundTripSessions(): boolean {
  return authorities.size > 0;
}
