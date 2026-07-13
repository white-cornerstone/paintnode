import {
  parseWorkflowGraphV2,
  serializeWorkflowGraphV2,
  type WorkflowEdgeEndpoint,
  type WorkflowEdgeV2,
  type WorkflowGraphV2,
  type WorkflowNodeV2,
  type WorkflowPoint,
  type WorkflowSize,
  type WorkflowValidationIssue,
} from './schema';

export type WorkflowDomainErrorCode =
  | 'INVALID_GRAPH'
  | 'INVALID_ID'
  | 'DUPLICATE_NODE_ID'
  | 'DUPLICATE_EDGE_ID'
  | 'DUPLICATE_ASSET_REFERENCE_ID'
  | 'DUPLICATE_RUN_RECORD_ID'
  | 'DUPLICATE_RUN_RECORD_LINK'
  | 'NODE_NOT_FOUND'
  | 'EDGE_NOT_FOUND'
  | 'ENDPOINT_NODE_NOT_FOUND'
  | 'DUPLICATE_PORT_ID'
  | 'SOURCE_PORT_NOT_FOUND'
  | 'TARGET_PORT_NOT_FOUND'
  | 'UNSUPPORTED_CONNECTION'
  | 'INCOMPATIBLE_PORT_TYPES'
  | 'DUPLICATE_CONNECTION'
  | 'TARGET_PORT_OCCUPIED'
  | 'SELF_LINK'
  | 'CYCLE_DETECTED'
  | 'RUN_RECORD_NODE_NOT_FOUND'
  | 'RUN_RECORD_NOT_FOUND'
  | 'RUN_RECORD_LINK_MISSING'
  | 'RUN_RECORD_LINK_MISMATCH'
  | 'INVALID_POSITION'
  | 'INVALID_SIZE'
  | 'INVALID_ATTACHED_EDGE_DIRECTION'
  | 'INVALID_JSON_VALUE'
  | 'SERIALIZATION_FAILED';

export class WorkflowDomainError extends Error {
  readonly code: WorkflowDomainErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: WorkflowDomainErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'WorkflowDomainError';
    this.code = code;
    this.details = details;
  }
}

export type WorkflowIdKind = 'node' | 'edge';
export type WorkflowIdGenerator = (kind: WorkflowIdKind) => string;

export interface WorkflowDomainOptions {
  idGenerator?: WorkflowIdGenerator;
  initialRevision?: number;
}

export interface WorkflowGraphRevision {
  readonly graphId: string;
  readonly revision: number;
}

export type WorkflowNodeDraft = Omit<WorkflowNodeV2, 'id'> & { id?: string };
export type WorkflowEdgeDraft = Omit<WorkflowEdgeV2, 'id'> & { id?: string };
export type WorkflowNodeUpdate = Partial<Pick<WorkflowNodeV2, 'title' | 'color' | 'config' | 'position' | 'size'>>;

export interface WorkflowAttachedEdgeDraft {
  id?: string;
  direction: 'incoming' | 'outgoing';
  nodePortId: string;
  other: WorkflowEdgeEndpoint;
}

export interface WorkflowNodeWithEdgeResult {
  node: WorkflowNodeV2;
  edge: WorkflowEdgeV2;
}

export type WorkflowConnectionRejectionCode =
  | 'ENDPOINT_NODE_NOT_FOUND'
  | 'SOURCE_PORT_NOT_FOUND'
  | 'TARGET_PORT_NOT_FOUND'
  | 'UNSUPPORTED_CONNECTION'
  | 'INCOMPATIBLE_PORT_TYPES'
  | 'DUPLICATE_CONNECTION'
  | 'TARGET_PORT_OCCUPIED'
  | 'SELF_LINK'
  | 'CYCLE_DETECTED';

export interface WorkflowConnectionAccepted {
  ok: true;
}

export interface WorkflowConnectionRejected {
  ok: false;
  code: WorkflowConnectionRejectionCode;
  message: string;
  details: Readonly<Record<string, unknown>>;
}

