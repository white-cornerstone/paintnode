import {
  WORKFLOW_GRAPH_VERSION,
  type WorkflowAssetReference,
  type WorkflowEdgeV2,
  type WorkflowGraphV2,
  type WorkflowNodePort,
  type WorkflowNodeV2,
} from './schema';
import { WorkflowDomainError, WorkflowGraphDomain } from './domain';

type UnknownRecord = Record<string, unknown>;

export class WorkflowMigrationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'WorkflowMigrationError';
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) throw new WorkflowMigrationError(`${path} must be an object`, path);
  return value;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? structuredClone(value) : [];
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return normalized || 'untitled-workflow';
}

const assetOutputPort: WorkflowNodePort = {
  id: 'asset',
  label: 'Asset',
  dataType: 'asset-reference',
};

const artDirectionAssetPort: WorkflowNodePort = {
  id: 'assets',
  label: 'Assets',
  dataType: 'asset-reference',
  multiple: true,
};

const artDirectionOutputPort: WorkflowNodePort = {
  id: 'layout',
  label: 'Layout',
  dataType: 'layout',
};

const outputInputPort: WorkflowNodePort = {
  id: 'source',
  label: 'Source',
  dataType: 'layout',
  required: true,
};

function assetReference(
  id: string,
  role: WorkflowAssetReference['role'],
  assetId: unknown,
  relativePath: unknown,
): WorkflowAssetReference | null {
  const normalizedAssetId = nullableString(assetId);
  const normalizedPath = nullableString(relativePath);
  if (!normalizedAssetId && !normalizedPath) return null;
  return {
    id,
    role,
    assetId: normalizedAssetId,
    relativePath: normalizedPath,
  };
}

function migrateInputNode(
  source: UnknownRecord,
  index: number,
  assetReferences: WorkflowAssetReference[],
): WorkflowNodeV2 {
  const id = nonEmptyString(source.id, `asset-${index + 1}`);
  const referenceId = `asset-ref-${id}`;
  const reference = assetReference(referenceId, 'source', source.assetId, source.relativePath);
  if (reference) assetReferences.push(reference);
  return {
    id,
    type: 'input',
    title: nonEmptyString(source.name, `Asset ${index + 1}`),
    position: {
      x: numberValue(source.x, 80 + index * 32),
      y: numberValue(source.y, 120 + index * 32),
    },
    size: {
      width: numberValue(source.width, 205),
      height: numberValue(source.height, 190),
    },
    color: stringValue(source.color, '#3a3c42'),
    ports: { inputs: [], outputs: [{ ...assetOutputPort }] },
    config: {
      assetReferenceId: reference?.id ?? null,
      included: booleanValue(source.included, true),
      role: stringValue(source.note),
    },
    runRecordIds: [],
  };
}

function migrateArtDirection(source: UnknownRecord): WorkflowNodeV2 {
  return {
    id: 'composition',
    type: 'art-direction',
    title: nonEmptyString(source.compositionName, 'Composition'),
    position: {
      x: numberValue(source.promptX, 480),
      y: numberValue(source.promptY, 70),
    },
    size: {
      width: numberValue(source.compositionWidth, 340),
      height: numberValue(source.compositionHeight, 408),
    },
    color: stringValue(source.compositionColor, '#3a3c42'),
    ports: {
      inputs: [{ ...artDirectionAssetPort }],
      outputs: [{ ...artDirectionOutputPort }],
    },
    config: {
      prompt: stringValue(source.prompt),
      storyboard: {
        dataUrl: nullableString(source.storyboardDataUrl),
        width: numberValue(source.storyboardWidth, 1024),
        height: numberValue(source.storyboardHeight, 768),
        oraPath: nullableString(source.storyboardOraPath),
        annotations: stringArray(source.storyboardAnnotations),
        annotationItems: unknownArray(source.storyboardAnnotationItems),
        annotationsVisible: booleanValue(source.storyboardAnnotationsVisible, true),
      },
    },
    runRecordIds: [],
  };
}

function legacyOutput(source: UnknownRecord): UnknownRecord {
  return {
    id: 'output',
    name: stringValue(source.outputName),
    x: numberValue(source.outputX, 895),
    y: numberValue(source.outputY, 96),
    width: numberValue(source.outputWidth, 210),
    height: numberValue(source.outputHeight, 232),
    color: stringValue(source.outputColor, '#3a3c42'),
    finalWidth: 1024,
    finalHeight: 1024,
    outputAssetId: source.outputAssetId,
    outputRelativePath: source.outputRelativePath,
  };
}

function withLegacyOutputFallback(source: UnknownRecord, fallback: UnknownRecord): UnknownRecord {
  const result = { ...fallback };
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && value !== undefined) result[key] = value;
  }
  return result;
}

