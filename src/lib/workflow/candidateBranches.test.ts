import { describe, expect, it, vi } from 'vitest';
import {
  WORKFLOW_MAX_CANDIDATES,
  createWorkflowCandidateLineage,
  deriveWorkflowCandidateBranchGroups,
  executeWorkflowCandidateBranches,
  retryWorkflowCandidateBranch,
} from './candidateBranches';
import { isFullWorkflowRunRecord, workflowSha256Bytes } from './provenance';
import { parseWorkflowGraphV2, serializeWorkflowGraphV2, type WorkflowRunRecordV1 } from './schema';
import { instantiateWorkflowTemplate } from './templates';
import {
  createWorkflowCompositionExecutor,
  executeCampaignGenerateTransform,
  type ExecuteCampaignGenerateOptions,
  type WorkflowProjectAsset,
} from './transformExecutor';

const productBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
const product: WorkflowProjectAsset = {
  id: 'asset-product', name: 'Product.png', relativePath: 'assets/Product.png',
  width: 1200, height: 1200, mime: 'image/png',
};

function campaign() {
  const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer', {
    graphId: 'candidate-branch-test',
  }));
  const slot = graph.nodes.find((node) => node.id === 'slot-product')!;
  slot.config = { ...slot.config, assetId: product.id, relativePath: product.relativePath };
  return graph;
}

function harness(cancelThird = false, reverseCompletion = false) {
  let active = 0;
  let maximumActive = 0;
  let providerCalls = 0;
  let now = 100;
  let stored = 0;
  const controller = new AbortController();
  const executor = createWorkflowCompositionExecutor('fake', async (_request, context) => {
    providerCalls += 1;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    const match = /candidate-(\d+)-[a-f0-9]+-attempt-(\d+)$/.exec(context.identity.runId);
    const ordinal = Number(match?.[1] ?? 0);
    const attempt = Number(match?.[2] ?? 1);
    await new Promise((resolve) => setTimeout(resolve, reverseCompletion ? (4 - ordinal) * 4 : 4));
    active -= 1;
    if (ordinal === 2 && attempt === 1) throw new Error('Candidate two failed safely.');
    if (cancelThird && ordinal === 3 && attempt === 1) controller.abort();
    return {
      kind: 'bytes', name: 'concept.png',
      bytes: new Uint8Array([137, 80, 78, 71, ordinal, attempt]),
      mime: 'image/png', width: 1024, height: 1024,
    };
  });
  const storeAsset = vi.fn(async (artifact: Readonly<{ name: string; bytes: Uint8Array }>) => {
    stored += 1;
    return {
      id: `stored-${stored}`,
      name: artifact.name,
      relativePath: `assets/generated/${artifact.name}`,
      width: 1024, height: 1024, mime: 'image/png',
    } satisfies WorkflowProjectAsset;
  });
  const options = (): ExecuteCampaignGenerateOptions => ({
    projectPath: '/virtual/project', provider: 'fake', executors: [executor], assets: [product],
    resolveAsset: async () => ({
      assetId: product.id, relativePath: product.relativePath,
      bytes: productBytes, contentHash: workflowSha256Bytes(productBytes),
    }),
    storeAsset,
    idGenerator: () => `seed-reference-${stored + 1}`,
    runIdGenerator: () => 'seed-run',
    clock: () => ++now,
    ...(cancelThird ? { signal: controller.signal } : {}),
  });
  return { options, storeAsset, maximumActive: () => maximumActive, providerCalls: () => providerCalls };
}

