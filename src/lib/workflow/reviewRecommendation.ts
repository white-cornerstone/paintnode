import { WorkflowGraphDomain } from './domain';
import { createWorkflowReviewNodeRevision, deriveWorkflowReviewCandidates, type WorkflowReviewCandidate } from './candidatePromotion';
import { workflowSha256Text } from './provenance';
import { safeWorkflowIdentifier, safeWorkflowModel, safeWorkflowProviderOptions } from './provenanceSafety';
import type { WorkflowGraphV2, WorkflowReviewRecommendationV1, WorkflowRunProvider } from './schema';

export interface WorkflowAiReviewResult {
  rankings: Array<{ candidateId: string; reason: string }>;
  recommendedCandidateId: string;
}

export type WorkflowReviewRecommendationResolution =
  | { state: 'missing'; recommendation: null }
  | { state: 'ready'; recommendation: WorkflowReviewRecommendationV1 }
  | { state: 'stale'; recommendation: WorkflowReviewRecommendationV1; reason: string };

function reviewInstructions(graph: WorkflowGraphV2, reviewNodeId: string): string {
  const node = graph.nodes.find((candidate) => candidate.id === reviewNodeId && candidate.type === 'review');
  return typeof node?.config.instructions === 'string' ? node.config.instructions : '';
}

function eligibleCandidates(graph: WorkflowGraphV2, reviewNodeId: string): WorkflowReviewCandidate[] {
  return deriveWorkflowReviewCandidates(graph, reviewNodeId).filter((candidate) => candidate.state === 'eligible' && candidate.output);
}

export function workflowReviewCandidateSetHash(candidates: readonly WorkflowReviewCandidate[]): string {
  return workflowSha256Text(JSON.stringify(candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    candidateRunId: candidate.latestRunId,
    materialKey: candidate.materialKey,
    contentHash: candidate.output?.contentHash ?? null,
  })).sort((left, right) => left.candidateId.localeCompare(right.candidateId))));
}

export function workflowReviewInstructionsHash(graph: WorkflowGraphV2, reviewNodeId: string): string {
  return workflowSha256Text(reviewInstructions(graph, reviewNodeId));
}

function safeReason(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Every AI Review ranking requires a reason.');
  const normalized = value.replace(/[\0\r]/g, '').trim();
  if (!normalized || normalized.length > 1_000) throw new Error('AI Review reasons must contain 1 to 1000 characters.');
  return normalized;
}

export function appendWorkflowReviewRecommendation(
  graph: WorkflowGraphV2,
  request: Readonly<{
    id: string;
    reviewNodeId: string;
    result: WorkflowAiReviewResult;
    provider: WorkflowRunProvider;
    createdAt: number;
  }>,
): WorkflowGraphV2 {
  const reviewNodeId = safeWorkflowIdentifier(request.reviewNodeId, 'Review node ID');
  const id = safeWorkflowIdentifier(request.id, 'Review recommendation ID');
  if (!Number.isSafeInteger(request.createdAt) || request.createdAt < 0) throw new Error('Recommendation time must be a nonnegative safe integer.');
  const reviewNodeRevision = createWorkflowReviewNodeRevision(graph, reviewNodeId);
  if (!reviewNodeRevision) throw new Error('AI Review requires an existing Review node.');
  const candidates = eligibleCandidates(graph, reviewNodeId);
  if (candidates.length === 0) throw new Error('AI Review requires at least one eligible candidate.');
  const expected = new Map(candidates.map((candidate) => [candidate.candidateId, candidate]));
  if (request.result.rankings.length !== candidates.length) throw new Error('AI Review must rank every eligible candidate exactly once.');
  const rankings = request.result.rankings.map((ranking, index) => {
    const candidateId = safeWorkflowIdentifier(ranking.candidateId, 'Reviewed candidate ID');
    const candidate = expected.get(candidateId);
    if (!candidate?.output) throw new Error('AI Review returned an unknown or ineligible candidate.');
    expected.delete(candidateId);
    return {
      candidateId,
      candidateRunId: candidate.latestRunId,
      materialKey: candidate.materialKey,
      contentHash: candidate.output.contentHash,
      rank: index + 1,
      reason: safeReason(ranking.reason),
    };
  });
  if (expected.size > 0) throw new Error('AI Review omitted an eligible candidate.');
  const recommendedCandidateId = safeWorkflowIdentifier(request.result.recommendedCandidateId, 'Recommended candidate ID');
  if (!rankings.some((ranking) => ranking.candidateId === recommendedCandidateId)) {
    throw new Error('AI Review recommended an unknown candidate.');
  }
  const provider: WorkflowRunProvider = {
    id: safeWorkflowIdentifier(request.provider.id, 'AI Review provider ID'),
    model: safeWorkflowModel(request.provider.model, 'AI Review model'),
    effectiveOptions: safeWorkflowProviderOptions(request.provider.effectiveOptions),
  };
  const recommendation: WorkflowReviewRecommendationV1 = {
    version: 1,
    id,
    reviewNodeId,
    reviewNodeRevision,
    instructionsHash: workflowReviewInstructionsHash(graph, reviewNodeId),
    candidateSetHash: workflowReviewCandidateSetHash(candidates),
    rankings,
    recommendedCandidateId,
    provider,
    createdAt: request.createdAt,
  };
  return new WorkflowGraphDomain({
    ...graph,
    reviewRecommendations: [...(graph.reviewRecommendations ?? []), recommendation],
  }).graph;
}

export function resolveWorkflowReviewRecommendation(
  graph: WorkflowGraphV2,
  reviewNodeId: string,
): WorkflowReviewRecommendationResolution {
  const recommendation = (graph.reviewRecommendations ?? []).filter((item) => item.reviewNodeId === reviewNodeId).at(-1);
  if (!recommendation) return { state: 'missing', recommendation: null };
  if (createWorkflowReviewNodeRevision(graph, reviewNodeId) !== recommendation.reviewNodeRevision) {
    return { state: 'stale', recommendation, reason: 'Review instructions or configuration changed.' };
  }
  if (workflowReviewInstructionsHash(graph, reviewNodeId) !== recommendation.instructionsHash) {
    return { state: 'stale', recommendation, reason: 'Review instructions changed.' };
  }
  if (workflowReviewCandidateSetHash(eligibleCandidates(graph, reviewNodeId)) !== recommendation.candidateSetHash) {
    return { state: 'stale', recommendation, reason: 'The eligible candidate set changed.' };
  }
  return { state: 'ready', recommendation };
}
