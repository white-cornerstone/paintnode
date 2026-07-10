import {
  WorkflowDomainError,
  WorkflowGraphDomain,
  type WorkflowGraphRevision,
} from './domain';
import { affectedWorkflowNodes } from './execution';
import { isFullWorkflowRunRecord } from './provenance';
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

const immutableIdentityConfigKeys = new Set([
  'assetReferenceId',
  'resultAssetReferenceId',
  'reference',
  'referenceId',
  'assetId',
  'resultAssetId',
  'outputAssetId',
  'relativePath',
  'resultRelativePath',
  'outputRelativePath',
  'path',
]);

function safeIsArray(value: unknown): boolean | null {
  try {
    return Array.isArray(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  try {
    if (safeIsArray(value) !== false) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
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

interface OwnDataSnapshot {
  readonly values: ReadonlyMap<string, unknown>;
}

function snapshotOwnData(
  value: Record<string, unknown>,
  path: string,
  issues: WorkflowDirectorPatchIssue[],
): OwnDataSnapshot {
  const values = new Map<string, unknown>();
  try {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        addIssue(issues, path, 'SYMBOL_KEY', `${path} cannot contain symbol keys.`);
        continue;
      }
      const name = String(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        addIssue(issues, `${path}.${name}`, 'INVALID_PROPERTY', `${path}.${name} must be an enumerable data property.`);
        continue;
      }
      values.set(name, descriptor.value);
    }
  } catch {
    addIssue(issues, path, 'INVALID_OBJECT', `${path} could not be inspected safely.`);
    values.clear();
  }
  return { values };
}

function exactKeys(
  snapshot: OwnDataSnapshot,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
  issues: WorkflowDirectorPatchIssue[],
): void {
  for (const name of snapshot.values.keys()) {
    if (!allowed.includes(name)) addIssue(issues, `${path}.${name}`, 'EXTRA_KEY', `${path}.${name} is not supported.`);
  }
  for (const key of required) {
    if (!snapshot.values.has(key)) addIssue(issues, `${path}.${key}`, 'MISSING_KEY', `${path}.${key} is required.`);
  }
}

function operationItems(
  value: unknown,
  issues: WorkflowDirectorPatchIssue[],
): { index: number; value: unknown }[] {
  const arrayState = safeIsArray(value);
  if (arrayState !== true) {
    addIssue(
      issues,
      'operations',
      'INVALID_OPERATIONS',
      arrayState === null ? 'operations could not be inspected safely.' : 'operations must be an array.',
    );
    return [];
  }
  const arrayValue = value as unknown[];
  let length = 0;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(arrayValue, 'length');
    if (!lengthDescriptor || !('value' in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
      addIssue(issues, 'operations', 'INVALID_OPERATIONS', 'operations must have a safe array length.');
      return [];
    }
    length = lengthDescriptor.value as number;
  } catch {
    addIssue(issues, 'operations', 'INVALID_OPERATIONS', 'operations could not be inspected safely.');
    return [];
  }
  if (length > 128) {
    addIssue(issues, 'operations', 'TOO_MANY_OPERATIONS', 'Director patches support at most 128 operations.');
    return [];
  }
  const items: { index: number; value: unknown }[] = [];
  try {
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of Reflect.ownKeys(arrayValue)) {
      if (key === 'length') continue;
      if (typeof key === 'symbol' || !/^(0|[1-9]\d*)$/.test(String(key))) {
        addIssue(issues, 'operations', 'INVALID_ARRAY_PROPERTY', 'operations cannot contain symbol or named properties.');
        continue;
      }
      const name = String(key);
      const descriptor = Object.getOwnPropertyDescriptor(arrayValue, key);
      if (descriptor) descriptors.set(name, descriptor);
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors.get(String(index));
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        addIssue(issues, `operations[${index}]`, 'INVALID_ARRAY_ENTRY', `operations[${index}] must be an enumerable data property.`);
        continue;
      }
      items.push({ index, value: descriptor.value });
    }
  } catch {
    addIssue(issues, 'operations', 'INVALID_OPERATIONS', 'operations could not be inspected safely.');
    return [];
  }
  return items;
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
  const snapshot = snapshotOwnData(value, path, issues);
  exactKeys(snapshot, path, ['x', 'y'], ['x', 'y'], issues);
  const read = (key: 'x' | 'y') => {
    const coordinate = snapshot.values.get(key);
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
  const snapshot = snapshotOwnData(value, path, issues);
  exactKeys(snapshot, path, ['nodeId', 'portId'], ['nodeId', 'portId'], issues);
  return {
    nodeId: requiredString(snapshot.values.get('nodeId'), `${path}.nodeId`, issues),
    portId: requiredString(snapshot.values.get('portId'), `${path}.portId`, issues),
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
  const parsed: Record<string, unknown> = {};
  const snapshot = snapshotOwnData(value, path, issues);
  for (const [key, setting] of snapshot.values) {
    if (!permitted.has(key)) {
      addIssue(issues, `${path}.${key}`, 'UNKNOWN_CONFIG', `${path}.${key} is not an authoring setting supported by Director patches.`);
      continue;
    }
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
      continue;
    }
    parsed[key] = setting;
  }
  return parsed;
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
  const snapshot = snapshotOwnData(input, path, issues);
  const op = snapshot.values.get('op');
  if (op === 'add-node') {
    exactKeys(snapshot, path, ['op', 'node'], ['op', 'node'], issues);
    const node = snapshot.values.get('node');
    if (!isRecord(node)) {
      addIssue(issues, `${path}.node`, 'INVALID_NODE', `${path}.node must be an object.`);
      return null;
    }
    const nodeSnapshot = snapshotOwnData(node, `${path}.node`, issues);
    exactKeys(nodeSnapshot, `${path}.node`, ['id', 'type', 'title', 'position', 'config'], ['id', 'type'], issues);
    const rawType = nodeSnapshot.values.get('type');
    const type = creatorTypes.has(rawType as CreatorNodeType)
      ? rawType as CreatorNodeType
      : null;
    if (!type) addIssue(issues, `${path}.node.type`, 'UNKNOWN_NODE_TYPE', 'Unsupported creator node type.');
    const rawConfig = nodeSnapshot.values.get('config');
    const parsedConfig = rawConfig === undefined
      ? undefined
      : config(rawConfig, `${path}.node.config`, issues, type ? configKeys[type] : new Set());
    const title = nodeSnapshot.values.get('title');
    const position = nodeSnapshot.values.get('position');
    return {
      op,
      node: {
        id: requiredString(nodeSnapshot.values.get('id'), `${path}.node.id`, issues),
        type: type ?? 'output',
        ...(title === undefined
          ? {}
          : { title: requiredString(title, `${path}.node.title`, issues) }),
        ...(position === undefined
          ? {}
          : { position: point(position, `${path}.node.position`, issues) }),
        ...(parsedConfig === undefined ? {} : { config: parsedConfig }),
      },
    };
  }
  if (op === 'remove-node') {
    exactKeys(snapshot, path, ['op', 'nodeId'], ['op', 'nodeId'], issues);
    return { op, nodeId: requiredString(snapshot.values.get('nodeId'), `${path}.nodeId`, issues) };
  }
  if (op === 'configure-node') {
    exactKeys(snapshot, path, ['op', 'nodeId', 'changes'], ['op', 'nodeId', 'changes'], issues);
    const changes = config(snapshot.values.get('changes'), `${path}.changes`, issues);
    if (Object.keys(changes).length === 0) {
      addIssue(issues, `${path}.changes`, 'EMPTY_CONFIG', 'Configure operations require at least one authoring setting.');
    }
    return { op, nodeId: requiredString(snapshot.values.get('nodeId'), `${path}.nodeId`, issues), changes };
  }
  if (op === 'move-node') {
    exactKeys(snapshot, path, ['op', 'nodeId', 'position'], ['op', 'nodeId', 'position'], issues);
    return {
      op,
      nodeId: requiredString(snapshot.values.get('nodeId'), `${path}.nodeId`, issues),
      position: point(snapshot.values.get('position'), `${path}.position`, issues),
    };
  }
  if (op === 'add-edge') {
    exactKeys(snapshot, path, ['op', 'edge'], ['op', 'edge'], issues);
    const edge = snapshot.values.get('edge');
    if (!isRecord(edge)) {
      addIssue(issues, `${path}.edge`, 'INVALID_EDGE', `${path}.edge must be an object.`);
      return null;
    }
    const edgeSnapshot = snapshotOwnData(edge, `${path}.edge`, issues);
    exactKeys(edgeSnapshot, `${path}.edge`, ['id', 'source', 'target'], ['id', 'source', 'target'], issues);
    return {
      op,
      edge: {
        id: requiredString(edgeSnapshot.values.get('id'), `${path}.edge.id`, issues),
        source: endpoint(edgeSnapshot.values.get('source'), `${path}.edge.source`, issues),
        target: endpoint(edgeSnapshot.values.get('target'), `${path}.edge.target`, issues),
      },
    };
  }
  if (op === 'remove-edge') {
    exactKeys(snapshot, path, ['op', 'edgeId'], ['op', 'edgeId'], issues);
    return { op, edgeId: requiredString(snapshot.values.get('edgeId'), `${path}.edgeId`, issues) };
  }
  addIssue(issues, `${path}.op`, 'UNSUPPORTED_OPERATION', 'Unsupported Director patch operation.');
  return null;
}

function parseWorkflowDirectorPatchUnchecked(input: unknown): {
  value: WorkflowDirectorPatchV1 | null;
  issues: WorkflowDirectorPatchIssue[];
} {
  const issues: WorkflowDirectorPatchIssue[] = [];
  if (!isRecord(input)) {
    addIssue(issues, '<root>', 'INVALID_PATCH', 'Director patch must be an object.');
    return detachedFrozen({ value: null, issues });
  }
  const snapshot = snapshotOwnData(input, '<root>', issues);
  exactKeys(snapshot, '<root>', ['version', 'sourceGraphRevision', 'summary', 'operations'], ['version', 'sourceGraphRevision', 'summary', 'operations'], issues);
  if (snapshot.values.get('version') !== WORKFLOW_DIRECTOR_PATCH_VERSION) {
    addIssue(issues, 'version', 'UNSUPPORTED_VERSION', `Director patch version must be ${WORKFLOW_DIRECTOR_PATCH_VERSION}.`);
  }
  let sourceGraphRevision: WorkflowGraphRevision = { graphId: '', revision: 0 };
  const rawSourceGraphRevision = snapshot.values.get('sourceGraphRevision');
  if (!isRecord(rawSourceGraphRevision)) {
    addIssue(issues, 'sourceGraphRevision', 'INVALID_REVISION', 'sourceGraphRevision must identify a graph and its content revision.');
  } else {
    const revisionSnapshot = snapshotOwnData(rawSourceGraphRevision, 'sourceGraphRevision', issues);
    exactKeys(revisionSnapshot, 'sourceGraphRevision', ['graphId', 'revision'], ['graphId', 'revision'], issues);
    const graphId = requiredString(revisionSnapshot.values.get('graphId'), 'sourceGraphRevision.graphId', issues);
    const revision = revisionSnapshot.values.get('revision');
    if (!Number.isSafeInteger(revision) || (revision as number) < 0 || revision === Number.MAX_SAFE_INTEGER) {
      addIssue(issues, 'sourceGraphRevision.revision', 'INVALID_REVISION', 'sourceGraphRevision.revision must be a non-negative safe integer that can advance by one.');
    }
    sourceGraphRevision = {
      graphId,
      revision: Number.isSafeInteger(revision) && revision !== Number.MAX_SAFE_INTEGER ? revision as number : 0,
    };
  }
  const operations = operationItems(snapshot.values.get('operations'), issues)
    .map((operation) => parseOperation(operation.value, operation.index, issues))
    .filter((operation): operation is WorkflowDirectorPatchOperation => operation !== null);
  const value: WorkflowDirectorPatchV1 = {
    version: WORKFLOW_DIRECTOR_PATCH_VERSION,
    sourceGraphRevision,
    summary: requiredString(snapshot.values.get('summary'), 'summary', issues, 2_000),
    operations,
  };
  return detachedFrozen({ value: issues.length === 0 ? value : null, issues });
}

export function parseWorkflowDirectorPatch(input: unknown): {
  value: WorkflowDirectorPatchV1 | null;
  issues: WorkflowDirectorPatchIssue[];
} {
  try {
    return parseWorkflowDirectorPatchUnchecked(input);
  } catch {
    return detachedFrozen({
      value: null,
      issues: [{
        path: '<root>',
        code: 'INVALID_PATCH',
        message: 'Director patch could not be inspected safely.',
      }],
    });
  }
}

function candidateProtected(node: WorkflowGraphV2['nodes'][number]): boolean {
  return [...candidateConfigKeys].some((key) => {
    const value = node.config[key];
    return value !== null && value !== undefined && value !== '';
  });
}

function addIdentity(identities: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) identities.add(value);
}

