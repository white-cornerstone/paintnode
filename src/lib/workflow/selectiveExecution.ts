import { WorkflowGraphDomain } from './domain';
import {
  WorkflowExecutionError,
  type WorkflowBlockReason,
  type WorkflowCachedResult,
  type WorkflowExecutionResult,
} from './execution';
import { isFullWorkflowRunRecord } from './provenance';
import { resolveWorkflowReviewTopology, workflowReviewPromotionMaterialKey } from './candidatePromotion';
import { creatorNodeDefinition, type CreatorNodeType } from './registry';
import type {
  WorkflowEdgeV2,
  WorkflowGraphV2,
  WorkflowNodeV2,
  WorkflowRunRecordV1,
} from './schema';

export type WorkflowSelectiveRunMode = 'run-node' | 'run-from-here';
export type WorkflowPreflightState = 'planned' | 'cached' | 'blocked' | 'stale';

export type WorkflowPreflightReasonCode =
  | WorkflowBlockReason['code']
  | 'NODE_DISABLED'
  | 'MATERIAL_CHANGED'
  | 'CACHED_OUTPUT_UNAVAILABLE'
  | 'REUSABLE_RESULT'
  | 'CONTEXT_SATISFIED'
  | 'PRUNED_BY_REUSABLE_RESULT'
  | 'NO_REUSABLE_RESULT';

export interface WorkflowPreflightReason {
  code: WorkflowPreflightReasonCode;
  message: string;
}

export interface WorkflowNodePreflight {
  nodeId: string;
  state: WorkflowPreflightState;
  willExecute: boolean;
  reason: WorkflowPreflightReason;
}

export interface WorkflowNodeExecutionDisposition {
  kind: 'not-required' | 'available' | 'unavailable';
  reason?: string;
}

export interface WorkflowExecutionRestriction {
  nodeId: string;
  kind: 'not-required' | 'unavailable';
  reason?: string;
}

declare const workflowExecutionRestrictionsBrand: unique symbol;
export interface WorkflowExecutionRestrictions {
  readonly [workflowExecutionRestrictionsBrand]: true;
}

const trustedExecutionRestrictions = new WeakMap<object, ReadonlyMap<string, WorkflowExecutionRestriction>>();

export interface WorkflowSelectiveExecutionRequest {
  mode: WorkflowSelectiveRunMode;
  nodeId: string;
  materialKeys: Readonly<Record<string, string>>;
  executionRestrictions?: WorkflowExecutionRestrictions;
  isRunRecordReusable?: (record: Readonly<WorkflowRunRecordV1>) => boolean;
  reviewMaterialKeys?: Readonly<Record<string, string>>;
  isReviewOutputAvailable?: (output: Readonly<WorkflowRunRecordV1['outputs'][number]>) => boolean;
}

export interface WorkflowSelectiveExecutionPlan {
  mode: WorkflowSelectiveRunMode;
  targetNodeId: string;
  affectedNodeIds: string[];
  requiredNodeIds: string[];
  executionNodeIds: string[];
  preflight: WorkflowNodePreflight[];
  nodes: WorkflowNodeV2[];
  dependencies: Readonly<Record<string, string[]>>;
  materialKeys: Readonly<Record<string, string>>;
  cachedResults: WorkflowCachedResult[];
}

export interface WorkflowSelectiveNodeExecutionContext {
  nodeId: string;
  node: Readonly<WorkflowNodeV2>;
  materialKey: string;
  dependencyResults: ReadonlyMap<string, Readonly<WorkflowExecutionResult>>;
  signal?: AbortSignal;
}

export interface WorkflowSelectiveSchedulerOptions {
  maxConcurrency: number;
  providerKeyForNode: (node: Readonly<WorkflowNodeV2>) => string;
  providerConcurrency: Readonly<Record<string, number>>;
  executeNode: (context: WorkflowSelectiveNodeExecutionContext) => Promise<WorkflowExecutionResult>;
  validateResultOwnership: (context: Readonly<{
    nodeId: string;
    result: Readonly<WorkflowExecutionResult>;
  }>) => boolean;
  sanitizeFailure?: (error: unknown) => WorkflowSelectiveNodeFailure;
  signal?: AbortSignal;
}

