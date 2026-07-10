import { describe, expect, it } from 'vitest';
import {
  WorkflowDomainError,
  WorkflowGraphDomain,
  type WorkflowIdGenerator,
  type WorkflowNodeDraft,
} from './domain';
import {
  WORKFLOW_GRAPH_VERSION,
  parseWorkflowGraphV2,
  type WorkflowGraphV2,
  type WorkflowNodeV2,
} from './schema';

function node(id: string, x = 0): WorkflowNodeV2 {
  return {
    id,
    type: 'brief',
    title: id,
    position: { x, y: 20 },
    size: { width: 260, height: 180 },
    color: '#3a3c42',
    ports: {
      inputs: [{ id: 'input', label: 'Input', dataType: 'prompt' }],
      outputs: [{ id: 'output', label: 'Output', dataType: 'prompt' }],
    },
    config: { objective: id },
    runRecordIds: [],
  };
}

function nodeDraft(title: string): WorkflowNodeDraft {
  const { id: _id, ...draft } = node('unused');
  return { ...draft, title };
}

function graph(): WorkflowGraphV2 {
  return {
    version: WORKFLOW_GRAPH_VERSION,
    id: 'workflow-domain-test',
    metadata: { name: 'Domain test', sourceVersion: null, migrations: [] },
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nodes: [node('source'), node('middle', 300), node('unrelated', 600)],
    edges: [
      {
        id: 'edge-source-middle',
        source: { nodeId: 'source', portId: 'output' },
        target: { nodeId: 'middle', portId: 'input' },
      },
      {
        id: 'edge-middle-unrelated',
        source: { nodeId: 'middle', portId: 'output' },
        target: { nodeId: 'unrelated', portId: 'input' },
      },
    ],
    assetReferences: [],
    runRecords: [],
  };
}

function deterministicIds(...ids: string[]): WorkflowIdGenerator {
  let index = 0;
  return (kind) => ids[index++] ?? `${kind}-${index}`;
}

