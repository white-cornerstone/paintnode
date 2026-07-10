import { createWorkflowCacheKey, type WorkflowCacheHash } from './execution';
import type {
  WorkflowGraphV2,
  WorkflowRunExecutor,
  WorkflowRunOutput,
  WorkflowRunProvider,
  WorkflowRunRecordV1,
  WorkflowRunSourceAsset,
  WorkflowRunStatus,
} from './schema';

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
  failure?: { code: string; message: string };
  projectTaskId?: string;
  debugArtifactReference?: string;
}

export interface WorkflowDerivedRunState {
  state: 'idle' | WorkflowRunStatus | 'stale';
  latestRun: WorkflowRunRecordV1 | null;
  acceptedOutputs: Array<WorkflowRunOutput & { acceptedAt: number }>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function digest(hash: WorkflowCacheHash, label: string, value: unknown): string {
  const result = hash(canonicalJson({ schema: label, value }));
  if (typeof result !== 'string' || !result.trim()) throw new Error(`${label} hash must be non-empty.`);
  return result;
}

function graphRevisionMaterial(graph: WorkflowGraphV2): unknown {
  return {
    id: graph.id,
    nodes: graph.nodes.map((node) => ({ ...node, runRecordIds: [] })),
    edges: graph.edges,
  };
}

export function createWorkflowRunRecord(
  draft: WorkflowRunRecordDraft,
  hash: WorkflowCacheHash,
): WorkflowRunRecordV1 {
  const node = draft.graph.nodes.find((candidate) => candidate.id === draft.nodeId);
  if (!node) throw new Error(`Workflow node "${draft.nodeId}" does not exist.`);
  const workflowRevision = digest(hash, 'paintnode-workflow-revision-v1', graphRevisionMaterial(draft.graph));
  const nodeRevision = digest(hash, 'paintnode-workflow-node-revision-v1', {
    type: node.type,
    ports: node.ports,
    config: node.config,
  });
  const effectivePromptHash = digest(hash, 'paintnode-workflow-prompt-v1', draft.material.prompt.effectivePrompt);
  const materialKey = createWorkflowCacheKey({
    nodeType: node.type,
    materialInputs: draft.material.sourceAssets.map((source) => ({
      portId: source.nodeId,
      contentHash: source.contentHash,
    })),
    effectiveConfig: {
      brief: draft.material.prompt.brief,
      artDirection: draft.material.prompt.artDirection,
      instructions: draft.material.prompt.instructions,
      constraints: draft.material.prompt.constraints,
    },
    executorVersion: `${draft.material.executor.id}@${draft.material.executor.version}/${draft.material.executor.requestSchemaVersion}`,
    providerOptions: {
      id: draft.material.provider.id,
      model: draft.material.provider.model,
      effectiveOptions: draft.material.provider.effectiveOptions,
    },
  }, hash);
  return {
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
    provider: structuredClone(draft.material.provider),
    executor: structuredClone(draft.material.executor),
    startedAt: draft.startedAt,
    finishedAt: draft.finishedAt,
    outputs: structuredClone(draft.outputs),
    ...(draft.failure ? { failure: structuredClone(draft.failure) } : {}),
    ...(draft.projectTaskId ? { projectTaskId: draft.projectTaskId } : {}),
    ...(draft.debugArtifactReference ? { debugArtifactReference: draft.debugArtifactReference } : {}),
  };
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
  if (!node) return { state: 'idle', latestRun: null, acceptedOutputs: [] };
  const records = node.runRecordIds
    .map((id) => graph.runRecords.find((record) => record.id === id))
    .filter((record): record is WorkflowRunRecordV1 => Boolean(record && isFullWorkflowRunRecord(record)));
  const latestRun = records.at(-1) ?? null;
  const acceptedOutputs = records.flatMap((record) => record.outputs
    .filter((output): output is WorkflowRunOutput & { acceptedAt: number } => typeof output.acceptedAt === 'number'));
  if (!latestRun) return { state: 'idle', latestRun: null, acceptedOutputs };
  const state = latestRun.status === 'succeeded'
    && currentMaterialKey
    && latestRun.materialKey !== currentMaterialKey
    ? 'stale'
    : latestRun.status;
  return { state, latestRun, acceptedOutputs };
}
