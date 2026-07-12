import { describe, expect, it } from 'vitest';
import {
  WorkflowExecutionError,
  WorkflowExecutionRuntime,
  affectedWorkflowNodes,
  createWorkflowCacheKey,
  planWorkflowExecution,
  type WorkflowCacheKeyMaterial,
  type WorkflowNodeRuntimeStateName,
} from './execution';
import {
  WORKFLOW_GRAPH_VERSION,
  type WorkflowEdgeV2,
  type WorkflowGraphV2,
  type WorkflowNodeV2,
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
    config: { operation: type, settings: { strength: 0.8 } },
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

function branchedGraph(): WorkflowGraphV2 {
  return {
    version: WORKFLOW_GRAPH_VERSION,
    id: 'execution-test',
    metadata: { name: 'Execution test', sourceVersion: null, migrations: [] },
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

describe('workflow execution planning', () => {
  it('computes the requested upstream closure and deterministic concurrent batches', () => {
    const plan = planWorkflowExecution(branchedGraph(), 'output', { maxConcurrency: 2 });

    expect(plan.requiredNodeIds).toEqual([
      'input-a',
      'input-b',
      'transform-a',
      'transform-b',
      'review',
      'output',
    ]);
    expect(plan.executionOrder).toEqual(plan.batches.flat());
    expect(plan.batches).toEqual([
      ['input-a', 'input-b'],
      ['transform-a', 'transform-b'],
      ['review'],
      ['output'],
    ]);
    expect(plan.blocked).toEqual([]);
  });

  it('splits independently runnable work at the adapter concurrency limit', () => {
    const plan = planWorkflowExecution(branchedGraph(), 'output', { maxConcurrency: 1 });

    expect(plan.batches).toEqual([
      ['input-a'],
      ['input-b'],
      ['transform-a'],
      ['transform-b'],
      ['review'],
      ['output'],
    ]);
    expect(plan.batches.every((batch) => batch.length <= 1)).toBe(true);
  });

  it('recognizes matching cache entries and prunes cached branch work', () => {
    const plan = planWorkflowExecution(branchedGraph(), 'output', {
      maxConcurrency: 3,
      cacheKeys: {
        'transform-a': 'key-transform-a',
        'input-a': 'key-input-a',
      },
      cacheEntries: [
        { nodeId: 'transform-a', cacheKey: 'key-transform-a', outputIds: ['accepted-a'] },
        { nodeId: 'input-a', cacheKey: 'key-input-a', outputIds: ['source-a'] },
        { nodeId: 'input-b', cacheKey: 'old-key', outputIds: ['stale-b'] },
      ],
    });

    expect(plan.requiredNodeIds).toContain('input-a');
    expect(plan.cachedNodeIds).toEqual(['input-a', 'transform-a']);
    expect(plan.executionOrder).not.toContain('input-a');
    expect(plan.executionOrder).not.toContain('transform-a');
    expect(plan.batches).toEqual([
      ['input-b'],
      ['transform-b'],
      ['review'],
      ['output'],
    ]);
  });

  it('lets an eligible cached child prune its uncached ancestors', () => {
    const plan = planWorkflowExecution(branchedGraph(), 'output', {
      maxConcurrency: 2,
      cacheKeys: { 'transform-a': 'key-transform-a' },
      cacheEntries: [{ nodeId: 'transform-a', cacheKey: 'key-transform-a', outputIds: ['accepted-a'] }],
    });

    expect(plan.cachedNodeIds).toEqual(['transform-a']);
    expect(plan.executionOrder).not.toContain('transform-a');
    expect(plan.executionOrder).not.toContain('input-a');
  });

  it('determines unsupported, missing-input, and upstream blocking before cache reuse', () => {
    const graph = branchedGraph();
    graph.edges = graph.edges.filter((item) => item.id !== 'input-a-transform-a');
    const plan = planWorkflowExecution(graph, 'output', {
      maxConcurrency: 2,
      cacheKeys: {
        'transform-a': 'key-transform-a',
        review: 'key-review',
        output: 'key-output',
      },
      cacheEntries: [
        { nodeId: 'transform-a', cacheKey: 'key-transform-a', outputIds: ['cached-transform'] },
        { nodeId: 'review', cacheKey: 'key-review', outputIds: ['cached-review'] },
        { nodeId: 'output', cacheKey: 'key-output', outputIds: ['cached-output'] },
      ],
    });

    expect(plan.cachedNodeIds).toEqual([]);
    expect(plan.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'transform-a', code: 'MISSING_REQUIRED_INPUT' }),
      expect.objectContaining({ nodeId: 'review', code: 'UPSTREAM_BLOCKED' }),
      expect.objectContaining({ nodeId: 'output', code: 'UPSTREAM_BLOCKED' }),
    ]));

    const unsupported = branchedGraph();
    unsupported.nodes.push(node('future', 'unsupported'));
    const futurePlan = planWorkflowExecution(unsupported, 'future', {
      maxConcurrency: 1,
      cacheKeys: { future: 'future-key' },
      cacheEntries: [{ nodeId: 'future', cacheKey: 'future-key', outputIds: ['future-output'] }],
    });
    expect(futurePlan.cachedNodeIds).toEqual([]);
    expect(futurePlan.blocked).toEqual([expect.objectContaining({ nodeId: 'future', code: 'UNSUPPORTED_NODE' })]);
  });

  it.each([
    ['empty outputs', []],
    ['empty output ID', ['']],
    ['blank output ID', ['   ']],
    ['duplicate output IDs', ['same', 'same']],
    ['non-string output ID', ['valid', 3] as never],
  ])('does not prune with a cache entry containing %s', (_name, outputIds) => {
    const plan = planWorkflowExecution(branchedGraph(), 'output', {
      maxConcurrency: 2,
      cacheKeys: { 'transform-a': 'key-transform-a' },
      cacheEntries: [{ nodeId: 'transform-a', cacheKey: 'key-transform-a', outputIds }],
    });

    expect(plan.cachedNodeIds).toEqual([]);
    expect(plan.executionOrder).toContain('transform-a');
    expect(plan.executionOrder).toContain('input-a');
  });

  it('rejects conflicting duplicate cache results independent of entry order', () => {
    const first = { nodeId: 'transform-a', cacheKey: 'key-transform-a', outputIds: ['first'] };
    const second = { nodeId: 'transform-a', cacheKey: 'key-transform-a', outputIds: ['second'] };
    const plan = (cacheEntries: typeof first[]) => planWorkflowExecution(branchedGraph(), 'output', {
      maxConcurrency: 2,
      cacheKeys: { 'transform-a': 'key-transform-a' },
      cacheEntries,
    });

    expect(plan([first, second]).cachedNodeIds).toEqual([]);
    expect(plan([second, first]).cachedNodeIds).toEqual([]);
    expect(plan([first, { ...first }]).cachedNodeIds).toEqual(['transform-a']);
  });

  it('uses the adapter reusability hook and treats false or exceptions as cache misses', () => {
    const options = {
      maxConcurrency: 2,
      cacheKeys: { 'transform-a': 'key-transform-a' },
      cacheEntries: [{ nodeId: 'transform-a', cacheKey: 'key-transform-a', outputIds: ['referenced-output'] }],
    };

    expect(planWorkflowExecution(branchedGraph(), 'output', {
      ...options,
      isCacheEntryReusable: () => true,
    }).cachedNodeIds).toEqual(['transform-a']);
    expect(planWorkflowExecution(branchedGraph(), 'output', {
      ...options,
      isCacheEntryReusable: () => false,
    }).cachedNodeIds).toEqual([]);
    expect(planWorkflowExecution(branchedGraph(), 'output', {
      ...options,
      isCacheEntryReusable: () => { throw new Error('Referenced output is missing'); },
    }).cachedNodeIds).toEqual([]);
  });

  it('ignores dormant edges and blocks a requested unsupported node with a clear reason', () => {
    const graph = branchedGraph();
    graph.nodes.push(node('future', 'unsupported'));
    graph.edges.push(edge('future-output', 'future', 'output'));

    const outputPlan = planWorkflowExecution(graph, 'output', { maxConcurrency: 2 });
    const futurePlan = planWorkflowExecution(graph, 'future', { maxConcurrency: 2 });

    expect(outputPlan.requiredNodeIds).not.toContain('future');
    expect(futurePlan.executionOrder).toEqual([]);
    expect(futurePlan.blocked).toEqual([{
      nodeId: 'future',
      code: 'UNSUPPORTED_NODE',
      message: 'Node "future" uses an unsupported workflow type and cannot be executed.',
    }]);
  });

  it('blocks nodes with missing required inputs and propagates the reason downstream', () => {
    const graph = branchedGraph();
    graph.edges = graph.edges.filter((item) => item.id !== 'input-a-transform-a');

    const plan = planWorkflowExecution(graph, 'output', { maxConcurrency: 2 });

    expect(plan.blocked).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'transform-a', code: 'MISSING_REQUIRED_INPUT' }),
      expect.objectContaining({ nodeId: 'review', code: 'UPSTREAM_BLOCKED' }),
      expect.objectContaining({ nodeId: 'output', code: 'UPSTREAM_BLOCKED' }),
    ]));
    expect(plan.executionOrder).not.toContain('transform-a');
    expect(plan.executionOrder).not.toContain('review');
    expect(plan.executionOrder).not.toContain('output');
  });
});

