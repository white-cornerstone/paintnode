import { WorkflowGraphDomain } from './domain';
import { createWorkflowRunRecord, isFullWorkflowRunRecord, workflowSha256Text } from './provenance';
import { safeWorkflowIdentifier } from './provenanceSafety';
import type {
  WorkflowCandidateLineageV1,
  WorkflowGraphV2,
  WorkflowRunRecordV1,
  WorkflowRunStatus,
} from './schema';
import {
  executeCampaignGenerateTransform,
  prepareCampaignGenerateTransform,
  WorkflowTransformExecutionError,
  type ExecuteCampaignGenerateOptions,
  type WorkflowAssetMaterial,
  type WorkflowProjectAsset,
  type WorkflowPreparedCampaignGenerateTransform,
  type WorkflowStoryboardDescriptor,
  type WorkflowStoryboardRead,
} from './transformExecutor';

export const WORKFLOW_MIN_CANDIDATES = 2;
export const WORKFLOW_MAX_CANDIDATES = 6;

export interface WorkflowCandidateSummary {
  candidateId: string;
  ordinal: number;
  status: WorkflowRunStatus;
  attemptCount: number;
  latestRunId: string;
  materialKey: string;
  effectivePromptHash: string;
  sourceAssetIds: string[];
  outputAssetId: string | null;
  failure: { code: string; message: string } | null;
}

export interface WorkflowCandidateBranchGroup {
  id: string;
  sourceNodeId: string;
  requestedCount: number;
  candidates: WorkflowCandidateSummary[];
}

export interface WorkflowCandidateBranchExecutionOptions {
  branchGroupId: string;
  count: number;
  maxConcurrency: number;
}

export interface WorkflowCandidateBranchExecutionOutcome {
  graph: WorkflowGraphV2;
  group: WorkflowCandidateBranchGroup;
}

function boundedCount(count: number): number {
  if (!Number.isSafeInteger(count) || count < WORKFLOW_MIN_CANDIDATES) {
    throw new Error(`Candidate branch count must be at least ${WORKFLOW_MIN_CANDIDATES}.`);
  }
  if (count > WORKFLOW_MAX_CANDIDATES) {
    throw new Error(`Candidate branch count must be at most ${WORKFLOW_MAX_CANDIDATES}.`);
  }
  return count;
}

function boundedConcurrency(value: number, count: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > count) {
    throw new Error('Candidate branch concurrency must be between 1 and the requested branch count.');
  }
  return value;
}

export function createWorkflowCandidateLineage(
  branchGroupId: string,
  sourceNodeId: string,
  ordinal: number,
  requestedCount: number,
  attempt = 1,
): Readonly<WorkflowCandidateLineageV1> {
  const group = safeWorkflowIdentifier(branchGroupId, 'Candidate branch group ID');
  const source = safeWorkflowIdentifier(sourceNodeId, 'Candidate source node ID');
  const count = boundedCount(requestedCount);
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > count) {
    throw new Error('Candidate ordinal must identify one requested branch.');
  }
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('Candidate attempt must start at 1.');
  const digest = workflowSha256Text(`${group}\u0000${source}\u0000${ordinal}`).slice('sha256:'.length, 'sha256:'.length + 20);
  return Object.freeze({
    version: 1,
    branchGroupId: group,
    candidateId: safeWorkflowIdentifier(`candidate-${ordinal}-${digest}`, 'Candidate ID'),
    ordinal,
    requestedCount: count,
    sourceNodeId: source,
    attempt,
  });
}

function candidateRecords(graph: WorkflowGraphV2): WorkflowRunRecordV1[] {
  return graph.runRecords.filter((record): record is WorkflowRunRecordV1 => (
    isFullWorkflowRunRecord(record) && Boolean(record.candidate)
  ));
}

