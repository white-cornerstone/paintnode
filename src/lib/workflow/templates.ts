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
    description: 'Start with an empty board and add only the nodes your workflow needs.',
    brief: '',
    artDirection: '',
    slots: [],
    outputs: [],
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

function campaignGenerateTransform(
  id: string,
  title: string,
  instructions: string,
  position: { x: number; y: number },
  templateRole: string,
): WorkflowNodeV2 {
  return createCreatorNode('transform', {
    id,
    title,
    position,
    config: {
      templateRole,
      capability: 'generate',
      instructions,
    },
  });
}

function campaignReviewNode(): WorkflowNodeV2 {
  return createCreatorNode('review', {
    id: 'review-campaign-direction',
    title: 'Choose Campaign Direction',
    position: { x: 1195, y: 50 },
    config: {
      templateRole: 'campaign-direction-review',
      mode: 'human',
      instructions: 'Choose the strongest campaign direction before adapting it to every publishing format.',
    },
  });
}

export function instantiateWorkflowTemplate(
  id: WorkflowTemplateId,
  options: { name?: string; graphId?: string } = {},
): WorkflowGraphV2 {
  const definition = workflowTemplate(id);
  if (id === 'blank') {
    return new WorkflowGraphDomain({
      version: WORKFLOW_GRAPH_VERSION,
      id: options.graphId?.trim() || freshWorkflowGraphId(),
      metadata: {
        name: options.name?.trim() || definition.name,
        sourceVersion: null,
        migrations: [],
      },
      viewport: { panX: 10, panY: 10, zoom: 1 },
      nodes: [],
      edges: [],
      assetReferences: [],
      runRecords: [],
    }).graph;
  }
  const slots = definition.slots.map(assetSlotNode);
  const brief = briefNode(definition);
  const artDirection = artDirectionNode(definition);
  const campaignNodes = id === 'campaign-composer' ? {
    concept: campaignGenerateTransform(
      'transform-generate-square', 'Generate Concepts',
      'Generate coordinated Square 1:1 campaign concepts from the Product, Brief, and Art Direction.',
      { x: 925, y: 50 }, 'campaign-generate-concepts',
    ),
    review: campaignReviewNode(),
    portrait: campaignGenerateTransform(
      'transform-generate-portrait', 'Generate Portrait',
      'Adapt the accepted campaign direction to the configured Portrait 4:5 output while preserving product and brand identity.',
      { x: 1465, y: 306 }, 'campaign-generate-portrait',
    ),
    landscape: campaignGenerateTransform(
      'transform-generate-landscape', 'Generate Landscape',
      'Adapt the accepted campaign direction to the configured Landscape 16:9 output while preserving product and brand identity.',
      { x: 1465, y: 562 }, 'campaign-generate-landscape',
    ),
  } : null;
  const outputs = definition.outputs.map((output, index) => outputNode(output, index, campaignNodes ? 1735 : 925));
  const graph: WorkflowGraphV2 = {
    version: WORKFLOW_GRAPH_VERSION,
    id: options.graphId?.trim() || freshWorkflowGraphId(),
    metadata: {
      name: options.name?.trim() || definition.name,
      sourceVersion: null,
      migrations: [],
    },
    viewport: { panX: 10, panY: 10, zoom: campaignNodes ? 0.44 : 0.72 },
    nodes: [
      ...slots, brief, artDirection,
      ...(campaignNodes ? [campaignNodes.concept, campaignNodes.review, campaignNodes.portrait, campaignNodes.landscape] : []),
      ...outputs,
    ],
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
      ...(campaignNodes ? [
        {
          id: 'edge-composition-transform-generate-square',
          source: { nodeId: 'composition', portId: 'layout' },
          target: { nodeId: campaignNodes.concept.id, portId: 'source' },
        },
        {
          id: 'edge-transform-generate-square-review-campaign-direction',
          source: { nodeId: campaignNodes.concept.id, portId: 'result' },
          target: { nodeId: campaignNodes.review.id, portId: 'candidates' },
        },
        {
          id: 'edge-review-campaign-direction-output-square',
          source: { nodeId: campaignNodes.review.id, portId: 'selected' },
          target: { nodeId: 'output-square', portId: 'source' },
        },
        {
          id: 'edge-review-campaign-direction-transform-generate-portrait',
          source: { nodeId: campaignNodes.review.id, portId: 'selected' },
          target: { nodeId: campaignNodes.portrait.id, portId: 'source' },
        },
        {
          id: 'edge-transform-generate-portrait-output-portrait',
          source: { nodeId: campaignNodes.portrait.id, portId: 'result' },
          target: { nodeId: 'output-portrait', portId: 'source' },
        },
        {
          id: 'edge-review-campaign-direction-transform-generate-landscape',
          source: { nodeId: campaignNodes.review.id, portId: 'selected' },
          target: { nodeId: campaignNodes.landscape.id, portId: 'source' },
        },
        {
          id: 'edge-transform-generate-landscape-output-landscape',
          source: { nodeId: campaignNodes.landscape.id, portId: 'result' },
          target: { nodeId: 'output-landscape', portId: 'source' },
        },
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
