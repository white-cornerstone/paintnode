import { WorkflowGraphDomain } from './domain';
import { createCreatorNode } from './registry';
import { WORKFLOW_GRAPH_VERSION, type WorkflowGraphV2, type WorkflowNodeV2 } from './schema';

export type WorkflowTemplateId = 'blank' | 'asset-composition' | 'campaign-composer';

export interface WorkflowTemplateSlot {
  id: string;
  name: string;
  required: boolean;
  guidance: string;
}

export interface WorkflowTemplateOutput {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface WorkflowTemplateDefinition {
  id: WorkflowTemplateId;
  name: string;
  description: string;
  brief: string;
  artDirection: string;
  slots: readonly WorkflowTemplateSlot[];
  outputs: readonly WorkflowTemplateOutput[];
}

let workflowGraphSequence = 0;

function freshWorkflowGraphId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `workflow-${uuid}`;
  workflowGraphSequence += 1;
  return `workflow-${Date.now()}-${workflowGraphSequence}`;
}

export const WORKFLOW_TEMPLATES: readonly WorkflowTemplateDefinition[] = [
  {
    id: 'blank',
    name: 'Blank Workflow',
    description: 'Start with one required image, then write the brief and art direction yourself.',
    brief: '',
    artDirection: '',
    slots: [
      {
        id: 'primary-image',
        name: 'Primary Image',
        required: true,
        guidance: 'Choose the main image or visual reference that generation must use.',
      },
    ],
    outputs: [{ id: 'square', name: 'Square 1:1', width: 1024, height: 1024 }],
  },
  {
    id: 'asset-composition',
    name: 'Asset Composition',
    description: 'Compose a subject with optional environment and style references.',
    brief: 'Create a polished composition that keeps the subject recognisable and visually coherent.',
    artDirection: 'Preserve the subject identity. Use optional references for environment, lighting, and finish.',
    slots: [
      {
        id: 'subject',
        name: 'Subject',
        required: true,
        guidance: 'The main person, product, or object that must appear in the result.',
      },
      {
        id: 'background',
        name: 'Background',
        required: false,
        guidance: 'Optional environment or setting reference.',
      },
      {
        id: 'style-reference',
        name: 'Style Reference',
        required: false,
        guidance: 'Optional visual reference for colour, lighting, or rendering style.',
      },
    ],
    outputs: [{ id: 'square', name: 'Square 1:1', width: 1024, height: 1024 }],
  },
  {
    id: 'campaign-composer',
    name: 'Campaign Composer',
    description: 'Turn one product into a coordinated square, portrait, and landscape campaign set.',
    brief: 'Build a cohesive campaign family around the product for multiple publishing formats.',
    artDirection: 'Keep product identity and brand cues consistent across every output while adapting the composition to each format.',
    slots: [
      {
        id: 'product',
        name: 'Product',
        required: true,
        guidance: 'The product that must remain recognisable in every campaign output.',
      },
      {
        id: 'subject',
        name: 'Subject',
        required: false,
        guidance: 'Optional person, model, or supporting subject reference.',
      },
      {
        id: 'style',
        name: 'Style',
        required: false,
        guidance: 'Optional brand, lighting, colour, or art-style reference.',
      },
    ],
    outputs: [
      { id: 'square', name: 'Square 1:1', width: 1024, height: 1024 },
      { id: 'portrait', name: 'Portrait 4:5', width: 1024, height: 1280 },
      { id: 'landscape', name: 'Landscape 16:9', width: 1280, height: 720 },
    ],
  },
] as const;

export function workflowTemplate(id: WorkflowTemplateId): WorkflowTemplateDefinition {
  const definition = WORKFLOW_TEMPLATES.find((template) => template.id === id);
  if (!definition) throw new Error(`Unknown workflow template: ${id}`);
  return definition;
}

function assetSlotNode(slot: WorkflowTemplateSlot, index: number): WorkflowNodeV2 {
  return createCreatorNode('input', {
    id: `slot-${slot.id}`,
    title: slot.name,
    position: { x: 30, y: 30 + index * 274 },
    size: { width: 220, height: 250 },
    color: slot.required ? '#3f4b5c' : '#3a3c42',
    portLabels: { asset: slot.name },
    replaceConfig: true,
    config: {
      templateRole: 'asset-slot',
      slotId: slot.id,
      role: slot.guidance,
      required: slot.required,
      assetId: null,
      relativePath: null,
    },
  });
}

