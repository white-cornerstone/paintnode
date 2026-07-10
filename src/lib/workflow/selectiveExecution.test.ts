import { describe, expect, it } from 'vitest';
import {
  executeSelectiveWorkflowPlan,
  planSelectiveWorkflowExecution,
  type WorkflowSelectiveExecutionPlan,
} from './selectiveExecution';
import {
  WORKFLOW_GRAPH_VERSION,
  type WorkflowEdgeV2,
  type WorkflowGraphV2,
  type WorkflowNodeV2,
  type WorkflowRunRecordV1,
} from './schema';

function node(
  id: string,
  type: WorkflowNodeV2['type'],
  inputs: Array<{ id: string; required?: boolean; multiple?: boolean }> = [],
  outputs: string[] = ['image'],
): WorkflowNodeV2 {
  return {
    id,
    type,
    title: id,
    position: { x: 0, y: 0 },
    size: { width: 200, height: 160 },
    color: '#333333',
    ports: {
      inputs: inputs.map((input) => ({
        id: input.id,
        label: input.id,
        dataType: 'image',
        ...(input.required === undefined ? {} : { required: input.required }),
        ...(input.multiple === undefined ? {} : { multiple: input.multiple }),
      })),
      outputs: outputs.map((id) => ({ id, label: id, dataType: 'image' })),
    },
    config: { operation: type },
    runRecordIds: [],
  };
}

function edge(id: string, from: string, to: string, targetPort = 'image'): WorkflowEdgeV2 {
  return {
    id,
    source: { nodeId: from, portId: 'image' },
    target: { nodeId: to, portId: targetPort },
  };
}

function graph(): WorkflowGraphV2 {
  return {
    version: WORKFLOW_GRAPH_VERSION,
    id: 'selective-execution-test',
    metadata: { name: 'Selective execution test', sourceVersion: null, migrations: [] },
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nodes: [
      node('input-a', 'input'),
      node('input-b', 'input'),
      node('transform-a', 'transform', [{ id: 'image', required: true }]),
      node('transform-b', 'transform', [{ id: 'image', required: true }]),
      node('review', 'review', [{ id: 'candidates', required: true, multiple: true }]),
      node('output', 'output', [{ id: 'image', required: true }], []),
      node('unrelated', 'transform'),
    ],
    edges: [
      edge('input-a-transform-a', 'input-a', 'transform-a'),
      edge('input-b-transform-b', 'input-b', 'transform-b'),
      edge('transform-a-review', 'transform-a', 'review', 'candidates'),
      edge('transform-b-review', 'transform-b', 'review', 'candidates'),
      edge('review-output', 'review', 'output'),
    ],
    assetReferences: [],
    runRecords: [],
  };
}

function successfulRun(nodeId: string, materialKey: string, acceptedAt?: number): WorkflowRunRecordV1 {
  return {
    recordVersion: 1,
    id: `run-${nodeId}-${materialKey}`,
    nodeId,
    status: 'succeeded',
    attempt: 1,
    workflowRevision: 'revision',
    nodeRevision: 'node-revision',
    materialKey,
    sourceAssets: [],
    prompt: {
      brief: 'Brief',
      artDirection: 'Art direction',
      instructions: 'Instructions',
      constraints: [],
      effectivePromptHash: 'prompt-hash',
    },
    provider: { id: 'fake', model: null, effectiveOptions: {} },
    executor: { id: 'fake', version: '1', requestSchemaVersion: '1' },
    target: { nodeId, title: nodeId, width: 64, height: 64 },
    startedAt: 1,
    finishedAt: 2,
    outputs: [{
      assetReferenceId: `ref-${nodeId}`,
      assetId: `asset-${nodeId}`,
      relativePath: `assets/${nodeId}.png`,
      contentHash: `sha256:${nodeId}`,
      ...(acceptedAt === undefined ? {} : { acceptedAt }),
    }],
  };
}

function addRun(input: WorkflowGraphV2, run: WorkflowRunRecordV1): void {
  input.runRecords.push(run);
  input.nodes.find((item) => item.id === run.nodeId)!.runRecordIds.push(run.id);
}

function keys(input: WorkflowGraphV2, overrides: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(input.nodes.map((item) => [item.id, overrides[item.id] ?? `key-${item.id}`]));
}

