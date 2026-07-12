import { describe, expect, it } from 'vitest';
import projectPanelSource from '../components/ProjectPanel.svelte?raw';
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
    expect(projectPanelSource).toContain("event.code !== 'KeyW'");
  });

  it('distinguishes layer placement from candidate inspection and requires an image document', () => {
    expect(projectPanelSource).toContain("'Place as layer'");
    expect(projectPanelSource).toContain("disabled={actionLabel === 'Place' && !editor.doc}");
  });
});
