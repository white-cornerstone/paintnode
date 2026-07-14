import { describe, expect, it, vi } from 'vitest';
import { AiTaskStore } from './aiTasks.svelte';
import { ui } from './ui.svelte';

describe('AI task cancellation', () => {
  it('exposes a running workflow cancellation seam and releases it at terminal state', async () => {
    const store = new AiTaskStore();
    const cancel = vi.fn(async () => undefined);
    const task = store.create({
      kind: 'workflow',
      title: 'Workflow: Square',
      subtitle: 'codex',
      progress: 'Running',
      runId: 'run-1',
      detail: { kind: 'workflow', providerLabel: 'codex', outputName: 'Square' },
    });
    store.setCancel(task.id, cancel);

    expect(store.canCancel(task)).toBe(true);
    await store.cancel(task.id);
    expect(cancel).toHaveBeenCalledOnce();
    expect(task.progress).toBe('Cancelling…');

    store.markCancelled(task.id);
    expect(store.canCancel(task)).toBe(false);
    expect(task.cancel).toBeNull();
    expect(task.status).toBe('cancelled');
    expect(task.progress).toBe('Cancelled');
    expect(task.completedAt).not.toBeNull();
  });
});

describe('workflow task details', () => {
  it('keeps progress current and opens the workflow task dialog', () => {
    const store = new AiTaskStore();
    const task = store.create({
      kind: 'workflow',
      title: 'Extract assets: Extract Assets',
      subtitle: 'codex → grok',
      progress: 'Preparing source and support images…',
      detail: { kind: 'workflow', providerLabel: 'grok', outputName: 'Extract Assets' },
    });

    store.setProgress(task.id, 'Extracting 6 of 8: pine foliage…');
    expect(task.progress).toBe('Extracting 6 of 8: pine foliage…');

    try {
      store.open(task.id);
      expect(ui.aiTaskDialog).toEqual({ kind: 'workflow', id: task.id });
      expect(ui.dialog).toBe('workflowTask');
    } finally {
      ui.close();
    }
  });

  it('keeps a completed workflow warning separate from errors', () => {
    const store = new AiTaskStore();
    const task = store.create({
      kind: 'workflow',
      title: 'Workflow: Square',
      subtitle: 'codex',
      progress: 'Running',
      detail: { kind: 'workflow', providerLabel: 'codex', outputName: 'Square' },
    });

    store.complete(task.id, 'Workflow generation completed with a warning', 'Settings changed during generation.');

    expect(task).toMatchObject({
      status: 'completed',
      progress: 'Workflow generation completed with a warning',
      warning: 'Settings changed during generation.',
      error: '',
    });
    expect(store.canRetry(task)).toBe(false);
  });

  it('exposes only active tasks scoped to the requested workflow node', () => {
    const store = new AiTaskStore();
    const task = store.create({
      kind: 'workflow',
      title: 'Generate concept branches',
      subtitle: 'codex',
      progress: 'Generating candidates…',
      detail: {
        kind: 'workflow',
        providerLabel: 'codex',
        outputName: 'Candidates',
        workflowId: 'workflow-1',
        nodeIds: ['transform-1', 'output-1'],
      },
    });

    expect(store.runningForWorkflowNode('workflow-1', 'transform-1')).toEqual([task]);
    expect(store.runningForWorkflow('workflow-1')).toEqual([task]);
    expect(store.runningForWorkflowNode('workflow-1', 'other')).toEqual([]);
    expect(store.runningForWorkflowNode('workflow-2', 'transform-1')).toEqual([]);

    store.complete(task.id);
    expect(store.runningForWorkflow('workflow-1')).toEqual([]);
    expect(store.runningForWorkflowNode('workflow-1', 'transform-1')).toEqual([]);
  });
});
