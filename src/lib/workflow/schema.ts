export const WORKFLOW_GRAPH_VERSION = 2 as const;

import {
  isProjectRelativeWorkflowReference,
  safeWorkflowIdentifier,
  safeWorkflowModel,
  safeWorkflowProviderOptions,
  validateWorkflowRunRecordSafety,
} from './provenanceSafety';

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
  name: string;
  role: string;
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

export interface WorkflowRunTarget {
  nodeId: string;
  title: string;
  width: number;
  height: number;
}

export interface WorkflowCandidateLineageV1 {
  version: 1;
  branchGroupId: string;
  candidateId: string;
  ordinal: number;
  requestedCount: number;
  sourceNodeId: string;
  attempt: number;
}

export interface WorkflowReviewPromotionV1 {
  version: 1;
  id: string;
  reviewNodeId: string;
  sourceNodeId: string;
  branchGroupId: string;
  candidateId: string;
  candidateRunId: string;
  assetReferenceId: string;
  assetId: string;
  relativePath: string;
  contentHash: string;
  materialKey: string;
  reviewNodeRevision: string;
  promotedAt: number;
  supersedesPromotionId?: string;
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
  target: WorkflowRunTarget;
  startedAt: number;
  finishedAt: number | null;
  outputs: WorkflowRunOutput[];
  candidate?: WorkflowCandidateLineageV1;
  retryOfRunId?: string;
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
  /** Append-only review decisions. Missing in early v2 files and preserved as absent. */
  reviewPromotions?: WorkflowReviewPromotionV1[];
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

export function normalizeInterruptedWorkflowRuns(graph: WorkflowGraphV2): WorkflowGraphV2 {
  if (!graph.runRecords.some((record) => (
    'recordVersion' in record && record.recordVersion === 1 && record.status === 'running'
  ))) return graph;
  return {
    ...graph,
    runRecords: graph.runRecords.map((record) => {
      if (!('recordVersion' in record) || record.recordVersion !== 1 || record.status !== 'running') return record;
      return {
        ...record,
        status: 'failed' as const,
        finishedAt: record.startedAt,
        outputs: [],
        failure: {
          code: 'INTERRUPTED',
          message: 'The attempt was interrupted before it completed.',
        },
      };
    }),
  };
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

function readNonnegativeInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: WorkflowValidationIssue[],
): number {
  const value = record[key];
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  issues.push({ path, message: `${path} must be a nonnegative safe integer`, severity: 'error' });
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
    return { nodeId: '', assetId: '', relativePath: '', contentHash: '', name: '', role: '' };
  }
  const source = {
    nodeId: readString(value, 'nodeId', `${path}.nodeId`, issues),
    assetId: readString(value, 'assetId', `${path}.assetId`, issues),
    relativePath: readString(value, 'relativePath', `${path}.relativePath`, issues),
    contentHash: readString(value, 'contentHash', `${path}.contentHash`, issues),
    name: readString(value, 'name', `${path}.name`, issues),
    role: readString(value, 'role', `${path}.role`, issues),
  };
  if (source.relativePath && !isProjectRelativeWorkflowReference(source.relativePath)) {
    issues.push({ path: `${path}.relativePath`, message: `${path}.relativePath must be project-relative`, severity: 'error' });
  }
  return source;
}

function parseRunOutput(value: unknown, path: string, issues: WorkflowValidationIssue[]): WorkflowRunOutput {
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return { assetReferenceId: '', assetId: '', relativePath: '', contentHash: '' };
  }
  const output = {
    assetReferenceId: readString(value, 'assetReferenceId', `${path}.assetReferenceId`, issues),
    assetId: readString(value, 'assetId', `${path}.assetId`, issues),
    relativePath: readString(value, 'relativePath', `${path}.relativePath`, issues),
    contentHash: readString(value, 'contentHash', `${path}.contentHash`, issues),
    ...(value.acceptedAt === undefined ? {} : {
      acceptedAt: readNonnegativeInteger(value, 'acceptedAt', `${path}.acceptedAt`, issues),
    }),
  };
  if (output.relativePath && !isProjectRelativeWorkflowReference(output.relativePath)) {
    issues.push({ path: `${path}.relativePath`, message: `${path}.relativePath must be project-relative`, severity: 'error' });
  }
  return output;
}

