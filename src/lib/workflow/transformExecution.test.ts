import { describe, expect, it, vi } from 'vitest';
import { parseWorkflowGraphV2, serializeWorkflowGraphV2 } from './schema';
import { instantiateWorkflowTemplate } from './templates';
import {
  createWorkflowCompositionExecutor,
  executeCampaignGenerateTransform,
  WorkflowTransformExecutionError,
  type WorkflowProjectAsset,
  type WorkflowTransformExecutionRequest,
} from './transformExecutor';
import { isFullWorkflowRunRecord, workflowSha256Bytes } from './provenance';

const material = (
  bytes: Uint8Array,
  assetId = 'asset-product',
  relativePath = 'assets/Product.png',
) => ({ assetId, relativePath, bytes, contentHash: workflowSha256Bytes(bytes) });

const productAsset: WorkflowProjectAsset = {
  id: 'asset-product',
  name: 'Product.png',
  relativePath: 'assets/Product.png',
  width: 1200,
  height: 1200,
  mime: 'image/png',
};

function boundCampaign() {
  const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer', {
    graphId: 'campaign-transform-test',
  }));
  const product = graph.nodes.find((node) => node.id === 'slot-product')!;
  product.config = { ...product.config, assetId: productAsset.id, relativePath: productAsset.relativePath };
  return graph;
}