describe('WorkflowGraphDomain', () => {
  it('adds nodes and edges with injected deterministic IDs and revisions', () => {
    const original = graph();
    const domain = new WorkflowGraphDomain(original, {
      idGenerator: deterministicIds('node-generated', 'edge-generated'),
      initialRevision: 7,
    });

    const added = domain.addNode(nodeDraft('Generated brief'));
    const edge = domain.addEdge({
      source: { nodeId: 'node-generated', portId: 'output' },
      target: { nodeId: 'unrelated', portId: 'input' },
    });

    expect(added.id).toBe('node-generated');
    expect(edge.id).toBe('edge-generated');
    expect(domain.revision).toBe(9);
    expect(domain.graph.nodes.at(-1)?.title).toBe('Generated brief');
    expect(domain.graph.edges.at(-1)).toEqual(edge);
    expect(original).toEqual(graph());
  });

  it('detaches nested node input and freezes the exposed snapshot', () => {
    const domain = new WorkflowGraphDomain(graph(), {
      idGenerator: deterministicIds('detached-node'),
    });
    const draft = nodeDraft('Detached');

    const added = domain.addNode(draft);
    draft.ports.outputs[0].label = 'Caller mutation';
    draft.config.objective = 'Caller mutation';

    expect(added.ports.outputs[0].label).toBe('Output');
    expect(added.config.objective).toBe('unused');
    expect(Object.isFrozen(domain.graph)).toBe(true);
    expect(Object.isFrozen(domain.graph.nodes)).toBe(true);
    expect(Object.isFrozen(added.config)).toBe(true);
  });

  it('moves, resizes, and configures nodes without mutating earlier snapshots or caller input', () => {
    const domain = new WorkflowGraphDomain(graph());
    const before = domain.graph;
    const config = { objective: 'Updated', nested: { strength: 0.8 } };

    domain.moveNode('middle', { x: 412.5, y: 87 });
    domain.resizeNode('middle', { width: 320, height: 240 });
    domain.configureNode('middle', config);
    config.nested.strength = 0.1;

    expect(domain.revision).toBe(3);
    expect(domain.graph.nodes.find((item) => item.id === 'middle')).toMatchObject({
      position: { x: 412.5, y: 87 },
      size: { width: 320, height: 240 },
      config: { objective: 'Updated', nested: { strength: 0.8 } },
    });
    expect(before.nodes.find((item) => item.id === 'middle')).toMatchObject({
      position: { x: 300, y: 20 },
      size: { width: 260, height: 180 },
      config: { objective: 'middle' },
    });
  });

  it('removes a node and only the edges connected to that node', () => {
    const initial = graph();
    initial.nodes.push(node('other-source', 900));
    initial.edges.push({
      id: 'edge-unrelated',
      source: { nodeId: 'other-source', portId: 'output' },
      target: { nodeId: 'unrelated', portId: 'input' },
    });
    initial.assetReferences.push({
      id: 'source-asset',
      role: 'source',
      assetId: 'asset-1',
      relativePath: 'assets/source.png',
    });
    initial.nodes[0].runRecordIds = ['run-1'];
    initial.runRecords.push({ id: 'run-1', nodeId: 'source', status: 'succeeded' });
    const domain = new WorkflowGraphDomain(initial);

    domain.removeNode('middle');

    expect(domain.graph.nodes.map((item) => item.id)).toEqual(['source', 'unrelated', 'other-source']);
    expect(domain.graph.edges).toEqual([initial.edges[2]]);
    expect(domain.graph.assetReferences).toEqual(initial.assetReferences);
    expect(domain.graph.runRecords).toEqual(initial.runRecords);
    expect(domain.revision).toBe(1);
  });

  it('does not advance revisions for no-ops or rejected operations', () => {
    const domain = new WorkflowGraphDomain(graph(), { initialRevision: 4 });

    domain.moveNode('source', { x: 0, y: 20 });
    domain.resizeNode('source', { width: 260, height: 180 });
    domain.configureNode('source', { objective: 'source' });
    domain.updateEdge('edge-source-middle', {
      source: { nodeId: 'source', portId: 'output' },
      target: { nodeId: 'middle', portId: 'input' },
    });
    expect(() => domain.removeNode('missing')).toThrowError(WorkflowDomainError);

    expect(domain.revision).toBe(4);
  });

  it('atomically adds a node and its attached edge on a shadow graph', () => {
    const domain = new WorkflowGraphDomain(graph(), {
      idGenerator: deterministicIds('attached-node', 'attached-edge'),
    });
    const result = domain.addNodeWithEdge(nodeDraft('Attached node'), {
      direction: 'outgoing',
      nodePortId: 'output',
      other: { nodeId: 'source', portId: 'input' },
    });

    expect(result.node.id).toBe('attached-node');
    expect(result.edge).toEqual({
      id: 'attached-edge',
      source: { nodeId: 'attached-node', portId: 'output' },
      target: { nodeId: 'source', portId: 'input' },
    });
    expect(domain.revision).toBe(2);
  });

  it('does not partially publish when the attached edge fails and documents ID consumption', () => {
    const domain = new WorkflowGraphDomain(graph(), {
      idGenerator: deterministicIds('transient-node', 'edge-source-middle', 'node-after-failure'),
    });
    const before = domain.graph;

    expect(() => domain.addNodeWithEdge(nodeDraft('Transient node'), {
      direction: 'outgoing',
      nodePortId: 'output',
      other: { nodeId: 'source', portId: 'input' },
    })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_EDGE_ID' }));

    expect(domain.graph).toBe(before);
    expect(domain.node('transient-node')).toBeNull();
    expect(domain.revision).toBe(0);
    expect(domain.addNode(nodeDraft('After failure')).id).toBe('node-after-failure');
  });

  it('does not publish the node when future attached-edge validation fails', () => {
    const domain = new WorkflowGraphDomain(graph(), {
      idGenerator: deterministicIds('transient-node', 'transient-edge'),
    });

    expect(() => domain.addNodeWithEdge(nodeDraft('Transient node'), {
      direction: 'incoming',
      nodePortId: 'input',
      other: { nodeId: 'future-missing-node', portId: 'output' },
    })).toThrowError(expect.objectContaining({ code: 'ENDPOINT_NODE_NOT_FOUND' }));

    expect(domain.node('transient-node')).toBeNull();
    expect(domain.revision).toBe(0);
  });

  it('rejects an invalid attached-edge direction before shadow work or ID consumption', () => {
    let generatedIds = 0;
    const domain = new WorkflowGraphDomain(graph(), {
      idGenerator: (kind) => `${kind}-${++generatedIds}`,
    });
    const before = domain.graph;

    expect(() => domain.addNodeWithEdge(nodeDraft('Invalid direction'), {
      direction: 'sideways' as never,
      nodePortId: 'output',
      other: { nodeId: 'source', portId: 'input' },
    })).toThrowError(expect.objectContaining({
      code: 'INVALID_ATTACHED_EDGE_DIRECTION',
      message: 'Attached edge direction must be incoming or outgoing.',
    }));

    expect(domain.graph).toBe(before);
    expect(domain.revision).toBe(0);
    expect(generatedIds).toBe(0);
  });

  it('updates and removes edges through controlled immutable operations', () => {
    const domain = new WorkflowGraphDomain(graph());
    const before = domain.graph;

    domain.updateEdge('edge-source-middle', {
      source: { nodeId: 'source', portId: 'alternate-output' },
      target: { nodeId: 'unrelated', portId: 'alternate-input' },
    });
    domain.removeEdge('edge-middle-unrelated');

    expect(domain.graph.edges).toEqual([{
      id: 'edge-source-middle',
      source: { nodeId: 'source', portId: 'alternate-output' },
      target: { nodeId: 'unrelated', portId: 'alternate-input' },
    }]);
    expect(before.edges).toHaveLength(2);
    expect(domain.revision).toBe(2);
  });

  it('provides read-only lookup and connection helpers for reactive adapters', () => {
    const domain = new WorkflowGraphDomain(graph());

    expect(domain.node('middle')?.title).toBe('middle');
    expect(domain.node('missing')).toBeNull();
    expect(domain.edge('edge-source-middle')?.source.nodeId).toBe('source');
    expect(domain.edge('missing')).toBeNull();
    expect(domain.incoming('middle').map((edge) => edge.id)).toEqual(['edge-source-middle']);
    expect(domain.outgoing('middle').map((edge) => edge.id)).toEqual(['edge-middle-unrelated']);
    expect(domain.isConnected('source', 'middle')).toBe(true);
    expect(domain.isConnected('middle', 'source')).toBe(false);
  });

  it('keeps graph invariants independent from external selection state', () => {
    const first = new WorkflowGraphDomain(graph());
    const second = new WorkflowGraphDomain(graph());
    const selection = { kind: 'node', id: 'middle' };

    first.removeNode(selection.id);
    selection.id = 'unrelated';
    second.removeNode('middle');

    expect(first.graph).toEqual(second.graph);
    expect(first.revision).toBe(second.revision);
  });

  it('returns a detached graph at the serialization boundary', () => {
    const domain = new WorkflowGraphDomain(graph());
    domain.configureNode('source', { nested: { value: 3 } });

    const serialized = domain.serialize();
    const parsed = parseWorkflowGraphV2(JSON.parse(serialized));

    expect(parsed.ok).toBe(true);
    expect(parsed.value).toEqual(domain.graph);
    expect(parsed.value).not.toBe(domain.graph);
    expect(JSON.parse(serialized)).not.toHaveProperty('revision');
  });

  it('does not advance revision for configuration equivalent after signed-zero normalization', () => {
    const input = graph();
    input.nodes[0].config = { value: 0 };
    const domain = new WorkflowGraphDomain(input);

    domain.configureNode('source', { value: -0 });
    domain.updateNode('source', { config: { value: -0 } });

    expect(domain.revision).toBe(0);
    expect(domain.node('source')?.config).toEqual({ value: 0 });
    expect(Object.is(domain.node('source')?.config.value, -0)).toBe(false);
  });

  it.each([
    ['missing node', () => new WorkflowGraphDomain(graph()).moveNode('missing', { x: 1, y: 2 }), 'NODE_NOT_FOUND'],
    ['invalid position', () => new WorkflowGraphDomain(graph()).moveNode('source', { x: Number.NaN, y: 2 }), 'INVALID_POSITION'],
    ['invalid size', () => new WorkflowGraphDomain(graph()).resizeNode('source', { width: 0, height: 2 }), 'INVALID_SIZE'],
    ['missing edge', () => new WorkflowGraphDomain(graph()).removeEdge('missing'), 'EDGE_NOT_FOUND'],
    [
      'missing endpoint node',
      () => new WorkflowGraphDomain(graph()).addEdge({
        id: 'invalid-edge',
        source: { nodeId: 'missing', portId: 'output' },
        target: { nodeId: 'source', portId: 'input' },
      }),
      'ENDPOINT_NODE_NOT_FOUND',
    ],
    ['duplicate node id', () => new WorkflowGraphDomain(graph()).addNode(node('source')), 'DUPLICATE_NODE_ID'],
    [
      'duplicate edge id',
      () => new WorkflowGraphDomain(graph()).addEdge({
        id: 'edge-source-middle',
        source: { nodeId: 'source', portId: 'output' },
        target: { nodeId: 'unrelated', portId: 'input' },
      }),
      'DUPLICATE_EDGE_ID',
    ],
  ])('reports a domain error for %s', (_name, action, code) => {
    expect(action).toThrowError(WorkflowDomainError);
    expect(action).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects invalid initial graph invariants without changing the input', () => {
    const input = graph();
    input.edges[0].target.nodeId = 'missing';

    expect(() => new WorkflowGraphDomain(input)).toThrowError(expect.objectContaining({
      code: 'ENDPOINT_NODE_NOT_FOUND',
    }));
    expect(input.edges[0].target.nodeId).toBe('missing');
  });

  it.each([
    ['undefined', { value: undefined }],
    ['NaN', { value: Number.NaN }],
    ['Infinity', { value: Number.POSITIVE_INFINITY }],
    ['BigInt', { value: BigInt(3) }],
    ['symbol', { value: Symbol('unsafe') }],
    ['function', { value: () => 'unsafe' }],
    ['Date', { value: new Date('2026-07-10T00:00:00Z') }],
    ['Map', { value: new Map([['key', 'value']]) }],
  ])('rejects JSON-lossy %s configuration with a stable domain error', (_name, config) => {
    const domain = new WorkflowGraphDomain(graph());

    expect(() => domain.configureNode('source', config)).toThrowError(expect.objectContaining({
      code: 'INVALID_JSON_VALUE',
    }));
    expect(domain.revision).toBe(0);
  });

  it('rejects cyclic and symbol-keyed configuration without leaking raw serializer errors', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const symbolKeyed = { visible: true } as Record<string | symbol, unknown>;
    symbolKeyed[Symbol('hidden')] = true;
    const domain = new WorkflowGraphDomain(graph());

    expect(() => domain.configureNode('source', cyclic)).toThrowError(expect.objectContaining({
      code: 'INVALID_JSON_VALUE',
    }));
    expect(() => domain.configureNode('source', symbolKeyed)).toThrowError(expect.objectContaining({
      code: 'INVALID_JSON_VALUE',
    }));
  });

  it('wraps hostile object inspection failures in a stable domain error', () => {
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error('inspection failed');
      },
    });
    const domain = new WorkflowGraphDomain(graph());

    expect(() => domain.configureNode('source', hostile)).toThrowError(expect.objectContaining({
      code: 'INVALID_JSON_VALUE',
    }));
  });

  it.each([
    ['node position', (input: WorkflowGraphV2) => { input.nodes[0].position.x = -0; }],
    ['viewport', (input: WorkflowGraphV2) => { input.viewport.panX = -0; }],
    ['migration metadata', (input: WorkflowGraphV2) => { input.metadata.migrations = [{ from: -0, to: 2 }]; }],
  ])('normalizes negative zero at the %s persistence boundary', (_name, mutate) => {
    const input = graph();
    mutate(input);
    const domain = new WorkflowGraphDomain(input);
    const serialized = domain.serialize();
    const roundTrip = parseWorkflowGraphV2(JSON.parse(serialized));

    expect(serialized).not.toContain('-0');
    expect(roundTrip.value).toEqual(domain.graph);
  });

  it('enforces unique asset/run IDs and bidirectional run-record links', () => {
    const duplicateAsset = graph();
    duplicateAsset.assetReferences = [
      { id: 'asset-ref', role: 'source', assetId: 'asset-1', relativePath: null },
      { id: 'asset-ref', role: 'output', assetId: 'asset-2', relativePath: null },
    ];
    const duplicateRun = graph();
    duplicateRun.nodes[0].runRecordIds = ['run-1'];
    duplicateRun.runRecords = [
      { id: 'run-1', nodeId: 'source' },
      { id: 'run-1', nodeId: 'source' },
    ];
    const missingRunNode = graph();
    missingRunNode.runRecords = [{ id: 'run-1', nodeId: 'missing' }];
    const unlinkedRun = graph();
    unlinkedRun.runRecords = [{ id: 'run-1', nodeId: 'source' }];
    const wrongNodeLink = graph();
    wrongNodeLink.nodes[1].runRecordIds = ['run-1'];
    wrongNodeLink.runRecords = [{ id: 'run-1', nodeId: 'source' }];

    expect(() => new WorkflowGraphDomain(duplicateAsset)).toThrowError(expect.objectContaining({ code: 'DUPLICATE_ASSET_REFERENCE_ID' }));
    expect(() => new WorkflowGraphDomain(duplicateRun)).toThrowError(expect.objectContaining({ code: 'DUPLICATE_RUN_RECORD_ID' }));
    expect(() => new WorkflowGraphDomain(missingRunNode)).toThrowError(expect.objectContaining({ code: 'RUN_RECORD_NODE_NOT_FOUND' }));
    expect(() => new WorkflowGraphDomain(unlinkedRun)).toThrowError(expect.objectContaining({ code: 'RUN_RECORD_LINK_MISSING' }));
    expect(() => new WorkflowGraphDomain(wrongNodeLink)).toThrowError(expect.objectContaining({ code: 'RUN_RECORD_LINK_MISMATCH' }));
  });

  it('removes the deleted node run records while preserving unrelated history in order', () => {
    const initial = graph();
    initial.nodes[0].runRecordIds = ['run-source-1', 'run-source-2'];
    initial.nodes[1].runRecordIds = ['run-middle'];
    initial.runRecords = [
      { id: 'run-source-1', nodeId: 'source', status: 'succeeded' },
      { id: 'run-middle', nodeId: 'middle', status: 'failed' },
      { id: 'run-source-2', nodeId: 'source', status: 'succeeded' },
    ];
    const domain = new WorkflowGraphDomain(initial);

    domain.removeNode('middle');

    expect(domain.graph.runRecords.map((run) => run.id)).toEqual(['run-source-1', 'run-source-2']);
    expect(domain.node('source')?.runRecordIds).toEqual(['run-source-1', 'run-source-2']);
  });
});