async function execute(plan: WorkflowSelectiveExecutionPlan, calls: string[]): Promise<void> {
  await executeSelectiveWorkflowPlan(plan, {
    maxConcurrency: 3,
    providerKeyForNode: () => 'fake',
    providerConcurrency: { fake: 3 },
    executeNode: async ({ nodeId, materialKey }) => {
      calls.push(nodeId);
      return { cacheKey: materialKey, outputIds: [`new-${nodeId}`] };
    },
  });
}

describe('selective workflow planning', () => {
  it('runs only the selected node after satisfying its required upstream closure from exact #77 records', async () => {
    const input = graph();
    for (const nodeId of ['input-a', 'input-b', 'transform-a', 'transform-b']) {
      addRun(input, successfulRun(nodeId, `key-${nodeId}`));
    }

    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'review',
      materialKeys: keys(input),
      isRunRecordReusable: () => true,
    });
    const calls: string[] = [];
    await execute(plan, calls);

    expect(plan.requiredNodeIds).toEqual(['input-a', 'input-b', 'transform-a', 'transform-b', 'review']);
    expect(plan.affectedNodeIds).toEqual(['review']);
    expect(plan.preflight.map(({ nodeId, state }) => [nodeId, state])).toEqual([
      ['transform-a', 'cached'],
      ['transform-b', 'cached'],
      ['review', 'planned'],
    ]);
    expect(calls).toEqual(['review']);
  });

  it('runs reachable downstream work while reusing the unchanged side branch and preserving accepted results', async () => {
    const input = graph();
    for (const nodeId of input.nodes.map((item) => item.id)) {
      addRun(input, successfulRun(nodeId, `old-${nodeId}`, nodeId === 'transform-b' ? 2 : undefined));
    }
    const materialKeys = keys(input, {
      'input-b': 'old-input-b',
      'transform-b': 'old-transform-b',
      unrelated: 'old-unrelated',
    });
    const before = structuredClone(input);

    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-from-here',
      nodeId: 'input-a',
      materialKeys,
      isRunRecordReusable: () => true,
    });
    const calls: string[] = [];
    await execute(plan, calls);

    expect(plan.affectedNodeIds).toEqual(['input-a', 'transform-a', 'review', 'output']);
    expect(plan.preflight).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'input-a', state: 'stale', reason: expect.objectContaining({ code: 'MATERIAL_CHANGED' }) }),
      expect.objectContaining({ nodeId: 'transform-a', state: 'stale' }),
      expect.objectContaining({ nodeId: 'transform-b', state: 'cached' }),
      expect.objectContaining({ nodeId: 'review', state: 'stale' }),
      expect.objectContaining({ nodeId: 'output', state: 'stale' }),
    ]));
    expect(calls).toEqual(['input-a', 'transform-a', 'review', 'output']);
    expect(input).toEqual(before);
    expect((input.runRecords.find((run) => run.nodeId === 'transform-b') as WorkflowRunRecordV1)
      .outputs[0].acceptedAt).toBe(2);
  });

  it('treats matching material with an unavailable persisted output as a planned cache miss', () => {
    const input = graph();
    addRun(input, successfulRun('unrelated', 'key-unrelated'));

    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'unrelated',
      materialKeys: keys(input),
      isRunRecordReusable: () => false,
    });

    expect(plan.preflight).toEqual([expect.objectContaining({
      nodeId: 'unrelated',
      state: 'planned',
      reason: expect.objectContaining({ code: 'CACHED_OUTPUT_UNAVAILABLE' }),
    })]);
    expect(plan.executionNodeIds).toEqual(['unrelated']);
  });

  it('reports disabled and downstream blockers before execution and never invokes blocked nodes', async () => {
    const input = graph();
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-from-here',
      nodeId: 'transform-a',
      materialKeys: keys(input),
      nodeAvailability: (candidate) => candidate.id === 'transform-a'
        ? { executable: false, reason: 'Generate is disabled until an executor is configured.' }
        : { executable: true },
    });
    const calls: string[] = [];
    await execute(plan, calls);

    expect(plan.preflight).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'transform-a', state: 'blocked', reason: { code: 'NODE_DISABLED', message: expect.stringContaining('executor') } }),
      expect.objectContaining({ nodeId: 'review', state: 'blocked', reason: { code: 'UPSTREAM_BLOCKED', message: expect.stringContaining('transform-a') } }),
      expect.objectContaining({ nodeId: 'output', state: 'blocked' }),
    ]));
    expect(calls).toEqual([]);
  });

  it('fails closed without explicit artifact proof and snapshots validated material keys', () => {
    const input = graph();
    addRun(input, successfulRun('unrelated', 'key-unrelated'));
    const materialKeys = keys(input);
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'unrelated',
      materialKeys,
    });
    materialKeys.unrelated = 'mutated-after-planning';

    expect(plan.preflight).toEqual([expect.objectContaining({
      nodeId: 'unrelated',
      state: 'planned',
      reason: expect.objectContaining({ code: 'CACHED_OUTPUT_UNAVAILABLE' }),
    })]);
    expect(plan.materialKeys.unrelated).toBe('key-unrelated');
    expect(Object.isFrozen(plan.materialKeys)).toBe(true);
    expect(() => planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'unrelated',
      materialKeys: { unrelated: '   ' },
    })).toThrow(/material key/i);
  });
});