export type WorkflowConnectionValidation = WorkflowConnectionAccepted | WorkflowConnectionRejected;
export type WorkflowConnectionEndpoints = Pick<WorkflowEdgeV2, 'source' | 'target'>;

let fallbackIdSequence = 0;

function defaultIdGenerator(kind: WorkflowIdKind): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${kind}-${uuid}`;
  fallbackIdSequence += 1;
  return `${kind}-${Date.now()}-${fallbackIdSequence}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item));
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => deepFreeze(item));
    return Object.freeze(value) as T;
  }
  return value;
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

function invalidJsonValue(path: string, reason: string, valueType: string): never {
  throw new WorkflowDomainError('INVALID_JSON_VALUE', `${path} is not JSON-safe: ${reason}.`, {
    path,
    reason,
    valueType,
  });
}

function assertJsonSafe(value: unknown, path: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidJsonValue(path, 'numbers must be finite', 'number');
    return;
  }
  if (typeof value !== 'object') {
    invalidJsonValue(path, `${typeof value} values are not represented by JSON`, typeof value);
  }

  const object = value as object;
  if (ancestors.has(object)) invalidJsonValue(path, 'cyclic references are not supported', 'object');
  ancestors.add(object);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) invalidJsonValue(`${path}[${index}]`, 'sparse array entries serialize as null', 'undefined');
        assertJsonSafe(value[index], `${path}[${index}]`, ancestors);
      }
      const extraKeys = Reflect.ownKeys(value).filter((key) => key !== 'length' && !/^\d+$/.test(String(key)));
      if (extraKeys.length > 0) {
        invalidJsonValue(path, 'arrays cannot contain symbol or named properties', typeof extraKeys[0]);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidJsonValue(path, 'only plain objects are supported', value.constructor?.name ?? 'object');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') invalidJsonValue(path, 'symbol keys are omitted by JSON', 'symbol');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) invalidJsonValue(`${path}.${key}`, 'non-enumerable properties are omitted by JSON', 'property');
      if (!('value' in descriptor)) invalidJsonValue(`${path}.${key}`, 'accessor properties are not supported', 'property');
      assertJsonSafe(descriptor.value, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(object);
  }
}

