import { createWorkflowCacheKey, type WorkflowCacheHash } from './execution';
import { hash as sha256 } from 'fast-sha256';
import type {
  WorkflowGraphV2,
  WorkflowCandidateLineageV1,
  WorkflowRunExecutor,
  WorkflowRunOutput,
  WorkflowRunProvider,
  WorkflowRunRecordV1,
  WorkflowRunSourceAsset,
  WorkflowRunStatus,
} from './schema';
import {
  requireProjectRelativeWorkflowReference,
  safeWorkflowIdentifier,
  safeWorkflowModel,
  safeWorkflowProviderOptions,
  sanitizeWorkflowFailure,
  validateWorkflowRunRecordSafety,
} from './provenanceSafety';

export interface WorkflowRunMaterialDraft {
  sourceAssets: WorkflowRunSourceAsset[];
  prompt: {
    brief: string;
    artDirection: string;
    instructions: string;
    constraints: string[];
    effectivePrompt: string;
  };
  provider: WorkflowRunProvider;
  executor: WorkflowRunExecutor;
  output: { nodeId: string; title: string; width: number; height: number };
}

export interface WorkflowRunRecordDraft {
  id: string;
  nodeId: string;
  attempt: number;
  status: WorkflowRunStatus;
  graph: WorkflowGraphV2;
  material: WorkflowRunMaterialDraft;
  startedAt: number;
  finishedAt: number | null;
  outputs: WorkflowRunOutput[];
  candidate?: WorkflowCandidateLineageV1;
  retryOfRunId?: string;
  failure?: { code: string; message: string };
  projectTaskId?: string;
  debugArtifactReference?: string;
}

export interface WorkflowDerivedRunState {
  state: 'idle' | WorkflowRunStatus | 'stale';
  latestRun: WorkflowRunRecordV1 | null;
  acceptedOutputs: Array<WorkflowRunOutput & { acceptedAt: number }>;
}

