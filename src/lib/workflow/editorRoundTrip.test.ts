import { describe, expect, it } from 'vitest';
import { appendWorkflowEditorRevision, resolveWorkflowEffectiveResult } from './editorRoundTrip';
import { instantiateWorkflowTemplate } from './templates';
import type { WorkflowEditorRevisionV1, WorkflowGraphV2, WorkflowRoundTripBindingV1, WorkflowRunRecordV1 } from './schema';

const hash = (digit: string) => `sha256:${digit.repeat(64)}`;

function sourceGraph(): WorkflowGraphV2 {
  const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer', { graphId: 'editor-round-trip' }));
  const node = graph.nodes.find((candidate) => candidate.id === 'transform-generate-square')!;
  const run: WorkflowRunRecordV1 = {
    recordVersion: 1, id: 'run-source', nodeId: node.id, status: 'succeeded', attempt: 1,
    workflowRevision: hash('1'), nodeRevision: hash('2'), materialKey: 'material-source',
    sourceAssets: [], prompt: {
      brief: 'Campaign brief', artDirection: 'Product direction', instructions: 'Generate square',
      constraints: [], effectivePromptHash: hash('3'),
    },
    provider: { id: 'qa-fake', model: null, effectiveOptions: {} },
    executor: { id: 'campaign-generate', version: '1', requestSchemaVersion: '1' },
    target: { nodeId: 'output-square', title: 'Square', width: 1024, height: 1024 },
    startedAt: 1, finishedAt: 2,
    outputs: [{
      assetReferenceId: 'ref-source', assetId: 'asset-source', relativePath: 'assets/generated/source.png',
      contentHash: hash('4'), acceptedAt: 2,
    }],
  };
  node.runRecordIds = [run.id];
  graph.runRecords = [run];
  graph.assetReferences = [{ id: 'ref-source', role: 'output', assetId: 'asset-source', relativePath: 'assets/generated/source.png' }];
  return graph;
}

function revision(id: string, source: WorkflowEditorRevisionV1['source'], digit: string): WorkflowEditorRevisionV1 {
  return {
    version: 1, id, nodeId: 'transform-generate-square', rootRunId: 'run-source', source,
    document: { relativePath: `documents/workflow-edits/${id}.ora`, contentHash: hash(digit), mime: 'image/openraster' },
    output: {
      assetReferenceId: `ref-${id}`, assetId: `asset-${id}`, relativePath: `assets/generated/${id}.png`,
      contentHash: hash(digit), width: 1024, height: 1024, mime: 'image/png',
    },
    createdAt: Number(digit),
  };
}

function binding(id: string, editorRevisionId: string, supersedesRoundTripId?: string): WorkflowRoundTripBindingV1 {
  return {
    version: 1, id, target: { nodeId: 'transform-generate-square', rootRunId: 'run-source' },
    editorRevisionId, boundAt: 10,
    ...(supersedesRoundTripId ? { supersedesRoundTripId } : {}),
  };
}

describe('workflow editor round trip', () => {
  it('preserves the run and appends immutable child revisions with a new effective material key', () => {
    const graph = sourceGraph();
    const first = revision('edit-1', {
      kind: 'run-output', id: 'run-source', assetReferenceId: 'ref-source', assetId: 'asset-source',
      relativePath: 'assets/generated/source.png', contentHash: hash('4'),
    }, '5');
    const once = appendWorkflowEditorRevision(graph, first, binding('binding-1', first.id));
    const second = revision('edit-2', {
      kind: 'editor-revision', id: first.id, assetReferenceId: first.output.assetReferenceId,
      assetId: first.output.assetId, relativePath: first.output.relativePath, contentHash: first.output.contentHash,
    }, '6');
    const twice = appendWorkflowEditorRevision(once, second, binding('binding-2', second.id, 'binding-1'));

    expect(twice.runRecords).toEqual(graph.runRecords);
    expect(twice.editorRevisions).toEqual([first, second]);
    expect(twice.workflowRoundTrips?.map((item) => item.id)).toEqual(['binding-1', 'binding-2']);
    expect(resolveWorkflowEffectiveResult(twice, {
      nodeId: 'transform-generate-square', rootRunId: 'run-source',
    })).toMatchObject({ output: second.output, editorRevision: { id: 'edit-2' } });
    expect(resolveWorkflowEffectiveResult(twice, {
      nodeId: 'transform-generate-square', rootRunId: 'run-source',
    })?.materialKey).not.toBe('material-source');
  });

  it('rejects a child that does not exactly match its parent output', () => {
    const graph = sourceGraph();
    const invalid = revision('edit-invalid', {
      kind: 'run-output', id: 'run-source', assetReferenceId: 'ref-source', assetId: 'asset-source',
      relativePath: 'assets/generated/source.png', contentHash: hash('9'),
    }, '5');
    expect(() => appendWorkflowEditorRevision(graph, invalid, binding('binding-invalid', invalid.id))).toThrow(/exact prior result/i);
  });

  it('rejects ambiguous or cross-target binding heads even when timestamps are equal', () => {
    const graph = sourceGraph();
    const first = revision('edit-1', {
      kind: 'run-output', id: 'run-source', assetReferenceId: 'ref-source', assetId: 'asset-source',
      relativePath: 'assets/generated/source.png', contentHash: hash('4'),
    }, '5');
    const once = appendWorkflowEditorRevision(graph, first, binding('binding-1', first.id));
    const second = revision('edit-2', {
      kind: 'editor-revision', id: first.id, assetReferenceId: first.output.assetReferenceId,
      assetId: first.output.assetId, relativePath: first.output.relativePath, contentHash: first.output.contentHash,
    }, '6');
    expect(() => appendWorkflowEditorRevision(once, second, binding('binding-2', second.id)))
      .toThrow(/strict append-only target chain/i);
  });
});
