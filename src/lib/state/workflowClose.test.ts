import { describe, expect, it, vi } from 'vitest';
import type { SaveChangesChoice } from './ui.svelte';
import { requestWorkflowClose } from './workflowClose';

function closeHarness(options: {
  dirty?: boolean;
  saved?: boolean;
  choice?: SaveChangesChoice;
  saveSucceeds?: boolean;
  closeSucceeds?: boolean;
} = {}) {
  let dirty = options.dirty ?? false;
  let saved = options.saved ?? true;
  const askSaveChanges = vi.fn(async () => options.choice ?? 'discard');
  const saveWorkflow = vi.fn(async () => {
    if (options.saveSucceeds === false) return;
    dirty = false;
    saved = true;
  });
  const closeWorkflow = vi.fn(() => options.closeSucceeds ?? true);

  return {
    askSaveChanges,
    saveWorkflow,
    closeWorkflow,
    request: () => requestWorkflowClose({
      name: () => 'Asset Composition',
      needsSave: () => dirty || !saved,
      askSaveChanges,
      saveWorkflow,
      closeWorkflow,
    }),
  };
}

describe('workflow close confirmation', () => {
  it('prompts for a newly created workflow even before the user edits it', async () => {
    const harness = closeHarness({ saved: false, choice: 'discard' });

    await expect(harness.request()).resolves.toBe('closed');
    expect(harness.askSaveChanges).toHaveBeenCalledWith({
      kind: 'workflow',
      name: 'Asset Composition',
      index: 1,
      total: 1,
    });
    expect(harness.closeWorkflow).toHaveBeenCalledOnce();
  });

  it('saves a changed workflow before closing it', async () => {
    const harness = closeHarness({ dirty: true, choice: 'save' });

    await expect(harness.request()).resolves.toBe('closed');
    expect(harness.saveWorkflow).toHaveBeenCalledOnce();
    expect(harness.closeWorkflow).toHaveBeenCalledOnce();
  });

  it('keeps the workflow open when save is cancelled or cannot complete', async () => {
    const cancelled = closeHarness({ dirty: true, choice: 'cancel' });
    await expect(cancelled.request()).resolves.toBe('cancelled');
    expect(cancelled.closeWorkflow).not.toHaveBeenCalled();

    const failed = closeHarness({ dirty: true, choice: 'save', saveSucceeds: false });
    await expect(failed.request()).resolves.toBe('save-incomplete');
    expect(failed.closeWorkflow).not.toHaveBeenCalled();
  });

  it('still blocks close when workflow-linked editor tabs are open', async () => {
    const harness = closeHarness({ dirty: true, choice: 'discard', closeSucceeds: false });

    await expect(harness.request()).resolves.toBe('blocked');
  });
});
