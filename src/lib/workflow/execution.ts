import { WorkflowGraphDomain } from './domain';
import type { WorkflowEdgeV2, WorkflowGraphV2, WorkflowNodeV2 } from './schema';

export type WorkflowNodeRuntimeStateName =
  | 'blocked'
  | 'ready'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'stale'
  | 'cancelled';

export type WorkflowBlockReasonCode =
  | 'UNSUPPORTED_NODE'
  | 'MISSING_REQUIRED_INPUT'
  | 'UPSTREAM_BLOCKED'
  | 'WAITING_FOR_DEPENDENCIES';

export interface WorkflowBlockReason {
  code: WorkflowBlockReasonCode;
  message: string;
}

export interface WorkflowExecutionFailure {
  code: string;
  message: string;
}

export interface WorkflowExecutionResult {
  cacheKey: string;
  outputIds: string[];
}

export interface WorkflowAcceptedOutput {
  id: string;
  assetReferenceId?: string;
  acceptedAt: number;
}

export interface WorkflowNodeRuntimeState {
  nodeId: string;
  state: WorkflowNodeRuntimeStateName;
  attempt: number;
  activeRunId?: string;
  startedAt?: number;
  finishedAt?: number;
  blockReason?: WorkflowBlockReason;
  error?: WorkflowExecutionFailure;
  lastResult?: WorkflowExecutionResult;
  acceptedOutputs: WorkflowAcceptedOutput[];
}

export interface WorkflowCachedResult {
  nodeId: string;
  cacheKey: string;
  outputIds: string[];
}

export interface WorkflowExecutionPlanOptions {
  maxConcurrency: number;
  cacheKeys?: Readonly<Record<string, string>>;
  cacheEntries?: readonly WorkflowCachedResult[];
  isCacheEntryReusable?: (entry: Readonly<WorkflowCachedResult>) => boolean;
}

export interface WorkflowExecutionPlan {
  targetNodeId: string;
  requiredNodeIds: string[];
  cachedNodeIds: string[];
  executionOrder: string[];
  batches: string[][];
  blocked: Array<WorkflowBlockReason & { nodeId: string }>;
}

export interface WorkflowCacheKeyMaterial {
  nodeType: WorkflowNodeV2['type'];
  materialInputs: readonly {
    portId: string;
    contentHash: string;
  }[];
  effectiveConfig: Readonly<Record<string, unknown>>;
  executorVersion: string;
  providerOptions: Readonly<Record<string, unknown>>;
}

export type WorkflowCacheHash = (canonicalMaterial: string) => string;

export type WorkflowExecutionErrorCode =
  | 'NODE_NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'INVALID_TRANSITION';

export class WorkflowExecutionError extends Error {
  constructor(
    readonly code: WorkflowExecutionErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'WorkflowExecutionError';
  }
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)]),
    ) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item));
    return Object.freeze(value) as T;
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach((item) => deepFreeze(item));
    return Object.freeze(value);
  }
  return value;
}

function detachedFrozen<T>(value: T): T {
  return deepFreeze(cloneValue(value));
}

function nodesById(graph: WorkflowGraphV2): Map<string, WorkflowNodeV2> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function activeEdges(graph: WorkflowGraphV2): WorkflowEdgeV2[] {
  const nodes = nodesById(graph);
  return graph.edges.filter((edge) => (
    nodes.get(edge.source.nodeId)?.type !== 'unsupported'
    && nodes.get(edge.target.nodeId)?.type !== 'unsupported'
  ));
}

function incomingEdges(edges: readonly WorkflowEdgeV2[], nodeId: string): WorkflowEdgeV2[] {
  return edges.filter((edge) => edge.target.nodeId === nodeId);
}

function missingRequiredInput(node: WorkflowNodeV2, edges: readonly WorkflowEdgeV2[]): string | null {
  return node.ports.inputs.find((port) => (
    port.required && !edges.some((edge) => edge.target.nodeId === node.id && edge.target.portId === port.id)
  ))?.id ?? null;
}

function unsupportedReason(node: WorkflowNodeV2): WorkflowBlockReason {
  return {
    code: 'UNSUPPORTED_NODE',
    message: `Node "${node.title}" uses an unsupported workflow type and cannot be executed.`,
  };
}

function missingInputReason(node: WorkflowNodeV2, portId: string): WorkflowBlockReason {
  return {
    code: 'MISSING_REQUIRED_INPUT',
    message: `Node "${node.title}" requires an input on port "${portId}" before it can run.`,
  };
}

