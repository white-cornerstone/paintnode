import { WorkflowGraphDomain } from './domain';
import {
  WorkflowExecutionError,
  type WorkflowBlockReason,
  type WorkflowCachedResult,
  type WorkflowExecutionResult,
} from './execution';
import { isFullWorkflowRunRecord } from './provenance';
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

export interface WorkflowSelectiveExecutionRequest {
  mode: WorkflowSelectiveRunMode;
  nodeId: string;
  materialKeys: Readonly<Record<string, string>>;
  executionDisposition?: (node: Readonly<WorkflowNodeV2>) => WorkflowNodeExecutionDisposition;
  isRunRecordReusable?: (record: Readonly<WorkflowRunRecordV1>) => boolean;
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
}

export interface WorkflowSelectiveSchedulerOptions {
  maxConcurrency: number;
  providerKeyForNode: (node: Readonly<WorkflowNodeV2>) => string;
  providerConcurrency: Readonly<Record<string, number>>;
  executeNode: (context: WorkflowSelectiveNodeExecutionContext) => Promise<WorkflowExecutionResult>;
  sanitizeFailure?: (error: unknown) => WorkflowSelectiveNodeFailure;
}

export interface WorkflowSelectiveExecutionOutcome {
  executedNodeIds: string[];
  cachedNodeIds: string[];
  results: ReadonlyMap<string, Readonly<WorkflowExecutionResult>>;
  failures: ReadonlyMap<string, Readonly<WorkflowSelectiveNodeFailure>>;
  blockedNodeIds: string[];
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

function defaultExecutionDisposition(node: WorkflowNodeV2): WorkflowNodeExecutionDisposition {
  if (node.type === 'transform') return { kind: 'available' };
  if (node.type === 'unsupported') {
    return { kind: 'unavailable', reason: `Node "${node.title}" uses an unsupported workflow type.` };
  }
  return { kind: 'not-required' };
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
  const candidate = result as Partial<WorkflowExecutionResult>;
  if (typeof candidate.cacheKey !== 'string' || candidate.cacheKey.trim().length === 0) return false;
  if (!Array.isArray(candidate.outputIds) || candidate.outputIds.length === 0) return false;
  const unique = new Set<string>();
  return candidate.outputIds.every((id) => {
    if (typeof id !== 'string' || id.trim().length === 0 || unique.has(id)) return false;
    unique.add(id);
    return true;
  });
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
  for (const node of graph.nodes) {
    if (!required.has(node.id)) continue;
    let disposition = defaultExecutionDisposition(node);
    if (request.executionDisposition) {
      try {
        disposition = request.executionDisposition(detachedFrozen(node));
      } catch {
        disposition = { kind: 'unavailable', reason: 'Execution availability could not be determined safely.' };
      }
    }
    if (!disposition || !['not-required', 'available', 'unavailable'].includes(disposition.kind)) {
      throw new WorkflowExecutionError('INVALID_ARGUMENT', `Node "${node.id}" has an invalid execution disposition.`, {
        nodeId: node.id,
      });
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
    .map((node) => [node.id, requireMaterialKey(request.materialKeys, node.id)]));

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
    if (cachedRuns.has(nodeId)) return;
    incomingNodeIds(edges, nodeId).forEach(visitNeeded);
  };
  affectedNodeIds.forEach(visitNeeded);

  const cachedResults: WorkflowCachedResult[] = graph.nodes
    .filter((node) => needed.has(node.id) && cachedRuns.has(node.id))
    .map((node) => ({
      nodeId: node.id,
      cacheKey: materialKeys[node.id],
      outputIds: cachedRuns.get(node.id)!.outputs.map((output) => output.assetReferenceId),
    }));
  const executionNodeIds = graph.nodes
    .filter((node) => needed.has(node.id)
      && dispositions.get(node.id)?.kind === 'available'
      && !cachedRuns.has(node.id)
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
      if (cachedRuns.has(node.id)) {
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
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency <= 0) {
    throw new WorkflowExecutionError('INVALID_ARGUMENT', 'Execution concurrency must be a positive safe integer.', {
      maxConcurrency: options.maxConcurrency,
    });
  }
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const results = new Map<string, WorkflowExecutionResult>(plan.cachedResults.map((entry) => [
    entry.nodeId,
    { cacheKey: entry.cacheKey, outputIds: [...entry.outputIds] },
  ]));
  const providers = new Map<string, string>();
  for (const nodeId of plan.executionNodeIds) {
    const node = nodes.get(nodeId);
    if (!node) throw new WorkflowExecutionError('INVALID_ARGUMENT', `Execution plan is missing node "${nodeId}".`);
    const provider = options.providerKeyForNode(detachedFrozen(node));
    const limit = options.providerConcurrency[provider];
    if (typeof provider !== 'string' || provider.trim().length === 0
      || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new WorkflowExecutionError(
        'INVALID_ARGUMENT',
        `Execution provider concurrency for node "${nodeId}" must be an injected positive safe integer.`,
        { nodeId, provider, limit },
      );
    }
    providers.set(nodeId, provider);
  }

  type Settled = { nodeId: string; provider: string; result?: WorkflowExecutionResult; error?: unknown };
  const pending = new Set(plan.executionNodeIds);
  const running = new Map<string, Promise<Settled>>();
  const providerActive = new Map<string, number>();
  const executedNodeIds: string[] = [];
  const failures = new Map<string, WorkflowSelectiveNodeFailure>();
  const blockedNodeIds: string[] = [];

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
    for (const nodeId of plan.executionNodeIds) {
      if (!pending.has(nodeId) || running.size >= options.maxConcurrency) continue;
      const dependencyIds = plan.dependencies[nodeId] ?? [];
      if (!dependencyIds.every((dependencyId) => results.has(dependencyId))) continue;
      const provider = providers.get(nodeId)!;
      const active = providerActive.get(provider) ?? 0;
      if (active >= options.providerConcurrency[provider]) continue;
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
        .then(() => options.executeNode({
          nodeId,
          node: detachedFrozen(node),
          materialKey,
          dependencyResults,
        }))
        .then(
          (result): Settled => ({ nodeId, provider, result }),
          (error): Settled => ({ nodeId, provider, error }),
        );
      running.set(nodeId, promise);
    }
  };

  while (pending.size > 0 || running.size > 0) {
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
    if (settled.error) {
      failures.set(settled.nodeId, safeFailure(settled.error, options.sanitizeFailure));
      continue;
    }
    if (!hasValidResult(settled.result) || settled.result.cacheKey !== plan.materialKeys[settled.nodeId]) {
      failures.set(settled.nodeId, {
        code: 'INVALID_EXECUTOR_RESULT',
        message: `Executor result for node "${settled.nodeId}" must contain the planned material key and valid outputs.`,
      });
      continue;
    }
    results.set(settled.nodeId, cloneValue(settled.result));
  }

  return {
    executedNodeIds,
    cachedNodeIds: plan.cachedResults.map((entry) => entry.nodeId),
    results,
    failures,
    blockedNodeIds,
  };
}
