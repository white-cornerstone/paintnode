import { describe, expect, it, vi } from 'vitest';
import type { ProjectAsset } from '../integrations/desktop';
import {
  createCreatorNode,
  createWorkflowCompositionExecutor,
  workflowSha256Bytes,
  type WorkflowGraphV2,
  type WorkflowTransformArtifact,
} from '../workflow';
import { WorkflowStore, type WorkflowStoreRunOptions } from './workflow.svelte';

const productBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const productAsset = {
  id: 'product-asset',
  kind: 'imported',
  name: 'Product.png',
  relativePath: 'assets/product.png',
  createdAt: 1,
  exists: true,
  width: 1200,
  height: 1200,
  mime: 'image/png',
} satisfies ProjectAsset;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function campaignStore(): WorkflowStore {
  const store = new WorkflowStore();
  store.newFromTemplate('campaign-composer', 'Selective campaign');
  store.assignAsset('slot-product', productAsset);
  return store;
}

function twoGenerateStore(): WorkflowStore {
  const seed = campaignStore();
  const graph = structuredClone(seed.serialize()) as WorkflowGraphV2;
  graph.nodes.push(
    createCreatorNode('transform', {
      id: 'transform-second', title: 'Generate Second',
      config: { capability: 'generate', instructions: 'Generate the second campaign output.' },
    }),
    createCreatorNode('output', {
      id: 'output-second', title: 'Second Output',
      config: { displayName: 'Second Output', finalWidth: 1024, finalHeight: 1024 },
    }),
  );
  graph.edges.push(
    {
      id: 'composition-transform-second',
      source: { nodeId: 'composition', portId: 'layout' },
      target: { nodeId: 'transform-second', portId: 'source' },
    },
    {
      id: 'transform-second-output-second',
      source: { nodeId: 'transform-second', portId: 'result' },
      target: { nodeId: 'output-second', portId: 'source' },
    },
  );
  const store = new WorkflowStore();
  store.openFromBytes(new TextEncoder().encode(JSON.stringify(graph)), null, 'Two Generate nodes');
  return store;
}

function harness() {
  let providerCalls = 0;
  let projectIdentity = '/virtual/project:a';
  let clock = 10;
  let sequence = 0;
  let currentProductBytes = productBytes;
  const generatedAssets: ProjectAsset[] = [];
  const generatedBytes = new Map<string, Uint8Array>();
  let execute = async (): Promise<WorkflowTransformArtifact> => {
    providerCalls += 1;
    const id = `generated-${providerCalls}`;
    const bytes = new Uint8Array([137, 80, 78, 71, providerCalls]);
    const asset: ProjectAsset = {
      id,
      kind: 'generated',
      name: `${id}.png`,
      relativePath: `generated/${id}.png`,
      createdAt: clock,
      exists: true,
      width: 1024,
      height: 1024,
      mime: 'image/png',
    };
    generatedAssets.push(asset);
    generatedBytes.set(asset.id, bytes);
    return { kind: 'project-asset', asset, bytes };
  };
  const executor = createWorkflowCompositionExecutor('fake', async () => execute());
  const resolveAsset = vi.fn(async (asset: Readonly<{ id: string; relativePath: string }>) => {
    const bytes = asset.id === productAsset.id ? currentProductBytes : generatedBytes.get(asset.id) ?? null;
    return {
      assetId: asset.id,
      relativePath: asset.relativePath,
      bytes,
      contentHash: bytes ? workflowSha256Bytes(bytes) : 'sha256:missing',
    };
  });
  const options = (): WorkflowStoreRunOptions => ({
    projectPath: '/virtual/project',
    currentProjectIdentity: () => projectIdentity,
    provider: 'fake',
    executors: [executor],
    assets: [productAsset, ...generatedAssets],
    resolveAsset,
    storeAsset: async () => { throw new Error('project-asset executor does not use storeAsset'); },
    idGenerator: () => `reference-${++sequence}`,
    runIdGenerator: (_nodeId, attempt) => `run-${++sequence}-${attempt}`,
    clock: () => ++clock,
  });
  return {
    options,
    resolveAsset,
    generatedAssets,
    providerCalls: () => providerCalls,
    setExecute(value: typeof execute) { execute = value; },
    switchProject() { projectIdentity = '/virtual/project:b'; },
    changeProductMaterial() { currentProductBytes = new Uint8Array([...productBytes, 99]); },
  };
}

async function seedAcceptedResult(store: WorkflowStore, run: ReturnType<typeof harness>): Promise<void> {
  await store.runCampaignGenerate('output-square', run.options());
  expect(run.generatedAssets).toHaveLength(1);
}