function immutableCandidateIdentities(graph: WorkflowGraphV2): Set<string> {
  const identities = new Set<string>();
  for (const reference of graph.assetReferences) {
    addIdentity(identities, reference.id);
    addIdentity(identities, reference.assetId);
    addIdentity(identities, reference.relativePath);
  }
  for (const run of graph.runRecords) {
    if (!isFullWorkflowRunRecord(run)) continue;
    for (const output of run.outputs) {
      addIdentity(identities, output.assetReferenceId);
      addIdentity(identities, output.assetId);
      addIdentity(identities, output.relativePath);
    }
  }
  return identities;
}

function containsImmutableIdentity(value: unknown, candidates: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => containsImmutableIdentity(item, candidates));
  if (!isRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (immutableIdentityConfigKeys.has(key) && typeof item === 'string' && candidates.has(item)) {
      return true;
    }
    if ((Array.isArray(item) || isRecord(item)) && containsImmutableIdentity(item, candidates)) {
      return true;
    }
  }
  return false;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => valuesEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]));
}

function nodeStructure(node: WorkflowNodeV2): Omit<WorkflowNodeV2, 'config' | 'position'> {
  const { config: _config, position: _position, ...structure } = node;
  return structure;
}

function deriveNodeChanges(
  before: WorkflowGraphV2,
  after: WorkflowGraphV2,
): WorkflowDirectorPatchNodeChange[] {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const changes: WorkflowDirectorPatchNodeChange[] = [];

  for (const node of before.nodes) {
    const next = afterNodes.get(node.id);
    if (!next || !valuesEqual(nodeStructure(node), nodeStructure(next))) {
      changes.push({
        kind: 'removed', nodeId: node.id, title: node.title,
        detail: `Remove ${node.type} creator node and its edges.`,
      });
    }
  }
  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id);
    if (!previous || !valuesEqual(nodeStructure(previous), nodeStructure(node))) {
      changes.push({
        kind: 'added', nodeId: node.id, title: node.title,
        detail: `Add ${node.type} creator node.`,
      });
      continue;
    }
    if (!valuesEqual(previous.config, node.config)) {
      const keys = new Set([...Object.keys(previous.config), ...Object.keys(node.config)]);
      const configured = [...keys]
        .filter((key) => !valuesEqual(previous.config[key], node.config[key]))
        .sort((left, right) => left.localeCompare(right));
      changes.push({
        kind: 'configured', nodeId: node.id, title: node.title,
        detail: `Configure ${configured.join(', ')}.`,
      });
    }
    if (!valuesEqual(previous.position, node.position)) {
      changes.push({ kind: 'moved', nodeId: node.id, title: node.title, detail: 'Move node on the workflow board.' });
    }
  }
  return changes.sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.kind.localeCompare(right.kind));
}

