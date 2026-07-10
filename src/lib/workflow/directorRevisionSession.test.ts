import { describe, expect, it, vi } from 'vitest';
import { WorkflowStore } from '../state/workflow.svelte';
import {
  createProviderFreeWorkflowRevisionRequester,
  providerFreeWorkflowRevisionPatch,
} from '../integrations/providerFreeWorkflowRevision';
import {
  acceptWorkflowDirectorRevisionPreview,
  createWorkflowDirectorRevisionViewModel,
  rejectWorkflowDirectorRevisionPreview,
  requestWorkflowDirectorRevisionPreview,
  workflowDirectorRevisionPreviewIsCurrent,
  type WorkflowDirectorRevisionRequest,
  type WorkflowDirectorRevisionRequester,
} from './directorRevisionSession';

function bytes(store: WorkflowStore): string {
  return JSON.stringify(store.serialize());
}

function campaign(): WorkflowStore {
  const store = new WorkflowStore();
  store.newFromTemplate('campaign-composer', 'Revision campaign');
  return store;
}

function deferredRequester(): {
  requester: WorkflowDirectorRevisionRequester;
  request: () => WorkflowDirectorRevisionRequest;
  resolve: (response: unknown) => void;
} {
  let captured!: WorkflowDirectorRevisionRequest;
  let resolve!: (response: unknown) => void;
  const promise = new Promise<unknown>((accept) => { resolve = accept; });
  return {
    requester: {
      label: 'Injected QA Fake',
      providerFree: true,
      request: vi.fn(async (request) => {
        captured = request;
        return promise;
      }),
    },
    request: () => captured,
    resolve,
  };
}

