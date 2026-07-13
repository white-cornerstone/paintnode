import type { SaveChangesChoice, SaveChangesPrompt } from './ui.svelte';

export type WorkflowCloseResult = 'closed' | 'cancelled' | 'save-incomplete' | 'blocked';

export async function requestWorkflowClose(options: Readonly<{
  name: () => string;
  needsSave: () => boolean;
  askSaveChanges: (prompt: SaveChangesPrompt) => Promise<SaveChangesChoice>;
  saveWorkflow: () => Promise<void>;
  closeWorkflow: () => boolean;
}>): Promise<WorkflowCloseResult> {
  if (options.needsSave()) {
    const choice = await options.askSaveChanges({
      kind: 'workflow',
      name: options.name(),
      index: 1,
      total: 1,
    });
    if (choice === 'cancel') return 'cancelled';
    if (choice === 'save') {
      await options.saveWorkflow();
      if (options.needsSave()) return 'save-incomplete';
    }
  }

  return options.closeWorkflow() ? 'closed' : 'blocked';
}