function summary(records: readonly WorkflowRunRecordV1[]): WorkflowCandidateSummary {
  const latest = records.at(-1)!;
  const candidate = latest.candidate!;
  return Object.freeze({
    candidateId: candidate.candidateId,
    ordinal: candidate.ordinal,
    status: latest.status,
    attemptCount: records.length,
    latestRunId: latest.id,
    materialKey: latest.materialKey,
    effectivePromptHash: latest.prompt.effectivePromptHash,
    sourceAssetIds: Object.freeze(latest.sourceAssets.map((asset) => asset.assetId)) as unknown as string[],
    outputAssetId: latest.outputs[0]?.assetId ?? null,
    failure: latest.failure ? Object.freeze({ ...latest.failure }) : null,
  });
}

export function deriveWorkflowCandidateBranchGroups(graph: WorkflowGraphV2): WorkflowCandidateBranchGroup[] {
  const groups = new Map<string, WorkflowRunRecordV1[]>();
  for (const record of candidateRecords(graph)) {
    const records = groups.get(record.candidate!.branchGroupId) ?? [];
    records.push(record);
    groups.set(record.candidate!.branchGroupId, records);
  }
  return [...groups.entries()].map(([id, records]) => {
    const byCandidate = new Map<string, WorkflowRunRecordV1[]>();
    for (const record of records) {
      const attempts = byCandidate.get(record.candidate!.candidateId) ?? [];
      attempts.push(record);
      byCandidate.set(record.candidate!.candidateId, attempts);
    }
    const candidates = [...byCandidate.values()].map(summary).sort((left, right) => left.ordinal - right.ordinal);
    return Object.freeze({
      id,
      sourceNodeId: records[0].candidate!.sourceNodeId,
      requestedCount: records[0].candidate!.requestedCount,
      candidates: Object.freeze(candidates) as unknown as WorkflowCandidateSummary[],
    });
  });
}

function transformForOutput(graph: WorkflowGraphV2, outputNodeId: string): string {
  const edge = graph.edges.find((candidate) => (
    candidate.target.nodeId === outputNodeId && candidate.target.portId === 'source'
  ));
  const node = edge && graph.nodes.find((candidate) => candidate.id === edge.source.nodeId);
  if (!node || node.type !== 'transform') throw new Error('Candidate branches require a connected Transform output.');
  return node.id;
}

function maximumNodeAttempt(graph: WorkflowGraphV2, nodeId: string): number {
  return graph.runRecords.reduce((maximum, record) => (
    isFullWorkflowRunRecord(record) && record.nodeId === nodeId
      ? Math.max(maximum, record.attempt)
      : maximum
  ), 0);
}

function cloneMaterial(material: WorkflowAssetMaterial): WorkflowAssetMaterial {
  return { ...material, bytes: material.bytes ? new Uint8Array(material.bytes) : null };
}

function cloneStoryboard(read: WorkflowStoryboardRead | null): WorkflowStoryboardRead | null {
  return read ? { ...read, bytes: new Uint8Array(read.bytes) } : null;
}

function memoizedMaterialOptions(options: ExecuteCampaignGenerateOptions): ExecuteCampaignGenerateOptions {
  const assets = new Map<string, Promise<WorkflowAssetMaterial>>();
  const storyboards = new Map<string, Promise<WorkflowStoryboardRead | null>>();
  return {
    ...options,
    resolveAsset: (asset: Readonly<WorkflowProjectAsset>) => {
      const key = `${asset.id}\u0000${asset.relativePath}`;
      let pending = assets.get(key);
      if (!pending) {
        pending = options.resolveAsset(asset).then(cloneMaterial);
        assets.set(key, pending);
      }
      return pending.then(cloneMaterial);
    },
    ...(options.readStoryboard ? {
      readStoryboard: (storyboard: Readonly<WorkflowStoryboardDescriptor>) => {
        const key = JSON.stringify(storyboard);
        let pending = storyboards.get(key);
        if (!pending) {
          pending = options.readStoryboard!(storyboard).then(cloneStoryboard);
          storyboards.set(key, pending);
        }
        return pending.then(cloneStoryboard);
      },
    } : {}),
  };
}

function candidateArtifactName(name: string, lineage: WorkflowCandidateLineageV1): string {
  const match = /^(.*?)(\.[A-Za-z0-9]{1,10})?$/.exec(name.trim());
  const stem = match?.[1] || 'concept';
  const extension = match?.[2] || '';
  return `${stem}-${lineage.candidateId}-attempt-${lineage.attempt}${extension}`;
}

