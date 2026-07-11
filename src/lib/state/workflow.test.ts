import { describe, expect, it, vi } from 'vitest';
import { AiTaskStore } from './aiTasks.svelte';
import { WorkflowStore } from './workflow.svelte';
import assetsStoryboard from '../workflow/fixtures/v1/assets-storyboard.json';
import annotations from '../workflow/fixtures/v1/annotations.json';
import multipleOutputs from '../workflow/fixtures/v1/multiple-outputs.json';
import {
  WORKFLOW_GRAPH_VERSION,
  buildWorkflowDirectorContext,
  createWorkflowDirectorProposal,
  type WorkflowDirectorGraphDraft,
  deriveWorkflowNodeRunState,
  isFullWorkflowRunRecord,
  serializeWorkflowGraphV2,
  workflowSha256Bytes,
  type WorkflowGraphV2,
  type WorkflowIdGenerator,
  type WorkflowRunRecordV1,
} from '../workflow';
import { WORKFLOW_TEMPLATES, instantiateWorkflowTemplate } from '../workflow/templates';
import { workflowReadiness } from '../workflow/readiness';
import { createCreatorNode, type CreatorNodeType } from '../workflow/registry';
import type { ProjectAsset } from '../integrations/desktop';
import { bindWorkflowRoundTripAuthority } from './workflowEditorSession';
import { project } from './project.svelte';
import {
  WorkflowTransformExecutionError,
  createWorkflowCompositionExecutor,
} from '../workflow/transformExecutor';

const material = (bytes: Uint8Array) => ({
  assetId: 'product-asset',
  relativePath: 'assets/product.png',
  bytes,
  contentHash: workflowSha256Bytes(bytes),
});

function ids(): WorkflowIdGenerator {
  let sequence = 0;
  return (kind) => `${kind}-test-${++sequence}`;
}

const campaignProduct = {
  id: 'product-asset', kind: 'imported', name: 'Product.png', relativePath: 'assets/product.png',
  createdAt: 1, exists: true, width: 1200, height: 1200, mime: 'image/png',
} satisfies ProjectAsset;

function campaignStore(): WorkflowStore {
  const store = new WorkflowStore({ idGenerator: ids() });
  store.newFromTemplate('campaign-composer');
  store.assignAsset('slot-product', campaignProduct);
  return store;
}

function editorRoundTripStore(): WorkflowStore {
  const graph = structuredClone(instantiateWorkflowTemplate('campaign-composer', { graphId: 'store-editor-return' }));
  const node = graph.nodes.find((candidate) => candidate.id === 'transform-generate-square')!;
  const outputHash = `sha256:${'4'.repeat(64)}`;
  const run: WorkflowRunRecordV1 = {
    recordVersion: 1, id: 'store-run', nodeId: node.id, status: 'succeeded', attempt: 1,
    workflowRevision: `sha256:${'1'.repeat(64)}`, nodeRevision: `sha256:${'2'.repeat(64)}`,
    materialKey: 'store-material', sourceAssets: [],
    prompt: { brief: 'Brief', artDirection: 'Direction', instructions: 'Generate', constraints: [], effectivePromptHash: `sha256:${'3'.repeat(64)}` },
    provider: { id: 'qa-fake', model: null, effectiveOptions: {} },
    executor: { id: 'campaign-generate', version: '1', requestSchemaVersion: '1' },
    target: { nodeId: 'output-square', title: 'Square', width: 64, height: 64 },
    startedAt: 1, finishedAt: 2,
    outputs: [{
      assetReferenceId: 'store-source-ref', assetId: 'store-source-asset',
      relativePath: 'assets/generated/store-source.png', contentHash: outputHash, acceptedAt: 2,
    }],
  };
  node.runRecordIds = [run.id];
  graph.runRecords = [run];
  graph.assetReferences = [{
    id: 'store-source-ref', role: 'output', assetId: 'store-source-asset',
    relativePath: 'assets/generated/store-source.png',
  }];
  const store = new WorkflowStore({ idGenerator: ids() });
  store.openFromBytes(new TextEncoder().encode(serializeWorkflowGraphV2(graph)), null, graph.metadata.name);
  return store;
}

function editorArtifacts(id: string, digit: string) {
  return {
    document: {
      relativePath: `documents/workflow-edits/${id}.ora`,
      contentHash: `sha256:${digit.repeat(64)}`,
      mime: 'image/openraster' as const,
    },
    output: {
      id: `asset-${id}`, kind: 'edited', name: `${id}.png`,
      relativePath: `assets/generated/${id}.png`, createdAt: Number(digit), exists: true,
      width: 64, height: 64, mime: 'image/png', previewDataUrl: null,
    },
    outputContentHash: `sha256:${digit.repeat(64)}`,
  };
}

function deferredCampaignRun(store: WorkflowStore, currentProjectIdentity?: () => string | null) {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const run = store.runCampaignGenerate('output-square', {
    projectPath: '/virtual/project',
    provider: 'fake',
    executors: [createWorkflowCompositionExecutor('fake', async () => {
      await gate;
      return {
        kind: 'project-asset',
        asset: {
          id: 'deferred-result', name: 'Square.png', relativePath: 'generated/Square.png',
          width: 1024, height: 1024, mime: 'image/png',
        },
        bytes: new Uint8Array([1, 2, 3]),
      };
    })],
    assets: [campaignProduct],
    resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
    storeAsset: async () => { throw new Error('unused'); },
    currentProjectIdentity,
  });
  return { finish, run };
}

function directorContext(options: { assetAvailable?: boolean; generateAvailable?: boolean } = {}) {
  return buildWorkflowDirectorContext({
    brief: 'Create a square product launch.',
    assets: [{ ...campaignProduct, exists: options.assetAvailable ?? true }],
    requestedOutputs: [{ id: 'square', name: 'Square 1:1', width: 1024, height: 1024 }],
    capabilities: [{
      id: 'generate',
      available: options.generateAvailable ?? true,
      reason: options.generateAvailable === false ? 'Generate is currently unavailable.' : null,
    }],
  });
}

function directorProposal() {
  const context = directorContext();
  const draft: WorkflowDirectorGraphDraft = {
    version: 1,
    name: 'Director Square',
    summary: 'A product-led square campaign.',
    nodes: [
      { id: 'product', type: 'input', title: 'Product', assetId: campaignProduct.id, role: 'Hero product', required: true },
      { id: 'brief', type: 'brief', title: 'Brief', objective: 'Launch the product.', guidance: 'Keep identity.' },
      { id: 'art', type: 'art-direction', title: 'Art Direction', prompt: 'Premium studio lighting.' },
      { id: 'generate', type: 'transform', title: 'Generate', capability: 'generate', instructions: 'Generate square.' },
      { id: 'square', type: 'output', title: 'Square 1:1', width: 1024, height: 1024 },
    ],
    edges: [
      { id: 'product-art', source: { nodeId: 'product', portId: 'asset' }, target: { nodeId: 'art', portId: 'assets' } },
      { id: 'brief-art', source: { nodeId: 'brief', portId: 'prompt' }, target: { nodeId: 'art', portId: 'brief' } },
      { id: 'art-generate', source: { nodeId: 'art', portId: 'layout' }, target: { nodeId: 'generate', portId: 'source' } },
      { id: 'generate-square', source: { nodeId: 'generate', portId: 'result' }, target: { nodeId: 'square', portId: 'source' } },
    ],
  };
  return createWorkflowDirectorProposal(draft, context, { graphId: 'director-square' }).proposal!;
}

function reviewedDirectorProposal() {
  const base = directorProposal();
  const draft = structuredClone(base.draft);
  draft.nodes.push({
    id: 'review', type: 'review', title: 'Review Candidates', mode: 'human', instructions: 'Choose the strongest direction.',
  });
  draft.edges = draft.edges.filter((edge) => edge.id !== 'generate-square');
  draft.edges.push(
    {
      id: 'generate-review',
      source: { nodeId: 'generate', portId: 'result' },
      target: { nodeId: 'review', portId: 'candidates' },
    },
    {
      id: 'review-square',
      source: { nodeId: 'review', portId: 'selected' },
      target: { nodeId: 'square', portId: 'source' },
    },
  );
  return createWorkflowDirectorProposal(draft, directorContext(), { graphId: 'director-reviewed-square' }).proposal!;
}

function directorProposalWithContext(options: { assetAvailable?: boolean; generateAvailable?: boolean }) {
  const draft = directorProposal().draft;
  return createWorkflowDirectorProposal(draft, directorContext(options), { graphId: 'director-context-check' }).proposal!;
}

