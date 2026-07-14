import { describe, expect, it } from 'vitest';
import { workflowReadiness, type WorkflowReadinessOptions } from './readiness';
import { instantiateWorkflowTemplate } from './templates';
import { planWorkflowExecution } from './execution';
import { createCreatorNode } from './registry';
import { WORKFLOW_GRAPH_VERSION, type WorkflowGraphV2 } from './schema';

function readyOptions(): WorkflowReadinessOptions {
  return {
    desktop: true,
    projectPath: '/tmp/project',
    assets: [{ id: 'product-asset', relativePath: 'assets/product.png', exists: true }],
    provider: 'fake',
    supportedProviders: ['fake'],
  };
}

function bindProduct() {
  const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer'));
  graph.nodes = graph.nodes.filter((node) => ![
    'review-campaign-direction', 'transform-generate-portrait', 'transform-generate-landscape',
  ].includes(node.id));
  graph.edges = graph.edges.filter((edge) => (
    graph.nodes.some((node) => node.id === edge.source.nodeId)
    && graph.nodes.some((node) => node.id === edge.target.nodeId)
  ));
  graph.edges.push(
    {
      id: 'edge-transform-generate-square-output-square',
      source: { nodeId: 'transform-generate-square', portId: 'result' },
      target: { nodeId: 'output-square', portId: 'source' },
    },
    ...['portrait', 'landscape'].map((format) => ({
      id: `edge-composition-output-${format}`,
      source: { nodeId: 'composition', portId: 'layout' },
      target: { nodeId: `output-${format}`, portId: 'source' },
    })),
  );
  const product = graph.nodes.find((node) => node.id === 'slot-product')!;
  product.config.assetId = 'product-asset';
  product.config.relativePath = 'assets/product.png';
  return graph;
}

function directWorkflow(instructions = 'Create a studio product photograph.'): WorkflowGraphV2 {
  const input = createCreatorNode('input', {
    id: 'direct-input',
    title: 'Direct product',
    config: { assetId: 'product-asset', relativePath: 'assets/product.png', role: 'Product reference' },
  });
  const transform = createCreatorNode('transform', {
    id: 'direct-transform',
    config: { capability: 'generate', instructions },
  });
  const output = createCreatorNode('output', { id: 'direct-output' });
  return {
    version: WORKFLOW_GRAPH_VERSION,
    id: 'direct-workflow',
    metadata: { name: 'Direct workflow', sourceVersion: null, migrations: [] },
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nodes: [input, transform, output],
    edges: [
      { id: 'input-transform', source: { nodeId: input.id, portId: 'asset' }, target: { nodeId: transform.id, portId: 'assets' } },
      { id: 'transform-output', source: { nodeId: transform.id, portId: 'result' }, target: { nodeId: output.id, portId: 'source' } },
    ],
    assetReferences: [],
    runRecords: [],
  };
}

