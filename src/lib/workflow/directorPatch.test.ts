import { describe, expect, it } from 'vitest';
import { instantiateWorkflowTemplate } from './templates';
import type { WorkflowGraphV2 } from './schema';
import {
  createWorkflowDirectorPatchProposal,
  parseWorkflowDirectorPatch,
  rejectWorkflowDirectorPatchProposal,
  type WorkflowDirectorPatchV1,
} from './directorPatch';

const SOURCE_REVISION = Object.freeze({ graphId: 'campaign-revision-source', revision: 7 });

function campaignWithAcceptedHistory(): WorkflowGraphV2 {
  const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer', {
    graphId: 'campaign-revision-source',
  }));
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
          target: { nodeId: 'transform-generate-square', portId: 'source' },
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
