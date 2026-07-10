export const WORKFLOW_GRAPH_VERSION = 2 as const;

export type WorkflowNodeType =
  | 'input'
  | 'brief'
  | 'art-direction'
  | 'transform'
  | 'review'
  | 'output'
  | 'unsupported';

export type WorkflowPortDataType =
  | 'image'
  | 'image-collection'
  | 'mask'
  | 'prompt'
  | 'layout'
  | 'layered-document'
  | 'asset-reference'
  | 'review-decision'
  | 'unknown';

export interface WorkflowPoint {
  x: number;
  y: number;
}

export interface WorkflowSize {
  width: number;
  height: number;
}

export interface WorkflowNodePort {
  id: string;
  label: string;
  dataType: WorkflowPortDataType;
  required?: boolean;
  multiple?: boolean;
}

export interface WorkflowNodeV2 {
  id: string;
  type: WorkflowNodeType;
  title: string;
  position: WorkflowPoint;
  size: WorkflowSize;
  color: string;
  ports: {
    inputs: WorkflowNodePort[];
    outputs: WorkflowNodePort[];
  };
  config: Record<string, unknown>;
  runRecordIds: string[];
}

export interface WorkflowEdgeEndpoint {
  nodeId: string;
  portId: string;
}

export interface WorkflowEdgeV2 {
  id: string;
  source: WorkflowEdgeEndpoint;
  target: WorkflowEdgeEndpoint;
}

export interface WorkflowAssetReference {
  id: string;
  role: 'source' | 'output';
  assetId: string | null;
  relativePath: string | null;
}

export type WorkflowRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkflowMinimalRunReference {
  id: string;
  nodeId: string;
  status?: string;
}

export interface WorkflowRunSourceAsset {
  nodeId: string;
  assetId: string;
  relativePath: string;
  contentHash: string;
}

export interface WorkflowRunPrompt {
  brief: string;
  artDirection: string;
  instructions: string;
  constraints: string[];
  effectivePromptHash: string;
}

export interface WorkflowRunProvider {
  id: string;
  model: string | null;
  effectiveOptions: Record<string, unknown>;
}

export interface WorkflowRunExecutor {
  id: string;
  version: string;
  requestSchemaVersion: string;
}

export interface WorkflowRunOutput {
  assetReferenceId: string;
  assetId: string;
  relativePath: string;
  contentHash: string;
  acceptedAt?: number;
}

export interface WorkflowRunRecordV1 extends WorkflowMinimalRunReference {
  recordVersion: 1;
  status: WorkflowRunStatus;
  attempt: number;
  workflowRevision: string;
  nodeRevision: string;
  materialKey: string;
  sourceAssets: WorkflowRunSourceAsset[];
  prompt: WorkflowRunPrompt;
  provider: WorkflowRunProvider;
  executor: WorkflowRunExecutor;
  startedAt: number;
  finishedAt: number | null;
  outputs: WorkflowRunOutput[];
  failure?: { code: string; message: string };
  projectTaskId?: string;
  debugArtifactReference?: string;
}

export type WorkflowRunReference = WorkflowMinimalRunReference | WorkflowRunRecordV1;

export interface WorkflowMigrationRecord {
  from: number;
  to: number;
}

export interface WorkflowGraphV2 {
  version: typeof WORKFLOW_GRAPH_VERSION;
  id: string;
  metadata: {
    name: string;
    sourceVersion: number | null;
    migrations: WorkflowMigrationRecord[];
  };
  viewport: {
    panX: number;
    panY: number;
    zoom: number;
  };
  nodes: WorkflowNodeV2[];
  edges: WorkflowEdgeV2[];
  assetReferences: WorkflowAssetReference[];
  runRecords: WorkflowRunReference[];
}

export interface WorkflowValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface WorkflowParseResult {
  ok: boolean;
  value?: WorkflowGraphV2;
  issues: WorkflowValidationIssue[];
}

const nodeTypes = new Set<WorkflowNodeType>([
  'input',
  'brief',
  'art-direction',
  'transform',
  'review',
  'output',
  'unsupported',
]);

const portDataTypes = new Set<WorkflowPortDataType>([
  'image',
  'image-collection',
  'mask',
  'prompt',
  'layout',
  'layered-document',
  'asset-reference',
  'review-decision',
  'unknown',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clonePersistedValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clonePersistedValue(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePersistedValue(item)])) as T;
  }
  return value;
}

