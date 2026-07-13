import type {
  WorkflowNodePort,
  WorkflowNodeType,
  WorkflowNodeV2,
  WorkflowPoint,
  WorkflowSize,
} from './schema';

export type CreatorNodeType = Exclude<WorkflowNodeType, 'unsupported'>;
export type CreatorNodeCategory = 'inputs' | 'direction' | 'actions' | 'review' | 'outputs';
export type CreatorNodeIconKey = 'image' | 'image-multiple' | 'document' | 'paint-brush' | 'sparkle' | 'review' | 'output';
export type CreatorExecutorStatus = 'not-required' | 'available' | 'draft-only';

export interface CreatorExecutorAvailability {
  status: CreatorExecutorStatus;
  capability: string | null;
  reason: string | null;
}

export interface CreatorNodeDefinition {
  type: CreatorNodeType;
  label: string;
  description: string;
  category: CreatorNodeCategory;
  iconKey: CreatorNodeIconKey;
  keywords: readonly string[];
  defaultTitle: string;
  defaultSize: WorkflowSize;
  defaultColor: string;
  ports: {
    inputs: readonly WorkflowNodePort[];
    outputs: readonly WorkflowNodePort[];
  };
  defaultConfig: Readonly<Record<string, unknown>>;
  executor: CreatorExecutorAvailability;
}

export interface CreatorNodeValidationIssue {
  path: string;
  message: string;
}

export interface CreateCreatorNodeOptions {
  id: string;
  title?: string;
  position?: WorkflowPoint;
  size?: WorkflowSize;
  color?: string;
  config?: Record<string, unknown>;
  replaceConfig?: boolean;
  portLabels?: Readonly<Record<string, string>>;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value) as T;
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value);
  }
  return value;
}

const noExecutor: CreatorExecutorAvailability = deepFreeze({
  status: 'not-required',
  capability: null,
  reason: null,
});

