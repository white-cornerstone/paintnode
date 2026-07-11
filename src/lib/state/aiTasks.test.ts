import { describe, expect, it, vi } from 'vitest';
import { AiTaskStore } from './aiTasks.svelte';

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