function readString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: WorkflowValidationIssue[],
): string {
  const value = record[key];
  if (typeof value === 'string' && value.length > 0) return value;
  issues.push({ path, message: `${path} must be a non-empty string`, severity: 'error' });
  return '';
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: WorkflowValidationIssue[],
): number {
  const value = record[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  issues.push({ path, message: `${path} must be a finite number`, severity: 'error' });
  return 0;
}

function parsePort(value: unknown, path: string, issues: WorkflowValidationIssue[]): WorkflowNodePort {
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return { id: '', label: '', dataType: 'unknown' };
  }
  const rawDataType = value.dataType;
  let dataType: WorkflowPortDataType = 'unknown';
  if (typeof rawDataType === 'string' && portDataTypes.has(rawDataType as WorkflowPortDataType)) {
    dataType = rawDataType as WorkflowPortDataType;
  } else {
    issues.push({
      path: `${path}.dataType`,
      message: `Unsupported workflow port data type: ${String(rawDataType)}`,
      severity: 'warning',
    });
  }
  return {
    id: readString(value, 'id', `${path}.id`, issues),
    label: readString(value, 'label', `${path}.label`, issues),
    dataType,
    ...(typeof value.required === 'boolean' ? { required: value.required } : {}),
    ...(typeof value.multiple === 'boolean' ? { multiple: value.multiple } : {}),
  };
}

function parsePortList(value: unknown, path: string, issues: WorkflowValidationIssue[]): WorkflowNodePort[] {
  if (!Array.isArray(value)) {
    issues.push({ path, message: `${path} must be an array`, severity: 'error' });
    return [];
  }
  return value.map((port, index) => parsePort(port, `${path}[${index}]`, issues));
}

function parseNode(value: unknown, index: number, issues: WorkflowValidationIssue[]): WorkflowNodeV2 {
  const path = `nodes[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return {
      id: '',
      type: 'unsupported',
      title: '',
      position: { x: 0, y: 0 },
      size: { width: 0, height: 0 },
      color: '',
      ports: { inputs: [], outputs: [] },
      config: { unsupportedType: 'invalid', rawConfig: {} },
      runRecordIds: [],
    };
  }

  const rawType = value.type;
  const knownType = typeof rawType === 'string' && nodeTypes.has(rawType as WorkflowNodeType);
  const type: WorkflowNodeType = knownType ? rawType as WorkflowNodeType : 'unsupported';
  const rawConfig = isRecord(value.config) ? clonePersistedValue(value.config) : {};
  const rawPorts = isRecord(value.ports) ? clonePersistedValue(value.ports) : {};
  if (!knownType) {
    issues.push({
      path: `${path}.type`,
      message: `Unsupported workflow node type: ${String(rawType)}`,
      severity: 'warning',
    });
  }

  const position = isRecord(value.position) ? value.position : {};
  if (!isRecord(value.position)) {
    issues.push({ path: `${path}.position`, message: `${path}.position must be an object`, severity: 'error' });
  }
  const size = isRecord(value.size) ? value.size : {};
  if (!isRecord(value.size)) {
    issues.push({ path: `${path}.size`, message: `${path}.size must be an object`, severity: 'error' });
  }
  const ports = isRecord(value.ports) ? value.ports : {};
  if (!isRecord(value.ports)) {
    issues.push({ path: `${path}.ports`, message: `${path}.ports must be an object`, severity: 'error' });
  }
  const runRecordIds = Array.isArray(value.runRecordIds)
    ? value.runRecordIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (!Array.isArray(value.runRecordIds)) {
    issues.push({
      path: `${path}.runRecordIds`,
      message: `${path}.runRecordIds must be an array`,
      severity: 'error',
    });
  }

  return {
    id: readString(value, 'id', `${path}.id`, issues),
    type,
    title: readString(value, 'title', `${path}.title`, issues),
    position: {
      x: readNumber(position, 'x', `${path}.position.x`, issues),
      y: readNumber(position, 'y', `${path}.position.y`, issues),
    },
    size: {
      width: readNumber(size, 'width', `${path}.size.width`, issues),
      height: readNumber(size, 'height', `${path}.size.height`, issues),
    },
    color: readString(value, 'color', `${path}.color`, issues),
    ports: {
      inputs: parsePortList(ports.inputs, `${path}.ports.inputs`, issues),
      outputs: parsePortList(ports.outputs, `${path}.ports.outputs`, issues),
    },
    config: knownType
      ? rawConfig
      : {
          unsupportedType: String(rawType ?? 'unknown'),
          rawConfig,
          rawPorts,
          rawNode: clonePersistedValue(value),
        },
    runRecordIds,
  };
}

function parseEndpoint(value: unknown, path: string, issues: WorkflowValidationIssue[]): WorkflowEdgeEndpoint {
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return { nodeId: '', portId: '' };
  }
  return {
    nodeId: readString(value, 'nodeId', `${path}.nodeId`, issues),
    portId: readString(value, 'portId', `${path}.portId`, issues),
  };
}

function parseEdge(value: unknown, index: number, issues: WorkflowValidationIssue[]): WorkflowEdgeV2 {
  const path = `edges[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return { id: '', source: { nodeId: '', portId: '' }, target: { nodeId: '', portId: '' } };
  }
  return {
    id: readString(value, 'id', `${path}.id`, issues),
    source: parseEndpoint(value.source, `${path}.source`, issues),
    target: parseEndpoint(value.target, `${path}.target`, issues),
  };
}

