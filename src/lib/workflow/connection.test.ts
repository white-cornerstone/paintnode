import { describe, expect, it } from 'vitest';
import {
  WorkflowDomainError,
  WorkflowGraphDomain,
  type WorkflowConnectionRejectionCode,
} from './domain';
import {
  WORKFLOW_GRAPH_VERSION,
  parseWorkflowGraphV2,
  type WorkflowGraphV2,
  type WorkflowNodePort,
  type WorkflowPortDataType,
} from './schema';

const connectableTypes = [
  'image',
  'image-collection',
  'mask',
  'prompt',
  'layout',
  'layered-document',
  'asset-reference',
  'review-decision',
] as const satisfies readonly WorkflowPortDataType[];

function port(
  id: string,
  dataType: WorkflowPortDataType,
  options: Partial<Pick<WorkflowNodePort, 'multiple' | 'required'>> = {},
): WorkflowNodePort {
  return { id, label: id, dataType, ...options };
}

function graph(
  sourceType: WorkflowPortDataType = 'image',
  targetType: WorkflowPortDataType = sourceType,
): WorkflowGraphV2 {
  return {
    version: WORKFLOW_GRAPH_VERSION,
    id: 'typed-connections',
    metadata: { name: 'Typed connections', sourceVersion: null, migrations: [] },
    viewport: { panX: 0, panY: 0, zoom: 1 },
    nodes: [
      {
        id: 'source',
        type: 'input',
        title: 'Source',
        position: { x: 0, y: 0 },
        size: { width: 200, height: 160 },
        color: '#333333',
        ports: {
          inputs: [port('source-input', sourceType)],
          outputs: [port('source-output', sourceType)],
        },
        config: {},
        runRecordIds: [],
      },
      {
        id: 'target',
        type: 'transform',
        title: 'Target',
        position: { x: 300, y: 0 },
        size: { width: 200, height: 160 },
        color: '#333333',
        ports: {
          inputs: [port('target-input', targetType)],
          outputs: [port('target-output', targetType)],
        },
        config: {},
        runRecordIds: [],
      },
      {
        id: 'third',
        type: 'output',
        title: 'Third',
        position: { x: 600, y: 0 },
        size: { width: 200, height: 160 },
        color: '#333333',
        ports: {
          inputs: [port('third-input', targetType)],
          outputs: [port('third-output', targetType)],
        },
        config: {},
        runRecordIds: [],
      },
    ],
    edges: [],
    assetReferences: [],
    runRecords: [],
  };
}

const source = { nodeId: 'source', portId: 'source-output' };
const target = { nodeId: 'target', portId: 'target-input' };

function expectRejected(
  domain: WorkflowGraphDomain,
  endpoints: Parameters<WorkflowGraphDomain['validateConnection']>[0],
  code: WorkflowConnectionRejectionCode,
  message: RegExp,
): void {
  const result = domain.validateConnection(endpoints);
  expect(result).toMatchObject({ ok: false, code });
  if (!result.ok) expect(result.message).toMatch(message);
}