export interface WorkflowSelectiveExecutionOutcome {
  executedNodeIds: string[];
  cachedNodeIds: string[];
  results: Readonly<Record<string, Readonly<WorkflowExecutionResult>>>;
  failures: Readonly<Record<string, Readonly<WorkflowSelectiveNodeFailure>>>;
  blockedNodeIds: string[];
  cancelledNodeIds: string[];
}

export interface WorkflowSelectiveNodeFailure {
  code: string;
  message: string;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
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

function incomingNodeIds(edges: readonly WorkflowEdgeV2[], nodeId: string): string[] {
  return edges.filter((edge) => edge.target.nodeId === nodeId).map((edge) => edge.source.nodeId);
}

function requireNode(graph: WorkflowGraphV2, nodeId: string): WorkflowNodeV2 {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new WorkflowExecutionError('NODE_NOT_FOUND', `Workflow node "${nodeId}" does not exist.`, { nodeId });
  }
  return node;
}

function requireMaterialKey(materialKeys: Readonly<Record<string, string>>, nodeId: string): string {
  const key = materialKeys[nodeId];
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new WorkflowExecutionError(
      'INVALID_ARGUMENT',
      `Workflow node "${nodeId}" requires a current #77 material key before selective execution can be planned.`,
      { nodeId },
    );
  }
  return key;
}

function missingRequiredInput(
  node: WorkflowNodeV2,
  edges: readonly WorkflowEdgeV2[],
): string | undefined {
  return node.ports.inputs.find((port) => (
    port.required && !edges.some((edge) => edge.target.nodeId === node.id && edge.target.portId === port.id)
  ))?.id;
}

export function registryExecutionDisposition(node: Readonly<WorkflowNodeV2>): WorkflowNodeExecutionDisposition {
  if (node.type === 'unsupported') {
    return { kind: 'unavailable', reason: `Node "${node.title}" uses an unsupported workflow type.` };
  }
  const executor = creatorNodeDefinition(node.type as CreatorNodeType).executor;
  if (executor.status === 'not-required') return { kind: 'not-required' };
  if (executor.status === 'draft-only') {
    return {
      kind: 'unavailable',
      reason: executor.reason ?? `Execution for node "${node.title}" is not available yet.`,
    };
  }
  const configuredCapability = node.config.capability;
  if (typeof configuredCapability !== 'string' || configuredCapability !== executor.capability) {
    return {
      kind: 'unavailable',
      reason: 'The configured Transform capability is not available for execution.',
    };
  }
  return { kind: 'available' };
}

export function createWorkflowExecutionRestrictions(
  input: readonly WorkflowExecutionRestriction[],
): WorkflowExecutionRestrictions {
  let snapshot: unknown;
  try {
    snapshot = structuredClone(input);
  } catch {
    throw new WorkflowExecutionError(
      'INVALID_ARGUMENT',
      'Execution restrictions must be detached plain data.',
    );
  }
  if (!Array.isArray(snapshot)) {
    throw new WorkflowExecutionError('INVALID_ARGUMENT', 'Execution restrictions must be an array.');
  }
  const restrictions = new Map<string, WorkflowExecutionRestriction>();
  for (const value of snapshot) {
    if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new WorkflowExecutionError('INVALID_ARGUMENT', 'Each execution restriction must be a plain object.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string' || !['nodeId', 'kind', 'reason'].includes(key))
      || !keys.includes('nodeId') || !keys.includes('kind')) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        'Execution restrictions contain unsupported fields.',
      );
    }
    const descriptors = Object.fromEntries((keys as string[]).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(value, key),
    ]));
    if (Object.values(descriptors).some((descriptor) => !descriptor?.enumerable || !('value' in descriptor))) {
      throw new WorkflowExecutionError('INVALID_ARGUMENT', 'Execution restrictions must contain own data fields.');
    }
    const nodeId = descriptors.nodeId?.value;
    const kind = descriptors.kind?.value;
    const reason = descriptors.reason?.value;
    if (typeof nodeId !== 'string' || nodeId.trim().length === 0
      || (kind !== 'not-required' && kind !== 'unavailable')
      || (keys.includes('reason') && typeof reason !== 'string')) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        'Execution restrictions may only demote or disable a named node.',
      );
    }
    if (restrictions.has(nodeId)) {
      throw new WorkflowExecutionError('INVALID_ARGUMENT', `Execution restriction for node "${nodeId}" is duplicated.`);
    }
    restrictions.set(nodeId, deepFreeze({
      nodeId,
      kind,
      ...(typeof reason === 'string' ? { reason } : {}),
    }));
  }
  const handle = Object.freeze(Object.create(null)) as WorkflowExecutionRestrictions;
  trustedExecutionRestrictions.set(handle, restrictions);
  return handle;
}