function parseRunTarget(value: unknown, path: string, issues: WorkflowValidationIssue[]): WorkflowRunTarget {
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return { nodeId: '', title: '', width: 0, height: 0 };
  }
  const width = readNonnegativeInteger(value, 'width', `${path}.width`, issues);
  const height = readNonnegativeInteger(value, 'height', `${path}.height`, issues);
  if (width < 1) issues.push({ path: `${path}.width`, message: `${path}.width must be positive`, severity: 'error' });
  if (height < 1) issues.push({ path: `${path}.height`, message: `${path}.height must be positive`, severity: 'error' });
  return {
    nodeId: readString(value, 'nodeId', `${path}.nodeId`, issues),
    title: readString(value, 'title', `${path}.title`, issues),
    width,
    height,
  };
}

function parseCandidateLineage(
  value: unknown,
  path: string,
  issues: WorkflowValidationIssue[],
): WorkflowCandidateLineageV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ path, message: `${path} must be an object`, severity: 'error' });
    return undefined;
  }
  const candidate: WorkflowCandidateLineageV1 = {
    version: 1,
    branchGroupId: readString(value, 'branchGroupId', `${path}.branchGroupId`, issues),
    candidateId: readString(value, 'candidateId', `${path}.candidateId`, issues),
    ordinal: readNonnegativeInteger(value, 'ordinal', `${path}.ordinal`, issues),
    requestedCount: readNonnegativeInteger(value, 'requestedCount', `${path}.requestedCount`, issues),
    sourceNodeId: readString(value, 'sourceNodeId', `${path}.sourceNodeId`, issues),
    attempt: readNonnegativeInteger(value, 'attempt', `${path}.attempt`, issues),
  };
  if (value.version !== 1) issues.push({ path: `${path}.version`, message: `${path}.version must be 1`, severity: 'error' });
  if (candidate.requestedCount < 2 || candidate.requestedCount > 6) {
    issues.push({ path: `${path}.requestedCount`, message: `${path}.requestedCount must be between 2 and 6`, severity: 'error' });
  }
  if (candidate.ordinal < 1 || candidate.ordinal > candidate.requestedCount) {
    issues.push({ path: `${path}.ordinal`, message: `${path}.ordinal must identify a requested candidate`, severity: 'error' });
  }
  if (candidate.attempt < 1) {
    issues.push({ path: `${path}.attempt`, message: `${path}.attempt must start at 1`, severity: 'error' });
  }
  return candidate;
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
  let effectiveOptions: Record<string, unknown> = {};
  try {
    effectiveOptions = safeWorkflowProviderOptions(provider.effectiveOptions);
  } catch (error) {
    issues.push({
      path: `${path}.provider.effectiveOptions`,
      message: (error as Error).message,
      severity: 'error',
    });
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
    : readNonnegativeInteger(value, 'finishedAt', `${path}.finishedAt`, issues);
  const startedAt = readNonnegativeInteger(value, 'startedAt', `${path}.startedAt`, issues);
  const parsedOutputs = outputs.map((output, outputIndex) => parseRunOutput(output, `${path}.outputs[${outputIndex}]`, issues));
  const parsedFailure = failure ? {
    code: readString(failure, 'code', `${path}.failure.code`, issues),
    message: readString(failure, 'message', `${path}.failure.message`, issues),
  } : undefined;
  const parsedCandidate = parseCandidateLineage(value.candidate, `${path}.candidate`, issues);
  if (finishedAt !== null && finishedAt < startedAt) {
    issues.push({ path: `${path}.finishedAt`, message: `${path}.finishedAt cannot precede startedAt`, severity: 'error' });
  }
  if (status === 'running' && (finishedAt !== null || parsedFailure || parsedOutputs.length > 0)) {
    issues.push({ path, message: `${path} running records cannot be finished, failed, or produce outputs`, severity: 'error' });
  }
  if (status === 'succeeded' && (finishedAt === null || parsedFailure || parsedOutputs.length === 0)) {
    issues.push({ path, message: `${path} succeeded records require outputs and no failure`, severity: 'error' });
  }
  if ((status === 'failed' || status === 'cancelled') && (finishedAt === null || !parsedFailure || parsedOutputs.length > 0)) {
    issues.push({ path, message: `${path} failed and cancelled records require a failure and no outputs`, severity: 'error' });
  }
  for (const output of parsedOutputs) {
    if (output.acceptedAt !== undefined && (
      status !== 'succeeded' || output.acceptedAt < startedAt || finishedAt === null || output.acceptedAt > finishedAt
    )) {
      issues.push({ path: `${path}.outputs`, message: `${path} acceptedAt must fall within a successful run`, severity: 'error' });
    }
  }
  if (new Set(parsedOutputs.map((output) => output.assetReferenceId)).size !== parsedOutputs.length) {
    issues.push({ path: `${path}.outputs`, message: `${path}.outputs must have unique asset references`, severity: 'error' });
  }
  if (provider.model !== null && typeof provider.model !== 'string') {
    issues.push({ path: `${path}.provider.model`, message: `${path}.provider.model must be a string or null`, severity: 'error' });
  }
  for (const [label, identifier, identifierPath] of [
    ['Run ID', minimal.id, `${path}.id`],
    ['Run node ID', minimal.nodeId, `${path}.nodeId`],
    ['Provider ID', typeof provider.id === 'string' ? provider.id : '', `${path}.provider.id`],
    ['Executor ID', typeof executor.id === 'string' ? executor.id : '', `${path}.executor.id`],
  ] as const) {
    try {
      if (identifier) safeWorkflowIdentifier(identifier, label);
    } catch (error) {
      issues.push({ path: identifierPath, message: (error as Error).message, severity: 'error' });
    }
  }
  if (typeof provider.model === 'string') {
    try {
      safeWorkflowModel(provider.model, 'Provider model');
    } catch (error) {
      issues.push({ path: `${path}.provider.model`, message: (error as Error).message, severity: 'error' });
    }
  }
  for (const [key, optional] of [
    ['projectTaskId', value.projectTaskId],
    ['debugArtifactReference', value.debugArtifactReference],
  ] as const) {
    if (optional !== undefined && typeof optional !== 'string') {
      issues.push({ path: `${path}.${key}`, message: `${path}.${key} must be a string`, severity: 'error' });
    }
  }
  if (typeof value.debugArtifactReference === 'string' && !isProjectRelativeWorkflowReference(value.debugArtifactReference)) {
    issues.push({ path: `${path}.debugArtifactReference`, message: `${path}.debugArtifactReference must be project-relative`, severity: 'error' });
  }
  if (value.retryOfRunId !== undefined && typeof value.retryOfRunId !== 'string') {
    issues.push({ path: `${path}.retryOfRunId`, message: `${path}.retryOfRunId must be a string`, severity: 'error' });
  }
  const parsed: WorkflowRunRecordV1 = {
    recordVersion: 1,
    id: minimal.id,
    nodeId: minimal.nodeId,
    status,
    attempt: readNonnegativeInteger(value, 'attempt', `${path}.attempt`, issues),
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
    target: parseRunTarget(value.target, `${path}.target`, issues),
    startedAt,
    finishedAt,
    outputs: parsedOutputs,
    ...(parsedCandidate ? { candidate: parsedCandidate } : {}),
    ...(typeof value.retryOfRunId === 'string' ? { retryOfRunId: value.retryOfRunId } : {}),
    ...(parsedFailure ? { failure: parsedFailure } : {}),
    ...(typeof value.projectTaskId === 'string' ? { projectTaskId: value.projectTaskId } : {}),
    ...(typeof value.debugArtifactReference === 'string' ? { debugArtifactReference: value.debugArtifactReference } : {}),
  };
  try {
    validateWorkflowRunRecordSafety(parsed);
  } catch (error) {
    issues.push({ path, message: (error as Error).message, severity: 'error' });
  }
  return parsed;
}

