import { describe, expect, it, vi } from 'vitest';
import type { ProjectAsset } from '../integrations/desktop';
import { createWorkflowCompositionExecutor, workflowSha256Bytes } from '../workflow';
import { WorkflowStore, type WorkflowStoreRunOptions } from './workflow.svelte';

const productBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const product = {
  id: 'product', kind: 'imported', name: 'Product.png', relativePath: 'assets/Product.png',
  createdAt: 1, exists: true, width: 1200, height: 1200, mime: 'image/png',
} satisfies ProjectAsset;

function store(): WorkflowStore {
  const value = new WorkflowStore();
  value.newFromTemplate('campaign-composer', 'Candidate Store');
  value.assignAsset('slot-product', product);
  return value;
}

function options(execute: ReturnType<typeof createWorkflowCompositionExecutor>['execute']): WorkflowStoreRunOptions {
  let stored = 0;
  return {
    projectPath: '/virtual/project',
    currentProjectIdentity: () => '/virtual/project:current',
    provider: 'fake',
    executors: [{
      provider: 'fake', capabilities: ['generate'], materialization: 'visual-bytes',
      executor: { id: 'candidate-store', version: '1', requestSchemaVersion: '1' },
      describeRun: () => ({ id: 'fake', model: null, effectiveOptions: {} }),
      execute,
    }],
    assets: [product],
    resolveAsset: async () => ({
      assetId: product.id, relativePath: product.relativePath,
      bytes: productBytes, contentHash: workflowSha256Bytes(productBytes),
    }),
    storeAsset: vi.fn(async (artifact) => ({
      id: `candidate-asset-${++stored}`,
      name: artifact.name,
      relativePath: `assets/generated/${artifact.name}`,
      width: artifact.width,
      height: artifact.height,
      mime: artifact.mime,
    })),
  };
}