describe('WorkflowStore selective execution integration', () => {
  it('reuses an exact project-verified cache hit with zero provider calls and no history mutation', async () => {
    const store = campaignStore();
    const run = harness();
    await seedAcceptedResult(store, run);
    const callsAfterSeed = run.providerCalls();
    const acceptedGraph = structuredClone(store.graphSnapshot());

    const preflight = await store.preflightSelectiveExecution('run-node', 'output-square', run.options());
    const outcome = await store.runSelectiveExecution(preflight, run.options());

    expect(preflight.stateByNodeId['transform-generate-square']).toMatchObject({
      state: 'cached', willExecute: false, reason: { code: 'REUSABLE_RESULT' },
    });
    expect(outcome.cachedNodeIds).toEqual(['transform-generate-square']);
    expect(outcome.executedNodeIds).toEqual([]);
    expect(run.providerCalls()).toBe(callsAfterSeed);
    expect(run.resolveAsset).toHaveBeenCalledWith(expect.objectContaining({ id: 'generated-1' }));
    expect(store.graphSnapshot()).toEqual(acceptedGraph);
  });

  it('projects a changed prepared material key as stale without replacing accepted history', async () => {
    const store = campaignStore();
    const run = harness();
    await seedAcceptedResult(store, run);
    const acceptedRun = structuredClone(store.graphSnapshot().runRecords[0]);
    store.setBriefObjective('brief', 'A materially changed campaign objective.');

    const preflight = await store.preflightSelectiveExecution('run-node', 'output-square', run.options());

    expect(preflight.stateByNodeId['transform-generate-square']).toMatchObject({
      state: 'stale', willExecute: true, reason: { code: 'MATERIAL_CHANGED' },
    });
    expect(store.graphSnapshot().runRecords[0]).toEqual(acceptedRun);
  });

  it('returns an explicit blocked reason when Campaign Generate material cannot be prepared', async () => {
    const store = new WorkflowStore();
    store.newFromTemplate('campaign-composer', 'Blocked campaign');
    const run = harness();

    const preflight = await store.preflightSelectiveExecution('run-node', 'output-square', run.options());

    expect(preflight.stateByNodeId['transform-generate-square']).toMatchObject({
      state: 'blocked',
      willExecute: false,
      reason: expect.objectContaining({ code: 'NODE_DISABLED', message: expect.stringMatching(/Product|asset/i) }),
    });
    expect(run.providerCalls()).toBe(0);
  });

  it('runs this Output through the Campaign Generate store adapter only', async () => {
    const store = campaignStore();
    const run = harness();
    const preflight = await store.preflightSelectiveExecution('run-node', 'output-square', run.options());

    const outcome = await store.runSelectiveExecution(preflight, run.options());

    expect(preflight.plan.affectedNodeIds).toEqual(['output-square']);
    expect(preflight.plan.executionNodeIds).toEqual(['transform-generate-square']);
    expect(outcome.executedNodeIds).toEqual(['transform-generate-square']);
    expect(run.providerCalls()).toBe(1);
    expect(store.transformExecution('transform-generate-square').state).toBe('succeeded');
  });

  it('rejects changed prepared material before the provider is invoked', async () => {
    const store = campaignStore();
    const run = harness();
    const preflight = await store.preflightSelectiveExecution('run-node', 'output-square', run.options());
    run.changeProductMaterial();

    const outcome = await store.runSelectiveExecution(preflight, run.options());

    expect(run.providerCalls()).toBe(0);
    expect(outcome.failures['transform-generate-square']).toMatchObject({
      code: 'NOT_READY',
      message: expect.stringMatching(/material changed/i),
    });
    expect(store.graphSnapshot().runRecords).toEqual([]);
  });

  it('runs from Product through only the real reachable Campaign Generate capability', async () => {
    const store = campaignStore();
    const run = harness();
    const preflight = await store.preflightSelectiveExecution('run-from-here', 'slot-product', run.options());

    const outcome = await store.runSelectiveExecution(preflight, run.options());

    expect(preflight.plan.affectedNodeIds).toEqual([
      'slot-product', 'composition', 'transform-generate-square',
      'output-square', 'output-portrait', 'output-landscape',
    ]);
    expect(outcome.executedNodeIds).toEqual(['transform-generate-square']);
    expect(run.providerCalls()).toBe(1);
  });

  it('cancels forever-running material preflight before any provider starts', async () => {
    const store = campaignStore();
    const run = harness();
    run.resolveAsset.mockImplementation(() => new Promise(() => undefined));

    const preflight = store.preflightSelectiveExecution('run-node', 'output-square', run.options());
    await Promise.resolve();
    await expect(store.cancelSelectiveExecution()).resolves.toMatchObject({ disposition: 'terminated' });

    await expect(preflight).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(run.providerCalls()).toBe(0);
  });

  it('cancels a forever-running provider and prevents a second ready node from starting', async () => {
    const store = twoGenerateStore();
    const run = harness();
    let starts = 0;
    run.setExecute(async () => {
      starts += 1;
      return new Promise(() => undefined);
    });
    const cancelProvider = vi.fn(async () => ({ disposition: 'terminated' as const, message: 'Provider stopped.' }));
    const options = { ...run.options(), cancelExecution: cancelProvider };
    const preflight = await store.preflightSelectiveExecution('run-from-here', 'composition', options);

    const execution = store.runSelectiveExecution(preflight, options, { maxConcurrency: 1 });
    while (starts === 0) await Promise.resolve();
    await store.cancelSelectiveExecution();
    const outcome = await execution;

    expect(starts).toBe(1);
    expect(cancelProvider).toHaveBeenCalledTimes(1);
    expect(outcome.cancelledNodeIds).toEqual(expect.arrayContaining([
      'transform-generate-square', 'transform-second',
    ]));
  });

  it('serializes two Campaign Generate commits by default while leaving pure scheduler concurrency configurable', async () => {
    const store = twoGenerateStore();
    const run = harness();
    const preflight = await store.preflightSelectiveExecution('run-from-here', 'composition', run.options());

    const outcome = await store.runSelectiveExecution(preflight, run.options());

    expect(outcome.executedNodeIds).toEqual(['transform-generate-square', 'transform-second']);
    expect(outcome.failures).toEqual({});
    expect(run.providerCalls()).toBe(2);
    expect(store.graphSnapshot().nodes.find((node) => node.id === 'transform-generate-square')?.runRecordIds).toHaveLength(1);
    expect(store.graphSnapshot().nodes.find((node) => node.id === 'transform-second')?.runRecordIds).toHaveLength(1);
  });

  it('reports detached when any active provider cancellation is not confirmed', async () => {
    const store = campaignStore();
    const run = harness();
    let starts = 0;
    run.setExecute(async () => {
      starts += 1;
      return new Promise(() => undefined);
    });
    const cancelProvider = vi.fn(async () => ({
      disposition: 'detached' as const,
      message: 'Provider termination was not confirmed.',
    }));
    const options = { ...run.options(), cancelExecution: cancelProvider };
    const preflight = await store.preflightSelectiveExecution('run-node', 'output-square', options);
    const execution = store.runSelectiveExecution(preflight, options);
    while (starts === 0) await Promise.resolve();

    await expect(store.cancelSelectiveExecution()).resolves.toMatchObject({ disposition: 'detached' });
    await expect(execution).resolves.toMatchObject({ cancelledNodeIds: ['transform-generate-square'] });
  });

  it('does not commit selective results after workflow session or project switches', async () => {
    const sessionStore = campaignStore();
    const sessionRun = harness();
    const sessionGate = deferred<WorkflowTransformArtifact>();
    sessionRun.setExecute(async () => sessionGate.promise);
    const sessionPreflight = await sessionStore.preflightSelectiveExecution('run-node', 'output-square', sessionRun.options());
    const sessionExecution = sessionStore.runSelectiveExecution(sessionPreflight, sessionRun.options());
    await Promise.resolve();
    sessionStore.newFromTemplate('campaign-composer', 'Replacement session');
    await expect(sessionExecution).resolves.toMatchObject({ cancelledNodeIds: ['transform-generate-square'] });
    expect(sessionStore.graphSnapshot().runRecords).toEqual([]);

    const projectStore = campaignStore();
    const projectRun = harness();
    const projectGate = deferred<WorkflowTransformArtifact>();
    projectRun.setExecute(async () => projectGate.promise);
    const projectPreflight = await projectStore.preflightSelectiveExecution('run-node', 'output-square', projectRun.options());
    const projectExecution = projectStore.runSelectiveExecution(projectPreflight, projectRun.options());
    await Promise.resolve();
    projectRun.switchProject();
    projectGate.resolve({
      kind: 'project-asset',
      asset: { id: 'late', name: 'Late.png', relativePath: 'generated/Late.png', width: 1024, height: 1024, mime: 'image/png' },
      bytes: new Uint8Array([137, 80, 78, 71, 9]),
    });
    const projectOutcome = await projectExecution;

    expect(projectOutcome.failures['transform-generate-square']).toBeDefined();
    expect(projectStore.graphSnapshot().runRecords).toEqual([]);
  });
});
