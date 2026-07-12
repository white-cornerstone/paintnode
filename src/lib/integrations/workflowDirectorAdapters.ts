import { invoke } from '@tauri-apps/api/core';
import type { AiRunOptions } from '../state/settings';
import type {
  WorkflowDirector,
  WorkflowDirectorContext,
  WorkflowDirectorGraphDraft,
} from '../workflow';
import { cancelAiRun, isDesktop } from './desktop';

export interface InvokeWorkflowDirectorOptions {
  provider: AiRunOptions['directorProvider'];
  context: WorkflowDirectorContext;
  runId: string;
  codexBin: string | null;
  codexModel: string | null;
  codexReasoningEffort: string | null;
  codexServiceTier: string | null;
  claudeBin: string | null;
  claudeModel: string | null;
  claudeEffort: string | null;
  antigravityBin: string | null;
  antigravityModel: string | null;
  antigravityApprovalMode: string | null;
  grokBin: string | null;
  grokModel: string | null;
  grokReasoningEffort: string | null;
  timeoutMs: number;
}

export type InvokeWorkflowDirector = (options: InvokeWorkflowDirectorOptions) => Promise<unknown>;
export type CancelWorkflowDirector = (runId: string) => Promise<void>;

export interface CancellableWorkflowDirector extends WorkflowDirector {
  cancel(): Promise<void>;
}

function configuredBin(mode: 'builtin' | 'custom', value: string): string | null {
  return mode === 'custom' && value.trim() ? value.trim() : null;
}

export const invokeWorkflowDirector: InvokeWorkflowDirector = async (options) => {
  if (!isDesktop()) throw new Error('AI Director workflow drafting is available only in the PaintNode desktop app.');
  return invoke<unknown>('draft_workflow_with_director', { ...options });
};

function defaultRunId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `workflow-director-${uuid}` : `workflow-director-${Date.now()}`;
}

export function createConfiguredWorkflowDirector(
  options: AiRunOptions,
  run: InvokeWorkflowDirector = invokeWorkflowDirector,
  runId: () => string = defaultRunId,
  cancelRun: CancelWorkflowDirector = cancelAiRun,
): CancellableWorkflowDirector {
  const invocation: Omit<InvokeWorkflowDirectorOptions, 'context' | 'runId'> = {
    provider: options.directorProvider,
    codexBin: options.directorProvider === 'codex' ? configuredBin(options.codexExecutableMode, options.codexBin) : null,
    codexModel: options.directorProvider === 'codex' ? options.model || null : null,
    codexReasoningEffort: options.directorProvider === 'codex' ? options.reasoningEffort || null : null,
    codexServiceTier: options.directorProvider === 'codex' ? options.serviceTier || null : null,
    claudeBin: options.directorProvider === 'claude' ? configuredBin(options.claudeExecutableMode, options.claudeBin) : null,
    claudeModel: options.directorProvider === 'claude' && options.claudeModel !== 'default' ? options.claudeModel : null,
    claudeEffort: options.directorProvider === 'claude' && options.claudeEffort !== 'auto' ? options.claudeEffort : null,
    antigravityBin: options.directorProvider === 'antigravity'
      ? configuredBin(options.antigravityExecutableMode, options.antigravityBin)
      : null,
    antigravityModel: options.directorProvider === 'antigravity' && options.antigravityModel !== 'auto'
      ? options.antigravityModel
      : null,
    antigravityApprovalMode: options.directorProvider === 'antigravity' ? options.antigravityApprovalMode || null : null,
    grokBin: options.directorProvider === 'grok'
      ? configuredBin(options.grokExecutableMode, options.grokBin)
      : null,
    grokModel: options.directorProvider === 'grok' && options.grokModel !== 'auto' ? options.grokModel : null,
    grokReasoningEffort: options.directorProvider === 'grok' && options.grokReasoningEffort !== 'auto'
      ? options.grokReasoningEffort
      : null,
    timeoutMs: 180_000,
  };
  let activeRunId: string | null = null;
  return {
    draft: async (context) => {
      if (activeRunId) throw new Error('AI Director is already drafting a workflow.');
      const currentRunId = runId();
      activeRunId = currentRunId;
      try {
        return await run({ ...invocation, context, runId: currentRunId });
      } finally {
        if (activeRunId === currentRunId) activeRunId = null;
      }
    },
    cancel: async () => {
      if (activeRunId) await cancelRun(activeRunId);
    },
  };
}

function inputTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim() || 'Visual Input';
}

function isCampaignRequest(context: WorkflowDirectorContext): boolean {
  const expected = [
    ['Square 1:1', 1024, 1024],
    ['Portrait 4:5', 1024, 1280],
    ['Landscape 16:9', 1280, 720],
  ];
  return context.requestedOutputs.length === expected.length
    && expected.every(([name, width, height], index) => {
      const output = context.requestedOutputs[index];
      return output?.name === name && output.width === width && output.height === height;
    });
}