function trackCandidateCancellation(options: ExecuteCampaignGenerateOptions) {
  const activeRunIds = new Set<string>();
  const requestedRunIds = new Set<string>();
  const settlements: Promise<unknown>[] = [];
  const cancelActive = (): void => {
    if (!options.cancelExecutionForRun) return;
    for (const runId of activeRunIds) {
      if (requestedRunIds.has(runId)) continue;
      requestedRunIds.add(runId);
      settlements.push(Promise.resolve().then(() => options.cancelExecutionForRun!(runId)));
    }
  };
  options.signal?.addEventListener('abort', cancelActive, { once: true });
  return {
    begin(runId: string): void {
      activeRunIds.add(runId);
      if (options.signal?.aborted) cancelActive();
    },
    end(runId: string): void {
      activeRunIds.delete(runId);
    },
    async settle(): Promise<void> {
      await Promise.allSettled(settlements);
    },
    dispose(): void {
      options.signal?.removeEventListener('abort', cancelActive);
    },
  };
}

function mergeTerminalGraphs(base: WorkflowGraphV2, terminalGraphs: readonly WorkflowGraphV2[]): WorkflowGraphV2 {
  const baseRunIds = new Set(base.runRecords.map((record) => record.id));
  const baseReferenceIds = new Set(base.assetReferences.map((reference) => reference.id));
  const runRecords = [...base.runRecords];
  const assetReferences = [...base.assetReferences];
  const linkedRunIds: string[] = [];
  const seenAssetIds = new Set(base.assetReferences.map((reference) => reference.assetId).filter(Boolean));
  const seenPaths = new Set(base.assetReferences.map((reference) => reference.relativePath).filter(Boolean));
  for (const graph of terminalGraphs) {
    const addedRuns = graph.runRecords.filter((record) => !baseRunIds.has(record.id));
    if (addedRuns.length !== 1 || !isFullWorkflowRunRecord(addedRuns[0]) || !addedRuns[0].candidate) {
      throw new Error('Candidate execution did not return exactly one terminal provenance record.');
    }
    const record = addedRuns[0];
    if (runRecords.some((candidate) => candidate.id === record.id)) throw new Error('Candidate run identity collided.');
    const addedReferences = graph.assetReferences.filter((reference) => !baseReferenceIds.has(reference.id));
    if (record.status === 'succeeded' && addedReferences.length !== 1) {
      throw new Error('Successful candidate must return exactly one project asset reference.');
    }
    for (const reference of addedReferences) {
      if (assetReferences.some((candidate) => candidate.id === reference.id)
        || !reference.assetId || seenAssetIds.has(reference.assetId)
        || !reference.relativePath || seenPaths.has(reference.relativePath)) {
        throw new Error('Candidate output asset identity collided with workflow history or a sibling.');
      }
      seenAssetIds.add(reference.assetId);
      seenPaths.add(reference.relativePath);
      assetReferences.push(reference);
    }
    runRecords.push(record);
    linkedRunIds.push(record.id);
  }
  const sourceNodeId = (runRecords.find((record) => linkedRunIds.includes(record.id)) as WorkflowRunRecordV1).nodeId;
  return new WorkflowGraphDomain({
    ...base,
    nodes: base.nodes.map((node) => node.id === sourceNodeId
      ? { ...node, runRecordIds: [...node.runRecordIds, ...linkedRunIds] }
      : node),
    assetReferences,
    runRecords,
  }).graph;
}