function validateRunRetryLinks(graph: WorkflowGraphV2, issues: WorkflowValidationIssue[]): void {
  for (const [index, reference] of graph.runRecords.entries()) {
    if (!('recordVersion' in reference) || reference.recordVersion !== 1 || !reference.retryOfRunId) continue;
    const path = `runRecords[${index}].retryOfRunId`;
    const prior = graph.runRecords.find((candidate) => candidate.id === reference.retryOfRunId);
    if (!prior || !('recordVersion' in prior) || prior.recordVersion !== 1) {
      issues.push({ path, message: `${path} must reference a run in the current workflow`, severity: 'error' });
      continue;
    }
    if (prior.nodeId !== reference.nodeId) {
      issues.push({ path, message: `${path} must reference an attempt on the same node`, severity: 'error' });
      continue;
    }
    if (prior.status !== 'failed' && prior.status !== 'cancelled') {
      issues.push({ path, message: `${path} must reference a failed or cancelled attempt`, severity: 'error' });
      continue;
    }
    if (!reference.candidate && prior.candidate) {
      issues.push({ path, message: `${path} normal runs cannot retry candidate branch attempts`, severity: 'error' });
      continue;
    }
    const node = graph.nodes.find((candidate) => candidate.id === reference.nodeId);
    const currentIndex = node?.runRecordIds.indexOf(reference.id) ?? -1;
    const priorIndex = node?.runRecordIds.indexOf(prior.id) ?? -1;
    if (currentIndex < 0 || priorIndex < 0 || priorIndex >= currentIndex) {
      issues.push({ path, message: `${path} must reference an earlier linked attempt on the same node`, severity: 'error' });
      continue;
    }
    if (reference.candidate && (
      !prior.candidate
      || prior.candidate.candidateId !== reference.candidate.candidateId
      || prior.candidate.branchGroupId !== reference.candidate.branchGroupId
    )) {
      issues.push({ path, message: `${path} must reference the same candidate branch`, severity: 'error' });
      continue;
    }
    const latestTerminal = node?.runRecordIds
      .slice(0, currentIndex)
      .map((id) => graph.runRecords.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is WorkflowRunRecordV1 => Boolean(
        candidate && 'recordVersion' in candidate && candidate.recordVersion === 1 && candidate.status !== 'running'
        && (reference.candidate
          ? candidate.candidate?.candidateId === reference.candidate.candidateId
          : !candidate.candidate),
      ))
      .at(-1);
    if (latestTerminal?.id !== prior.id) {
      issues.push({ path, message: `${path} must reference the latest terminal attempt`, severity: 'error' });
    }
    if (reference.candidate && reference.candidate.attempt !== prior.candidate!.attempt + 1) {
      issues.push({ path, message: `${path} candidate attempt must immediately follow the linked candidate attempt`, severity: 'error' });
    }
    const previousNodeAttempt = node?.runRecordIds
      .slice(0, currentIndex)
      .map((id) => graph.runRecords.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is WorkflowRunRecordV1 => Boolean(
        candidate && 'recordVersion' in candidate && candidate.recordVersion === 1,
      ))
      .at(-1)?.attempt ?? 0;
    if (reference.attempt !== previousNodeAttempt + 1) {
      issues.push({ path, message: `${path} retry must preserve node-global attempt order`, severity: 'error' });
    }
  }
}

