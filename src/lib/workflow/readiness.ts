import { WorkflowGraphDomain } from './domain';
import type { WorkflowGraphV2, WorkflowNodeV2 } from './schema';

export type WorkflowReadinessCode =
  | 'desktop'
  | 'project-folder'
  | 'required-assets'
  | 'brief'
  | 'art-direction'
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

function assetReadiness(graph: WorkflowGraphV2, options: WorkflowReadinessOptions): WorkflowReadinessItem {
  const templateSlots = graph.nodes.filter((node) => node.type === 'input' && node.config.templateRole === 'asset-slot');
  const slots = templateSlots.length > 0
    ? templateSlots
    : graph.nodes.filter((node) => node.type === 'input');
  const artDirectionIds = new Set(graph.nodes.filter((node) => node.type === 'art-direction').map((node) => node.id));
  for (const slot of slots) {
    const binding = assetBinding(graph, slot);
    const required = templateSlots.length === 0 || slot.config.required === true;
    if (required && !binding) {
      return blocked(
        'required-assets',
        'Visual inputs',
        `${slot.title} is required before Generate can run.`,
        `Choose an asset for ${slot.title}`,
      );
    }
    if (!binding) continue;
    const connected = graph.edges.some((edge) => (
      edge.source.nodeId === slot.id && artDirectionIds.has(edge.target.nodeId)
    ));
    if (!connected) {
      return blocked(
        'required-assets',
        'Visual inputs',
        `${slot.title} has an asset but is not connected to Art Direction.`,
        `Reconnect ${slot.title} to Art Direction`,
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
  const requiredCount = slots.filter((node) => templateSlots.length === 0 || node.config.required === true).length;
  if (requiredCount === 0 && slots.length === 0) {
    return blocked('required-assets', 'Visual inputs', 'Add at least one visual input before Generate can run.', 'Add a visual input');
  }
  return complete(
    'required-assets',
    'Visual inputs',
    requiredCount > 0 ? `${requiredCount} required visual ${requiredCount === 1 ? 'input is' : 'inputs are'} ready.` : 'Visual inputs are ready.',
  );
}

function outputReadiness(graph: WorkflowGraphV2): WorkflowReadinessItem {
  const outputs = graph.nodes.filter((node) => node.type === 'output');
  if (outputs.length === 0) {
    return blocked('outputs', 'Outputs', 'Add at least one configured output.', 'Add an output');
  }
  const artDirectionIds = new Set(graph.nodes.filter((node) => node.type === 'art-direction').map((node) => node.id));
  for (const output of outputs) {
    const width = output.config.finalWidth;
    const height = output.config.finalHeight;
    if (typeof width !== 'number' || width <= 0 || typeof height !== 'number' || height <= 0) {
      return blocked('outputs', 'Outputs', `${output.title} needs valid dimensions.`, `Configure ${output.title}`);
    }
    const connected = graph.edges.some((edge) => (
      edge.target.nodeId === output.id && artDirectionIds.has(edge.source.nodeId)
    ));
    if (!connected) {
      return blocked('outputs', 'Outputs', `${output.title} is not connected to Art Direction.`, `Reconnect ${output.title}`);
    }
  }
  return complete('outputs', 'Outputs', `${outputs.length} configured ${outputs.length === 1 ? 'output is' : 'outputs are'} ready.`);
}

function briefReadiness(
  graph: WorkflowGraphV2,
  brief: WorkflowNodeV2 | undefined,
  artDirection: WorkflowNodeV2 | undefined,
): WorkflowReadinessItem {
  const objective = brief ? textConfig(brief, 'objective') : textConfig(artDirection, 'prompt');
  if (!objective) {
    return blocked('brief', 'Creative brief', 'Describe the outcome this workflow should create.', 'Write the campaign brief');
  }
  if (brief && artDirection) {
    const requiredPromptPort = artDirection.ports.inputs.find((port) => port.required && port.dataType === 'prompt');
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

export function workflowReadiness(
  inputGraph: WorkflowGraphV2,
  options: WorkflowReadinessOptions,
): WorkflowReadiness {
  const graph = new WorkflowGraphDomain(inputGraph).graph;
  const brief = graph.nodes.find((node) => node.type === 'brief');
  const artDirection = graph.nodes.find((node) => node.type === 'art-direction');
  const items: WorkflowReadinessItem[] = [
    options.desktop
      ? complete('desktop', 'Desktop app', 'Workflow generation is available.')
      : blocked('desktop', 'Desktop app', 'Generation runs in the PaintNode desktop app.', 'Open the desktop app'),
    options.projectPath
      ? complete('project-folder', 'Project folder', options.projectPath)
      : blocked('project-folder', 'Project folder', 'Generated assets and workflow files need a project folder.', 'Choose or create a project folder'),
    assetReadiness(graph, options),
    briefReadiness(graph, brief, artDirection),
    textConfig(artDirection, 'prompt') || textConfig(artDirection, 'guidance')
      ? complete('art-direction', 'Art direction', 'Visual guidance is defined.')
      : blocked('art-direction', 'Art direction', 'Add composition, lighting, colour, or style guidance.', 'Add art-direction guidance'),
    outputReadiness(graph),
  ];
  const nextAction = items.find((item) => item.status === 'blocked') ?? null;
  return { ready: nextAction === null, items, nextAction };
}
