import { WorkflowGraphDomain } from './domain';
import {
  resolveWorkflowCampaignPath,
  resolveWorkflowReviewTopology,
  type WorkflowReviewTopologyResolution,
} from './candidatePromotion';
import type { WorkflowGraphV2, WorkflowNodeV2 } from './schema';
import { workflowNodeAiOverrides } from './aiRoles';
import { workflowTransformContext, type WorkflowTransformContext } from './transformContext';

export type WorkflowReadinessCode =
  | 'desktop'
  | 'project-folder'
  | 'required-assets'
  | 'brief'
  | 'art-direction'
  | 'provider'
  | 'transform'
  | 'review'
  | 'outputs';

export interface WorkflowReadinessAsset {
  id: string;
  relativePath: string;
  exists: boolean;
}

export interface WorkflowReadinessOptions {
  desktop: boolean;
  projectPath: string | null;
  assets: readonly WorkflowReadinessAsset[];
  provider?: string | null;
  supportedProviders?: readonly string[];
  targetNodeId?: string | null;
  allowUnpromotedReview?: boolean;
  requireVerifiedReview?: boolean;
  reviewResolutions?: Readonly<Record<string, WorkflowReviewTopologyResolution>>;
}

export interface WorkflowReadinessItem {
  code: WorkflowReadinessCode;
  label: string;
  status: 'complete' | 'blocked';
  message: string;
  action: string | null;
}

export interface WorkflowReadiness {
  ready: boolean;
  items: readonly WorkflowReadinessItem[];
  nextAction: WorkflowReadinessItem | null;
}

function complete(code: WorkflowReadinessCode, label: string, message: string): WorkflowReadinessItem {
  return { code, label, status: 'complete', message, action: null };
}

function blocked(
  code: WorkflowReadinessCode,
  label: string,
  message: string,
  action: string,
): WorkflowReadinessItem {
  return { code, label, status: 'blocked', message, action };
}

