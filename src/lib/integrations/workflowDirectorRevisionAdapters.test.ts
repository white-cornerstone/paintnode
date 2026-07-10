import { describe, expect, it, vi } from 'vitest';
import { defaultAiRunOptions } from '../state/settings';
import { WorkflowStore } from '../state/workflow.svelte';
import { createConfiguredWorkflowRevisionRequester } from './workflowDirectorRevisionAdapters';

describe('configured workflow Director revision adapter', () => {
  it.each(['codex', 'claude', 'antigravity'] as const)('invokes only configured %s with constrained graph state', async (provider) => {
    const store = new WorkflowStore();
    store.newFromTemplate('campaign-composer');
    const graph = structuredClone(store.graphSnapshot());
    graph.runRecords = [{ secret: '/Users/alice/token' } as never];
    graph.assetReferences = [{ id: 'secret', role: 'source', assetId: 'secret', relativePath: 'private/secret.png' }];
    const run = vi.fn().mockResolvedValue({ version: 1 });
    const options = { ...defaultAiRunOptions(), directorProvider: provider };
    const requester = createConfiguredWorkflowRevisionRequester(options, run, () => 'revision-run');

    await requester.request({
      instruction: 'Refine the current brief.', graph,
      sourceGraphRevision: { graphId: graph.id, revision: store.graphRevision },
      session: store.captureDirectorSession(),
    });

    expect(run).toHaveBeenCalledOnce();
    const call = run.mock.calls[0][0];
    expect(call.provider).toBe(provider);
    expect(JSON.stringify(call.context)).not.toContain('runRecords');
    expect(JSON.stringify(call.context)).not.toContain('/Users/alice');
    expect(call.context.graph).toEqual(expect.objectContaining({ id: graph.id, nodes: expect.any(Array), edges: expect.any(Array) }));
  });

  it('cancels the exact configured run and sanitizes provider errors', async () => {
    let reject!: (error: Error) => void;
    const run = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    const cancel = vi.fn().mockResolvedValue(undefined);
    const requester = createConfiguredWorkflowRevisionRequester(
      defaultAiRunOptions(), run, () => 'revision-cancel', cancel,
    );
    const store = new WorkflowStore();
    store.newFromTemplate('campaign-composer');
    const graph = store.graphSnapshot();
    const controller = new AbortController();
    const pending = requester.request({ instruction: 'x', graph, sourceGraphRevision: { graphId: graph.id, revision: 0 }, session: store.captureDirectorSession() }, controller.signal);
    controller.abort();
    reject(new Error('Bearer secret at /Users/alice/private'));

    await expect(pending).rejects.not.toThrow(/alice|Bearer/i);
    expect(cancel).toHaveBeenCalledWith('revision-cancel');
  });
});
