import { WorkflowGraphDomain } from './domain';
import { isFullWorkflowRunRecord, workflowSha256Text } from './provenance';
import { safeWorkflowIdentifier } from './provenanceSafety';
import type {
  WorkflowGraphV2,
  WorkflowReviewPromotionV1,
  WorkflowRunOutput,
  WorkflowRunRecordV1,
} from './schema';

export type WorkflowReviewCandidateState = 'eligible' | 'stale' | 'unavailable';

export interface WorkflowReviewCandidate {
  candidateId: string;
  branchGroupId: string;
  ordinal: number;
  latestRunId: string;
  sourceNodeId: string;
  state: WorkflowReviewCandidateState;
  materialKey: string;
  brief: string;
  artDirection: string;
  instructions: string;
  providerId: string;
  model: string | null;
  sourceAssetIds: string[];
  output: WorkflowRunOutput | null;
}

export interface WorkflowReviewResolutionOptions {
  reviewNodeId: string;
  currentMaterialKeys?: Readonly<Record<string, string>>;
  isOutputAvailable?: (output: Readonly<WorkflowRunOutput>) => boolean;
}

export type WorkflowReviewBlockCode =
  | 'REVIEW_NOT_FOUND'
  | 'REVIEW_TOPOLOGY_INVALID'
  | 'PROMOTION_REQUIRED'
  | 'PROMOTION_STALE'
  | 'PROMOTED_LINEAGE_INVALID'
  | 'PROMOTED_RUN_MISSING'
  | 'PROMOTED_OUTPUT_UNAVAILABLE';

export type WorkflowReviewTopologyResolution = {
  state: 'ready';
  reviewNodeId: string;
  transformNodeId: string;
  outputNodeId: string | null;
  promotion: WorkflowReviewPromotionV1;
  output: WorkflowRunOutput;
} | {
  state: 'blocked';
  reviewNodeId: string;
  transformNodeId: string | null;
  outputNodeId: string | null;
  reason: { code: WorkflowReviewBlockCode; message: string; action: string };
};

