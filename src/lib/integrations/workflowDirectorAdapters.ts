import { invoke } from '@tauri-apps/api/core';
import type { AiRunOptions } from '../state/settings';
import type {
  WorkflowDirector,
  WorkflowDirectorContext,
  WorkflowDirectorGraphDraft,
} from '../workflow';
import { isDesktop } from './desktop';

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
}

export type InvokeWorkflowDirector = (options: InvokeWorkflowDirectorOptions) => Promise<unknown>;

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
): WorkflowDirector {
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
  };
  return {
    draft: (context) => run({ ...invocation, context, runId: runId() }),
  };
}

function inputTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim() || 'Visual Input';
}

export function providerFreeWorkflowDraft(context: WorkflowDirectorContext): WorkflowDirectorGraphDraft {
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

export function createProviderFreeWorkflowDirector(): WorkflowDirector {
  return { draft: async (context) => providerFreeWorkflowDraft(context) };
}