describe('WorkflowStore graph adapter', () => {
  it('accepts a validated Director proposal as one fresh dirty workflow session', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Previous workflow');
    store.openFromBytes(store.toBytes(), 'workflows/previous.cxflow.json', 'Previous workflow');
    const proposal = directorProposal();

    store.applyDirectorProposal(proposal);

    expect(store.graphSnapshot()).toEqual(proposal.graph);
    expect(store.name).toBe('Director Square');
    expect(store.savedPath).toBeNull();
    expect(store.migrationSourcePath).toBeNull();
    expect(store.requiresExplicitSave).toBe(false);
    expect(store.active).toBe(true);
    expect(store.selection).toEqual({ kind: 'composition' });
    expect(store.rev).toBe(1);
    expect(store.savedRev).toBe(0);
    expect(store.dirty).toBe(true);

    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), null, 'Director Square');
    expect(reopened.serialize()).toEqual(store.serialize());
  });

  it('rejects a non-acceptable Director proposal before mutating any workflow or session state', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Untouched');
    const before = store.graphSnapshot();
    const rev = store.rev;
    const proposal = { ...directorProposal(), canAccept: false };

    expect(() => store.applyDirectorProposal(proposal)).toThrow(/trusted validation|cannot be accepted/i);
    expect(store.graphSnapshot()).toBe(before);
    expect(store.name).toBe('Untouched');
    expect(store.rev).toBe(rev);
    expect(store.dirty).toBe(false);
  });

  it('rejects a Director replacement carrying persisted Review decisions', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Untouched');
    const before = store.toBytes();
    const proposal = directorProposal();
    const graph = structuredClone(proposal.graph);
    graph.reviewPromotions = [{
      version: 1,
      id: 'director-forged-promotion',
      reviewNodeId: 'review',
      sourceNodeId: 'generate',
      branchGroupId: 'branch-group',
      candidateId: 'candidate-1',
      candidateRunId: 'candidate-run-1',
      assetReferenceId: 'candidate-output-1',
      assetId: 'candidate-asset-1',
      relativePath: 'assets/candidate-1.png',
      contentHash: `sha256:${'a'.repeat(64)}`,
      materialKey: 'workflow-cache-v1:forged',
      reviewNodeRevision: `sha256:${'b'.repeat(64)}`,
      promotedAt: 1,
    }];

    expect(() => store.applyDirectorProposal({ ...proposal, graph })).toThrow(/trusted validation|fresh Director draft/i);
    expect(store.toBytes()).toEqual(before);
  });

  it.each([
    ['Input project binding', directorProposal, 'product', {
      assetId: 'asset-from-another-project', relativePath: 'assets/private-product.png',
    }],
    ['Brief history', directorProposal, 'brief', { lastAcceptedPrompt: 'Persisted prior prompt' }],
    ['Art Direction editor state', directorProposal, 'composition', {
      storyboardDataUrl: 'data:image/png;base64,cHJpdmF0ZQ==',
      storyboardOraPath: 'documents/private-storyboard.ora',
      storyboardAnnotations: ['Persisted annotation'],
      storyboardAnnotationItems: [{ id: 'persisted-mark' }],
    }],
    ['Transform result binding', directorProposal, 'generate', {
      resultAssetReferenceId: 'prior-result-reference',
      resultAssetId: 'prior-result-asset',
      resultRelativePath: 'assets/prior-result.png',
    }],
    ['Review selection state', reviewedDirectorProposal, 'review', {
      promotedCandidateId: 'prior-candidate', promotionId: 'prior-promotion',
    }],
    ['Output result binding', directorProposal, 'square', {
      outputAssetId: 'prior-output-asset',
      outputRelativePath: 'assets/prior-output.png',
      assetReferenceId: 'prior-output-reference',
    }],
  ] as const)('rejects forged %s config atomically', (_name, proposalFactory, nodeId, forgedConfig) => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Untouched');
    const before = store.toBytes();
    const proposal = proposalFactory();
    const graph = structuredClone(proposal.graph);
    const node = graph.nodes.find((candidate) => candidate.id === nodeId)!;
    node.config = { ...node.config, ...forgedConfig };

    expect(() => store.applyDirectorProposal({ ...proposal, graph })).toThrow(/trusted validation|fresh Director draft/i);
    expect(store.toBytes()).toEqual(before);
  });

  it('rejects future editor and round-trip ledgers not authored by the Director draft', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Untouched');
    const before = store.toBytes();
    const proposal = directorProposal();
    const graph = structuredClone(proposal.graph) as WorkflowGraphV2 & {
      editorRevisions: unknown[];
      workflowRoundTrips: unknown[];
    };
    graph.editorRevisions = [{ id: 'private-editor-revision' }] as never;
    graph.workflowRoundTrips = [{ id: 'private-round-trip' }] as never;

    expect(() => store.applyDirectorProposal({ ...proposal, graph })).toThrow(/trusted validation|fresh Director draft/i);
    expect(store.toBytes()).toEqual(before);
  });

  it.each([
    ['unavailable asset', { assetAvailable: false }, 'ASSET_UNAVAILABLE'],
    ['unsupported capability', { generateAvailable: false }, 'UNSUPPORTED_CAPABILITY'],
  ] as const)('recomputes %s instead of trusting forged acceptance metadata', (_name, options, issueCode) => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Untouched');
    const before = store.toBytes();
    const proposal = directorProposalWithContext(options);
    expect(proposal.canAccept).toBe(false);
    expect(proposal.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: issueCode })]));
    expect(() => store.applyDirectorProposal(proposal)).toThrow(/recomputed validation issue/i);
    expect(store.toBytes()).toEqual(before);

    expect(() => store.applyDirectorProposal({
      ...proposal,
      canAccept: true,
      issues: [],
      unsupportedCapabilities: [],
    })).toThrow(/trusted validation|cannot be accepted/i);
    expect(store.toBytes()).toEqual(before);
  });

  it('rejects deleted, changed, or reordered validation issues', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Untouched');
    const before = store.toBytes();
    const proposal = directorProposalWithContext({ assetAvailable: false, generateAvailable: false });
    expect(proposal.issues.length).toBeGreaterThan(1);
    for (const issues of [
      [],
      proposal.issues.slice(1),
      proposal.issues.map((issue, index) => index === 0 ? { ...issue, message: 'Changed issue.' } : issue),
      [...proposal.issues].reverse(),
    ]) {
      expect(() => store.applyDirectorProposal({ ...proposal, canAccept: true, issues })).toThrow(/trusted validation|cannot be accepted/i);
      expect(store.toBytes()).toEqual(before);
    }
  });

  it('rejects a canonical semantic draft and graph swapped into another accepted proposal', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Untouched');
    const before = store.toBytes();
    const original = directorProposal();
    const replacement = reviewedDirectorProposal();

    expect(() => store.applyDirectorProposal({
      ...original,
      draft: replacement.draft,
      graph: replacement.graph,
      summary: replacement.summary,
      nodes: replacement.nodes,
      requirements: replacement.requirements,
      unsupportedCapabilities: replacement.unsupportedCapabilities,
      issues: replacement.issues,
      canAccept: replacement.canAccept,
    })).toThrow(/trusted validation/i);
    expect(store.toBytes()).toEqual(before);
  });

  it('rejects captured asset or capability context replacement', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Untouched');
    const before = store.toBytes();
    const proposal = directorProposalWithContext({ assetAvailable: false, generateAvailable: false });
    const contextProposal = proposal as typeof proposal & { validationContext: ReturnType<typeof directorContext> };

    expect(() => store.applyDirectorProposal({
      ...proposal,
      validationContext: directorContext(),
      canAccept: true,
      issues: [],
      requirements: contextProposal.requirements.map((requirement) => ({ ...requirement, status: 'ready' as const })),
      unsupportedCapabilities: [],
    })).toThrow(/trusted validation/i);
    expect(store.toBytes()).toEqual(before);
  });

  it.each(['subclass', 'proxy'] as const)('rejects %s arrays that can inject config after comparison', (kind) => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Untouched');
    const before = store.toBytes();
    const proposal = directorProposal();
    const graph = structuredClone(proposal.graph);
    const canonicalNodes = graph.nodes;
    const inject = () => canonicalNodes.map((node, index) => index === 0
      ? { ...node, config: { ...node.config, resultAssetId: 'injected-after-comparison' } }
      : node);
    if (kind === 'subclass') {
      class InjectingNodes<T> extends Array<T> {
        override map<U>(_callback: (value: T, index: number, array: T[]) => U): U[] {
          return inject() as U[];
        }
      }
      const nodes = new InjectingNodes<WorkflowGraphV2['nodes'][number]>();
      graph.nodes.forEach((node) => nodes.push(node));
      graph.nodes = nodes;
    } else {
      graph.nodes = new Proxy(graph.nodes, {
        get(target, property, receiver) {
          if (property === 'map') return inject;
          return Reflect.get(target, property, receiver);
        },
      });
    }

    expect(() => store.applyDirectorProposal({ ...proposal, graph })).toThrow(/trusted validation|plain data/i);
    expect(store.toBytes()).toEqual(before);
  });

  it('rejects a Director proposal captured from a stale graph revision without changing bytes', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Working campaign');
    const proposal = directorProposal();
    const session = store.captureDirectorSession();
    store.setPrompt('A newer art direction written after the Director request.');
    const before = JSON.stringify(store.serialize());

    expect(() => store.applyDirectorProposal(proposal, session)).toThrow(/workflow changed/i);
    expect(JSON.stringify(store.serialize())).toBe(before);
    expect(store.name).toBe('Working campaign');
  });

  it('rejects a Director proposal captured from a different workflow session', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'First session');
    const session = store.captureDirectorSession();
    store.newFromTemplate('asset-composition', 'Second session');
    const before = JSON.stringify(store.serialize());

    expect(() => store.applyDirectorProposal(directorProposal(), session)).toThrow(/workflow changed/i);
    expect(JSON.stringify(store.serialize())).toBe(before);
    expect(store.name).toBe('Second session');
  });

  it('rejects a Director proposal after non-domain workflow state changes', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer', 'Original name');
    const session = store.captureDirectorSession();
    store.setName('Renamed while previewing');
    const before = JSON.stringify(store.serialize());

    expect(() => store.applyDirectorProposal(directorProposal(), session)).toThrow(/workflow changed/i);
    expect(JSON.stringify(store.serialize())).toBe(before);
    expect(store.name).toBe('Renamed while previewing');
  });
  it('exposes fake Transform running/succeeded state and persists the bound Square output on reopen', async () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer');
    const product = {
      id: 'product-asset', kind: 'imported', name: 'Product.png', relativePath: 'assets/product.png',
      createdAt: 1, exists: true, width: 1200, height: 1200, mime: 'image/png',
    } satisfies ProjectAsset;
    store.assignAsset('slot-product', product);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const run = store.runCampaignGenerate('output-square', {
      projectPath: '/virtual/project',
      provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => {
        await gate;
        return {
          kind: 'project-asset',
          asset: {
            id: 'result-square', name: 'Square.png', relativePath: 'generated/Square.png',
            width: 1024, height: 1024, mime: 'image/png',
          },
          bytes: new Uint8Array([4, 5, 6]),
        };
      })],
      assets: [product],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: async () => { throw new Error('bytes store should not run'); },
    });

    expect(store.transformExecution('transform-generate-square')).toMatchObject({ state: 'running' });
    finish();
    expect((await run).committed).toBe(true);
    expect(store.transformExecution('transform-generate-square')).toMatchObject({
      state: 'succeeded', assetId: 'result-square',
    });
    expect(store.outputNode('output-square')).toMatchObject({
      outputAssetId: 'result-square', outputRelativePath: 'generated/Square.png',
    });

    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), null, 'Campaign');
    expect(reopened.outputNode('output-square')).toMatchObject({
      outputAssetId: 'result-square', outputRelativePath: 'generated/Square.png',
    });
    expect(reopened.transformExecution('transform-generate-square')).toMatchObject({
      state: 'succeeded', assetId: 'result-square',
    });
    reopened.setBriefObjective('brief', 'A materially different campaign objective.');
    expect(reopened.transformExecution('transform-generate-square')).toMatchObject({
      state: 'stale', assetId: 'result-square',
    });
  });

  it('persists a safe failed attempt and restores it after reopen', async () => {
    const store = campaignStore();
    await expect(store.runCampaignGenerate('output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => {
        throw new Error('token=secret at /tmp/provider.jsonl');
      })],
      assets: [campaignProduct],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: async () => { throw new Error('unused'); },
      runIdGenerator: () => 'failed-run', clock: () => 100,
    })).rejects.toMatchObject({ code: 'EXECUTOR_ERROR' });

    expect(store.graphSnapshot().runRecords).toEqual([
      expect.objectContaining({
        id: 'failed-run', status: 'failed',
        failure: { code: 'EXECUTOR_ERROR', message: 'The provider could not complete this attempt.' },
      }),
    ]);
    expect(store.transformExecution('transform-generate-square')).toMatchObject({
      state: 'failed', message: 'The provider could not complete this attempt. Retry Generate.', assetId: null,
    });
    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), null, 'Campaign');
    expect(reopened.transformExecution('transform-generate-square')).toMatchObject({
      state: 'failed', message: 'The provider could not complete this attempt. Retry Generate.', assetId: null,
    });
  });

  it('returns fixed safe errors to Board and task callers when source materialization fails immediately', async () => {
    const store = campaignStore();
    const failure = await store.runCampaignGenerate('output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', vi.fn())],
      assets: [campaignProduct],
      resolveAsset: async () => { throw new Error('Bearer secret at /Users/alice/private/source.png'); },
      storeAsset: async () => { throw new Error('unused'); },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(WorkflowTransformExecutionError);
    expect(failure).toMatchObject({
      code: 'EXECUTOR_ERROR',
      message: 'The workflow could not prepare this generation attempt.',
      nextAction: 'Retry Generate',
    });
    expect((failure as Error).message).not.toMatch(/alice|Bearer|private/i);

    const tasks = new AiTaskStore();
    const task = tasks.create({
      kind: 'workflow', title: 'Workflow: Square', subtitle: 'fake', progress: 'Preparing',
      detail: { kind: 'workflow', providerLabel: 'fake', outputName: 'Square' },
    });
    tasks.fail(task.id, (failure as Error).message);
    expect(task.error).toBe('The workflow could not prepare this generation attempt.');
    expect(task.error).not.toMatch(/alice|Bearer|private/i);

    expect(store.transformExecution('transform-generate-square')).toEqual({
      state: 'failed',
      message: 'The workflow could not prepare this generation attempt. Retry Generate.',
      assetId: null,
    });
    expect(store.transformExecution('transform-generate-square').message).not.toMatch(/alice|Bearer|private/i);
  });

  it('does not persist a failed attempt after the workflow changes while it is running', async () => {
    const store = campaignStore();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const run = store.runCampaignGenerate('output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => {
        await gate;
        throw new Error('provider failed');
      })],
      assets: [campaignProduct],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: async () => { throw new Error('unused'); },
    });
    store.setBriefObjective('brief', 'Edited while failure was pending.');
    finish();
    await expect(run).rejects.toMatchObject({ code: 'EXECUTOR_ERROR' });
    expect(store.graphSnapshot().runRecords).toEqual([]);
    expect(store.briefNodes[0].objective).toBe('Edited while failure was pending.');
  });

  it('persists no transient running record and safely detaches a stuck cancellation before late completion', async () => {
    const store = campaignStore();
    let finishProvider!: () => void;
    let providerStarted!: () => void;
    let reportLateProgress!: () => void;
    const started = new Promise<void>((resolve) => { providerStarted = resolve; });
    const gate = new Promise<void>((resolve) => { finishProvider = resolve; });
    const progress = vi.fn();
    const run = store.runCampaignGenerate('output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async (_request, context) => {
        reportLateProgress = () => context.reportProgress({ message: 'late provider progress' });
        providerStarted();
        await gate;
        return {
          kind: 'project-asset' as const,
          asset: {
            id: 'late-result', name: 'Late.png', relativePath: 'generated/late.png',
            width: 1024, height: 1024, mime: 'image/png',
          },
          bytes: new Uint8Array([1, 2, 3]),
        };
      })],
      assets: [campaignProduct],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: async () => { throw new Error('unused'); },
      cancelExecution: () => new Promise(() => undefined),
      cancellationTimeoutMs: 5,
      onProgress: progress,
      runIdGenerator: () => 'cancel-store-run',
      clock: () => 100,
    });
    void run.catch(() => undefined);
    await started;
    expect(store.graphSnapshot().runRecords).toEqual([]);

    await expect(store.cancelCampaignGenerate('transform-generate-square')).resolves.toEqual({
      disposition: 'detached',
      message: 'Provider termination was not confirmed; late results will be ignored.',
    });
    const callsAfterCancel = progress.mock.calls.length;
    reportLateProgress();
    finishProvider();
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    await Promise.resolve();

    expect(progress).toHaveBeenCalled();
    expect(progress.mock.calls).toHaveLength(callsAfterCancel);
    expect(store.outputNode('output-square')?.outputAssetId).toBeNull();
    expect(store.graphSnapshot().runRecords).toEqual([
      expect.objectContaining({ id: 'cancel-store-run', status: 'cancelled' }),
    ]);
    expect(store.transformExecution('transform-generate-square')).toMatchObject({
      state: 'cancelled',
      message: 'Provider termination was not confirmed; late results will be ignored.',
      assetId: null,
    });
  });

  it('normalizes a legacy persisted running attempt to recoverable interrupted history on reopen', async () => {
    const source = campaignStore();
    await source.runCampaignGenerate('output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async () => ({
        kind: 'project-asset' as const,
        asset: {
          id: 'accepted-result', name: 'Accepted.png', relativePath: 'generated/accepted.png',
          width: 1024, height: 1024, mime: 'image/png',
        },
        bytes: new Uint8Array([1, 2, 3]),
      }))],
      assets: [campaignProduct],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: async () => { throw new Error('unused'); },
      runIdGenerator: () => 'accepted-run', clock: () => 100,
    });
    const legacyGraph = structuredClone(source.graphSnapshot());
    const accepted = legacyGraph.runRecords.find(isFullWorkflowRunRecord)!;
    const interrupted = {
      ...structuredClone(accepted),
      id: 'legacy-running-run',
      attempt: 2,
      status: 'running' as const,
      startedAt: 200,
      finishedAt: null,
      outputs: [],
    };
    legacyGraph.runRecords.push(interrupted);
    legacyGraph.nodes.find((node) => node.id === interrupted.nodeId)!.runRecordIds.push(interrupted.id);
    expect(JSON.parse(serializeWorkflowGraphV2(legacyGraph)).runRecords.at(-1)).toMatchObject({
      status: 'failed', failure: { code: 'INTERRUPTED' },
    });

    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(
      new TextEncoder().encode(JSON.stringify(legacyGraph)),
      'workflows/campaign.cxflow.json',
      'Campaign',
    );
    const normalized = reopened.graphSnapshot();
    expect(normalized.runRecords.at(-1)).toMatchObject({
      id: 'legacy-running-run', status: 'failed', finishedAt: 200,
      failure: { code: 'INTERRUPTED', message: 'The attempt was interrupted before it completed.' },
    });
    expect(normalized.runRecords.some((record) => record.status === 'running')).toBe(false);
    expect(reopened.requiresExplicitSave).toBe(true);
    expect(reopened.savedPath).toBeNull();
    expect(reopened.migrationSourcePath).toBe('workflows/campaign.cxflow.json');
    expect(reopened.dirty).toBe(true);
    expect(reopened.transformExecution(interrupted.nodeId)).toMatchObject({
      state: 'failed', message: 'The attempt was interrupted before it completed. Retry Generate.',
    });
    expect(deriveWorkflowNodeRunState(normalized, interrupted.nodeId).acceptedOutputs).toEqual([
      expect.objectContaining({ assetId: 'accepted-result' }),
    ]);
  });

  it('keeps the newest overlapping Transform result when an older run finishes late', async () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer');
    const product = {
      id: 'product-asset', kind: 'imported', name: 'Product.png', relativePath: 'assets/product.png',
      createdAt: 1, exists: true, width: 1200, height: 1200, mime: 'image/png',
    } satisfies ProjectAsset;
    store.assignAsset('slot-product', product);
    const resolvers: Array<(id: string) => void> = [];
    const executor = createWorkflowCompositionExecutor('fake', () => new Promise((resolve) => {
      resolvers.push((assetId) => resolve({
        kind: 'project-asset',
        asset: {
          id: assetId, name: `${assetId}.png`, relativePath: `generated/${assetId}.png`,
          width: 1024, height: 1024, mime: 'image/png',
        },
        bytes: new Uint8Array([7, 8, 9]),
      }));
    }));
    const options = {
      projectPath: '/virtual/project', provider: 'fake', executors: [executor], assets: [product],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: async () => { throw new Error('unused'); },
    };
    const older = store.runCampaignGenerate('output-square', options);
    void older.catch(() => undefined);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const newer = store.runCampaignGenerate('output-square', options);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]('newer');
    expect((await newer).committed).toBe(true);
    await expect(older).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(store.outputNode('output-square')?.outputAssetId).toBe('newer');
    expect(store.transformExecution('transform-generate-square')).toMatchObject({ state: 'succeeded', assetId: 'newer' });
    expect(store.serialize().runRecords).toEqual([
      expect.objectContaining({ attempt: 1, status: 'cancelled' }),
      expect.objectContaining({ attempt: 2, status: 'succeeded' }),
    ]);
    const records = store.serialize().runRecords.filter(isFullWorkflowRunRecord);
    expect(records[0].retryOfRunId).toBeUndefined();
    expect(records[1].retryOfRunId).toBe(records[0].id);
  });

  it('serializes three same-node starts into durable cancelled retry history', async () => {
    const store = campaignStore();
    const cancelExecution = vi.fn(() => new Promise<never>(() => undefined));
    const resolvers: Array<(assetId: string) => void> = [];
    const executor = createWorkflowCompositionExecutor('fake', () => new Promise((resolve) => {
      resolvers.push((assetId) => resolve({
        kind: 'project-asset',
        asset: {
          id: assetId, name: `${assetId}.png`, relativePath: `generated/${assetId}.png`,
          width: 1024, height: 1024, mime: 'image/png',
        },
        bytes: new Uint8Array([7, 8, 9]),
      }));
    }));
    const options = {
      projectPath: '/virtual/project', provider: 'fake', executors: [executor], assets: [campaignProduct],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: async () => { throw new Error('unused'); },
      runIdGenerator: (_nodeId: string, attempt: number) => `run-${attempt}`,
      cancelExecution,
      cancellationTimeoutMs: 5,
    };

    const first = store.runCampaignGenerate('output-square', options);
    void first.catch(() => undefined);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const second = store.runCampaignGenerate('output-square', options);
    void second.catch(() => undefined);
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    const third = store.runCampaignGenerate('output-square', options);
    await vi.waitFor(() => expect(resolvers).toHaveLength(3));
    resolvers[2]('third');

    await expect(first).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(second).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(third).resolves.toMatchObject({ committed: true });
    expect(store.serialize().runRecords).toEqual([
      expect.objectContaining({ id: 'run-1', attempt: 1, status: 'cancelled' }),
      expect.objectContaining({ id: 'run-2', attempt: 2, status: 'cancelled', retryOfRunId: 'run-1' }),
      expect.objectContaining({ id: 'run-3', attempt: 3, status: 'succeeded', retryOfRunId: 'run-2' }),
    ]);
    expect(store.serialize().runRecords.filter(isFullWorkflowRunRecord)[0].retryOfRunId).toBeUndefined();
    expect(cancelExecution).toHaveBeenCalledTimes(2);
  });

  it('supersedes a run blocked forever while resolving source material', async () => {
    const store = campaignStore();
    let assetReads = 0;
    const service = vi.fn(async () => ({
      kind: 'project-asset' as const,
      asset: {
        id: 'replacement', name: 'Replacement.png', relativePath: 'generated/replacement.png',
        width: 1024, height: 1024, mime: 'image/png',
      },
      bytes: new Uint8Array([1, 2, 3]),
    }));
    const executor = createWorkflowCompositionExecutor('fake', service);
    const options = {
      projectPath: '/virtual/project', provider: 'fake', executors: [executor], assets: [campaignProduct],
      resolveAsset: async () => {
        assetReads += 1;
        if (assetReads === 1) return new Promise<never>(() => undefined);
        return material(new Uint8Array([137, 80, 78, 71]));
      },
      storeAsset: async () => { throw new Error('unused'); },
      runIdGenerator: (_nodeId: string, attempt: number) => `asset-run-${attempt}`,
    };

    const blocked = store.runCampaignGenerate('output-square', options);
    void blocked.catch(() => undefined);
    await vi.waitFor(() => expect(assetReads).toBe(1));
    const replacement = store.runCampaignGenerate('output-square', options);

    await expect(blocked).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(replacement).resolves.toMatchObject({ committed: true });
    expect(store.serialize().runRecords).toEqual([
      expect.objectContaining({ id: 'asset-run-1', attempt: 1, status: 'cancelled' }),
      expect.objectContaining({ id: 'asset-run-2', attempt: 2, status: 'succeeded', retryOfRunId: 'asset-run-1' }),
    ]);
    expect(service).toHaveBeenCalledOnce();
  });

  it('supersedes a run blocked forever while materializing the storyboard', async () => {
    const store = campaignStore();
    store.setStoryboardDataUrl('data:image/png;base64,AA==');
    let storyboardReads = 0;
    const service = vi.fn(async () => ({
      kind: 'project-asset' as const,
      asset: {
        id: 'storyboard-replacement', name: 'Replacement.png',
        relativePath: 'generated/storyboard-replacement.png', width: 1024, height: 1024, mime: 'image/png',
      },
      bytes: new Uint8Array([1, 2, 3]),
    }));
    const executor = createWorkflowCompositionExecutor('fake', service);
    const options = {
      projectPath: '/virtual/project', provider: 'fake', executors: [executor], assets: [campaignProduct],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      readStoryboard: async () => {
        storyboardReads += 1;
        if (storyboardReads === 1) return new Promise<never>(() => undefined);
        return { bytes: new Uint8Array([137, 80, 78, 71]), relativePath: 'storyboards/campaign.png' };
      },
      storeAsset: async () => { throw new Error('unused'); },
      runIdGenerator: (_nodeId: string, attempt: number) => `storyboard-run-${attempt}`,
    };

    const blocked = store.runCampaignGenerate('output-square', options);
    void blocked.catch(() => undefined);
    await vi.waitFor(() => expect(storyboardReads).toBe(1));
    const replacement = store.runCampaignGenerate('output-square', options);

    await expect(blocked).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(replacement).resolves.toMatchObject({ committed: true });
    expect(store.serialize().runRecords).toEqual([
      expect.objectContaining({ id: 'storyboard-run-1', attempt: 1, status: 'cancelled' }),
      expect.objectContaining({
        id: 'storyboard-run-2', attempt: 2, status: 'succeeded', retryOfRunId: 'storyboard-run-1',
      }),
    ]);
    expect(service).toHaveBeenCalledOnce();
  });

  it('does not overwrite workflow edits made while a Transform is running', async () => {
    const store = campaignStore();
    const deferred = deferredCampaignRun(store);
    store.setBriefObjective('brief', 'Edited while the provider was running.');
    deferred.finish();
    const outcome = await deferred.run;

    expect(outcome.committed).toBe(false);
    expect(outcome.commitMessage).toMatch(/workflow changed/i);
    expect(outcome.commitMessage).toContain('generated/Square.png');
    expect(store.briefNodes[0].objective).toBe('Edited while the provider was running.');
    expect(store.outputNode('output-square')?.outputAssetId).toBeNull();
    expect(store.transformExecution('transform-generate-square')).toMatchObject({ state: 'failed' });
  });

  it.each(['new', 'open', 'close'] as const)('does not bind a late result after the workflow session is %s', async (action) => {
    const store = campaignStore();
    const originalBytes = store.toBytes();
    const deferred = deferredCampaignRun(store);
    void deferred.run.catch(() => undefined);
    if (action === 'new') store.newFromTemplate('campaign-composer', 'New session');
    else if (action === 'open') store.openFromBytes(originalBytes, null, 'Reopened session');
    else store.close();
    deferred.finish();
    await expect(deferred.run).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(store.outputNode('output-square')?.outputAssetId).toBeNull();
    if (action === 'new') expect(store.name).toBe('New session');
    if (action === 'close') expect(store.active).toBe(false);
  });

  it('aborts a session-switched store operation, closes progress, and starts bounded provider cancellation', async () => {
    const store = campaignStore();
    let finishStore!: (asset: ProjectAsset) => void;
    let storeStarted!: () => void;
    let reportLate!: () => void;
    const started = new Promise<void>((resolve) => { storeStarted = resolve; });
    const stored = new Promise<ProjectAsset>((resolve) => { finishStore = resolve; });
    const progress = vi.fn();
    const cancelExecution = vi.fn(async () => ({ disposition: 'terminated' as const }));
    const run = store.runCampaignGenerate('output-square', {
      projectPath: '/virtual/project', provider: 'fake',
      executors: [createWorkflowCompositionExecutor('fake', async (_request, context) => {
        reportLate = () => context.reportProgress({ message: 'late store progress' });
        return {
          kind: 'bytes' as const,
          name: 'pending.png', bytes: new Uint8Array([1, 2, 3]), mime: 'image/png',
          width: 1024, height: 1024,
        };
      })],
      assets: [campaignProduct],
      resolveAsset: async () => material(new Uint8Array([137, 80, 78, 71])),
      storeAsset: async () => {
        storeStarted();
        return stored;
      },
      cancelExecution,
      onProgress: progress,
      runIdGenerator: () => 'session-switch-store',
      clock: () => 100,
    });
    void run.catch(() => undefined);
    await started;
    const progressBeforeClose = progress.mock.calls.length;

    store.close();
    reportLate();
    finishStore({
      id: 'late-store-result', kind: 'generated', name: 'Late.png', relativePath: 'generated/late.png',
      createdAt: 1, exists: true, width: 1024, height: 1024, mime: 'image/png',
    });
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    await Promise.resolve();

    expect(cancelExecution).toHaveBeenCalledOnce();
    expect(progress.mock.calls).toHaveLength(progressBeforeClose);
    expect(store.outputNode('output-square')?.outputAssetId).toBeNull();
    expect(store.active).toBe(false);
  });

  it('does not bind a late result after the active project identity changes', async () => {
    const store = campaignStore();
    let projectIdentity = 'project-session-a:/virtual/project';
    const deferred = deferredCampaignRun(store, () => projectIdentity);
    projectIdentity = 'project-session-b:/other/project';
    deferred.finish();
    const outcome = await deferred.run;

    expect(outcome.committed).toBe(false);
    expect(outcome.commitMessage).toMatch(/project changed/i);
    expect(store.outputNode('output-square')?.outputAssetId).toBeNull();
  });
  it('adds every creator registry node and preserves exact config and port identity on reopen', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard('Palette additions');
    const types: CreatorNodeType[] = ['input', 'brief', 'art-direction', 'transform', 'review', 'output'];
    const added = types.map((type, index) => store.addCreatorNode(type, { x: 50 + index * 250, y: 500 }));
    const graph = store.graphSnapshot();

    for (const [index, nodeId] of added.entries()) {
      const expected = createCreatorNode(types[index], {
        id: nodeId,
        position: { x: 50 + index * 250, y: 500 },
      });
      expect(graph.nodes.find((node) => node.id === nodeId)).toEqual(expected);
    }
    expect([
      store.nodes.find((node) => node.id === added[0])?.id,
      store.briefNodes.find((node) => node.id === added[1])?.id,
      store.creatorNodes.find((node) => node.id === added[2])?.id,
      store.creatorNodes.find((node) => node.id === added[3])?.id,
      store.creatorNodes.find((node) => node.id === added[4])?.id,
      store.outputNodes.find((node) => node.id === added[5])?.id,
    ]).toEqual(added);
    expect(store.creatorNodes.map((node) => node.type)).toEqual(['art-direction', 'transform', 'review']);
    expect(store.selection).toEqual({ kind: 'output', id: added.at(-1) });

    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), null, 'Palette additions');
    expect(reopened.serialize()).toEqual(store.serialize());
    expect(reopened.creatorNodes.map((node) => node.type)).toEqual(['art-direction', 'transform', 'review']);
  });

  it('rejects invalid creator additions atomically before the graph domain mutates', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard('Atomic palette add');
    const before = store.graphSnapshot();

    expect(() => store.addCreatorNode('transform', { x: 100, y: 200 }, {
      capability: '',
      instructions: '',
      advanced: 'codex',
    })).toThrow(/invalid transform configuration/i);
    expect(store.graphSnapshot()).toBe(before);
    expect(store.rev).toBe(0);
  });

  it('updates meaningful creator configuration fields and generic input asset bindings', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard('Creator controls');
    const inputId = store.addCreatorNode('input');
    const artId = store.addCreatorNode('art-direction');
    const transformId = store.addCreatorNode('transform');
    const reviewId = store.addCreatorNode('review');
    const asset = { id: 'asset-1', name: 'Reference.png', relativePath: 'assets/Reference.png' } as ProjectAsset;

    store.assignAsset(inputId, asset);
    store.configureCreatorNode(inputId, { role: 'Hero product reference' });
    store.configureCreatorNode(artId, { prompt: 'Top-lit editorial layout' });
    store.configureCreatorNode(transformId, { capability: 'relight', instructions: 'Warm key light' });
    store.configureCreatorNode(reviewId, { mode: 'human', instructions: 'Prefer legibility' });

    expect(store.graphSnapshot().nodes.find((node) => node.id === inputId)?.config).toMatchObject({
      assetId: 'asset-1', relativePath: 'assets/Reference.png', role: 'Hero product reference',
    });
    expect(store.creatorNodes.find((node) => node.id === artId)?.config.prompt).toBe('Top-lit editorial layout');
    expect(store.creatorNodes.find((node) => node.id === transformId)?.config).toMatchObject({ capability: 'relight', instructions: 'Warm key light' });
    expect(store.creatorNodes.find((node) => node.id === reviewId)?.config).toMatchObject({ mode: 'human', instructions: 'Prefer legibility' });
  });

  it('connects the exact named typed ports requested by the board', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard('Exact ports');
    const inputId = store.addCreatorNode('input');
    const briefId = store.addCreatorNode('brief');
    const artId = store.addCreatorNode('art-direction');

    expect(store.connectPorts(inputId, 'asset', artId, 'assets')).toBe(true);
    expect(store.connectPorts(briefId, 'prompt', artId, 'brief')).toBe(true);
    expect(store.graphSnapshot().edges.slice(-2).map((edge) => ({ source: edge.source, target: edge.target }))).toEqual([
      { source: { nodeId: inputId, portId: 'asset' }, target: { nodeId: artId, portId: 'assets' } },
      { source: { nodeId: briefId, portId: 'prompt' }, target: { nodeId: artId, portId: 'brief' } },
    ]);
  });

  it.each(WORKFLOW_TEMPLATES)('installs and round-trips the $name template through the graph adapter', (template) => {
    const store = new WorkflowStore({
      idGenerator: ids(),
      workflowGraphIdGenerator: () => `workflow-${template.id}-test`,
    });
    store.newFromTemplate(template.id, `My ${template.name}`);

    expect(store.active).toBe(true);
    expect(store.name).toBe(`My ${template.name}`);
    expect(store.graphSnapshot().id).toBe(`workflow-${template.id}-test`);
    expect(store.savedPath).toBeNull();
    expect(store.rev).toBe(0);
    expect(store.savedRev).toBe(0);
    expect(store.dirty).toBe(false);
    expect(store.briefNodes).toHaveLength(1);
    expect(store.nodes.map((node) => node.name)).toEqual(template.slots.map((slot) => slot.name));
    expect(store.outputNodes.map((node) => [node.name, node.finalWidth, node.finalHeight])).toEqual(
      template.outputs.map((output) => [output.name, output.width, output.height]),
    );

    const graph = store.serialize();
    expect(graph.metadata).toEqual({ name: `My ${template.name}`, sourceVersion: null, migrations: [] });
    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), null, 'Fallback');
    expect(reopened.serialize()).toEqual(graph);
    expect(reopened.briefNodes).toEqual(store.briefNodes);
    expect(reopened.rev).toBe(0);
  });

  it('persists guided slot assignments and brief edits as graph configuration', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer');
    store.assignAsset('slot-product', {
      id: 'product-asset',
      kind: 'imported',
      name: 'Product.png',
      relativePath: 'assets/product.png',
      createdAt: 1,
      exists: true,
    });
    store.setBriefObjective('brief', 'Launch the winter range for design-conscious travellers.');

    expect(store.nodes.find((node) => node.id === 'slot-product')).toMatchObject({
      assetId: 'product-asset',
      relativePath: 'assets/product.png',
      required: true,
    });
    expect(store.briefNodes[0].objective).toBe('Launch the winter range for design-conscious travellers.');
    expect(store.rev).toBe(2);

    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), null, 'Campaign');
    expect(reopened.nodes.find((node) => node.id === 'slot-product')).toMatchObject({
      assetId: 'product-asset',
      relativePath: 'assets/product.png',
    });
    expect(reopened.briefNodes[0].objective).toBe('Launch the winter range for design-conscious travellers.');
  });

  it('reconnects Brief through the compatible named prompt port and restores readiness', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newFromTemplate('campaign-composer');
    store.assignAsset('slot-product', {
      id: 'product-asset', kind: 'imported', name: 'Product.png', relativePath: 'assets/product.png', createdAt: 1, exists: true,
    });
    store.disconnectConnection('edge-brief-composition');
    const options = {
      desktop: true,
      projectPath: '/tmp/project',
      assets: [{ id: 'product-asset', relativePath: 'assets/product.png', exists: true }],
      provider: 'fake',
      supportedProviders: ['fake'],
    };
    expect(workflowReadiness(store.graphSnapshot(), options).ready).toBe(false);
    expect(store.planExecution('output-square', { maxConcurrency: 2 }).blocked).not.toEqual([]);

    expect(store.connect('brief', 'composition')).toBe(true);
    expect(store.graphSnapshot().edges.find((edge) => edge.source.nodeId === 'brief')).toMatchObject({
      source: { portId: 'prompt' },
      target: { portId: 'brief' },
    });
    expect(workflowReadiness(store.graphSnapshot(), options).ready).toBe(true);
    expect(store.planExecution('output-square', { maxConcurrency: 2 }).blocked).toEqual([]);
  });

  it('routes asset node mutations and connections through one domain owner', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard('Adapter test');

    expect(store.graphRevision).toBe(0);
    expect(store.rev).toBe(0);

    store.addBlankAsset(12.4, 24.6, 100, 100);
    const assetId = store.nodes[0].id;
    expect(assetId).toBe('node-test-2');
    expect(store.nodes[0]).toMatchObject({ x: 12, y: 25, width: 160, height: 130, included: true });
    expect(store.isConnected(assetId, 'composition')).toBe(true);
    expect(store.rev).toBe(1);
    expect(store.graphRevision).toBe(2);

    store.moveNode(assetId, 80.6, 91.2);
    store.resizeNode(assetId, 200.2, 149.7);
    store.setNodeNote(assetId, 'Reference only');
    expect(store.nodes[0]).toMatchObject({
      x: 81,
      y: 91,
      width: 200,
      height: 150,
      note: 'Reference only',
    });
    expect(store.rev).toBe(4);
    expect(store.graphRevision).toBe(5);

    const connectionId = store.connections.find((connection) => connection.from === assetId)?.id;
    expect(connectionId).toBe('edge-test-3');
    store.disconnectConnection(connectionId!);
    expect(store.nodes[0].included).toBe(false);
    expect(store.rev).toBe(5);

    store.connect(assetId, 'composition');
    expect(store.nodes[0].included).toBe(true);
    expect(store.rev).toBe(6);

    store.removeNode(assetId);
    expect(store.nodes).toEqual([]);
    expect(store.connections.every((connection) => connection.from !== assetId && connection.to !== assetId)).toBe(true);
    expect(store.rev).toBe(7);
  });

  it('rolls back every compound store add when injected edge generation collides', () => {
    const cases: Array<[string, (store: WorkflowStore) => void]> = [
      ['blank asset', (store) => store.addBlankAsset(20, 30, 200, 180)],
      ['project asset', (store) => store.addAsset({
        id: 'project-asset',
        kind: 'imported',
        name: 'Reference.png',
        relativePath: 'assets/reference.png',
        createdAt: 1,
        exists: true,
      })],
      ['output', (store) => { store.addOutputNode(); }],
    ];

    for (const [name, add] of cases) {
      const generatedIds = ['edge-existing', `transient-${name}`, 'edge-existing'];
      let index = 0;
      const store = new WorkflowStore({
        idGenerator: () => generatedIds[index++] ?? `generated-${index}`,
      });
      store.newBoard();

      expect(() => add(store), name).toThrowError(expect.objectContaining({ code: 'DUPLICATE_EDGE_ID' }));
      expect(store.nodes, name).toEqual([]);
      expect(store.outputNodes, name).toHaveLength(1);
      expect(store.rev, name).toBe(0);
      expect(store.graphRevision, name).toBe(0);

      store.setPrompt('Mutation after rollback');
      expect(store.nodes, name).toEqual([]);
      expect(store.outputNodes, name).toHaveLength(1);
      expect(store.prompt, name).toBe('Mutation after rollback');
    }
  });

  it('preserves output behavior without double-incrementing the store revision', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();

    store.moveOutput(700.4, 88.8);
    expect(store.outputNodes[0]).toMatchObject({ x: 700, y: 89 });
    expect(store.outputX).toBe(700);
    expect(store.outputY).toBe(89);
    expect(store.rev).toBe(1);

    const added = store.addOutputNode(1000.2, 90.7, 100, 100);
    expect(added).toMatchObject({
      id: 'node-test-2',
      x: 1000,
      y: 91,
      width: 190,
      height: 190,
    });
    expect(store.isConnected('composition', added.id)).toBe(true);
    expect(store.selection).toEqual({ kind: 'output', id: added.id });
    expect(store.rev).toBe(2);

    store.removeOutputNode(added.id);
    expect(store.outputNodes.map((node) => node.id)).toEqual(['output']);
    expect(store.rev).toBe(3);
  });

  it('routes composition configuration while keeping selection and tools reactive-only', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();
    const selection = store.selection;
    const tool = store.tool;

    store.setPrompt('Launch campaign');
    store.setStoryboardSize(1600, 900);
    store.setStoryboardAnnotations(['  Focus product  ', '', 'Warm light']);

    expect(store.prompt).toBe('Launch campaign');
    expect(store.storyboardWidth).toBe(1600);
    expect(store.storyboardHeight).toBe(900);
    expect(store.storyboardAnnotations).toEqual(['Focus product', 'Warm light']);
    expect(store.selection).toEqual(selection);
    expect(store.tool).toBe(tool);
    expect(store.rev).toBe(3);
    expect(store.graphRevision).toBe(3);
  });

  it('preserves legacy primary and default secondary output geometry after unrelated mutations', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();
    const initial = { outputWidth: store.outputWidth, outputHeight: store.outputHeight, outputX: store.outputX, outputY: store.outputY };
    store.setPrompt('Geometry must not change');

    expect(store.outputWidth).toBe(initial.outputWidth);
    expect(store.outputHeight).toBe(initial.outputHeight);
    expect(store.outputX).toBe(initial.outputX);
    expect(store.outputY).toBe(initial.outputY);

    const secondary = store.addOutputNode();
    expect(secondary).toMatchObject({ width: 210, height: 190 });
  });

  it('normalizes near-origin UI mutations while preserving exact v2 viewport values on reopen', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();
    store.addBlankAsset(-0.1, -0.1, 200, 180);
    const assetId = store.nodes[0].id;
    store.moveNode(assetId, 10, 10);
    store.moveNode(assetId, -0.1, -0.1);
    store.movePrompt(-0.1, -0.1);
    store.moveOutput(-0.1, -0.1);

    expect(store.nodes[0].x).toBe(0);
    expect(store.nodes[0].y).toBe(0);
    expect(store.promptX).toBe(0);
    expect(store.promptY).toBe(0);
    expect(store.outputX).toBe(0);
    expect(store.outputY).toBe(0);
    expect(Object.is(store.nodes[0].x, -0)).toBe(false);

    const persisted = structuredClone(store.serialize());
    persisted.viewport.panX = -0.1;
    persisted.viewport.panY = -0.1;
    persisted.nodes.find((node) => node.id === assetId)!.position.x = -0.1;
    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(
      new TextEncoder().encode(JSON.stringify(persisted)),
      'workflows/near-origin.cxflow.json',
      'Near origin',
    );

    expect(reopened.panX).toBe(-0.1);
    expect(reopened.panY).toBe(-0.1);
    expect(reopened.nodes[0].x).toBe(-0.1);
  });

  it('reopens a WorkflowGraph v2 save through the same domain adapter', () => {
    const source = new WorkflowStore({ idGenerator: ids() });
    source.newBoard('Legacy round trip');
    source.addBlankAsset(20, 30, 200, 180);
    const bytes = source.toBytes();

    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(bytes, 'workflows/legacy.cxflow.json', 'Fallback');
    const assetId = reopened.nodes[0].id;

    expect(reopened.serialize()).toEqual(source.serialize());
    expect(reopened.graphRevision).toBe(0);
    reopened.moveNode(assetId, 45, 55);
    expect(reopened.nodes[0]).toMatchObject({ x: 45, y: 55 });
    expect(reopened.rev).toBe(1);
    expect(reopened.graphRevision).toBe(1);
  });

  it.each([
    ['assets and storyboard', assetsStoryboard],
    ['annotations', annotations],
    ['multiple outputs', multipleOutputs],
  ])('migrates the %s v1 fixture into reactive behavior and explicitly saves/reopens v2', (_name, fixture) => {
    const store = new WorkflowStore({ idGenerator: ids() });
    const originalBytes = new TextEncoder().encode(JSON.stringify(fixture));
    store.openFromBytes(originalBytes, `workflows/${fixture.name}.cxflow.json`, fixture.name);

    expect(store.requiresExplicitSave).toBe(true);
    expect(store.savedPath).toBeNull();
    expect(store.migrationSourcePath).toContain('.cxflow.json');
    expect(store.serialize().version).toBe(WORKFLOW_GRAPH_VERSION);
    expect(JSON.parse(new TextDecoder().decode(originalBytes))).toEqual(fixture);

    const v2 = store.serialize();
    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), 'workflows/converted.cxflow.json', 'Converted');
    expect(reopened.serialize()).toEqual(v2);
    expect(reopened.requiresExplicitSave).toBe(false);
    expect(reopened.rev).toBe(0);
  });

  it('preserves storyboard, annotations, multiple outputs, generated placement, references, and graph metadata', () => {
    const assets = new WorkflowStore({ idGenerator: ids() });
    assets.openFromBytes(
      new TextEncoder().encode(JSON.stringify(assetsStoryboard)),
      'workflows/assets.cxflow.json',
      'Assets',
    );
    expect(assets.nodes).toHaveLength(2);
    expect(assets.nodes[0]).toMatchObject({
      assetId: 'project-product',
      relativePath: 'assets/product.png',
      included: true,
      note: 'Hero product; preserve label and proportions',
    });
    expect(assets.storyboardDataUrl).toBe(assetsStoryboard.storyboardDataUrl);

    const store = new WorkflowStore({ idGenerator: ids() });
    store.openFromBytes(
      new TextEncoder().encode(JSON.stringify(multipleOutputs)),
      'workflows/outputs.cxflow.json',
      'Outputs',
    );
    expect(store.outputNodes).toHaveLength(2);
    expect(store.outputNodes[1]).toMatchObject({ finalWidth: 768, finalHeight: 1376, outputAssetId: 'story-asset' });
    store.setOutput({
      id: 'replacement-story',
      kind: 'generated',
      name: 'replacement.png',
      relativePath: 'generated/replacement-story.png',
      createdAt: 2,
      exists: true,
    }, 'output-story');
    const placementReopen = new WorkflowStore({ idGenerator: ids() });
    placementReopen.openFromBytes(store.toBytes(), 'workflows/placement.cxflow.json', 'Placement');
    expect(placementReopen.outputNode('output-story')).toMatchObject({
      outputAssetId: 'replacement-story',
      outputRelativePath: 'generated/replacement-story.png',
    });
    placementReopen.setOutput(null, 'output-story');
    expect(placementReopen.outputNode('output-story')).toMatchObject({
      outputAssetId: null,
      outputRelativePath: null,
    });
    const clearedReopen = new WorkflowStore({ idGenerator: ids() });
    clearedReopen.openFromBytes(placementReopen.toBytes(), 'workflows/cleared.cxflow.json', 'Cleared');
    expect(clearedReopen.outputNode('output-story')).toMatchObject({
      outputAssetId: null,
      outputRelativePath: null,
    });

    const storyboard = new WorkflowStore({ idGenerator: ids() });
    storyboard.openFromBytes(
      new TextEncoder().encode(JSON.stringify(annotations)),
      'workflows/annotations.cxflow.json',
      'Annotations',
    );
    expect(storyboard.storyboardAnnotationItems).toEqual(annotations.storyboardAnnotationItems);
    expect(storyboard.storyboardAnnotationsVisible).toBe(false);
    const before = storyboard.serialize();
    storyboard.setPrompt('Updated prompt');
    const after = storyboard.serialize();
    expect(after.id).toBe(before.id);
    expect(after.metadata.sourceVersion).toBe(1);
    expect(after.metadata.migrations).toEqual([{ from: 1, to: 2 }]);
    expect(after.assetReferences).toEqual(before.assetReferences);
  });

  it('keeps presentation state outside graph revisions while persisting viewport dirty state', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();
    const graphRevision = store.graphRevision;
    store.select({ kind: 'output', id: 'output' });
    store.setTool('zoom');
    expect(store.rev).toBe(0);
    expect(store.graphRevision).toBe(graphRevision);
    store.zoomBy(1, 300, 200);
    expect(store.rev).toBe(0);

    store.panBy(20, 10);
    store.setZoom(1.25);
    expect(store.rev).toBe(2);
    expect(store.graphRevision).toBe(graphRevision);
    expect(store.serialize().viewport).toEqual({ panX: 20, panY: 10, zoom: 1.25 });
  });

  it('round-trips unusual valid v2 metadata names exactly until the user renames', () => {
    const source = new WorkflowStore({ idGenerator: ids() });
    source.newBoard();
    const graph = structuredClone(source.serialize());
    graph.metadata.name = '  Campaign.CXFLOW.JSON  ';
    const store = new WorkflowStore({ idGenerator: ids() });
    store.openFromBytes(new TextEncoder().encode(JSON.stringify(graph)), 'workflows/unusual.cxflow.json', 'Fallback');

    expect(store.name).toBe('  Campaign.CXFLOW.JSON  ');
    expect(store.serialize().metadata.name).toBe('  Campaign.CXFLOW.JSON  ');
    const reopened = new WorkflowStore({ idGenerator: ids() });
    reopened.openFromBytes(store.toBytes(), 'workflows/unusual.cxflow.json', 'Fallback');
    expect(reopened.serialize()).toEqual(store.serialize());

    store.setName('  Renamed.cxflow.json  ');
    expect(store.serialize().metadata.name).toBe('Renamed');
  });

  it('preserves fractional v2 pan for identity and saturated zoom no-ops', () => {
    const source = new WorkflowStore({ idGenerator: ids() });
    source.newBoard();
    const graph = structuredClone(source.serialize());
    graph.viewport = { panX: 0.5, panY: -0.5, zoom: 1 };
    const store = new WorkflowStore({ idGenerator: ids() });
    store.openFromBytes(new TextEncoder().encode(JSON.stringify(graph)), 'workflows/fractional.cxflow.json', 'Fractional');

    store.zoomBy(1, 200, 100);
    expect(store.rev).toBe(0);
    expect(store.serialize().viewport).toEqual({ panX: 0.5, panY: -0.5, zoom: 1 });

    const saturatedGraph = structuredClone(graph);
    saturatedGraph.viewport = { panX: 0.5, panY: -0.5, zoom: 4 };
    const saturated = new WorkflowStore({ idGenerator: ids() });
    saturated.openFromBytes(new TextEncoder().encode(JSON.stringify(saturatedGraph)), 'workflows/saturated.cxflow.json', 'Saturated');
    saturated.zoomAt(200, 100, 'in');
    expect(saturated.rev).toBe(0);
    expect(saturated.serialize().viewport).toEqual(saturatedGraph.viewport);
  });

  it('surfaces strict connection explanations without dirtying or partially mutating the graph', () => {
    const store = new WorkflowStore({ idGenerator: ids() });
    store.newBoard();
    const before = store.graphSnapshot();

    expect(store.connect('composition', 'composition')).toBe(false);
    expect(store.connectionError).toMatch(/cannot connect to itself/i);
    expect(store.graphSnapshot()).toBe(before);
    expect(store.rev).toBe(0);
  });

  it('delegates output execution planning and preserves unsupported dormant nodes across UI mutations', () => {
    const source = new WorkflowStore({ idGenerator: ids() });
    source.newBoard();
    const graph = structuredClone(source.serialize()) as WorkflowGraphV2;
    graph.nodes.push({
      id: 'future',
      type: 'unsupported',
      title: 'Future node',
      position: { x: 100, y: 500 },
      size: { width: 200, height: 160 },
      color: '#333333',
      ports: { inputs: [], outputs: [] },
      config: { unsupportedType: 'future', rawConfig: { strength: 1 }, rawPorts: {}, rawNode: {} },
      runRecordIds: [],
    });
    graph.nodes.find((node) => node.id === 'composition')!.runRecordIds = ['run-composition'];
    graph.runRecords = [{ id: 'run-composition', nodeId: 'composition', status: 'succeeded' }];
    const store = new WorkflowStore({ idGenerator: ids() });
    store.openFromBytes(new TextEncoder().encode(JSON.stringify(graph)), 'workflows/future.cxflow.json', 'Future');
    expect(store.unsupportedNodes).toEqual([
      expect.objectContaining({
        id: 'future',
        unsupportedType: 'future',
        runnable: false,
        config: graph.nodes.at(-1)?.config,
      }),
    ]);
    store.setPrompt('Still preserved');
    store.addCreatorNode('review', { x: 360, y: 500 });

    expect(store.serialize().nodes.find((node) => node.id === 'future')).toEqual(graph.nodes.at(-1));
    expect(store.serialize().runRecords).toEqual(graph.runRecords);
    expect(store.planExecution('output', { maxConcurrency: 2 })).toMatchObject({
      targetNodeId: 'output',
      executionOrder: ['composition', 'output'],
    });
  });

  it('rotates return authority for repeated edits and rejects stale duplicate or workflow-drift commits', () => {
    const store = editorRoundTripStore();
    const request = {
      nodeId: 'transform-generate-square', rootRunId: 'store-run', assetReferenceId: 'store-source-ref',
    };
    const descriptor = store.prepareWorkflowEditorRoundTrip(request, [], project.identity);
    expect(descriptor).toMatchObject({
      documentRelativePath: null,
      documentContentHash: null,
      editorRevisionId: null,
      output: { assetReferenceId: 'store-source-ref' },
    });
    expect(() => store.prepareWorkflowEditorRoundTrip({
      ...request,
      assetReferenceId: 'missing-source-ref',
    }, [], project.identity)).toThrow(/accepted workflow result|output is unavailable/i);
    const activeSession = {};
    const duplicateSession = {};
    bindWorkflowRoundTripAuthority(activeSession, descriptor.authority);
    bindWorkflowRoundTripAuthority(duplicateSession, descriptor.authority);

    store.commitWorkflowEditorReturn(activeSession, {
      revisionId: 'store-edit-1', bindingId: 'store-binding-1', outputAssetReferenceId: 'store-edit-ref-1',
      artifacts: editorArtifacts('store-edit-1', '5'), width: 64, height: 64, createdAt: 5,
    });
    expect(() => store.commitWorkflowEditorReturn(duplicateSession, {
      revisionId: 'store-edit-duplicate', bindingId: 'store-binding-duplicate',
      outputAssetReferenceId: 'store-edit-ref-duplicate', artifacts: editorArtifacts('store-edit-duplicate', '6'),
      width: 64, height: 64, createdAt: 6,
    })).toThrow(/workflow or project changed|not linked/i);

    store.commitWorkflowEditorReturn(activeSession, {
      revisionId: 'store-edit-2', bindingId: 'store-binding-2', outputAssetReferenceId: 'store-edit-ref-2',
      artifacts: editorArtifacts('store-edit-2', '7'), width: 64, height: 64, createdAt: 7,
    });
    expect(store.serialize().editorRevisions?.map((revision) => revision.id))
      .toEqual(['store-edit-1', 'store-edit-2']);
    expect(store.serialize().workflowRoundTrips?.[1].supersedesRoundTripId).toBe('store-binding-1');

    const driftDescriptor = store.prepareWorkflowEditorRoundTrip(request, [], project.identity);
    expect(driftDescriptor).toMatchObject({
      documentRelativePath: 'documents/workflow-edits/store-edit-2.ora',
      documentContentHash: `sha256:${'7'.repeat(64)}`,
      editorRevisionId: 'store-edit-2',
      output: { assetReferenceId: 'store-edit-ref-2' },
    });
    const driftSession = {};
    bindWorkflowRoundTripAuthority(driftSession, driftDescriptor.authority);
    store.setBriefObjective('brief', 'Changed after editor open');
    expect(() => store.commitWorkflowEditorReturn(driftSession, {
      revisionId: 'store-edit-drift', bindingId: 'store-binding-drift', outputAssetReferenceId: 'store-edit-ref-drift',
      artifacts: editorArtifacts('store-edit-drift', '8'), width: 64, height: 64, createdAt: 8,
    })).toThrow(/workflow or project changed/i);
    expect(store.serialize().editorRevisions).toHaveLength(2);
  });
});
