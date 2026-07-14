import { describe, expect, it } from 'vitest';
import { createCreatorNode } from './registry';
import { WORKFLOW_GRAPH_VERSION, type WorkflowGraphV2 } from './schema';
import {
  withInputAssetScopePorts,
  workflowExtractionQuickLinks,
  workflowInputAssetScope,
} from './inputAssetScope';

function scopeGraph(): WorkflowGraphV2 {
  const first = createCreatorNode('extract-assets', {
    id: 'extract-first',
    title: 'First extraction',
    config: {
      resultAssets: [
        { id: 'first-a', name: 'First A', relativePath: 'assets/first-a.png' },
        { id: 'first-b', name: 'First B', relativePath: 'assets/first-b.png' },
      ],
    },
  });
  const second = createCreatorNode('extract-assets', {
    id: 'extract-second',
    title: 'Second extraction',
    config: {
      resultAssets: [{ id: 'second-a', name: 'Second A', relativePath: 'assets/second-a.png' }],
    },
  });
  return {
    version: WORKFLOW_GRAPH_VERSION,
    id: 'input-asset-scope',
    metadata: { name: 'Input asset scope', sourceVersion: null, migrations: [] },
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nodes: [first, second, createCreatorNode('input', { id: 'input' })],
    edges: [],
    assetReferences: [],
    runRecords: [],
  };
}

describe('Visual Input extraction scope', () => {
  it('keeps all extraction quick links available until an Extract Assets output is connected', () => {
    const graph = scopeGraph();

    expect(workflowInputAssetScope(graph, 'input')).toBeNull();
    expect(workflowExtractionQuickLinks(graph).map((link) => [link.nodeName, link.id])).toEqual([
      ['First extraction', 'first-a'],
      ['First extraction', 'first-b'],
      ['Second extraction', 'second-a'],
    ]);
  });

  it('returns only the connected Extract Assets result list', () => {
    const graph = scopeGraph();
    graph.edges.push({
      id: 'scope-edge',
      source: { nodeId: 'extract-second', portId: 'assets' },
      target: { nodeId: 'input', portId: 'scope' },
    });

    expect(workflowInputAssetScope(graph, 'input')).toEqual({
      nodeId: 'extract-second',
      nodeName: 'Second extraction',
      assets: [{ id: 'second-a', name: 'Second A', relativePath: 'assets/second-a.png' }],
    });
  });

  it('adds the scope probe to older input nodes without changing already-current graphs', () => {
    const legacy = scopeGraph();
    legacy.nodes.find((node) => node.id === 'input')!.ports.inputs = [];

    const upgraded = withInputAssetScopePorts(legacy);

    expect(upgraded).not.toBe(legacy);
    expect(upgraded.nodes.find((node) => node.id === 'input')?.ports.inputs).toEqual([
      { id: 'scope', label: 'Extracted asset scope', dataType: 'asset-reference' },
    ]);
    expect(withInputAssetScopePorts(upgraded)).toBe(upgraded);
  });
});