function parseAssetReference(
  value: unknown,
  index: number,
  issues: WorkflowValidationIssue[],
): WorkflowAssetReference {
  const path = `assetReferences[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return { id: '', role: 'source', assetId: null, relativePath: null };
  }
  const role = value.role === 'output' ? 'output' : 'source';
  if (value.role !== 'source' && value.role !== 'output') {
    issues.push({ path: `${path}.role`, message: `${path}.role must be source or output`, severity: 'error' });
  }
  return {
    id: readString(value, 'id', `${path}.id`, issues),
    role,
    assetId: typeof value.assetId === 'string' ? value.assetId : null,
    relativePath: typeof value.relativePath === 'string' ? value.relativePath : null,
  };
}

function parseRunSourceAsset(value: unknown, path: string, issues: WorkflowValidationIssue[]): WorkflowRunSourceAsset {
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return { nodeId: '', assetId: '', relativePath: '', contentHash: '' };
  }
  return {
    nodeId: readString(value, 'nodeId', `${path}.nodeId`, issues),
    assetId: readString(value, 'assetId', `${path}.assetId`, issues),
    relativePath: readString(value, 'relativePath', `${path}.relativePath`, issues),
    contentHash: readString(value, 'contentHash', `${path}.contentHash`, issues),
  };
}

function parseRunOutput(value: unknown, path: string, issues: WorkflowValidationIssue[]): WorkflowRunOutput {
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return { assetReferenceId: '', assetId: '', relativePath: '', contentHash: '' };
  }
  return {
    assetReferenceId: readString(value, 'assetReferenceId', `${path}.assetReferenceId`, issues),
    assetId: readString(value, 'assetId', `${path}.assetId`, issues),
    relativePath: readString(value, 'relativePath', `${path}.relativePath`, issues),
    contentHash: readString(value, 'contentHash', `${path}.contentHash`, issues),
    ...(typeof value.acceptedAt === 'number' && Number.isFinite(value.acceptedAt)
      ? { acceptedAt: value.acceptedAt }
      : {}),
  };
}

function parseRunReference(value: unknown, index: number, issues: WorkflowValidationIssue[]): WorkflowRunReference {
  const path = `runRecords[${index}]`;
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return { id: '', nodeId: '' };
  }
  const minimal: WorkflowMinimalRunReference = {
    id: readString(value, 'id', `${path}.id`, issues),
    nodeId: readString(value, 'nodeId', `${path}.nodeId`, issues),
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
  };
  if (value.recordVersion === undefined) return minimal;
  if (value.recordVersion !== 1) {
    issues.push({ path: `${path}.recordVersion`, message: `${path}.recordVersion must be 1`, severity: 'error' });
  }
  const statuses = new Set<WorkflowRunStatus>(['running', 'succeeded', 'failed', 'cancelled']);
  const status = typeof value.status === 'string' && statuses.has(value.status as WorkflowRunStatus)
    ? value.status as WorkflowRunStatus
    : 'failed';
  if (status !== value.status) {
    issues.push({ path: `${path}.status`, message: `${path}.status is not supported`, severity: 'error' });
  }
  const sourceAssets = Array.isArray(value.sourceAssets) ? value.sourceAssets : [];
  if (!Array.isArray(value.sourceAssets)) {
    issues.push({ path: `${path}.sourceAssets`, message: `${path}.sourceAssets must be an array`, severity: 'error' });
  }
  const outputs = Array.isArray(value.outputs) ? value.outputs : [];
  if (!Array.isArray(value.outputs)) {
    issues.push({ path: `${path}.outputs`, message: `${path}.outputs must be an array`, severity: 'error' });
  }
  const prompt = isRecord(value.prompt) ? value.prompt : {};
  if (!isRecord(value.prompt)) {
    issues.push({ path: `${path}.prompt`, message: `${path}.prompt must be an object`, severity: 'error' });
  }
  const constraints = Array.isArray(prompt.constraints)
    ? prompt.constraints.filter((item): item is string => typeof item === 'string')
    : [];
  if (!Array.isArray(prompt.constraints) || constraints.length !== prompt.constraints.length) {
    issues.push({ path: `${path}.prompt.constraints`, message: `${path}.prompt.constraints must contain strings`, severity: 'error' });
  }
  const provider = isRecord(value.provider) ? value.provider : {};
  if (!isRecord(value.provider)) {
    issues.push({ path: `${path}.provider`, message: `${path}.provider must be an object`, severity: 'error' });
  }
  const effectiveOptions = isRecord(provider.effectiveOptions) ? clonePersistedValue(provider.effectiveOptions) : {};
  if (!isRecord(provider.effectiveOptions)) {
    issues.push({ path: `${path}.provider.effectiveOptions`, message: `${path}.provider.effectiveOptions must be an object`, severity: 'error' });
  }
  const executor = isRecord(value.executor) ? value.executor : {};
  if (!isRecord(value.executor)) {
    issues.push({ path: `${path}.executor`, message: `${path}.executor must be an object`, severity: 'error' });
  }
  const failure = value.failure === undefined ? undefined : isRecord(value.failure) ? value.failure : {};
  if (value.failure !== undefined && !isRecord(value.failure)) {
    issues.push({ path: `${path}.failure`, message: `${path}.failure must be an object`, severity: 'error' });
  }
  const finishedAt = value.finishedAt === null
    ? null
    : readNumber(value, 'finishedAt', `${path}.finishedAt`, issues);
  return {
    recordVersion: 1,
    id: minimal.id,
    nodeId: minimal.nodeId,
    status,
    attempt: readNumber(value, 'attempt', `${path}.attempt`, issues),
    workflowRevision: readString(value, 'workflowRevision', `${path}.workflowRevision`, issues),
    nodeRevision: readString(value, 'nodeRevision', `${path}.nodeRevision`, issues),
    materialKey: readString(value, 'materialKey', `${path}.materialKey`, issues),
    sourceAssets: sourceAssets.map((asset, sourceIndex) => parseRunSourceAsset(asset, `${path}.sourceAssets[${sourceIndex}]`, issues)),
    prompt: {
      brief: readString(prompt, 'brief', `${path}.prompt.brief`, issues),
      artDirection: readString(prompt, 'artDirection', `${path}.prompt.artDirection`, issues),
      instructions: readString(prompt, 'instructions', `${path}.prompt.instructions`, issues),
      constraints,
      effectivePromptHash: readString(prompt, 'effectivePromptHash', `${path}.prompt.effectivePromptHash`, issues),
    },
    provider: {
      id: readString(provider, 'id', `${path}.provider.id`, issues),
      model: provider.model === null || typeof provider.model === 'string' ? provider.model : null,
      effectiveOptions,
    },
    executor: {
      id: readString(executor, 'id', `${path}.executor.id`, issues),
      version: readString(executor, 'version', `${path}.executor.version`, issues),
      requestSchemaVersion: readString(executor, 'requestSchemaVersion', `${path}.executor.requestSchemaVersion`, issues),
    },
    startedAt: readNumber(value, 'startedAt', `${path}.startedAt`, issues),
    finishedAt,
    outputs: outputs.map((output, outputIndex) => parseRunOutput(output, `${path}.outputs[${outputIndex}]`, issues)),
    ...(failure ? {
      failure: {
        code: readString(failure, 'code', `${path}.failure.code`, issues),
        message: readString(failure, 'message', `${path}.failure.message`, issues),
      },
    } : {}),
    ...(typeof value.projectTaskId === 'string' ? { projectTaskId: value.projectTaskId } : {}),
    ...(typeof value.debugArtifactReference === 'string' ? { debugArtifactReference: value.debugArtifactReference } : {}),
  };
}

function parseMigrations(value: unknown, issues: WorkflowValidationIssue[]): WorkflowMigrationRecord[] {
  if (!Array.isArray(value)) {
    issues.push({
      path: 'metadata.migrations',
      message: 'metadata.migrations must be an array',
      severity: 'error',
    });
    return [];
  }
  return value.map((item, index) => {
    const path = `metadata.migrations[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path, message: `${path} must be an object`, severity: 'error' });
      return { from: 0, to: 0 };
    }
    return {
      from: readNumber(item, 'from', `${path}.from`, issues),
      to: readNumber(item, 'to', `${path}.to`, issues),
    };
  });
}

