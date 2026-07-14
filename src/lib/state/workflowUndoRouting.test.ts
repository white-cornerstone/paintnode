import { describe, expect, it } from 'vitest';
import appSource from '../../App.svelte?raw';
import menuBarSource from '../components/MenuBar.svelte?raw';
import workflowBoardSource from '../components/WorkflowBoard.svelte?raw';
import keyboardSource from './keyboard.ts?raw';

describe('workflow authoring undo routing', () => {
  it('routes keyboard undo and redo to workflow history on the workflow surface', () => {
    expect(keyboardSource).toContain("ui.activeSurface === 'workflow' && workflow.active");
    expect(keyboardSource).toContain('workflow.undoAuthoring()');
    expect(keyboardSource).toContain('workflow.redoAuthoring()');
    expect(keyboardSource).toContain('else editor.undo()');
    expect(keyboardSource).toContain('else editor.redo()');
  });

  it('routes both application menus through the active workflow history', () => {
    for (const source of [appSource, menuBarSource]) {
      expect(source).toContain("ui.activeSurface === 'workflow'");
      expect(source).toContain('workflow.undoAuthoring()');
      expect(source).toContain('workflow.redoAuthoring()');
    }
  });

  it('offers an actionable undo notice after disconnecting links', () => {
    expect(workflowBoardSource).toContain('Disconnected {disconnectUndoNotice.count}');
    expect(workflowBoardSource).toContain("workflow.authoringUndoLabel === 'Disconnect links'");
    expect(workflowBoardSource).toContain('onclick={undoDisconnect}');
  });
});