function validateCandidateBranchGroups(graph: WorkflowGraphV2, issues: WorkflowValidationIssue[]): void {
  const groups = new Map<string, WorkflowRunRecordV1[]>();
  for (const node of graph.nodes) {
    let previousAttempt = 0;
    const attempts = new Set<number>();
    for (const runId of node.runRecordIds) {
      const record = graph.runRecords.find((candidate) => candidate.id === runId);
      if (!record || !('recordVersion' in record) || record.recordVersion !== 1) continue;
      if (attempts.has(record.attempt) || record.attempt <= previousAttempt) {
        issues.push({
          path: `runRecords.${record.id}.attempt`,
          message: 'Run attempts must be unique and node-global monotonic.',
          severity: 'error',
        });
      }
      attempts.add(record.attempt);
      previousAttempt = record.attempt;
      if (record.candidate) {
        const records = groups.get(record.candidate.branchGroupId) ?? [];
        records.push(record);
        groups.set(record.candidate.branchGroupId, records);
      }
    }
  }
  for (const [groupId, records] of groups) {
    const first = records[0];
    const expectedSnapshot = JSON.stringify(stableValue({
      nodeId: first.nodeId,
      materialKey: first.materialKey,
      sourceAssets: first.sourceAssets,
      prompt: first.prompt,
      provider: first.provider,
      executor: first.executor,
      target: first.target,
    }));
    const ordinals = new Map<number, string>();
    const candidateIds = new Map<string, number>();
    const candidateAttempts = new Map<string, number>();
    for (const record of records) {
      const lineage = record.candidate!;
      const path = `runRecords.${record.id}.candidate`;
      if (lineage.branchGroupId !== groupId
        || lineage.sourceNodeId !== first.nodeId
        || lineage.requestedCount !== first.candidate!.requestedCount) {
        issues.push({ path, message: 'Candidate branch group lineage must use one node and requested count.', severity: 'error' });
      }
      const snapshot = JSON.stringify(stableValue({
        nodeId: record.nodeId,
        materialKey: record.materialKey,
        sourceAssets: record.sourceAssets,
        prompt: record.prompt,
        provider: record.provider,
        executor: record.executor,
        target: record.target,
      }));
      if (snapshot !== expectedSnapshot) {
        issues.push({ path, message: 'Candidate branch group must share one exact material and provider snapshot.', severity: 'error' });
      }
      const ordinalOwner = ordinals.get(lineage.ordinal);
      const idOrdinal = candidateIds.get(lineage.candidateId);
      if ((ordinalOwner && ordinalOwner !== lineage.candidateId)
        || (idOrdinal !== undefined && idOrdinal !== lineage.ordinal)) {
        issues.push({ path, message: 'Candidate branch ordinals and IDs must have a stable one-to-one mapping.', severity: 'error' });
      }
      ordinals.set(lineage.ordinal, lineage.candidateId);
      candidateIds.set(lineage.candidateId, lineage.ordinal);
      const priorCandidateAttempt = candidateAttempts.get(lineage.candidateId) ?? 0;
      if (lineage.attempt !== priorCandidateAttempt + 1) {
        issues.push({ path, message: 'Candidate attempts must be contiguous and start at 1.', severity: 'error' });
      }
      candidateAttempts.set(lineage.candidateId, lineage.attempt);
    }
    const expectedCount = first.candidate!.requestedCount;
    if (ordinals.size !== expectedCount
      || Array.from({ length: expectedCount }, (_, index) => index + 1).some((ordinal) => !ordinals.has(ordinal))) {
      issues.push({
        path: `runRecords.candidateGroups.${groupId}`,
        message: 'Persisted candidate branch groups must contain every requested ordinal exactly once.',
        severity: 'error',
      });
    }
  }
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

function parseReviewPromotions(value: unknown, issues: WorkflowValidationIssue[]): WorkflowReviewPromotionV1[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push({ path: 'reviewPromotions', message: 'reviewPromotions must be an array', severity: 'error' });
    return [];
  }
  return value.map((item, index) => {
    const path = `reviewPromotions[${index}]`;
    if (!isRecord(item)) {
      issues.push({ path, message: `${path} must be an object`, severity: 'error' });
      return {
        version: 1, id: '', reviewNodeId: '', sourceNodeId: '', branchGroupId: '', candidateId: '',
        candidateRunId: '', assetReferenceId: '', assetId: '', relativePath: '', contentHash: '',
        materialKey: '', reviewNodeRevision: '', promotedAt: 0,
      };
    }
    if (item.version !== 1) issues.push({ path: `${path}.version`, message: 'Promotion version must be 1', severity: 'error' });
    const promotedAt = readNonnegativeInteger(item, 'promotedAt', `${path}.promotedAt`, issues);
    const promotion: WorkflowReviewPromotionV1 = {
      version: 1,
      id: readString(item, 'id', `${path}.id`, issues),
      reviewNodeId: readString(item, 'reviewNodeId', `${path}.reviewNodeId`, issues),
      sourceNodeId: readString(item, 'sourceNodeId', `${path}.sourceNodeId`, issues),
      branchGroupId: readString(item, 'branchGroupId', `${path}.branchGroupId`, issues),
      candidateId: readString(item, 'candidateId', `${path}.candidateId`, issues),
      candidateRunId: readString(item, 'candidateRunId', `${path}.candidateRunId`, issues),
      assetReferenceId: readString(item, 'assetReferenceId', `${path}.assetReferenceId`, issues),
      assetId: readString(item, 'assetId', `${path}.assetId`, issues),
      relativePath: readString(item, 'relativePath', `${path}.relativePath`, issues),
      contentHash: readString(item, 'contentHash', `${path}.contentHash`, issues),
      materialKey: readString(item, 'materialKey', `${path}.materialKey`, issues),
      reviewNodeRevision: readString(item, 'reviewNodeRevision', `${path}.reviewNodeRevision`, issues),
      promotedAt,
      ...(typeof item.supersedesPromotionId === 'string'
        ? { supersedesPromotionId: item.supersedesPromotionId }
        : {}),
    };
    if (item.supersedesPromotionId !== undefined && typeof item.supersedesPromotionId !== 'string') {
      issues.push({ path: `${path}.supersedesPromotionId`, message: 'supersedesPromotionId must be a string', severity: 'error' });
    }
    for (const [key, identifier] of [
      ['id', promotion.id], ['reviewNodeId', promotion.reviewNodeId], ['sourceNodeId', promotion.sourceNodeId],
      ['branchGroupId', promotion.branchGroupId], ['candidateId', promotion.candidateId],
      ['candidateRunId', promotion.candidateRunId], ['assetReferenceId', promotion.assetReferenceId],
      ...(promotion.supersedesPromotionId ? [['supersedesPromotionId', promotion.supersedesPromotionId] as const] : []),
    ] as const) {
      try { safeWorkflowIdentifier(identifier, `Promotion ${key}`); }
      catch (error) { issues.push({ path: `${path}.${key}`, message: (error as Error).message, severity: 'error' }); }
    }
    if (!isProjectRelativeWorkflowReference(promotion.relativePath)) {
      issues.push({ path: `${path}.relativePath`, message: 'Promotion output path must be project-relative', severity: 'error' });
    }
    for (const [key, hash] of [
      ['contentHash', promotion.contentHash], ['reviewNodeRevision', promotion.reviewNodeRevision],
    ] as const) {
      if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
        issues.push({ path: `${path}.${key}`, message: `${key} must be a canonical SHA-256 digest`, severity: 'error' });
      }
    }
    return promotion;
  });
}