function cancelledCandidateGraph(
  base: WorkflowGraphV2,
  options: ExecuteCampaignGenerateOptions,
  prepared: WorkflowPreparedCampaignGenerateTransform,
  lineage: WorkflowCandidateLineageV1,
  nodeAttempt: number,
  retryOfRunId?: string,
): WorkflowGraphV2 {
  const executor = options.executors.find((candidate) => (
    candidate.provider === prepared.request.provider
    && candidate.capabilities.includes(prepared.request.capability)
  ));
  if (!executor) throw new Error('Prepared candidate executor is unavailable.');
  const startedAt = options.clock?.() ?? Date.now();
  const finishedAt = options.clock?.() ?? Date.now();
  const record = createWorkflowRunRecord({
    id: `${lineage.candidateId}-attempt-${lineage.attempt}`,
    nodeId: lineage.sourceNodeId,
    attempt: nodeAttempt,
    status: 'cancelled',
    graph: base,
    material: {
      sourceAssets: prepared.request.sources.map((source) => ({
        nodeId: source.nodeId,
        assetId: source.assetId,
        relativePath: source.relativePath,
        contentHash: source.contentHash,
        name: source.name,
        role: source.role,
      })),
      prompt: {
        brief: prepared.request.brief,
        artDirection: prepared.request.artDirection,
        instructions: prepared.request.transform.instructions,
        constraints: [...(prepared.request.storyboard?.placementConstraints ?? [])],
        effectivePrompt: prepared.request.prompt,
      },
      provider: executor.describeRun(prepared.request),
      executor: executor.executor,
      output: prepared.request.output,
    },
    startedAt,
    finishedAt,
    outputs: [],
    retryOfRunId,
    candidate: lineage,
    failure: { code: 'CANCELLED', message: 'The candidate attempt was cancelled.' },
  }, options.hash ?? workflowSha256Text);
  return {
    ...base,
    nodes: base.nodes.map((node) => node.id === lineage.sourceNodeId
      ? { ...node, runRecordIds: [...node.runRecordIds, record.id] }
      : node),
    runRecords: [...base.runRecords, record],
  };
}

async function executeCandidate(
  base: WorkflowGraphV2,
  outputNodeId: string,
  options: ExecuteCampaignGenerateOptions,
  lineage: WorkflowCandidateLineageV1,
  nodeAttempt: number,
  expectedMaterialKey: string,
  retryOfRunId?: string,
): Promise<WorkflowGraphV2> {
  let progressOpen = true;
  try {
    const outcome = await executeCampaignGenerateTransform(base, outputNodeId, {
      ...options,
      candidateLineage: lineage,
      runAttempt: nodeAttempt,
      expectedMaterialKey,
      retryOfRunId,
      onProgress: (event) => {
        if (progressOpen) options.onProgress?.(event);
      },
      runIdGenerator: () => `${lineage.candidateId}-attempt-${lineage.attempt}`,
      idGenerator: () => `candidate-output-${workflowSha256Text(`${lineage.candidateId}\u0000${lineage.attempt}`).slice(-20)}`,
      storeAsset: (artifact) => options.storeAsset({
        ...artifact,
        name: candidateArtifactName(artifact.name, lineage),
      }),
    });
    return outcome.graph;
  } catch (error) {
    if (error instanceof WorkflowTransformExecutionError && error.failureGraph) return error.failureGraph;
    throw error;
  } finally {
    progressOpen = false;
  }
}