describe('Workflow Director revision session', () => {
  it('returns the same QA Fake patch for the same bounded revision request', async () => {
    const store = campaign();
    const graph = store.graphSnapshot();
    const session = store.captureDirectorSession();
    const request: WorkflowDirectorRevisionRequest = {
      instruction: 'Use a deterministic premium launch objective.',
      graph,
      sourceGraphRevision: { graphId: graph.id, revision: session.graphRevision },
      session,
    };
    const requester = createProviderFreeWorkflowRevisionRequester();

    expect(await requester.request(request)).toEqual(await requester.request(request));
    expect(bytes(store)).toBe(JSON.stringify(graph));
  });

  it('requests a deterministic provider-free patch and previews every change without graph mutation', async () => {
    const store = campaign();
    const before = bytes(store);

    const preview = await requestWorkflowDirectorRevisionPreview(
      createProviderFreeWorkflowRevisionRequester(),
      store,
      'Focus the campaign on a premium evening launch.',
    );
    const view = createWorkflowDirectorRevisionViewModel(preview.result);

    expect(bytes(store)).toBe(before);
    expect(store.pendingDirectorPatchProposal).toBe(preview.result.proposal);
    expect(view).toMatchObject({
      canAccept: true,
      summary: expect.stringMatching(/QA Fake/i),
      operations: [expect.objectContaining({ index: 1, kind: 'configure-node' })],
      nodeChanges: [expect.objectContaining({ kind: 'configured', nodeId: 'brief' })],
      validationIssues: [],
    });
    expect(view.operations[0].detail).toContain('premium evening launch');
    expect(view.downstreamStaleness.length).toBeGreaterThan(0);
  });

  it('reports preview currency across instruction, store, and workflow session changes', async () => {
    const store = campaign();
    const preview = await requestWorkflowDirectorRevisionPreview(
      createProviderFreeWorkflowRevisionRequester(),
      store,
      'Keep this exact live instruction.',
    );

    expect(workflowDirectorRevisionPreviewIsCurrent(preview, store, preview.instruction)).toBe(true);
    expect(workflowDirectorRevisionPreviewIsCurrent(preview, store, 'Changed instruction.')).toBe(false);
    store.setBriefObjective('brief', 'Newer store state.');
    expect(workflowDirectorRevisionPreviewIsCurrent(preview, store, preview.instruction)).toBe(false);
    store.newFromTemplate('campaign-composer', 'Replacement session');
    expect(workflowDirectorRevisionPreviewIsCurrent(preview, store, preview.instruction)).toBe(false);
  });

  it('rejects a pending preview with zero graph, revision, dirty, or history mutation', async () => {
    const store = campaign();
    const before = { bytes: bytes(store), rev: store.rev, dirty: store.dirty };
    const preview = await requestWorkflowDirectorRevisionPreview(
      createProviderFreeWorkflowRevisionRequester(),
      store,
      'Use a more editorial launch direction.',
    );

    expect(rejectWorkflowDirectorRevisionPreview(preview, store)).toBe(true);

    expect({ bytes: bytes(store), rev: store.rev, dirty: store.dirty }).toEqual(before);
    expect(store.pendingDirectorPatchProposal).toBeNull();
    expect(store.canUndoDirectorPatch).toBe(false);
    expect(store.canRedoDirectorPatch).toBe(false);
  });

  it('accepts exactly one transaction and exposes truthful undo and redo status', async () => {
    const store = campaign();
    const before = bytes(store);
    const beforeRevision = store.rev;
    const preview = await requestWorkflowDirectorRevisionPreview(
      createProviderFreeWorkflowRevisionRequester(),
      store,
      'Make the brief feel cinematic and premium.',
    );

    acceptWorkflowDirectorRevisionPreview(preview, store);
    const accepted = bytes(store);

    expect(accepted).not.toBe(before);
    expect(store.rev).toBe(beforeRevision + 1);
    expect(store.canUndoDirectorPatch).toBe(true);
    expect(store.canRedoDirectorPatch).toBe(false);
    expect(store.undoDirectorPatch()).toBe(true);
    expect(bytes(store)).toBe(before);
    expect(store.canUndoDirectorPatch).toBe(false);
    expect(store.canRedoDirectorPatch).toBe(true);
    expect(store.redoDirectorPatch()).toBe(true);
    expect(bytes(store)).toBe(accepted);
    expect(store.canUndoDirectorPatch).toBe(true);
    expect(store.canRedoDirectorPatch).toBe(false);
  });

  it('rejects acceptance when the live revision instruction changed after preview', async () => {
    const store = campaign();
    const before = bytes(store);
    const preview = await requestWorkflowDirectorRevisionPreview(
      createProviderFreeWorkflowRevisionRequester(),
      store,
      'Original revision instruction.',
    );

    expect(() => acceptWorkflowDirectorRevisionPreview(
      preview,
      store,
      'A newer revision instruction.',
    )).toThrow(/instruction changed/i);
    expect(bytes(store)).toBe(before);
    expect(store.pendingDirectorPatchProposal).toBeNull();
    expect(store.canUndoDirectorPatch).toBe(false);
  });

  it.each(['store mutation', 'workflow session'] as const)(
    'rejects acceptance when the preview has a stale %s',
    async (change) => {
      const store = campaign();
      const preview = await requestWorkflowDirectorRevisionPreview(
        createProviderFreeWorkflowRevisionRequester(),
        store,
        'Preview before a newer workflow state.',
      );
      if (change === 'store mutation') store.setBriefObjective('brief', 'Newer manual state.');
      else store.newFromTemplate('asset-composition', 'New workflow session');
      const newer = bytes(store);

      expect(() => acceptWorkflowDirectorRevisionPreview(preview, store)).toThrow(/stale|changed/i);
      expect(bytes(store)).toBe(newer);
      expect(store.pendingDirectorPatchProposal).toBeNull();
    },
  );

  it('does not create a pending preview when an injected in-flight request is cancelled', async () => {
    const store = campaign();
    const before = bytes(store);
    const injected = deferredRequester();
    const controller = new AbortController();
    const pending = requestWorkflowDirectorRevisionPreview(
      injected.requester,
      store,
      'This response will arrive after cancellation.',
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'WorkflowDirectorRevisionCancelledError' });
    injected.resolve(providerFreeWorkflowRevisionPatch(injected.request()));
    await Promise.resolve();
    expect(bytes(store)).toBe(before);
    expect(store.pendingDirectorPatchProposal).toBeNull();
  });

  it.each(['store mutation', 'workflow session'] as const)(
    'rejects an injected response after a stale %s without replacing newer state',
    async (change) => {
      const store = campaign();
      const injected = deferredRequester();
      const pending = requestWorkflowDirectorRevisionPreview(
        injected.requester,
        store,
        'This response will become stale.',
      );
      const request = injected.request();
      if (change === 'store mutation') store.setBriefObjective('brief', 'A newer manual objective.');
      else store.newFromTemplate('asset-composition', 'Replacement workflow');
      const newer = bytes(store);
      injected.resolve(providerFreeWorkflowRevisionPatch(request));

      await expect(pending).rejects.toThrow(/workflow changed/i);
      expect(bytes(store)).toBe(newer);
      expect(store.pendingDirectorPatchProposal).toBeNull();
    },
  );

  it('builds operation, connection, requirement, downstream, and validation issue view models', async () => {
    const store = campaign();
    const graph = store.graphSnapshot();
    const edge = graph.edges.find((item) => item.target.nodeId === 'output-square' && item.target.portId === 'source')!;
    const preview = await requestWorkflowDirectorRevisionPreview({
      label: 'Injected QA Fake',
      providerFree: true,
      request: async (request) => ({
        version: 1,
        sourceGraphRevision: request.sourceGraphRevision,
        summary: 'Disconnect Square Output for revision preview QA.',
        operations: [{ op: 'remove-edge', edgeId: edge.id }],
      }),
    }, store, 'Disconnect the square output.');
    const view = createWorkflowDirectorRevisionViewModel(preview.result);

    expect(view.operations).toEqual([expect.objectContaining({ kind: 'remove-edge' })]);
    expect(view.connectionChanges).toEqual([expect.objectContaining({ kind: 'removed', edgeId: edge.id })]);
    expect(view.requirementChanges).toEqual([
      expect.objectContaining({ nodeId: 'output-square', before: 'ready', after: 'missing' }),
    ]);
    expect(view.downstreamStaleness).toEqual([
      expect.objectContaining({ nodeId: 'output-square' }),
    ]);

    const invalid = await requestWorkflowDirectorRevisionPreview({
      label: 'Injected QA Fake',
      providerFree: true,
      request: async () => ({ version: 1 }),
    }, store, 'Return an invalid patch.');
    expect(createWorkflowDirectorRevisionViewModel(invalid.result)).toMatchObject({
      canAccept: false,
      validationIssues: expect.arrayContaining([expect.objectContaining({ path: expect.any(String) })]),
    });
  });
});