export function canonicalWorkflowProvenanceJson(
  value: unknown,
  path = 'provenance material',
  ancestors = new WeakSet<object>(),
): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must be JSON-safe.`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== 'object') throw new Error(`${path} must be JSON-safe.`);
  if (ancestors.has(value)) throw new Error(`${path} must be JSON-safe and acyclic.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const extraKeys = Reflect.ownKeys(value).filter((key) => (
        key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(String(key))
      ));
      if (extraKeys.length > 0) throw new Error(`${path} must be JSON-safe plain data.`);
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new Error(`${path} must be JSON-safe and cannot be sparse.`);
        items.push(canonicalWorkflowProvenanceJson(value[index], `${path}[${index}]`, ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must be JSON-safe plain data.`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key === 'symbol')) throw new Error(`${path} must be JSON-safe plain data.`);
    return `{${(keys as string[]).sort().map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error(`${path}.${key} must be JSON-safe plain data.`);
      }
      return `${JSON.stringify(key)}:${canonicalWorkflowProvenanceJson(descriptor.value, `${path}.${key}`, ancestors)}`;
    }).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function digest(hash: WorkflowCacheHash, label: string, value: unknown): string {
  const result = hash(canonicalWorkflowProvenanceJson({ schema: label, value }));
  if (typeof result !== 'string' || !result.trim()) throw new Error(`${label} hash must be non-empty.`);
  return result;
}

function persistedMaterialConfig(config: Record<string, unknown>): Record<string, unknown> {
  const runtimeKeys = new Set([
    'resultAssetReferenceId', 'resultAssetId', 'resultRelativePath',
    'assetReferenceId', 'outputAssetId', 'outputRelativePath',
  ]);
  return Object.fromEntries(Object.entries(config).filter(([key]) => !runtimeKeys.has(key)));
}

function graphRevisionMaterial(graph: WorkflowGraphV2): unknown {
  return {
    id: graph.id,
    nodes: graph.nodes.map((node) => ({ ...node, config: persistedMaterialConfig(node.config), runRecordIds: [] })),
    edges: graph.edges,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function workflowSha256Bytes(bytes: Uint8Array): string {
  return `sha256:${hex(sha256(bytes))}`;
}

export function workflowSha256Text(value: string): string {
  return workflowSha256Bytes(new TextEncoder().encode(value));
}

export function createWorkflowRevision(graph: WorkflowGraphV2, hash: WorkflowCacheHash = workflowSha256Text): string {
  return digest(hash, 'paintnode-workflow-revision-v1', graphRevisionMaterial(graph));
}

export function createWorkflowRunRecord(
  draft: WorkflowRunRecordDraft,
  hash: WorkflowCacheHash,
): WorkflowRunRecordV1 {
  const node = draft.graph.nodes.find((candidate) => candidate.id === draft.nodeId);
  if (!node) throw new Error(`Workflow node "${draft.nodeId}" does not exist.`);
  safeWorkflowIdentifier(draft.id, 'Run ID');
  safeWorkflowIdentifier(draft.nodeId, 'Run node ID');
  safeWorkflowIdentifier(draft.material.provider.id, 'Provider ID');
  safeWorkflowIdentifier(draft.material.executor.id, 'Executor ID');
  safeWorkflowIdentifier(draft.material.executor.version, 'Executor version');
  safeWorkflowIdentifier(draft.material.executor.requestSchemaVersion, 'Request schema version');
  if (!Number.isSafeInteger(draft.attempt) || draft.attempt < 0) throw new Error('Run attempt must be a nonnegative safe integer.');
  if (!Number.isSafeInteger(draft.startedAt) || draft.startedAt < 0) throw new Error('Run startedAt must be a nonnegative safe integer.');
  if (draft.finishedAt !== null && (
    !Number.isSafeInteger(draft.finishedAt) || draft.finishedAt < draft.startedAt
  )) throw new Error('Run finishedAt must be a nonnegative safe integer after startedAt.');
  if (!Number.isSafeInteger(draft.material.output.width) || draft.material.output.width < 1
    || !Number.isSafeInteger(draft.material.output.height) || draft.material.output.height < 1) {
    throw new Error('Run output dimensions must be positive safe integers.');
  }
  if (draft.status === 'running' && (draft.finishedAt !== null || draft.failure || draft.outputs.length > 0)) {
    throw new Error('Running records cannot be finished, failed, or produce outputs.');
  }
  if (draft.status === 'succeeded' && (draft.finishedAt === null || draft.failure || draft.outputs.length === 0)) {
    throw new Error('Succeeded records require outputs and no failure.');
  }
  if ((draft.status === 'failed' || draft.status === 'cancelled')
    && (draft.finishedAt === null || !draft.failure || draft.outputs.length > 0)) {
    throw new Error('Failed and cancelled records require a failure and no outputs.');
  }
  const providerOptions = safeWorkflowProviderOptions(draft.material.provider.effectiveOptions);
  safeWorkflowIdentifier(draft.material.output.nodeId, 'Output target node ID');
  for (const source of draft.material.sourceAssets) {
    safeWorkflowIdentifier(source.nodeId, 'Source node ID');
    safeWorkflowIdentifier(source.assetId, 'Source asset ID');
    requireProjectRelativeWorkflowReference(source.relativePath, 'Source asset path');
  }
  for (const output of draft.outputs) {
    safeWorkflowIdentifier(output.assetReferenceId, 'Output asset reference ID');
    safeWorkflowIdentifier(output.assetId, 'Output asset ID');
    requireProjectRelativeWorkflowReference(output.relativePath, 'Output asset path');
    if (output.acceptedAt !== undefined && (
      draft.status !== 'succeeded'
      || !Number.isSafeInteger(output.acceptedAt)
      || output.acceptedAt < draft.startedAt
      || draft.finishedAt === null
      || output.acceptedAt > draft.finishedAt
    )) throw new Error('Accepted output time must fall within a successful run.');
  }
  if (draft.projectTaskId) safeWorkflowIdentifier(draft.projectTaskId, 'Project task ID');
  if (draft.retryOfRunId !== undefined) {
    safeWorkflowIdentifier(draft.retryOfRunId, 'Retry run ID');
    const prior = draft.graph.runRecords.find((record) => record.id === draft.retryOfRunId);
    if (!prior || !isFullWorkflowRunRecord(prior)) {
      throw new Error('Retry run ID must reference an attempt in the current workflow.');
    }
    if (prior.nodeId !== draft.nodeId) {
      throw new Error('Retry run ID must reference an attempt on the same node.');
    }
    if (prior.status !== 'failed' && prior.status !== 'cancelled') {
      throw new Error('Retry run ID must reference a failed or cancelled attempt.');
    }
    if (!draft.candidate && prior.candidate) {
      throw new Error('A normal run cannot retry a candidate branch attempt.');
    }
    if (draft.candidate && (
      !prior.candidate
      || prior.candidate.candidateId !== draft.candidate.candidateId
      || prior.candidate.branchGroupId !== draft.candidate.branchGroupId
    )) throw new Error('Retry run ID must reference the same candidate branch.');
    if (draft.candidate && draft.candidate.attempt !== prior.candidate!.attempt + 1) {
      throw new Error('Candidate retry attempt must immediately follow the linked candidate attempt.');
    }
    const latestTerminal = draft.graph.nodes.find((candidate) => candidate.id === draft.nodeId)?.runRecordIds
      .map((id) => draft.graph.runRecords.find((record) => record.id === id))
      .filter((record): record is WorkflowRunRecordV1 => Boolean(
        record && isFullWorkflowRunRecord(record) && record.status !== 'running'
        && (!draft.candidate || record.candidate?.candidateId === draft.candidate.candidateId),
      ))
      .at(-1);
    if (latestTerminal?.id !== prior.id) {
      throw new Error('Retry run ID must reference the latest terminal attempt.');
    }
    if (draft.candidate ? draft.attempt <= prior.attempt : draft.attempt !== prior.attempt + 1) {
      throw new Error(draft.candidate
        ? 'Candidate retry attempt must follow the linked attempt.'
        : 'Retry attempt must immediately follow the linked attempt.');
    }
  }
  if (draft.debugArtifactReference) {
    requireProjectRelativeWorkflowReference(draft.debugArtifactReference, 'Debug artifact reference');
  }
  const workflowRevision = createWorkflowRevision(draft.graph, hash);
  const nodeRevision = digest(hash, 'paintnode-workflow-node-revision-v1', {
    type: node.type,
    ports: node.ports,
    config: persistedMaterialConfig(node.config),
  });
  const effectivePromptHash = digest(hash, 'paintnode-workflow-prompt-v1', draft.material.prompt.effectivePrompt);
  const materialKey = createWorkflowCacheKey({
    nodeType: node.type,
    materialInputs: draft.material.sourceAssets.map((source) => ({
      portId: `${source.nodeId}:${source.name}:${source.role}`,
      contentHash: source.contentHash,
    })),
    effectiveConfig: {
      nodeRevision,
      brief: draft.material.prompt.brief,
      artDirection: draft.material.prompt.artDirection,
      instructions: draft.material.prompt.instructions,
      constraints: draft.material.prompt.constraints,
      effectivePromptHash,
      output: draft.material.output,
    },
    executorVersion: `${draft.material.executor.id}@${draft.material.executor.version}/${draft.material.executor.requestSchemaVersion}`,
    providerOptions: {
      id: draft.material.provider.id,
      model: safeWorkflowModel(draft.material.provider.model, 'Provider model'),
      effectiveOptions: providerOptions,
    },
  }, hash);
  const record: WorkflowRunRecordV1 = {
    recordVersion: 1,
    id: draft.id,
    nodeId: draft.nodeId,
    status: draft.status,
    attempt: draft.attempt,
    workflowRevision,
    nodeRevision,
    materialKey,
    sourceAssets: structuredClone(draft.material.sourceAssets),
    prompt: {
      brief: draft.material.prompt.brief,
      artDirection: draft.material.prompt.artDirection,
      instructions: draft.material.prompt.instructions,
      constraints: [...draft.material.prompt.constraints],
      effectivePromptHash,
    },
    provider: {
      id: safeWorkflowIdentifier(draft.material.provider.id, 'Provider ID'),
      model: safeWorkflowModel(draft.material.provider.model, 'Provider model'),
      effectiveOptions: providerOptions,
    },
    executor: structuredClone(draft.material.executor),
    target: structuredClone(draft.material.output),
    startedAt: draft.startedAt,
    finishedAt: draft.finishedAt,
    outputs: structuredClone(draft.outputs),
    ...(draft.candidate ? { candidate: structuredClone(draft.candidate) } : {}),
    ...(draft.retryOfRunId !== undefined ? { retryOfRunId: draft.retryOfRunId } : {}),
    ...(draft.failure ? { failure: sanitizeWorkflowFailure(draft.failure) } : {}),
    ...(draft.projectTaskId ? { projectTaskId: draft.projectTaskId } : {}),
    ...(draft.debugArtifactReference ? { debugArtifactReference: draft.debugArtifactReference } : {}),
  };
  validateWorkflowRunRecordSafety(record);
  return record;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null) return value;
  Object.values(value).forEach((item) => deepFreeze(item));
  return Object.freeze(value);
}

export function isFullWorkflowRunRecord(value: unknown): value is WorkflowRunRecordV1 {
  return typeof value === 'object' && value !== null && 'recordVersion' in value
    && (value as { recordVersion?: unknown }).recordVersion === 1;
}

export function deriveWorkflowNodeRunState(
  graph: WorkflowGraphV2,
  nodeId: string,
  currentMaterialKey?: string,
): WorkflowDerivedRunState {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return deepFreeze({ state: 'idle' as const, latestRun: null, acceptedOutputs: [] });
  const records = node.runRecordIds
    .map((id) => graph.runRecords.find((record) => record.id === id))
    .filter((record): record is WorkflowRunRecordV1 => Boolean(
      record && isFullWorkflowRunRecord(record) && !record.candidate,
    ));
  const latestRun = records.at(-1) ? structuredClone(records.at(-1)!) : null;
  const acceptedOutputs = records.flatMap((record) => record.outputs
    .filter((output): output is WorkflowRunOutput & { acceptedAt: number } => typeof output.acceptedAt === 'number'))
    .map((output) => structuredClone(output));
  if (!latestRun) return deepFreeze({ state: 'idle' as const, latestRun: null, acceptedOutputs });
  const state = latestRun.status === 'succeeded'
    && currentMaterialKey
    && latestRun.materialKey !== currentMaterialKey
    ? 'stale'
    : latestRun.status;
  return deepFreeze({ state, latestRun, acceptedOutputs });
}