function requireNode(graph: WorkflowGraphV2, nodeId: string): WorkflowNodeV2 {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) {
    throw new WorkflowExecutionError('NODE_NOT_FOUND', `Workflow node "${nodeId}" does not exist.`, { nodeId });
  }
  return node;
}

function hasValidResultStructure(result: unknown): result is WorkflowExecutionResult {
  if (typeof result !== 'object' || result === null) return false;
  const candidate = result as Partial<WorkflowExecutionResult>;
  if (typeof candidate.cacheKey !== 'string' || candidate.cacheKey.trim().length === 0) return false;
  if (!Array.isArray(candidate.outputIds) || candidate.outputIds.length === 0) return false;
  const outputIds = new Set<string>();
  for (const outputId of candidate.outputIds) {
    if (typeof outputId !== 'string' || outputId.trim().length === 0 || outputIds.has(outputId)) return false;
    outputIds.add(outputId);
  }
  return true;
}

function reusableCacheEntries(
  entries: readonly WorkflowCachedResult[],
  hook?: WorkflowExecutionPlanOptions['isCacheEntryReusable'],
): Map<string, WorkflowCachedResult> {
  const candidates = new Map<string, Map<string, WorkflowCachedResult>>();
  for (const entry of entries) {
    if (typeof entry?.nodeId !== 'string' || entry.nodeId.trim().length === 0) continue;
    if (!hasValidResultStructure(entry)) continue;
    const key = `${entry.nodeId}\u0000${entry.cacheKey}`;
    const signature = JSON.stringify(entry.outputIds);
    const variants = candidates.get(key) ?? new Map<string, WorkflowCachedResult>();
    if (!variants.has(signature)) variants.set(signature, cloneValue(entry));
    candidates.set(key, variants);
  }

  const reusable = new Map<string, WorkflowCachedResult>();
  for (const [key, variants] of candidates) {
    if (variants.size !== 1) continue;
    const entry = variants.values().next().value as WorkflowCachedResult;
    try {
      if (hook && hook(detachedFrozen(entry)) !== true) continue;
    } catch {
      continue;
    }
    reusable.set(key, entry);
  }
  return reusable;
}

export function planWorkflowExecution(
  inputGraph: WorkflowGraphV2,
  targetNodeId: string,
  options: WorkflowExecutionPlanOptions,
): WorkflowExecutionPlan {
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency <= 0) {
    throw new WorkflowExecutionError(
      'INVALID_ARGUMENT',
      'Execution concurrency must be a positive safe integer.',
      { maxConcurrency: options.maxConcurrency },
    );
  }
  const graph = new WorkflowGraphDomain(inputGraph).graph;
  requireNode(graph, targetNodeId);
  const edges = activeEdges(graph);
  const closure = new Set<string>();
  const visitUpstream = (nodeId: string): void => {
    if (closure.has(nodeId)) return;
    closure.add(nodeId);
    for (const edge of incomingEdges(edges, nodeId)) visitUpstream(edge.source.nodeId);
  };
  visitUpstream(targetNodeId);
  const requiredNodeIds = graph.nodes.filter((node) => closure.has(node.id)).map((node) => node.id);

  // Eligibility is derived from the active graph before consulting cache.
  // A result can skip work, but it cannot make an unsupported or blocked node executable.
  const blockedById = new Map<string, WorkflowBlockReason>();
  for (const node of graph.nodes) {
    if (!closure.has(node.id)) continue;
    if (node.type === 'unsupported') {
      blockedById.set(node.id, unsupportedReason(node));
      continue;
    }
    const missingPort = missingRequiredInput(node, edges);
    if (missingPort) blockedById.set(node.id, missingInputReason(node, missingPort));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (!closure.has(node.id) || blockedById.has(node.id)) continue;
      const blockedUpstream = incomingEdges(edges, node.id)
        .map((edge) => edge.source.nodeId)
        .find((nodeId) => blockedById.has(nodeId));
      if (blockedUpstream) {
        blockedById.set(node.id, {
          code: 'UPSTREAM_BLOCKED',
          message: `Node "${node.title}" is blocked because upstream node "${blockedUpstream}" cannot run.`,
        });
        changed = true;
      }
    }
  }

  const cacheEntries = reusableCacheEntries(options.cacheEntries ?? [], options.isCacheEntryReusable);
  const cached = new Set(requiredNodeIds.filter((nodeId) => {
    if (blockedById.has(nodeId)) return false;
    const cacheKey = options.cacheKeys?.[nodeId];
    return cacheKey !== undefined && cacheEntries.has(`${nodeId}\u0000${cacheKey}`);
  }));

  const needed = new Set<string>();
  const visitNeeded = (nodeId: string): void => {
    if (needed.has(nodeId)) return;
    needed.add(nodeId);
    if (cached.has(nodeId)) return;
    for (const edge of incomingEdges(edges, nodeId)) visitNeeded(edge.source.nodeId);
  };
  visitNeeded(targetNodeId);

  const pending = new Set(graph.nodes
    .filter((node) => needed.has(node.id) && !cached.has(node.id) && !blockedById.has(node.id))
    .map((node) => node.id));
  const completed = new Set(cached);
  const batches: string[][] = [];
  while (pending.size > 0) {
    const ready = graph.nodes
      .filter((node) => pending.has(node.id))
      .filter((node) => incomingEdges(edges, node.id).every((edge) => (
        !needed.has(edge.source.nodeId) || completed.has(edge.source.nodeId)
      )))
      .slice(0, options.maxConcurrency)
      .map((node) => node.id);
    if (ready.length === 0) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        'Execution planning could not resolve the remaining dependencies.',
        { pendingNodeIds: [...pending] },
      );
    }
    batches.push(ready);
    ready.forEach((nodeId) => {
      pending.delete(nodeId);
      completed.add(nodeId);
    });
  }

  return detachedFrozen({
    targetNodeId,
    requiredNodeIds,
    cachedNodeIds: requiredNodeIds.filter((nodeId) => cached.has(nodeId)),
    executionOrder: batches.flat(),
    batches,
    blocked: graph.nodes
      .filter((node) => blockedById.has(node.id))
      .map((node) => ({ nodeId: node.id, ...blockedById.get(node.id)! })),
  });
}

