import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_GRAPH_VERSION,
  parseWorkflowGraphV2,
  serializeWorkflowGraphV2,
  type WorkflowGraphV2,
} from './schema';

function graph(config: Record<string, unknown> = {}): WorkflowGraphV2 {
  return {
    version: WORKFLOW_GRAPH_VERSION,
    id: 'workflow-test',
    metadata: {
      name: 'Test workflow',
      sourceVersion: null,
      migrations: [],
    },
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nodes: [
      {
        id: 'brief',
        type: 'brief',
        title: 'Brief',
        position: { x: 10, y: 20 },
        size: { width: 260, height: 180 },
        color: '#3a3c42',
        ports: {
          inputs: [],
          outputs: [{ id: 'prompt', label: 'Prompt', dataType: 'prompt' }],
        },
        config,
        runRecordIds: [],
      },
    ],
    edges: [],
    assetReferences: [],
    runRecords: [],
  };
}

describe('WorkflowGraph v2 schema', () => {
  it('accepts a valid graph and returns a detached value', () => {
    const input = graph({ objective: 'Campaign hero' });
    const result = parseWorkflowGraphV2(input);

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.value).toEqual(input);
    expect(result.value).not.toBe(input);
  });

  it('returns recoverable errors for invalid persisted data', () => {
    const result = parseWorkflowGraphV2({ version: 3, nodes: [{ type: 'brief' }] });

    expect(result.ok).toBe(false);
    expect(result.value).toBeUndefined();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'version', severity: 'error' }),
      expect.objectContaining({ path: 'id', severity: 'error' }),
      expect.objectContaining({ path: 'nodes[0].id', severity: 'error' }),
    ]));
  });

  it('preserves unknown future nodes as unsupported nodes with a warning', () => {
    const input = graph();
    input.nodes[0] = {
      ...input.nodes[0],
      type: 'future-relight-node' as never,
      config: { strength: 0.75, nested: { mode: 'cinematic' } },
    };

    const result = parseWorkflowGraphV2(input);

    expect(result.ok).toBe(true);
    expect(result.issues).toContainEqual(expect.objectContaining({
      path: 'nodes[0].type',
      severity: 'warning',
    }));
    expect(result.value?.nodes[0]).toMatchObject({
      id: 'brief',
      type: 'unsupported',
      config: {
        unsupportedType: 'future-relight-node',
        rawConfig: { strength: 0.75, nested: { mode: 'cinematic' } },
      },
    });
  });

  it('serializes deterministically regardless of object key insertion order', () => {
    const first = graph({ zeta: 1, alpha: { second: true, first: false } });
    const second = graph({ alpha: { first: false, second: true }, zeta: 1 });

    expect(serializeWorkflowGraphV2(first)).toBe(serializeWorkflowGraphV2(second));
    expect(parseWorkflowGraphV2(JSON.parse(serializeWorkflowGraphV2(first))).value).toEqual(first);
  });
});
