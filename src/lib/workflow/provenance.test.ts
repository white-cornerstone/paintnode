import { describe, expect, it } from 'vitest';
import { instantiateWorkflowTemplate } from './templates';
import {
  createWorkflowRunRecord,
  canonicalWorkflowProvenanceJson,
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
        contentHash: 'sha256:product', name: 'Product', role: 'Hero product',
      }],
      prompt: {
        brief: 'Launch campaign', artDirection: 'Keep product left', instructions: 'Generate Square',
        constraints: ['Preserve logo'], effectivePrompt: 'Launch campaign. Keep product left.',
      },
      provider: { id: 'qa-fake', model: null, effectiveOptions: { fixture: 'square' } },
      executor: { id: 'campaign-generate', version: '1', requestSchemaVersion: '1' },
      output: { nodeId: 'output-square', title: 'Square 1:1', width: 1024, height: 1024 },
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
    ['source role', (value: WorkflowRunRecordDraft) => { value.material.sourceAssets[0].role = 'Background'; }],
    ['source name', (value: WorkflowRunRecordDraft) => { value.material.sourceAssets[0].name = 'Alternate Product'; }],
    ['brief', (value: WorkflowRunRecordDraft) => { value.material.prompt.brief = 'Changed'; }],
    ['effective prompt', (value: WorkflowRunRecordDraft) => { value.material.prompt.effectivePrompt = 'Changed final prompt'; }],
    ['model', (value: WorkflowRunRecordDraft) => { value.material.provider.model = 'other-model'; }],
    ['effective option', (value: WorkflowRunRecordDraft) => { value.material.provider.effectiveOptions = { quality: 'high' }; }],
    ['executor version', (value: WorkflowRunRecordDraft) => { value.material.executor.version = '2'; }],
    ['output target', (value: WorkflowRunRecordDraft) => { value.material.output.nodeId = 'output-portrait'; }],
    ['output title', (value: WorkflowRunRecordDraft) => { value.material.output.title = 'Portrait 4:5'; }],
    ['output dimensions', (value: WorkflowRunRecordDraft) => { value.material.output.height = 1280; }],
    ['node revision', (value: WorkflowRunRecordDraft) => {
      value.graph.nodes.find((node) => node.id === value.nodeId)!.config.instructions = 'Changed node';
    }],
  ] as const)('changes the material key when %s changes', (_label, mutate) => {
    const baseline = draft();
    const changed = draft();
    mutate(changed);
    expect(createWorkflowRunRecord(changed, canonicalHash).materialKey)
      .not.toBe(createWorkflowRunRecord(baseline, canonicalHash).materialKey);
  });

  it.each([
    ['token', 'secret-or-path'],
    ['apiKey', 'secret-or-path'],
    ['authorization', 'secret-or-path'],
    ['cookie', 'secret-or-path'],
    ['executable', '/opt/provider/bin'],
    ['projectPath', '/Volumes/private'],
    ['advancedJson', '{"access_token":"secret"}'],
    ['reasoningEffort', 'Bearer secret-token'],
    ['agentModel', '/opt/provider/model'],
    ['compressionQuality', 101],
    ['editChecksLevel', 4],
  ])('rejects unsafe provider option %s instead of persisting it', (key, unsafeValue) => {
    const value = draft();
    value.material.provider.effectiveOptions = { [key]: unsafeValue };
    expect(() => createWorkflowRunRecord(value, canonicalHash)).toThrow(/safe provider option/i);
  });

  it('sanitizes failures and rejects non-project-relative optional references', () => {
    const failed = draft({
      status: 'failed', outputs: [],
      failure: {
        code: 'PROVIDER ERROR!',
        message: 'Authorization: Bearer secret-token at /Users/alice/private/transcript.jsonl',
      },
    });
    const record = createWorkflowRunRecord(failed, canonicalHash);
    expect(record.failure).toEqual({
      code: 'EXECUTION_FAILED',
      message: 'The workflow attempt did not complete.',
    });
    expect(JSON.stringify(record)).not.toContain('secret-token');
    expect(JSON.stringify(record)).not.toContain('/Users/alice');

    expect(() => createWorkflowRunRecord({ ...draft(), debugArtifactReference: '/tmp/raw.jsonl' }, canonicalHash))
      .toThrow(/project-relative/i);
    expect(() => createWorkflowRunRecord({ ...draft(), debugArtifactReference: '../raw.jsonl' }, canonicalHash))
      .toThrow(/project-relative/i);
  });

  it('fails closed on model secrets and every shared record invariant', () => {
    for (const model of ['/opt/private/model', '/Volumes/Models/private', '{"access_token":"secret"}', 'Bearer secret']) {
      const value = draft();
      value.material.provider.model = model;
      expect(() => createWorkflowRunRecord(value, canonicalHash)).toThrow(/safe model/i);
    }

    const duplicate = draft();
    duplicate.outputs.push({ ...duplicate.outputs[0] });
    expect(() => createWorkflowRunRecord(duplicate, canonicalHash)).toThrow(/unique asset references/i);
    expect(() => createWorkflowRunRecord({ ...draft(), attempt: 0 }, canonicalHash)).toThrow(/at least 1/i);
    expect(() => createWorkflowRunRecord({ ...draft(), projectTaskId: '../task' }, canonicalHash)).toThrow(/safe identifier/i);
  });

  it('canonicalizes locale-independently and rejects cyclic or non-JSON-safe material', () => {
    expect(canonicalWorkflowProvenanceJson({ z: 1, 'ä': 2, a: 3 }))
      .toBe(canonicalWorkflowProvenanceJson({ a: 3, 'ä': 2, z: 1 }));
    expect(canonicalWorkflowProvenanceJson({ z: 1, 'ä': 2, a: 3 }))
      .toBe('{"a":3,"z":1,"ä":2}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalWorkflowProvenanceJson(cyclic)).toThrow(/acyclic/i);
    expect(() => canonicalWorkflowProvenanceJson({ unsafe: undefined })).toThrow(/JSON-safe/i);
    expect(() => canonicalWorkflowProvenanceJson({ unsafe: Number.NaN })).toThrow(/JSON-safe/i);
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

    const derived = deriveWorkflowNodeRunState(graph, success.nodeId, failure.materialKey);
    expect(derived).toMatchObject({
      state: 'failed',
      latestRun: { id: 'run-2', attempt: 2 },
      acceptedOutputs: [{ assetId: 'square', acceptedAt: 120 }],
    });
    expect(Object.isFrozen(derived)).toBe(true);
    expect(Object.isFrozen(derived.latestRun)).toBe(true);
    expect(Object.isFrozen(derived.acceptedOutputs)).toBe(true);
    expect(() => { derived.latestRun!.provider.effectiveOptions.fixture = 'mutated'; }).toThrow();
    expect(() => { derived.acceptedOutputs[0].assetId = 'mutated'; }).toThrow();
    expect(graph.runRecords).toEqual([success, failure]);
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
