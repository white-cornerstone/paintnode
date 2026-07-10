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
        rawPorts: input.nodes[0].ports,
      },
    });
  });

  it('keeps the raw type, configuration, ports, and future fields recoverable for unsupported nodes', () => {
    const input = graph();
    const futureNode = {
      ...input.nodes[0],
      type: 'future-compositor',
      ports: {
        inputs: [{ id: 'scene', label: 'Scene', dataType: 'future-scene' }],
        outputs: [{ id: 'result', label: 'Result', dataType: 'future-render' }],
      },
      config: { quality: 'ultra', nested: { passes: 4 } },
      futureExecutionPolicy: { locality: 'device' },
    };
    input.nodes[0] = futureNode as never;

    const result = parseWorkflowGraphV2(input);

    expect(result.ok).toBe(true);
    expect(result.value?.nodes[0]).toMatchObject({
      type: 'unsupported',
      ports: {
        inputs: [{ id: 'scene', dataType: 'unknown' }],
        outputs: [{ id: 'result', dataType: 'unknown' }],
      },
      config: {
        unsupportedType: 'future-compositor',
        rawConfig: futureNode.config,
        rawPorts: futureNode.ports,
        rawNode: futureNode,
      },
    });
  });

  it('serializes deterministically regardless of object key insertion order', () => {
    const first = graph({ zeta: 1, alpha: { second: true, first: false } });
    const second = graph({ alpha: { first: false, second: true }, zeta: 1 });

    expect(serializeWorkflowGraphV2(first)).toBe(serializeWorkflowGraphV2(second));
    expect(parseWorkflowGraphV2(JSON.parse(serializeWorkflowGraphV2(first))).value).toEqual(first);
  });

  it('opens and reserializes legacy minimal v2 run references without data loss', () => {
    const input = graph();
    input.nodes[0].runRecordIds = ['legacy-run'];
    input.runRecords = [{ id: 'legacy-run', nodeId: 'brief', status: 'succeeded' }];

    const parsed = parseWorkflowGraphV2(input);

    expect(parsed).toMatchObject({ ok: true, value: input });
    expect(JSON.parse(serializeWorkflowGraphV2(parsed.value!)).runRecords).toEqual(input.runRecords);
  });

  it('strictly parses and canonically serializes a full additive v2 run record', () => {
    const input = graph();
    input.nodes[0].runRecordIds = ['run-1'];
    input.runRecords = [{
      recordVersion: 1,
      id: 'run-1',
      nodeId: 'brief',
      status: 'succeeded',
      attempt: 1,
      workflowRevision: 'sha256:workflow',
      nodeRevision: 'sha256:node',
      materialKey: 'workflow-cache-v1:material',
      sourceAssets: [{
        nodeId: 'input-product', assetId: 'asset-product', relativePath: 'assets/product.png',
        contentHash: 'sha256:product',
      }],
      prompt: {
        brief: 'Launch campaign', artDirection: 'Keep the product left', instructions: 'Generate Square',
        constraints: ['Keep logo readable'], effectivePromptHash: 'sha256:prompt',
      },
      provider: { id: 'qa-fake', model: null, effectiveOptions: { quality: 'fixture', nested: { b: 2, a: 1 } } },
      executor: { id: 'campaign-generate', version: '1', requestSchemaVersion: '1' },
      startedAt: 100,
      finishedAt: 120,
      outputs: [{
        assetReferenceId: 'asset-ref-square', assetId: 'asset-square', relativePath: 'assets/square.png',
        contentHash: 'sha256:square', acceptedAt: 120,
      }],
    }];

    const parsed = parseWorkflowGraphV2(input);
    expect(parsed).toMatchObject({ ok: true, value: input });
    const first = serializeWorkflowGraphV2(parsed.value!);
    const reordered = structuredClone(input);
    const full = reordered.runRecords[0] as typeof input.runRecords[0] & { provider: { effectiveOptions: object } };
    full.provider.effectiveOptions = { nested: { a: 1, b: 2 }, quality: 'fixture' };
    expect(serializeWorkflowGraphV2(reordered)).toBe(first);
  });
});
