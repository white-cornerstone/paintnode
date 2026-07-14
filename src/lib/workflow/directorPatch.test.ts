import { describe, expect, it } from 'vitest';
import { instantiateWorkflowTemplate } from './templates';
import { createCreatorNode } from './registry';
import type { WorkflowGraphV2 } from './schema';
import {
  createWorkflowDirectorPatchProposal,
  assertFreshWorkflowDirectorPatchProposal,
  parseWorkflowDirectorPatch,
  rejectWorkflowDirectorPatchProposal,
  type WorkflowDirectorPatchV1,
} from './directorPatch';

const SOURCE_REVISION = Object.freeze({ graphId: 'campaign-revision-source', revision: 7 });

function legacyCampaignGraph(): WorkflowGraphV2 {
  const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer', {
    graphId: 'campaign-revision-source',
  }));
  graph.nodes = graph.nodes.filter((node) => ![
    'review-campaign-direction', 'transform-format-square',
    'transform-generate-portrait', 'transform-generate-landscape',
  ].includes(node.id));
  graph.edges = graph.edges.filter((edge) => (
    graph.nodes.some((node) => node.id === edge.source.nodeId)
    && graph.nodes.some((node) => node.id === edge.target.nodeId)
  ));
  graph.edges.push(
    {
      id: 'edge-transform-generate-square-output-square',
      source: { nodeId: 'transform-generate-square', portId: 'result' },
      target: { nodeId: 'output-square', portId: 'source' },
    },
    ...['portrait', 'landscape'].map((format) => ({
      id: `edge-composition-output-${format}`,
      source: { nodeId: 'composition', portId: 'layout' },
      target: { nodeId: `output-${format}`, portId: 'source' },
    })),
  );
  graph.nodes.find((node) => node.id === 'transform-generate-square')!.config.instructions =
    'Generate the configured Square 1:1 campaign result from the Product, Brief, and Art Direction.';
  return graph;
}

function campaignWithAcceptedHistory(): WorkflowGraphV2 {
  const graph = legacyCampaignGraph();
  const transform = graph.nodes.find((node) => node.id === 'transform-generate-square')!;
  const square = graph.nodes.find((node) => node.id === 'output-square')!;
  transform.runRecordIds = ['run-generate-square'];
  transform.config = {
    ...transform.config,
    resultAssetReferenceId: 'accepted-square-ref',
    resultAssetId: 'accepted-square-asset',
    resultRelativePath: 'assets/generated/accepted-square.png',
  };
  square.config = {
    ...square.config,
    assetReferenceId: 'accepted-square-ref',
    outputAssetId: 'accepted-square-asset',
    outputRelativePath: 'assets/generated/accepted-square.png',
  };
  graph.runRecords = [{ id: 'run-generate-square', nodeId: transform.id, status: 'succeeded' }];
  graph.assetReferences = [{
    id: 'accepted-square-ref',
    role: 'output',
    assetId: 'accepted-square-asset',
    relativePath: 'assets/generated/accepted-square.png',
  }];
  return graph;
}

function campaignWithPromotedReview(): WorkflowGraphV2 {
  const graph = legacyCampaignGraph();
  const review = createCreatorNode('review', { id: 'review-concepts' });
  review.ports.outputs = review.ports.outputs.map((port) => port.id === 'selected'
    ? { ...port, label: 'Selected direction', dataType: 'layout' }
    : port);
  graph.nodes.push(review);
  graph.edges = graph.edges.filter((edge) => edge.id !== 'edge-transform-generate-square-output-square');
  graph.edges.push(
    {
      id: 'edge-transform-review',
      source: { nodeId: 'transform-generate-square', portId: 'result' },
      target: { nodeId: 'review-concepts', portId: 'candidates' },
    },
    {
      id: 'edge-review-output',
      source: { nodeId: 'review-concepts', portId: 'selected' },
      target: { nodeId: 'output-square', portId: 'source' },
    },
  );
  graph.reviewPromotions = [{
    version: 1,
    id: 'promotion-accepted',
    reviewNodeId: 'review-concepts',
    sourceNodeId: 'transform-generate-square',
    branchGroupId: 'branch-accepted',
    candidateId: 'candidate-accepted',
    candidateRunId: 'candidate-run-accepted',
    assetReferenceId: 'candidate-reference-accepted',
    assetId: 'candidate-asset-accepted',
    relativePath: 'assets/generated/candidate-accepted.png',
    contentHash: `sha256:${'a'.repeat(64)}`,
    materialKey: 'workflow-cache-v1:accepted',
    reviewNodeRevision: `sha256:${'b'.repeat(64)}`,
    promotedAt: 100,
  }];
  return graph;
}