export async function executeWorkflowCandidateBranches(
  inputGraph: WorkflowGraphV2,
  outputNodeId: string,
  inputOptions: ExecuteCampaignGenerateOptions,
  branch: WorkflowCandidateBranchExecutionOptions,
): Promise<WorkflowCandidateBranchExecutionOutcome> {
  const count = boundedCount(branch.count);
  const concurrency = boundedConcurrency(branch.maxConcurrency, count);
  const groupId = safeWorkflowIdentifier(branch.branchGroupId, 'Candidate branch group ID');
  if (candidateRecords(inputGraph).some((record) => record.candidate!.branchGroupId === groupId)) {
    throw new Error('Candidate branch group ID already exists in workflow history.');
  }
  const sourceNodeId = transformForOutput(inputGraph, outputNodeId);
  const lineages = Array.from({ length: count }, (_, index) => (
    createWorkflowCandidateLineage(groupId, sourceNodeId, index + 1, count)
  ));
  const options = memoizedMaterialOptions(inputOptions);
  const prepared = await prepareCampaignGenerateTransform(inputGraph, outputNodeId, options);
  const firstNodeAttempt = maximumNodeAttempt(inputGraph, sourceNodeId) + 1;
  let storeTail: Promise<void> = Promise.resolve();
  const serializeStore: ExecuteCampaignGenerateOptions['storeAsset'] = (artifact) => {
    const operation = storeTail.then(() => options.storeAsset(artifact));
    storeTail = operation.then(() => undefined, () => undefined);
    return operation;
  };
  const terminalGraphs = new Array<WorkflowGraphV2>(count);
  const cancellation = trackCandidateCancellation(options);
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < count) {
      const index = next++;
      const runId = `${lineages[index].candidateId}-attempt-${lineages[index].attempt}`;
      if (options.signal?.aborted) {
        terminalGraphs[index] = cancelledCandidateGraph(
          inputGraph, options, prepared, lineages[index], firstNodeAttempt + index,
        );
        continue;
      }
      cancellation.begin(runId);
      try {
        terminalGraphs[index] = await executeCandidate(
          inputGraph,
          outputNodeId,
          { ...options, storeAsset: serializeStore },
          lineages[index],
          firstNodeAttempt + index,
          prepared.materialKey,
        );
      } finally {
        cancellation.end(runId);
      }
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    await cancellation.settle();
    cancellation.dispose();
  }
  const graph = mergeTerminalGraphs(inputGraph, terminalGraphs);
  const group = deriveWorkflowCandidateBranchGroups(graph).find((candidate) => candidate.id === groupId)!;
  return Object.freeze({ graph, group });
}

export async function retryWorkflowCandidateBranch(
  inputGraph: WorkflowGraphV2,
  candidateId: string,
  inputOptions: ExecuteCampaignGenerateOptions,
  scheduler: { maxConcurrency: number },
): Promise<{ graph: WorkflowGraphV2; candidate: WorkflowCandidateSummary }> {
  boundedConcurrency(scheduler.maxConcurrency, 1);
  const safeCandidateId = safeWorkflowIdentifier(candidateId, 'Candidate ID');
  const attempts = candidateRecords(inputGraph).filter((record) => record.candidate!.candidateId === safeCandidateId);
  const latest = attempts.at(-1);
  if (!latest || (latest.status !== 'failed' && latest.status !== 'cancelled')) {
    throw new Error('Only the latest failed or cancelled candidate attempt can be retried.');
  }
  const options = memoizedMaterialOptions(inputOptions);
  const prepared = await prepareCampaignGenerateTransform(inputGraph, latest.target.nodeId, options);
  if (prepared.materialKey !== latest.materialKey) throw new Error('Candidate material changed; create a new branch group.');
  const lineage = createWorkflowCandidateLineage(
    latest.candidate!.branchGroupId,
    latest.candidate!.sourceNodeId,
    latest.candidate!.ordinal,
    latest.candidate!.requestedCount,
    latest.candidate!.attempt + 1,
  );
  const nodeAttempt = maximumNodeAttempt(inputGraph, latest.nodeId) + 1;
  const runId = `${lineage.candidateId}-attempt-${lineage.attempt}`;
  const cancellation = trackCandidateCancellation(options);
  let terminal: WorkflowGraphV2;
  try {
    if (options.signal?.aborted) {
      terminal = cancelledCandidateGraph(inputGraph, options, prepared, lineage, nodeAttempt, latest.id);
    } else {
      cancellation.begin(runId);
      try {
        terminal = await executeCandidate(
          inputGraph,
          latest.target.nodeId,
          options,
          lineage,
          nodeAttempt,
          prepared.materialKey,
          latest.id,
        );
      } finally {
        cancellation.end(runId);
      }
    }
  } finally {
    await cancellation.settle();
    cancellation.dispose();
  }
  const graph = mergeTerminalGraphs(inputGraph, [terminal]);
  const candidate = deriveWorkflowCandidateBranchGroups(graph)
    .flatMap((group) => group.candidates)
    .find((item) => item.candidateId === safeCandidateId)!;
  return Object.freeze({ graph, candidate });
}