function providerFreeCampaignDraft(context: WorkflowDirectorContext): WorkflowDirectorGraphDraft {
  const availableAssets = context.assets.filter((asset) => asset.available);
  const slots = [
    { id: 'product', title: 'Product', role: 'Hero product', required: true, assetId: availableAssets[0]?.id ?? null },
    { id: 'subject', title: 'Subject', role: 'Optional person', required: false, assetId: availableAssets[1]?.id ?? null },
    { id: 'style', title: 'Style', role: 'Optional brand style', required: false, assetId: availableAssets[2]?.id ?? null },
  ] as const;
  return {
    version: 1,
    name: 'QA Fake Campaign Proposal',
    summary: 'A deterministic Campaign Composer-equivalent proposal for provider-free acceptance QA.',
    nodes: [
      ...slots.map((slot) => ({ ...slot, type: 'input' as const })),
      {
        id: 'brief',
        type: 'brief',
        title: 'Campaign Brief',
        objective: context.brief,
        guidance: 'Keep the product recognisable.',
      },
      {
        id: 'composition',
        type: 'art-direction',
        title: 'Art Direction',
        prompt: 'Keep product identity and brand cues consistent while adapting composition to each format.',
      },
      {
        id: 'generate-square',
        type: 'transform',
        title: 'Generate Concepts',
        capability: 'generate',
        instructions: 'Generate square campaign concepts.',
      },
      {
        id: 'review-direction', type: 'review', title: 'Choose Campaign Direction', mode: 'human',
        instructions: 'Choose the strongest campaign direction before adapting it to every format.',
      },
      {
        id: 'generate-portrait', type: 'transform', title: 'Generate Portrait', capability: 'generate',
        instructions: 'Adapt the accepted direction to Portrait 4:5.',
      },
      {
        id: 'generate-landscape', type: 'transform', title: 'Generate Landscape', capability: 'generate',
        instructions: 'Adapt the accepted direction to Landscape 16:9.',
      },
      ...context.requestedOutputs.map((output) => ({
        id: output.id,
        type: 'output' as const,
        title: output.name,
        width: output.width,
        height: output.height,
      })),
    ],
    edges: [
      ...slots.map((slot) => ({
        id: `${slot.id}-composition`,
        source: { nodeId: slot.id, portId: 'asset' },
        target: { nodeId: 'composition', portId: 'assets' },
      })),
      {
        id: 'brief-composition',
        source: { nodeId: 'brief', portId: 'prompt' },
        target: { nodeId: 'composition', portId: 'brief' },
      },
      {
        id: 'composition-generate',
        source: { nodeId: 'composition', portId: 'layout' },
        target: { nodeId: 'generate-square', portId: 'source' },
      },
      {
        id: 'generate-square-review',
        source: { nodeId: 'generate-square', portId: 'result' },
        target: { nodeId: 'review-direction', portId: 'candidates' },
      },
      { id: 'review-square', source: { nodeId: 'review-direction', portId: 'selected' }, target: { nodeId: context.requestedOutputs[0].id, portId: 'source' } },
      { id: 'review-portrait', source: { nodeId: 'review-direction', portId: 'selected' }, target: { nodeId: 'generate-portrait', portId: 'source' } },
      { id: 'generate-portrait-output', source: { nodeId: 'generate-portrait', portId: 'result' }, target: { nodeId: context.requestedOutputs[1].id, portId: 'source' } },
      { id: 'review-landscape', source: { nodeId: 'review-direction', portId: 'selected' }, target: { nodeId: 'generate-landscape', portId: 'source' } },
      { id: 'generate-landscape-output', source: { nodeId: 'generate-landscape', portId: 'result' }, target: { nodeId: context.requestedOutputs[2].id, portId: 'source' } },
    ],
  };
}

export function providerFreeWorkflowDraft(context: WorkflowDirectorContext): WorkflowDirectorGraphDraft {
  if (isCampaignRequest(context)) return providerFreeCampaignDraft(context);
  const asset = context.assets.find((item) => item.available) ?? null;
  const nodes: WorkflowDirectorGraphDraft['nodes'] = [
    ...(asset ? [{
      id: 'qa-input',
      type: 'input' as const,
      title: inputTitle(asset.name),
      assetId: asset.id,
      role: 'Primary visual input',
      required: true,
    }] : []),
    {
      id: 'qa-brief',
      type: 'brief',
      title: 'Creative Brief',
      objective: context.brief,
      guidance: 'Preserve the requested subject, brand cues, and output intent.',
    },
    {
      id: 'qa-art-direction',
      type: 'art-direction',
      title: 'Art Direction',
      prompt: 'Create a cohesive, polished visual system that adapts clearly to every requested output.',
    },
    {
      id: 'qa-generate',
      type: 'transform',
      title: 'Generate Primary',
      capability: 'generate',
      instructions: 'Generate the primary requested result from the authored brief and art direction.',
    },
    ...context.requestedOutputs.map((output, index) => ({
      id: `qa-output-${index + 1}`,
      type: 'output' as const,
      title: output.name,
      width: output.width,
      height: output.height,
    })),
  ];
  const firstOutputId = 'qa-output-1';
  return {
    version: 1,
    name: 'QA Fake Director Proposal',
    summary: 'A deterministic provider-free creator workflow for validating proposal preview and acceptance.',
    nodes,
    edges: [
      ...(asset ? [{
        id: 'qa-input-art',
        source: { nodeId: 'qa-input', portId: 'asset' },
        target: { nodeId: 'qa-art-direction', portId: 'assets' },
      }] : []),
      {
        id: 'qa-brief-art',
        source: { nodeId: 'qa-brief', portId: 'prompt' },
        target: { nodeId: 'qa-art-direction', portId: 'brief' },
      },
      {
        id: 'qa-art-generate',
        source: { nodeId: 'qa-art-direction', portId: 'layout' },
        target: { nodeId: 'qa-generate', portId: 'source' },
      },
      {
        id: 'qa-generate-output-1',
        source: { nodeId: 'qa-generate', portId: 'result' },
        target: { nodeId: firstOutputId, portId: 'source' },
      },
      ...context.requestedOutputs.slice(1).map((_output, index) => ({
        id: `qa-art-output-${index + 2}`,
        source: { nodeId: 'qa-art-direction', portId: 'layout' },
        target: { nodeId: `qa-output-${index + 2}`, portId: 'source' },
      })),
    ],
  };
}

export function createProviderFreeWorkflowDirector(): CancellableWorkflowDirector {
  return {
    draft: async (context) => providerFreeWorkflowDraft(context),
    cancel: async () => undefined,
  };
}