function patch(operations: WorkflowDirectorPatchV1['operations']): WorkflowDirectorPatchV1 {
  return {
    version: 1,
    sourceGraphRevision: SOURCE_REVISION,
    summary: 'Warm the generated square while preserving accepted work.',
    operations,
  };
}

describe('Workflow Director patch schema', () => {
  it('parses only the strict versioned constrained vocabulary', () => {
    const input = patch([
      { op: 'configure-node', nodeId: 'transform-generate-square', changes: { instructions: 'Use warmer light.' } },
      { op: 'move-node', nodeId: 'output-portrait', position: { x: 1420, y: 310 } },
      {
        op: 'add-node',
        node: {
          id: 'output-story', type: 'output', title: 'Story 9:16',
          position: { x: 1420, y: 810 }, config: { finalWidth: 1080, finalHeight: 1920 },
        },
      },
      {
        op: 'add-edge',
        edge: {
          id: 'edge-composition-output-story',
          source: { nodeId: 'composition', portId: 'layout' },
          target: { nodeId: 'output-story', portId: 'source' },
        },
      },
      { op: 'remove-edge', edgeId: 'edge-composition-output-landscape' },
      { op: 'remove-node', nodeId: 'output-landscape' },
    ]);

    expect(parseWorkflowDirectorPatch(input)).toEqual({ value: input, issues: [] });
  });

  it.each([
    ['top-level extra key', { ...patch([]), viewport: { zoom: 3 } }],
    ['unsupported version', { ...patch([]), version: 2 }],
    ['unsupported operation', { ...patch([]), operations: [{ op: 'replace-graph', graph: {} }] }],
    ['operation extra key', { ...patch([{ op: 'remove-edge', edgeId: 'edge' }]), operations: [{ op: 'remove-edge', edgeId: 'edge', force: true }] }],
    ['raw ports on add', { ...patch([]), operations: [{ op: 'add-node', node: { id: 'x', type: 'output', ports: {} } }] }],
    ['unknown node type', { ...patch([]), operations: [{ op: 'add-node', node: { id: 'x', type: 'recipe' } }] }],
    ['unknown configuration', { ...patch([]), operations: [{ op: 'configure-node', nodeId: 'output-square', changes: { rawCandidate: true } }] }],
    ['history mutation', { ...patch([]), operations: [{ op: 'configure-node', nodeId: 'output-square', changes: { runRecordIds: [] } }] }],
  ])('rejects %s without returning a partial patch', (_name, input) => {
    const result = parseWorkflowDirectorPatch(input);
    expect(result.value).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it.each([
    ['inherited summary', (() => {
      const input = Object.create({ summary: 'Inherited summary' }) as Record<string, unknown>;
      Object.assign(input, { version: 1, sourceGraphRevision: SOURCE_REVISION, operations: [] });
      return input;
    })()],
    ['inherited operation', (() => {
      const operation = Object.create({ op: 'remove-edge' }) as Record<string, unknown>;
      operation.edgeId = 'edge-composition-output-landscape';
      return { ...patch([]), operations: [operation] };
    })()],
    ['non-enumerable summary', (() => {
      const input = patch([]) as unknown as Record<string, unknown>;
      Object.defineProperty(input, 'summary', { value: input.summary, enumerable: false });
      return input;
    })()],
    ['non-enumerable operation kind', (() => {
      const operation: Record<string, unknown> = { edgeId: 'edge-composition-output-landscape' };
      Object.defineProperty(operation, 'op', { value: 'remove-edge', enumerable: false });
      return { ...patch([]), operations: [operation] };
    })()],
    ['symbol key', (() => {
      const input = patch([]) as WorkflowDirectorPatchV1 & { [key: symbol]: boolean };
      input[Symbol('hidden')] = true;
      return input;
    })()],
  ])('rejects patches containing %s', (_name, input) => {
    const result = parseWorkflowDirectorPatch(input);
    expect(result.value).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('rejects accessors without invoking them', () => {
    const input = patch([]) as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(input, 'summary', {
      enumerable: true,
      get() {
        reads += 1;
        return 'Accessor summary';
      },
    });
    const result = parseWorkflowDirectorPatch(input);
    expect(result.value).toBeNull();
    expect(reads).toBe(0);
  });

  it.each([
    ['root descriptor trap', (secret: string) => new Proxy(patch([]), {
      getOwnPropertyDescriptor() { throw new Error(secret); },
    })],
    ['operation own-key trap', (secret: string) => ({
      ...patch([]),
      operations: [new Proxy({ op: 'remove-edge', edgeId: 'edge-composition-output-landscape' }, {
        ownKeys() { throw new Error(secret); },
      })],
    })],
    ['operations descriptor trap', (secret: string) => ({
      ...patch([]),
      operations: new Proxy([], {
        getOwnPropertyDescriptor() { throw new Error(secret); },
      }),
    })],
  ])('sanitizes %s without leaking trap text', (_name, hostile) => {
    const secret = 'do-not-leak-proxy-secret';
    let result: ReturnType<typeof parseWorkflowDirectorPatch> | undefined;
    expect(() => { result = parseWorkflowDirectorPatch(hostile(secret)); }).not.toThrow();
    expect(result?.value).toBeNull();
    expect(JSON.stringify(result?.issues)).not.toContain(secret);
  });

  it.each([
    ['revoked root', () => {
      const revocable = Proxy.revocable(patch([]), {});
      revocable.revoke();
      return revocable.proxy;
    }],
    ['revoked operations array', () => {
      const revocable = Proxy.revocable([], {});
      revocable.revoke();
      return { ...patch([]), operations: revocable.proxy };
    }],
    ['revoked operation', () => {
      const revocable = Proxy.revocable({ op: 'remove-edge', edgeId: 'edge-composition-output-landscape' }, {});
      revocable.revoke();
      return { ...patch([]), operations: [revocable.proxy] };
    }],
  ])('rejects %s without escaping an IsArray TypeError', (_name, hostile) => {
    let result: ReturnType<typeof parseWorkflowDirectorPatch> | undefined;
    expect(() => { result = parseWorkflowDirectorPatch(hostile()); }).not.toThrow();
    expect(result?.value).toBeNull();
    expect(result?.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result?.issues)).not.toMatch(/IsArray|revoked|TypeError/i);
  });

  it('rejects oversized operation arrays before inspecting any operation', () => {
    const operations = new Array(129).fill(null);
    let reads = 0;
    Object.defineProperty(operations, 0, {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error('must not inspect oversized patch');
      },
    });
    const result = parseWorkflowDirectorPatch({ ...patch([]), operations });
    expect(result.value).toBeNull();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'TOO_MANY_OPERATIONS' }),
    ]));
    expect(reads).toBe(0);
  });

  it('rejects a source revision that cannot be incremented safely', () => {
    const result = parseWorkflowDirectorPatch({
      ...patch([]),
      sourceGraphRevision: { graphId: SOURCE_REVISION.graphId, revision: Number.MAX_SAFE_INTEGER },
    });
    expect(result.value).toBeNull();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_REVISION' }),
    ]));
  });
});