function deriveEdgeChanges(
  before: WorkflowGraphV2,
  after: WorkflowGraphV2,
): WorkflowDirectorPatchEdgeChange[] {
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));
  const changes: WorkflowDirectorPatchEdgeChange[] = [];
  for (const edge of before.edges) {
    const next = afterEdges.get(edge.id);
    if (!next || !valuesEqual(edge, next)) {
      changes.push({ kind: 'removed', edgeId: edge.id, source: edge.source, target: edge.target });
    }
  }
  for (const edge of after.edges) {
    const previous = beforeEdges.get(edge.id);
    if (!previous || !valuesEqual(previous, edge)) {
      changes.push({ kind: 'added', edgeId: edge.id, source: edge.source, target: edge.target });
    }
  }
  return changes.sort((left, right) => left.edgeId.localeCompare(right.edgeId) || left.kind.localeCompare(right.kind));
}

function deriveMaterialRoots(
  before: WorkflowGraphV2,
  after: WorkflowGraphV2,
  nodeChanges: readonly WorkflowDirectorPatchNodeChange[],
  edgeChanges: readonly WorkflowDirectorPatchEdgeChange[],
): Set<string> {
  const roots = new Set<string>();
  const beforeNodeIds = new Set(before.nodes.map((node) => node.id));
  const afterNodeIds = new Set(after.nodes.map((node) => node.id));
  for (const change of nodeChanges) {
    if (change.kind === 'configured') roots.add(change.nodeId);
    if ((change.kind === 'added' || change.kind === 'removed')
      && beforeNodeIds.has(change.nodeId) && afterNodeIds.has(change.nodeId)) {
      roots.add(change.nodeId);
    }
  }
  for (const change of edgeChanges) {
    if (afterNodeIds.has(change.target.nodeId)) roots.add(change.target.nodeId);
  }
  return roots;
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
  const immutableIdentities = immutableCandidateIdentities(before);
  const historyBefore = immutableHistorySnapshot(before);
  const working = new WorkflowGraphDomain(before);

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
      } else if (operation.op === 'remove-node') {
        const node = ensureCreatorNode(working.graph, operation.nodeId);
        if (node.runRecordIds.length > 0) {
          throw new WorkflowDomainError('INVALID_GRAPH', `Node "${node.title}" cannot be removed because its run history is immutable.`, { nodeId: node.id });
        }
        if (candidateProtected(node)) {
          throw new WorkflowDomainError('INVALID_GRAPH', `Node "${node.title}" cannot be removed because it owns an accepted candidate.`, { nodeId: node.id });
        }
        if (containsImmutableIdentity(node.config, immutableIdentities)) {
          throw new WorkflowDomainError('INVALID_GRAPH', `Node "${node.title}" cannot be removed because it references an immutable project asset or accepted candidate.`, { nodeId: node.id });
        }
        working.removeNode(node.id);
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
        working.configureNode(node.id, nextConfig);
      } else if (operation.op === 'move-node') {
        const node = ensureCreatorNode(working.graph, operation.nodeId);
        working.moveNode(node.id, operation.position);
      } else if (operation.op === 'add-edge') {
        working.addEdge(operation.edge);
      } else if (operation.op === 'remove-edge') {
        const edge = working.edge(operation.edgeId);
        if (!edge) throw new WorkflowDomainError('EDGE_NOT_FOUND', `Edge "${operation.edgeId}" does not exist.`, { edgeId: operation.edgeId });
        working.removeEdge(edge.id);
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
  const nodeChanges = deriveNodeChanges(before, after);
  const edgeChanges = deriveEdgeChanges(before, after);
  if (nodeChanges.length === 0 && edgeChanges.length === 0) {
    return detachedFrozen({
      proposal: null,
      issues: [{ path: 'operations', code: 'NO_EFFECT', message: 'Director patch makes no changes to the workflow.' }],
    });
  }
  const materialRoots = deriveMaterialRoots(before, after, nodeChanges, edgeChanges);

  return detachedFrozen({
    proposal: {
      patch,
      graph: after,
      sourceGraphRevision: currentGraphRevision,
      targetGraphRevision: { graphId: currentGraphRevision.graphId, revision: currentGraphRevision.revision + 1 },
      nodeChanges,
      edgeChanges,
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