export const CREATOR_NODE_DEFINITIONS: readonly CreatorNodeDefinition[] = deepFreeze([
  {
    type: 'input',
    label: 'Input',
    description: 'Add an image, mask, layered document, or project asset with a clear visual role.',
    category: 'inputs',
    iconKey: 'image',
    keywords: ['asset', 'image', 'mask', 'layered document', 'project', 'visual reference', 'source'],
    defaultTitle: 'Visual Input',
    defaultSize: { width: 220, height: 240 },
    defaultColor: '#3f4b5c',
    ports: {
      inputs: [],
      outputs: [{ id: 'asset', label: 'Asset', dataType: 'asset-reference' }],
    },
    defaultConfig: { creatorRole: 'input', assetId: null, relativePath: null, role: '' },
    executor: noExecutor,
  },
  {
    type: 'brief',
    label: 'Brief',
    description: 'Describe the creative objective, audience, constraints, and intended result.',
    category: 'direction',
    iconKey: 'document',
    keywords: ['campaign', 'objective', 'direction', 'constraints', 'audience', 'prompt'],
    defaultTitle: 'Creative Brief',
    defaultSize: { width: 245, height: 220 },
    defaultColor: '#4a4059',
    ports: {
      inputs: [],
      outputs: [{ id: 'prompt', label: 'Brief', dataType: 'prompt' }],
    },
    defaultConfig: {
      creatorRole: 'brief',
      objective: '',
      guidance: 'State the outcome, audience, and non-negotiable content for this workflow.',
    },
    executor: noExecutor,
  },
  {
    type: 'art-direction',
    label: 'Art Direction',
    description: 'Guide composition, storyboard, annotations, lighting, colour, and visual style.',
    category: 'direction',
    iconKey: 'paint-brush',
    keywords: ['campaign', 'direction', 'storyboard', 'layout', 'composition', 'annotations', 'style'],
    defaultTitle: 'Art Direction',
    defaultSize: { width: 340, height: 408 },
    defaultColor: '#3a3c42',
    ports: {
      inputs: [
        { id: 'assets', label: 'Visual inputs', dataType: 'asset-reference', multiple: true },
        { id: 'brief', label: 'Brief', dataType: 'prompt', required: true },
      ],
      outputs: [{ id: 'layout', label: 'Directed composition', dataType: 'layout' }],
    },
    defaultConfig: {
      creatorRole: 'art-direction',
      displayName: 'Art Direction',
      prompt: '',
      storyboardDataUrl: null,
      storyboardWidth: 1024,
      storyboardHeight: 768,
      storyboardOraPath: null,
      storyboardAnnotations: [],
      storyboardAnnotationItems: [],
      storyboardAnnotationsVisible: true,
    },
    executor: noExecutor,
  },
  {
    type: 'extract-assets',
    label: 'Extract Assets',
    description: 'Extract labelled reusable assets from multiple source and annotated support images.',
    category: 'actions',
    iconKey: 'image-multiple',
    keywords: ['extract', 'assets', 'objects', 'index sheet', 'grid', 'fast', 'support images', 'annotations'],
    defaultTitle: 'Extract Assets',
    defaultSize: { width: 280, height: 400 },
    defaultColor: '#3d4654',
    ports: {
      inputs: [
        { id: 'sources', label: 'Source images', dataType: 'asset-reference', multiple: true },
        { id: 'support', label: 'Annotated support', dataType: 'asset-reference', multiple: true },
        { id: 'prompt', label: 'Extraction guidance', dataType: 'prompt' },
      ],
      outputs: [{ id: 'assets', label: 'Extracted assets', dataType: 'asset-reference', multiple: true }],
    },
    defaultConfig: {
      creatorRole: 'extract-assets',
      prompt: '',
      mode: 'quality',
      assetsPerSheet: 4,
      resultAssets: [],
      notes: '',
    },
    executor: {
      status: 'available',
      capability: 'extract-assets',
      reason: null,
    },
  },
  {
    type: 'transform',
    label: 'Transform',
    description: 'Configure a creator action such as generate, edit, remove background, relight, or upscale.',
    category: 'actions',
    iconKey: 'sparkle',
    keywords: ['generate', 'edit', 'remove background', 'relight', 'upscale', 'action'],
    defaultTitle: 'Generate',
    defaultSize: { width: 240, height: 480 },
    defaultColor: '#39475a',
    ports: {
      inputs: [
        { id: 'source', label: 'Directed composition', dataType: 'layout', required: true },
        { id: 'prompt', label: 'Additional guidance', dataType: 'prompt' },
      ],
      outputs: [{ id: 'result', label: 'Transformed result', dataType: 'layout' }],
    },
    defaultConfig: {
      creatorRole: 'transform',
      capability: 'generate',
      instructions: '',
      advanced: { provider: null, model: null, options: {} },
    },
    executor: {
      status: 'available',
      capability: 'generate',
      reason: null,
    },
  },
  {
    type: 'review',
    label: 'Review',
    description: 'Compare candidates and record which direction should continue downstream.',
    category: 'review',
    iconKey: 'review',
    keywords: ['compare candidates', 'approve', 'promote', 'quality gate', 'decision'],
    defaultTitle: 'Review Candidates',
    defaultSize: { width: 240, height: 536 },
    defaultColor: '#4b4057',
    ports: {
      inputs: [{ id: 'candidates', label: 'Candidates', dataType: 'layout', required: true, multiple: true }],
      outputs: [{ id: 'selected', label: 'Selected direction', dataType: 'layout' }],
    },
    defaultConfig: { creatorRole: 'review', mode: 'human', instructions: '' },
    executor: {
      status: 'available',
      capability: 'candidate-review',
      reason: null,
    },
  },
  {
    type: 'output',
    label: 'Output',
    description: 'Define final format, dimensions, filename, placement, and export intent.',
    category: 'outputs',
    iconKey: 'output',
    keywords: ['format', 'size', 'export', 'placement', 'delivery'],
    defaultTitle: 'Output',
    defaultSize: { width: 220, height: 280 },
    defaultColor: '#3a3c42',
    ports: {
      inputs: [{ id: 'source', label: 'Directed composition', dataType: 'layout', required: true }],
      outputs: [],
    },
    defaultConfig: {
      creatorRole: 'output',
      displayName: 'Output',
      finalWidth: 1024,
      finalHeight: 1024,
      outputAssetId: null,
      outputRelativePath: null,
    },
    executor: noExecutor,
  },
] satisfies CreatorNodeDefinition[]);

