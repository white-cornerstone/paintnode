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
    expect(workflow.candidateBranchGroups()).toEqual([]);
  });
});
