import { describe, expect, it, vi } from 'vitest';
import { defaultAiRunOptions } from '../state/settings';
import { WorkflowStore } from '../state/workflow.svelte';
import {
  constrainedWorkflowRevisionGraph,
  createConfiguredWorkflowRevisionRequester,
} from './workflowDirectorRevisionAdapters';

describe('configured workflow Director revision adapter', () => {
  it('omits unsupported future nodes and their dormant edges from provider context', () => {
    const store = new WorkflowStore();
    store.newFromTemplate('campaign-composer');
    const graph = structuredClone(store.graphSnapshot());
    const future = graph.nodes.find((node) => node.id === 'output-landscape')!;
    future.type = 'unsupported';
    future.config = { unsupportedType: 'future-output', rawConfig: {}, rawPorts: future.ports };

    const constrained = constrainedWorkflowRevisionGraph(graph);

    expect(constrained.nodes.some((node) => node.id === future.id)).toBe(false);
    expect(constrained.edges.some((edge) => (
      edge.source.nodeId === future.id || edge.target.nodeId === future.id
    ))).toBe(false);
  });

  it.each(['codex', 'claude', 'antigravity', 'grok'] as const)('invokes only configured %s with constrained graph state', async (provider) => {
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
    expect(call.grokBin).toBeNull();
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

  it.each([
    ['cancelled: Bearer secret at /Users/alice/private', 'The AI Director revision was cancelled.'],
    ['timed out with token secret at /Users/alice/private', 'The AI Director revision timed out and was stopped.'],
    ['stopped after reading Bearer secret at /Users/alice/private', 'The AI Director revision was stopped.'],
  ])('maps provider state errors to fixed safe copy: %s', async (providerError, expected) => {
    const store = new WorkflowStore();
    store.newFromTemplate('campaign-composer');
    const graph = store.graphSnapshot();
    const requester = createConfiguredWorkflowRevisionRequester(
      defaultAiRunOptions(),
      vi.fn().mockRejectedValue(new Error(providerError)),
      () => 'revision-safe-error',
    );

    await expect(requester.request({
      instruction: 'Refine safely.',
      graph,
      sourceGraphRevision: { graphId: graph.id, revision: store.graphRevision },
      session: store.captureDirectorSession(),
    })).rejects.toThrow(expected);
    await expect(requester.request({
      instruction: 'Refine safely.',
      graph,
      sourceGraphRevision: { graphId: graph.id, revision: store.graphRevision },
      session: store.captureDirectorSession(),
    })).rejects.not.toThrow(/alice|Bearer|secret/i);
  });
});
