import { describe, expect, it } from 'vitest';
import projectPanelSource from '../components/ProjectPanel.svelte?raw';
import documentTabsSource from '../components/DocumentTabs.svelte?raw';
import projectStoreSource from './project.svelte.ts?raw';

describe('project restart recovery UX', () => {
  it('offers an explicit last-project fallback when automatic restore is disabled or missed', () => {
    expect(projectStoreSource).toContain('get lastPath(): string | null');
    expect(projectStoreSource).toContain('async reopenLastProject(): Promise<boolean>');
    expect(projectPanelSource).toContain('Reopen Last Project');
    expect(projectPanelSource).toContain('project.reopenLastProject()');
    expect(projectPanelSource).toContain('Keyboard: Alt+W opens the first saved workflow.');
    expect(projectPanelSource).toContain('aria-keyshortcuts="Alt+W"');
    expect(projectPanelSource).toContain('projectKeyboardShortcut(event)');
    expect(projectPanelSource).toContain('openFirstWorkflow()');
    expect(projectPanelSource).toContain("event.code === 'KeyW' && workflowFiles.length");
  });

  it('routes project assets to the active surface and only requires a document for layer placement', () => {
    expect(projectPanelSource).toContain("'Place as layer'");
    expect(projectPanelSource).toContain("'Add to workflow'");
    expect(projectPanelSource).toContain('const canUsePlaceActions = $derived(!!editor.doc || workflowBoardActive)');
    expect(projectPanelSource).toContain("disabled={actionLabel === 'Place' && !canUsePlaceActions}");
    expect(projectPanelSource).toContain('workflow.addAsset(asset)');
  });

  it('offers a guarded keyboard path to place the latest saved workflow edit after restart', () => {
    expect(projectPanelSource).toContain("/^editor-revision-.*\\.png$/i");
    expect(projectPanelSource).toContain('Place latest workflow edit as layer (Alt+L)');
    expect(projectPanelSource).toContain('aria-keyshortcuts="Alt+L"');
    expect(projectPanelSource).toContain("event.code === 'KeyL' && latestWorkflowEdit && editor.doc");
    expect(projectPanelSource).toContain('placeLatestWorkflowEdit()');
  });

  it('guards workflow replacement and routes tab close through the save confirmation command', () => {
    expect(projectPanelSource).toContain('workflow.active && workflow.dirty');
    expect(projectPanelSource).toContain('Save it before opening another saved workflow.');
    expect(projectPanelSource).toContain('workflow.savedPath === file.relativePath');
    expect(documentTabsSource).toContain('closeWorkflowCommand');
    expect(documentTabsSource).not.toContain('if (workflow.dirty)');
  });
});