describe('WorkflowStore candidate branches', () => {
  it('commits one merged branch group and reopens its visible candidate state', async () => {
    const workflow = store();
    let calls = 0;
    const runOptions = options(async () => {
      calls += 1;
      if (calls === 2) throw new Error('One candidate failed safely.');
      return {
        kind: 'bytes', name: 'concept.png',
        bytes: new Uint8Array([137, 80, 78, 71, calls]),
        mime: 'image/png', width: 1024, height: 1024,
      };
    });

    const outcome = await workflow.runCandidateBranches('output-square', runOptions, {
      branchGroupId: 'store-branch-group', count: 3, maxConcurrency: 2,
    });

    expect(outcome.committed).toBe(true);
    expect(workflow.candidateBranchGroups('transform-generate-square')[0]).toMatchObject({
      id: 'store-branch-group',
      candidates: expect.arrayContaining([
        expect.objectContaining({ status: 'succeeded' }),
        expect.objectContaining({ status: 'failed' }),
      ]),
    });
    expect(workflow.transformExecution('transform-generate-square')).toMatchObject({ state: 'idle' });
    const selective = await workflow.preflightSelectiveExecution(
      'run-node', 'output-square', runOptions,
    );
    expect(selective.stateByNodeId['transform-generate-square']).not.toMatchObject({ state: 'cached' });
    expect(selective.stateByNodeId['transform-generate-square'].willExecute).toBe(true);
    const reopened = new WorkflowStore();
    reopened.openFromBytes(workflow.toBytes(), null, 'Reopened candidates');
    expect(reopened.candidateBranchGroups()).toEqual(workflow.candidateBranchGroups());
  });

  it('blocks the single merged commit after an external workflow change', async () => {
    const workflow = store();
    let release!: () => void;
    let started = 0;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runOptions = options(async () => {
      started += 1;
      await gate;
      return {
        kind: 'bytes', name: 'concept.png', bytes: new Uint8Array([137, 80, 78, 71, 9]),
        mime: 'image/png', width: 1024, height: 1024,
      };
    });
    const execution = workflow.runCandidateBranches('output-square', runOptions, {
      branchGroupId: 'stale-branch-group', count: 2, maxConcurrency: 2,
    });
    while (started < 2) await Promise.resolve();
    workflow.setBriefObjective('brief', 'Changed while candidates were running.');
    release();

    const outcome = await execution;
    expect(outcome).toMatchObject({ committed: false, commitMessage: expect.stringMatching(/workflow changed/i) });
    expect(runOptions.storeAsset).toHaveBeenCalledTimes(2);
    expect(workflow.candidateBranchGroups()).toEqual([]);
  });

  it('verifies candidate bytes before atomically appending and reopening a promotion', async () => {
    const workflow = store();
    const originalBrief = String(workflow.serialize().nodes.find((node) => node.id === 'brief')!.config.objective);
    const reviewId = workflow.addCreatorNode('review');
    workflow.disconnectNodes('transform-generate-square', 'output-square');
    expect(workflow.connectPorts('transform-generate-square', 'result', reviewId, 'candidates')).toBe(true);
    expect(workflow.connectPorts(reviewId, 'selected', 'output-square', 'source')).toBe(true);
    const candidateBytes = new Uint8Array([137, 80, 78, 71, 81, 1]);
    const runOptions = options(async () => ({
      kind: 'bytes', name: 'concept.png', bytes: candidateBytes,
      mime: 'image/png', width: 1024, height: 1024,
    }));
    await workflow.runCandidateBranches('output-square', runOptions, {
      branchGroupId: 'promotion-store-group', count: 2, maxConcurrency: 1,
    });
    const candidate = workflow.reviewCandidates(reviewId)[0];
    const generated = {
      id: candidate.output!.assetId, kind: 'generated', name: 'concept.png',
      relativePath: candidate.output!.relativePath, createdAt: 2, exists: true,
      width: 1024, height: 1024, mime: 'image/png',
    } satisfies ProjectAsset;
    runOptions.assets = [product, generated];
    runOptions.resolveAsset = async (asset) => asset.id === generated.id
      ? {
          assetId: generated.id, relativePath: generated.relativePath,
          bytes: candidateBytes, contentHash: workflowSha256Bytes(candidateBytes),
        }
      : {
          assetId: product.id, relativePath: product.relativePath,
          bytes: productBytes, contentHash: workflowSha256Bytes(productBytes),
        };

    await workflow.promoteCandidate(reviewId, candidate.candidateId, runOptions);
    expect(workflow.serialize().reviewPromotions).toHaveLength(1);
    await workflow.refreshReviewState(reviewId, runOptions);
    expect(workflow.reviewCandidates(reviewId, runOptions.assets, true)[0].state).toBe('eligible');
    expect(workflow.reviewResolution(reviewId, runOptions.assets, true).state).toBe('ready');

    let releaseConcurrentVerification!: () => void;
    let concurrentVerificationStarted!: () => void;
    const concurrentStarted = new Promise<void>((resolve) => { concurrentVerificationStarted = resolve; });
    const concurrentGate = new Promise<void>((resolve) => { releaseConcurrentVerification = resolve; });
    const concurrentOptions: WorkflowStoreRunOptions = {
      ...runOptions,
      resolveAsset: async (asset) => {
        if (asset.id === generated.id) {
          concurrentVerificationStarted();
          await concurrentGate;
        }
        return runOptions.resolveAsset(asset);
      },
    };
    const concurrentVerification = workflow.refreshReviewState(reviewId, concurrentOptions);
    await concurrentStarted;
    const concurrentBranches = await workflow.runCandidateBranches('output-square', runOptions, {
      branchGroupId: 'concurrent-verification-group', count: 2, maxConcurrency: 1,
    });
    expect(concurrentBranches.committed).toBe(true);
    expect(workflow.candidateBranchGroups('transform-generate-square'))
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: 'concurrent-verification-group' })]));
    releaseConcurrentVerification();
    await expect(concurrentVerification).rejects.toThrow(/changed/i);

    let releaseProviderA!: () => void;
    let providerAStarted!: () => void;
    const providerAStartedPromise = new Promise<void>((resolve) => { providerAStarted = resolve; });
    const providerAGate = new Promise<void>((resolve) => { releaseProviderA = resolve; });
    const providerAOptions: WorkflowStoreRunOptions = {
      ...runOptions,
      selectiveExecutionIdentity: 'review-provider-a',
      resolveAsset: async (asset) => {
        if (asset.id === generated.id) {
          providerAStarted();
          await providerAGate;
        }
        return runOptions.resolveAsset(asset);
      },
    };
    const providerARefresh = workflow.refreshReviewState(reviewId, providerAOptions);
    await providerAStartedPromise;
    const providerBOptions: WorkflowStoreRunOptions = {
      ...runOptions,
      selectiveExecutionIdentity: 'review-provider-b',
    };
    await workflow.refreshReviewState(reviewId, providerBOptions);
    releaseProviderA();
    await expect(providerARefresh).rejects.toThrow(/superseded/i);
    expect(workflow.reviewVerifications[reviewId] as unknown as Record<string, unknown>)
      .toMatchObject({ optionsIdentity: expect.stringContaining('review-provider-b') });
    const reopened = new WorkflowStore();
    reopened.openFromBytes(workflow.toBytes(), null, 'Reopened promotion');
    expect(reopened.reviewResolution(reviewId)).toMatchObject({
      state: 'ready', promotion: { candidateId: candidate.candidateId },
    });

    workflow.setBriefObjective('brief', 'Changed upstream after promotion.');
    expect(workflow.reviewCandidates(reviewId, runOptions.assets, true)[0].state).toBe('stale');
    expect(workflow.reviewResolution(reviewId, runOptions.assets, true))
      .toMatchObject({ state: 'blocked', reason: { code: 'PROMOTION_STALE' } });
    await workflow.refreshReviewState(reviewId, runOptions);
    expect(workflow.reviewCandidates(reviewId, runOptions.assets, true)[0].state).toBe('stale');
    expect(workflow.reviewResolution(reviewId, runOptions.assets, true))
      .toMatchObject({ state: 'blocked', reason: { code: 'PROMOTION_STALE' } });
    const stalePreflight = await workflow.preflightSelectiveExecution('run-node', 'output-square', runOptions);
    expect(stalePreflight.stateByNodeId[reviewId]).toMatchObject({ state: 'blocked' });
    expect(stalePreflight.plan.cachedResults.map((result) => result.nodeId)).not.toContain(reviewId);
    expect(stalePreflight.plan.executionNodeIds).not.toContain('transform-generate-square');

    workflow.setBriefObjective('brief', originalBrief);
    runOptions.assets = [product];
    const missingPreflight = await workflow.preflightSelectiveExecution('run-node', 'output-square', runOptions);
    expect(missingPreflight.stateByNodeId[reviewId]).toMatchObject({ state: 'blocked' });
    expect(missingPreflight.plan.cachedResults.map((result) => result.nodeId)).not.toContain(reviewId);

    runOptions.assets = [product, generated];
    runOptions.resolveAsset = async (asset) => asset.id === generated.id
      ? {
          assetId: generated.id, relativePath: generated.relativePath,
          bytes: new Uint8Array([1, 2, 3]), contentHash: workflowSha256Bytes(new Uint8Array([1, 2, 3])),
        }
      : {
          assetId: product.id, relativePath: product.relativePath,
          bytes: productBytes, contentHash: workflowSha256Bytes(productBytes),
        };
    const tamperedPreflight = await workflow.preflightSelectiveExecution('run-node', 'output-square', runOptions);
    expect(tamperedPreflight.stateByNodeId[reviewId]).toMatchObject({ state: 'blocked' });
    expect(tamperedPreflight.plan.cachedResults.map((result) => result.nodeId)).not.toContain(reviewId);

    await expect(workflow.promoteCandidate(reviewId, candidate.candidateId, runOptions))
      .rejects.toThrow(/changed/i);
    expect(workflow.serialize().reviewPromotions).toHaveLength(1);
  });
});
