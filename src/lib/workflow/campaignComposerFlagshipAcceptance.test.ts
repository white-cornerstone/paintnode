import { describe, expect, it, vi } from 'vitest';
import { providerFreeWorkflowDraft } from '../integrations/workflowDirectorAdapters';
import type { ProjectAsset } from '../integrations/desktop';
import { bindWorkflowRoundTripAuthority } from '../state/workflowEditorSession';
import { project } from '../state/project.svelte';
import { WorkflowStore, type WorkflowStoreRunOptions } from '../state/workflow.svelte';
import { createWorkflowCompositionExecutor } from './transformExecutor';
import { buildWorkflowDirectorContext, createWorkflowDirectorProposal, isCampaignRequirementsEquivalent } from './directorDraft';
import { isFullWorkflowRunRecord, workflowSha256Bytes } from './provenance';
import { parseWorkflowGraphV2, serializeWorkflowGraphV2 } from './schema';
import { instantiateWorkflowTemplate } from './templates';

describe('Campaign Composer provider-free flagship acceptance', () => {
  it('completes, selectively reruns, recovers, and reopens the production journey', async () => {
    const productABytes = new Uint8Array([137, 80, 78, 71, 1]);
    const productBBytes = new Uint8Array([137, 80, 78, 71, 2]);
    const productA: ProjectAsset = {
      id: 'product-a', kind: 'imported', name: 'Product A.png', relativePath: 'assets/Product-A.png',
      createdAt: 1, exists: true, width: 1200, height: 1200, mime: 'image/png',
    };
    const productB: ProjectAsset = {
      ...productA, id: 'product-b', name: 'Product B.png', relativePath: 'assets/Product-B.png', createdAt: 2,
    };
    const requestedOutputs = [
      { id: 'square', name: 'Square 1:1', width: 1024, height: 1024 },
      { id: 'portrait', name: 'Portrait 4:5', width: 1024, height: 1280 },
      { id: 'landscape', name: 'Landscape 16:9', width: 1280, height: 720 },
    ];
    const directorContext = buildWorkflowDirectorContext({
      brief: 'Build a coordinated launch campaign.',
      assets: [productA],
      requestedOutputs,
      capabilities: [
        { id: 'generate', available: true, reason: null },
        { id: 'candidate-review', available: false, reason: 'Human review is used.' },
      ],
    });
    const director = createWorkflowDirectorProposal(
      providerFreeWorkflowDraft(directorContext), directorContext, { graphId: 'flagship-director' },
    ).proposal!;
    expect(isCampaignRequirementsEquivalent(
      director.graph,
      instantiateWorkflowTemplate('campaign-composer', { graphId: 'flagship-template' }),
    )).toEqual({ equivalent: true, differences: [] });

    const store = new WorkflowStore();
    store.newFromTemplate('campaign-composer', 'Flagship acceptance');
    expect(store.serialize().nodes.filter((node) => node.type === 'input').map((node) => [
      node.title, node.config.required,
    ])).toEqual([['Product', true], ['Subject', false], ['Style', false]]);
    store.assignAsset('slot-product', productA);

    const assets: ProjectAsset[] = [productA];
    const bytesByAssetId = new Map<string, Uint8Array>([[productA.id, productABytes]]);
    const providerRequests: Array<{ nodeId: string; width: number; height: number; sourceIds: string[] }> = [];
    let assetSequence = 0;
    let failCandidateTwo = true;
    let failLandscapeOnce = true;
    const executor = createWorkflowCompositionExecutor('qa-fake', async (request, context) => {
      providerRequests.push({
        nodeId: request.nodeId,
        width: request.output.width,
        height: request.output.height,
        sourceIds: request.sources.map((source) => source.assetId),
      });
      if (failCandidateTwo && /candidate-2-[a-f0-9]+-attempt-1$/.test(context.identity.runId)) {
        throw new Error('Isolated candidate failure.');
      }
      if (failLandscapeOnce && request.nodeId === 'transform-generate-landscape') {
        failLandscapeOnce = false;
        throw new Error('Isolated landscape failure.');
      }
      return {
        kind: 'bytes',
        name: `${request.nodeId}-${providerRequests.length}.png`,
        bytes: new Uint8Array([137, 80, 78, 71, providerRequests.length]),
        mime: 'image/png',
        width: request.output.width,
        height: request.output.height,
      };
    });
    const options: WorkflowStoreRunOptions = {
      projectPath: '/virtual/project',
      currentProjectIdentity: () => project.identity,
      provider: 'qa-fake',
      executors: [executor],
      assets,
      resolveAsset: vi.fn(async (asset) => {
        const bytes = bytesByAssetId.get(asset.id);
        if (!bytes) throw new Error(`Missing in-memory bytes for ${asset.id}`);
        return {
          assetId: asset.id, relativePath: asset.relativePath,
          bytes: new Uint8Array(bytes), contentHash: workflowSha256Bytes(bytes),
        };
      }),
      storeAsset: vi.fn(async (artifact) => {
        const asset: ProjectAsset = {
          id: `generated-${++assetSequence}`, kind: 'generated', name: artifact.name,
          relativePath: `assets/generated/${assetSequence}-${artifact.name}`, createdAt: 10 + assetSequence,
          exists: true, width: artifact.width, height: artifact.height, mime: artifact.mime,
        };
        assets.push(asset);
        bytesByAssetId.set(asset.id, new Uint8Array(artifact.bytes));
        return asset;
      }),
    };

    const firstBranches = await store.runCandidateBranches('output-square', options, {
      branchGroupId: 'flagship-concepts-a', count: 3, maxConcurrency: 1,
    });
    expect(firstBranches.group.candidates.map((candidate) => candidate.status))
      .toEqual(['succeeded', 'failed', 'succeeded']);
    expect(store.reviewCandidates('review-campaign-direction').map((candidate) => candidate.ordinal))
      .toEqual([1, 3]);
    const failedCandidate = firstBranches.group.candidates.find((candidate) => candidate.status === 'failed')!;
    await store.retryCandidateBranch(failedCandidate.candidateId, options);
    expect(store.reviewCandidates('review-campaign-direction').map((candidate) => candidate.state))
      .toEqual(['eligible', 'eligible', 'eligible']);
    expect(providerRequests).toHaveLength(4);

    expect(store.reviewCandidates('review-campaign-direction').map((candidate) => candidate.ordinal))
      .toEqual([1, 2, 3]);
    const promotedCandidate = store.reviewCandidates('review-campaign-direction')[0];
    await store.promoteCandidate('review-campaign-direction', promotedCandidate.candidateId, options);
    await store.refreshReviewState('review-campaign-direction', options);
    const promotion = store.serialize().reviewPromotions!.at(-1)!;
    const editorDescriptor = store.prepareWorkflowEditorRoundTrip({
      nodeId: promotion.sourceNodeId,
      rootRunId: promotion.candidateRunId,
      assetReferenceId: promotion.assetReferenceId,
      promotionId: promotion.id,
    }, assets, project.identity);
    const editedBytes = new Uint8Array([137, 80, 78, 71, 99]);
    const editedAsset: ProjectAsset = {
      id: 'edited-direction', kind: 'edited', name: 'Edited direction.png',
      relativePath: 'assets/generated/edited-direction.png', createdAt: 30, exists: true,
      width: 1024, height: 1024, mime: 'image/png',
    };
    assets.push(editedAsset);
    bytesByAssetId.set(editedAsset.id, editedBytes);
    const editorSession = { doc: {} };
    bindWorkflowRoundTripAuthority(editorSession, editorDescriptor.authority);
    store.commitWorkflowEditorReturn(editorSession, {
      revisionId: 'flagship-editor-revision', bindingId: 'flagship-editor-binding',
      outputAssetReferenceId: 'flagship-editor-reference', width: 1024, height: 1024, createdAt: 31,
      artifacts: {
        document: {
          relativePath: 'documents/workflow-edits/flagship.ora',
          contentHash: `sha256:${'d'.repeat(64)}`, mime: 'image/openraster',
        },
        output: { ...editedAsset, previewDataUrl: null },
        outputContentHash: workflowSha256Bytes(editedBytes), cleanupToken: 'flagship-cleanup',
      },
    });
    await store.refreshReviewState('review-campaign-direction', options);
    expect(store.reviewResolution('review-campaign-direction', assets, true)).toMatchObject({
      state: 'ready', output: { assetId: editedAsset.id },
    });

    const callsBeforeOutputs = providerRequests.length;
    const firstFormatPreflight = await store.preflightSelectiveExecution(
      'run-from-here', 'review-campaign-direction', options,
    );
    expect(firstFormatPreflight.plan.executionNodeIds).toEqual([
      'transform-format-square', 'transform-generate-portrait', 'transform-generate-landscape',
    ]);
    const firstFormatRun = await store.runSelectiveExecution(firstFormatPreflight, options, { maxConcurrency: 1 });
    expect(firstFormatRun.executedNodeIds).toEqual([
      'transform-format-square', 'transform-generate-portrait', 'transform-generate-landscape',
    ]);
    expect(firstFormatRun.failures['transform-generate-landscape']).toMatchObject({ code: 'EXECUTOR_ERROR' });
    expect(providerRequests).toHaveLength(callsBeforeOutputs + 3);
    expect(providerRequests.slice(callsBeforeOutputs).map((request) => request.sourceIds[0]))
      .toEqual([editedAsset.id, editedAsset.id, editedAsset.id]);

    const retryFormatPreflight = await store.preflightSelectiveExecution(
      'run-from-here', 'review-campaign-direction', options,
    );
    expect(retryFormatPreflight.plan.executionNodeIds).toEqual(['transform-generate-landscape']);
    const portraitBindingBeforeRetry = structuredClone(store.outputNode('output-portrait'));
    await store.runSelectiveExecution(retryFormatPreflight, options, { maxConcurrency: 1 });
    expect(store.outputNode('output-portrait')).toEqual(portraitBindingBeforeRetry);
    expect(providerRequests).toHaveLength(callsBeforeOutputs + 4);

    const unchangedPreflight = await store.preflightSelectiveExecution(
      'run-from-here', 'review-campaign-direction', options,
    );
    expect(unchangedPreflight.plan.executionNodeIds).toEqual([]);
    await store.runSelectiveExecution(unchangedPreflight, options, { maxConcurrency: 1 });
    expect(providerRequests).toHaveLength(callsBeforeOutputs + 4);

    assets.push(productB);
    bytesByAssetId.set(productB.id, productBBytes);
    store.assignAsset('slot-product', productB);
    const staleFromProduct = await store.preflightSelectiveExecution('run-from-here', 'slot-product', options);
    expect(staleFromProduct.plan.affectedNodeIds).toEqual([
      'slot-product', 'composition', 'transform-generate-square', 'review-campaign-direction',
      'transform-format-square', 'transform-generate-portrait', 'transform-generate-landscape',
      'output-square', 'output-portrait', 'output-landscape',
    ]);
    expect(staleFromProduct.plan.affectedNodeIds).not.toContain('slot-subject');
    expect(staleFromProduct.plan.affectedNodeIds).not.toContain('slot-style');

    failCandidateTwo = false;
    const callsBeforeProductRerun = providerRequests.length;
    const replacementBranches = await store.runCandidateBranches('output-square', options, {
      branchGroupId: 'flagship-concepts-b', count: 3, maxConcurrency: 1,
    });
    await store.promoteCandidate(
      'review-campaign-direction', replacementBranches.group.candidates[0].candidateId, options,
    );
    await store.refreshReviewState('review-campaign-direction', options);
    const productFormatPreflight = await store.preflightSelectiveExecution(
      'run-from-here', 'review-campaign-direction', options,
    );
    expect(productFormatPreflight.plan.executionNodeIds).toEqual([
      'transform-format-square', 'transform-generate-portrait', 'transform-generate-landscape',
    ]);
    await store.runSelectiveExecution(productFormatPreflight, options, { maxConcurrency: 1 });
    expect(providerRequests.slice(callsBeforeProductRerun).map((request) => request.nodeId)).toEqual([
      'transform-generate-square', 'transform-generate-square', 'transform-generate-square',
      'transform-format-square', 'transform-generate-portrait', 'transform-generate-landscape',
    ]);
    expect(providerRequests).toHaveLength(14);
    expect(Object.fromEntries(['transform-generate-square', 'transform-format-square', 'transform-generate-portrait', 'transform-generate-landscape']
      .map((nodeId) => [nodeId, providerRequests.filter((request) => request.nodeId === nodeId).length])))
      .toEqual({
        'transform-generate-square': 7,
        'transform-format-square': 2,
        'transform-generate-portrait': 2,
        'transform-generate-landscape': 3,
      });

    const persisted = store.serialize();
    const reopenedGraph = parseWorkflowGraphV2(JSON.parse(serializeWorkflowGraphV2(persisted))).value!;
    const reopened = new WorkflowStore();
    reopened.openFromBytes(new TextEncoder().encode(serializeWorkflowGraphV2(reopenedGraph)), null, 'Reopened flagship');
    expect(reopened.serialize().runRecords).toEqual(persisted.runRecords);
    expect(reopened.serialize().reviewPromotions).toEqual(persisted.reviewPromotions);
    expect(reopened.serialize().editorRevisions).toEqual(persisted.editorRevisions);
    expect(reopened.serialize().workflowRoundTrips).toEqual(persisted.workflowRoundTrips);
    expect(reopened.serialize().editorRevisions).toHaveLength(1);
    expect(reopened.serialize().workflowRoundTrips).toHaveLength(1);
    expect(reopened.serialize().runRecords.filter(isFullWorkflowRunRecord).every((run) => (
      run.sourceAssets.every((source) => source.contentHash.startsWith('sha256:'))
    ))).toBe(true);
    const selectedOutputs = [
      reopened.outputNode('output-square'),
      reopened.outputNode('output-portrait'),
      reopened.outputNode('output-landscape'),
    ];
    expect(selectedOutputs).toEqual([
      expect.objectContaining({ outputAssetId: expect.any(String), finalWidth: 1024, finalHeight: 1024 }),
      expect.objectContaining({ outputAssetId: expect.any(String), finalWidth: 1024, finalHeight: 1280 }),
      expect.objectContaining({ outputAssetId: expect.any(String), finalWidth: 1280, finalHeight: 720 }),
    ]);
  });
});
