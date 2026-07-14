import { describe, expect, it } from 'vitest';
import { createCreatorNode } from './registry';
import { WORKFLOW_GRAPH_VERSION, type WorkflowGraphV2 } from './schema';
import { workflowTransformContext } from './transformContext';

function graph(): WorkflowGraphV2 {
  const nodes = [
    createCreatorNode('input', { id: 'inherited', title: 'Bottle' }),
    createCreatorNode('input', { id: 'direct', title: 'Glass' }),
    createCreatorNode('brief', { id: 'brief' }),
    createCreatorNode('art-direction', { id: 'direction' }),
    createCreatorNode('transform', { id: 'transform' }),
  ];
  return {
    version: WORKFLOW_GRAPH_VERSION,
    id: 'transform-context',
    metadata: { name: 'Transform context', sourceVersion: null, migrations: [] },
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nodes,
    edges: [
      { id: 'brief-direction', source: { nodeId: 'brief', portId: 'prompt' }, target: { nodeId: 'direction', portId: 'brief' } },
      { id: 'inherited-direction', source: { nodeId: 'inherited', portId: 'asset' }, target: { nodeId: 'direction', portId: 'assets' } },
      { id: 'direction-transform', source: { nodeId: 'direction', portId: 'layout' }, target: { nodeId: 'transform', portId: 'source' } },
      { id: 'direct-transform', source: { nodeId: 'direct', portId: 'asset' }, target: { nodeId: 'transform', portId: 'assets' } },
    ],
    assetReferences: [],
    runRecords: [],
  };
}

describe('Transform context', () => {
  it('reports inherited Brief, Art Direction, and visual references separately from direct references', () => {
    const context = workflowTransformContext(graph(), 'transform');

    expect(context.brief?.id).toBe('brief');
    expect(context.artDirection?.id).toBe('direction');
    expect(context.inheritedVisuals.map(({ node }) => node.id)).toEqual(['inherited']);
    expect(context.directVisuals.map(({ node }) => node.id)).toEqual(['direct']);
    expect(context.visualInputs.map(({ node, origin }) => [node.id, origin])).toEqual([
      ['inherited', 'inherited'],
      ['direct', 'direct'],
    ]);
  });

  it('does not send the same Input twice when it is connected through both paths', () => {
    const input = graph();
    input.edges.push({
      id: 'inherited-also-direct',
      source: { nodeId: 'inherited', portId: 'asset' },
      target: { nodeId: 'transform', portId: 'assets' },
    });

    const context = workflowTransformContext(input, 'transform');
    expect(context.directVisuals.map(({ node }) => node.id)).toEqual(['direct', 'inherited']);
    expect(context.visualInputs.map(({ node }) => node.id)).toEqual(['inherited', 'direct']);
  });
});