function ensureJsonSafe(value: unknown, path: string): void {
  try {
    assertJsonSafe(value, path);
  } catch (error) {
    if (error instanceof WorkflowDomainError) throw error;
    throw new WorkflowDomainError('INVALID_JSON_VALUE', `${path} could not be inspected for JSON safety.`, {
      path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeNegativeZero<T>(value: T): T {
  if (typeof value === 'number') return (Object.is(value, -0) ? 0 : value) as T;
  if (Array.isArray(value)) return value.map((item) => normalizeNegativeZero(item)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeNegativeZero(item)]),
    ) as T;
  }
  return value;
}

function invalidGraphMessage(issues: WorkflowValidationIssue[]): string {
  return issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`).join('; ');
}

function requireId(value: string, kind: WorkflowIdKind): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkflowDomainError('INVALID_ID', `The ${kind} ID must be a non-empty string.`, {
      kind,
      value,
    });
  }
  return value;
}

function assertFinitePoint(position: WorkflowPoint, nodeId: string): void {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    throw new WorkflowDomainError('INVALID_POSITION', `Node "${nodeId}" must have a finite position.`, {
      nodeId,
      position,
    });
  }
}

function assertValidSize(size: WorkflowSize, nodeId: string): void {
  if (!Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new WorkflowDomainError('INVALID_SIZE', `Node "${nodeId}" must have a positive finite size.`, {
      nodeId,
      size,
    });
  }
}

function assertUniqueIds(graph: WorkflowGraphV2): void {
  const nodeIds = new Set<string>();
  for (const [nodeIndex, node] of graph.nodes.entries()) {
    if (nodeIds.has(node.id)) {
      throw new WorkflowDomainError('DUPLICATE_NODE_ID', `A node with ID "${node.id}" already exists.`, {
        nodeId: node.id,
        nodeIndex,
      });
    }
    nodeIds.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const [edgeIndex, edge] of graph.edges.entries()) {
    if (edgeIds.has(edge.id)) {
      throw new WorkflowDomainError('DUPLICATE_EDGE_ID', `An edge with ID "${edge.id}" already exists.`, {
        edgeId: edge.id,
        edgeIndex,
      });
    }
    edgeIds.add(edge.id);
  }
}

function assertUniquePortIds(graph: WorkflowGraphV2): void {
  for (const node of graph.nodes) {
    for (const [direction, ports] of [
      ['input', node.ports.inputs],
      ['output', node.ports.outputs],
    ] as const) {
      const ids = new Set<string>();
      for (const port of ports) {
        if (ids.has(port.id)) {
          throw new WorkflowDomainError(
            'DUPLICATE_PORT_ID',
            `Node "${node.title}" ${direction} port IDs must be unique; "${port.id}" is repeated.`,
            { nodeId: node.id, direction, portId: port.id },
          );
        }
        ids.add(port.id);
      }
    }
  }
}

function assertReferenceInvariants(graph: WorkflowGraphV2): void {
  const assetReferenceIds = new Set<string>();
  for (const reference of graph.assetReferences) {
    if (assetReferenceIds.has(reference.id)) {
      throw new WorkflowDomainError(
        'DUPLICATE_ASSET_REFERENCE_ID',
        `An asset reference with ID "${reference.id}" already exists.`,
        { assetReferenceId: reference.id },
      );
    }
    assetReferenceIds.add(reference.id);
  }

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const runsById = new Map<string, WorkflowGraphV2['runRecords'][number]>();
  for (const run of graph.runRecords) {
    if (runsById.has(run.id)) {
      throw new WorkflowDomainError(
        'DUPLICATE_RUN_RECORD_ID',
        `A run record with ID "${run.id}" already exists.`,
        { runRecordId: run.id },
      );
    }
    if (!nodesById.has(run.nodeId)) {
      throw new WorkflowDomainError(
        'RUN_RECORD_NODE_NOT_FOUND',
        `Run record "${run.id}" refers to missing node "${run.nodeId}".`,
        { runRecordId: run.id, nodeId: run.nodeId },
      );
    }
    runsById.set(run.id, run);
  }

  for (const node of graph.nodes) {
    const links = new Set<string>();
    for (const runRecordId of node.runRecordIds) {
      if (links.has(runRecordId)) {
        throw new WorkflowDomainError(
          'DUPLICATE_RUN_RECORD_LINK',
          `Node "${node.id}" links run record "${runRecordId}" more than once.`,
          { nodeId: node.id, runRecordId },
        );
      }
      links.add(runRecordId);
      const run = runsById.get(runRecordId);
      if (!run) {
        throw new WorkflowDomainError(
          'RUN_RECORD_NOT_FOUND',
          `Node "${node.id}" refers to missing run record "${runRecordId}".`,
          { nodeId: node.id, runRecordId },
        );
      }
      if (run.nodeId !== node.id) {
        throw new WorkflowDomainError(
          'RUN_RECORD_LINK_MISMATCH',
          `Run record "${runRecordId}" belongs to node "${run.nodeId}", not "${node.id}".`,
          { nodeId: node.id, runRecordId, runNodeId: run.nodeId },
        );
      }
    }
  }

  for (const run of graph.runRecords) {
    if (!nodesById.get(run.nodeId)?.runRecordIds.includes(run.id)) {
      throw new WorkflowDomainError(
        'RUN_RECORD_LINK_MISSING',
        `Run record "${run.id}" is not linked from node "${run.nodeId}".`,
        { runRecordId: run.id, nodeId: run.nodeId },
      );
    }
  }
}

function rejected(
  code: WorkflowConnectionRejectionCode,
  message: string,
  details: Readonly<Record<string, unknown>>,
): WorkflowConnectionRejected {
  return { ok: false, code, message, details };
}

function connectionTouchesUnsupported(
  graph: WorkflowGraphV2,
  endpoints: WorkflowConnectionEndpoints,
): boolean {
  return graph.nodes.some((node) => (
    node.type === 'unsupported'
    && (node.id === endpoints.source.nodeId || node.id === endpoints.target.nodeId)
  ));
}

function hasDependencyPath(
  graph: WorkflowGraphV2,
  fromNodeId: string,
  toNodeId: string,
  excludedEdgeId?: string,
): boolean {
  const visited = new Set<string>();
  const pending = [fromNodeId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === toNodeId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of graph.edges) {
      if (
        edge.id !== excludedEdgeId
        && !connectionTouchesUnsupported(graph, edge)
        && edge.source.nodeId === current
      ) {
        pending.push(edge.target.nodeId);
      }
    }
  }
  return false;
}

function validateConnectionInGraph(
  graph: WorkflowGraphV2,
  endpoints: WorkflowConnectionEndpoints,
  options: {
    excludedEdgeId?: string;
    allowDormantUnsupported?: boolean;
  } = {},
): WorkflowConnectionValidation {
  const sourceNode = graph.nodes.find((node) => node.id === endpoints.source.nodeId);
  if (!sourceNode) {
    return rejected(
      'ENDPOINT_NODE_NOT_FOUND',
      `The source node "${endpoints.source.nodeId}" does not exist.`,
      { endpoint: 'source', nodeId: endpoints.source.nodeId },
    );
  }
  const targetNode = graph.nodes.find((node) => node.id === endpoints.target.nodeId);
  if (!targetNode) {
    return rejected(
      'ENDPOINT_NODE_NOT_FOUND',
      `The target node "${endpoints.target.nodeId}" does not exist.`,
      { endpoint: 'target', nodeId: endpoints.target.nodeId },
    );
  }
  if (sourceNode.type === 'unsupported' || targetNode.type === 'unsupported') {
    if (options.allowDormantUnsupported) return { ok: true };
    return rejected(
      'UNSUPPORTED_CONNECTION',
      `Unsupported workflow nodes cannot be connected until PaintNode understands their port contract.`,
      { sourceNodeType: sourceNode.type, targetNodeType: targetNode.type },
    );
  }
  if (sourceNode.id === targetNode.id) {
    return rejected(
      'SELF_LINK',
      `Node "${sourceNode.title}" cannot connect to itself.`,
      { nodeId: sourceNode.id },
    );
  }

  const sourcePort = sourceNode.ports.outputs.find((port) => port.id === endpoints.source.portId);
  if (!sourcePort) {
    const wrongDirection = sourceNode.ports.inputs.some((port) => port.id === endpoints.source.portId);
    return rejected(
      'SOURCE_PORT_NOT_FOUND',
      wrongDirection
        ? `Source node "${sourceNode.title}" port "${endpoints.source.portId}" is not an output port.`
        : `Source node "${sourceNode.title}" has no "${endpoints.source.portId}" output port.`,
      { nodeId: sourceNode.id, portId: endpoints.source.portId, direction: 'output' },
    );
  }
  const targetPort = targetNode.ports.inputs.find((port) => port.id === endpoints.target.portId);
  if (!targetPort) {
    const wrongDirection = targetNode.ports.outputs.some((port) => port.id === endpoints.target.portId);
    return rejected(
      'TARGET_PORT_NOT_FOUND',
      wrongDirection
        ? `Target node "${targetNode.title}" port "${endpoints.target.portId}" is not an input port.`
        : `Target node "${targetNode.title}" has no "${endpoints.target.portId}" input port.`,
      { nodeId: targetNode.id, portId: endpoints.target.portId, direction: 'input' },
    );
  }

  if (sourcePort.dataType === 'unknown' || targetPort.dataType === 'unknown') {
    return rejected(
      'UNSUPPORTED_CONNECTION',
      `Unknown workflow port types cannot be connected safely.`,
      { sourceType: sourcePort.dataType, targetType: targetPort.dataType },
    );
  }
  if (sourcePort.dataType !== targetPort.dataType) {
    return rejected(
      'INCOMPATIBLE_PORT_TYPES',
      `The ${sourcePort.dataType} output cannot connect to the ${targetPort.dataType} input.`,
      { sourceType: sourcePort.dataType, targetType: targetPort.dataType },
    );
  }

  const existingEdges = graph.edges.filter((edge) => (
    edge.id !== options.excludedEdgeId && !connectionTouchesUnsupported(graph, edge)
  ));
  if (existingEdges.some((edge) => (
    endpointEquals(edge.source, endpoints.source) && endpointEquals(edge.target, endpoints.target)
  ))) {
    return rejected(
      'DUPLICATE_CONNECTION',
      `"${sourceNode.title}" and "${targetNode.title}" are already connected through these ports.`,
      { source: endpoints.source, target: endpoints.target },
    );
  }
  if (!targetPort.multiple && existingEdges.some((edge) => endpointEquals(edge.target, endpoints.target))) {
    return rejected(
      'TARGET_PORT_OCCUPIED',
      `The "${targetPort.label}" input on "${targetNode.title}" accepts only one connection.`,
      { target: endpoints.target },
    );
  }
  if (hasDependencyPath(graph, targetNode.id, sourceNode.id, options.excludedEdgeId)) {
    return rejected(
      'CYCLE_DETECTED',
      `Connecting "${sourceNode.title}" to "${targetNode.title}" would create a cycle.`,
      { sourceNodeId: sourceNode.id, targetNodeId: targetNode.id },
    );
  }
  return { ok: true };
}

function throwConnectionRejection(
  validation: WorkflowConnectionValidation,
  context: Readonly<Record<string, unknown>> = {},
): void {
  if (!validation.ok) {
    throw new WorkflowDomainError(validation.code, validation.message, { ...validation.details, ...context });
  }
}

function assertConnections(graph: WorkflowGraphV2): void {
  graph.edges.forEach((edge, edgeIndex) => {
    throwConnectionRejection(
      validateConnectionInGraph(graph, edge, {
        excludedEdgeId: edge.id,
        allowDormantUnsupported: true,
      }),
      { edgeId: edge.id, edgeIndex },
    );
  });
}

function normalizeGraph(graph: WorkflowGraphV2): WorkflowGraphV2 {
  if (Array.isArray(graph.nodes)) {
    graph.nodes.forEach((node, index) => ensureJsonSafe(node?.config, `nodes[${index}].config`));
  }
  const parsed = parseWorkflowGraphV2(graph);
  if (!parsed.ok || !parsed.value) {
    throw new WorkflowDomainError(
      'INVALID_GRAPH',
      `Workflow graph is structurally invalid: ${invalidGraphMessage(parsed.issues)}`,
      { issues: parsed.issues },
    );
  }

  const normalized = normalizeNegativeZero(parsed.value);
  const normalizedInputRoles: WorkflowGraphV2 = {
    ...normalized,
    nodes: normalized.nodes.map((node) => {
      if (node.type !== 'input' || typeof node.config.assetId !== 'string' || !node.config.assetId.trim()) return node;
      const role = typeof node.config.role === 'string' && node.config.role.trim()
        ? node.config.role
        : typeof node.config.note === 'string' && node.config.note.trim()
          ? node.config.note
        : typeof node.config.slotId === 'string' && node.config.slotId.trim()
          ? node.config.slotId
          : 'Connected visual input';
      return role === node.config.role ? node : { ...node, config: { ...node.config, role } };
    }),
  };
  assertUniqueIds(normalizedInputRoles);
  assertUniquePortIds(normalizedInputRoles);
  // Parsing intentionally normalizes optional undefined fields. The parsed
  // graph must then round-trip through JSON without changing numeric identity
  // (including the otherwise lossy negative-zero case).
  ensureJsonSafe(normalizedInputRoles, 'graph');
  assertReferenceInvariants(normalizedInputRoles);
  for (const node of normalizedInputRoles.nodes) {
    assertFinitePoint(node.position, node.id);
    assertValidSize(node.size, node.id);
  }
  assertConnections(normalizedInputRoles);
  return deepFreeze(normalizedInputRoles);
}

function endpointEquals(left: WorkflowEdgeEndpoint, right: WorkflowEdgeEndpoint): boolean {
  return left.nodeId === right.nodeId && left.portId === right.portId;
}

/**
 * Framework-independent owner of a WorkflowGraph v2.
 *
 * The graph exposed by this class is deeply frozen. Every material operation
 * validates and replaces it with a detached snapshot, then advances revision
 * exactly once. Selection and other presentation state intentionally live in
 * the reactive UI adapter instead.
 */
export class WorkflowGraphDomain {
  #graph: WorkflowGraphV2;
  #revision: number;
  readonly #idGenerator: WorkflowIdGenerator;

  constructor(graph: WorkflowGraphV2, options: WorkflowDomainOptions = {}) {
    const initialRevision = options.initialRevision ?? 0;
    if (!Number.isSafeInteger(initialRevision) || initialRevision < 0) {
      throw new WorkflowDomainError('INVALID_GRAPH', 'Initial graph revision must be a non-negative safe integer.', {
        initialRevision,
      });
    }
    this.#graph = normalizeGraph(graph);
    this.#revision = initialRevision;
    this.#idGenerator = options.idGenerator ?? defaultIdGenerator;
  }

  get graph(): WorkflowGraphV2 {
    return this.#graph;
  }

  get revision(): number {
    return this.#revision;
  }

  get contentRevision(): WorkflowGraphRevision {
    return Object.freeze({ graphId: this.#graph.id, revision: this.#revision });
  }

  node(nodeId: string): WorkflowNodeV2 | null {
    return this.#graph.nodes.find((node) => node.id === nodeId) ?? null;
  }

  edge(edgeId: string): WorkflowEdgeV2 | null {
    return this.#graph.edges.find((edge) => edge.id === edgeId) ?? null;
  }

  incoming(nodeId: string): WorkflowEdgeV2[] {
    return this.#graph.edges.filter((edge) => edge.target.nodeId === nodeId);
  }

  outgoing(nodeId: string): WorkflowEdgeV2[] {
    return this.#graph.edges.filter((edge) => edge.source.nodeId === nodeId);
  }

  isConnected(sourceNodeId: string, targetNodeId: string): boolean {
    return this.#graph.edges.some(
      (edge) => edge.source.nodeId === sourceNodeId && edge.target.nodeId === targetNodeId,
    );
  }

  validateConnection(endpoints: WorkflowConnectionEndpoints): WorkflowConnectionValidation {
    return validateConnectionInGraph(this.#graph, endpoints);
  }

  addNode(draft: WorkflowNodeDraft): WorkflowNodeV2 {
    const id = requireId(draft.id ?? this.#idGenerator('node'), 'node');
    if (this.#graph.nodes.some((node) => node.id === id)) {
      throw new WorkflowDomainError('DUPLICATE_NODE_ID', `A node with ID "${id}" already exists.`, { nodeId: id });
    }

    ensureJsonSafe(draft.config, `nodes.${id}.config`);
    const candidate = normalizeNegativeZero<WorkflowNodeV2>({ ...draft, id });
    assertFinitePoint(candidate.position, id);
    assertValidSize(candidate.size, id);
    this.commit({ ...this.#graph, nodes: [...this.#graph.nodes, candidate] });
    return this.#graph.nodes[this.#graph.nodes.length - 1];
  }

  /**
   * Atomically adds one node and one edge attached to it. Work is validated on
   * a shadow graph and published only after both operations succeed. Generated
   * IDs are external inputs and remain consumed when validation fails.
   */
  addNodeWithEdge(
    nodeDraft: WorkflowNodeDraft,
    attachedEdge: WorkflowAttachedEdgeDraft,
  ): WorkflowNodeWithEdgeResult {
    if (attachedEdge.direction !== 'incoming' && attachedEdge.direction !== 'outgoing') {
      throw new WorkflowDomainError(
        'INVALID_ATTACHED_EDGE_DIRECTION',
        'Attached edge direction must be incoming or outgoing.',
        { direction: String(attachedEdge.direction) },
      );
    }
    const working = new WorkflowGraphDomain(this.#graph, {
      idGenerator: this.#idGenerator,
      initialRevision: this.#revision,
    });
    const node = working.addNode(nodeDraft);
    const edge = working.addEdge({
      ...(attachedEdge.id === undefined ? {} : { id: attachedEdge.id }),
      source: attachedEdge.direction === 'outgoing'
        ? { nodeId: node.id, portId: attachedEdge.nodePortId }
        : attachedEdge.other,
      target: attachedEdge.direction === 'incoming'
        ? { nodeId: node.id, portId: attachedEdge.nodePortId }
        : attachedEdge.other,
    });
    this.#graph = working.#graph;
    this.#revision = working.#revision;
    return { node, edge };
  }

  removeNode(nodeId: string): void {
    this.requireNode(nodeId);
    this.commit({
      ...this.#graph,
      nodes: this.#graph.nodes.filter((node) => node.id !== nodeId),
      edges: this.#graph.edges.filter(
        (edge) => edge.source.nodeId !== nodeId && edge.target.nodeId !== nodeId,
      ),
      // Run records are node-owned provenance. Deleting a node removes only
      // that node's records so cross-links remain valid and unrelated history
      // retains its original order.
      runRecords: this.#graph.runRecords.filter((run) => run.nodeId !== nodeId),
    });
  }

  moveNode(nodeId: string, position: WorkflowPoint): void {
    const node = this.requireNode(nodeId);
    const normalizedPosition = normalizeNegativeZero(position);
    assertFinitePoint(normalizedPosition, nodeId);
    if (node.position.x === normalizedPosition.x && node.position.y === normalizedPosition.y) return;
    this.replaceNode(nodeId, { ...node, position: normalizedPosition });
  }

  resizeNode(nodeId: string, size: WorkflowSize): void {
    const node = this.requireNode(nodeId);
    const normalizedSize = normalizeNegativeZero(size);
    assertValidSize(normalizedSize, nodeId);
    if (node.size.width === normalizedSize.width && node.size.height === normalizedSize.height) return;
    this.replaceNode(nodeId, { ...node, size: normalizedSize });
  }

  configureNode(nodeId: string, config: Record<string, unknown>): void {
    const node = this.requireNode(nodeId);
    if (!isRecord(config)) {
      throw new WorkflowDomainError('INVALID_GRAPH', `Node "${nodeId}" configuration must be an object.`, {
        nodeId,
      });
    }
    ensureJsonSafe(config, `nodes.${nodeId}.config`);
    const normalizedConfig = normalizeNegativeZero(config);
    if (valuesEqual(node.config, normalizedConfig)) return;
    this.replaceNode(nodeId, { ...node, config: normalizedConfig });
  }

  updateNodePorts(nodeId: string, ports: WorkflowNodeV2['ports']): void {
    const node = this.requireNode(nodeId);
    const normalizedPorts = normalizeNegativeZero(ports);
    const inputIds = new Set(normalizedPorts.inputs.map((port) => port.id));
    const outputIds = new Set(normalizedPorts.outputs.map((port) => port.id));
    const candidate: WorkflowGraphV2 = {
      ...this.#graph,
      nodes: this.#graph.nodes.map((item) => item.id === nodeId ? { ...node, ports: normalizedPorts } : item),
      edges: this.#graph.edges.filter((edge) => (
        edge.target.nodeId !== nodeId || inputIds.has(edge.target.portId)
      ) && (
        edge.source.nodeId !== nodeId || outputIds.has(edge.source.portId)
      )),
    };
    if (valuesEqual(this.#graph, candidate)) return;
    this.commit(candidate);
  }

  updateNode(nodeId: string, update: WorkflowNodeUpdate): void {
    const node = this.requireNode(nodeId);
    if (update.config !== undefined) ensureJsonSafe(update.config, `nodes.${nodeId}.config`);
    const normalizedUpdate = normalizeNegativeZero(update);
    if (normalizedUpdate.position !== undefined) assertFinitePoint(normalizedUpdate.position, nodeId);
    if (normalizedUpdate.size !== undefined) assertValidSize(normalizedUpdate.size, nodeId);
    const replacement = { ...node, ...normalizedUpdate };
    if (valuesEqual(node, replacement)) return;
    this.replaceNode(nodeId, replacement);
  }

  addEdge(draft: WorkflowEdgeDraft): WorkflowEdgeV2 {
    const id = requireId(draft.id ?? this.#idGenerator('edge'), 'edge');
    if (this.#graph.edges.some((edge) => edge.id === id)) {
      throw new WorkflowDomainError('DUPLICATE_EDGE_ID', `An edge with ID "${id}" already exists.`, { edgeId: id });
    }
    const candidate = normalizeNegativeZero<WorkflowEdgeV2>({ ...draft, id });
    throwConnectionRejection(this.validateConnection(candidate));
    this.commit({ ...this.#graph, edges: [...this.#graph.edges, candidate] });
    return this.#graph.edges[this.#graph.edges.length - 1];
  }

  updateEdge(edgeId: string, endpoints: Pick<WorkflowEdgeV2, 'source' | 'target'>): void {
    const edge = this.requireEdge(edgeId);
    const normalizedEndpoints = normalizeNegativeZero(endpoints);
    if (endpointEquals(edge.source, normalizedEndpoints.source) && endpointEquals(edge.target, normalizedEndpoints.target)) return;
    throwConnectionRejection(validateConnectionInGraph(this.#graph, normalizedEndpoints, { excludedEdgeId: edgeId }));
    this.commit({
      ...this.#graph,
      edges: this.#graph.edges.map((item) => item.id === edgeId ? { ...item, ...normalizedEndpoints } : item),
    });
  }

  removeEdge(edgeId: string): void {
    this.requireEdge(edgeId);
    this.commit({ ...this.#graph, edges: this.#graph.edges.filter((edge) => edge.id !== edgeId) });
  }

  serialize(): string {
    try {
      return serializeWorkflowGraphV2(this.#graph);
    } catch (error) {
      if (error instanceof WorkflowDomainError) throw error;
      throw new WorkflowDomainError('SERIALIZATION_FAILED', 'Workflow graph could not be serialized.', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private replaceNode(nodeId: string, replacement: WorkflowNodeV2): void {
    this.commit({
      ...this.#graph,
      nodes: this.#graph.nodes.map((node) => node.id === nodeId ? replacement : node),
    });
  }

  private requireNode(nodeId: string): WorkflowNodeV2 {
    const node = this.#graph.nodes.find((item) => item.id === nodeId);
    if (!node) {
      throw new WorkflowDomainError('NODE_NOT_FOUND', `Node "${nodeId}" does not exist.`, { nodeId });
    }
    return node;
  }

  private requireEdge(edgeId: string): WorkflowEdgeV2 {
    const edge = this.#graph.edges.find((item) => item.id === edgeId);
    if (!edge) {
      throw new WorkflowDomainError('EDGE_NOT_FOUND', `Edge "${edgeId}" does not exist.`, { edgeId });
    }
    return edge;
  }

  private commit(candidate: WorkflowGraphV2): void {
    this.#graph = normalizeGraph(candidate);
    this.#revision += 1;
  }
}