describe('selective workflow scheduling', () => {
  it('uses injected provider limits and a deterministic graph-order ready queue', async () => {
    const input = graph();
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'output',
      materialKeys: keys(input),
    });
    const started: string[] = [];
    const active = new Map<string, number>();
    const maximum = new Map<string, number>();
    const providerKeyForNode = (candidate: WorkflowNodeV2) => candidate.id.startsWith('input') ? 'asset' : 'creative';

    const result = await executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 3,
      providerKeyForNode,
      providerConcurrency: { asset: 1, creative: 2 },
      executeNode: async ({ nodeId, materialKey, node: candidate }) => {
        const provider = providerKeyForNode(candidate);
        started.push(nodeId);
        active.set(provider, (active.get(provider) ?? 0) + 1);
        maximum.set(provider, Math.max(maximum.get(provider) ?? 0, active.get(provider)!));
        await new Promise((resolve) => setTimeout(resolve, 1));
        active.set(provider, active.get(provider)! - 1);
        return { cacheKey: materialKey, outputIds: [`new-${nodeId}`] };
      },
    });

    expect(started).toEqual(['input-a', 'input-b', 'transform-a', 'transform-b', 'review', 'output']);
    expect(maximum).toEqual(new Map([['asset', 1], ['creative', 2]]));
    expect(result.executedNodeIds).toEqual(started);
    expect(result.results.get('output')).toEqual({ cacheKey: 'key-output', outputIds: ['new-output'] });
  });

  it('rejects a zero provider limit before making calls with an actionable configuration error', async () => {
    const input = graph();
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'unrelated',
      materialKeys: keys(input),
    });
    let calls = 0;

    await expect(executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 1,
      providerKeyForNode: () => 'fake',
      providerConcurrency: { fake: 0 },
      executeNode: async () => {
        calls += 1;
        return { cacheKey: 'key-unrelated', outputIds: ['never'] };
      },
    })).rejects.toThrow(/provider concurrency.*positive safe integer/i);
    expect(calls).toBe(0);
  });

  it('blocks only failed dependents while an independent ready branch completes', async () => {
    const input = graph();
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'output',
      materialKeys: keys(input),
    });
    const completed: string[] = [];

    const result = await executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 2,
      providerKeyForNode: () => 'fake',
      providerConcurrency: { fake: 2 },
      executeNode: async ({ nodeId, materialKey }) => {
        if (nodeId === 'transform-a') throw new Error('transform-a failed');
        completed.push(nodeId);
        return { cacheKey: materialKey, outputIds: [`new-${nodeId}`] };
      },
    });

    expect(completed).toEqual(['input-a', 'input-b', 'transform-b']);
    expect(result.failures.get('transform-a')).toEqual({ code: 'EXECUTOR_FAILED', message: 'transform-a failed' });
    expect(result.blockedNodeIds).toEqual(['review', 'output']);
    expect(result.results.has('transform-b')).toBe(true);
    expect(result.results.has('review')).toBe(false);
  });
});