describe('workflow cache keys', () => {
  const material: WorkflowCacheKeyMaterial = {
    nodeType: 'transform',
    materialInputs: [
      { portId: 'image', contentHash: 'image-sha' },
      { portId: 'mask', contentHash: 'mask-sha' },
    ],
    effectiveConfig: { prompt: 'Campaign', nested: { guidance: 7, preserve: true } },
    executorVersion: 'generate-image@3',
    providerOptions: { model: 'gpt-image-2', quality: 'high' },
  };

  it('canonically serializes explicit material through an injected browser-safe hash', () => {
    const reordered: WorkflowCacheKeyMaterial = {
      ...material,
      effectiveConfig: { nested: { preserve: true, guidance: 7 }, prompt: 'Campaign' },
      providerOptions: { quality: 'high', model: 'gpt-image-2' },
    };
    const seen: string[] = [];
    const hash = (canonical: string) => {
      seen.push(canonical);
      return `hash-${canonical.length}`;
    };

    expect(createWorkflowCacheKey(material, hash)).toBe(createWorkflowCacheKey(reordered, hash));
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toContain('"executorVersion":"generate-image@3"');
    expect(seen[0]).toContain('"providerOptions"');
  });

  it.each([
    ['material input', { ...material, materialInputs: [{ portId: 'image', contentHash: 'different' }] }],
    ['effective config', { ...material, effectiveConfig: { prompt: 'Different' } }],
    ['executor version', { ...material, executorVersion: 'generate-image@4' }],
    ['provider options', { ...material, providerOptions: { model: 'other-model', quality: 'high' } }],
  ] satisfies Array<[string, WorkflowCacheKeyMaterial]>)('changes when %s changes', (_name, changed) => {
    const identityHash = (canonical: string) => canonical;
    expect(createWorkflowCacheKey(changed, identityHash)).not.toBe(createWorkflowCacheKey(material, identityHash));
  });

  it('rejects non-canonical material before invoking the hash', () => {
    let hashCalls = 0;
    expect(() => createWorkflowCacheKey({
      ...material,
      effectiveConfig: { unsafe: undefined },
    }, () => {
      hashCalls += 1;
      return 'never';
    })).toThrow(/JSON-safe/i);
    expect(hashCalls).toBe(0);
  });
});

