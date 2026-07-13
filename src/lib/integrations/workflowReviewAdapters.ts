import { invoke } from '@tauri-apps/api/core';
import type { AiRunOptions } from '../state/settings';
import type { WorkflowAiReviewResult } from '../workflow/reviewRecommendation';
import type { WorkflowRunProvider } from '../workflow/schema';
import { cancelAiRun, isDesktop } from './desktop';

export interface WorkflowAiReviewCandidateInput {
  candidateId: string;
  candidateRunId: string;
  materialKey: string;
  contentHash: string;
  providerId: string;
  model: string | null;
  previewPng: Uint8Array;
}

type InvokeReview = (options: Record<string, unknown>) => Promise<unknown>;

function configuredBin(mode: 'builtin' | 'custom', value: string): string | null {
  return mode === 'custom' && value.trim() ? value.trim() : null;
}

function directorModel(options: AiRunOptions): string | null {
  if (options.directorProvider === 'codex') return options.model || null;
  if (options.directorProvider === 'claude') return options.claudeModel === 'default' ? null : options.claudeModel;
  if (options.directorProvider === 'antigravity') return options.antigravityModel === 'auto' ? null : options.antigravityModel;
  return options.grokModel === 'auto' ? null : options.grokModel;
}

export function workflowAiReviewProvider(options: AiRunOptions): WorkflowRunProvider {
  return {
    id: options.directorProvider,
    model: directorModel(options),
    effectiveOptions: options.directorProvider === 'codex'
      ? { reasoningEffort: options.reasoningEffort, serviceTier: options.serviceTier }
      : options.directorProvider === 'claude'
        ? { claudeEffort: options.claudeEffort }
        : options.directorProvider === 'antigravity'
          ? { approvalMode: options.antigravityApprovalMode }
          : { grokReasoningEffort: options.grokReasoningEffort },
  };
}

export async function invokeWorkflowAiReview(options: Record<string, unknown>): Promise<unknown> {
  if (!isDesktop()) throw new Error('AI Review is available only in the PaintNode desktop app.');
  return invoke('review_workflow_candidates', options);
}

export async function reviewWorkflowCandidates(
  options: AiRunOptions,
  request: Readonly<{ reviewNodeId: string; instructions: string; candidates: WorkflowAiReviewCandidateInput[] }>,
  dependencies: Readonly<{
    invokeReview?: InvokeReview;
    runId?: () => string;
    cancelRun?: (runId: string) => Promise<void>;
    signal?: AbortSignal;
  }> = {},
): Promise<WorkflowAiReviewResult> {
  const runId = (dependencies.runId ?? (() => `workflow-review-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`))();
  const cancelRun = dependencies.cancelRun ?? cancelAiRun;
  const cancel = () => { void cancelRun(runId); };
  if (dependencies.signal?.aborted) cancel();
  else dependencies.signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await (dependencies.invokeReview ?? invokeWorkflowAiReview)({
      provider: options.directorProvider,
      context: {
        version: 1,
        reviewNodeId: request.reviewNodeId,
        instructions: request.instructions,
        candidates: request.candidates.map((candidate) => ({
          ...candidate,
          previewPng: Array.from(candidate.previewPng),
        })),
      },
      runId,
      codexBin: options.directorProvider === 'codex' ? configuredBin(options.codexExecutableMode, options.codexBin) : null,
      codexModel: options.directorProvider === 'codex' ? options.model || null : null,
      codexReasoningEffort: options.directorProvider === 'codex' ? options.reasoningEffort || null : null,
      codexServiceTier: options.directorProvider === 'codex' ? options.serviceTier || null : null,
      claudeBin: options.directorProvider === 'claude' ? configuredBin(options.claudeExecutableMode, options.claudeBin) : null,
      claudeModel: options.directorProvider === 'claude' && options.claudeModel !== 'default' ? options.claudeModel : null,
      claudeEffort: options.directorProvider === 'claude' && options.claudeEffort !== 'auto' ? options.claudeEffort : null,
      antigravityBin: options.directorProvider === 'antigravity' ? configuredBin(options.antigravityExecutableMode, options.antigravityBin) : null,
      antigravityModel: options.directorProvider === 'antigravity' && options.antigravityModel !== 'auto' ? options.antigravityModel : null,
      antigravityApprovalMode: options.directorProvider === 'antigravity' ? options.antigravityApprovalMode : null,
      grokBin: options.directorProvider === 'grok' ? configuredBin(options.grokExecutableMode, options.grokBin) : null,
      grokModel: options.directorProvider === 'grok' && options.grokModel !== 'auto' ? options.grokModel : null,
      grokReasoningEffort: options.directorProvider === 'grok' && options.grokReasoningEffort !== 'auto'
        ? options.grokReasoningEffort : null,
      timeoutMs: 180_000,
    }) as WorkflowAiReviewResult;
  } finally {
    dependencies.signal?.removeEventListener('abort', cancel);
  }
}