export function createCreatorNodeRegistry(
  definitions: readonly CreatorNodeDefinition[],
): ReadonlyMap<CreatorNodeType, CreatorNodeDefinition> {
  const registry = new Map<CreatorNodeType, CreatorNodeDefinition>();
  for (const definition of definitions) {
    if (registry.has(definition.type)) {
      throw new Error(`Duplicate creator node definition: ${definition.type}`);
    }
    registry.set(definition.type, deepFreeze(cloneValue(definition)));
  }
  return registry;
}

const definitionsByType = createCreatorNodeRegistry(CREATOR_NODE_DEFINITIONS);

export function creatorNodeDefinition(type: CreatorNodeType): CreatorNodeDefinition {
  const definition = definitionsByType.get(type);
  if (!definition) throw new Error(`Unknown creator node type: ${type}`);
  return definition;
}

export function validateCreatorNodeConfig(
  type: CreatorNodeType,
  config: Readonly<Record<string, unknown>>,
): CreatorNodeValidationIssue[] {
  const issues: CreatorNodeValidationIssue[] = [];
  const requireString = (key: string, allowEmpty = true) => {
    const value = config[key];
    if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
      issues.push({ path: `config.${key}`, message: `${key} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.` });
    }
  };
  if (type === 'input') {
    requireString('role');
  } else if (type === 'brief') {
    requireString('objective');
    requireString('guidance');
  } else if (type === 'art-direction') {
    requireString('prompt');
  } else if (type === 'extract-assets') {
    requireString('prompt');
    if (config.mode !== 'quality' && config.mode !== 'fast') {
      issues.push({ path: 'config.mode', message: 'mode must be quality or fast.' });
    }
    if (![1, 2, 4, 8].includes(config.assetsPerSheet as number)) {
      issues.push({ path: 'config.assetsPerSheet', message: 'assetsPerSheet must be 1, 2, 4, or 8.' });
    }
    if (!Array.isArray(config.resultAssets)) {
      issues.push({ path: 'config.resultAssets', message: 'resultAssets must be an array.' });
    }
  } else if (type === 'transform') {
    requireString('capability', false);
    if (typeof config.advanced !== 'object' || config.advanced === null || Array.isArray(config.advanced)) {
      issues.push({ path: 'config.advanced', message: 'advanced must be an object.' });
    }
  } else if (type === 'review') {
    requireString('mode', false);
  } else if (type === 'output') {
    for (const key of ['finalWidth', 'finalHeight'] as const) {
      if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] <= 0) {
        issues.push({ path: `config.${key}`, message: `${key} must be a positive finite number.` });
      }
    }
  }
  return issues;
}

export function createCreatorNode(type: CreatorNodeType, options: CreateCreatorNodeOptions): WorkflowNodeV2 {
  const definition = creatorNodeDefinition(type);
  const labelPort = (port: WorkflowNodePort): WorkflowNodePort => ({
    ...cloneValue(port),
    label: options.portLabels?.[port.id] ?? port.label,
  });
  const node: WorkflowNodeV2 = {
    id: options.id,
    type,
    title: options.title?.trim() || definition.defaultTitle,
    position: cloneValue(options.position ?? { x: 80, y: 80 }),
    size: cloneValue(options.size ?? definition.defaultSize),
    color: options.color ?? definition.defaultColor,
    ports: {
      inputs: definition.ports.inputs.map(labelPort),
      outputs: definition.ports.outputs.map(labelPort),
    },
    config: options.replaceConfig
      ? cloneValue(options.config ?? {})
      : { ...cloneValue(definition.defaultConfig), ...cloneValue(options.config ?? {}) },
    runRecordIds: [],
  };
  const issues = validateCreatorNodeConfig(type, node.config);
  if (issues.length > 0) {
    throw new Error(`Invalid ${definition.label} configuration: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
  }
  return node;
}