export function affectedWorkflowNodes(
  inputGraph: WorkflowGraphV2,
  changedNodeIds: readonly string[],
): string[] {
  const graph = new WorkflowGraphDomain(inputGraph).graph;
  changedNodeIds.forEach((nodeId) => requireNode(graph, nodeId));
  const edges = activeEdges(graph);
  const affected = new Set(changedNodeIds);
  const pending = [...changedNodeIds];
  while (pending.length > 0) {
    const current = pending.shift()!;
    for (const edge of edges) {
      if (edge.source.nodeId !== current || affected.has(edge.target.nodeId)) continue;
      affected.add(edge.target.nodeId);
      pending.push(edge.target.nodeId);
    }
  }
  return graph.nodes.filter((node) => affected.has(node.id)).map((node) => node.id);
}

function canonicalJson(value: unknown, path = 'cache material', ancestors = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new WorkflowExecutionError('INVALID_ARGUMENT', `${path} must be JSON-safe.`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') {
    throw new WorkflowExecutionError('INVALID_ARGUMENT', `${path} must be JSON-safe.`);
  }
  if (ancestors.has(value)) {
    throw new WorkflowExecutionError('INVALID_ARGUMENT', `${path} must be JSON-safe and acyclic.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const extraKeys = Reflect.ownKeys(value).filter((key) => (
        key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(String(key))
      ));
      if (extraKeys.length > 0) {
        throw new WorkflowExecutionError('INVALID_ARGUMENT', `${path} must be JSON-safe plain data.`);
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          throw new WorkflowExecutionError('INVALID_ARGUMENT', `${path} must be JSON-safe and cannot be sparse.`);
        }
        items.push(canonicalJson(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkflowExecutionError('INVALID_ARGUMENT', `${path} must be JSON-safe plain data.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) {
      throw new WorkflowExecutionError('INVALID_ARGUMENT', `${path} must be JSON-safe and cannot use symbol keys.`);
    }
    return `{${(keys as string[])
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new WorkflowExecutionError('INVALID_ARGUMENT', `${path}.${key} must be JSON-safe plain data.`);
        }
        return `${JSON.stringify(key)}:${canonicalJson(descriptor.value, `${path}.${key}`, ancestors)}`;
      })
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function createWorkflowCacheKey(
  material: WorkflowCacheKeyMaterial,
  hash: WorkflowCacheHash,
): string {
  if (typeof hash !== 'function') {
    throw new WorkflowExecutionError('INVALID_ARGUMENT', 'A cache hash function must be supplied.');
  }
  const canonical = canonicalJson({
    schema: 'paintnode-workflow-cache-v1',
    nodeType: material.nodeType,
    materialInputs: material.materialInputs,
    effectiveConfig: material.effectiveConfig,
    executorVersion: material.executorVersion,
    providerOptions: material.providerOptions,
  });
  const digest = hash(canonical);
  if (typeof digest !== 'string' || digest.length === 0) {
    throw new WorkflowExecutionError('INVALID_ARGUMENT', 'The cache hash function must return a non-empty string.');
  }
  return `workflow-cache-v1:${digest}`;
}

export interface WorkflowExecutionRuntimeOptions {
  clock?: () => number;
  runIdGenerator?: (nodeId: string, attempt: number) => string;
}

export class WorkflowExecutionRuntime {
  readonly #graph: WorkflowGraphV2;
  readonly #edges: WorkflowEdgeV2[];
  readonly #states = new Map<string, WorkflowNodeRuntimeState>();
  readonly #clock: () => number;
  readonly #runIdGenerator: (nodeId: string, attempt: number) => string;

  constructor(inputGraph: WorkflowGraphV2, options: WorkflowExecutionRuntimeOptions = {}) {
    this.#graph = new WorkflowGraphDomain(inputGraph).graph;
    this.#edges = activeEdges(this.#graph);
    this.#clock = options.clock ?? (() => 0);
    this.#runIdGenerator = options.runIdGenerator ?? ((nodeId, attempt) => `${nodeId}:attempt-${attempt}`);
    for (const node of this.#graph.nodes) {
      const availability = this.initialAvailability(node);
      this.#states.set(node.id, {
        nodeId: node.id,
        state: availability.state,
        attempt: 0,
        ...(availability.blockReason ? { blockReason: availability.blockReason } : {}),
        acceptedOutputs: [],
      });
    }
  }

  node(nodeId: string): WorkflowNodeRuntimeState {
    return detachedFrozen(this.requireState(nodeId));
  }

  start(nodeId: string): WorkflowNodeRuntimeState {
    const current = this.requireState(nodeId);
    this.assertState(current, ['ready'], 'start');
    const attempt = current.attempt + 1;
    const activeRunId = this.#runIdGenerator(nodeId, attempt);
    if (typeof activeRunId !== 'string' || activeRunId.length === 0) {
      throw new WorkflowExecutionError('INVALID_ARGUMENT', 'Run IDs must be non-empty strings.', { nodeId, attempt });
    }
    const startedAt = this.readTimestamp('start', nodeId);
    this.#states.set(nodeId, {
      ...current,
      state: 'running',
      attempt,
      activeRunId,
      startedAt,
      blockReason: undefined,
      error: undefined,
    });
    return this.node(nodeId);
  }

  succeed(nodeId: string, result: WorkflowExecutionResult): WorkflowNodeRuntimeState {
    const current = this.requireState(nodeId);
    this.assertState(current, ['running'], 'succeed');
    if (!hasValidResultStructure(result)) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        'Successful results require a cache key and a non-empty list of unique, non-blank output IDs.',
        { nodeId },
      );
    }
    const lastResult = cloneValue(result);
    const finishedAt = this.readTimestamp('succeed', nodeId);
    this.#states.set(nodeId, {
      ...current,
      state: 'succeeded',
      activeRunId: undefined,
      finishedAt,
      error: undefined,
      lastResult,
    });
    this.refreshWaitingNodes();
    return this.node(nodeId);
  }

  fail(nodeId: string, failure: WorkflowExecutionFailure): WorkflowNodeRuntimeState {
    const current = this.requireState(nodeId);
    this.assertState(current, ['running'], 'fail');
    const error = cloneValue(failure);
    const finishedAt = this.readTimestamp('fail', nodeId);
    this.#states.set(nodeId, {
      ...current,
      state: 'failed',
      activeRunId: undefined,
      finishedAt,
      error,
    });
    return this.node(nodeId);
  }

  cancel(nodeId: string, message: string): WorkflowNodeRuntimeState {
    const current = this.requireState(nodeId);
    this.assertState(current, ['running'], 'cancel');
    const finishedAt = this.readTimestamp('cancel', nodeId);
    this.#states.set(nodeId, {
      ...current,
      state: 'cancelled',
      activeRunId: undefined,
      finishedAt,
      error: { code: 'CANCELLED', message },
    });
    return this.node(nodeId);
  }

  retry(nodeId: string): WorkflowNodeRuntimeState {
    const current = this.requireState(nodeId);
    this.assertState(current, ['blocked', 'failed', 'stale', 'cancelled'], 'retry');
    const availability = this.currentAvailability(requireNode(this.#graph, nodeId));
    this.#states.set(nodeId, {
      ...current,
      state: availability.state,
      activeRunId: undefined,
      startedAt: undefined,
      finishedAt: undefined,
      error: undefined,
      blockReason: availability.blockReason,
    });
    return this.node(nodeId);
  }

  acceptOutput(
    nodeId: string,
    output: Omit<WorkflowAcceptedOutput, 'acceptedAt'>,
  ): WorkflowNodeRuntimeState {
    const current = this.requireState(nodeId);
    this.assertState(current, ['succeeded', 'stale'], 'accept output for');
    if (!output.id) throw new WorkflowExecutionError('INVALID_ARGUMENT', 'Accepted output IDs must be non-empty.', { nodeId });
    const clonedOutput = cloneValue(output);
    const acceptedAt = this.readTimestamp('accept output', nodeId);
    const accepted: WorkflowAcceptedOutput = { ...clonedOutput, acceptedAt };
    this.#states.set(nodeId, {
      ...current,
      acceptedOutputs: [...current.acceptedOutputs.filter((item) => item.id !== output.id), accepted],
    });
    return this.node(nodeId);
  }

  invalidateMaterialChange(nodeId: string): string[] {
    const affected = affectedWorkflowNodes(this.#graph, [nodeId]);
    for (const affectedNodeId of affected) {
      const current = this.requireState(affectedNodeId);
      if (current.lastResult !== undefined || current.state === 'running' || current.state === 'succeeded') {
        this.#states.set(affectedNodeId, {
          ...current,
          state: 'stale',
          activeRunId: undefined,
          blockReason: undefined,
          error: undefined,
        });
        continue;
      }
      if (incomingEdges(this.#edges, affectedNodeId).length > 0) {
        this.#states.set(affectedNodeId, {
          ...current,
          state: 'blocked',
          activeRunId: undefined,
          blockReason: {
            code: 'WAITING_FOR_DEPENDENCIES',
            message: `Node "${requireNode(this.#graph, affectedNodeId).title}" is waiting for its upstream dependencies.`,
          },
          error: undefined,
        });
      }
    }
    return affected;
  }

  private initialAvailability(node: WorkflowNodeV2): Pick<WorkflowNodeRuntimeState, 'state' | 'blockReason'> {
    if (node.type === 'unsupported') return { state: 'blocked', blockReason: unsupportedReason(node) };
    const missingPort = missingRequiredInput(node, this.#edges);
    if (missingPort) return { state: 'blocked', blockReason: missingInputReason(node, missingPort) };
    if (incomingEdges(this.#edges, node.id).length > 0) {
      return {
        state: 'blocked',
        blockReason: {
          code: 'WAITING_FOR_DEPENDENCIES',
          message: `Node "${node.title}" is waiting for its upstream dependencies.`,
        },
      };
    }
    return { state: 'ready' };
  }

  private currentAvailability(node: WorkflowNodeV2): Pick<WorkflowNodeRuntimeState, 'state' | 'blockReason'> {
    const initial = this.initialAvailability(node);
    if (initial.blockReason?.code !== 'WAITING_FOR_DEPENDENCIES') return initial;
    const upstream = incomingEdges(this.#edges, node.id).map((edge) => this.requireState(edge.source.nodeId));
    return upstream.every((state) => state.state === 'succeeded')
      ? { state: 'ready' }
      : initial;
  }

  private refreshWaitingNodes(): void {
    for (const node of this.#graph.nodes) {
      const current = this.requireState(node.id);
      if (current.state !== 'blocked' || current.blockReason?.code !== 'WAITING_FOR_DEPENDENCIES') continue;
      const availability = this.currentAvailability(node);
      if (availability.state === 'ready') {
        this.#states.set(node.id, { ...current, state: 'ready', blockReason: undefined });
      }
    }
  }

  private requireState(nodeId: string): WorkflowNodeRuntimeState {
    const state = this.#states.get(nodeId);
    if (!state) throw new WorkflowExecutionError('NODE_NOT_FOUND', `Workflow node "${nodeId}" does not exist.`, { nodeId });
    return state;
  }

  private readTimestamp(action: string, nodeId: string): number {
    let timestamp: number;
    try {
      timestamp = this.#clock();
    } catch (error) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        `The execution clock failed while attempting to ${action} node "${nodeId}".`,
        { nodeId, action, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (!Number.isFinite(timestamp)) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        `The execution clock must return a finite timestamp before it can ${action} node "${nodeId}".`,
        { nodeId, action, timestamp },
      );
    }
    return timestamp;
  }

  private assertState(
    state: WorkflowNodeRuntimeState,
    allowed: readonly WorkflowNodeRuntimeStateName[],
    action: string,
  ): void {
    if (!allowed.includes(state.state)) {
      throw new WorkflowExecutionError(
        'INVALID_TRANSITION',
        `Cannot ${action} node "${state.nodeId}" while it is ${state.state}.`,
        { nodeId: state.nodeId, state: state.state, action },
      );
    }
  }
}
