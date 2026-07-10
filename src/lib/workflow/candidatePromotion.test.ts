import { describe, expect, it, vi } from 'vitest';
import {
  deriveWorkflowReviewCandidates,
  promoteWorkflowCandidate,
  resolveWorkflowReviewTopology,
  workflowReviewPromotionMaterialKey,
} from './candidatePromotion';
import { createCreatorNode } from './registry';
import { parseWorkflowGraphV2, serializeWorkflowGraphV2 } from './schema';
import { instantiateWorkflowTemplate } from './templates';
import { executeWorkflowCandidateBranches } from './candidateBranches';
import { createWorkflowCompositionExecutor, type ExecuteCampaignGenerateOptions } from './transformExecutor';
import { createWorkflowRevision, workflowSha256Bytes } from './provenance';
import { planSelectiveWorkflowExecution } from './selectiveExecution';

const bytes = new Uint8Array([137, 80, 78, 71, 81]);
const product = {
  id: 'asset-product', name: 'Product.png', relativePath: 'assets/Product.png',
  width: 1200, height: 1200, mime: 'image/png',
};

async function reviewGraph() {
  const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer', { graphId: 'promotion-test' }));
  graph.nodes.find((node) => node.id === 'slot-product')!.config = {
    ...graph.nodes.find((node) => node.id === 'slot-product')!.config,
    assetId: product.id, relativePath: product.relativePath,
  };
  graph.nodes.push(createCreatorNode('review', { id: 'review-concepts', position: { x: 1250, y: 500 } }));
  graph.edges = graph.edges.filter((edge) => edge.id !== 'edge-transform-generate-square-output-square');
  graph.edges.push(
    {
      id: 'edge-transform-review',
      source: { nodeId: 'transform-generate-square', portId: 'result' },
      target: { nodeId: 'review-concepts', portId: 'candidates' },
    },
    {
      id: 'edge-review-output',
      source: { nodeId: 'review-concepts', portId: 'selected' },
      target: { nodeId: 'output-square', portId: 'source' },
    },
  );
  let stored = 0;
  const executor = createWorkflowCompositionExecutor('fake', async () => ({
    kind: 'bytes', name: 'concept.png', bytes: new Uint8Array([...bytes, ++stored]),
    mime: 'image/png', width: 1024, height: 1024,
  }));
  const options: ExecuteCampaignGenerateOptions = {
    projectPath: '/virtual/project', provider: 'fake', executors: [executor], assets: [product],
    resolveAsset: async () => ({
      assetId: product.id, relativePath: product.relativePath, bytes,
      contentHash: workflowSha256Bytes(bytes),
    }),
    storeAsset: vi.fn(async (artifact) => ({
      id: `candidate-asset-${stored}`, name: artifact.name,
      relativePath: `assets/generated/${artifact.name}`,
      width: 1024, height: 1024, mime: 'image/png',
    })),
    clock: (() => { let now = 100; return () => ++now; })(),
  };
  const branched = await executeWorkflowCandidateBranches(graph, 'output-square', options, {
    branchGroupId: 'review-group', count: 2, maxConcurrency: 1,
  });
  return structuredClone(branched.graph);
}