describe('workflow candidate branches', () => {
  it('creates stable bounded candidate and branch group identities', () => {
    const first = createWorkflowCandidateLineage('branch-group-a', 'transform-generate-square', 1, 3);
    const repeated = createWorkflowCandidateLineage('branch-group-a', 'transform-generate-square', 1, 3);

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({
      version: 1,
      branchGroupId: 'branch-group-a',
      candidateId: expect.stringMatching(/^candidate-1-[a-f0-9]{20}$/),
      ordinal: 1,
      requestedCount: 3,
      sourceNodeId: 'transform-generate-square',
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => createWorkflowCandidateLineage('branch-group-a', 'transform-generate-square', 1, 1))
      .toThrow(/at least 2/i);
    expect(() => createWorkflowCandidateLineage(
      'branch-group-a', 'transform-generate-square', 1, WORKFLOW_MAX_CANDIDATES + 1,
    )).toThrow(/at most/i);
    expect(() => createWorkflowCandidateLineage('branch-group-a', 'transform-generate-square', 4, 3))
      .toThrow(/ordinal/i);
  });

  it.each([
    ['low count', { count: 1, maxConcurrency: 1 }],
    ['high count', { count: 7, maxConcurrency: 1 }],
    ['zero concurrency', { count: 3, maxConcurrency: 0 }],
    ['excess concurrency', { count: 3, maxConcurrency: 4 }],
  ] as const)('rejects %s before project or provider side effects', async (_label, invalid) => {
    const run = harness();
    await expect(executeWorkflowCandidateBranches(campaign(), 'output-square', run.options(), {
      branchGroupId: 'invalid-before-side-effects', ...invalid,
    })).rejects.toThrow();
    expect(run.providerCalls()).toBe(0);
    expect(run.storeAsset).not.toHaveBeenCalled();
  });

  it('preserves accepted history while bounded concurrent siblings partially fail and reopen', async () => {
    const run = harness();
    const seeded = await executeCampaignGenerateTransform(campaign(), 'output-square', run.options());
    const acceptedBefore = structuredClone(seeded.graph.runRecords);
    const outputBefore = structuredClone(
      seeded.graph.nodes.find((node) => node.id === 'output-square')!.config,
    );

    const outcome = await executeWorkflowCandidateBranches(seeded.graph, 'output-square', run.options(), {
      branchGroupId: 'branch-group-a',
      count: 3,
      maxConcurrency: 2,
    });

    expect(run.maximumActive()).toBe(2);
    expect(outcome.group).toMatchObject({
      id: 'branch-group-a', sourceNodeId: 'transform-generate-square', requestedCount: 3,
      candidates: [
        { ordinal: 1, status: 'succeeded', attemptCount: 1 },
        { ordinal: 2, status: 'failed', attemptCount: 1 },
        { ordinal: 3, status: 'succeeded', attemptCount: 1 },
      ],
    });
    expect(outcome.graph.runRecords.slice(0, acceptedBefore.length)).toEqual(acceptedBefore);
    expect(outcome.graph.nodes.find((node) => node.id === 'output-square')!.config).toEqual(outputBefore);
    expect(outcome.graph.assetReferences.slice(0, seeded.graph.assetReferences.length))
      .toEqual(seeded.graph.assetReferences);
    const candidateRuns = outcome.graph.runRecords.filter((record): record is WorkflowRunRecordV1 => (
      isFullWorkflowRunRecord(record) && record.candidate?.branchGroupId === 'branch-group-a'
    ));
    expect(candidateRuns).toHaveLength(3);
    expect(candidateRuns.map((record) => record.candidate?.candidateId)).toEqual(
      [1, 2, 3].map((ordinal) => (
        createWorkflowCandidateLineage('branch-group-a', 'transform-generate-square', ordinal, 3).candidateId
      )),
    );
    expect(candidateRuns[0]).toMatchObject({
      id: expect.stringMatching(/candidate-1-.*-attempt-1$/),
      nodeId: 'transform-generate-square',
      materialKey: expect.stringMatching(/^workflow-cache-v1:/),
      sourceAssets: [{ nodeId: 'slot-product', assetId: product.id, contentHash: workflowSha256Bytes(productBytes) }],
      prompt: { constraints: expect.any(Array), effectivePromptHash: expect.stringMatching(/^sha256:/) },
      candidate: { branchGroupId: 'branch-group-a', sourceNodeId: 'transform-generate-square' },
    });
    expect(candidateRuns.filter((record) => record.status === 'succeeded')
      .every((record) => record.outputs.every((output) => output.acceptedAt === undefined))).toBe(true);
    const candidateReferences = outcome.graph.assetReferences.slice(seeded.graph.assetReferences.length);
    expect(new Set(candidateReferences.map((reference) => reference.id)).size).toBe(2);
    expect(new Set(candidateReferences.map((reference) => reference.assetId)).size).toBe(2);
    expect(new Set(candidateReferences.map((reference) => reference.relativePath)).size).toBe(2);

    const serialized = serializeWorkflowGraphV2(outcome.graph);
    const reopened = parseWorkflowGraphV2(JSON.parse(serialized));
    expect(reopened).toMatchObject({ ok: true, value: outcome.graph });
    expect(deriveWorkflowCandidateBranchGroups(reopened.value!)).toEqual([outcome.group]);
  });

  it('retries only the failed candidate and never mutates successful or earlier attempts', async () => {
    const run = harness();
    const first = await executeWorkflowCandidateBranches(campaign(), 'output-square', run.options(), {
      branchGroupId: 'branch-group-retry', count: 3, maxConcurrency: 2,
    });
    const failed = first.group.candidates.find((candidate) => candidate.status === 'failed')!;
    const historyBefore = structuredClone(first.graph.runRecords);
    const referencesBefore = structuredClone(first.graph.assetReferences);

    const retried = await retryWorkflowCandidateBranch(
      first.graph, failed.candidateId, run.options(), { maxConcurrency: 1 },
    );

    expect(retried.graph.runRecords.slice(0, historyBefore.length)).toEqual(historyBefore);
    expect(retried.graph.assetReferences.slice(0, referencesBefore.length)).toEqual(referencesBefore);
    expect(retried.candidate).toMatchObject({
      candidateId: failed.candidateId,
      status: 'succeeded',
      attemptCount: 2,
      latestRunId: expect.stringMatching(/attempt-2$/),
    });
    expect(retried.graph.runRecords.at(-1)).toMatchObject({
      status: 'succeeded', attempt: 4, retryOfRunId: failed.latestRunId,
      candidate: { candidateId: failed.candidateId, branchGroupId: 'branch-group-retry', attempt: 2 },
    });

    const added = await executeWorkflowCandidateBranches(retried.graph, 'output-square', run.options(), {
      branchGroupId: 'branch-group-added', count: 2, maxConcurrency: 1,
    });
    expect(added.graph.runRecords.slice(0, retried.graph.runRecords.length)).toEqual(retried.graph.runRecords);
    expect(deriveWorkflowCandidateBranchGroups(added.graph).map((group) => group.id))
      .toEqual(['branch-group-retry', 'branch-group-added']);
  });

  it('keeps successful, failed, and cancelled siblings in one durable group', async () => {
    const run = harness(true);
    const outcome = await executeWorkflowCandidateBranches(campaign(), 'output-square', run.options(), {
      branchGroupId: 'branch-group-mixed-terminal', count: 3, maxConcurrency: 1,
    });

    expect(outcome.group.candidates.map((candidate) => candidate.status))
      .toEqual(['succeeded', 'failed', 'cancelled']);
    expect(outcome.graph.runRecords.filter((record) => (
      isFullWorkflowRunRecord(record) && record.candidate?.branchGroupId === 'branch-group-mixed-terminal'
    ))).toHaveLength(3);
    expect(parseWorkflowGraphV2(JSON.parse(serializeWorkflowGraphV2(outcome.graph))).ok).toBe(true);
  });

  it('merges reverse completion in deterministic candidate ordinal order', async () => {
    const run = harness(false, true);
    const outcome = await executeWorkflowCandidateBranches(campaign(), 'output-square', run.options(), {
      branchGroupId: 'branch-group-reverse', count: 3, maxConcurrency: 3,
    });
    expect(outcome.group.candidates.map((candidate) => candidate.ordinal)).toEqual([1, 2, 3]);
    expect(outcome.graph.runRecords.filter((record): record is WorkflowRunRecordV1 => (
      isFullWorkflowRunRecord(record) && Boolean(record.candidate)
    ))
      .map((record) => record.candidate!.ordinal)).toEqual([1, 2, 3]);
  });

  it.each([
    ['mixed count', (records: WorkflowRunRecordV1[]) => { records[1].candidate!.requestedCount = 4; }],
    ['ordinal collision', (records: WorkflowRunRecordV1[]) => { records[1].candidate!.ordinal = 1; }],
    ['candidate ID collision', (records: WorkflowRunRecordV1[]) => {
      records[1].candidate!.candidateId = records[0].candidate!.candidateId;
    }],
    ['material snapshot drift', (records: WorkflowRunRecordV1[]) => { records[1].materialKey = 'workflow-cache-v1:drift'; }],
    ['node attempt collision', (records: WorkflowRunRecordV1[]) => { records[1].attempt = records[0].attempt; }],
    ['candidate attempt gap', (records: WorkflowRunRecordV1[]) => { records[1].candidate!.attempt = 2; }],
  ] as const)('rejects persisted branch group invariant: %s', async (_label, mutate) => {
    const run = harness();
    const outcome = await executeWorkflowCandidateBranches(campaign(), 'output-square', run.options(), {
      branchGroupId: 'branch-group-invalid', count: 3, maxConcurrency: 2,
    });
    const input = structuredClone(outcome.graph);
    const records = input.runRecords.filter((record): record is WorkflowRunRecordV1 => (
      isFullWorkflowRunRecord(record) && record.candidate?.branchGroupId === 'branch-group-invalid'
    ));
    mutate(records);
    expect(parseWorkflowGraphV2(input).ok).toBe(false);
  });
});
