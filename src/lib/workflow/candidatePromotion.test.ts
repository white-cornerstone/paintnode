import { describe, expect, it, vi } from 'vitest';
import {
  deriveWorkflowReviewCandidates,
  promoteWorkflowCandidate,
  resolveWorkflowReviewTopology,
  workflowReviewPromotionMaterialKey,
} from './candidatePromotion';
import { parseWorkflowGraphV2, serializeWorkflowGraphV2 } from './schema';
import { instantiateWorkflowTemplate } from './templates';
import { executeWorkflowCandidateBranches } from './candidateBranches';
import {
  createWorkflowCompositionExecutor,
  prepareCampaignGenerateTransform,
  type ExecuteCampaignGenerateOptions,
} from './transformExecutor';
import { createWorkflowRevision, isFullWorkflowRunRecord, workflowSha256Bytes } from './provenance';
import { planSelectiveWorkflowExecution } from './selectiveExecution';
import { appendWorkflowEditorRevision, resolveWorkflowEffectiveResult } from './editorRoundTrip';
import { workflowReadiness } from './readiness';

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
  graph.nodes.find((node) => node.id === 'review-campaign-direction')!.id = 'review-concepts';
  for (const edge of graph.edges) {
    if (edge.source.nodeId === 'review-campaign-direction') edge.source.nodeId = 'review-concepts';
    if (edge.target.nodeId === 'review-campaign-direction') edge.target.nodeId = 'review-concepts';
  }
  graph.edges.find((edge) => edge.target.nodeId === 'review-concepts')!.id = 'edge-transform-review';
  graph.edges.find((edge) => edge.source.nodeId === 'review-concepts' && edge.target.nodeId === 'output-square')!.id = 'edge-review-output';
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

  it('uses the promoted editor revision as the downstream selective cache identity', async () => {
    const graph = await reviewGraph();
    const candidates = deriveWorkflowReviewCandidates(graph, 'review-concepts');
    const promoted = promoteWorkflowCandidate(graph, {
      reviewNodeId: 'review-concepts', candidateId: candidates[0].candidateId,
      id: 'promotion-edited', promotedAt: 800,
    });
    const promotion = promoted.reviewPromotions![0];
    const run = promoted.runRecords.find((record) => record.id === promotion.candidateRunId)!;
    expect(isFullWorkflowRunRecord(run)).toBe(true);
    if (!isFullWorkflowRunRecord(run)) throw new Error('Expected full candidate run');
    const original = run.outputs[0];
    const editedOutput = {
      assetReferenceId: 'ref-promotion-edit', assetId: 'asset-promotion-edit',
      relativePath: 'assets/generated/promotion-edit.png',
      contentHash: workflowSha256Bytes(new Uint8Array([2])), width: 1024, height: 1024,
      mime: 'image/png' as const,
    };
    const edited = appendWorkflowEditorRevision(promoted, {
      version: 1, id: 'revision-promotion-edit', nodeId: run.nodeId, rootRunId: run.id,
      source: {
        kind: 'run-output', id: run.id, assetReferenceId: original.assetReferenceId,
        assetId: original.assetId, relativePath: original.relativePath, contentHash: original.contentHash,
      },
      candidate: {
        branchGroupId: run.candidate!.branchGroupId,
        candidateId: run.candidate!.candidateId,
      },
      promotion: { reviewNodeId: promotion.reviewNodeId, promotionId: promotion.id },
      document: {
        relativePath: 'documents/workflow-edits/promotion-edit.ora',
        contentHash: workflowSha256Bytes(new Uint8Array([1])), mime: 'image/openraster',
      },
      output: editedOutput,
      createdAt: 900,
    }, {
      version: 1, id: 'binding-promotion-edit',
      target: { nodeId: run.nodeId, rootRunId: run.id, promotionId: promotion.id },
      editorRevisionId: 'revision-promotion-edit', boundAt: 900,
    });
    const effective = resolveWorkflowEffectiveResult(edited, {
      nodeId: run.nodeId, rootRunId: run.id,
      candidateId: promotion.candidateId, promotionId: promotion.id,
    })!;
    const originalPlan = planSelectiveWorkflowExecution(promoted, {
      mode: 'run-node', nodeId: 'output-square',
      materialKeys: Object.fromEntries(promoted.nodes.map((node) => [node.id, `material:${node.id}`])),
      isRunRecordReusable: () => false,
    });
    const editedPlan = planSelectiveWorkflowExecution(edited, {
      mode: 'run-node', nodeId: 'output-square',
      materialKeys: Object.fromEntries(edited.nodes.map((node) => [node.id, `material:${node.id}`])),
      reviewEffectiveOutputs: { 'review-concepts': effective.output },
      isReviewOutputAvailable: () => true,
      isRunRecordReusable: () => false,
    });

    expect(editedPlan.cachedResults).toContainEqual(expect.objectContaining({
      nodeId: 'review-concepts', outputIds: [editedOutput.assetReferenceId],
    }));
    expect(editedPlan.cachedResults.find((item) => item.nodeId === 'review-concepts')?.cacheKey)
      .not.toBe(originalPlan.cachedResults.find((item) => item.nodeId === 'review-concepts')?.cacheKey);

    const formatExecutor = createWorkflowCompositionExecutor('fake', async () => {
      throw new Error('Preflight must not invoke the provider.');
    }, { materialization: 'metadata-only' });
    const formatOptions: ExecuteCampaignGenerateOptions = {
      projectPath: '/virtual/project', provider: 'fake', executors: [formatExecutor],
      assets: [product, {
        id: editedOutput.assetId, name: 'Edited direction.png', relativePath: editedOutput.relativePath,
        width: 1024, height: 1024, mime: 'image/png',
      }],
      resolveAsset: async (asset) => ({
        assetId: asset.id,
        relativePath: asset.relativePath,
        bytes: null,
        contentHash: asset.id === editedOutput.assetId
          ? editedOutput.contentHash
          : workflowSha256Bytes(bytes),
      }),
      storeAsset: async () => { throw new Error('Preflight must not store output.'); },
    };
    const portrait = await prepareCampaignGenerateTransform(edited, 'output-portrait', formatOptions);
    const landscape = await prepareCampaignGenerateTransform(edited, 'output-landscape', formatOptions);
    expect(portrait.request.sources[0]).toMatchObject({
      nodeId: 'review-concepts', portId: 'selected', name: 'Accepted edited campaign direction',
      assetId: editedOutput.assetId, relativePath: editedOutput.relativePath,
      contentHash: editedOutput.contentHash,
    });
    expect(landscape.request.sources[0]).toEqual(portrait.request.sources[0]);
    expect(portrait.materialKey).not.toBe(landscape.materialKey);
    const formatPlan = planSelectiveWorkflowExecution(edited, {
      mode: 'run-from-here', nodeId: 'review-concepts',
      materialKeys: {
        'transform-generate-square': promotion.materialKey,
        'transform-generate-portrait': portrait.materialKey,
        'transform-generate-landscape': landscape.materialKey,
      },
      reviewEffectiveOutputs: { 'review-concepts': effective.output },
      isReviewOutputAvailable: () => true,
      isRunRecordReusable: () => false,
    });
    expect(formatPlan.executionNodeIds).toEqual([
      'transform-generate-portrait', 'transform-generate-landscape',
    ]);
    expect(formatPlan.executionNodeIds).not.toContain('transform-generate-square');

    const replacement = promoteWorkflowCandidate(edited, {
      reviewNodeId: 'review-concepts', candidateId: candidates[1].candidateId,
      id: 'promotion-replacement', promotedAt: 1000,
    });
    expect(resolveWorkflowEffectiveResult(replacement, {
      nodeId: candidates[1].sourceNodeId,
      rootRunId: candidates[1].latestRunId,
      candidateId: candidates[1].candidateId,
      promotionId: 'promotion-replacement',
    })?.editorRevision).toBeNull();
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

  it('blocks a promotion whose source is no longer the Transform connected to Review', async () => {
    const graph = await reviewGraph();
    const candidate = deriveWorkflowReviewCandidates(graph, 'review-concepts')[0];
    const promoted = promoteWorkflowCandidate(graph, {
      reviewNodeId: 'review-concepts', candidateId: candidate.candidateId,
      id: 'promotion-reconnected', promotedAt: 1000,
    });
    const reconnected = structuredClone(promoted);
    const original = reconnected.nodes.find((node) => node.id === 'transform-generate-square')!;
    reconnected.nodes.push({ ...structuredClone(original), id: 'transform-replacement', runRecordIds: [] });
    reconnected.edges.find((edge) => edge.id === 'edge-transform-review')!.source.nodeId = 'transform-replacement';
    expect(resolveWorkflowReviewTopology(reconnected, { reviewNodeId: 'review-concepts' }))
      .toMatchObject({ state: 'blocked', reason: { code: 'PROMOTED_LINEAGE_INVALID' } });
  });

  it('requires the Board readiness contract to use a verified Review resolution', async () => {
    const graph = await reviewGraph();
    const candidate = deriveWorkflowReviewCandidates(graph, 'review-concepts')[0];
    const promoted = promoteWorkflowCandidate(graph, {
      reviewNodeId: 'review-concepts', candidateId: candidate.candidateId,
      id: 'promotion-readiness', promotedAt: 1100,
    });
    const baseOptions = {
      desktop: true, projectPath: '/virtual/project', provider: 'fake', supportedProviders: ['fake'],
      targetNodeId: 'output-square',
      assets: [{ id: product.id, relativePath: product.relativePath, exists: true }],
      requireVerifiedReview: true,
    };
    const unverified = workflowReadiness(promoted, baseOptions);
    expect(unverified.items.find((item) => item.code === 'review')).toMatchObject({ status: 'blocked' });

    const resolution = resolveWorkflowReviewTopology(promoted, { reviewNodeId: 'review-concepts' });
    const verified = workflowReadiness(promoted, {
      ...baseOptions,
      reviewResolutions: { 'review-concepts': resolution },
    });
    expect(verified.items.find((item) => item.code === 'review')).toMatchObject({ status: 'complete' });
  });
});
