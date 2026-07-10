import { describe, expect, it } from 'vitest';
import blank from './fixtures/v1/blank.json';
import { readWorkflowGraph } from './load';
import { migrateWorkflowFileV1 } from './migration';
import type { WorkflowGraphV2 } from './schema';

function invalidV2(
  mutate: (graph: WorkflowGraphV2) => void,
): WorkflowGraphV2 {
  const graph = migrateWorkflowFileV1(blank);
  mutate(graph);
  return graph;
}

describe('workflow graph loading', () => {
  it('returns migrated v1 data without mutating or implicitly saving the source', () => {
    const source = structuredClone(blank);
    const result = readWorkflowGraph(source);

    expect(result.ok).toBe(true);
    expect(result.sourceVersion).toBe(1);
    expect(result.requiresExplicitSave).toBe(true);
    expect(result.graph).toEqual(migrateWorkflowFileV1(blank));
    expect(source).toEqual(blank);
  });

  it('returns valid v2 data without marking it for migration save', () => {
    const graph = migrateWorkflowFileV1(blank);
    const result = readWorkflowGraph(graph);

    expect(result.ok).toBe(true);
    expect(result.sourceVersion).toBe(2);
    expect(result.requiresExplicitSave).toBe(false);
    expect(result.graph).toEqual(graph);
  });

  it('returns recoverable path-specific issues for malformed or unsupported data', () => {
    const malformed = readWorkflowGraph({ version: 1, nodes: 'broken' });
    const unsupported = readWorkflowGraph({ version: 7 });

    expect(malformed).toMatchObject({
      ok: false,
      sourceVersion: 1,
      issues: [{ path: 'nodes', severity: 'error' }],
    });
    expect(unsupported).toMatchObject({
      ok: false,
      sourceVersion: 7,
      issues: [{ path: 'version', severity: 'error' }],
    });
  });

  it.each([
    [
      'missing ports',
      invalidV2((graph) => { graph.edges[0].source.portId = 'missing'; }),
      'SOURCE_PORT_NOT_FOUND',
    ],
    [
      'incompatible ports',
      invalidV2((graph) => { graph.nodes.find((node) => node.id === 'output')!.ports.inputs[0].dataType = 'image'; }),
      'INCOMPATIBLE_PORT_TYPES',
    ],
    [
      'duplicate endpoints',
      invalidV2((graph) => { graph.edges.push({ ...structuredClone(graph.edges[0]), id: 'duplicate' }); }),
      'DUPLICATE_CONNECTION',
    ],
    [
      'duplicate edge IDs',
      invalidV2((graph) => {
        graph.edges.push({
          id: graph.edges[0].id,
          source: { nodeId: 'composition', portId: 'layout' },
          target: { nodeId: 'output', portId: 'source' },
        });
      }),
      'DUPLICATE_EDGE_ID',
    ],
    [
      'single-input cardinality',
      invalidV2((graph) => {
        const composition = graph.nodes.find((node) => node.id === 'composition')!;
        graph.nodes.push({ ...structuredClone(composition), id: 'other-composition', title: 'Other composition' });
        graph.edges.push({
          id: 'other-output',
          source: { nodeId: 'other-composition', portId: 'layout' },
          target: { nodeId: 'output', portId: 'source' },
        });
      }),
      'TARGET_PORT_OCCUPIED',
    ],
    [
      'cycles',
      invalidV2((graph) => {
        const composition = graph.nodes.find((node) => node.id === 'composition')!;
        const output = graph.nodes.find((node) => node.id === 'output')!;
        composition.ports.inputs.push({ id: 'feedback', label: 'Feedback', dataType: 'layout' });
        output.ports.outputs.push({ id: 'feedback', label: 'Feedback', dataType: 'layout' });
        graph.edges.push({
          id: 'cycle',
          source: { nodeId: 'output', portId: 'feedback' },
          target: { nodeId: 'composition', portId: 'feedback' },
        });
      }),
      'CYCLE_DETECTED',
    ],
  ])('rejects v2 graphs with %s at the public load boundary', (_name, graph, code) => {
    const result = readWorkflowGraph(graph);

    expect(result).toMatchObject({
      ok: false,
      sourceVersion: 2,
      requiresExplicitSave: false,
      issues: [{ path: expect.stringMatching(/^edges\[\d+\]/), severity: 'error' }],
    });
    expect(result.graph).toBeUndefined();
    expect(result.issues[0].message).toContain(String(code));
  });

  it('loads and preserves dormant edges connected to unsupported future nodes', () => {
    const graph = invalidV2((input) => {
      input.nodes[0] = { ...input.nodes[0], type: 'future-node' as never };
    });

    const result = readWorkflowGraph(graph);

    expect(result.ok).toBe(true);
    expect(result.graph?.nodes[0]).toMatchObject({ type: 'unsupported' });
    expect(result.graph?.edges).toEqual(graph.edges);
  });
});