function reviewTopology(graph: WorkflowGraphV2, reviewNodeId: string) {
  const review = graph.nodes.find((node) => node.id === reviewNodeId && node.type === 'review');
  const incomingEdges = graph.edges.filter((edge) => edge.target.nodeId === reviewNodeId && edge.target.portId === 'candidates');
  const incoming = incomingEdges.length === 1 ? incomingEdges[0] : undefined;
  const transform = incoming?.source.portId === 'result'
    ? graph.nodes.find((node) => node.id === incoming.source.nodeId && node.type === 'transform')
    : undefined;
  const outgoingEdges = graph.edges.filter((edge) => edge.source.nodeId === reviewNodeId && edge.source.portId === 'selected');
  const directOutputEdges = outgoingEdges.filter((edge) => (
    edge.target.portId === 'source'
    && graph.nodes.some((node) => node.id === edge.target.nodeId && node.type === 'output')
  ));
  const supportedFanout = outgoingEdges.every((edge) => (
    directOutputEdges.includes(edge)
    || ((edge.target.portId === 'decision' || edge.target.portId === 'source')
      && graph.nodes.some((node) => node.id === edge.target.nodeId && node.type === 'transform'))
  ));
  const hasFormatFanout = outgoingEdges.some((edge) => !directOutputEdges.includes(edge));
  const outgoing = directOutputEdges.length === 1 ? directOutputEdges[0] : undefined;
  const output = outgoing?.target.portId === 'source'
    ? graph.nodes.find((node) => node.id === outgoing.target.nodeId && node.type === 'output')
    : undefined;
  return {
    review,
    transform,
    output,
    valid: Boolean(review && transform && incomingEdges.length === 1
      && directOutputEdges.length <= 1
      && !(directOutputEdges.length > 0 && hasFormatFanout)
      && supportedFanout),
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

export function createWorkflowReviewNodeRevision(graph: WorkflowGraphV2, reviewNodeId: string): string | null {
  const review = graph.nodes.find((node) => node.id === reviewNodeId && node.type === 'review');
  if (!review) return null;
  return workflowSha256Text(JSON.stringify(stableValue({
    id: review.id,
    type: review.type,
    ports: review.ports,
    config: review.config,
  })));
}

function candidateRunsForReview(graph: WorkflowGraphV2, reviewNodeId: string): WorkflowRunRecordV1[] {
  const { transform } = reviewTopology(graph, reviewNodeId);
  if (!transform) return [];
  const latest = new Map<string, WorkflowRunRecordV1>();
  for (const runId of transform.runRecordIds) {
    const record = graph.runRecords.find((candidate) => candidate.id === runId);
    if (record && isFullWorkflowRunRecord(record) && record.candidate) {
      latest.set(record.candidate.candidateId, record);
    }
  }
  return [...latest.values()]
    .filter((record) => record.status === 'succeeded')
    .sort((left, right) => left.candidate!.ordinal - right.candidate!.ordinal);
}

export function deriveWorkflowReviewCandidates(
  graph: WorkflowGraphV2,
  reviewNodeId: string,
  options: Omit<WorkflowReviewResolutionOptions, 'reviewNodeId'> = {},
): WorkflowReviewCandidate[] {
  return candidateRunsForReview(graph, reviewNodeId).map((record) => {
    const output = record.outputs[0] ?? null;
    const currentMaterial = options.currentMaterialKeys?.[record.nodeId];
    const state: WorkflowReviewCandidateState = currentMaterial && currentMaterial !== record.materialKey
      ? 'stale'
      : !output || (options.isOutputAvailable && !options.isOutputAvailable(output))
        ? 'unavailable'
        : 'eligible';
    return Object.freeze({
      candidateId: record.candidate!.candidateId,
      branchGroupId: record.candidate!.branchGroupId,
      ordinal: record.candidate!.ordinal,
      latestRunId: record.id,
      sourceNodeId: record.nodeId,
      state,
      materialKey: record.materialKey,
      brief: record.prompt.brief,
      artDirection: record.prompt.artDirection,
      instructions: record.prompt.instructions,
      providerId: record.provider.id,
      model: record.provider.model,
      sourceAssetIds: Object.freeze(record.sourceAssets.map((asset) => asset.assetId)) as unknown as string[],
      output: output ? Object.freeze({ ...output }) : null,
    });
  });
}

export function promoteWorkflowCandidate(
  graph: WorkflowGraphV2,
  request: Readonly<{
    reviewNodeId: string;
    candidateId: string;
    id: string;
    promotedAt: number;
    isOutputAvailable?: (output: Readonly<WorkflowRunOutput>) => boolean;
  }>,
): WorkflowGraphV2 {
  const reviewNodeId = safeWorkflowIdentifier(request.reviewNodeId, 'Review node ID');
  const candidateId = safeWorkflowIdentifier(request.candidateId, 'Candidate ID');
  const id = safeWorkflowIdentifier(request.id, 'Promotion ID');
  if (!Number.isSafeInteger(request.promotedAt) || request.promotedAt < 0) {
    throw new Error('Promotion time must be a nonnegative safe integer.');
  }
  const candidate = candidateRunsForReview(graph, reviewNodeId).find((item) => item.candidate!.candidateId === candidateId);
  if (!candidate || candidate.status !== 'succeeded' || candidate.outputs.length !== 1) {
    throw new Error('Only a successful candidate connected to this Review can be promoted.');
  }
  const output = candidate.outputs[0];
  if (request.isOutputAvailable && !request.isOutputAvailable(output)) {
    throw new Error('The candidate output is unavailable and cannot be promoted.');
  }
  const prior = (graph.reviewPromotions ?? []).filter((item) => item.reviewNodeId === reviewNodeId).at(-1);
  const promotion: WorkflowReviewPromotionV1 = {
    version: 1,
    id,
    reviewNodeId,
    sourceNodeId: candidate.nodeId,
    branchGroupId: candidate.candidate!.branchGroupId,
    candidateId,
    candidateRunId: candidate.id,
    assetReferenceId: output.assetReferenceId,
    assetId: output.assetId,
    relativePath: output.relativePath,
    contentHash: output.contentHash,
    materialKey: candidate.materialKey,
    reviewNodeRevision: createWorkflowReviewNodeRevision(graph, reviewNodeId)!,
    promotedAt: request.promotedAt,
    ...(prior ? { supersedesPromotionId: prior.id } : {}),
  };
  return new WorkflowGraphDomain({
    ...graph,
    reviewPromotions: [...(graph.reviewPromotions ?? []), promotion],
  }).graph;
}

export function resolveWorkflowReviewTopology(
  graph: WorkflowGraphV2,
  options: WorkflowReviewResolutionOptions,
): WorkflowReviewTopologyResolution {
  const { review, transform, output: outputNode, valid } = reviewTopology(graph, options.reviewNodeId);
  const blocked = (code: WorkflowReviewBlockCode, message: string, action: string): WorkflowReviewTopologyResolution => ({
    state: 'blocked', reviewNodeId: options.reviewNodeId,
    transformNodeId: transform?.id ?? null, outputNodeId: outputNode?.id ?? null,
    reason: { code, message, action },
  });
  if (!review) return blocked('REVIEW_NOT_FOUND', 'The Review node is unavailable.', 'Reconnect the Review node');
  if (!valid || !transform) {
    return blocked(
      'REVIEW_TOPOLOGY_INVALID',
      'Review must receive one concept Transform; its promoted decision may fan out to separate format Transforms.',
      'Reconnect the Review path',
    );
  }
  const promotion = (graph.reviewPromotions ?? []).filter((item) => item.reviewNodeId === review.id).at(-1);
  if (!promotion) return blocked('PROMOTION_REQUIRED', 'Choose a concept before continuing downstream.', 'Promote a candidate');
  const run = graph.runRecords.find((item) => item.id === promotion.candidateRunId);
  if (!run || !isFullWorkflowRunRecord(run) || run.status !== 'succeeded') {
    return blocked('PROMOTED_RUN_MISSING', 'The promoted candidate run is no longer available.', 'Promote another candidate');
  }
  if (promotion.sourceNodeId !== transform.id) {
    return blocked('PROMOTED_LINEAGE_INVALID', 'The promoted candidate belongs to a different Transform than this Review.', 'Review and promote a connected candidate');
  }
  const currentMaterial = options.currentMaterialKeys?.[transform.id];
  if ((currentMaterial && currentMaterial !== promotion.materialKey)
    || createWorkflowReviewNodeRevision(graph, review.id) !== promotion.reviewNodeRevision) {
    return blocked(
      'PROMOTION_STALE',
      'The promoted candidate no longer matches the current concept inputs or preview settings.',
      'Regenerate candidates for the updated workflow',
    );
  }
  const output = run.outputs.find((item) => (
    item.assetReferenceId === promotion.assetReferenceId
    && item.assetId === promotion.assetId
    && item.relativePath === promotion.relativePath
    && item.contentHash === promotion.contentHash
  ));
  if (run.nodeId !== promotion.sourceNodeId
    || run.candidate?.candidateId !== promotion.candidateId
    || run.candidate.branchGroupId !== promotion.branchGroupId
    || run.materialKey !== promotion.materialKey) {
    return blocked('PROMOTED_RUN_MISSING', 'The promoted candidate snapshot no longer matches its run.', 'Promote another candidate');
  }
  if (!output || (options.isOutputAvailable && !options.isOutputAvailable(output))) {
    return blocked('PROMOTED_OUTPUT_UNAVAILABLE', 'The promoted candidate asset is unavailable.', 'Restore it or promote another candidate');
  }
  return {
    state: 'ready', reviewNodeId: review.id, transformNodeId: transform.id,
    outputNodeId: outputNode?.id ?? null, promotion: structuredClone(promotion), output: structuredClone(output),
  };
}

export function workflowReviewPromotionMaterialKey(resolution: Extract<WorkflowReviewTopologyResolution, { state: 'ready' }>): string {
  return workflowSha256Text(JSON.stringify({
    reviewNodeRevision: resolution.promotion.reviewNodeRevision,
    candidateRunId: resolution.promotion.candidateRunId,
    assetReferenceId: resolution.output.assetReferenceId,
    contentHash: resolution.output.contentHash,
  }));
}

export function resolveWorkflowOutputTransform(graph: WorkflowGraphV2, outputNodeId: string): string | null {
  const direct = graph.edges.find((edge) => edge.target.nodeId === outputNodeId && edge.target.portId === 'source');
  const source = graph.nodes.find((node) => node.id === direct?.source.nodeId);
  if (source?.type === 'transform') return source.id;
  if (source?.type !== 'review') return null;
  return reviewTopology(graph, source.id).transform?.id ?? null;
}

export function resolveWorkflowTransformOutput(graph: WorkflowGraphV2, transformNodeId: string): string | null {
  const direct = graph.edges.find((edge) => edge.source.nodeId === transformNodeId && edge.source.portId === 'result');
  const target = graph.nodes.find((node) => node.id === direct?.target.nodeId);
  if (target?.type === 'output') return target.id;
  if (target?.type !== 'review') return null;
  return reviewTopology(graph, target.id).output?.id ?? null;
}

export interface WorkflowCampaignPath {
  transformNodeId: string;
  reviewNodeId: string | null;
  outputNodeId: string;
}

export function resolveWorkflowCampaignPath(
  graph: WorkflowGraphV2,
  selector: Readonly<{ outputNodeId?: string; transformNodeId?: string }>,
): WorkflowCampaignPath | null {
  const matches: WorkflowCampaignPath[] = [];
  for (const transform of graph.nodes.filter((node) => node.type === 'transform')) {
    if (selector.transformNodeId && transform.id !== selector.transformNodeId) continue;
    for (const edge of graph.edges.filter((item) => item.source.nodeId === transform.id && item.source.portId === 'result')) {
      const target = graph.nodes.find((node) => node.id === edge.target.nodeId);
      if (target?.type === 'output' && edge.target.portId === 'source') {
        if (!selector.outputNodeId || target.id === selector.outputNodeId) {
          const reviewEdge = graph.edges.find((candidate) => (
            candidate.target.nodeId === transform.id
            && (candidate.target.portId === 'decision' || candidate.target.portId === 'source')
            && candidate.source.portId === 'selected'
            && graph.nodes.some((node) => node.id === candidate.source.nodeId && node.type === 'review')
          ));
          matches.push({
            transformNodeId: transform.id,
            reviewNodeId: reviewEdge?.source.nodeId ?? null,
            outputNodeId: target.id,
          });
        }
      }
      if (target?.type === 'review' && edge.target.portId === 'candidates') {
        const topology = reviewTopology(graph, target.id);
        if (topology.valid && topology.transform?.id === transform.id && topology.output
          && (!selector.outputNodeId || topology.output.id === selector.outputNodeId)) {
          matches.push({
            transformNodeId: transform.id, reviewNodeId: target.id, outputNodeId: topology.output.id,
          });
        }
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}
