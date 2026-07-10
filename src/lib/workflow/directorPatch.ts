import {
  WorkflowDomainError,
  WorkflowGraphDomain,
  type WorkflowGraphRevision,
} from './domain';
import { affectedWorkflowNodes } from './execution';
import {
  createCreatorNode,
  validateCreatorNodeConfig,
  type CreatorNodeType,
} from './registry';
import type { WorkflowEdgeV2, WorkflowGraphV2, WorkflowNodeV2, WorkflowPoint } from './schema';

export const WORKFLOW_DIRECTOR_PATCH_VERSION = 1 as const;

export interface WorkflowDirectorPatchAddNode {
  op: 'add-node';
  node: {
    id: string;
    type: CreatorNodeType;
    title?: string;
    position?: WorkflowPoint;
    config?: Record<string, unknown>;
  };
}

export interface WorkflowDirectorPatchRemoveNode {
  op: 'remove-node';
  nodeId: string;
}

export interface WorkflowDirectorPatchConfigureNode {
  op: 'configure-node';
  nodeId: string;
  changes: Record<string, unknown>;
}

export interface WorkflowDirectorPatchMoveNode {
  op: 'move-node';
  nodeId: string;
  position: WorkflowPoint;
}

export interface WorkflowDirectorPatchAddEdge {
  op: 'add-edge';
  edge: WorkflowEdgeV2;
}

export interface WorkflowDirectorPatchRemoveEdge {
  op: 'remove-edge';
  edgeId: string;
}

export type WorkflowDirectorPatchOperation =
  | WorkflowDirectorPatchAddNode
  | WorkflowDirectorPatchRemoveNode
  | WorkflowDirectorPatchConfigureNode
  | WorkflowDirectorPatchMoveNode
  | WorkflowDirectorPatchAddEdge
  | WorkflowDirectorPatchRemoveEdge;

export interface WorkflowDirectorPatchV1 {
  version: typeof WORKFLOW_DIRECTOR_PATCH_VERSION;
  sourceGraphRevision: WorkflowGraphRevision;
  summary: string;
  operations: WorkflowDirectorPatchOperation[];
}

export interface WorkflowDirectorPatchIssue {
  path: string;
  code: string;
  message: string;
}

export interface WorkflowDirectorPatchNodeChange {
  kind: 'added' | 'removed' | 'configured' | 'moved';
  nodeId: string;
  title: string;
  detail: string;
}

export interface WorkflowDirectorPatchEdgeChange {
  kind: 'added' | 'removed';
  edgeId: string;
  source: WorkflowEdgeV2['source'];
  target: WorkflowEdgeV2['target'];
}

export interface WorkflowDirectorPatchRequirementChange {
  nodeId: string;
  nodeTitle: string;
  portId: string;
  portLabel: string;
  before: 'absent' | 'missing' | 'ready';
  after: 'absent' | 'missing' | 'ready';
}

export interface WorkflowDirectorPatchStalenessChange {
  nodeId: string;
  nodeTitle: string;
  reason: string;
}

export interface WorkflowDirectorPatchProposal {
  patch: WorkflowDirectorPatchV1;
  graph: WorkflowGraphV2;
  sourceGraphRevision: WorkflowGraphRevision;
  targetGraphRevision: WorkflowGraphRevision;
  nodeChanges: readonly WorkflowDirectorPatchNodeChange[];
  edgeChanges: readonly WorkflowDirectorPatchEdgeChange[];
  requirementChanges: readonly WorkflowDirectorPatchRequirementChange[];
  downstreamStaleness: readonly WorkflowDirectorPatchStalenessChange[];
  canAccept: true;
}

export interface WorkflowDirectorPatchProposalResult {
  proposal: WorkflowDirectorPatchProposal | null;
  issues: readonly WorkflowDirectorPatchIssue[];
}

const creatorTypes = new Set<CreatorNodeType>([
  'input', 'brief', 'art-direction', 'transform', 'review', 'output',
]);

const configKeys: Readonly<Record<CreatorNodeType, ReadonlySet<string>>> = {
  input: new Set(['assetId', 'role', 'required']),
  brief: new Set(['objective', 'guidance']),
  'art-direction': new Set(['prompt']),
  transform: new Set(['capability', 'instructions']),
  review: new Set(['mode', 'instructions']),
  output: new Set(['finalWidth', 'finalHeight']),
};

