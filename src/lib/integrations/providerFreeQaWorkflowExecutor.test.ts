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
