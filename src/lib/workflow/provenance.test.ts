import { describe, expect, it } from 'vitest';
import { instantiateWorkflowTemplate } from './templates';
import {
  createWorkflowRunRecord,
  createWorkflowGenerationRevision,
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

  it('records independent AI roles and includes them in the material identity', () => {
    const baseline = draft();
    baseline.material.roles = {
      director: { id: 'claude', model: 'claude-sonnet', effectiveOptions: { claudeEffort: 'high' } },
      image: { id: 'grok', model: 'grok-imagine', effectiveOptions: { quality: 'high' } },
    };
    const changed = structuredClone(baseline);
    changed.material.roles!.image!.model = 'grok-imagine-v2';

    const record = createWorkflowRunRecord(baseline, canonicalHash);
    expect(record.roles).toEqual(baseline.material.roles);
    expect(createWorkflowRunRecord(changed, canonicalHash).materialKey).not.toBe(record.materialKey);
  });

  it('keeps persisted result pointers out of the next material key', () => {
    const baseline = draft();
    const completed = draft();
    completed.graph.nodes.find((node) => node.id === completed.nodeId)!.config = {
      ...completed.graph.nodes.find((node) => node.id === completed.nodeId)!.config,
      resultAssetReferenceId: 'previous-reference',
      resultAssetId: 'previous-asset',
      resultRelativePath: 'generated/previous.png',
    };

    expect(createWorkflowRunRecord(completed, canonicalHash).materialKey)
      .toBe(createWorkflowRunRecord(baseline, canonicalHash).materialKey);
  });

  it('scopes generation revisions to material settings on the selected output path', () => {
    const baseline = draft().graph;
    const layoutChange = structuredClone(baseline);
    layoutChange.nodes.find((node) => node.id === 'brief')!.position = { x: 999, y: 777 };
    const unrelatedChange = structuredClone(baseline);
    unrelatedChange.nodes.find((node) => node.id === 'output-portrait')!.config.finalHeight = 1440;
    const relevantChange = structuredClone(baseline);
    relevantChange.nodes.find((node) => node.id === 'brief')!.config.objective = 'A changed campaign objective.';

    const revision = createWorkflowGenerationRevision(baseline, 'output-square');
    expect(createWorkflowGenerationRevision(layoutChange, 'output-square')).toBe(revision);
    expect(createWorkflowGenerationRevision(unrelatedChange, 'output-square')).toBe(revision);
    expect(createWorkflowGenerationRevision(relevantChange, 'output-square')).not.toBe(revision);
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

  it('accepts only a retry link to the latest failed or cancelled attempt on the same node and workflow', () => {
    const firstFailure = createWorkflowRunRecord(draft({
      id: 'run-failed-1', status: 'failed', outputs: [], finishedAt: 120,
      failure: { code: 'EXECUTOR_ERROR', message: 'failed' },
    }), canonicalHash);
    const graph = structuredClone(draft().graph);
    graph.nodes.find((node) => node.id === firstFailure.nodeId)!.runRecordIds = [firstFailure.id];
    graph.runRecords = [firstFailure];
    const retry = createWorkflowRunRecord(draft({
      id: 'run-retry', attempt: 2, graph, retryOfRunId: firstFailure.id,
    }), canonicalHash);
    expect(retry.retryOfRunId).toBe(firstFailure.id);

    const success = createWorkflowRunRecord(draft({ id: 'run-success' }), canonicalHash);
    const successGraph = structuredClone(draft().graph);
    successGraph.nodes.find((node) => node.id === success.nodeId)!.runRecordIds = [success.id];
    successGraph.runRecords = [success];
    expect(() => createWorkflowRunRecord(draft({
      id: 'retry-success', attempt: 2, graph: successGraph, retryOfRunId: success.id,
    }), canonicalHash)).toThrow(/failed or cancelled/i);

    const otherNodeFailure = createWorkflowRunRecord(draft({
      id: 'other-node-failure', nodeId: 'composition', status: 'failed', outputs: [],
      failure: { code: 'EXECUTOR_ERROR', message: 'failed' },
    }), canonicalHash);
    const otherNodeGraph = structuredClone(draft().graph);
    otherNodeGraph.nodes.find((node) => node.id === otherNodeFailure.nodeId)!.runRecordIds = [otherNodeFailure.id];
    otherNodeGraph.runRecords = [otherNodeFailure];
    expect(() => createWorkflowRunRecord(draft({
      id: 'retry-other-node', attempt: 2, graph: otherNodeGraph, retryOfRunId: otherNodeFailure.id,
    }), canonicalHash)).toThrow(/same node/i);

    expect(() => createWorkflowRunRecord(draft({
      id: 'retry-other-workflow', attempt: 2, graph, retryOfRunId: 'missing-run',
    }), canonicalHash)).toThrow(/current workflow/i);
    expect(() => createWorkflowRunRecord(draft({
      id: 'retry-empty', attempt: 2, graph, retryOfRunId: '',
    }), canonicalHash)).toThrow(/safe identifier/i);

    const secondFailure = createWorkflowRunRecord(draft({
      id: 'run-failed-2', attempt: 2, graph, status: 'failed', outputs: [], finishedAt: 220,
      retryOfRunId: firstFailure.id,
      failure: { code: 'EXECUTOR_ERROR', message: 'failed again' },
    }), canonicalHash);
    const latestGraph = structuredClone(graph);
    latestGraph.nodes.find((node) => node.id === firstFailure.nodeId)!.runRecordIds.push(secondFailure.id);
    latestGraph.runRecords.push(secondFailure);
    expect(() => createWorkflowRunRecord(draft({
      id: 'retry-nonlatest', attempt: 3, graph: latestGraph, retryOfRunId: firstFailure.id,
    }), canonicalHash)).toThrow(/latest terminal attempt/i);
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

  it('derives a linked retry while preserving every accepted output in history', () => {
    const success = createWorkflowRunRecord(draft(), canonicalHash);
    const failure = createWorkflowRunRecord(draft({
      id: 'run-2', attempt: 2, status: 'failed', startedAt: 200, finishedAt: 210, outputs: [],
      failure: { code: 'PROVIDER_ERROR', message: 'Provider failed safely' },
    }), canonicalHash);
    const graph = structuredClone(draft().graph);
    graph.nodes.find((node) => node.id === success.nodeId)!.runRecordIds = [success.id, failure.id];
    graph.runRecords = [success, failure];
    const retry = createWorkflowRunRecord(draft({
      id: 'run-3', attempt: 3, graph, retryOfRunId: failure.id,
      startedAt: 300, finishedAt: 320,
      outputs: [{
        assetReferenceId: 'asset-ref-retry', assetId: 'retry-square',
        relativePath: 'assets/retry-square.png', contentHash: 'sha256:retrysquare', acceptedAt: 320,
      }],
    }), canonicalHash);
    graph.nodes.find((node) => node.id === success.nodeId)!.runRecordIds.push(retry.id);
    graph.runRecords.push(retry);

    const derived = deriveWorkflowNodeRunState(graph, success.nodeId, retry.materialKey);
    expect(derived).toMatchObject({
      state: 'succeeded',
      latestRun: { id: 'run-3', attempt: 3, retryOfRunId: 'run-2' },
      acceptedOutputs: [
        { assetId: 'square', acceptedAt: 120 },
        { assetId: 'retry-square', acceptedAt: 320 },
      ],
    });
    expect(Object.isFrozen(derived)).toBe(true);
    expect(Object.isFrozen(derived.latestRun)).toBe(true);
    expect(Object.isFrozen(derived.acceptedOutputs)).toBe(true);
    expect(() => { derived.latestRun!.provider.effectiveOptions.fixture = 'mutated'; }).toThrow();
    expect(() => { derived.acceptedOutputs[0].assetId = 'mutated'; }).toThrow();
    expect(graph.runRecords).toEqual([success, failure, retry]);
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