function migrateOutputNode(
  source: UnknownRecord,
  index: number,
  assetReferences: WorkflowAssetReference[],
): WorkflowNodeV2 {
  const id = nonEmptyString(source.id, index === 0 ? 'output' : `output-${index + 1}`);
  const referenceId = `asset-ref-${id}`;
  const reference = assetReference(referenceId, 'output', source.outputAssetId, source.outputRelativePath);
  if (reference) assetReferences.push(reference);
  return {
    id,
    type: 'output',
    title: nonEmptyString(source.name, index === 0 ? 'Output' : `Output ${index + 1}`),
    position: {
      x: numberValue(source.x, 895 + index * 280),
      y: numberValue(source.y, 96),
    },
    size: {
      width: numberValue(source.width, 210),
      height: numberValue(source.height, 232),
    },
    color: stringValue(source.color, '#3a3c42'),
    ports: { inputs: [{ ...outputInputPort }], outputs: [] },
    config: {
      finalWidth: numberValue(source.finalWidth, 1024),
      finalHeight: numberValue(source.finalHeight, 1024),
      assetReferenceId: reference?.id ?? null,
    },
    runRecordIds: [],
  };
}

function sourcePort(nodeId: string, nodeTypes: Map<string, WorkflowNodeV2['type']>): string {
  const type = nodeTypes.get(nodeId);
  if (type === 'input') return 'asset';
  if (type === 'art-direction') return 'layout';
  return 'output';
}

function targetPort(nodeId: string, nodeTypes: Map<string, WorkflowNodeV2['type']>): string {
  const type = nodeTypes.get(nodeId);
  if (type === 'art-direction') return 'assets';
  if (type === 'output') return 'source';
  return 'input';
}

function migrateEdges(source: UnknownRecord, nodes: WorkflowNodeV2[]): WorkflowEdgeV2[] {
  const nodeTypes = new Map(nodes.map((node) => [node.id, node.type]));
  const rawConnections = source.connections;
  if (Array.isArray(rawConnections) && rawConnections.length > 0) {
    return rawConnections.map((connection, index) => {
      const item = record(connection, `connections[${index}]`);
      const from = stringValue(item.from);
      const to = stringValue(item.to);
      return {
        id: nonEmptyString(item.id, `connection-${index + 1}`),
        source: { nodeId: from, portId: sourcePort(from, nodeTypes) },
        target: { nodeId: to, portId: targetPort(to, nodeTypes) },
      };
    });
  }

  const inputs = nodes.filter((node) => node.type === 'input' && node.config.included !== false);
  const outputs = nodes.filter((node) => node.type === 'output');
  return [
    ...inputs.map((node, index) => ({
      id: `connection-input-${index + 1}`,
      source: { nodeId: node.id, portId: 'asset' },
      target: { nodeId: 'composition', portId: 'assets' },
    })),
    ...outputs.map((node, index) => ({
      id: `connection-output-${index + 1}`,
      source: { nodeId: 'composition', portId: 'layout' },
      target: { nodeId: node.id, portId: 'source' },
    })),
  ];
}

function retainValidLegacyEdges(graph: WorkflowGraphV2, candidates: WorkflowEdgeV2[]): WorkflowEdgeV2[] {
  const domain = new WorkflowGraphDomain({ ...graph, edges: [] });
  for (const candidate of candidates) {
    try {
      domain.addEdge(candidate);
    } catch (error) {
      // WorkflowFile v1 did not enforce direction, port compatibility,
      // cardinality, or acyclicity. Keep valid dependencies in source order
      // and deterministically discard legacy links that cannot exist in v2.
      if (!(error instanceof WorkflowDomainError)) throw error;
    }
  }
  return domain.graph.edges.map((edge) => structuredClone(edge));
}

export function migrateWorkflowFileV1(input: unknown): WorkflowGraphV2 {
  const source = record(input, 'workflow');
  if (source.version !== 1) {
    throw new WorkflowMigrationError('version must be 1', 'version');
  }
  if (!Array.isArray(source.nodes)) {
    throw new WorkflowMigrationError('nodes must be an array', 'nodes');
  }

  const name = nonEmptyString(source.name, 'Untitled Workflow');
  const assetReferences: WorkflowAssetReference[] = [];
  const inputs = source.nodes.map((node, index) => migrateInputNode(record(node, `nodes[${index}]`), index, assetReferences));
  const direction = migrateArtDirection(source);

  const firstOutputFallback = legacyOutput(source);
  const rawOutputs = Array.isArray(source.outputNodes) && source.outputNodes.length > 0
    ? source.outputNodes.map((output, index) => {
      const persisted = record(output, `outputNodes[${index}]`);
      return index === 0 ? withLegacyOutputFallback(persisted, firstOutputFallback) : persisted;
    })
    : [firstOutputFallback];
  const outputs = rawOutputs.map((output, index) => migrateOutputNode(output, index, assetReferences));
  const nodes = [...inputs, direction, ...outputs];

  const graph: WorkflowGraphV2 = {
    version: WORKFLOW_GRAPH_VERSION,
    id: `workflow-${slug(name)}`,
    metadata: {
      name,
      sourceVersion: 1,
      migrations: [{ from: 1, to: WORKFLOW_GRAPH_VERSION }],
    },
    viewport: {
      panX: numberValue(source.panX, 0),
      panY: numberValue(source.panY, 0),
      zoom: numberValue(source.zoom, 1),
    },
    nodes,
    edges: [],
    assetReferences,
    runRecords: [],
  };
  graph.edges = retainValidLegacyEdges(graph, migrateEdges(source, nodes));
  // Verify the final migrated result through the same strict constructor used
  // by v2 loading before exposing it to callers.
  return structuredClone(new WorkflowGraphDomain(graph).graph);
}
