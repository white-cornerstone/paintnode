import { describe, expect, it, vi } from 'vitest';
import type { ProjectAsset } from '../integrations/desktop';
import { WorkflowStore, type WorkflowStoreRunOptions } from '../state/workflow.svelte';
import {
  WorkflowReviewRefreshGate,
  WorkflowReviewVerificationCoordinator,
  createWorkflowReviewRefreshIdentity,
  shouldRetryReviewVerificationAfterRefresh,
  type WorkflowReviewVerificationState,
} from './boardRunContext';
import { workflowSha256Bytes } from './provenance';
import { createWorkflowCompositionExecutor } from './transformExecutor';

function identity(overrides: Record<string, unknown> = {}) {
  return createWorkflowReviewRefreshIdentity({
    workflowId: 'workflow-one',
    workflowRevision: 12,
    projectIdentity: 'project:one',
    executionOptionsIdentity: JSON.stringify({
      provider: 'codex',
      qaMode: null,
      qaScenario: 'success',
      options: { model: 'gpt-image-1', effort: 'medium' },
      keepAiDebugArtifacts: false,
    }),
    assetIdentity: [['asset-1', 'assets/one.png', true]],
    ...overrides,
  });
}

describe('Board Review verification refresh gate', () => {
  it('schedules exactly once per model/run-options or provider-free QA scenario identity', () => {
    const gate = new WorkflowReviewRefreshGate();
    const refreshAndEvict = vi.fn();
    const refresh = (contextIdentity: string) => {
      if (gate.shouldRefresh(contextIdentity)) refreshAndEvict();
    };
    const initial = identity();
    refresh(initial);
    refresh(initial);
    expect(refreshAndEvict).toHaveBeenCalledTimes(1);

    const modelChanged = identity({
      executionOptionsIdentity: JSON.stringify({
        provider: 'codex', qaMode: null, qaScenario: 'success',
        options: { model: 'gpt-image-2', effort: 'high' }, keepAiDebugArtifacts: false,
      }),
    });
    refresh(modelChanged);
    refresh(modelChanged);
    expect(refreshAndEvict).toHaveBeenCalledTimes(2);

    const qaScenarioChanged = identity({
      executionOptionsIdentity: JSON.stringify({
        provider: 'qa-fake', qaMode: 'provider-free', qaScenario: 'branch-one-failure',
        options: {}, keepAiDebugArtifacts: false,
      }),
    });
    refresh(qaScenarioChanged);
    refresh(qaScenarioChanged);
    expect(refreshAndEvict).toHaveBeenCalledTimes(3);
  });

  it('does not refresh again when transient Review verification state writes without context changes', () => {
    const gate = new WorkflowReviewRefreshGate();
    const context = identity();
    expect(gate.shouldRefresh(context)).toBe(true);
    // reviewVerifications is intentionally not part of the material/context identity.
    expect(gate.shouldRefresh(context)).toBe(false);
  });

  it('serializes reopen verification and converges to the latest incremental asset snapshot', async () => {
    const states: Array<{ status: string; identity: string | null }> = [];
    const coordinator = new WorkflowReviewVerificationCoordinator(
      (state) => states.push({ status: state.status, identity: state.identity }),
      1_000,
    );
    let finishInitial!: () => void;
    const initial = new Promise<void>((resolve) => { finishInitial = resolve; });
    let finishStable!: () => void;
    const stable = new Promise<void>((resolve) => { finishStable = resolve; });
    const calls: string[] = [];

    coordinator.request('reopen-assets-partial', async () => {
      calls.push('partial');
      await initial;
    });
    coordinator.request('reopen-assets-stable', async () => {
      calls.push('stable');
      await stable;
    });
    expect(calls).toEqual(['partial']);

    finishInitial();
    await vi.waitFor(() => expect(calls).toEqual(['partial', 'stable']));
    finishStable();
    await coordinator.settled();

    expect(coordinator.state).toMatchObject({
      status: 'ready', identity: 'reopen-assets-stable', canRetry: false,
    });
    expect(states.at(-1)).toEqual({ status: 'ready', identity: 'reopen-assets-stable' });
  });

  it('surfaces terminal verification failure and retries the same stable snapshot', async () => {
    const coordinator = new WorkflowReviewVerificationCoordinator(() => undefined, 1_000);
    let attempts = 0;
    coordinator.request('stable-assets', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Promoted output hash does not match the project asset.');
    });
    await coordinator.settled();

    expect(coordinator.state).toMatchObject({
      status: 'failed', identity: 'stable-assets', canRetry: true,
    });
    expect(coordinator.state.message).toMatch(/hash does not match/i);

    coordinator.retry();
    await coordinator.settled();
    expect(attempts).toBe(2);
    expect(coordinator.state).toMatchObject({ status: 'ready', identity: 'stable-assets' });
  });

  it('bounds a hung verification and exposes a retry action', async () => {
    const coordinator = new WorkflowReviewVerificationCoordinator(() => undefined, 20);
    coordinator.request('hung-assets', () => new Promise<void>(() => undefined));
    await coordinator.settled();

    expect(coordinator.state).toMatchObject({
      status: 'failed', identity: 'hung-assets', canRetry: true,
    });
    expect(coordinator.state.message).toMatch(/timed out/i);
  });

  it('treats an external refresh supersession as convergence instead of terminal failure', async () => {
    const states: WorkflowReviewVerificationState[] = [];
    const coordinator = new WorkflowReviewVerificationCoordinator(
      (state) => states.push({ ...state }),
      1_000,
    );
    coordinator.request('shared-assets', async () => {
      throw new Error('Review verification was superseded by newer execution options.');
    });
    await coordinator.settled();

    expect(coordinator.state).toMatchObject({
      status: 'idle', identity: 'shared-assets', canRetry: false,
    });
    expect(states.some((state) => state.status === 'failed')).toBe(false);
  });

  it('retries manual refresh only when no newer verification request started', () => {
    const failed: WorkflowReviewVerificationState = {
      status: 'failed', identity: 'assets-one', message: 'failed', canRetry: true,
    };
    expect(shouldRetryReviewVerificationAfterRefresh(failed, failed)).toBe(true);
    expect(shouldRetryReviewVerificationAfterRefresh(failed, {
      status: 'verifying', identity: 'assets-two', message: 'verifying', canRetry: false,
    })).toBe(false);
    expect(shouldRetryReviewVerificationAfterRefresh(failed, {
      status: 'ready', identity: 'assets-two', message: 'ready', canRetry: false,
    })).toBe(false);
  });

  it('converges a reopened promoted workflow after incremental assets supersede verification', async () => {
    const productBytes = new Uint8Array([137, 80, 78, 71, 1]);
    const product: ProjectAsset = {
      id: 'product', kind: 'imported', name: 'Product.png', relativePath: 'assets/product.png',
      createdAt: 1, exists: true, width: 1024, height: 1024, mime: 'image/png',
    };
    const assets: ProjectAsset[] = [product];
    const bytesByAssetId = new Map<string, Uint8Array>([[product.id, productBytes]]);
    let assetSequence = 0;
    const executor = createWorkflowCompositionExecutor('codex', async (request) => ({
      kind: 'bytes', name: `${request.nodeId}.png`,
      bytes: new Uint8Array([137, 80, 78, 71, assetSequence + 2]),
      mime: 'image/png', width: request.output.width, height: request.output.height,
    }));
    const options = (snapshot: ProjectAsset[], tamper = false): WorkflowStoreRunOptions => ({
      projectPath: '/project',
      currentProjectIdentity: () => 'project-one',
      provider: 'codex',
      executors: [executor],
      assets: snapshot,
      resolveAsset: vi.fn(async (asset) => {
        const bytes = bytesByAssetId.get(asset.id);
        if (!bytes) throw new Error(`Missing bytes for ${asset.id}`);
        const material = tamper && asset.id !== product.id
          ? new Uint8Array([...bytes, 255])
          : new Uint8Array(bytes);
        return {
          assetId: asset.id, relativePath: asset.relativePath,
          bytes: material, contentHash: workflowSha256Bytes(material),
        };
      }),
      storeAsset: vi.fn(async (artifact) => {
        const stored: ProjectAsset = {
          id: `generated-${++assetSequence}`, kind: 'generated', name: artifact.name,
          relativePath: `assets/generated/${assetSequence}.png`, createdAt: assetSequence + 1,
          exists: true, width: artifact.width, height: artifact.height, mime: artifact.mime,
        };
        assets.push(stored);
        bytesByAssetId.set(stored.id, new Uint8Array(artifact.bytes));
        return stored;
      }),
    });

    const original = new WorkflowStore();
    original.newFromTemplate('campaign-composer', 'Review convergence');
    original.assignAsset('slot-product', product);
    const branches = await original.runCandidateBranches('output-square', options(assets), {
      branchGroupId: 'reopen-branches', count: 2, maxConcurrency: 1,
    });
    await original.promoteCandidate(
      'review-campaign-direction', branches.group.candidates[0].candidateId, options(assets),
    );

    const reopened = new WorkflowStore();
    reopened.openFromBytes(original.toBytes(), 'documents/reopen.cxflow.json', 'Reopened');
    const partialAssets = [product];
    let releasePartial!: () => void;
    const partialGate = new Promise<void>((resolve) => { releasePartial = resolve; });
    const coordinator = new WorkflowReviewVerificationCoordinator(() => undefined, 1_000);
    coordinator.request('reopen-partial-assets', async () => {
      await partialGate;
      await reopened.refreshReviewState('review-campaign-direction', options(partialAssets));
    });
    coordinator.request('reopen-stable-assets', async () => {
      await reopened.refreshReviewState('review-campaign-direction', options([...assets]));
    });
    releasePartial();
    await coordinator.settled();

    expect(coordinator.state).toMatchObject({ status: 'ready', identity: 'reopen-stable-assets' });
    expect(reopened.reviewResolution(
      'review-campaign-direction', assets, true, 'project-one',
    )).toMatchObject({ state: 'ready' });

    coordinator.request('reopen-tampered-assets', async () => {
      await reopened.refreshReviewState('review-campaign-direction', options([...assets], true));
    });
    await coordinator.settled();
    expect(reopened.reviewResolution(
      'review-campaign-direction', assets, true, 'project-one',
    )).toMatchObject({
      state: 'blocked', reason: { code: 'PROMOTED_OUTPUT_UNAVAILABLE' },
    });
  });
});
