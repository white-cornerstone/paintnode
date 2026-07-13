import { invoke } from '@tauri-apps/api/core';
import type { AiProvider, AiRunOptions } from '../state/settings';
import { cancelAiRun, isDesktop } from './desktop';

export interface WorkflowAssetExtractionPlanV1 {
  version: 1;
  items: Array<{ id: string; name: string; instruction: string }>;
  notes: string;
}

export interface WorkflowAssetExtractionManifestV1 {
  version: 1;
  plan: WorkflowAssetExtractionPlanV1;
  outputs: Array<{ itemId: string; name: string; assetId: string; relativePath: string }>;
  failures: Array<{ itemId: string; code: 'IMAGE_OPERATION_FAILED' }>;
  roles: {
    director: { provider: string; model: string | null };
    image: { provider: AiProvider; model: string | null };
  };
  completedAt: number;
}

export function createWorkflowAssetExtractionManifest(
  plan: WorkflowAssetExtractionPlanV1,
  request: Readonly<{
    outputs: Array<{ itemId: string; name: string; assetId: string; relativePath: string }>;
    failedItemIds: string[];
    director: { provider: string; model: string | null };
    image: { provider: AiProvider; model: string | null };
    completedAt: number;
  }>,
): WorkflowAssetExtractionManifestV1 {
  const planned = new Set(plan.items.map((item) => item.id));
  const resolved = [...request.outputs.map((item) => item.itemId), ...request.failedItemIds];
  if (new Set(resolved).size !== resolved.length || resolved.length !== planned.size
    || resolved.some((itemId) => !planned.has(itemId))) {
    throw new Error('Extraction manifest must account for every planned item exactly once.');
  }
  if (!Number.isSafeInteger(request.completedAt) || request.completedAt < 0) {
    throw new Error('Extraction manifest completion time is invalid.');
  }
  return {
    version: 1,
    plan: structuredClone(plan),
    outputs: request.outputs.map((item) => ({ ...item })),
    failures: request.failedItemIds.map((itemId) => ({ itemId, code: 'IMAGE_OPERATION_FAILED' as const })),
    roles: structuredClone({ director: request.director, image: request.image }),
    completedAt: request.completedAt,
  };
}

export function workflowExtractionCapability(
  imageProvider: AiProvider,
  directorEnabled: boolean,
): { supported: boolean; reason: string | null } {
  if (directorEnabled) return { supported: true, reason: null };
  if (imageProvider === 'grok') {
    return { supported: false, reason: 'Direct Grok extraction cannot produce the required labelled asset inventory.' };
  }
  return { supported: true, reason: null };
}

function configuredBin(mode: 'builtin' | 'custom', value: string): string | null {
  return mode === 'custom' && value.trim() ? value.trim() : null;
}

function parsePlan(value: unknown, maximumAssets: number): WorkflowAssetExtractionPlanV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('AI Director returned an invalid extraction plan.');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.items) || record.items.length === 0 || record.items.length > maximumAssets
    || typeof record.notes !== 'string') throw new Error('AI Director returned an invalid extraction plan.');
  const ids = new Set<string>();
  const items = record.items.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('AI Director returned an invalid extraction item.');
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || !candidate.id.trim() || candidate.id.length > 160 || ids.has(candidate.id)
      || typeof candidate.name !== 'string' || !candidate.name.trim() || candidate.name.length > 160
      || typeof candidate.instruction !== 'string' || !candidate.instruction.trim() || candidate.instruction.length > 2_000) {
      throw new Error('AI Director returned an invalid extraction item.');
    }
    ids.add(candidate.id);
    return { id: candidate.id, name: candidate.name, instruction: candidate.instruction };
  });
  return { version: 1, items, notes: record.notes };
}

export async function planWorkflowAssetExtraction(
  options: AiRunOptions,
  request: Readonly<{ sourcePng: Uint8Array; guidance: string; mode: 'fast' | 'quality'; maximumAssets: number }>,
  dependencies: Readonly<{
    invokePlan?: (options: Record<string, unknown>) => Promise<unknown>;
    runId?: () => string;
    cancelRun?: (runId: string) => Promise<void>;
    signal?: AbortSignal;
  }> = {},
): Promise<WorkflowAssetExtractionPlanV1> {
  if (!dependencies.invokePlan && !isDesktop()) throw new Error('Asset extraction planning is available only in the PaintNode desktop app.');
  const runId = (dependencies.runId ?? (() => `extraction-plan-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`))();
  const cancelRun = dependencies.cancelRun ?? cancelAiRun;
  const cancel = () => { void cancelRun(runId); };
  if (dependencies.signal?.aborted) cancel();
  else dependencies.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const value = await (dependencies.invokePlan ?? ((args) => invoke('plan_workflow_asset_extraction', args)))({
      provider: options.directorProvider,
      context: {
        version: 1,
        guidance: request.guidance,
        mode: request.mode,
        maximumAssets: request.maximumAssets,
        sourcePng: Array.from(request.sourcePng),
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
    });
    return parsePlan(value, request.maximumAssets);
  } finally {
    dependencies.signal?.removeEventListener('abort', cancel);
  }
}
