import { describe, expect, it } from 'vitest';
import { createProviderFreeWorkflowRevisionRequester } from '../integrations/providerFreeWorkflowRevision';
import { WorkflowStore } from '../state/workflow.svelte';
import { createWorkflowDirectorRevisionHistoryState } from './directorRevisionHistory.svelte';
import {
  acceptWorkflowDirectorRevisionPreview,
  requestWorkflowDirectorRevisionPreview,
} from './directorRevisionSession';

describe('Workflow Director revision history controls', () => {
  it('reactively enables Undo after accept, Redo after undo, and Undo after redo', async () => {
    const store = new WorkflowStore();
    store.newFromTemplate('campaign-composer');
    const history = createWorkflowDirectorRevisionHistoryState(store);
    expect(history).toMatchObject({ canUndo: false, canRedo: false });

    const preview = await requestWorkflowDirectorRevisionPreview(
      createProviderFreeWorkflowRevisionRequester(),
      store,
      'Refine this campaign for reactive history controls.',
    );
    acceptWorkflowDirectorRevisionPreview(preview, store);
    expect(history).toMatchObject({ canUndo: true, canRedo: false });

    expect(store.undoDirectorPatch()).toBe(true);
    expect(history).toMatchObject({ canUndo: false, canRedo: true });

    expect(store.redoDirectorPatch()).toBe(true);
    expect(history).toMatchObject({ canUndo: true, canRedo: false });
  });
});