function safeFailure(
  error: unknown,
  sanitizer?: WorkflowSelectiveSchedulerOptions['sanitizeFailure'],
): WorkflowSelectiveNodeFailure {
  if (sanitizer) {
    try {
      const failure = sanitizer(error);
      if (typeof failure?.code === 'string' && failure.code.trim()
        && typeof failure.message === 'string' && failure.message.trim()) {
        return { code: failure.code, message: failure.message };
      }
    } catch {
      // A boundary sanitizer is fail-closed just like artifact verification.
    }
  }
  return { code: 'EXECUTOR_FAILED', message: 'Node execution failed. Retry the node or inspect safe run diagnostics.' };
}

function linkedSuccessfulRuns(graph: WorkflowGraphV2, node: WorkflowNodeV2): WorkflowRunRecordV1[] {
  return node.runRecordIds
    .map((id) => graph.runRecords.find((record) => record.id === id))
    .filter((record): record is WorkflowRunRecordV1 => Boolean(
      record
      && isFullWorkflowRunRecord(record)
      && record.nodeId === node.id
      && !record.candidate
      && record.status === 'succeeded'
      && record.outputs.length > 0,
    ));
}

function reusableRun(
  runs: readonly WorkflowRunRecordV1[],
  materialKey: string,
  hook?: WorkflowSelectiveExecutionRequest['isRunRecordReusable'],
): { reusable?: WorkflowRunRecordV1; exactUnavailable: boolean } {
  let exactUnavailable = false;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    if (run.materialKey !== materialKey) continue;
    if (!hook) {
      exactUnavailable = true;
      continue;
    }
    try {
      if (hook(detachedFrozen(run)) === true) return { reusable: run, exactUnavailable: false };
    } catch {
      // Boundary checks are deliberately fail-closed: a missing asset is a cache miss.
    }
    exactUnavailable = true;
  }
  return { exactUnavailable };
}

function hasValidResult(result: unknown): result is WorkflowExecutionResult {
  if (typeof result !== 'object' || result === null) return false;
  const prototype = Object.getPrototypeOf(result);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(result);
  if (keys.some((key) => typeof key !== 'string')) return false;
  if ((keys as string[]).sort().join('\u0000') !== ['cacheKey', 'outputIds'].sort().join('\u0000')) return false;
  if ((keys as string[]).some((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    return !descriptor?.enumerable || !('value' in descriptor);
  })) return false;
  const candidate = result as Partial<WorkflowExecutionResult>;
  if (typeof candidate.cacheKey !== 'string' || candidate.cacheKey.trim().length === 0) return false;
  if (!Array.isArray(candidate.outputIds) || candidate.outputIds.length === 0) return false;
  if (Object.getPrototypeOf(candidate.outputIds) !== Array.prototype) return false;
  if (Reflect.ownKeys(candidate.outputIds).some((key) => (
    key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key))
  ))) return false;
  const unique = new Set<string>();
  for (let index = 0; index < candidate.outputIds.length; index += 1) {
    if (!(index in candidate.outputIds)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(candidate.outputIds, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) return false;
    const id = descriptor.value;
    if (typeof id !== 'string' || id.trim().length === 0 || unique.has(id)) return false;
    unique.add(id);
  }
  return true;
}