function validateReviewPromotions(graph: WorkflowGraphV2, issues: WorkflowValidationIssue[]): void {
  const promotions = graph.reviewPromotions ?? [];
  const ids = new Set<string>();
  const latestByReview = new Map<string, WorkflowReviewPromotionV1>();
  for (const [index, promotion] of promotions.entries()) {
    const path = `reviewPromotions[${index}]`;
    if (ids.has(promotion.id)) issues.push({ path: `${path}.id`, message: 'Promotion IDs must be unique', severity: 'error' });
    ids.add(promotion.id);
    const prior = latestByReview.get(promotion.reviewNodeId);
    if ((prior?.id ?? undefined) !== promotion.supersedesPromotionId) {
      issues.push({ path: `${path}.supersedesPromotionId`, message: 'Promotion history must append from the prior Review decision', severity: 'error' });
    }
    if (prior && promotion.promotedAt < prior.promotedAt) {
      issues.push({ path: `${path}.promotedAt`, message: 'Promotion times must be monotonic per Review node', severity: 'error' });
    }
    latestByReview.set(promotion.reviewNodeId, promotion);
  }
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
    ...(input.reviewPromotions === undefined
      ? {}
      : { reviewPromotions: parseReviewPromotions(input.reviewPromotions, issues) }),
  };

  validateRunRetryLinks(value, issues);
  validateCandidateBranchGroups(value, issues);
  validateReviewPromotions(value, issues);

  if (issues.some((issue) => issue.severity === 'error')) return { ok: false, issues };
  return { ok: true, value, issues };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function serializeWorkflowGraphV2(graph: WorkflowGraphV2): string {
  const parsed = parseWorkflowGraphV2(normalizeInterruptedWorkflowRuns(graph));
  if (!parsed.ok || !parsed.value) {
    const detail = parsed.issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`).join('; ');
    throw new Error(`Cannot serialize invalid WorkflowGraph v2: ${detail}`);
  }
  return JSON.stringify(stableValue(parsed.value), null, 2);
}