describe('workflow candidate promotion', () => {
  it('keeps legacy graphs valid with an empty promotion ledger', () => {
    const legacy = instantiateWorkflowTemplate('campaign-composer', { graphId: 'legacy-review' });
    const parsed = parseWorkflowGraphV2(legacy);
    expect(parsed.ok).toBe(true);
    expect(parsed.value?.reviewPromotions).toBeUndefined();
  });

  it('lists eligible, stale, failed, and unavailable candidates with inspectable context', async () => {
    const graph = await reviewGraph();
    const eligible = deriveWorkflowReviewCandidates(graph, 'review-concepts');
    expect(eligible.map((candidate) => candidate.state)).toEqual(['eligible', 'eligible']);
    const stale = deriveWorkflowReviewCandidates(graph, 'review-concepts', {
      currentMaterialKeys: { 'transform-generate-square': 'changed-material' },
    });
    expect(stale.map((candidate) => candidate.state)).toEqual(['stale', 'stale']);
    const unavailable = deriveWorkflowReviewCandidates(graph, 'review-concepts', {
      isOutputAvailable: (output) => output.assetId !== 'candidate-asset-2',
    });
    expect(unavailable.map((candidate) => candidate.state)).toEqual(['eligible', 'unavailable']);
    const failedGraph = structuredClone(graph);
    const failedRun = failedGraph.runRecords.find((record) => record.id === eligible[0].latestRunId)!;
    Object.assign(failedRun, { status: 'failed', outputs: [], failure: { code: 'FAILED', message: 'Safe failure' } });
    expect(deriveWorkflowReviewCandidates(failedGraph, 'review-concepts')[0].state).toBe('failed');
    expect(eligible[0]).toMatchObject({
      brief: expect.any(String), artDirection: expect.any(String),
      providerId: 'fake', sourceNodeId: 'transform-generate-square',
    });
  });

  it('promotes additively, preserves alternatives, and resolves downstream from the decision instead of latest', async () => {
    const graph = await reviewGraph();
    const candidates = deriveWorkflowReviewCandidates(graph, 'review-concepts');
    const first = promoteWorkflowCandidate(graph, {
      reviewNodeId: 'review-concepts', candidateId: candidates[0].candidateId,
      id: 'promotion-1', promotedAt: 500,
    });
    const second = promoteWorkflowCandidate(first, {
      reviewNodeId: 'review-concepts', candidateId: candidates[1].candidateId,
      id: 'promotion-2', promotedAt: 600,
    });
    expect(second.reviewPromotions).toHaveLength(2);
    expect(first.runRecords).toEqual(graph.runRecords);
    expect(second.runRecords).toEqual(graph.runRecords);
    expect(second.reviewPromotions?.[1]).toMatchObject({ supersedesPromotionId: 'promotion-1' });
    const firstResolution = resolveWorkflowReviewTopology(first, { reviewNodeId: 'review-concepts' });
    const secondResolution = resolveWorkflowReviewTopology(second, { reviewNodeId: 'review-concepts' });
    expect(secondResolution).toMatchObject({
      state: 'ready', promotion: { id: 'promotion-2', candidateId: candidates[1].candidateId },
    });
    expect(createWorkflowRevision(first)).toBe(createWorkflowRevision(second));
    expect(workflowReviewPromotionMaterialKey(firstResolution as Extract<typeof firstResolution, { state: 'ready' }>))
      .not.toBe(workflowReviewPromotionMaterialKey(secondResolution as Extract<typeof secondResolution, { state: 'ready' }>));
  });

  it('round-trips promotion history and recoverably blocks missing or stale promoted outputs', async () => {
    const graph = await reviewGraph();
    const candidate = deriveWorkflowReviewCandidates(graph, 'review-concepts')[0];
    const promoted = promoteWorkflowCandidate(graph, {
      reviewNodeId: 'review-concepts', candidateId: candidate.candidateId,
      id: 'promotion-save', promotedAt: 700,
    });
    const reopened = parseWorkflowGraphV2(JSON.parse(serializeWorkflowGraphV2(promoted))).value!;
    expect(reopened.reviewPromotions).toEqual(promoted.reviewPromotions);
    expect(resolveWorkflowReviewTopology(reopened, {
      reviewNodeId: 'review-concepts', currentMaterialKeys: { 'transform-generate-square': 'changed' },
    })).toMatchObject({ state: 'blocked', reason: { code: 'PROMOTION_STALE' } });
    expect(resolveWorkflowReviewTopology(reopened, {
      reviewNodeId: 'review-concepts', isOutputAvailable: () => false,
    })).toMatchObject({ state: 'blocked', reason: { code: 'PROMOTED_OUTPUT_UNAVAILABLE' } });
  });

  it('treats a resolved Review as an exact cached semantic boundary in selective execution', async () => {
    const graph = await reviewGraph();
    const candidates = deriveWorkflowReviewCandidates(graph, 'review-concepts');
    const promoted = promoteWorkflowCandidate(graph, {
      reviewNodeId: 'review-concepts', candidateId: candidates[0].candidateId,
      id: 'promotion-selective', promotedAt: 800,
    });
    const plan = planSelectiveWorkflowExecution(promoted, {
      mode: 'run-node', nodeId: 'output-square',
      materialKeys: Object.fromEntries(promoted.nodes.map((node) => [node.id, `material:${node.id}`])),
      isRunRecordReusable: () => false,
    });
    expect(plan.cachedResults).toContainEqual(expect.objectContaining({
      nodeId: 'review-concepts', outputIds: [candidates[0].output!.assetReferenceId],
    }));
    expect(plan.dependencies['review-concepts']).toEqual([]);
    expect(plan.executionNodeIds).not.toContain('transform-generate-square');

    const unpromoted = planSelectiveWorkflowExecution(graph, {
      mode: 'run-node', nodeId: 'output-square',
      materialKeys: Object.fromEntries(graph.nodes.map((node) => [node.id, `material:${node.id}`])),
      isRunRecordReusable: () => false,
    });
    expect(unpromoted.preflight.find((entry) => entry.nodeId === 'review-concepts')).toMatchObject({
      state: 'blocked', reason: { code: 'NODE_DISABLED', message: expect.stringMatching(/choose a concept/i) },
    });
    expect(unpromoted.executionNodeIds).not.toContain('transform-generate-square');
  });

  it('loads broken promotion references as recoverable state while rejecting a malformed append chain', async () => {
    const graph = await reviewGraph();
    const candidate = deriveWorkflowReviewCandidates(graph, 'review-concepts')[0];
    const promoted = promoteWorkflowCandidate(graph, {
      reviewNodeId: 'review-concepts', candidateId: candidate.candidateId,
      id: 'promotion-broken', promotedAt: 900,
    });
    const missingRun = structuredClone(promoted);
    missingRun.reviewPromotions![0].candidateRunId = 'missing-candidate-run';
    expect(parseWorkflowGraphV2(missingRun).ok).toBe(true);
    expect(resolveWorkflowReviewTopology(missingRun, { reviewNodeId: 'review-concepts' }))
      .toMatchObject({ state: 'blocked', reason: { code: 'PROMOTED_RUN_MISSING' } });

    const malformed = structuredClone(promoted);
    malformed.reviewPromotions!.push({
      ...malformed.reviewPromotions![0], id: 'promotion-bad-chain', promotedAt: 901,
      supersedesPromotionId: 'not-the-prior-decision',
    });
    expect(parseWorkflowGraphV2(malformed).ok).toBe(false);
  });

  it('recoverably rejects an ambiguous Review topology', async () => {
    const graph = await reviewGraph();
    graph.edges.push({
      id: 'ambiguous-review-output',
      source: { nodeId: 'review-concepts', portId: 'selected' },
      target: { nodeId: 'output-landscape', portId: 'source' },
    });
    expect(resolveWorkflowReviewTopology(graph, { reviewNodeId: 'review-concepts' }))
      .toMatchObject({ state: 'blocked', reason: { code: 'REVIEW_TOPOLOGY_INVALID' } });
  });
});
