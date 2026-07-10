import type { AiDirectorProvider } from '../state/settings';
import {
  draftWorkflowWithDirector,
  type WorkflowDirector,
  type WorkflowDirectorContext,
  type WorkflowDirectorProposal,
  type WorkflowDirectorProposalResult,
} from './directorDraft';
import type { WorkflowQaMode } from './providerQaSelection';

export interface WorkflowDirectorSessionToken {
  readonly sessionIdentity: number;
  readonly graphRevision: number;
  readonly storeRevision: number;
}

export interface WorkflowDirectorProposalTarget {
  captureDirectorSession(): WorkflowDirectorSessionToken;
  applyDirectorProposal(proposal: WorkflowDirectorProposal, session: WorkflowDirectorSessionToken): void;
}

export interface WorkflowDirectorProposalPreview {
  readonly result: WorkflowDirectorProposalResult;
  readonly session: WorkflowDirectorSessionToken;
}

export interface WorkflowDirectorUiSelection {
  ready: boolean;
  provider: AiDirectorProvider | 'qa-fake';
  qaFake: boolean;
  label: string;
  reason: string | null;
}

function providerLabel(provider: AiDirectorProvider): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'claude') return 'Claude';
  return 'Antigravity';
}

export function workflowDirectorProviderSelection(
  resolved: boolean,
  qaMode: WorkflowQaMode,
  desktop: boolean,
  configuredProvider: AiDirectorProvider,
): WorkflowDirectorUiSelection {
  if (!resolved) {
    return {
      ready: false,
      provider: configuredProvider,
      qaFake: false,
      label: 'Checking native QA mode…',
      reason: 'PaintNode is still resolving the native QA mode.',
    };
  }
  if (qaMode === 'provider-free') {
    return {
      ready: true,
      provider: 'qa-fake',
      qaFake: true,
      label: 'QA Fake',
      reason: null,
    };
  }
  return {
    ready: desktop,
    provider: configuredProvider,
    qaFake: false,
    label: providerLabel(configuredProvider),
    reason: desktop ? null : 'Configured AI Directors are available only in the PaintNode desktop app.',
  };
}

export async function requestDirectorProposalPreview(
  director: WorkflowDirector,
  context: WorkflowDirectorContext,
  target: WorkflowDirectorProposalTarget,
  options: { graphId?: string } = {},
): Promise<WorkflowDirectorProposalPreview> {
  const session = target.captureDirectorSession();
  const result = await draftWorkflowWithDirector(director, context, options);
  return Object.freeze({ result, session });
}

export function rejectDirectorProposalPreview(
  _preview: WorkflowDirectorProposalPreview,
): null {
  return null;
}

export function acceptDirectorProposalPreview(
  preview: WorkflowDirectorProposalPreview,
  target: WorkflowDirectorProposalTarget,
): void {
  if (!preview.result.proposal?.canAccept) {
    throw new Error('This AI Director proposal cannot be accepted because validation did not pass.');
  }
  target.applyDirectorProposal(preview.result.proposal, preview.session);
}