function snapshotExecutorResult(result: unknown): Readonly<WorkflowExecutionResult> | null {
  try {
    const snapshot = detachedFrozen(result);
    return hasValidResult(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

export function planSelectiveWorkflowExecution(
  inputGraph: WorkflowGraphV2,
  request: WorkflowSelectiveExecutionRequest,
): WorkflowSelectiveExecutionPlan {
  if (request.mode !== 'run-node' && request.mode !== 'run-from-here') {
    throw new WorkflowExecutionError('INVALID_ARGUMENT', 'Selective execution mode is not supported.', {
      mode: request.mode,
    });
  }
  const graph = new WorkflowGraphDomain(inputGraph).graph;
  requireNode(graph, request.nodeId);
  let restrictions: ReadonlyMap<string, WorkflowExecutionRestriction> = new Map();
  try {
    const restrictionHandle = request.executionRestrictions;
    if (restrictionHandle !== undefined) {
      const trusted = trustedExecutionRestrictions.get(restrictionHandle);
      if (!trusted) {
        throw new WorkflowExecutionError(
          'INVALID_ARGUMENT',
          'Execution restrictions were not created by the trusted workflow boundary.',
        );
      }
      restrictions = trusted;
    }
  } catch (error) {
    if (error instanceof WorkflowExecutionError) throw error;
    throw new WorkflowExecutionError(
      'INVALID_ARGUMENT',
      'Execution restrictions could not be read safely.',
    );
  }
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  for (const nodeId of restrictions.keys()) {
    if (!graphNodeIds.has(nodeId)) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        `Execution restriction references missing node "${nodeId}".`,
        { nodeId },
      );
    }
  }
  const edges = activeEdges(graph);

  const affected = new Set<string>([request.nodeId]);
  if (request.mode === 'run-from-here') {
    const pending = [request.nodeId];
    while (pending.length > 0) {
      const current = pending.shift()!;
      for (const edge of edges) {
        if (edge.source.nodeId !== current || affected.has(edge.target.nodeId)) continue;
        affected.add(edge.target.nodeId);
        pending.push(edge.target.nodeId);
      }
    }
  }
  const affectedNodeIds = graph.nodes.filter((node) => affected.has(node.id)).map((node) => node.id);

  const required = new Set<string>();
  const visitUpstream = (nodeId: string): void => {
    if (required.has(nodeId)) return;
    required.add(nodeId);
    incomingNodeIds(edges, nodeId).forEach(visitUpstream);
  };
  affectedNodeIds.forEach(visitUpstream);
  const requiredNodeIds = graph.nodes.filter((node) => required.has(node.id)).map((node) => node.id);
  const dispositions = new Map<string, WorkflowNodeExecutionDisposition>();
  const promotedReviewResults = new Map<string, WorkflowCachedResult>();
  for (const node of graph.nodes) {
    if (!required.has(node.id)) continue;
    let registryDisposition = registryExecutionDisposition(node);
    if (node.type === 'review') {
      const resolution = resolveWorkflowReviewTopology(graph, {
        reviewNodeId: node.id,
        currentMaterialKeys: request.reviewMaterialKeys,
        isOutputAvailable: request.isReviewOutputAvailable,
      });
      if (resolution.state === 'ready') {
        registryDisposition = { kind: 'available' };
        promotedReviewResults.set(node.id, {
          nodeId: node.id,
          cacheKey: workflowReviewPromotionMaterialKey(resolution),
          outputIds: [resolution.output.assetReferenceId],
        });
      } else {
        registryDisposition = { kind: 'unavailable', reason: resolution.reason.message };
      }
    }
    let disposition = registryDisposition;
    const restriction = restrictions.get(node.id);
    if (restriction && registryDisposition.kind === 'available') {
      disposition = { kind: restriction.kind, ...(restriction.reason ? { reason: restriction.reason } : {}) };
    } else if (restriction && registryDisposition.kind === 'not-required' && restriction.kind === 'unavailable') {
      disposition = { kind: restriction.kind, ...(restriction.reason ? { reason: restriction.reason } : {}) };
    }
    dispositions.set(node.id, disposition);
  }
  const blocked = new Map<string, WorkflowPreflightReason>();
  for (const node of graph.nodes) {
    if (!required.has(node.id)) continue;
    const disposition = dispositions.get(node.id)!;
    if (disposition.kind === 'unavailable') {
      blocked.set(node.id, {
        code: node.type === 'unsupported' ? 'UNSUPPORTED_NODE' : 'NODE_DISABLED',
        message: disposition.reason?.trim() || `Node "${node.title}" requires an executor that is unavailable.`,
      });
      continue;
    }
    const missingPort = missingRequiredInput(node, edges);
    if (missingPort) {
      blocked.set(node.id, {
        code: 'MISSING_REQUIRED_INPUT',
        message: `Node "${node.title}" requires an input on port "${missingPort}" before it can run.`,
      });
      continue;
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of graph.nodes) {
      if (!required.has(node.id) || blocked.has(node.id)) continue;
      const blockedUpstream = incomingNodeIds(edges, node.id).find((nodeId) => blocked.has(nodeId));
      if (!blockedUpstream) continue;
      blocked.set(node.id, {
        code: 'UPSTREAM_BLOCKED',
        message: `Node "${node.title}" is blocked because upstream node "${blockedUpstream}" cannot run.`,
      });
      changed = true;
    }
  }
  const materialKeys = Object.fromEntries(graph.nodes
    .filter((node) => required.has(node.id)
      && dispositions.get(node.id)?.kind === 'available'
      && !blocked.has(node.id))
    .map((node) => [
      node.id,
      promotedReviewResults.get(node.id)?.cacheKey ?? requireMaterialKey(request.materialKeys, node.id),
    ]));

  const cachedRuns = new Map<string, WorkflowRunRecordV1>();
  const latestSuccessful = new Map<string, WorkflowRunRecordV1>();
  const unavailableExact = new Set<string>();
  for (const node of graph.nodes) {
    if (!required.has(node.id) || blocked.has(node.id)
      || dispositions.get(node.id)?.kind !== 'available') continue;
    const runs = linkedSuccessfulRuns(graph, node);
    if (runs.length > 0) latestSuccessful.set(node.id, runs.at(-1)!);
    const match = reusableRun(runs, materialKeys[node.id], request.isRunRecordReusable);
    if (match.reusable) cachedRuns.set(node.id, match.reusable);
    if (match.exactUnavailable) unavailableExact.add(node.id);
  }

  const needed = new Set<string>();
  const visitNeeded = (nodeId: string): void => {
    if (needed.has(nodeId)) return;
    needed.add(nodeId);
    if (blocked.has(nodeId) && graph.nodes.some((node) => node.id === nodeId && node.type === 'review')) return;
    if (cachedRuns.has(nodeId) || promotedReviewResults.has(nodeId)) return;
    incomingNodeIds(edges, nodeId).forEach(visitNeeded);
  };
  affectedNodeIds.forEach(visitNeeded);

  const cachedResults: WorkflowCachedResult[] = graph.nodes
    .filter((node) => needed.has(node.id) && (cachedRuns.has(node.id) || promotedReviewResults.has(node.id)))
    .map((node) => promotedReviewResults.get(node.id) ?? ({
      nodeId: node.id,
      cacheKey: materialKeys[node.id],
      outputIds: cachedRuns.get(node.id)!.outputs.map((output) => output.assetReferenceId),
    }));
  const executionNodeIds = graph.nodes
    .filter((node) => needed.has(node.id)
      && dispositions.get(node.id)?.kind === 'available'
      && !cachedRuns.has(node.id)
      && !promotedReviewResults.has(node.id)
      && !blocked.has(node.id))
    .map((node) => node.id);
  const preflight: WorkflowNodePreflight[] = graph.nodes
    .filter((node) => required.has(node.id))
    .map((node) => {
      const block = blocked.get(node.id);
      if (block) return { nodeId: node.id, state: 'blocked' as const, willExecute: false, reason: block };
      if (dispositions.get(node.id)?.kind === 'not-required') {
        return {
          nodeId: node.id,
          state: 'planned' as const,
          willExecute: false,
          reason: {
            code: 'CONTEXT_SATISFIED' as const,
            message: `Node "${node.title}" supplies material context and requires no executor call.`,
          },
        };
      }
      if (cachedRuns.has(node.id) || promotedReviewResults.has(node.id)) {
        return {
          nodeId: node.id,
          state: 'cached' as const,
          willExecute: false,
          reason: { code: 'REUSABLE_RESULT' as const, message: 'An unchanged successful result will be reused.' },
        };
      }
      if (!needed.has(node.id)) {
        return {
          nodeId: node.id,
          state: 'planned' as const,
          willExecute: false,
          reason: {
            code: 'PRUNED_BY_REUSABLE_RESULT' as const,
            message: `Node "${node.title}" is behind a verified reusable result and is not scheduled.`,
          },
        };
      }
      const latest = latestSuccessful.get(node.id);
      if (latest && latest.materialKey !== materialKeys[node.id]) {
        return {
          nodeId: node.id,
          state: 'stale' as const,
          willExecute: true,
          reason: {
            code: 'MATERIAL_CHANGED' as const,
            message: `Node "${node.title}" changed since its latest successful run and will execute again.`,
          },
        };
      }
      if (unavailableExact.has(node.id)) {
        return {
          nodeId: node.id,
          state: 'planned' as const,
          willExecute: true,
          reason: {
            code: 'CACHED_OUTPUT_UNAVAILABLE' as const,
            message: `Node "${node.title}" has matching run metadata, but its output is unavailable and will be rebuilt.`,
          },
        };
      }
      return {
        nodeId: node.id,
        state: 'planned' as const,
        willExecute: true,
        reason: {
          code: 'NO_REUSABLE_RESULT' as const,
          message: `Node "${node.title}" has no reusable successful result and will execute.`,
        },
      };
    });
  const planNodes = graph.nodes.filter((node) => required.has(node.id));
  const executionCandidates = new Set([...executionNodeIds, ...cachedResults.map((entry) => entry.nodeId)]);
  const executionDependencies = (nodeId: string): string[] => {
    const found = new Set<string>();
    const visited = new Set<string>();
    const visit = (candidateId: string): void => {
      if (visited.has(candidateId)) return;
      visited.add(candidateId);
      for (const upstreamId of incomingNodeIds(edges, candidateId)) {
        if (executionCandidates.has(upstreamId)) found.add(upstreamId);
        else visit(upstreamId);
      }
    };
    visit(nodeId);
    return graph.nodes.filter((node) => found.has(node.id)).map((node) => node.id);
  };
  const dependencies = Object.fromEntries([...executionCandidates].map((nodeId) => [
    nodeId,
    executionDependencies(nodeId),
  ]));

  return detachedFrozen({
    mode: request.mode,
    targetNodeId: request.nodeId,
    affectedNodeIds,
    requiredNodeIds,
    executionNodeIds,
    preflight,
    nodes: planNodes,
    dependencies,
    materialKeys,
    cachedResults,
  });
}

export async function executeSelectiveWorkflowPlan(
  plan: WorkflowSelectiveExecutionPlan,
  options: WorkflowSelectiveSchedulerOptions,
): Promise<WorkflowSelectiveExecutionOutcome> {
  let configuration: WorkflowSelectiveSchedulerOptions;
  try {
    configuration = {
      maxConcurrency: options.maxConcurrency,
      providerKeyForNode: options.providerKeyForNode,
      providerConcurrency: options.providerConcurrency,
      executeNode: options.executeNode,
      validateResultOwnership: options.validateResultOwnership,
      ...(options.sanitizeFailure ? { sanitizeFailure: options.sanitizeFailure } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
  } catch {
    throw new WorkflowExecutionError('INVALID_ARGUMENT', 'Selective execution configuration could not be read safely.');
  }
  if (!Number.isSafeInteger(configuration.maxConcurrency) || configuration.maxConcurrency <= 0) {
    throw new WorkflowExecutionError('INVALID_ARGUMENT', 'Execution concurrency must be a positive safe integer.', {
      maxConcurrency: configuration.maxConcurrency,
    });
  }
  if (typeof configuration.validateResultOwnership !== 'function') {
    throw new WorkflowExecutionError(
      'INVALID_ARGUMENT',
      'Selective execution requires an output ownership validator before any executor call.',
    );
  }
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const results = new Map<string, WorkflowExecutionResult>(plan.cachedResults.map((entry) => [
    entry.nodeId,
    { cacheKey: entry.cacheKey, outputIds: [...entry.outputIds] },
  ]));
  const providers = new Map<string, string>();
  const providerLimits = new Map<string, number>();
  for (const nodeId of plan.executionNodeIds) {
    const node = nodes.get(nodeId);
    if (!node) throw new WorkflowExecutionError('INVALID_ARGUMENT', `Execution plan is missing node "${nodeId}".`);
    let provider: string;
    let limit: number;
    try {
      provider = configuration.providerKeyForNode(detachedFrozen(node));
      limit = configuration.providerConcurrency[provider];
    } catch {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        `Execution provider mapping for node "${nodeId}" could not be resolved safely.`,
        { nodeId },
      );
    }
    if (typeof provider !== 'string' || provider.trim().length === 0
      || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        `Execution provider concurrency for node "${nodeId}" must be an injected positive safe integer.`,
        { nodeId },
      );
    }
    const snapshottedLimit = providerLimits.get(provider);
    if (snapshottedLimit !== undefined && snapshottedLimit !== limit) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        `Execution provider concurrency for node "${nodeId}" changed during preflight and cannot be trusted.`,
        { nodeId },
      );
    }
    providers.set(nodeId, provider);
    providerLimits.set(provider, limit);
  }

  type Settled = { nodeId: string; provider: string; result?: WorkflowExecutionResult; error?: unknown };
  const pending = new Set(plan.executionNodeIds);
  const running = new Map<string, Promise<Settled>>();
  const providerActive = new Map<string, number>();
  const executedNodeIds: string[] = [];
  const failures = new Map<string, WorkflowSelectiveNodeFailure>();
  const blockedNodeIds: string[] = [];
  const cancelledNodeIds: string[] = [];
  const outputOwners = new Map<string, string>();
  for (const entry of plan.cachedResults) {
    for (const outputId of entry.outputIds) {
      const existingOwner = outputOwners.get(outputId);
      if (existingOwner !== undefined) {
        throw new WorkflowExecutionError(
          'INVALID_ARGUMENT',
          'Selective execution cache contains an output identity owned by more than one node.',
        );
      }
      outputOwners.set(outputId, entry.nodeId);
    }
  }

  const blockFailedDependents = (): void => {
    let changed = true;
    while (changed) {
      changed = false;
      for (const nodeId of plan.executionNodeIds) {
        if (!pending.has(nodeId)) continue;
        const dependencyIds = plan.dependencies[nodeId] ?? [];
        if (!dependencyIds.some((dependencyId) => (
          failures.has(dependencyId) || blockedNodeIds.includes(dependencyId)
        ))) continue;
        pending.delete(nodeId);
        blockedNodeIds.push(nodeId);
        changed = true;
      }
    }
  };

  const startReadyNodes = (): void => {
    if (configuration.signal?.aborted) return;
    for (const nodeId of plan.executionNodeIds) {
      if (!pending.has(nodeId) || running.size >= configuration.maxConcurrency) continue;
      const dependencyIds = plan.dependencies[nodeId] ?? [];
      if (!dependencyIds.every((dependencyId) => results.has(dependencyId))) continue;
      const provider = providers.get(nodeId)!;
      const active = providerActive.get(provider) ?? 0;
      if (active >= providerLimits.get(provider)!) continue;
      const node = nodes.get(nodeId)!;
      const dependencyResults = new Map(dependencyIds.map((dependencyId) => [
        dependencyId,
        detachedFrozen(results.get(dependencyId)!),
      ]));
      const materialKey = plan.materialKeys[nodeId];
      pending.delete(nodeId);
      executedNodeIds.push(nodeId);
      providerActive.set(provider, active + 1);
      const promise = Promise.resolve()
        .then(() => configuration.executeNode({
          nodeId,
          node: detachedFrozen(node),
          materialKey,
          dependencyResults,
          ...(configuration.signal ? { signal: configuration.signal } : {}),
        }))
        .then(
          (result): Settled => ({ nodeId, provider, result }),
          (error): Settled => ({ nodeId, provider, error }),
        );
      running.set(nodeId, promise);
    }
  };

  while (pending.size > 0 || running.size > 0) {
    if (configuration.signal?.aborted) {
      for (const nodeId of plan.executionNodeIds) {
        if (!pending.delete(nodeId)) continue;
        cancelledNodeIds.push(nodeId);
      }
    }
    blockFailedDependents();
    startReadyNodes();
    if (pending.size === 0 && running.size === 0) break;
    if (running.size === 0) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        'Selective execution could not resolve the remaining dependencies.',
        { pendingNodeIds: [...pending] },
      );
    }
    const settled = await Promise.race(running.values());
    running.delete(settled.nodeId);
    providerActive.set(settled.provider, providerActive.get(settled.provider)! - 1);
    if (configuration.signal?.aborted) {
      cancelledNodeIds.push(settled.nodeId);
      continue;
    }
    if (settled.error) {
      failures.set(settled.nodeId, safeFailure(settled.error, configuration.sanitizeFailure));
      continue;
    }
    const resultSnapshot = snapshotExecutorResult(settled.result);
    const structurallyValid = resultSnapshot !== null
      && resultSnapshot.cacheKey === plan.materialKeys[settled.nodeId];
    let ownershipValid = false;
    if (structurallyValid && resultSnapshot) {
      const hasCollision = resultSnapshot.outputIds.some((outputId) => {
        const owner = outputOwners.get(outputId);
        return owner !== undefined && owner !== settled.nodeId;
      });
      if (!hasCollision) {
        try {
          ownershipValid = configuration.validateResultOwnership(detachedFrozen({
            nodeId: settled.nodeId,
            result: {
              cacheKey: resultSnapshot.cacheKey,
              outputIds: [...resultSnapshot.outputIds],
            },
          })) === true;
        } catch {
          ownershipValid = false;
        }
      }
    }
    if (!structurallyValid || !ownershipValid || !resultSnapshot) {
      failures.set(settled.nodeId, {
        code: 'INVALID_EXECUTOR_RESULT',
        message: `Executor result for node "${settled.nodeId}" failed material, shape, identity, or ownership validation.`,
      });
      continue;
    }
    const projectedResult: WorkflowExecutionResult = {
      cacheKey: resultSnapshot.cacheKey,
      outputIds: [...resultSnapshot.outputIds],
    };
    results.set(settled.nodeId, projectedResult);
    projectedResult.outputIds.forEach((outputId) => outputOwners.set(outputId, settled.nodeId));
  }

  return detachedFrozen({
    executedNodeIds,
    cachedNodeIds: plan.cachedResults.map((entry) => entry.nodeId),
    results: Object.fromEntries(results),
    failures: Object.fromEntries(failures),
    blockedNodeIds,
    cancelledNodeIds,
  });
}