describe('workflow runtime state and staleness', () => {
  function complete(runtime: WorkflowExecutionRuntime, nodeId: string, outputId = `${nodeId}-result`): void {
    if (runtime.node(nodeId).state === 'blocked') runtime.retry(nodeId);
    runtime.start(nodeId);
    runtime.succeed(nodeId, { cacheKey: `key-${nodeId}`, outputIds: [outputId] });
  }

  it('covers every runtime state with deterministic recoverable transitions', () => {
    const runtime = new WorkflowExecutionRuntime(branchedGraph(), { clock: (() => {
      let value = 100;
      return () => value++;
    })() });

    expect(runtime.node('input-a').state).toBe('ready');
    expect(runtime.node('transform-a')).toMatchObject({ state: 'blocked', blockReason: { code: 'WAITING_FOR_DEPENDENCIES' } });

    const running = runtime.start('input-a');
    expect(running).toMatchObject({ state: 'running', attempt: 1, activeRunId: 'input-a:attempt-1', startedAt: 100 });
    runtime.succeed('input-a', { cacheKey: 'key-input-a', outputIds: ['candidate-a'] });
    expect(runtime.node('input-a')).toMatchObject({ state: 'succeeded', finishedAt: 101 });
    expect(runtime.node('transform-a').state).toBe('ready');

    runtime.start('transform-a');
    runtime.fail('transform-a', { code: 'PROVIDER_ERROR', message: 'Provider failed' });
    expect(runtime.node('transform-a')).toMatchObject({ state: 'failed', error: { code: 'PROVIDER_ERROR' } });
    expect(runtime.retry('transform-a').state).toBe('ready');

    runtime.start('transform-a');
    runtime.cancel('transform-a', 'Cancelled by creator');
    expect(runtime.node('transform-a')).toMatchObject({ state: 'cancelled', error: { code: 'CANCELLED' } });
    expect(runtime.retry('transform-a').state).toBe('ready');
    expect(runtime.start('transform-a')).toMatchObject({ attempt: 3, state: 'running' });
    runtime.succeed('transform-a', { cacheKey: 'key-transform-a', outputIds: ['candidate-transform-a'] });
    runtime.invalidateMaterialChange('transform-a');
    expect(runtime.node('transform-a').state).toBe('stale');

    const states: WorkflowNodeRuntimeStateName[] = [
      'blocked', 'ready', 'running', 'succeeded', 'failed', 'stale', 'cancelled',
    ];
    expect(states).toHaveLength(7);
  });

  it('stales only the changed node and affected downstream branch', () => {
    const runtime = new WorkflowExecutionRuntime(branchedGraph());
    for (const nodeId of ['input-a', 'input-b', 'transform-a', 'transform-b', 'review', 'output', 'unrelated']) {
      complete(runtime, nodeId);
    }

    expect(affectedWorkflowNodes(branchedGraph(), ['input-a'])).toEqual([
      'input-a', 'transform-a', 'review', 'output',
    ]);
    expect(runtime.invalidateMaterialChange('input-a')).toEqual([
      'input-a', 'transform-a', 'review', 'output',
    ]);
    expect(runtime.node('input-a').state).toBe('stale');
    expect(runtime.node('transform-a').state).toBe('stale');
    expect(runtime.node('review').state).toBe('stale');
    expect(runtime.node('output').state).toBe('stale');
    expect(runtime.node('input-b').state).toBe('succeeded');
    expect(runtime.node('transform-b').state).toBe('succeeded');
    expect(runtime.node('unrelated').state).toBe('succeeded');
  });

  it('blocks ready downstream work until its stale upstream dependency succeeds again', () => {
    const runtime = new WorkflowExecutionRuntime(branchedGraph());
    runtime.start('input-a');
    runtime.succeed('input-a', { cacheKey: 'first-input', outputIds: ['first-source'] });
    expect(runtime.node('transform-a').state).toBe('ready');

    runtime.invalidateMaterialChange('input-a');
    expect(runtime.node('input-a').state).toBe('stale');
    expect(runtime.node('transform-a')).toMatchObject({
      state: 'blocked',
      blockReason: { code: 'WAITING_FOR_DEPENDENCIES' },
    });

    runtime.retry('input-a');
    runtime.start('input-a');
    runtime.succeed('input-a', { cacheKey: 'second-input', outputIds: ['second-source'] });
    expect(runtime.node('transform-a').state).toBe('ready');
  });

  it('keeps accepted output history separate from failed, cancelled, and retried active attempts', () => {
    const runtime = new WorkflowExecutionRuntime(branchedGraph(), { clock: () => 500 });
    runtime.start('unrelated');
    runtime.succeed('unrelated', { cacheKey: 'first-key', outputIds: ['first-candidate'] });
    runtime.acceptOutput('unrelated', { id: 'accepted-first', assetReferenceId: 'asset-first' });

    runtime.invalidateMaterialChange('unrelated');
    runtime.retry('unrelated');
    runtime.start('unrelated');
    runtime.fail('unrelated', { code: 'FAILED_SECOND', message: 'Second attempt failed' });
    runtime.retry('unrelated');
    runtime.start('unrelated');
    runtime.cancel('unrelated', 'Stopped third attempt');

    expect(runtime.node('unrelated').acceptedOutputs).toEqual([{
      id: 'accepted-first',
      assetReferenceId: 'asset-first',
      acceptedAt: 500,
    }]);
    expect(runtime.node('unrelated').lastResult).toEqual({
      cacheKey: 'first-key',
      outputIds: ['first-candidate'],
    });
  });

  it('rejects invalid transitions without partially changing runtime state', () => {
    const runtime = new WorkflowExecutionRuntime(branchedGraph());
    const before = runtime.node('transform-a');

    expect(() => runtime.start('transform-a')).toThrowError(expect.objectContaining({
      name: 'WorkflowExecutionError',
      code: 'INVALID_TRANSITION',
    }));
    runtime.start('input-a');
    expect(() => runtime.succeed('input-a', { cacheKey: 'key', outputIds: [] })).toThrow(WorkflowExecutionError);
    expect(runtime.node('input-a').state).toBe('running');
    expect(runtime.node('transform-a')).toEqual(before);
  });

  it.each([
    ['empty outputs', []],
    ['empty output ID', ['']],
    ['blank output ID', ['  ']],
    ['duplicate output IDs', ['same', 'same']],
    ['non-string output ID', ['valid', 3] as never],
  ])('rejects successful runtime results containing %s atomically', (_name, outputIds) => {
    const runtime = new WorkflowExecutionRuntime(branchedGraph());
    runtime.start('unrelated');
    const before = runtime.node('unrelated');

    expect(() => runtime.succeed('unrelated', { cacheKey: 'key', outputIds })).toThrowError(expect.objectContaining({
      code: 'INVALID_ARGUMENT',
    }));
    expect(runtime.node('unrelated')).toEqual(before);
  });

  it('validates every injected clock read before mutating state', () => {
    const failures: Array<[string, () => number]> = [
      ['NaN', () => Number.NaN],
      ['Infinity', () => Number.POSITIVE_INFINITY],
      ['throw', () => { throw new Error('clock failed'); }],
    ];
    const actions = ['start', 'succeed', 'fail', 'cancel', 'accept'] as const;
    for (const [_failureName, failClock] of failures) {
      for (const action of actions) {
        const prerequisiteReads = action === 'start' ? 0 : action === 'accept' ? 2 : 1;
        let reads = 0;
        const runtime = new WorkflowExecutionRuntime(branchedGraph(), {
          clock: () => {
            reads += 1;
            return reads <= prerequisiteReads ? reads : failClock();
          },
        });
        if (action !== 'start') runtime.start('unrelated');
        if (action === 'accept') {
          runtime.succeed('unrelated', { cacheKey: 'key', outputIds: ['output'] });
        }
        const before = runtime.node('unrelated');
        const run = () => {
          if (action === 'start') runtime.start('unrelated');
          else if (action === 'succeed') runtime.succeed('unrelated', { cacheKey: 'key', outputIds: ['output'] });
          else if (action === 'fail') runtime.fail('unrelated', { code: 'FAILED', message: 'failed' });
          else if (action === 'cancel') runtime.cancel('unrelated', 'cancelled');
          else runtime.acceptOutput('unrelated', { id: 'output' });
        };
        expect(run).toThrowError(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
        expect(runtime.node('unrelated')).toEqual(before);
      }
    }
  });

  it('returns detached frozen plans and runtime snapshots', () => {
    const graph = branchedGraph();
    const plan = planWorkflowExecution(graph, 'output', { maxConcurrency: 2 });
    const runtime = new WorkflowExecutionRuntime(graph);
    const state = runtime.node('input-a');

    graph.nodes[0].title = 'Caller mutation';
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.batches)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(runtime.node('input-a').nodeId).toBe('input-a');
    expect(() => plan.batches[0].push('mutation')).toThrow();
    expect(() => state.acceptedOutputs.push({ id: 'mutation', acceptedAt: 0 })).toThrow();
  });
});
