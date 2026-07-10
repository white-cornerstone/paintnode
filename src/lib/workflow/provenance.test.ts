import { describe, expect, it } from 'vitest';
import { instantiateWorkflowTemplate } from './templates';
import {
  createWorkflowRunRecord,
  deriveWorkflowNodeRunState,
  type WorkflowRunRecordDraft,
} from './provenance';

const canonicalHash = (canonical: string) => `sha256:${canonical}`;

function draft(overrides: Partial<WorkflowRunRecordDraft> = {}): WorkflowRunRecordDraft {
  const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer', { graphId: 'provenance-test' }));
  return {
    id: 'run-1',
    nodeId: 'transform-generate-square',
    attempt: 1,
    status: 'succeeded',
    graph,
    material: {
      sourceAssets: [{
        nodeId: 'slot-product', assetId: 'product', relativePath: 'assets/product.png',
        contentHash: 'sha256:product',
      }],
      prompt: {
        brief: 'Launch campaign', artDirection: 'Keep product left', instructions: 'Generate Square',
        constraints: ['Preserve logo'], effectivePrompt: 'Launch campaign. Keep product left.',
      },
      provider: { id: 'qa-fake', model: null, effectiveOptions: { fixture: 'square' } },
      executor: { id: 'campaign-generate', version: '1', requestSchemaVersion: '1' },
    },
    startedAt: 100,
    finishedAt: 120,
    outputs: [{
      assetReferenceId: 'asset-ref-square', assetId: 'square', relativePath: 'assets/square.png',
      contentHash: 'sha256:square', acceptedAt: 120,
    }],
    ...overrides,
  };
}

describe('workflow run provenance', () => {
  it('creates stable provider-neutral revisions and material keys', () => {
    const first = createWorkflowRunRecord(draft(), canonicalHash);
    const reordered = draft();
    reordered.material.provider.effectiveOptions = { fixture: 'square' };
    const second = createWorkflowRunRecord(reordered, canonicalHash);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      recordVersion: 1,
      status: 'succeeded',
      workflowRevision: expect.stringContaining('sha256:'),
      nodeRevision: expect.stringContaining('sha256:'),
      materialKey: expect.stringContaining('workflow-cache-v1:'),
      prompt: { effectivePromptHash: expect.stringContaining('sha256:') },
    });
    expect(JSON.stringify(first)).not.toMatch(/transcript|token|projectPath|executable/i);
  });

  it.each([
    ['source content', (value: WorkflowRunRecordDraft) => { value.material.sourceAssets[0].contentHash = 'sha256:changed'; }],
    ['brief', (value: WorkflowRunRecordDraft) => { value.material.prompt.brief = 'Changed'; }],
    ['model', (value: WorkflowRunRecordDraft) => { value.material.provider.model = 'other-model'; }],
    ['effective option', (value: WorkflowRunRecordDraft) => { value.material.provider.effectiveOptions = { fixture: 'portrait' }; }],
    ['executor version', (value: WorkflowRunRecordDraft) => { value.material.executor.version = '2'; }],
  ] as const)('changes the material key when %s changes', (_label, mutate) => {
    const baseline = draft();
    const changed = draft();
    mutate(changed);
    expect(createWorkflowRunRecord(changed, canonicalHash).materialKey)
      .not.toBe(createWorkflowRunRecord(baseline, canonicalHash).materialKey);
  });

  it('derives durable failed state while preserving earlier accepted output history', () => {
    const success = createWorkflowRunRecord(draft(), canonicalHash);
    const failure = createWorkflowRunRecord(draft({
      id: 'run-2', attempt: 2, status: 'failed', startedAt: 200, finishedAt: 210, outputs: [],
      failure: { code: 'PROVIDER_ERROR', message: 'Provider failed safely' },
    }), canonicalHash);
    const graph = structuredClone(draft().graph);
    graph.nodes.find((node) => node.id === success.nodeId)!.runRecordIds = [success.id, failure.id];
    graph.runRecords = [success, failure];

    expect(deriveWorkflowNodeRunState(graph, success.nodeId, failure.materialKey)).toMatchObject({
      state: 'failed',
      latestRun: { id: 'run-2', attempt: 2 },
      acceptedOutputs: [{ assetId: 'square', acceptedAt: 120 }],
    });
  });

  it('derives stale only when the latest successful material no longer matches', () => {
    const success = createWorkflowRunRecord(draft(), canonicalHash);
    const graph = structuredClone(draft().graph);
    graph.nodes.find((node) => node.id === success.nodeId)!.runRecordIds = [success.id];
    graph.runRecords = [success];

    expect(deriveWorkflowNodeRunState(graph, success.nodeId, success.materialKey).state).toBe('succeeded');
    expect(deriveWorkflowNodeRunState(graph, success.nodeId, 'workflow-cache-v1:changed').state).toBe('stale');
  });
});