function briefNode(definition: WorkflowTemplateDefinition): WorkflowNodeV2 {
  const y = 30 + Math.max(0, definition.slots.length - 1) * 137;
  return createCreatorNode('brief', {
    id: 'brief',
    title: definition.id === 'campaign-composer' ? 'Campaign Brief' : 'Creative Brief',
    position: { x: 280, y },
    replaceConfig: true,
    config: {
      templateRole: 'brief',
      objective: definition.brief,
      guidance: 'State the outcome, audience, and non-negotiable content for this workflow.',
    },
  });
}

function artDirectionNode(definition: WorkflowTemplateDefinition): WorkflowNodeV2 {
  const height = Math.max(408, 220 + definition.slots.length * 32);
  return createCreatorNode('art-direction', {
    id: 'composition',
    title: 'Art Direction',
    position: { x: 555, y: 30 },
    size: { width: 340, height },
    replaceConfig: true,
    config: {
      templateRole: 'art-direction',
      legacyKind: 'composition',
      displayName: 'Art Direction',
      prompt: definition.artDirection,
      storyboardDataUrl: null,
      storyboardWidth: 1024,
      storyboardHeight: 768,
      storyboardOraPath: null,
      storyboardAnnotations: [],
      storyboardAnnotationItems: [],
      storyboardAnnotationsVisible: true,
    },
  });
}

function outputNode(output: WorkflowTemplateOutput, index: number, x = 925): WorkflowNodeV2 {
  return createCreatorNode('output', {
    id: `output-${output.id}`,
    title: output.name,
    position: { x, y: 30 + index * 256 },
    replaceConfig: true,
    config: {
      templateRole: 'configured-output',
      legacyKind: 'output',
      displayName: output.name,
      finalWidth: output.width,
      finalHeight: output.height,
      outputAssetId: null,
      outputRelativePath: null,
    },
  });
}

function campaignGenerateTransform(): WorkflowNodeV2 {
  return createCreatorNode('transform', {
    id: 'transform-generate-square',
    title: 'Generate Square',
    position: { x: 925, y: 50 },
    config: {
      templateRole: 'campaign-generate-square',
      capability: 'generate',
      instructions: 'Generate the configured Square 1:1 campaign result from the Product, Brief, and Art Direction.',
    },
  });
}

export function instantiateWorkflowTemplate(
  id: WorkflowTemplateId,
  options: { name?: string; graphId?: string } = {},
): WorkflowGraphV2 {
  const definition = workflowTemplate(id);
  const slots = definition.slots.map(assetSlotNode);
  const brief = briefNode(definition);
  const artDirection = artDirectionNode(definition);
  const campaignTransform = id === 'campaign-composer' ? campaignGenerateTransform() : null;
  const outputs = definition.outputs.map((output, index) => outputNode(output, index, campaignTransform ? 1195 : 925));
  const graph: WorkflowGraphV2 = {
    version: WORKFLOW_GRAPH_VERSION,
    id: options.graphId?.trim() || freshWorkflowGraphId(),
    metadata: {
      name: options.name?.trim() || definition.name,
      sourceVersion: null,
      migrations: [],
    },
    viewport: { panX: 10, panY: 10, zoom: campaignTransform ? 0.62 : 0.72 },
    nodes: [...slots, brief, artDirection, ...(campaignTransform ? [campaignTransform] : []), ...outputs],
    edges: [
      ...slots.map((slot) => ({
        id: `edge-${slot.id}-composition`,
        source: { nodeId: slot.id, portId: 'asset' },
        target: { nodeId: 'composition', portId: 'assets' },
      })),
      {
        id: 'edge-brief-composition',
        source: { nodeId: 'brief', portId: 'prompt' },
        target: { nodeId: 'composition', portId: 'brief' },
      },
      ...(campaignTransform ? [
        {
          id: 'edge-composition-transform-generate-square',
          source: { nodeId: 'composition', portId: 'layout' },
          target: { nodeId: campaignTransform.id, portId: 'source' },
        },
        {
          id: 'edge-transform-generate-square-output-square',
          source: { nodeId: campaignTransform.id, portId: 'result' },
          target: { nodeId: 'output-square', portId: 'source' },
        },
        ...outputs.filter((output) => output.id !== 'output-square').map((output) => ({
          id: `edge-composition-${output.id}`,
          source: { nodeId: 'composition', portId: 'layout' },
          target: { nodeId: output.id, portId: 'source' },
        })),
      ] : outputs.map((output) => ({
        id: `edge-composition-${output.id}`,
        source: { nodeId: 'composition', portId: 'layout' },
        target: { nodeId: output.id, portId: 'source' },
      }))),
    ],
    assetReferences: [],
    runRecords: [],
  };
  return new WorkflowGraphDomain(graph).graph;
}