describe('Workflow Director patch proposal', () => {
  it('previews node, edge, requirement, and isolated downstream-staleness changes', () => {
    const graph = campaignWithAcceptedHistory();
    const result = createWorkflowDirectorPatchProposal(patch([
      { op: 'configure-node', nodeId: 'transform-generate-square', changes: { instructions: 'Use warmer amber light.' } },
      { op: 'move-node', nodeId: 'output-portrait', position: { x: 1500, y: 340 } },
      {
        op: 'add-node',
        node: {
          id: 'output-story', type: 'output', title: 'Story 9:16',
          position: { x: 1500, y: 820 }, config: { finalWidth: 1080, finalHeight: 1920 },
        },
      },
    ]), graph, SOURCE_REVISION);

    expect(result.issues).toEqual([]);
    expect(result.proposal).toMatchObject({
      canAccept: true,
      sourceGraphRevision: SOURCE_REVISION,
      targetGraphRevision: { graphId: SOURCE_REVISION.graphId, revision: SOURCE_REVISION.revision + 1 },
      nodeChanges: expect.arrayContaining([
        expect.objectContaining({ kind: 'configured', nodeId: 'transform-generate-square' }),
        expect.objectContaining({ kind: 'moved', nodeId: 'output-portrait' }),
        expect.objectContaining({ kind: 'added', nodeId: 'output-story' }),
      ]),
      requirementChanges: expect.arrayContaining([
        expect.objectContaining({ nodeId: 'output-story', portId: 'source', after: 'missing' }),
      ]),
      downstreamStaleness: [
        expect.objectContaining({ nodeId: 'transform-generate-square' }),
        expect.objectContaining({ nodeId: 'output-square' }),
      ],
    });
    expect(result.proposal?.downstreamStaleness.map((item) => item.nodeId)).not.toContain('output-portrait');
    expect(result.proposal?.downstreamStaleness.map((item) => item.nodeId)).not.toContain('output-landscape');
  });

  it('adds and removes only compatible named-port edges', () => {
    const graph = campaignWithAcceptedHistory();
    const result = createWorkflowDirectorPatchProposal(patch([
      {
        op: 'add-node',
        node: {
          id: 'output-story', type: 'output', title: 'Story 9:16',
          position: { x: 1500, y: 820 }, config: { finalWidth: 1080, finalHeight: 1920 },
        },
      },
      {
        op: 'add-edge',
        edge: {
          id: 'edge-composition-output-story',
          source: { nodeId: 'composition', portId: 'layout' },
          target: { nodeId: 'output-story', portId: 'source' },
        },
      },
      { op: 'remove-edge', edgeId: 'edge-composition-output-landscape' },
    ]), graph, SOURCE_REVISION);

    expect(result.proposal?.edgeChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'added', edgeId: 'edge-composition-output-story' }),
      expect.objectContaining({ kind: 'removed', edgeId: 'edge-composition-output-landscape' }),
    ]));
    expect(result.proposal?.requirementChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'output-story', before: 'absent', after: 'ready' }),
      expect.objectContaining({ nodeId: 'output-landscape', before: 'ready', after: 'missing' }),
    ]));
  });

  it.each([
    ['stale source revision', patch([]), { ...SOURCE_REVISION, revision: SOURCE_REVISION.revision + 1 }, /stale/i],
    ['invalid source port', patch([{ op: 'add-edge', edge: { id: 'bad', source: { nodeId: 'composition', portId: 'missing' }, target: { nodeId: 'output-portrait', portId: 'source' } } }]), SOURCE_REVISION, /port/i],
    ['duplicate node ID', patch([{ op: 'add-node', node: { id: 'output-square', type: 'output' } }]), SOURCE_REVISION, /already exists|duplicate/i],
    ['duplicate edge ID', patch([{ op: 'add-edge', edge: { id: 'edge-brief-composition', source: { nodeId: 'brief', portId: 'prompt' }, target: { nodeId: 'composition', portId: 'brief' } } }]), SOURCE_REVISION, /already exists|duplicate/i],
    ['no-op configuration', patch([{ op: 'configure-node', nodeId: 'transform-generate-square', changes: { instructions: 'Generate the configured Square 1:1 campaign result from the Product, Brief, and Art Direction.' } }]), SOURCE_REVISION, /no changes/i],
  ])('rejects %s atomically', (_name, input, currentRevision, message) => {
    const graph = campaignWithAcceptedHistory();
    const before = JSON.stringify(graph);
    const result = createWorkflowDirectorPatchProposal(input, graph, currentRevision);
    expect(result.proposal).toBeNull();
    expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(message);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('rejects a cycle-producing patch after earlier valid operations without partial application', () => {
    const graph = campaignWithAcceptedHistory();
    const before = JSON.stringify(graph);
    const result = createWorkflowDirectorPatchProposal(patch([
      { op: 'configure-node', nodeId: 'brief', changes: { objective: 'A valid first change.' } },
      { op: 'add-node', node: { id: 'review-cycle', type: 'review' } },
      { op: 'remove-edge', edgeId: 'edge-composition-transform-generate-square' },
      {
        op: 'add-edge',
        edge: {
          id: 'cycle-composition-review',
          source: { nodeId: 'composition', portId: 'layout' },
          target: { nodeId: 'review-cycle', portId: 'candidates' },
        },
      },
      {
        op: 'add-edge',
        edge: {
          id: 'cycle-review-transform',
          source: { nodeId: 'review-cycle', portId: 'selected' },
          target: { nodeId: 'transform-generate-square', portId: 'decision' },
        },
      },
      {
        op: 'add-edge',
        edge: {
          id: 'cycle-transform-review',
          source: { nodeId: 'transform-generate-square', portId: 'result' },
          target: { nodeId: 'review-cycle', portId: 'candidates' },
        },
      },
    ]), graph, SOURCE_REVISION);

    expect(result.proposal).toBeNull();
    expect(result.issues.map((issue) => issue.code)).toContain('CYCLE_DETECTED');
    expect(JSON.stringify(graph)).toBe(before);
  });

  it.each([
    ['run history', 'transform-generate-square'],
    ['accepted candidate', 'output-square'],
  ])('rejects removal that would destroy %s', (_name, nodeId) => {
    const graph = campaignWithAcceptedHistory();
    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'remove-node', nodeId }]),
      graph,
      SOURCE_REVISION,
    );
    expect(result.proposal).toBeNull();
    expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/history|candidate|accepted/i);
  });

  it('preserves accepted candidates and run history byte-for-byte in an accepted patch', () => {
    const graph = campaignWithAcceptedHistory();
    const transformBefore = graph.nodes.find((node) => node.id === 'transform-generate-square')!;
    const squareBefore = graph.nodes.find((node) => node.id === 'output-square')!;
    transformBefore.config.futureExecutionPolicy = { version: 3, preserve: ['exactly'] };
    const assetReferencesBefore = JSON.stringify(graph.assetReferences);
    const runRecordsBefore = JSON.stringify(graph.runRecords);
    const runLinksBefore = JSON.stringify(graph.nodes.map((node) => [node.id, node.runRecordIds]));
    const protectedBefore = JSON.stringify({
      transform: {
        resultAssetReferenceId: transformBefore.config.resultAssetReferenceId,
        resultAssetId: transformBefore.config.resultAssetId,
        resultRelativePath: transformBefore.config.resultRelativePath,
        futureExecutionPolicy: transformBefore.config.futureExecutionPolicy,
      },
      output: {
        assetReferenceId: squareBefore.config.assetReferenceId,
        outputAssetId: squareBefore.config.outputAssetId,
        outputRelativePath: squareBefore.config.outputRelativePath,
      },
    });
    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'configure-node', nodeId: 'transform-generate-square', changes: { instructions: 'Warm revision.' } }]),
      graph,
      SOURCE_REVISION,
    );
    const next = result.proposal!.graph;
    const transformAfter = next.nodes.find((node) => node.id === 'transform-generate-square')!;
    const squareAfter = next.nodes.find((node) => node.id === 'output-square')!;

    expect(JSON.stringify(next.assetReferences)).toBe(assetReferencesBefore);
    expect(JSON.stringify(next.runRecords)).toBe(runRecordsBefore);
    expect(JSON.stringify(next.nodes.map((node) => [node.id, node.runRecordIds]))).toBe(runLinksBefore);
    expect(JSON.stringify({
      transform: {
        resultAssetReferenceId: transformAfter.config.resultAssetReferenceId,
        resultAssetId: transformAfter.config.resultAssetId,
        resultRelativePath: transformAfter.config.resultRelativePath,
        futureExecutionPolicy: transformAfter.config.futureExecutionPolicy,
      },
      output: {
        assetReferenceId: squareAfter.config.assetReferenceId,
        outputAssetId: squareAfter.config.outputAssetId,
        outputRelativePath: squareAfter.config.outputRelativePath,
      },
    })).toBe(protectedBefore);
    expect(transformAfter.config.instructions).toBe('Warm revision.');
  });

  it('preserves the Review promotion ledger exactly instead of normalizing it away', () => {
    const graph = campaignWithAcceptedHistory();
    graph.reviewPromotions = [];
    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'move-node', nodeId: 'output-portrait', position: { x: 1600, y: 240 } }]),
      graph,
      SOURCE_REVISION,
    );

    expect(result.issues).toEqual([]);
    expect(result.proposal?.graph).toHaveProperty('reviewPromotions');
    expect(JSON.stringify(result.proposal?.graph.reviewPromotions)).toBe(JSON.stringify(graph.reviewPromotions));
  });

  it.each([
    ['promoted Review node', [{ op: 'remove-node', nodeId: 'review-concepts' }]],
    ['promotion source Transform', [{ op: 'remove-node', nodeId: 'transform-generate-square' }]],
    ['promoted path Output', [{ op: 'remove-node', nodeId: 'output-square' }]],
    ['source-to-Review connection', [{ op: 'remove-edge', edgeId: 'edge-transform-review' }]],
    ['Review-to-Output connection', [{ op: 'remove-edge', edgeId: 'edge-review-output' }]],
    ['reconnected Review source', [
      { op: 'remove-edge', edgeId: 'edge-transform-review' },
      {
        op: 'add-edge',
        edge: {
          id: 'edge-composition-review',
          source: { nodeId: 'composition', portId: 'layout' },
          target: { nodeId: 'review-concepts', portId: 'candidates' },
        },
      },
    ]],
  ] as const)('rejects removal of the %s without changing accepted Review history', (_name, operations) => {
    const graph = campaignWithPromotedReview();
    const before = JSON.stringify(graph);
    const result = createWorkflowDirectorPatchProposal(
      patch([...structuredClone(operations)] as WorkflowDirectorPatchV1['operations']),
      graph,
      SOURCE_REVISION,
    );

    expect(result.proposal).toBeNull();
    expect(result.issues).toEqual([expect.objectContaining({ code: 'PROTECTED_REVIEW_HISTORY' })]);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('still permits removing an unrelated node beside immutable Review history', () => {
    const graph = campaignWithPromotedReview();
    const promotions = JSON.stringify(graph.reviewPromotions);
    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'remove-node', nodeId: 'output-landscape' }]),
      graph,
      SOURCE_REVISION,
    );

    expect(result.issues).toEqual([]);
    expect(result.proposal?.graph.nodes.some((node) => node.id === 'output-landscape')).toBe(false);
    expect(JSON.stringify(result.proposal?.graph.reviewPromotions)).toBe(promotions);
  });

  it('rejects adding a second candidate source to a promoted Review atomically', () => {
    const graph = campaignWithPromotedReview();
    const before = JSON.stringify(graph);
    const result = createWorkflowDirectorPatchProposal(
      patch([{
        op: 'add-edge',
        edge: {
          id: 'edge-composition-review-second-source',
          source: { nodeId: 'composition', portId: 'layout' },
          target: { nodeId: 'review-concepts', portId: 'candidates' },
        },
      }]),
      graph,
      SOURCE_REVISION,
    );

    expect(result.proposal).toBeNull();
    expect(result.issues).toEqual([expect.objectContaining({ code: 'PROTECTED_REVIEW_HISTORY' })]);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it('permits adding a separate unpromoted Review without changing promoted Review topology', () => {
    const graph = campaignWithPromotedReview();
    const result = createWorkflowDirectorPatchProposal(
      patch([
        { op: 'add-node', node: { id: 'review-draft', type: 'review', title: 'Draft Review' } },
        {
          op: 'add-edge',
          edge: {
            id: 'edge-composition-review-draft',
            source: { nodeId: 'composition', portId: 'layout' },
            target: { nodeId: 'review-draft', portId: 'candidates' },
          },
        },
      ]),
      graph,
      SOURCE_REVISION,
    );

    expect(result.issues).toEqual([]);
    expect(result.proposal?.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'review-concepts', type: 'review' }),
      expect.objectContaining({ id: 'review-draft', type: 'review' }),
    ]));
  });

  it('rejects removal of a dormant edge owned by an unsupported future node', () => {
    const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer', {
      graphId: 'campaign-revision-source',
    }));
    const future = graph.nodes.find((node) => node.id === 'output-landscape')!;
    future.type = 'unsupported';
    future.config = {
      unsupportedType: 'future-output',
      rawConfig: structuredClone(future.config),
      rawPorts: structuredClone(future.ports),
    };
    const before = JSON.stringify(graph);
    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'remove-edge', edgeId: 'edge-transform-generate-landscape-output-landscape' }]),
      graph,
      SOURCE_REVISION,
    );

    expect(result.proposal).toBeNull();
    expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/connections.*unsupported/i);
    expect(JSON.stringify(graph)).toBe(before);
  });

  it.each(['editorRevisions', 'workflowRoundTrips'] as const)(
    'fails closed instead of dropping an invalid %s ledger',
    (ledger) => {
      const graph = campaignWithAcceptedHistory() as WorkflowGraphV2 & Record<typeof ledger, unknown[]>;
      graph[ledger] = [{ id: `protected-${ledger}` }] as never;
      const result = createWorkflowDirectorPatchProposal(
        patch([{ op: 'move-node', nodeId: 'output-portrait', position: { x: 1600, y: 240 } }]),
        graph,
        SOURCE_REVISION,
      );

      expect(result.proposal).toBeNull();
      expect(result.issues).toEqual([expect.objectContaining({
        path: 'graph',
        code: 'INVALID_GRAPH',
      })]);
    },
  );

  it('accepts only the exact canonical patch proposal returned by validation', () => {
    const graph = campaignWithAcceptedHistory();
    const proposal = createWorkflowDirectorPatchProposal(
      patch([{ op: 'move-node', nodeId: 'output-portrait', position: { x: 1600, y: 240 } }]),
      graph,
      SOURCE_REVISION,
    ).proposal!;

    expect(assertFreshWorkflowDirectorPatchProposal(proposal)).toBe(proposal.graph);
    expect(() => assertFreshWorkflowDirectorPatchProposal({ ...proposal }))
      .toThrow(/trusted validation identity/i);
  });

  it('rejects cross-graph patches even when the numeric content revision matches', () => {
    const graph = campaignWithAcceptedHistory();
    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'move-node', nodeId: 'output-square', position: { x: 1600, y: 80 } }]),
      graph,
      { graphId: 'different-workflow', revision: SOURCE_REVISION.revision },
    );
    expect(result.proposal).toBeNull();
    expect(result.issues).toEqual([expect.objectContaining({ code: 'STALE_GRAPH_REVISION' })]);
  });

  it.each([
    ['string dimensions', { finalWidth: '1080' }],
    ['deleted setting', { instructions: undefined }],
    ['invalid review mode', { mode: 'automatic' }],
    ['blank capability', { capability: '   ' }],
  ])('rejects strictly typed configuration containing %s', (_name, changes) => {
    const result = parseWorkflowDirectorPatch(patch([
      { op: 'configure-node', nodeId: 'transform-generate-square', changes },
    ]));
    expect(result.value).toBeNull();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_CONFIG_VALUE' }),
    ]));
  });

  it('rejects prototype-polluted configuration as a non-plain patch object', () => {
    const polluted = Object.create({ instructions: 'inherited' }) as Record<string, unknown>;
    polluted.capability = 'generate';
    const result = parseWorkflowDirectorPatch(patch([
      { op: 'configure-node', nodeId: 'transform-generate-square', changes: polluted },
    ]));
    expect(result.value).toBeNull();
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('preserves existing future configuration while applying an allowlisted change', () => {
    const graph = campaignWithAcceptedHistory();
    const transform = graph.nodes.find((node) => node.id === 'transform-generate-square')!;
    transform.config.futureExecutionPolicy = {
      version: 3,
      nested: ['keep', { exact: true }],
    };
    const protectedBytes = JSON.stringify(transform.config.futureExecutionPolicy);
    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'configure-node', nodeId: transform.id, changes: { instructions: 'Warm revision.' } }]),
      graph,
      SOURCE_REVISION,
    );
    expect(JSON.stringify(result.proposal?.graph.nodes.find((node) => node.id === transform.id)?.config.futureExecutionPolicy)).toBe(protectedBytes);
  });

  it('rejects removal through a future config key that references an immutable asset reference', () => {
    const graph = campaignWithAcceptedHistory();
    const portrait = graph.nodes.find((node) => node.id === 'output-portrait')!;
    portrait.config.futureAcceptedCandidate = { reference: 'accepted-square-ref' };
    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'remove-node', nodeId: portrait.id }]),
      graph,
      SOURCE_REVISION,
    );
    expect(result.proposal).toBeNull();
    expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/immutable project asset/i);
  });

  it.each([
    ['nested accepted asset identity', (graph: WorkflowGraphV2) => {
      graph.nodes.find((node) => node.id === 'output-portrait')!.config.futureAcceptedCandidate = {
        assetId: 'accepted-square-asset',
        path: 'assets/generated/accepted-square.png',
      };
      return 'output-portrait';
    }],
    ['direct input asset binding', (graph: WorkflowGraphV2) => {
      const product = graph.nodes.find((node) => node.id === 'slot-product')!;
      product.config.assetId = 'accepted-square-asset';
      product.config.relativePath = 'assets/generated/accepted-square.png';
      return product.id;
    }],
    ['run-output identity outside asset references', (graph: WorkflowGraphV2) => {
      const transform = graph.nodes.find((node) => node.id === 'transform-generate-square')!;
      graph.runRecords = [{
        recordVersion: 1,
        id: 'run-generate-square',
        nodeId: transform.id,
        status: 'succeeded',
        attempt: 1,
        workflowRevision: 'workflow-revision',
        nodeRevision: 'node-revision',
        materialKey: 'material-key',
        sourceAssets: [],
        prompt: {
          brief: 'Brief', artDirection: 'Direction', instructions: 'Generate',
          constraints: [], effectivePromptHash: 'prompt-hash',
        },
        provider: { id: 'fake', model: null, effectiveOptions: {} },
        executor: { id: 'fake', version: '1', requestSchemaVersion: '1' },
        target: { nodeId: transform.id, title: transform.title, width: 1024, height: 1024 },
        startedAt: 1,
        finishedAt: 2,
        outputs: [{
          assetReferenceId: 'run-only-reference',
          assetId: 'run-only-asset',
          relativePath: 'assets/generated/run-only.png',
          contentHash: 'sha256:run-only',
        }],
      }] as unknown as WorkflowGraphV2['runRecords'];
      graph.assetReferences = [];
      graph.nodes.find((node) => node.id === 'output-portrait')!.config.futureAcceptedCandidate = {
        assetId: 'run-only-asset',
        relativePath: 'assets/generated/run-only.png',
      };
      return 'output-portrait';
    }],
  ])('rejects removal through %s', (_name, prepare) => {
    const graph = campaignWithAcceptedHistory();
    const nodeId = prepare(graph);
    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'remove-node', nodeId }]),
      graph,
      SOURCE_REVISION,
    );
    expect(result.proposal).toBeNull();
    expect(result.issues.map((issue) => issue.message).join(' ')).toMatch(/immutable project asset|accepted/i);
  });

  it('preserves a complete run record byte-for-byte on an unrelated patch', () => {
    const graph = campaignWithAcceptedHistory();
    const transform = graph.nodes.find((node) => node.id === 'transform-generate-square')!;
    graph.runRecords = [{
      recordVersion: 1,
      id: 'run-generate-square',
      nodeId: transform.id,
      status: 'succeeded',
      attempt: 1,
      workflowRevision: 'workflow-revision',
      nodeRevision: 'node-revision',
      materialKey: 'material-key',
      sourceAssets: [],
      prompt: {
        brief: 'Brief', artDirection: 'Direction', instructions: 'Generate',
        constraints: [], effectivePromptHash: 'prompt-hash',
      },
      provider: { id: 'fake', model: null, effectiveOptions: {} },
      executor: { id: 'fake', version: '1', requestSchemaVersion: '1' },
      target: { nodeId: transform.id, title: transform.title, width: 1024, height: 1024 },
      startedAt: 1,
      finishedAt: 2,
      outputs: [{
        assetReferenceId: 'run-only-reference',
        assetId: 'run-only-asset',
        relativePath: 'assets/generated/run-only.png',
        contentHash: 'sha256:run-only',
      }],
    }] as unknown as WorkflowGraphV2['runRecords'];
    const before = JSON.stringify(graph.runRecords);

    const proposal = createWorkflowDirectorPatchProposal(patch([
      { op: 'move-node', nodeId: 'output-portrait', position: { x: 1666, y: 222 } },
    ]), graph, SOURCE_REVISION).proposal!;

    expect(JSON.stringify(proposal.graph.runRecords)).toBe(before);
  });

  it('does not treat ordinary authoring text as an immutable asset binding', () => {
    const graph = campaignWithAcceptedHistory();
    const brief = graph.nodes.find((node) => node.id === 'brief')!;
    brief.config.objective = 'accepted-square-asset';

    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'remove-node', nodeId: brief.id }]),
      graph,
      SOURCE_REVISION,
    );

    expect(result.issues).toEqual([]);
    expect(result.proposal?.graph.nodes.some((node) => node.id === brief.id)).toBe(false);
  });

  it('derives configured changes and staleness only from the final shadow graph', () => {
    const graph = campaignWithAcceptedHistory();
    const original = graph.nodes.find((node) => node.id === 'transform-generate-square')!.config.instructions as string;
    const result = createWorkflowDirectorPatchProposal(patch([
      { op: 'configure-node', nodeId: 'transform-generate-square', changes: { instructions: 'Temporary change.' } },
      { op: 'configure-node', nodeId: 'transform-generate-square', changes: { instructions: original } },
      { op: 'move-node', nodeId: 'output-portrait', position: { x: 1777, y: 333 } },
    ]), graph, SOURCE_REVISION).proposal!;

    expect(result.nodeChanges).toEqual([
      expect.objectContaining({ kind: 'moved', nodeId: 'output-portrait' }),
    ]);
    expect(result.downstreamStaleness).toEqual([]);
  });

  it('derives edge, requirement, and staleness changes only from net topology', () => {
    const graph = campaignWithAcceptedHistory();
    const edge = graph.edges.find((item) => item.id === 'edge-composition-output-landscape')!;
    const result = createWorkflowDirectorPatchProposal(patch([
      { op: 'remove-edge', edgeId: edge.id },
      { op: 'add-edge', edge },
      { op: 'move-node', nodeId: 'output-portrait', position: { x: 1888, y: 444 } },
    ]), graph, SOURCE_REVISION).proposal!;

    expect(result.edgeChanges).toEqual([]);
    expect(result.requirementChanges).toEqual([]);
    expect(result.downstreamStaleness).toEqual([]);
  });

  it('rejects an edge remove-and-restore sequence as a semantic no-op', () => {
    const graph = campaignWithAcceptedHistory();
    const edge = graph.edges.find((item) => item.id === 'edge-composition-output-landscape')!;
    const result = createWorkflowDirectorPatchProposal(patch([
      { op: 'remove-edge', edgeId: edge.id },
      { op: 'add-edge', edge },
    ]), graph, SOURCE_REVISION);

    expect(result.proposal).toBeNull();
    expect(result.issues).toEqual([expect.objectContaining({ code: 'NO_EFFECT' })]);
  });

  it('produces the same accepted graph and derived preview for reordered independent operations', () => {
    const graph = campaignWithAcceptedHistory();
    const configure = { op: 'configure-node', nodeId: 'brief', changes: { objective: 'A warmer campaign.' } } as const;
    const move = { op: 'move-node', nodeId: 'output-portrait', position: { x: 1600, y: 280 } } as const;
    const first = createWorkflowDirectorPatchProposal(patch([configure, move]), graph, SOURCE_REVISION).proposal!;
    const second = createWorkflowDirectorPatchProposal(patch([move, configure]), graph, SOURCE_REVISION).proposal!;

    expect(first.graph).toEqual(second.graph);
    expect(first.nodeChanges).toEqual(second.nodeChanges);
    expect(first.edgeChanges).toEqual(second.edgeChanges);
    expect(first.requirementChanges).toEqual(second.requirementChanges);
    expect(first.downstreamStaleness).toEqual(second.downstreamStaleness);
  });

  it('rejects a proposal as a no-op without touching the source graph', () => {
    const graph = campaignWithAcceptedHistory();
    const result = createWorkflowDirectorPatchProposal(
      patch([{ op: 'move-node', nodeId: 'output-square', position: graph.nodes.find((node) => node.id === 'output-square')!.position }]),
      graph,
      SOURCE_REVISION,
    );
    expect(result.proposal).toBeNull();
    expect(result.issues).toEqual([expect.objectContaining({ code: 'NO_EFFECT' })]);
    expect(rejectWorkflowDirectorPatchProposal(result.proposal)).toBeNull();
  });
});