describe('Campaign Composer Generate Transform execution', () => {
  it('plans, materializes, executes, stores, binds, and reopens through injected provider-free contracts', async () => {
    const graph = boundCampaign();
    graph.nodes.find((node) => node.id === 'transform-generate-square')!.config.advanced = {
      provider: null,
      model: 'persisted-model',
      options: { quality: 'high' },
    };
    const seen: WorkflowTransformExecutionRequest[] = [];
    const resolveAsset = vi.fn(async () => material(new Uint8Array([137, 80, 78, 71])));
    const storeAsset = vi.fn(async () => ({
      id: 'asset-square-result',
      name: 'campaign-square.png',
      relativePath: 'generated/campaign-square.png',
      width: 1024,
      height: 1024,
      mime: 'image/png',
    } satisfies WorkflowProjectAsset));
    const executor = createWorkflowCompositionExecutor('fake', async (request) => {
      seen.push(request);
      return {
        kind: 'bytes',
        name: 'campaign-square.png',
        bytes: new Uint8Array([1, 2, 3, 4]),
        mime: 'image/png',
        width: 1024,
        height: 1024,
      };
    });

    const result = await executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'fake',
      executors: [executor],
      assets: [productAsset],
      resolveAsset,
      storeAsset,
      idGenerator: () => 'asset-ref-square-result',
      runIdGenerator: () => 'run-square-1',
      clock: (() => { let now = 100; return () => now += 10; })(),
    });

    expect(result.plan.executionOrder).toEqual([
      'slot-product', 'slot-subject', 'slot-style', 'brief', 'composition', 'transform-generate-square', 'output-square',
    ]);
    expect(result.plan.batches).toEqual([
      ['slot-product', 'slot-subject', 'slot-style', 'brief'],
      ['composition'],
      ['transform-generate-square'],
      ['output-square'],
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      nodeId: 'transform-generate-square',
      capability: 'generate',
      provider: 'fake',
      projectPath: '/virtual/project',
      brief: 'Build a cohesive campaign family around the product for multiple publishing formats.',
      artDirection: 'Keep product identity and brand cues consistent across every output while adapting the composition to each format.',
      transform: {
        capability: 'generate',
        advanced: { provider: null, model: 'persisted-model', options: { quality: 'high' } },
      },
      output: { nodeId: 'output-square', width: 1024, height: 1024 },
      sources: [{ nodeId: 'slot-product', assetId: 'asset-product', relativePath: 'assets/Product.png' }],
    });
    expect(seen[0].prompt).toContain('Build a cohesive campaign family');
    expect(seen[0].prompt).toContain('Keep product identity');
    expect(seen[0].prompt).not.toMatch(/1024|\d+\s*x\s*\d+/i);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(Object.isFrozen(seen[0].output)).toBe(true);
    expect(Object.isFrozen(seen[0].sources)).toBe(true);
    expect(Object.isFrozen(seen[0].transform.advanced)).toBe(true);
    expect(Object.isFrozen(seen[0].transform.advanced.options)).toBe(true);
    expect(resolveAsset).toHaveBeenCalledTimes(1);
    expect(storeAsset).toHaveBeenCalledTimes(1);
    expect(result.asset).toEqual(expect.objectContaining({ id: 'asset-square-result' }));
    expect(result.graph.nodes.find((node) => node.id === 'transform-generate-square')?.config).toMatchObject({
      resultAssetId: 'asset-square-result',
      resultRelativePath: 'generated/campaign-square.png',
    });
    expect(result.graph.nodes.find((node) => node.id === 'output-square')?.config).toMatchObject({
      outputAssetId: 'asset-square-result',
      outputRelativePath: 'generated/campaign-square.png',
    });
    expect(result.graph.assetReferences).toContainEqual({
      id: 'asset-ref-square-result',
      role: 'output',
      assetId: 'asset-square-result',
      relativePath: 'generated/campaign-square.png',
    });
    expect(result.graph.nodes.find((node) => node.id === 'transform-generate-square')?.runRecordIds)
      .toEqual(['run-square-1']);
    expect(result.graph.runRecords).toEqual([
      expect.objectContaining({
        recordVersion: 1,
        id: 'run-square-1',
        nodeId: 'transform-generate-square',
        status: 'succeeded',
        attempt: 1,
        sourceAssets: [expect.objectContaining({
          name: 'Product', role: 'The product that must remain recognisable in every campaign output.',
          assetId: 'asset-product', contentHash: workflowSha256Bytes(new Uint8Array([137, 80, 78, 71])),
        })],
        target: { nodeId: 'output-square', title: 'Square 1:1', width: 1024, height: 1024 },
        provider: { id: 'fake', model: 'persisted-model', effectiveOptions: { quality: 'high' } },
        outputs: [expect.objectContaining({
          assetReferenceId: 'asset-ref-square-result', assetId: 'asset-square-result',
          contentHash: workflowSha256Bytes(new Uint8Array([1, 2, 3, 4])), acceptedAt: 120,
        })],
      }),
    ]);

    const serialized = serializeWorkflowGraphV2(result.graph);
    expect(parseWorkflowGraphV2(JSON.parse(serialized))).toMatchObject({ ok: true, value: result.graph });
  });

  it('appends a failed attempt without deleting an earlier accepted result', async () => {
    const first = await executeCampaignGenerateTransform(boundCampaign(), 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => ({
        kind: 'project-asset',
        asset: {
          id: 'accepted-square', name: 'accepted.png', relativePath: 'generated/accepted.png',
          width: 1024, height: 1024, mime: 'image/png',
        },
        bytes: new Uint8Array([10, 20, 30]),
      }))],
      assets: [productAsset], resolveAsset: async () => material(new Uint8Array([1])), storeAsset: vi.fn(),
      idGenerator: () => 'accepted-ref', runIdGenerator: () => 'run-success', clock: () => 100,
    });

    let failure: unknown;
    try {
      await executeCampaignGenerateTransform(first.graph, 'output-square', {
        projectPath: '/virtual/project', provider: 'fake',
        executors: [createWorkflowCompositionExecutor('fake', async () => { throw new Error('token=secret at /tmp/raw.jsonl'); })],
        assets: [productAsset], resolveAsset: async () => material(new Uint8Array([1])), storeAsset: vi.fn(),
        runIdGenerator: () => 'run-failed', clock: () => 200,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      failureGraph: {
        runRecords: [
          expect.objectContaining({ id: 'run-success', status: 'succeeded' }),
          expect.objectContaining({
            id: 'run-failed', status: 'failed', outputs: [],
            failure: { code: 'EXECUTOR_ERROR', message: 'The provider could not complete this attempt.' },
          }),
        ],
        assetReferences: [expect.objectContaining({ id: 'accepted-ref', assetId: 'accepted-square' })],
      },
    });
  });

  it('rejects legacy direct-output graphs without invoking an executor or injected IO', async () => {
    const graph = boundCampaign();
    graph.nodes = graph.nodes.filter((node) => node.id !== 'transform-generate-square');
    graph.edges = graph.edges.filter((edge) => !edge.id.includes('transform-generate-square'));
    graph.edges.push({
      id: 'legacy-direct-square',
      source: { nodeId: 'composition', portId: 'layout' },
      target: { nodeId: 'output-square', portId: 'source' },
    });
    const service = vi.fn();
    const resolveAsset = vi.fn();
    const storeAsset = vi.fn();
    await expect(executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', service)],
      assets: [productAsset],
      resolveAsset,
      storeAsset,
    })).rejects.toMatchObject({ code: 'INVALID_TRANSFORM_PATH' });
    expect(service).not.toHaveBeenCalled();
    expect(resolveAsset).not.toHaveBeenCalled();
    expect(storeAsset).not.toHaveBeenCalled();
  });

  it('rejects mismatched exact source material before invoking the provider', async () => {
    const service = vi.fn();
    await expect(executeCampaignGenerateTransform(boundCampaign(), 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', service)],
      assets: [productAsset],
      resolveAsset: async () => ({
        assetId: productAsset.id,
        relativePath: productAsset.relativePath,
        bytes: new Uint8Array([137, 80, 78, 71]),
        contentHash: `sha256:${'8'.repeat(64)}`,
      }),
      storeAsset: vi.fn(),
    })).rejects.toMatchObject({
      code: 'MISSING_ASSET',
      message: expect.stringMatching(/exact project material/i),
    });
    expect(service).not.toHaveBeenCalled();
  });

  it('records the current manifest path returned with the resolved source material', async () => {
    const requests: WorkflowTransformExecutionRequest[] = [];
    const service = vi.fn(async (request: Readonly<WorkflowTransformExecutionRequest>) => {
      requests.push(request as WorkflowTransformExecutionRequest);
      return {
        kind: 'project-asset' as const,
        asset: {
          id: 'canonical-result', name: 'Square.png', relativePath: 'generated/canonical.png',
          width: 1024, height: 1024, mime: 'image/png',
        },
        bytes: new Uint8Array([1, 2, 3]),
      };
    });
    const result = await executeCampaignGenerateTransform(boundCampaign(), 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', service)],
      assets: [productAsset],
      resolveAsset: async () => material(
        new Uint8Array([137, 80, 78, 71]),
        productAsset.id,
        'assets/renamed/Product.png',
      ),
      storeAsset: vi.fn(),
    });

    expect(requests[0]?.sources[0]).toMatchObject({
      assetId: productAsset.id,
      relativePath: 'assets/renamed/Product.png',
    });
    const recordedRun = result.graph.runRecords.at(-1);
    expect(isFullWorkflowRunRecord(recordedRun!)).toBe(true);
    if (!recordedRun || !isFullWorkflowRunRecord(recordedRun)) throw new Error('expected full run record');
    expect(recordedRun.sourceAssets[0]).toMatchObject({
      assetId: productAsset.id,
      relativePath: 'assets/renamed/Product.png',
    });
  });

  it('rejects a resolver remap to another asset ID before invoking the provider', async () => {
    const service = vi.fn();
    await expect(executeCampaignGenerateTransform(boundCampaign(), 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', service)],
      assets: [productAsset],
      resolveAsset: async () => material(
        new Uint8Array([137, 80, 78, 71]),
        'different-asset',
        productAsset.relativePath,
      ),
      storeAsset: vi.fn(),
    })).rejects.toMatchObject({ code: 'MISSING_ASSET' });
    expect(service).not.toHaveBeenCalled();
  });

  it('records cancellation and ignores a provider completion that arrives after abort', async () => {
    const controller = new AbortController();
    let finishProvider!: () => void;
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const gate = new Promise<void>((resolve) => { finishProvider = resolve; });
    const progress: Array<{ stage: string; message: string; runId: string; nodeId: string }> = [];
    const storeAsset = vi.fn();
    const service = vi.fn(async (_request, context) => {
      context.reportProgress({ stage: 'running', message: 'Provider working' });
      providerStarted();
      await gate;
      return {
        kind: 'bytes' as const,
        name: 'late.png',
        bytes: new Uint8Array([1, 2, 3]),
        mime: 'image/png',
        width: 1024,
        height: 1024,
      };
    });
    const operation = executeCampaignGenerateTransform(boundCampaign(), 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', service)],
      assets: [productAsset],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset,
      workflowSessionId: 'session-cancel',
      runIdGenerator: () => 'run-cancelled',
      signal: controller.signal,
      onProgress: (event) => progress.push(event),
      clock: (() => { let now = 100; return () => now += 10; })(),
    });
    void operation.catch(() => undefined);
    await started;
    controller.abort();

    let cancellation: WorkflowTransformExecutionError | null = null;
    try {
      await operation;
    } catch (error) {
      cancellation = error as WorkflowTransformExecutionError;
    }
    expect(cancellation).toMatchObject({ code: 'CANCELLED' });
    expect(cancellation?.failureGraph?.runRecords).toEqual([
      expect.objectContaining({
        id: 'run-cancelled', status: 'cancelled', outputs: [],
        failure: { code: 'CANCELLED', message: 'The attempt was cancelled.' },
      }),
    ]);
    expect(progress.map((event) => event.stage)).toEqual(['queued', 'running', 'running', 'cancelled']);
    expect(progress.every((event) => event.runId === 'run-cancelled'
      && event.nodeId === 'transform-generate-square')).toBe(true);

    finishProvider();
    await Promise.resolve();
    await Promise.resolve();
    expect(storeAsset).not.toHaveBeenCalled();
    expect(progress.at(-1)?.stage).toBe('cancelled');
  });

  it('links a retry to the latest failed attempt while preserving its history', async () => {
    let failedGraph = boundCampaign();
    try {
      await executeCampaignGenerateTransform(failedGraph, 'output-square', {
        projectPath: '/virtual/project', provider: 'fake',
        executors: [createWorkflowCompositionExecutor('fake', async () => { throw new Error('failed'); })],
        assets: [productAsset],
        resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
        storeAsset: vi.fn(),
        runIdGenerator: () => 'run-failed',
        clock: () => 100,
      });
    } catch (error) {
      failedGraph = (error as WorkflowTransformExecutionError).failureGraph!;
    }

    const result = await executeCampaignGenerateTransform(failedGraph, 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => ({
        kind: 'project-asset' as const,
        asset: {
          id: 'retry-result', name: 'Retry.png', relativePath: 'generated/retry.png',
          width: 1024, height: 1024, mime: 'image/png',
        },
        bytes: new Uint8Array([4, 5, 6]),
      }))],
      assets: [productAsset],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: vi.fn(),
      retryOfRunId: 'run-failed',
      runIdGenerator: () => 'run-retry',
      clock: () => 200,
    });

    expect(result.graph.runRecords).toHaveLength(2);
    expect(result.graph.runRecords[0]).toMatchObject({ id: 'run-failed', status: 'failed' });
    expect(result.graph.runRecords[1]).toMatchObject({
      id: 'run-retry', status: 'succeeded', retryOfRunId: 'run-failed',
    });
  });

  it('rejects malformed or wrong-sized results atomically and preserves an earlier output binding', async () => {
    const graph = boundCampaign();
    const square = graph.nodes.find((node) => node.id === 'output-square')!;
    square.config.outputAssetId = 'previous-square';
    square.config.outputRelativePath = 'generated/previous-square.png';
    const before = structuredClone(graph);
    const storeAsset = vi.fn();

    await expect(executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => ({
        kind: 'bytes',
        name: 'wrong.png',
        bytes: new Uint8Array([1]),
        mime: 'image/png',
        width: 1024,
        height: 768,
      }))],
      assets: [productAsset],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset,
    })).rejects.toMatchObject({ code: 'INVALID_EXECUTOR_RESULT' });

    expect(storeAsset).not.toHaveBeenCalled();
    expect(graph).toEqual(before);
    expect(square.config).toMatchObject({
      outputAssetId: 'previous-square',
      outputRelativePath: 'generated/previous-square.png',
    });

    const mismatchStore = vi.fn();
    await expect(executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => ({
        kind: 'bytes', name: 'mismatch.png', bytes: new Uint8Array([1, 2, 3, 4]),
        mime: 'image/png', width: 1024, height: 1024, contentHash: `sha256:${'9'.repeat(64)}`,
      }))],
      assets: [productAsset], resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: mismatchStore,
    })).rejects.toMatchObject({
      code: 'INVALID_EXECUTOR_RESULT',
      message: 'The generated result did not satisfy the output requirements.',
      failureGraph: {
        runRecords: [expect.objectContaining({
          status: 'failed', failure: {
            code: 'INVALID_EXECUTOR_RESULT',
            message: 'The generated result did not satisfy the output requirements.',
          },
        })],
      },
    });
    expect(mismatchStore).not.toHaveBeenCalled();
    expect(graph).toEqual(before);
  });

  it('does not reach global network APIs on the pure fake executor path', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      await executeCampaignGenerateTransform(boundCampaign(), 'output-square', {
        projectPath: '/virtual/project',
        provider: 'fake',
        executors: [createWorkflowCompositionExecutor('fake', async () => ({
          kind: 'project-asset',
          asset: {
            id: 'fake-square', name: 'square.png', relativePath: 'generated/square.png',
            width: 1024, height: 1024, mime: 'image/png',
          },
          bytes: new Uint8Array([4, 5, 6]),
        }))],
        assets: [productAsset],
        resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
        storeAsset: vi.fn(),
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('converts unsafe returned asset metadata into a durable sanitized failure', async () => {
    for (const [kind, executor, storeAsset] of [
      [
        'project-asset',
        createWorkflowCompositionExecutor('fake', async () => ({
          kind: 'project-asset',
          asset: {
            id: '../unsafe-result', name: 'unsafe.png', relativePath: 'generated/unsafe.png',
            width: 1024, height: 1024, mime: 'image/png',
          },
          bytes: new Uint8Array([1, 2, 3]),
        })),
        vi.fn(),
      ],
      [
        'stored-bytes',
        createWorkflowCompositionExecutor('fake', async () => ({
          kind: 'bytes', name: 'stored.png', bytes: new Uint8Array([4, 5, 6]),
          mime: 'image/png', width: 1024, height: 1024,
        })),
        vi.fn(async () => ({
          id: 'unsafe-stored', name: 'stored.png', relativePath: '../outside-stored.png',
          width: 1024, height: 1024, mime: 'image/png',
        })),
      ],
    ] as const) {
      let failure: unknown;
      try {
        await executeCampaignGenerateTransform(boundCampaign(), 'output-square', {
          projectPath: '/virtual/project', provider: 'fake', executors: [executor],
          assets: [productAsset],
          resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
          storeAsset,
          runIdGenerator: () => `run-unsafe-${kind}`,
          idGenerator: () => `ref-unsafe-${kind}`,
          clock: () => 100,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: 'INVALID_EXECUTOR_RESULT',
        message: 'The generated result did not satisfy the output requirements.',
        failureGraph: {
          runRecords: [expect.objectContaining({
            id: `run-unsafe-${kind}`, status: 'failed', outputs: [],
            failure: {
              code: 'INVALID_EXECUTOR_RESULT',
              message: 'The generated result did not satisfy the output requirements.',
            },
          })],
        },
      });
    }
  });

  it('rejects run and output-reference collisions before invoking the provider', async () => {
    const first = await executeCampaignGenerateTransform(boundCampaign(), 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => ({
        kind: 'project-asset',
        asset: {
          id: 'collision-output', name: 'collision.png', relativePath: 'generated/collision.png',
          width: 1024, height: 1024, mime: 'image/png',
        },
        bytes: new Uint8Array([1, 2, 3]),
      }))],
      assets: [productAsset],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: vi.fn(), runIdGenerator: () => 'run-collision', idGenerator: () => 'ref-collision',
    });
    const provider = vi.fn();
    await expect(executeCampaignGenerateTransform(first.graph, 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', provider)],
      assets: [productAsset],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: vi.fn(), runIdGenerator: () => 'run-collision', idGenerator: () => 'ref-next',
    })).rejects.toMatchObject({ message: expect.stringMatching(/run ID collides/i) });
    await expect(executeCampaignGenerateTransform(first.graph, 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', provider)],
      assets: [productAsset],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: vi.fn(), runIdGenerator: () => 'run-next', idGenerator: () => 'ref-collision',
    })).rejects.toMatchObject({ message: expect.stringMatching(/output reference collides/i) });
    expect(provider).not.toHaveBeenCalled();

    const duplicateAssetProvider = vi.fn(async () => ({
      kind: 'project-asset' as const,
      asset: {
        id: 'collision-output', name: 'duplicate.png', relativePath: 'generated/duplicate.png',
        width: 1024, height: 1024, mime: 'image/png',
      },
      bytes: new Uint8Array([8, 8, 8]),
    }));
    await expect(executeCampaignGenerateTransform(first.graph, 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', duplicateAssetProvider)],
      assets: [productAsset],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: vi.fn(), runIdGenerator: () => 'run-duplicate-asset', idGenerator: () => 'ref-duplicate-asset',
    })).rejects.toMatchObject({
      code: 'INVALID_EXECUTOR_RESULT',
      failureGraph: {
        runRecords: [
          expect.objectContaining({ id: 'run-collision', status: 'succeeded' }),
          expect.objectContaining({ id: 'run-duplicate-asset', status: 'failed' }),
        ],
      },
    });
    expect(duplicateAssetProvider).toHaveBeenCalledOnce();
  });

  it('materializes persisted storyboard intent and placement constraints through an injected boundary', async () => {
    const graph = boundCampaign();
    const composition = graph.nodes.find((node) => node.id === 'composition')!;
    composition.config = {
      ...composition.config,
      storyboardDataUrl: 'data:image/png;base64,c3Rvcnlib2FyZA==',
      storyboardWidth: 1440,
      storyboardHeight: 900,
      storyboardOraPath: 'storyboards/campaign.ora',
      storyboardAnnotations: ['at 20% x, 35% y (subject): keep the product left'],
      storyboardAnnotationItems: [{ id: 'note-1', x: 0.2, y: 0.35, text: 'Keep the product left' }],
      storyboardAnnotationsVisible: true,
    };
    const readStoryboard = vi.fn(async () => ({
      bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      relativePath: 'storyboards/embedded-composition.png',
    }));
    let seen!: WorkflowTransformExecutionRequest;
    const outcome = await executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async (request) => {
        seen = request;
        return {
          kind: 'project-asset',
          asset: {
            id: 'storyboard-result', name: 'square.png', relativePath: 'generated/square.png',
            width: 1024, height: 1024, mime: 'image/png',
          },
          bytes: new Uint8Array([7, 8, 9]),
        };
      })],
      assets: [productAsset],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      readStoryboard,
      storeAsset: vi.fn(),
    });

    expect(readStoryboard).toHaveBeenCalledWith(expect.objectContaining({
      dataUrl: 'data:image/png;base64,c3Rvcnlib2FyZA==',
      oraPath: 'storyboards/campaign.ora',
      width: 1440,
      height: 900,
    }));
    expect(seen.storyboard).toMatchObject({
      dataUrl: 'data:image/png;base64,c3Rvcnlib2FyZA==',
      oraPath: 'storyboards/campaign.ora',
      annotations: ['at 20% x, 35% y (subject): keep the product left'],
      annotationItems: [{ id: 'note-1', x: 0.2, y: 0.35, text: 'Keep the product left' }],
      source: {
        name: 'Storyboard sketch - mandatory layout guide',
        bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      },
    });
    expect(seen.storyboard?.placementConstraints).toEqual(expect.arrayContaining([
      expect.stringMatching(/primary spatial plan/i),
      'at 20% x, 35% y (subject): keep the product left',
    ]));
    expect(seen.prompt).toMatch(/primary spatial plan/i);
    expect(seen.prompt).toContain('keep the product left');
    expect(seen.prompt).not.toMatch(/1440|900/);
    expect(outcome.graph.runRecords[0]).toMatchObject({
      sourceAssets: expect.arrayContaining([expect.objectContaining({
        nodeId: 'composition', assetId: 'storyboard-composition',
        relativePath: 'storyboards/embedded-composition.png',
        contentHash: workflowSha256Bytes(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])),
      })]),
    });

    const changedStoryboard = await executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => ({
        kind: 'project-asset',
        asset: {
          id: 'storyboard-result-2', name: 'square-2.png', relativePath: 'generated/square-2.png',
          width: 1024, height: 1024, mime: 'image/png',
        },
        bytes: new Uint8Array([12, 13, 14]),
      }))],
      assets: [productAsset],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      readStoryboard: async () => ({
        bytes: new Uint8Array([137, 80, 78, 71, 99, 98, 97, 96]),
        relativePath: 'storyboards/embedded-composition.png',
      }),
      storeAsset: vi.fn(),
      runIdGenerator: () => 'run-storyboard-changed',
    });
    const originalRun = outcome.graph.runRecords.find(isFullWorkflowRunRecord)!;
    const changedRun = changedStoryboard.graph.runRecords.find(isFullWorkflowRunRecord)!;
    expect(changedRun.sourceAssets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        relativePath: 'storyboards/embedded-composition.png',
        contentHash: workflowSha256Bytes(new Uint8Array([137, 80, 78, 71, 99, 98, 97, 96])),
      }),
    ]));
    expect(changedRun.materialKey).not.toBe(originalRun.materialKey);
  });

  it('explains missing-project and unsupported-provider actions before any injected side effect', async () => {
    const graph = boundCampaign();
    const resolveAsset = vi.fn();
    const storeAsset = vi.fn();
    const executor = createWorkflowCompositionExecutor('fake', vi.fn());

    await expect(executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: null,
      provider: 'fake',
      executors: [executor],
      assets: [productAsset],
      resolveAsset,
      storeAsset,
    })).rejects.toMatchObject({
      code: 'MISSING_PROJECT',
      nextAction: 'Choose or create a project folder',
    } satisfies Partial<WorkflowTransformExecutionError>);

    await expect(executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'unknown-provider',
      executors: [executor],
      assets: [productAsset],
      resolveAsset,
      storeAsset,
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER',
      nextAction: 'Choose a supported image provider',
    } satisfies Partial<WorkflowTransformExecutionError>);
    expect(resolveAsset).not.toHaveBeenCalled();
    expect(storeAsset).not.toHaveBeenCalled();
  });

  it('honours a persisted Transform provider instead of silently overwriting it with UI settings', async () => {
    const graph = boundCampaign();
    graph.nodes.find((node) => node.id === 'transform-generate-square')!.config.advanced = {
      provider: 'persisted-provider', model: 'persisted-model',
    };
    const service = vi.fn();
    const resolveAsset = vi.fn();
    await expect(executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', service)],
      assets: [productAsset],
      resolveAsset,
      storeAsset: vi.fn(),
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER',
      message: expect.stringMatching(/persisted-provider/),
    });
    expect(service).not.toHaveBeenCalled();
    expect(resolveAsset).not.toHaveBeenCalled();
  });

  it('selects a saved Antigravity override exactly when the current UI default is Codex', async () => {
    const graph = boundCampaign();
    graph.nodes.find((node) => node.id === 'transform-generate-square')!.config.advanced = {
      provider: 'antigravity',
      model: 'gemini-3.1-flash-image',
      options: { imageSize: '2K', compressionQuality: 88 },
    };
    const codex = vi.fn();
    const antigravity = vi.fn(async () => ({
      kind: 'project-asset' as const,
      asset: {
        id: 'antigravity-square', name: 'square.png', relativePath: 'generated/square.png',
        width: 1024, height: 1024, mime: 'image/png',
      },
      bytes: new Uint8Array([11, 12, 13]),
    }));
    const outcome = await executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'codex',
      executors: [
        createWorkflowCompositionExecutor('codex', codex),
        createWorkflowCompositionExecutor('antigravity', antigravity),
      ],
      assets: [productAsset],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: vi.fn(),
    });

    expect(codex).not.toHaveBeenCalled();
    expect(antigravity).toHaveBeenCalledOnce();
    expect(outcome.request).toMatchObject({
      provider: 'antigravity',
      transform: {
        advanced: {
          provider: 'antigravity', model: 'gemini-3.1-flash-image',
          options: { imageSize: '2K', compressionQuality: 88 },
        },
      },
    });
  });
});
