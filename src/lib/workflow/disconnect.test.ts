import { describe, expect, it } from 'vitest';
import { createCreatorNode } from './registry';
import type { WorkflowEdgeV2 } from './schema';
import { workflowDisconnectMode, workflowNodeDisconnectLinks } from './disconnect';

const source = createCreatorNode('extract-assets', { id: 'extract', title: 'Extract Assets' });
const selected = createCreatorNode('input', { id: 'selected', title: 'Selected Asset' });
const output = createCreatorNode('output', { id: 'output', title: 'Final Output' });
const edges: WorkflowEdgeV2[] = [
  {
    id: 'edge-input',
    source: { nodeId: source.id, portId: 'assets' },
    target: { nodeId: selected.id, portId: 'scope' },
  },
  {
    id: 'edge-output',
    source: { nodeId: selected.id, portId: 'asset' },
    target: { nodeId: output.id, portId: 'source' },
  },
];

describe('workflow node disconnect links', () => {
  it('groups incoming links before outgoing links with readable endpoint labels', () => {
    const links = workflowNodeDisconnectLinks({ nodes: [source, selected, output], edges }, selected.id);

    expect(links).toEqual([
      expect.objectContaining({
        id: 'edge-input',
        direction: 'input',
        peerNodeTitle: 'Extract Assets',
        localPortLabel: 'Extracted asset scope',
        peerPortLabel: 'Extracted assets',
      }),
      expect.objectContaining({
        id: 'edge-output',
        direction: 'output',
        peerNodeTitle: 'Final Output',
        localPortLabel: 'Asset',
        peerPortLabel: 'Directed composition',
      }),
    ]);
  });

  it('uses the direct action only for exactly one link', () => {
    const links = workflowNodeDisconnectLinks({ nodes: [source, selected, output], edges }, selected.id);

    expect(workflowDisconnectMode([])).toBe('none');
    expect(workflowDisconnectMode(links.slice(0, 1))).toBe('immediate');
    expect(workflowDisconnectMode(links)).toBe('confirm');
  });
});
