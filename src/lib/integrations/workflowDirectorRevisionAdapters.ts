import { invoke } from '@tauri-apps/api/core';
import type { AiRunOptions } from '../state/settings';
import type { WorkflowGraphV2 } from '../workflow/schema';
import type {
  WorkflowDirectorRevisionRequest,
  WorkflowDirectorRevisionRequester,
} from '../workflow/directorRevisionSession';
import { cancelAiRun, isDesktop } from './desktop';

type InvokeRevision = (options: Record<string, unknown>) => Promise<unknown>;

const authoringKeys: Record<string, readonly string[]> = {
  input: ['assetId', 'role', 'required'],
  brief: ['objective', 'guidance'],
  'art-direction': ['prompt'],
  transform: ['capability', 'instructions'],
  review: ['mode', 'instructions'],
  output: ['finalWidth', 'finalHeight'],
};

export function constrainedWorkflowRevisionGraph(graph: WorkflowGraphV2) {
  const supportedNodeIds = new Set(
    graph.nodes.filter((node) => node.type !== 'unsupported').map((node) => node.id),
  );
  return {
    id: graph.id,
    nodes: graph.nodes.filter((node) => node.type !== 'unsupported').map((node) => ({
      id: node.id,
      type: node.type,
      title: node.title,
      position: node.position,
      ports: node.ports,
      config: Object.fromEntries((authoringKeys[node.type] ?? [])
        .filter((key) => Object.hasOwn(node.config, key))
        .map((key) => [key, node.config[key]])),
    })),
    edges: graph.edges
      .filter((edge) => (
        supportedNodeIds.has(edge.source.nodeId) && supportedNodeIds.has(edge.target.nodeId)
      ))
      .map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
  };
}

export const invokeWorkflowDirectorRevision: InvokeRevision = async (options) => {
  if (!isDesktop()) throw new Error('Configured workflow revision is available only in the PaintNode desktop app.');
  return invoke('revise_workflow_with_director', options);
};

function configuredBin(mode: 'builtin' | 'custom', value: string): string | null {
  return mode === 'custom' && value.trim() ? value.trim() : null;
}

export function createConfiguredWorkflowRevisionRequester(
  options: AiRunOptions,
  run: InvokeRevision = invokeWorkflowDirectorRevision,
  runId: () => string = () => `workflow-revision-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
  cancelRun: (id: string) => Promise<void> = cancelAiRun,
): WorkflowDirectorRevisionRequester {
  let activeRunId: string | null = null;
  return {
    label: `Configured Director · ${options.directorProvider}`,
    providerFree: false,
    request: async (request: WorkflowDirectorRevisionRequest, signal?: AbortSignal) => {
      if (activeRunId) throw new Error('A configured workflow revision is already running.');
      const currentRunId = runId();
      activeRunId = currentRunId;
      const cancel = () => { void cancelRun(currentRunId); };
      if (signal?.aborted) cancel();
      else signal?.addEventListener('abort', cancel, { once: true });
      try {
        return await run({
          provider: options.directorProvider,
          context: {
            version: 1,
            instruction: request.instruction,
            sourceGraphRevision: request.sourceGraphRevision,
            graph: constrainedWorkflowRevisionGraph(request.graph),
          },
          runId: currentRunId,
          codexBin: options.directorProvider === 'codex' ? configuredBin(options.codexExecutableMode, options.codexBin) : null,
          codexModel: options.directorProvider === 'codex' ? options.model || null : null,
          codexReasoningEffort: options.directorProvider === 'codex' ? options.reasoningEffort || null : null,
          codexServiceTier: options.directorProvider === 'codex' ? options.serviceTier || null : null,
          claudeBin: options.directorProvider === 'claude' ? configuredBin(options.claudeExecutableMode, options.claudeBin) : null,
          claudeModel: options.directorProvider === 'claude' && options.claudeModel !== 'default' ? options.claudeModel : null,
          claudeEffort: options.directorProvider === 'claude' && options.claudeEffort !== 'auto' ? options.claudeEffort : null,
          antigravityBin: options.directorProvider === 'antigravity' ? configuredBin(options.antigravityExecutableMode, options.antigravityBin) : null,
          antigravityModel: options.directorProvider === 'antigravity' && options.antigravityModel !== 'auto' ? options.antigravityModel : null,
          antigravityApprovalMode: options.directorProvider === 'antigravity' ? options.antigravityApprovalMode || null : null,
          timeoutMs: 180_000,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out/i.test(message)) throw new Error('The AI Director revision timed out and was stopped.');
        if (/cancelled/i.test(message)) throw new Error('The AI Director revision was cancelled.');
        if (/stopped/i.test(message)) throw new Error('The AI Director revision was stopped.');
        throw new Error('Configured AI Director could not prepare a safe workflow revision. Review provider progress and try again.');
      } finally {
        signal?.removeEventListener('abort', cancel);
        if (activeRunId === currentRunId) activeRunId = null;
      }
    },
  };
}