describe('workflow readiness', () => {
  it('accepts direct visual references and Transform guidance without Brief or Art Direction', () => {
    const ready = workflowReadiness(directWorkflow(), { ...readyOptions(), targetNodeId: 'direct-output' });
    expect(ready.ready).toBe(true);
    expect(ready.items.find((item) => item.code === 'required-assets')).toMatchObject({ status: 'complete' });
    expect(ready.items.find((item) => item.code === 'brief')).toMatchObject({ status: 'complete' });
    expect(ready.items.find((item) => item.code === 'art-direction')).toMatchObject({
      status: 'complete', label: 'Transform guidance',
    });

    const missingGuidance = workflowReadiness(directWorkflow(''), { ...readyOptions(), targetNodeId: 'direct-output' });
    expect(missingGuidance.ready).toBe(false);
    expect(missingGuidance.items.find((item) => item.code === 'art-direction')).toMatchObject({
      status: 'blocked', action: 'Write instructions in Generate',
    });
  });

  it('reports every first-run requirement without performing any side effects', () => {
    const result = workflowReadiness(instantiateWorkflowTemplate('blank'), {
      desktop: false,
      projectPath: null,
      assets: [],
    });

    expect(result.ready).toBe(false);
    expect(result.items.map((item) => [item.code, item.status])).toEqual([
      ['desktop', 'blocked'],
      ['project-folder', 'blocked'],
      ['required-assets', 'blocked'],
      ['brief', 'blocked'],
      ['art-direction', 'blocked'],
      ['outputs', 'blocked'],
    ]);
    expect(result.nextAction).toMatchObject({ code: 'desktop', action: 'Open the desktop app' });
  });

  it('allows empty optional slots when the required Product slot is valid', () => {
    const result = workflowReadiness(bindProduct(), readyOptions());
    expect(result.ready).toBe(true);
    expect(result.items.find((item) => item.code === 'required-assets')).toMatchObject({ status: 'complete' });
  });

  it('honors explicit optional inputs without template metadata and keeps absent required legacy-strict', () => {
    const graph = bindProduct();
    const inputs = graph.nodes.filter((node) => node.type === 'input');
    inputs.forEach((node) => {
      delete node.config.templateRole;
    });

    const explicit = workflowReadiness(graph, readyOptions());
    expect(explicit.ready).toBe(true);
    expect(explicit.items.find((item) => item.code === 'required-assets')).toMatchObject({
      status: 'complete',
      message: '1 required visual input is ready.',
    });

    const legacy = structuredClone(graph);
    delete legacy.nodes.find((node) => node.id === 'slot-subject')!.config.required;
    const absent = workflowReadiness(legacy, readyOptions());
    expect(absent.ready).toBe(false);
    expect(absent.items.find((item) => item.code === 'required-assets')).toMatchObject({
      status: 'blocked',
      message: expect.stringMatching(/Subject is required/i),
    });

    const malformed = structuredClone(graph);
    malformed.nodes.find((node) => node.id === 'slot-subject')!.config.required = 'false';
    const invalid = workflowReadiness(malformed, readyOptions());
    expect(invalid.ready).toBe(false);
    expect(invalid.items.find((item) => item.code === 'required-assets')).toMatchObject({
      status: 'blocked',
      message: expect.stringMatching(/Subject is required/i),
    });
  });

  it('does not let partial template metadata hide an untagged required Campaign input', () => {
    const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer'));
    delete graph.nodes.find((node) => node.id === 'slot-product')!.config.templateRole;
    delete graph.nodes.find((node) => node.id === 'slot-subject')!.config.templateRole;

    const result = workflowReadiness(graph, {
      ...readyOptions(),
      assets: [],
    });

    expect(result.ready).toBe(false);
    expect(result.items.find((item) => item.code === 'required-assets')).toMatchObject({
      status: 'blocked',
      message: expect.stringMatching(/Product is required/i),
    });
  });

  it('scopes Transform and provider readiness to the requested output', () => {
    const graph = bindProduct();
    const square = workflowReadiness(graph, {
      ...readyOptions(), provider: 'unsupported', targetNodeId: 'output-square',
    });
    expect(square.ready).toBe(false);
    expect(square.nextAction).toMatchObject({
      code: 'provider', action: 'Choose a supported image provider',
    });

    const portrait = workflowReadiness(graph, {
      ...readyOptions(), provider: 'unsupported', targetNodeId: 'output-portrait',
    });
    expect(portrait.ready).toBe(false);
    expect(portrait.nextAction).toMatchObject({
      code: 'transform', action: 'Add or reconnect a Generate Transform for Portrait 4:5',
    });
    expect(portrait.items.some((item) => item.code === 'provider')).toBe(false);
  });

  it('blocks a pre-Generate direct output with a recoverable Transform action before a run', () => {
    const graph = bindProduct();
    graph.nodes = graph.nodes.filter((node) => node.id !== 'transform-generate-square');
    graph.edges = graph.edges.filter((edge) => !edge.id.includes('transform-generate-square'));
    graph.edges.push({
      id: 'legacy-direct-square',
      source: { nodeId: 'composition', portId: 'layout' },
      target: { nodeId: 'output-square', portId: 'source' },
    });
    const result = workflowReadiness(graph, { ...readyOptions(), targetNodeId: 'output-square' });
    expect(result.ready).toBe(false);
    expect(result.nextAction).toMatchObject({
      code: 'transform', action: 'Add or reconnect a Generate Transform for Square 1:1',
    });
  });

  it('uses the persisted Transform provider override for target readiness', () => {
    const graph = bindProduct();
    const transform = graph.nodes.find((node) => node.id === 'transform-generate-square')!;
    transform.config.advanced = { provider: 'antigravity', model: 'gemini-3.1-flash-image' };
    const supported = workflowReadiness(graph, {
      ...readyOptions(),
      provider: 'codex',
      supportedProviders: ['codex', 'antigravity'],
      targetNodeId: 'output-square',
    });
    expect(supported.ready).toBe(true);
    expect(supported.items.find((item) => item.code === 'provider')?.message).toMatch(/antigravity/i);

    transform.config.advanced = { provider: 'saved-unsupported-provider' };
    const unsupported = workflowReadiness(graph, {
      ...readyOptions(),
      provider: 'codex',
      supportedProviders: ['codex', 'antigravity'],
      targetNodeId: 'output-square',
    });
    expect(unsupported.nextAction).toMatchObject({
      code: 'provider', action: 'Choose a supported image provider',
    });
  });

  it('blocks missing, disconnected, and stale required asset bindings with a specific next action', () => {
    const missing = workflowReadiness(instantiateWorkflowTemplate('campaign-composer'), readyOptions());
    expect(missing.items.find((item) => item.code === 'required-assets')).toMatchObject({
      status: 'blocked',
      message: expect.stringMatching(/Product/),
      action: 'Choose an asset for Product',
    });

    const disconnectedGraph = bindProduct();
    disconnectedGraph.edges = disconnectedGraph.edges.filter((edge) => edge.source.nodeId !== 'slot-product');
    const disconnected = workflowReadiness(disconnectedGraph, readyOptions());
    expect(disconnected.items.find((item) => item.code === 'required-assets')).toMatchObject({
      status: 'blocked',
      message: expect.stringMatching(/not connected/i),
      action: 'Reconnect Product to Art Direction',
    });

    const stale = workflowReadiness(bindProduct(), { ...readyOptions(), assets: [] });
    expect(stale.items.find((item) => item.code === 'required-assets')).toMatchObject({
      status: 'blocked',
      message: expect.stringMatching(/no longer available/i),
      action: 'Replace the asset in Product',
    });
  });

  it('does not require an extraction-only source image on the final generation path', () => {
    const graph = bindProduct();
    const extractionSource = createCreatorNode('input', {
      id: 'extraction-source',
      title: 'Original scene',
      config: {
        assetId: 'original-scene',
        relativePath: 'assets/original-scene.png',
        role: 'Extraction source',
      },
    });
    const extraction = createCreatorNode('extract-assets', { id: 'extract-products' });
    graph.nodes.push(extractionSource, extraction);
    graph.edges.push({
      id: 'scene-extraction',
      source: { nodeId: extractionSource.id, portId: 'asset' },
      target: { nodeId: extraction.id, portId: 'sources' },
    });

    const finalPath = workflowReadiness(graph, readyOptions());
    expect(finalPath.ready).toBe(true);
    expect(finalPath.items.find((item) => item.code === 'required-assets')).toMatchObject({ status: 'complete' });

    graph.edges.push({
      id: 'scene-art-direction',
      source: { nodeId: extractionSource.id, portId: 'asset' },
      target: { nodeId: 'composition', portId: 'assets' },
    });
    const reusedAsReference = workflowReadiness(graph, readyOptions());
    expect(reusedAsReference.items.find((item) => item.code === 'required-assets')).toMatchObject({
      status: 'blocked',
      message: expect.stringMatching(/Original scene.*no longer available/i),
    });
  });

  it('blocks a stale assigned optional slot instead of silently ignoring it', () => {
    const graph = bindProduct();
    const style = graph.nodes.find((node) => node.id === 'slot-style')!;
    style.config.assetId = 'missing-style';
    style.config.relativePath = 'assets/missing-style.png';
    const result = workflowReadiness(graph, readyOptions());

    expect(result.ready).toBe(false);
    expect(result.items.find((item) => item.code === 'required-assets')).toMatchObject({
      message: expect.stringMatching(/Style.*no longer available/i),
      action: 'Replace the asset in Style',
    });
  });

  it('shares explicit checks for brief, art direction, and configured outputs', () => {
    const graph = bindProduct();
    graph.nodes.find((node) => node.type === 'brief')!.config.objective = '';
    graph.nodes.find((node) => node.type === 'art-direction')!.config.prompt = '';
    graph.edges = graph.edges.filter((edge) => edge.target.nodeId !== 'output-square');

    const result = workflowReadiness(graph, readyOptions());
    expect(result.items.find((item) => item.code === 'brief')).toMatchObject({ status: 'blocked', action: 'Write the campaign brief' });
    expect(result.items.find((item) => item.code === 'art-direction')).toMatchObject({ status: 'blocked', action: 'Add art-direction guidance' });
    expect(result.items.find((item) => item.code === 'outputs')).toMatchObject({ status: 'blocked', action: 'Reconnect Square 1:1' });
  });

  it('blocks when a required typed Brief port is disconnected just as the execution planner does', () => {
    const graph = bindProduct();
    graph.edges = graph.edges.filter((edge) => edge.id !== 'edge-brief-composition');
    const readiness = workflowReadiness(graph, readyOptions());
    const plan = planWorkflowExecution(graph, 'output-square', { maxConcurrency: 2 });

    expect(readiness.ready).toBe(false);
    expect(readiness.items.find((item) => item.code === 'brief')).toMatchObject({
      status: 'blocked',
      action: 'Reconnect Campaign Brief to Art Direction',
    });
    expect(plan.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'composition', code: 'MISSING_REQUIRED_INPUT' }),
      expect.objectContaining({ nodeId: 'output-square', code: 'UPSTREAM_BLOCKED' }),
    ]));
  });
});