const allConfigKeys = new Set(Object.values(configKeys).flatMap((keys) => [...keys]));
const candidateConfigKeys = new Set([
  'assetReferenceId',
  'resultAssetReferenceId',
  'resultAssetId',
  'resultRelativePath',
  'outputAssetId',
  'outputRelativePath',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value) as T;
  }
  return value;
}

function detachedFrozen<T>(value: T): T {
  return deepFreeze(cloneValue(value));
}

function addIssue(
  issues: WorkflowDirectorPatchIssue[],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ path, code, message });
}

function exactKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  issues: WorkflowDirectorPatchIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) addIssue(issues, `${path}.${key}`, 'EXTRA_KEY', `${path}.${key} is not supported.`);
  }
  for (const key of required) {
    if (!(key in value)) addIssue(issues, `${path}.${key}`, 'MISSING_KEY', `${path}.${key} is required.`);
  }
}

function requiredString(
  value: unknown,
  path: string,
  issues: WorkflowDirectorPatchIssue[],
  maxLength = 256,
): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    addIssue(issues, path, 'INVALID_STRING', `${path} must be a non-empty string no longer than ${maxLength} characters.`);
    return '';
  }
  return value.trim();
}

function point(value: unknown, path: string, issues: WorkflowDirectorPatchIssue[]): WorkflowPoint {
  if (!isRecord(value)) {
    addIssue(issues, path, 'INVALID_POSITION', `${path} must be an object.`);
    return { x: 0, y: 0 };
  }
  exactKeys(value, path, ['x', 'y'], ['x', 'y'], issues);
  const read = (key: 'x' | 'y') => {
    const coordinate = value[key];
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)) {
      addIssue(issues, `${path}.${key}`, 'INVALID_POSITION', `${path}.${key} must be a finite number.`);
      return 0;
    }
    return Object.is(coordinate, -0) ? 0 : coordinate;
  };
  return { x: read('x'), y: read('y') };
}

function endpoint(
  value: unknown,
  path: string,
  issues: WorkflowDirectorPatchIssue[],
): WorkflowEdgeV2['source'] {
  if (!isRecord(value)) {
    addIssue(issues, path, 'INVALID_ENDPOINT', `${path} must be an object.`);
    return { nodeId: '', portId: '' };
  }
  exactKeys(value, path, ['nodeId', 'portId'], ['nodeId', 'portId'], issues);
  return {
    nodeId: requiredString(value.nodeId, `${path}.nodeId`, issues),
    portId: requiredString(value.portId, `${path}.portId`, issues),
  };
}

function config(
  value: unknown,
  path: string,
  issues: WorkflowDirectorPatchIssue[],
  allowed?: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isRecord(value)) {
    addIssue(issues, path, 'INVALID_CONFIG', `${path} must be an object.`);
    return {};
  }
  const permitted = allowed ?? allConfigKeys;
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      addIssue(issues, `${path}.${key}`, 'UNKNOWN_CONFIG', `${path}.${key} is not an authoring setting supported by Director patches.`);
      continue;
    }
    const setting = value[key];
    const valid = key === 'assetId'
      ? setting === null || (typeof setting === 'string' && setting.trim().length > 0 && setting.length <= 256)
      : key === 'required'
        ? typeof setting === 'boolean'
        : key === 'finalWidth' || key === 'finalHeight'
          ? Number.isSafeInteger(setting) && (setting as number) >= 64 && (setting as number) <= 16_384
          : key === 'mode'
            ? setting === 'human' || setting === 'ai'
            : typeof setting === 'string'
              && setting.length <= 16_384
              && (key !== 'capability' || setting.trim().length > 0);
    if (!valid) {
      addIssue(issues, `${path}.${key}`, 'INVALID_CONFIG_VALUE', `${path}.${key} has an invalid value for that authoring setting.`);
    }
  }
  return cloneValue(value);
}