function textConfig(node: WorkflowNodeV2 | undefined, key: string): string {
  const value = node?.config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function assetBinding(graph: WorkflowGraphV2, node: WorkflowNodeV2): { assetId: string; relativePath: string } | null {
  const directAssetId = typeof node.config.assetId === 'string' ? node.config.assetId.trim() : '';
  const directPath = typeof node.config.relativePath === 'string' ? node.config.relativePath.trim() : '';
  const referenceId = typeof node.config.assetReferenceId === 'string' ? node.config.assetReferenceId : '';
  const reference = graph.assetReferences.find((item) => item.id === referenceId);
  const assetId = directAssetId || reference?.assetId?.trim() || '';
  const relativePath = directPath || reference?.relativePath?.trim() || '';
  return assetId || relativePath ? { assetId, relativePath } : null;
}

function assetReadiness(
  graph: WorkflowGraphV2,
  options: WorkflowReadinessOptions,
  context: WorkflowTransformContext | null,
): WorkflowReadinessItem {
  const slots = graph.nodes.filter((node) => node.type === 'input');
  const artDirectionIds = new Set(graph.nodes.filter((node) => node.type === 'art-direction').map((node) => node.id));
  const transformIds = new Set(graph.nodes.filter((node) => node.type === 'transform').map((node) => node.id));
  const extractionIds = new Set(graph.nodes.filter((node) => node.type === 'extract-assets').map((node) => node.id));
  const connectedToGenerationContext = (slotId: string): boolean => graph.edges.some((edge) => {
    if (edge.source.nodeId !== slotId) return false;
    if (context?.transform) {
      return (edge.target.nodeId === context.transform.id && edge.target.portId === 'assets')
        || (edge.target.nodeId === context.artDirection?.id && edge.target.portId === 'assets');
    }
    return (artDirectionIds.has(edge.target.nodeId) && edge.target.portId === 'assets')
      || (transformIds.has(edge.target.nodeId) && edge.target.portId === 'assets');
  });
  for (const slot of slots) {
    const connected = connectedToGenerationContext(slot.id);
    const extractionOnly = !connected && graph.edges.some((edge) => (
      edge.source.nodeId === slot.id
      && extractionIds.has(edge.target.nodeId)
      && (edge.target.portId === 'sources' || edge.target.portId === 'support')
    ));
    if (extractionOnly) continue;
    const binding = assetBinding(graph, slot);
    const required = slot.config.required !== false;
    if (required && !binding) {
      return blocked(
        'required-assets',
        'Visual inputs',
        `${slot.title} is required before Generate can run.`,
        `Choose an asset for ${slot.title}`,
      );
    }
    if (!binding) continue;
    if (!connected) {
      const targetName = context?.artDirection?.title ?? context?.transform?.title ?? 'Art Direction or Transform';
      return blocked(
        'required-assets',
        'Visual inputs',
        `${slot.title} has an asset but is not connected to ${targetName}.`,
        `Reconnect ${slot.title} to ${targetName}`,
      );
    }
    const available = options.assets.some((asset) => (
      asset.exists && (
        (binding.assetId.length > 0 && asset.id === binding.assetId)
        || (binding.relativePath.length > 0 && asset.relativePath === binding.relativePath)
      )
    ));
    if (!available) {
      return blocked(
        'required-assets',
        'Visual inputs',
        `${slot.title} points to an asset that is no longer available in this project.`,
        `Replace the asset in ${slot.title}`,
      );
    }
  }
  const requiredCount = slots.filter((node) => node.config.required !== false).length;
  if (requiredCount === 0 && slots.length === 0) {
    return blocked('required-assets', 'Visual inputs', 'Add at least one visual input before Generate can run.', 'Add a visual input');
  }
  return complete(
    'required-assets',
    'Visual inputs',
    requiredCount > 0 ? `${requiredCount} required visual ${requiredCount === 1 ? 'input is' : 'inputs are'} ready.` : 'Visual inputs are ready.',
  );
}

function targetOutputs(graph: WorkflowGraphV2, targetNodeId?: string | null): WorkflowNodeV2[] {
  if (!targetNodeId) return graph.nodes.filter((node) => node.type === 'output');
  const target = graph.nodes.find((node) => node.id === targetNodeId && node.type === 'output');
  return target ? [target] : [];
}

function transformForOutput(graph: WorkflowGraphV2, output: WorkflowNodeV2): WorkflowNodeV2 | null {
  const path = resolveWorkflowCampaignPath(graph, { outputNodeId: output.id });
  return graph.nodes.find((node) => node.id === path?.transformNodeId && node.type === 'transform') ?? null;
}

function outputReadiness(graph: WorkflowGraphV2, targetNodeId?: string | null): WorkflowReadinessItem {
  const outputs = targetOutputs(graph, targetNodeId);
  if (outputs.length === 0) {
    return blocked('outputs', 'Outputs', targetNodeId ? 'The requested output is unavailable.' : 'Add at least one configured output.', targetNodeId ? 'Choose an available output' : 'Add an output');
  }
  const artDirectionIds = new Set(graph.nodes.filter((node) => node.type === 'art-direction').map((node) => node.id));
  for (const output of outputs) {
    const width = output.config.finalWidth;
    const height = output.config.finalHeight;
    if (typeof width !== 'number' || width <= 0 || typeof height !== 'number' || height <= 0) {
      return blocked('outputs', 'Outputs', `${output.title} needs valid dimensions.`, `Configure ${output.title}`);
    }
    const transform = transformForOutput(graph, output);
    const connected = Boolean(resolveWorkflowCampaignPath(graph, { outputNodeId: output.id })) || graph.edges.some((edge) => (
      edge.target.nodeId === output.id && artDirectionIds.has(edge.source.nodeId)
    ));
    if (!connected) {
      return blocked('outputs', 'Outputs', `${output.title} is not connected to Art Direction.`, `Reconnect ${output.title}`);
    }
  }
  return complete('outputs', 'Outputs', `${outputs.length} configured ${outputs.length === 1 ? 'output is' : 'outputs are'} ready.`);
}

function transformReadiness(
  graph: WorkflowGraphV2,
  output: WorkflowNodeV2,
  requiredForRun = false,
): WorkflowReadinessItem | null {
  const transform = transformForOutput(graph, output);
  if (!transform) {
    return requiredForRun
      ? blocked(
          'transform',
          'Generate Transform',
          `${output.title} is not connected through a Generate Transform.`,
          `Add or reconnect a Generate Transform for ${output.title}`,
        )
      : null;
  }
  const context = workflowTransformContext(graph, transform.id);
  const hasSource = Boolean(
    (context.artDirection
      && context.sourceEdge?.source.nodeId === context.artDirection.id
      && context.sourceEdge.source.portId === 'layout')
    || (context.sourceReview
      && context.sourceEdge?.source.nodeId === context.sourceReview.id
      && context.sourceEdge.source.portId === 'selected')
    || (!context.sourceEdge && context.directVisuals.length > 0),
  );
  const hasResult = graph.edges.some((edge) => (
    edge.source.nodeId === transform.id && edge.source.portId === 'result'
  )) && Boolean(resolveWorkflowCampaignPath(graph, { outputNodeId: output.id, transformNodeId: transform.id }));
  const capability = textConfig(transform, 'capability');
  if (!['generate', 'edit', 'remove-background', 'relight', 'upscale'].includes(capability) || !hasSource || !hasResult) {
    return blocked(
      'transform',
      'Image Transform',
      `${transform.title} needs Directed composition or direct visual references, plus a connection to ${output.title}.`,
      `Connect visual context to ${transform.title}, then reconnect ${output.title}`,
    );
  }
  return complete('transform', 'Image Transform', `${transform.title} is configured for ${output.title}.`);
}

function reviewReadiness(
  graph: WorkflowGraphV2,
  output: WorkflowNodeV2,
  options: WorkflowReadinessOptions,
): WorkflowReadinessItem | null {
  const path = resolveWorkflowCampaignPath(graph, { outputNodeId: output.id });
  const transform = graph.nodes.find((node) => node.id === path?.transformNodeId && node.type === 'transform');
  const sourceReviewId = transform
    ? graph.edges.find((edge) => edge.target.nodeId === transform.id
      && edge.target.portId === 'source' && edge.source.portId === 'selected')?.source.nodeId ?? null
    : null;
  const reviewNodeId = path?.reviewNodeId ?? sourceReviewId;
  if (!reviewNodeId || options.allowUnpromotedReview) return null;
  const resolution = options.reviewResolutions?.[reviewNodeId]
    ?? (options.requireVerifiedReview
      ? {
          state: 'blocked' as const,
          reviewNodeId,
          transformNodeId: path?.transformNodeId ?? null,
          outputNodeId: path?.outputNodeId ?? output.id,
          reason: {
            code: 'PROMOTED_OUTPUT_UNAVAILABLE' as const,
            message: 'The promoted candidate has not been verified against the current workflow and project.',
            action: 'Wait for Review verification or inspect the Review node',
          },
        }
      : resolveWorkflowReviewTopology(graph, { reviewNodeId }));
  return resolution.state === 'ready'
    ? complete('review', 'Concept review', 'A promoted candidate is ready for downstream use.')
    : blocked('review', 'Concept review', resolution.reason.message, resolution.reason.action);
}

function providerReadiness(
  output: WorkflowNodeV2,
  graph: WorkflowGraphV2,
  options: WorkflowReadinessOptions,
): WorkflowReadinessItem | null {
  const transform = transformForOutput(graph, output);
  if (!transform) return null;
  const advanced = transform.config.advanced;
  const configuredProvider = workflowNodeAiOverrides(transform)?.image?.provider ?? (typeof advanced === 'object' && advanced !== null && !Array.isArray(advanced)
    && typeof (advanced as Record<string, unknown>).provider === 'string'
    ? ((advanced as Record<string, unknown>).provider as string).trim()
    : '');
  const provider = configuredProvider || options.provider?.trim() || '';
  if (!provider) {
    return blocked('provider', 'Image provider', 'Choose an image provider for this Transform.', 'Choose a supported image provider');
  }
  if (!(options.supportedProviders ?? []).includes(provider)) {
    return blocked('provider', 'Image provider', `The provider “${provider}” cannot run this Transform.`, 'Choose a supported image provider');
  }
  return complete('provider', 'Image provider', `${provider} can run this Transform.`);
}

function briefReadiness(
  graph: WorkflowGraphV2,
  brief: WorkflowNodeV2 | undefined,
  artDirection: WorkflowNodeV2 | undefined,
  transform: WorkflowNodeV2 | null,
): WorkflowReadinessItem {
  if (!artDirection && transform) {
    return complete('brief', 'Creative brief', 'No separate Brief is required; this Transform uses its local guidance.');
  }
  const requiredPromptPort = artDirection?.ports.inputs.find((port) => port.required && port.dataType === 'prompt');
  if (artDirection && requiredPromptPort && !brief) {
    return blocked(
      'brief',
      'Creative brief',
      `${artDirection.title} requires a connected Brief.`,
      `Connect a Brief to ${artDirection.title}`,
    );
  }
  const objective = textConfig(brief, 'objective');
  if (!objective) {
    return blocked('brief', 'Creative brief', 'Describe the outcome this workflow should create.', 'Write the campaign brief');
  }
  if (brief && artDirection) {
    const connected = requiredPromptPort && graph.edges.some((edge) => (
      edge.source.nodeId === brief.id
      && edge.target.nodeId === artDirection.id
      && edge.target.portId === requiredPromptPort.id
    ));
    if (requiredPromptPort && !connected) {
      return blocked(
        'brief',
        'Creative brief',
        `${brief.title} is not connected to ${artDirection.title}'s required ${requiredPromptPort.label} input.`,
        `Reconnect ${brief.title} to ${artDirection.title}`,
      );
    }
  }
  return complete('brief', 'Creative brief', 'The intended outcome is defined and connected.');
}

function artDirectionReadiness(
  artDirection: WorkflowNodeV2 | undefined,
  transform: WorkflowNodeV2 | null,
): WorkflowReadinessItem {
  if (artDirection) {
    return textConfig(artDirection, 'prompt') || textConfig(artDirection, 'guidance')
      ? complete('art-direction', 'Art direction', 'Visual guidance is defined.')
      : blocked('art-direction', 'Art direction', 'Add composition, lighting, colour, or style guidance.', 'Add art-direction guidance');
  }
  if (!transform) {
    return blocked('art-direction', 'Art direction', 'Add composition, lighting, colour, or style guidance.', 'Add art-direction guidance');
  }
  const capability = textConfig(transform, 'capability');
  const instructions = textConfig(transform, 'instructions');
  if (instructions || capability === 'remove-background' || capability === 'upscale') {
    return complete('art-direction', 'Transform guidance', 'This Transform uses direct visual references and local guidance.');
  }
  return blocked(
    'art-direction',
    'Transform guidance',
    `${transform.title} needs local instructions when no Art Direction is connected.`,
    `Write instructions in ${transform.title}`,
  );
}

export function workflowReadiness(
  inputGraph: WorkflowGraphV2,
  options: WorkflowReadinessOptions,
): WorkflowReadiness {
  const graph = new WorkflowGraphDomain(inputGraph).graph;
  const outputs = targetOutputs(graph, options.targetNodeId);
  const targetOutput = outputs[0];
  const targetTransform = targetOutput ? transformForOutput(graph, targetOutput) : null;
  const targetContext = targetTransform ? workflowTransformContext(graph, targetTransform.id) : null;
  const brief = targetContext?.brief ?? graph.nodes.find((node) => node.type === 'brief');
  const artDirection = targetContext?.artDirection ?? (targetTransform
    ? undefined
    : graph.nodes.find((node) => node.type === 'art-direction'));
  const transform = targetOutput
    ? transformReadiness(graph, targetOutput, Boolean(options.targetNodeId))
    : null;
  const provider = targetOutput ? providerReadiness(targetOutput, graph, options) : null;
  const review = targetOutput ? reviewReadiness(graph, targetOutput, options) : null;
  const items: WorkflowReadinessItem[] = [
    options.desktop
      ? complete('desktop', 'Desktop app', 'Workflow generation is available.')
      : blocked('desktop', 'Desktop app', 'Generation runs in the PaintNode desktop app.', 'Open the desktop app'),
    options.projectPath
      ? complete('project-folder', 'Project folder', options.projectPath)
      : blocked('project-folder', 'Project folder', 'Generated assets and workflow files need a project folder.', 'Choose or create a project folder'),
    assetReadiness(graph, options, targetContext),
    briefReadiness(graph, brief, artDirection, targetTransform),
    artDirectionReadiness(artDirection, targetTransform),
    ...(transform ? [transform] : []),
    ...(provider ? [provider] : []),
    ...(review ? [review] : []),
    outputReadiness(graph, options.targetNodeId),
  ];
  const nextAction = items.find((item) => item.status === 'blocked') ?? null;
  return { ready: nextAction === null, items, nextAction };
}
