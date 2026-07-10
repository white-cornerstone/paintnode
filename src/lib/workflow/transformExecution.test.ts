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
    const readAsset = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
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
      readAsset,
      storeAsset,
      idGenerator: () => 'asset-ref-square-result',
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
    expect(readAsset).toHaveBeenCalledTimes(1);
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

    const serialized = serializeWorkflowGraphV2(result.graph);
    expect(parseWorkflowGraphV2(JSON.parse(serialized))).toMatchObject({ ok: true, value: result.graph });
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
    const readAsset = vi.fn();
    const storeAsset = vi.fn();
    await expect(executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', service)],
      assets: [productAsset],
      readAsset,
      storeAsset,
    })).rejects.toMatchObject({ code: 'INVALID_TRANSFORM_PATH' });
    expect(service).not.toHaveBeenCalled();
    expect(readAsset).not.toHaveBeenCalled();
    expect(storeAsset).not.toHaveBeenCalled();
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
      readAsset: async () => new Uint8Array([137, 80, 78, 71]),
      storeAsset,
    })).rejects.toMatchObject({ code: 'INVALID_EXECUTOR_RESULT' });

    expect(storeAsset).not.toHaveBeenCalled();
    expect(graph).toEqual(before);
    expect(square.config).toMatchObject({
      outputAssetId: 'previous-square',
      outputRelativePath: 'generated/previous-square.png',
    });
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
        }))],
        assets: [productAsset],
        readAsset: async () => new Uint8Array([137, 80, 78, 71]),
        storeAsset: vi.fn(),
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
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
    const readStoryboard = vi.fn(async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    let seen!: WorkflowTransformExecutionRequest;
    await executeCampaignGenerateTransform(graph, 'output-square', {
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
        };
      })],
      assets: [productAsset],
      readAsset: async () => new Uint8Array([137, 80, 78, 71]),
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
  });

  it('explains missing-project and unsupported-provider actions before any injected side effect', async () => {
    const graph = boundCampaign();
    const readAsset = vi.fn();
    const storeAsset = vi.fn();
    const executor = createWorkflowCompositionExecutor('fake', vi.fn());

    await expect(executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: null,
      provider: 'fake',
      executors: [executor],
      assets: [productAsset],
      readAsset,
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
      readAsset,
      storeAsset,
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER',
      nextAction: 'Choose a supported image provider',
    } satisfies Partial<WorkflowTransformExecutionError>);
    expect(readAsset).not.toHaveBeenCalled();
    expect(storeAsset).not.toHaveBeenCalled();
  });

  it('honours a persisted Transform provider instead of silently overwriting it with UI settings', async () => {
    const graph = boundCampaign();
    graph.nodes.find((node) => node.id === 'transform-generate-square')!.config.advanced = {
      provider: 'persisted-provider', model: 'persisted-model',
    };
    const service = vi.fn();
    const readAsset = vi.fn();
    await expect(executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', service)],
      assets: [productAsset],
      readAsset,
      storeAsset: vi.fn(),
    })).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROVIDER',
      message: expect.stringMatching(/persisted-provider/),
    });
    expect(service).not.toHaveBeenCalled();
    expect(readAsset).not.toHaveBeenCalled();
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
    }));
    const outcome = await executeCampaignGenerateTransform(graph, 'output-square', {
      projectPath: '/virtual/project',
      provider: 'codex',
      executors: [
        createWorkflowCompositionExecutor('codex', codex),
        createWorkflowCompositionExecutor('antigravity', antigravity),
      ],
      assets: [productAsset],
      readAsset: async () => new Uint8Array([137, 80, 78, 71]),
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
