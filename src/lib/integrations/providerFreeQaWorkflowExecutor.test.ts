import { describe, expect, it, vi } from 'vitest';
import type { WorkflowTransformExecutionRequest } from '../workflow/transformExecutor';
import { executeCampaignGenerateTransform } from '../workflow/transformExecutor';
import { parseWorkflowGraphV2, serializeWorkflowGraphV2 } from '../workflow/schema';
import { instantiateWorkflowTemplate } from '../workflow/templates';
import { createProviderFreeQaWorkflowExecutor } from './providerFreeQaWorkflowExecutor';

function request(): WorkflowTransformExecutionRequest {
  return {
    workflowId: 'qa-workflow',
    nodeId: 'transform-generate-square',
    capability: 'generate',
    provider: 'qa-fake',
    projectPath: '/virtual/project',
    brief: 'Provider-free QA campaign',
    artDirection: 'Keep the product recognisable',
    transform: { capability: 'generate', instructions: 'Generate Square', advanced: {} },
    prompt: 'Provider-free QA campaign',
    sources: [],
    storyboard: null,
    output: { nodeId: 'output-square', title: 'Square 1:1', width: 1024, height: 1024 },
  };
}

describe('provider-free QA workflow executor', () => {
  it.each([null, 'provider-e2e'] as const)('cannot be created outside provider-free mode: %s', (mode) => {
    const loadPng = vi.fn();
    expect(() => createProviderFreeQaWorkflowExecutor(mode, loadPng)).toThrow(/provider-free QA mode/i);
    expect(loadPng).not.toHaveBeenCalled();
  });

  it('returns deterministic square bytes without provider, auth, picker, network, or filesystem calls', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const loadPng = vi.fn(async () => new Uint8Array(png));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const executor = createProviderFreeQaWorkflowExecutor('provider-free', loadPng);
      const first = await executor.execute(request());
      const second = await executor.execute(request());

      expect(executor).toMatchObject({ provider: 'qa-fake', capabilities: ['generate'] });
      expect(first).toEqual({
        kind: 'bytes',
        name: 'paintnode-provider-free-qa-square.png',
        bytes: png,
        mime: 'image/png',
        width: 1024,
        height: 1024,
      });
      expect(second).toEqual(first);
      expect(loadPng).toHaveBeenCalledTimes(2);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('offers a cancellable slow scenario for native progress and cancellation QA', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const loadPng = vi.fn(async () => new Uint8Array(png));
    const controller = new AbortController();
    const progress: string[] = [];
    const executor = createProviderFreeQaWorkflowExecutor('provider-free', loadPng, {
      scenario: 'slow-success',
      progressSteps: 4,
      stepDelayMs: 5,
    });

    const operation = executor.execute(request(), {
      identity: {
        workflowSessionId: 'qa-session', workflowId: 'qa-workflow', runId: 'qa-run', nodeId: 'transform-generate-square',
      },
      signal: controller.signal,
      reportProgress: (event) => {
        progress.push(event.message);
        if (progress.length === 1) controller.abort();
      },
    });

    await expect(operation).rejects.toThrow(/cancelled/i);
    expect(progress[0]).toMatch(/slow provider-free QA/i);
    expect(loadPng).not.toHaveBeenCalled();
  });

  it('completes the slow scenario with bounded structured progress when it is not cancelled', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const progress: Array<{ message: string; completed?: number; total?: number }> = [];
    const executor = createProviderFreeQaWorkflowExecutor('provider-free', async () => png, {
      scenario: 'slow-success',
      progressSteps: 2,
      stepDelayMs: 1,
    });

    await expect(executor.execute(request(), {
      identity: {
        workflowSessionId: 'qa-session', workflowId: 'qa-workflow', runId: 'qa-run', nodeId: 'transform-generate-square',
      },
      reportProgress: (event) => progress.push({ ...event }),
    })).resolves.toMatchObject({ kind: 'bytes', bytes: png });
    expect(progress).toEqual([
      { message: 'Slow provider-free QA 1 of 2', completed: 0, total: 2 },
      { message: 'Slow provider-free QA 2 of 2', completed: 1, total: 2 },
    ]);
  });

  it('offers an actionable fixed failure without loading provider output bytes', async () => {
    const loadPng = vi.fn();
    const executor = createProviderFreeQaWorkflowExecutor('provider-free', loadPng, {
      scenario: 'failure',
    });

    await expect(executor.execute(request())).rejects.toThrow(
      'QA Fake simulated a provider failure. Review the workflow inputs, then retry Generate.',
    );
    expect(loadPng).not.toHaveBeenCalled();
    expect(executor.describeRun(request())).toEqual({
      id: 'qa-fake', model: null, effectiveOptions: { fixture: 'square' },
    });
  });

  it('fails only candidate two attempt one for branch retry QA', async () => {
    const loadPng = vi.fn(async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const executor = createProviderFreeQaWorkflowExecutor('provider-free', loadPng, {
      scenario: 'branch-one-failure',
    });
    const context = (runId: string) => ({
      identity: {
        workflowSessionId: 'qa-session', workflowId: 'qa-workflow', runId,
        nodeId: 'transform-generate-square',
      },
      reportProgress: vi.fn(),
    });

    await expect(executor.execute(
      request(), context('candidate-2-abcdef0123456789abcd-attempt-1'),
    )).rejects.toThrow(/candidate 2 failed safely/i);
    await expect(executor.execute(
      request(), context('candidate-2-abcdef0123456789abcd-attempt-2'),
    )).resolves.toMatchObject({ kind: 'bytes' });
    await expect(executor.execute(
      request(), context('candidate-1-abcdef0123456789abcd-attempt-1'),
    )).resolves.toMatchObject({ kind: 'bytes' });
    expect(loadPng).toHaveBeenCalledTimes(2);
  });

  it('rejects any output contract other than the QA Square fixture before loading bytes', async () => {
    const loadPng = vi.fn();
    const invalid = request();
    invalid.output = { ...invalid.output, width: 1024, height: 1280 };
    const executor = createProviderFreeQaWorkflowExecutor('provider-free', loadPng);
    await expect(executor.execute(invalid)).rejects.toThrow(/1024 x 1024/i);
    expect(loadPng).not.toHaveBeenCalled();
  });

  it('binds, saves, reopens, and leaves a Place-ready asset without reading visual files', async () => {
    const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer', {
      graphId: 'provider-free-visible-qa',
    }));
    const product = graph.nodes.find((node) => node.id === 'slot-product')!;
    product.config.assetId = 'product';
    product.config.relativePath = 'assets/Product.png';
    const resolveAsset = vi.fn(async () => ({
      assetId: 'product',
      relativePath: 'assets/Product.png',
      bytes: null,
      contentHash: `sha256:${'5'.repeat(64)}`,
    }));
    const readStoryboard = vi.fn();
    const storeAsset = vi.fn(async () => ({
      id: 'qa-square',
      name: 'paintnode-provider-free-qa-square.png',
      relativePath: 'assets/generated/paintnode-provider-free-qa-square.png',
      width: 1024,
      height: 1024,
      mime: 'image/png',
    }));
    const executor = createProviderFreeQaWorkflowExecutor(
      'provider-free',
      async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(executor.executor).toEqual({
      id: 'paintnode-qa-fake-square', version: '1', requestSchemaVersion: '1',
    });
    expect(executor.describeRun(request())).toEqual({
      id: 'qa-fake', model: null, effectiveOptions: { fixture: 'square' },
    });

    const outcome = await executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'qa-fake',
      executors: [executor],
      assets: [{
        id: 'product', name: 'Product.png', relativePath: 'assets/Product.png',
        width: 1200, height: 1200, mime: 'image/png',
      }],
      resolveAsset,
      readStoryboard,
      storeAsset,
    });

    expect(resolveAsset).toHaveBeenCalledOnce();
    expect(readStoryboard).not.toHaveBeenCalled();
    expect(storeAsset).toHaveBeenCalledOnce();
    expect(outcome.asset).toMatchObject({
      id: 'qa-square', relativePath: 'assets/generated/paintnode-provider-free-qa-square.png',
      width: 1024, height: 1024, mime: 'image/png',
    });
    expect(outcome.graph.nodes.find((node) => node.id === 'output-square')?.config).toMatchObject({
      outputAssetId: 'qa-square',
      outputRelativePath: 'assets/generated/paintnode-provider-free-qa-square.png',
    });
    const reopened = parseWorkflowGraphV2(JSON.parse(serializeWorkflowGraphV2(outcome.graph)));
    expect(reopened).toMatchObject({ ok: true });
    expect(reopened.value?.nodes.find((node) => node.id === 'output-square')?.config).toMatchObject({
      outputAssetId: 'qa-square',
      outputRelativePath: 'assets/generated/paintnode-provider-free-qa-square.png',
    });
  });
});