export function parseWorkflowGraphV2(input: unknown): WorkflowParseResult {
  const issues: WorkflowValidationIssue[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      issues: [{ path: '', message: 'Workflow graph must be an object', severity: 'error' }],
    };
  }

  if (input.version !== WORKFLOW_GRAPH_VERSION) {
    issues.push({
      path: 'version',
      message: `Expected workflow graph version ${WORKFLOW_GRAPH_VERSION}`,
      severity: 'error',
    });
  }
  const id = readString(input, 'id', 'id', issues);

  const metadata = isRecord(input.metadata) ? input.metadata : {};
  if (!isRecord(input.metadata)) {
    issues.push({ path: 'metadata', message: 'metadata must be an object', severity: 'error' });
  }
  const viewport = isRecord(input.viewport) ? input.viewport : {};
  if (!isRecord(input.viewport)) {
    issues.push({ path: 'viewport', message: 'viewport must be an object', severity: 'error' });
  }

  const rawNodes = Array.isArray(input.nodes) ? input.nodes : [];
  if (!Array.isArray(input.nodes)) {
    issues.push({ path: 'nodes', message: 'nodes must be an array', severity: 'error' });
  }
  const rawEdges = Array.isArray(input.edges) ? input.edges : [];
  if (!Array.isArray(input.edges)) {
    issues.push({ path: 'edges', message: 'edges must be an array', severity: 'error' });
  }
  const rawAssets = Array.isArray(input.assetReferences) ? input.assetReferences : [];
  if (!Array.isArray(input.assetReferences)) {
    issues.push({ path: 'assetReferences', message: 'assetReferences must be an array', severity: 'error' });
  }
  const rawRuns = Array.isArray(input.runRecords) ? input.runRecords : [];
  if (!Array.isArray(input.runRecords)) {
    issues.push({ path: 'runRecords', message: 'runRecords must be an array', severity: 'error' });
  }

  const sourceVersion = metadata.sourceVersion;
  if (sourceVersion !== null && !(typeof sourceVersion === 'number' && Number.isFinite(sourceVersion))) {
    issues.push({
      path: 'metadata.sourceVersion',
      message: 'metadata.sourceVersion must be a finite number or null',
      severity: 'error',
    });
  }

  const value: WorkflowGraphV2 = {
    version: WORKFLOW_GRAPH_VERSION,
    id,
    metadata: {
      name: readString(metadata, 'name', 'metadata.name', issues),
      sourceVersion: sourceVersion === null || typeof sourceVersion === 'number' ? sourceVersion : null,
      migrations: parseMigrations(metadata.migrations, issues),
    },
    viewport: {
      panX: readNumber(viewport, 'panX', 'viewport.panX', issues),
      panY: readNumber(viewport, 'panY', 'viewport.panY', issues),
      zoom: readNumber(viewport, 'zoom', 'viewport.zoom', issues),
    },
    nodes: rawNodes.map((node, index) => parseNode(node, index, issues)),
    edges: rawEdges.map((edge, index) => parseEdge(edge, index, issues)),
    assetReferences: rawAssets.map((asset, index) => parseAssetReference(asset, index, issues)),
    runRecords: rawRuns.map((run, index) => parseRunReference(run, index, issues)),
  };

  if (issues.some((issue) => issue.severity === 'error')) return { ok: false, issues };
  return { ok: true, value, issues };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function serializeWorkflowGraphV2(graph: WorkflowGraphV2): string {
  const parsed = parseWorkflowGraphV2(graph);
  if (!parsed.ok || !parsed.value) {
    const detail = parsed.issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`).join('; ');
    throw new Error(`Cannot serialize invalid WorkflowGraph v2: ${detail}`);
  }
  return JSON.stringify(stableValue(parsed.value), null, 2);
}
