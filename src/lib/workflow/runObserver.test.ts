import { describe, expect, it, vi } from 'vitest';
import { WorkflowStore } from '../state/workflow.svelte';
import { createWorkflowCompositionExecutor, type WorkflowProjectAsset } from './transformExecutor';
import { runWithAsyncObserver } from './runObserver';

const product = {
  id: 'product',
  name: 'Product.png',
  relativePath: 'assets/Product.png',
  width: 1200,
  height: 1200,
  mime: 'image/png',
} satisfies WorkflowProjectAsset;

function campaignStore(): WorkflowStore {
  const store = new WorkflowStore();
  store.newFromTemplate('campaign-composer', 'Original campaign');
  store.assignAsset('slot-product', {
    ...product, kind: 'imported', createdAt: 1, exists: true,
  });
  return store;
}

describe('workflow async observer orchestration', () => {
  it('invokes the run synchronously before awaiting observer registration and disposes it afterward', async () => {
    let finishRegistration!: (dispose: () => void) => void;
    const registration = new Promise<() => void>((resolve) => { finishRegistration = resolve; });
    const dispose = vi.fn();
    const run = vi.fn(async () => 'done');

    const result = runWithAsyncObserver({ register: () => registration, run });
    expect(run).toHaveBeenCalledOnce();
    finishRegistration(dispose);

    await expect(result).resolves.toBe('done');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each(['workflow', 'project'] as const)(
    'keeps the original snapshot when %s changes before a deferred observer resolves',
    async (change) => {
      const store = campaignStore();
      let projectIdentity = 'project-a:/virtual/project';
      let finishRegistration!: (dispose: () => void) => void;
      const registration = new Promise<() => void>((resolve) => { finishRegistration = resolve; });
      const dispose = vi.fn();
      let finishProvider!: () => void;
      const providerGate = new Promise<void>((resolve) => { finishProvider = resolve; });
      const provider = vi.fn(async (request) => {
        await providerGate;
        return {
          kind: 'project-asset' as const,
          asset: {
            id: 'original-result', name: 'Square.png', relativePath: 'generated/original-square.png',
            width: 1024, height: 1024, mime: 'image/png',
          },
        };
      });

      const operation = runWithAsyncObserver({
        register: () => registration,
        run: () => store.runCampaignGenerate('output-square', {
          projectPath: '/virtual/project',
          currentProjectIdentity: () => projectIdentity,
          provider: 'fake',
          executors: [createWorkflowCompositionExecutor('fake', provider)],
          assets: [product],
          readAsset: async () => new Uint8Array([137, 80, 78, 71]),
          storeAsset: async () => { throw new Error('unused'); },
        }),
      });

      if (change === 'workflow') store.newFromTemplate('campaign-composer', 'Replacement campaign');
      else projectIdentity = 'project-b:/other/project';
      finishRegistration(dispose);
      finishProvider();
      const outcome = await operation;
      const flashSuccess = vi.fn();
      if (outcome.committed) flashSuccess();

      expect(provider).toHaveBeenCalledOnce();
      expect(provider.mock.calls[0][0]).toMatchObject({
        workflowId: expect.any(String),
        brief: 'Build a cohesive campaign family around the product for multiple publishing formats.',
      });
      expect(outcome.committed).toBe(false);
      expect(outcome.commitMessage).toMatch(change === 'workflow' ? /session changed/i : /project changed/i);
      expect(store.outputNode('output-square')?.outputAssetId).toBeNull();
      expect(flashSuccess).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      if (change === 'workflow') expect(store.name).toBe('Replacement campaign');
    },
  );
});
