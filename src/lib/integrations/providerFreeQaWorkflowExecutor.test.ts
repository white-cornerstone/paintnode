import { describe, expect, it, vi } from 'vitest';
import type { WorkflowTransformExecutionRequest } from '../workflow/transformExecutor';
import { executeCampaignGenerateTransform } from '../workflow/transformExecutor';
import { parseWorkflowGraphV2, serializeWorkflowGraphV2 } from '../workflow/schema';
import { instantiateWorkflowTemplate } from '../workflow/templates';
import { workflowSha256Bytes } from '../workflow/provenance';
import { createProviderFreeQaWorkflowExecutor } from './providerFreeQaWorkflowExecutor';

function request(width = 1024, height = 1024): WorkflowTransformExecutionRequest {
  const nodeId = width === 1280 ? 'transform-generate-landscape'
    : height === 1280 ? 'transform-generate-portrait' : 'transform-generate-square';
  return {
    workflowId: 'qa-workflow',
    nodeId,
    capability: 'generate',
    provider: 'qa-fake',
    projectPath: '/virtual/project',
    brief: 'Provider-free QA campaign',
    artDirection: 'Keep the product recognisable',
    transform: { capability: 'generate', instructions: 'Generate Square', advanced: {} },
    prompt: 'Provider-free QA campaign',
    sources: [],
    storyboard: null,
    output: { nodeId: 'output-square', title: 'Campaign output', width, height },
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
      expect(loadPng).toHaveBeenNthCalledWith(1, 1024, 1024, 0);
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

  it('uses stable, visibly distinct native square fixtures keyed by candidate ordinal', async () => {
    const loadPng = vi.fn(async (_width: number, _height: number, variant: number) => (
      new Uint8Array([137, 80, 78, 71, variant, 255 - variant])
    ));
    const executor = createProviderFreeQaWorkflowExecutor('provider-free', loadPng);
    const context = (runId: string) => ({
      identity: {
        workflowSessionId: 'qa-session', workflowId: 'qa-workflow', runId,
        nodeId: 'transform-generate-square',
      },
      reportProgress: vi.fn(),
    });

    const first = await executor.execute(
      request(), context('candidate-1-abcdef0123456789abcd-attempt-1'),
    );
    const firstRetry = await executor.execute(
      request(), context('candidate-1-abcdef0123456789abcd-attempt-2'),
    );
    const second = await executor.execute(
      request(), context('candidate-2-abcdef0123456789abcd-attempt-1'),
    );

    expect(first.kind).toBe('bytes');
    expect(firstRetry.kind).toBe('bytes');
    expect(second.kind).toBe('bytes');
    if (first.kind !== 'bytes' || firstRetry.kind !== 'bytes' || second.kind !== 'bytes') return;
    expect(workflowSha256Bytes(first.bytes)).toBe(workflowSha256Bytes(firstRetry.bytes));
    expect(workflowSha256Bytes(first.bytes)).not.toBe(workflowSha256Bytes(second.bytes));
    expect(loadPng.mock.calls).toEqual([
      [1024, 1024, 1], [1024, 1024, 1], [1024, 1024, 2],
    ]);
  });

  it('fails Landscape at any historical attempt only while the format recovery checkpoint is active', async () => {
    const loadPng = vi.fn(async (_width: number, _height: number, variant: number) => (
      new Uint8Array([137, 80, 78, 71, variant])
    ));
    const recoveryExecutor = createProviderFreeQaWorkflowExecutor('provider-free', loadPng, {
      scenario: 'format-recovery-checkpoint',
    });
    const standardExecutor = createProviderFreeQaWorkflowExecutor('provider-free', loadPng);
    const context = (nodeId: string, attempt: number) => ({
      identity: {
        workflowSessionId: 'qa-session', workflowId: 'qa-workflow',
        runId: `board-run:${nodeId}:${attempt}`, nodeId,
      },
      reportProgress: vi.fn(),
    });

    const square = await recoveryExecutor.execute(request(), context('transform-generate-square', 3));
    const portrait = await recoveryExecutor.execute(
      request(1024, 1280), context('transform-generate-portrait', 3),
    );
    await expect(recoveryExecutor.execute(
      request(1280, 720), context('transform-generate-landscape', 3),
    )).rejects.toThrow(/Landscape recovery checkpoint/i);
    const retriedLandscape = await standardExecutor.execute(
      request(1280, 720), context('transform-generate-landscape', 3),
    );

    expect(square).toMatchObject({ kind: 'bytes', width: 1024, height: 1024 });
    expect(portrait).toMatchObject({ kind: 'bytes', width: 1024, height: 1280 });
    expect(retriedLandscape).toMatchObject({ kind: 'bytes', width: 1280, height: 720 });
    expect(loadPng.mock.calls).toEqual([
      [1024, 1024, 0], [1024, 1280, 0], [1280, 720, 0],
    ]);
  });

  it('supports the exact three Campaign Composer shapes through the dimension-aware loader', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const loadPng = vi.fn(async () => png);
    const executor = createProviderFreeQaWorkflowExecutor('provider-free', loadPng);

    await expect(executor.execute(request(1024, 1024))).resolves.toMatchObject({
      name: 'paintnode-provider-free-qa-square.png', width: 1024, height: 1024,
    });
    await expect(executor.execute(request(1024, 1280))).resolves.toMatchObject({
      name: 'paintnode-provider-free-qa-portrait.png', width: 1024, height: 1280,
    });
    await expect(executor.execute(request(1280, 720))).resolves.toMatchObject({
      name: 'paintnode-provider-free-qa-landscape.png', width: 1280, height: 720,
    });
    expect(loadPng.mock.calls).toEqual([[1024, 1024, 0], [1024, 1280, 0], [1280, 720, 0]]);
  });

  it('rejects any output contract outside the three Campaign Composer fixtures before loading bytes', async () => {
    const loadPng = vi.fn();
    const executor = createProviderFreeQaWorkflowExecutor('provider-free', loadPng);
    await expect(executor.execute(request(900, 900))).rejects.toThrow(/1:1, 4:5, and 16:9/i);
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
      id: 'paintnode-qa-fake-campaign', version: '2', requestSchemaVersion: '1',
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
      allowUnpromotedReview: true,
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
