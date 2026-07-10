import { describe, expect, it } from 'vitest';
import { workflowReadiness, type WorkflowReadinessOptions } from './readiness';
import { instantiateWorkflowTemplate } from './templates';
import { planWorkflowExecution } from './execution';

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
  const product = graph.nodes.find((node) => node.id === 'slot-product')!;
  product.config.assetId = 'product-asset';
  product.config.relativePath = 'assets/product.png';
  return graph;
}

describe('workflow readiness', () => {
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
      ['outputs', 'complete'],
    ]);
    expect(result.nextAction).toMatchObject({ code: 'desktop', action: 'Open the desktop app' });
  });

  it('allows empty optional slots when the required Product slot is valid', () => {
    const result = workflowReadiness(bindProduct(), readyOptions());
    expect(result.ready).toBe(true);
    expect(result.items.find((item) => item.code === 'required-assets')).toMatchObject({ status: 'complete' });
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
