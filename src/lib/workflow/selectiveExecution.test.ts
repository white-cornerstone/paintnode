import { describe, expect, it } from 'vitest';
import type { WorkflowExecutionResult } from './execution';
import {
  createWorkflowExecutionRestrictions,
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
import { instantiateWorkflowTemplate } from './templates';

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
    config: type === 'transform'
      ? { operation: type, capability: 'generate' }
      : { operation: type },
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
      node('review', 'transform', [{ id: 'candidates', required: true, multiple: true }]),
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
    validateResultOwnership: () => true,
    executeNode: async ({ nodeId, materialKey }) => {
      calls.push(nodeId);
      return { cacheKey: materialKey, outputIds: [`new-${nodeId}`] };
    },
  });
}

describe('selective workflow planning', () => {
  it('rejects a proxy around trusted execution restrictions without invoking reflection traps', () => {
    const input = graph();
    const trusted = createWorkflowExecutionRestrictions([{
      nodeId: 'transform-a',
      kind: 'unavailable',
      reason: 'Disabled for this run.',
    }]);
    const traps = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 };
    const hostile = new Proxy(trusted, {
      getPrototypeOf: () => {
        traps.getPrototypeOf += 1;
        throw new Error('/private/getPrototypeOf auth=secret');
      },
      ownKeys: () => {
        traps.ownKeys += 1;
        throw new Error('/private/ownKeys auth=secret');
      },
      getOwnPropertyDescriptor: () => {
        traps.getOwnPropertyDescriptor += 1;
        throw new Error('/private/descriptor auth=secret');
      },
    });

    expect(() => planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'output',
      materialKeys: keys(input),
      executionRestrictions: hostile,
    })).toThrow('Execution restrictions were not created by the trusted workflow boundary.');
    expect(traps).toEqual({ getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0 });
  });
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
      ['input-a', 'planned'],
      ['input-b', 'planned'],
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
      executionRestrictions: createWorkflowExecutionRestrictions([{
        nodeId: 'review',
        kind: 'not-required',
      }]),
      isRunRecordReusable: () => true,
    });
    const calls: string[] = [];
    await execute(plan, calls);

    expect(plan.affectedNodeIds).toEqual(['input-a', 'transform-a', 'review', 'output']);
    expect(plan.preflight).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'input-a', state: 'planned', willExecute: false, reason: expect.objectContaining({ code: 'CONTEXT_SATISFIED' }) }),
      expect.objectContaining({ nodeId: 'transform-a', state: 'stale' }),
      expect.objectContaining({ nodeId: 'transform-b', state: 'cached' }),
      expect.objectContaining({ nodeId: 'review', state: 'planned', willExecute: false }),
      expect.objectContaining({ nodeId: 'output', state: 'planned', willExecute: false }),
    ]));
    expect(calls).toEqual(['transform-a']);
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

  it('reuses an edited accepted Transform while invalidating direct downstream cache identity', () => {
    const input = graph();
    input.nodes = input.nodes.filter((item) => ['input-a', 'transform-a', 'transform-b'].includes(item.id));
    input.edges = [
      edge('input-a-transform-a', 'input-a', 'transform-a'),
      edge('transform-a-transform-b', 'transform-a', 'transform-b'),
    ];
    addRun(input, successfulRun('transform-a', 'key-transform-a', 2));
    addRun(input, successfulRun('transform-b', 'key-transform-b', 2));
    const editedOutput = {
      assetReferenceId: 'ref-transform-a-edit', assetId: 'asset-transform-a-edit',
      relativePath: 'assets/transform-a-edit.png', contentHash: `sha256:${'a'.repeat(64)}`,
      width: 64, height: 64, mime: 'image/png' as const,
    };

    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node', nodeId: 'transform-b', materialKeys: keys(input),
      isRunRecordReusable: () => true,
      effectiveRunResults: {
        'transform-a': {
          rootRunId: input.runRecords.find((run) => run.nodeId === 'transform-a')!.id,
          materialKey: 'workflow-editor-effective-material',
          output: editedOutput,
        },
      },
    });

    expect(plan.cachedResults).toContainEqual({
      nodeId: 'transform-a', cacheKey: 'workflow-editor-effective-material',
      outputIds: ['ref-transform-a-edit'],
    });
    expect(plan.preflight).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'transform-a', state: 'cached' }),
      expect.objectContaining({ nodeId: 'transform-b', state: 'stale', willExecute: true }),
    ]));
    expect(plan.executionNodeIds).toEqual(['transform-b']);
  });

  it('feeds the edited cached result across a direct Transform to Output path', () => {
    const input = graph();
    input.nodes = input.nodes.filter((item) => ['input-a', 'transform-a', 'output'].includes(item.id));
    input.edges = [
      edge('input-a-transform-a', 'input-a', 'transform-a'),
      edge('transform-a-output', 'transform-a', 'output'),
    ];
    addRun(input, successfulRun('transform-a', 'key-transform-a', 2));
    addRun(input, successfulRun('output', 'key-output', 2));
    const rootRunId = input.runRecords.find((run) => run.nodeId === 'transform-a')!.id;
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node', nodeId: 'output', materialKeys: keys(input),
      isRunRecordReusable: () => true,
      effectiveRunResults: {
        'transform-a': {
          rootRunId,
          materialKey: 'workflow-editor-direct-output-material',
          output: {
            assetReferenceId: 'ref-direct-edit', assetId: 'asset-direct-edit',
            relativePath: 'assets/direct-edit.png', contentHash: `sha256:${'b'.repeat(64)}`,
          },
        },
      },
    });

    expect(plan.cachedResults).toContainEqual({
      nodeId: 'transform-a', cacheKey: 'workflow-editor-direct-output-material',
      outputIds: ['ref-direct-edit'],
    });
    expect(plan.cachedResults.some((result) => result.nodeId === 'output')).toBe(false);
    expect(plan.executionNodeIds).not.toContain('transform-a');
  });

  it('reports disabled and downstream blockers before execution and never invokes blocked nodes', async () => {
    const input = graph();
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-from-here',
      nodeId: 'transform-a',
      materialKeys: keys(input),
      executionRestrictions: createWorkflowExecutionRestrictions([{
        nodeId: 'transform-a',
        kind: 'unavailable',
        reason: 'Generate is disabled until an executor is configured.',
      }]),
    });
    const calls: string[] = [];
    await execute(plan, calls);

    expect(plan.preflight).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'transform-a', state: 'blocked', reason: { code: 'NODE_DISABLED', message: expect.stringContaining('executor') } }),
      expect.objectContaining({ nodeId: 'review', state: 'blocked', reason: { code: 'UPSTREAM_BLOCKED', message: expect.stringContaining('transform-a') } }),
      expect.objectContaining({ nodeId: 'output', state: 'blocked' }),
    ]));
    expect(calls).toEqual(['transform-b']);
  });

  it('exposes a missing-input root blocker without requiring a material key for blocked work', () => {
    const input = graph();
    input.edges = input.edges.filter((item) => item.id !== 'input-a-transform-a');

    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'output',
      materialKeys: { 'transform-b': 'key-transform-b' },
    });

    expect(plan.preflight).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'transform-a', state: 'blocked', reason: expect.objectContaining({ code: 'MISSING_REQUIRED_INPUT' }) }),
      expect.objectContaining({ nodeId: 'review', state: 'blocked', reason: expect.objectContaining({ code: 'UPSTREAM_BLOCKED' }) }),
      expect.objectContaining({ nodeId: 'output', state: 'blocked', reason: expect.objectContaining({ code: 'UPSTREAM_BLOCKED' }) }),
    ]));
    expect(plan.materialKeys).toEqual({ 'transform-b': 'key-transform-b' });
  });

  it('runs only Generate for the real Campaign structural topology', async () => {
    const input = instantiateWorkflowTemplate('campaign-composer', { graphId: 'selective-campaign' });
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'output-square',
      materialKeys: { 'transform-generate-square': 'key-generate' },
    });
    const calls: string[] = [];
    await execute(plan, calls);

    expect(plan.requiredNodeIds).toEqual([
      'slot-product', 'slot-subject', 'slot-style', 'brief', 'composition', 'transform-generate-square', 'output-square',
    ]);
    expect(plan.executionNodeIds).toEqual(['transform-generate-square']);
    expect(plan.preflight.map(({ nodeId, willExecute }) => [nodeId, willExecute])).toEqual([
      ['slot-product', false],
      ['slot-subject', false],
      ['slot-style', false],
      ['brief', false],
      ['composition', false],
      ['transform-generate-square', true],
      ['output-square', false],
    ]);
    expect(calls).toEqual(['transform-generate-square']);
  });

  it('blocks a configured transform capability that the registry does not support', () => {
    const input = structuredClone(instantiateWorkflowTemplate('campaign-composer'));
    input.nodes.find((candidate) => candidate.id === 'transform-generate-square')!.config.capability = 'relight';

    expect(() => createWorkflowExecutionRestrictions([{
      nodeId: 'transform-generate-square',
      kind: 'available',
    } as never])).toThrow(/only demote or disable/i);

    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'output-square',
      materialKeys: {},
    });

    expect(plan.executionNodeIds).toEqual([]);
    expect(plan.preflight).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'transform-generate-square',
        state: 'blocked',
        reason: expect.objectContaining({ code: 'NODE_DISABLED', message: expect.stringContaining('not available') }),
      }),
      expect.objectContaining({ nodeId: 'output-square', state: 'blocked' }),
    ]));
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
    input.nodes.filter((candidate) => candidate.id !== 'unrelated').forEach((candidate) => {
      candidate.type = 'transform';
      candidate.config.capability = 'generate';
    });
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
      validateResultOwnership: () => true,
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
    expect(result.results.output).toEqual({ cacheKey: 'key-output', outputIds: ['new-output'] });
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
      validateResultOwnership: () => true,
      executeNode: async () => {
        calls += 1;
        return { cacheKey: 'key-unrelated', outputIds: ['never'] };
      },
    })).rejects.toThrow(/provider concurrency.*positive safe integer/i);
    expect(calls).toBe(0);
  });

  it('sanitizes provider mapping exceptions before making executor calls', async () => {
    const input = graph();
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'unrelated',
      materialKeys: keys(input),
    });
    let calls = 0;

    const run = executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 1,
      providerKeyForNode: () => { throw new Error('/Users/private/project auth-token=secret'); },
      providerConcurrency: {},
      validateResultOwnership: () => true,
      executeNode: async () => {
        calls += 1;
        return { cacheKey: 'key-unrelated', outputIds: ['never'] };
      },
    });

    const error = await run.then(
      () => new Error('Expected provider mapping to reject.'),
      (failure: unknown) => failure as Error,
    );
    expect(error.message).toBe('Execution provider mapping for node "unrelated" could not be resolved safely.');
    expect(error.message).not.toMatch(/private|auth-token|secret/);
    expect(calls).toBe(0);
  });

  it.each(['throws', 'changes'] as const)(
    'snapshots provider limits during preflight when a second read %s',
    async (behavior) => {
      const input = graph();
      const plan = planSelectiveWorkflowExecution(input, {
        mode: 'run-node',
        nodeId: 'output',
        materialKeys: keys(input),
      });
      let reads = 0;
      let calls = 0;
      const providerConcurrency = {} as Record<string, number>;
      Object.defineProperty(providerConcurrency, 'fake', {
        enumerable: true,
        get: () => {
          reads += 1;
          if (reads === 1) return 1;
          if (behavior === 'throws') throw new Error('/private/provider-config auth=secret');
          return 2;
        },
      });

      const run = executeSelectiveWorkflowPlan(plan, {
        maxConcurrency: 2,
        providerKeyForNode: () => 'fake',
        providerConcurrency,
        validateResultOwnership: () => true,
        executeNode: async ({ nodeId, materialKey }) => {
          calls += 1;
          return { cacheKey: materialKey, outputIds: [`owned-${nodeId}`] };
        },
      });
      const error = await run.then(
        () => new Error('Expected provider preflight to reject.'),
        (failure: unknown) => failure as Error,
      );

      expect(error.message).toMatch(/provider (mapping|concurrency)/i);
      expect(error.message).not.toMatch(/private|auth|secret/);
      expect(reads).toBe(2);
      expect(calls).toBe(0);
    },
  );

  it('rejects extra result fields and foreign output ownership', async () => {
    const input = graph();
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'unrelated',
      materialKeys: keys(input),
    });

    const extra = await executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 1,
      providerKeyForNode: () => 'fake',
      providerConcurrency: { fake: 1 },
      validateResultOwnership: () => true,
      executeNode: async () => ({
        cacheKey: 'key-unrelated',
        outputIds: ['asset-unrelated'],
        foreignMetadata: '/private/path',
      } as WorkflowExecutionResult),
    });
    const foreign = await executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 1,
      providerKeyForNode: () => 'fake',
      providerConcurrency: { fake: 1 },
      validateResultOwnership: (context) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(Object.isFrozen(context.result.outputIds)).toBe(true);
        return context.result.outputIds.every((id) => id.startsWith('owned-'));
      },
      executeNode: async () => ({ cacheKey: 'key-unrelated', outputIds: ['foreign-asset'] }),
    });
    const duplicate = await executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 1,
      providerKeyForNode: () => 'fake',
      providerConcurrency: { fake: 1 },
      validateResultOwnership: () => true,
      executeNode: async () => ({ cacheKey: 'key-unrelated', outputIds: ['same', 'same'] }),
    });

    expect(extra.failures.unrelated?.code).toBe('INVALID_EXECUTOR_RESULT');
    expect(extra.results.unrelated).toBeUndefined();
    expect(foreign.failures.unrelated?.code).toBe('INVALID_EXECUTOR_RESULT');
    expect(foreign.results.unrelated).toBeUndefined();
    expect(duplicate.failures.unrelated?.code).toBe('INVALID_EXECUTOR_RESULT');
    expect(duplicate.results.unrelated).toBeUndefined();
  });

  it('requires an ownership validator before resolving providers or executing nodes', async () => {
    const input = graph();
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'unrelated',
      materialKeys: keys(input),
    });
    let boundaryCalls = 0;

    await expect(executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 1,
      providerKeyForNode: () => {
        boundaryCalls += 1;
        return 'fake';
      },
      providerConcurrency: { fake: 1 },
      validateResultOwnership: undefined as never,
      executeNode: async () => {
        boundaryCalls += 1;
        return { cacheKey: 'key-unrelated', outputIds: ['owned'] };
      },
    })).rejects.toThrow(/requires an output ownership validator/i);
    expect(boundaryCalls).toBe(0);
  });

  it('snapshots executor data once and rejects a state-changing result proxy without leakage', async () => {
    const input = graph();
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'unrelated',
      materialKeys: keys(input),
    });
    const trapReads = {
      get: 0,
      cacheKey: 0,
      outputIds: 0,
      getPrototypeOf: 0,
      ownKeys: 0,
      descriptor: 0,
    };
    const hostileResult = new Proxy({
      cacheKey: 'key-unrelated',
      outputIds: ['owned-unrelated'],
    }, {
      get: (target, property, receiver) => {
        trapReads.get += 1;
        if (property === 'then') return undefined;
        if (property === 'cacheKey') {
          trapReads.cacheKey += 1;
          return trapReads.cacheKey === 1 ? 'key-unrelated' : 'foreign-key';
        }
        if (property === 'outputIds') trapReads.outputIds += 1;
        return Reflect.get(target, property, receiver);
      },
      getPrototypeOf: () => {
        trapReads.getPrototypeOf += 1;
        throw new Error('/private/result getPrototypeOf auth=secret');
      },
      ownKeys: () => {
        trapReads.ownKeys += 1;
        throw new Error('/private/result ownKeys auth=secret');
      },
      getOwnPropertyDescriptor: () => {
        trapReads.descriptor += 1;
        throw new Error('/private/result descriptor auth=secret');
      },
    });

    const result = await executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 1,
      providerKeyForNode: () => 'fake',
      providerConcurrency: { fake: 1 },
      validateResultOwnership: () => true,
      executeNode: async () => hostileResult,
    });

    expect(result.failures.unrelated).toEqual(expect.objectContaining({ code: 'INVALID_EXECUTOR_RESULT' }));
    expect(result.failures.unrelated?.message).not.toMatch(/private|auth|secret/);
    expect(result.results.unrelated).toBeUndefined();
    expect(trapReads.cacheKey).toBe(0);
    expect(trapReads.outputIds).toBe(0);
  });

  it('validates and commits one detached snapshot when executor getters can change later', async () => {
    const input = graph();
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'unrelated',
      materialKeys: keys(input),
    });
    let cacheKeyReads = 0;
    let outputReads = 0;
    const result = await executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 1,
      providerKeyForNode: () => 'fake',
      providerConcurrency: { fake: 1 },
      validateResultOwnership: ({ result: snapshot }) => snapshot.outputIds[0] === 'owned-unrelated',
      executeNode: async () => Object.defineProperties({}, {
        cacheKey: {
          enumerable: true,
          get: () => (++cacheKeyReads === 1 ? 'key-unrelated' : 'foreign-key'),
        },
        outputIds: {
          enumerable: true,
          get: () => (++outputReads === 1 ? ['owned-unrelated'] : ['foreign-output']),
        },
      }) as WorkflowExecutionResult,
    });

    expect(cacheKeyReads).toBe(1);
    expect(outputReads).toBe(1);
    expect(result.results.unrelated).toEqual({ cacheKey: 'key-unrelated', outputIds: ['owned-unrelated'] });
  });

  it('rejects cross-node output collisions and returns a detached immutable outcome', async () => {
    const input = graph();
    input.nodes.filter((candidate) => candidate.id !== 'unrelated').forEach((candidate) => {
      candidate.type = 'transform';
      candidate.config.capability = 'generate';
    });
    const plan = planSelectiveWorkflowExecution(input, {
      mode: 'run-node',
      nodeId: 'output',
      materialKeys: keys(input),
    });

    const result = await executeSelectiveWorkflowPlan(plan, {
      maxConcurrency: 2,
      providerKeyForNode: () => 'fake',
      providerConcurrency: { fake: 2 },
      validateResultOwnership: () => true,
      executeNode: async ({ nodeId, materialKey }) => ({
        cacheKey: materialKey,
        outputIds: nodeId.startsWith('input') ? ['colliding-output'] : [`owned-${nodeId}`],
      }),
    });

    expect(result.results['input-a']).toEqual({ cacheKey: 'key-input-a', outputIds: ['colliding-output'] });
    expect(result.failures['input-b']?.code).toBe('INVALID_EXECUTOR_RESULT');
    expect(result.blockedNodeIds).toEqual(['transform-b', 'review', 'output']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.results)).toBe(true);
    expect(Object.isFrozen(result.results['input-a']?.outputIds)).toBe(true);
    expect(() => (result.results['input-a']!.outputIds as string[]).push('mutation')).toThrow();
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
      validateResultOwnership: () => true,
      executeNode: async ({ nodeId, materialKey }) => {
        if (nodeId === 'transform-a') throw new Error('transform-a failed');
        completed.push(nodeId);
        return { cacheKey: materialKey, outputIds: [`new-${nodeId}`] };
      },
    });

    expect(completed).toEqual(['transform-b']);
    expect(result.failures['transform-a']).toEqual({
      code: 'EXECUTOR_FAILED',
      message: 'Node execution failed. Retry the node or inspect safe run diagnostics.',
    });
    expect(result.failures['transform-a']?.message).not.toContain('transform-a failed');
    expect(result.blockedNodeIds).toEqual(['review']);
    expect(result.results['transform-b']).toBeDefined();
    expect(result.results.review).toBeUndefined();
  });
});