function parseOperation(
  input: unknown,
  index: number,
  issues: WorkflowDirectorPatchIssue[],
): WorkflowDirectorPatchOperation | null {
  const path = `operations[${index}]`;
  if (!isRecord(input)) {
    addIssue(issues, path, 'INVALID_OPERATION', `${path} must be an object.`);
    return null;
  }
  const op = input.op;
  if (op === 'add-node') {
    exactKeys(input, path, ['op', 'node'], ['op', 'node'], issues);
    if (!isRecord(input.node)) {
      addIssue(issues, `${path}.node`, 'INVALID_NODE', `${path}.node must be an object.`);
      return null;
    }
    exactKeys(input.node, `${path}.node`, ['id', 'type', 'title', 'position', 'config'], ['id', 'type'], issues);
    const type = creatorTypes.has(input.node.type as CreatorNodeType)
      ? input.node.type as CreatorNodeType
      : null;
    if (!type) addIssue(issues, `${path}.node.type`, 'UNKNOWN_NODE_TYPE', `Unsupported creator node type: ${String(input.node.type)}.`);
    const parsedConfig = input.node.config === undefined
      ? undefined
      : config(input.node.config, `${path}.node.config`, issues, type ? configKeys[type] : new Set());
    return {
      op,
      node: {
        id: requiredString(input.node.id, `${path}.node.id`, issues),
        type: type ?? 'output',
        ...(input.node.title === undefined
          ? {}
          : { title: requiredString(input.node.title, `${path}.node.title`, issues) }),
        ...(input.node.position === undefined
          ? {}
          : { position: point(input.node.position, `${path}.node.position`, issues) }),
        ...(parsedConfig === undefined ? {} : { config: parsedConfig }),
      },
    };
  }
  if (op === 'remove-node') {
    exactKeys(input, path, ['op', 'nodeId'], ['op', 'nodeId'], issues);
    return { op, nodeId: requiredString(input.nodeId, `${path}.nodeId`, issues) };
  }
  if (op === 'configure-node') {
    exactKeys(input, path, ['op', 'nodeId', 'changes'], ['op', 'nodeId', 'changes'], issues);
    const changes = config(input.changes, `${path}.changes`, issues);
    if (Object.keys(changes).length === 0) {
      addIssue(issues, `${path}.changes`, 'EMPTY_CONFIG', 'Configure operations require at least one authoring setting.');
    }
    return { op, nodeId: requiredString(input.nodeId, `${path}.nodeId`, issues), changes };
  }
  if (op === 'move-node') {
    exactKeys(input, path, ['op', 'nodeId', 'position'], ['op', 'nodeId', 'position'], issues);
    return {
      op,
      nodeId: requiredString(input.nodeId, `${path}.nodeId`, issues),
      position: point(input.position, `${path}.position`, issues),
    };
  }
  if (op === 'add-edge') {
    exactKeys(input, path, ['op', 'edge'], ['op', 'edge'], issues);
    if (!isRecord(input.edge)) {
      addIssue(issues, `${path}.edge`, 'INVALID_EDGE', `${path}.edge must be an object.`);
      return null;
    }
    exactKeys(input.edge, `${path}.edge`, ['id', 'source', 'target'], ['id', 'source', 'target'], issues);
    return {
      op,
      edge: {
        id: requiredString(input.edge.id, `${path}.edge.id`, issues),
        source: endpoint(input.edge.source, `${path}.edge.source`, issues),
        target: endpoint(input.edge.target, `${path}.edge.target`, issues),
      },
    };
  }
  if (op === 'remove-edge') {
    exactKeys(input, path, ['op', 'edgeId'], ['op', 'edgeId'], issues);
    return { op, edgeId: requiredString(input.edgeId, `${path}.edgeId`, issues) };
  }
  addIssue(issues, `${path}.op`, 'UNSUPPORTED_OPERATION', `Unsupported Director patch operation: ${String(op)}.`);
  return null;
}