describe('typed workflow connections', () => {
  it.each(connectableTypes)('accepts matching %s ports', (dataType) => {
    const domain = new WorkflowGraphDomain(graph(dataType));

    expect(domain.validateConnection({ source, target })).toEqual({ ok: true });
    expect(domain.addEdge({ id: `edge-${dataType}`, source, target })).toMatchObject({ source, target });
  });

  it('exhaustively rejects every mismatched MVP port-type pair', () => {
    for (const sourceType of connectableTypes) {
      for (const targetType of connectableTypes) {
        if (sourceType === targetType) continue;
        const domain = new WorkflowGraphDomain(graph(sourceType, targetType));

        expectRejected(
          domain,
          { source, target },
          'INCOMPATIBLE_PORT_TYPES',
          new RegExp(`${sourceType}.*${targetType}`, 'i'),
        );
      }
    }
  });

  it('rejects unknown port types and unsupported nodes without enabling unsafe connections', () => {
    const unknownPort = new WorkflowGraphDomain(graph('unknown'));
    expectRejected(unknownPort, { source, target }, 'UNSUPPORTED_CONNECTION', /unknown.*cannot be connected/i);

    for (const endpoint of ['source', 'target'] as const) {
      const input = graph();
      const index = endpoint === 'source' ? 0 : 1;
      input.nodes[index] = {
        ...input.nodes[index],
        type: 'unsupported',
        config: { unsupportedType: 'future-node', rawConfig: { strength: 0.7 } },
      };
      const domain = new WorkflowGraphDomain(input);
      expectRejected(domain, { source, target }, 'UNSUPPORTED_CONNECTION', /unsupported.*cannot be connected/i);
    }
  });

  it('preserves persisted connections to future nodes as dormant recoverable data', () => {
    const input = graph();
    input.nodes[0] = {
      ...input.nodes[0],
      type: 'future-compositor',
      ports: {
        inputs: [],
        outputs: [{ id: 'future-result', label: 'Future result', dataType: 'future-image' }],
      },
      config: { futureQuality: 4 },
    } as never;
    input.edges = [{
      id: 'future-target',
      source: { nodeId: 'source', portId: 'future-result' },
      target,
    }];

    const parsed = parseWorkflowGraphV2(input);
    expect(parsed.ok).toBe(true);
    const domain = new WorkflowGraphDomain(parsed.value!);

    expect(domain.graph.edges).toEqual(input.edges);
    expect(domain.node('source')).toMatchObject({
      type: 'unsupported',
      config: {
        unsupportedType: 'future-compositor',
        rawConfig: { futureQuality: 4 },
        rawPorts: input.nodes[0].ports,
      },
    });
    expect(parseWorkflowGraphV2(JSON.parse(domain.serialize())).value).toEqual(domain.graph);
    expectRejected(domain, {
      source: { nodeId: 'source', portId: 'future-result' },
      target: { nodeId: 'third', portId: 'third-input' },
    }, 'UNSUPPORTED_CONNECTION', /unsupported.*cannot be connected/i);
  });

  it('does not let dormant future edges occupy active inputs or participate in active cycles', () => {
    const input = graph();
    input.nodes[2] = { ...input.nodes[2], type: 'unsupported' };
    input.edges = [
      {
        id: 'dormant-target',
        source: { nodeId: 'third', portId: 'third-output' },
        target,
      },
      { id: 'active-target', source, target },
      {
        id: 'dormant-cycle',
        source: { nodeId: 'third', portId: 'third-output' },
        target: { nodeId: 'source', portId: 'source-input' },
      },
    ];

    const domain = new WorkflowGraphDomain(input);

    expect(domain.graph.edges).toEqual(input.edges);
    expect(domain.validateConnection({
      source: { nodeId: 'target', portId: 'target-output' },
      target: { nodeId: 'source', portId: 'source-input' },
    })).toMatchObject({ ok: false, code: 'CYCLE_DETECTED' });
  });

  it('requires source output ports and target input ports by their declared names', () => {
    const domain = new WorkflowGraphDomain(graph());

    expectRejected(
      domain,
      { source: { nodeId: 'source', portId: 'missing' }, target },
      'SOURCE_PORT_NOT_FOUND',
      /Source.*missing.*output port/i,
    );
    expectRejected(
      domain,
      { source: { nodeId: 'source', portId: 'source-input' }, target },
      'SOURCE_PORT_NOT_FOUND',
      /Source.*source-input.*not an output port/i,
    );
    expectRejected(
      domain,
      { source, target: { nodeId: 'target', portId: 'missing' } },
      'TARGET_PORT_NOT_FOUND',
      /Target.*missing.*input port/i,
    );
    expectRejected(
      domain,
      { source, target: { nodeId: 'target', portId: 'target-output' } },
      'TARGET_PORT_NOT_FOUND',
      /Target.*target-output.*not an input port/i,
    );
  });

  it('rejects duplicate endpoint pairs independent of edge IDs', () => {
    const input = graph();
    input.edges.push({ id: 'first', source, target });
    const domain = new WorkflowGraphDomain(input);

    expectRejected(domain, { source, target }, 'DUPLICATE_CONNECTION', /already connected/i);
    expect(() => domain.addEdge({ id: 'second', source, target })).toThrowError(expect.objectContaining({
      code: 'DUPLICATE_CONNECTION',
      message: expect.stringMatching(/already connected/i),
    }));
  });

  it('rejects self-links and cycles of any length', () => {
    const domain = new WorkflowGraphDomain(graph());

    expectRejected(
      domain,
      {
        source,
        target: { nodeId: 'source', portId: 'source-input' },
      },
      'SELF_LINK',
      /cannot connect to itself/i,
    );

    domain.addEdge({ id: 'source-target', source, target });
    domain.addEdge({
      id: 'target-third',
      source: { nodeId: 'target', portId: 'target-output' },
      target: { nodeId: 'third', portId: 'third-input' },
    });
    expectRejected(
      domain,
      {
        source: { nodeId: 'third', portId: 'third-output' },
        target: { nodeId: 'source', portId: 'source-input' },
      },
      'CYCLE_DETECTED',
      /cycle/i,
    );
  });

  it('allows many dependencies only when the named target input declares multiple', () => {
    const single = graph();
    single.edges.push({ id: 'source-target', source, target });
    single.nodes.push({
      ...structuredClone(single.nodes[0]),
      id: 'other-source',
      title: 'Other source',
      ports: { inputs: [], outputs: [port('output', 'image')] },
    });
    const singleDomain = new WorkflowGraphDomain(single);
    expectRejected(
      singleDomain,
      { source: { nodeId: 'other-source', portId: 'output' }, target },
      'TARGET_PORT_OCCUPIED',
      /accepts only one connection/i,
    );

    const multiple = structuredClone(single);
    multiple.nodes[1].ports.inputs[0].multiple = true;
    const multipleDomain = new WorkflowGraphDomain(multiple);
    expect(multipleDomain.validateConnection({
      source: { nodeId: 'other-source', portId: 'output' },
      target,
    })).toEqual({ ok: true });
  });

  it('rejects invalid existing graphs through the same strict validation contract', () => {
    const cases: Array<[string, (input: WorkflowGraphV2) => void, WorkflowConnectionRejectionCode]> = [
      ['missing source port', (input) => { input.edges = [{ id: 'bad', source: { nodeId: 'source', portId: 'missing' }, target }]; }, 'SOURCE_PORT_NOT_FOUND'],
      ['incompatible types', (input) => { input.nodes[1].ports.inputs[0].dataType = 'mask'; input.edges = [{ id: 'bad', source, target }]; }, 'INCOMPATIBLE_PORT_TYPES'],
      ['self link', (input) => { input.edges = [{ id: 'bad', source, target: { nodeId: 'source', portId: 'source-input' } }]; }, 'SELF_LINK'],
      ['cycle', (input) => { input.edges = [
        { id: 'forward', source, target },
        { id: 'back', source: { nodeId: 'target', portId: 'target-output' }, target: { nodeId: 'source', portId: 'source-input' } },
      ]; }, 'CYCLE_DETECTED'],
    ];

    for (const [_name, mutate, code] of cases) {
      const input = graph();
      mutate(input);
      expect(() => new WorkflowGraphDomain(input)).toThrowError(expect.objectContaining({ code }));
    }
  });

  it('keeps add and update failures atomic with stable rejection reasons', () => {
    const domain = new WorkflowGraphDomain(graph());
    const before = domain.graph;

    expect(() => domain.addEdge({
      id: 'bad-add',
      source: { nodeId: 'source', portId: 'missing' },
      target,
    })).toThrowError(expect.objectContaining({ code: 'SOURCE_PORT_NOT_FOUND' }));
    expect(domain.graph).toBe(before);
    expect(domain.revision).toBe(0);

    domain.addEdge({ id: 'valid', source, target });
    const connected = domain.graph;
    expect(() => domain.updateEdge('valid', {
      source: { nodeId: 'target', portId: 'target-output' },
      target: { nodeId: 'target', portId: 'target-input' },
    })).toThrowError(expect.objectContaining({ code: 'SELF_LINK' }));
    expect(domain.graph).toBe(connected);
    expect(domain.revision).toBe(1);
  });

  it('requires unique named port IDs within each direction', () => {
    for (const direction of ['inputs', 'outputs'] as const) {
      const input = graph();
      input.nodes[0].ports[direction].push({ ...input.nodes[0].ports[direction][0] });

      expect(() => new WorkflowGraphDomain(input)).toThrowError(expect.objectContaining({
        code: 'DUPLICATE_PORT_ID',
        message: expect.stringMatching(new RegExp(`Source.*${direction === 'inputs' ? 'input' : 'output'}.*unique`, 'i')),
      }));
    }
  });

  it('always surfaces connection rejections as WorkflowDomainError from mutations', () => {
    const domain = new WorkflowGraphDomain(graph('image', 'mask'));

    expect(() => domain.addEdge({ id: 'bad', source, target })).toThrowError(WorkflowDomainError);
  });
});