export function parseWorkflowDirectorPatch(input: unknown): {
  value: WorkflowDirectorPatchV1 | null;
  issues: WorkflowDirectorPatchIssue[];
} {
  const issues: WorkflowDirectorPatchIssue[] = [];
  if (!isRecord(input)) {
    addIssue(issues, '<root>', 'INVALID_PATCH', 'Director patch must be an object.');
    return detachedFrozen({ value: null, issues });
  }
  exactKeys(input, '<root>', ['version', 'sourceGraphRevision', 'summary', 'operations'], ['version', 'sourceGraphRevision', 'summary', 'operations'], issues);
  if (input.version !== WORKFLOW_DIRECTOR_PATCH_VERSION) {
    addIssue(issues, 'version', 'UNSUPPORTED_VERSION', `Director patch version must be ${WORKFLOW_DIRECTOR_PATCH_VERSION}.`);
  }
  let sourceGraphRevision: WorkflowGraphRevision = { graphId: '', revision: 0 };
  if (!isRecord(input.sourceGraphRevision)) {
    addIssue(issues, 'sourceGraphRevision', 'INVALID_REVISION', 'sourceGraphRevision must identify a graph and its content revision.');
  } else {
    exactKeys(input.sourceGraphRevision, 'sourceGraphRevision', ['graphId', 'revision'], ['graphId', 'revision'], issues);
    const graphId = requiredString(input.sourceGraphRevision.graphId, 'sourceGraphRevision.graphId', issues);
    const revision = input.sourceGraphRevision.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      addIssue(issues, 'sourceGraphRevision.revision', 'INVALID_REVISION', 'sourceGraphRevision.revision must be a non-negative safe integer.');
    }
    sourceGraphRevision = { graphId, revision: Number.isSafeInteger(revision) ? revision as number : 0 };
  }
  const operations = Array.isArray(input.operations)
    ? input.operations.map((operation, index) => parseOperation(operation, index, issues))
      .filter((operation): operation is WorkflowDirectorPatchOperation => operation !== null)
    : [];
  if (!Array.isArray(input.operations)) {
    addIssue(issues, 'operations', 'INVALID_OPERATIONS', 'operations must be an array.');
  } else if (input.operations.length > 128) {
    addIssue(issues, 'operations', 'TOO_MANY_OPERATIONS', 'Director patches support at most 128 operations.');
  }
  const value: WorkflowDirectorPatchV1 = {
    version: WORKFLOW_DIRECTOR_PATCH_VERSION,
    sourceGraphRevision,
    summary: requiredString(input.summary, 'summary', issues, 2_000),
    operations,
  };
  return detachedFrozen({ value: issues.length === 0 ? value : null, issues });
}

function candidateProtected(node: WorkflowGraphV2['nodes'][number]): boolean {
  return [...candidateConfigKeys].some((key) => {
    const value = node.config[key];
    return value !== null && value !== undefined && value !== '';
  });
}

function containsString(value: unknown, candidates: ReadonlySet<string>): boolean {
  if (typeof value === 'string') return candidates.has(value);
  if (Array.isArray(value)) return value.some((item) => containsString(item, candidates));
  if (isRecord(value)) return Object.values(value).some((item) => containsString(item, candidates));
  return false;
}

function ensureCreatorNode(
  graph: WorkflowGraphV2,
  nodeId: string,
): WorkflowNodeV2 & { type: CreatorNodeType } {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) throw new WorkflowDomainError('NODE_NOT_FOUND', `Node "${nodeId}" does not exist.`, { nodeId });
  if (node.type === 'unsupported') {
    throw new WorkflowDomainError('INVALID_GRAPH', `Unsupported node "${nodeId}" cannot be revised by an AI Director patch.`, { nodeId });
  }
  return node as WorkflowNodeV2 & { type: CreatorNodeType };
}

function requirementMap(graph: WorkflowGraphV2): Map<string, {
  nodeId: string;
  nodeTitle: string;
  portId: string;
  portLabel: string;
  state: 'missing' | 'ready';
}> {
  const result = new Map<string, {
    nodeId: string;
    nodeTitle: string;
    portId: string;
    portLabel: string;
    state: 'missing' | 'ready';
  }>();
  for (const node of graph.nodes) {
    for (const port of node.ports.inputs.filter((item) => item.required)) {
      result.set(`${node.id}\u0000${port.id}`, {
        nodeId: node.id,
        nodeTitle: node.title,
        portId: port.id,
        portLabel: port.label,
        state: graph.edges.some((edge) => edge.target.nodeId === node.id && edge.target.portId === port.id)
          ? 'ready'
          : 'missing',
      });
    }
  }
  return result;
}

function requirementChanges(
  before: WorkflowGraphV2,
  after: WorkflowGraphV2,
): WorkflowDirectorPatchRequirementChange[] {
  const beforeMap = requirementMap(before);
  const afterMap = requirementMap(after);
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  const changes: WorkflowDirectorPatchRequirementChange[] = [];
  for (const key of keys) {
    const previous = beforeMap.get(key);
    const next = afterMap.get(key);
    const beforeState = previous?.state ?? 'absent';
    const afterState = next?.state ?? 'absent';
    if (beforeState === afterState) continue;
    const requirement = next ?? previous!;
    changes.push({
      nodeId: requirement.nodeId,
      nodeTitle: requirement.nodeTitle,
      portId: requirement.portId,
      portLabel: requirement.portLabel,
      before: beforeState,
      after: afterState,
    });
  }
  return changes;
}

function downstreamStaleness(
  before: WorkflowGraphV2,
  after: WorkflowGraphV2,
  materialRoots: ReadonlySet<string>,
): WorkflowDirectorPatchStalenessChange[] {
  const affected = new Set<string>();
  for (const nodeId of materialRoots) {
    if (after.nodes.some((node) => node.id === nodeId)) {
      affectedWorkflowNodes(after, [nodeId]).forEach((id) => affected.add(id));
    } else if (before.nodes.some((node) => node.id === nodeId)) {
      affectedWorkflowNodes(before, [nodeId]).forEach((id) => affected.add(id));
    }
  }
  return after.nodes
    .filter((node) => affected.has(node.id))
    .map((node) => ({
      nodeId: node.id,
      nodeTitle: node.title,
      reason: materialRoots.has(node.id)
        ? 'This node changed materially.'
        : 'An upstream material dependency changed.',
    }));
}

function immutableHistorySnapshot(graph: WorkflowGraphV2): string {
  return JSON.stringify({
    assetReferences: graph.assetReferences,
    runRecords: graph.runRecords,
    survivingRunLinks: graph.nodes
      .filter((node) => node.runRecordIds.length > 0)
      .map((node) => [node.id, node.runRecordIds]),
  });
}

function issueFromError(error: unknown, path: string): WorkflowDirectorPatchIssue {
  if (error instanceof WorkflowDomainError) {
    return { path, code: error.code, message: error.message };
  }
  return {
    path,
    code: 'INVALID_PATCH_OPERATION',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function createWorkflowDirectorPatchProposal(
  response: unknown,
  inputGraph: WorkflowGraphV2,
  currentGraphRevision: WorkflowGraphRevision,
): WorkflowDirectorPatchProposalResult {
  const parsed = parseWorkflowDirectorPatch(response);
  if (!parsed.value) return detachedFrozen({ proposal: null, issues: parsed.issues });
  const patch = parsed.value;
  if (
    patch.sourceGraphRevision.graphId !== currentGraphRevision.graphId
    || patch.sourceGraphRevision.revision !== currentGraphRevision.revision
    || inputGraph.id !== currentGraphRevision.graphId
  ) {
    return detachedFrozen({
      proposal: null,
      issues: [{
        path: 'sourceGraphRevision',
        code: 'STALE_GRAPH_REVISION',
        message: `Director patch source revision ${patch.sourceGraphRevision.graphId}@${patch.sourceGraphRevision.revision} is stale; current graph revision is ${currentGraphRevision.graphId}@${currentGraphRevision.revision}.`,
      }],
    });
  }

  let before: WorkflowGraphV2;
  try {
    before = new WorkflowGraphDomain(inputGraph).graph;
  } catch (error) {
    return detachedFrozen({ proposal: null, issues: [issueFromError(error, 'graph')] });
  }
  const historyBefore = immutableHistorySnapshot(before);
  const working = new WorkflowGraphDomain(before);
  const nodeChanges: WorkflowDirectorPatchNodeChange[] = [];
  const edgeChanges: WorkflowDirectorPatchEdgeChange[] = [];
  const materialRoots = new Set<string>();

  try {
    patch.operations.forEach((operation, index) => {
      const path = `operations[${index}]`;
      if (operation.op === 'add-node') {
        const node = createCreatorNode(operation.node.type, {
          id: operation.node.id,
          ...(operation.node.title === undefined ? {} : { title: operation.node.title }),
          ...(operation.node.position === undefined ? {} : { position: operation.node.position }),
          ...(operation.node.config === undefined ? {} : { config: operation.node.config }),
        });
        working.addNode(node);
        nodeChanges.push({ kind: 'added', nodeId: node.id, title: node.title, detail: `Add ${node.type} creator node.` });
      } else if (operation.op === 'remove-node') {
        const node = ensureCreatorNode(working.graph, operation.nodeId);
        if (node.runRecordIds.length > 0) {
          throw new WorkflowDomainError('INVALID_GRAPH', `Node "${node.title}" cannot be removed because its run history is immutable.`, { nodeId: node.id });
        }
        if (candidateProtected(node)) {
          throw new WorkflowDomainError('INVALID_GRAPH', `Node "${node.title}" cannot be removed because it owns an accepted candidate.`, { nodeId: node.id });
        }
        const referenceIds = new Set(working.graph.assetReferences.map((reference) => reference.id));
        if (containsString(node.config, referenceIds)) {
          throw new WorkflowDomainError('INVALID_GRAPH', `Node "${node.title}" cannot be removed because it references an immutable project asset.`, { nodeId: node.id });
        }
        working.outgoing(node.id).forEach((edge) => materialRoots.add(edge.target.nodeId));
        working.removeNode(node.id);
        nodeChanges.push({ kind: 'removed', nodeId: node.id, title: node.title, detail: `Remove ${node.type} creator node and its edges.` });
      } else if (operation.op === 'configure-node') {
        const node = ensureCreatorNode(working.graph, operation.nodeId);
        const allowed = configKeys[node.type];
        for (const key of Object.keys(operation.changes)) {
          if (!allowed.has(key)) {
            throw new WorkflowDomainError('INVALID_GRAPH', `${path}.changes.${key} is not valid for ${node.type} nodes.`, { nodeId: node.id, key });
          }
        }
        const nextConfig = { ...node.config, ...operation.changes };
        const configIssues = validateCreatorNodeConfig(node.type, nextConfig);
        if (configIssues.length > 0) {
          throw new WorkflowDomainError(
            'INVALID_GRAPH',
            `Invalid ${node.type} configuration: ${configIssues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
            { nodeId: node.id },
          );
        }
        const revision = working.revision;
        working.configureNode(node.id, nextConfig);
        if (working.revision !== revision) {
          materialRoots.add(node.id);
          nodeChanges.push({
            kind: 'configured', nodeId: node.id, title: node.title,
            detail: `Configure ${Object.keys(operation.changes).join(', ')}.`,
          });
        }
      } else if (operation.op === 'move-node') {
        const node = ensureCreatorNode(working.graph, operation.nodeId);
        const revision = working.revision;
        working.moveNode(node.id, operation.position);
        if (working.revision !== revision) {
          nodeChanges.push({ kind: 'moved', nodeId: node.id, title: node.title, detail: 'Move node on the workflow board.' });
        }
      } else if (operation.op === 'add-edge') {
        working.addEdge(operation.edge);
        materialRoots.add(operation.edge.target.nodeId);
        edgeChanges.push({
          kind: 'added', edgeId: operation.edge.id,
          source: operation.edge.source, target: operation.edge.target,
        });
      } else if (operation.op === 'remove-edge') {
        const edge = working.edge(operation.edgeId);
        if (!edge) throw new WorkflowDomainError('EDGE_NOT_FOUND', `Edge "${operation.edgeId}" does not exist.`, { edgeId: operation.edgeId });
        materialRoots.add(edge.target.nodeId);
        working.removeEdge(edge.id);
        edgeChanges.push({ kind: 'removed', edgeId: edge.id, source: edge.source, target: edge.target });
      }
    });
  } catch (error) {
    return detachedFrozen({ proposal: null, issues: [issueFromError(error, 'operations')] });
  }

  let after: WorkflowGraphV2;
  try {
    after = new WorkflowGraphDomain(working.graph).graph;
  } catch (error) {
    return detachedFrozen({ proposal: null, issues: [issueFromError(error, 'operations')] });
  }
  if (immutableHistorySnapshot(after) !== historyBefore) {
    return detachedFrozen({
      proposal: null,
      issues: [{
        path: 'operations',
        code: 'PROTECTED_HISTORY_MUTATION',
        message: 'Director patches cannot modify accepted candidates, asset references, run records, or surviving run-record links.',
      }],
    });
  }
  if (JSON.stringify(after) === JSON.stringify(before)) {
    return detachedFrozen({
      proposal: null,
      issues: [{ path: 'operations', code: 'NO_EFFECT', message: 'Director patch makes no changes to the workflow.' }],
    });
  }

  return detachedFrozen({
    proposal: {
      patch,
      graph: after,
      sourceGraphRevision: currentGraphRevision,
      targetGraphRevision: { graphId: currentGraphRevision.graphId, revision: currentGraphRevision.revision + 1 },
      nodeChanges: nodeChanges.sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.kind.localeCompare(right.kind)),
      edgeChanges: edgeChanges.sort((left, right) => left.edgeId.localeCompare(right.edgeId) || left.kind.localeCompare(right.kind)),
      requirementChanges: requirementChanges(before, after),
      downstreamStaleness: downstreamStaleness(before, after, materialRoots),
      canAccept: true,
    },
    issues: [],
  });
}

export function rejectWorkflowDirectorPatchProposal(
  _proposal: WorkflowDirectorPatchProposal | null,
): null {
  return null;
}
