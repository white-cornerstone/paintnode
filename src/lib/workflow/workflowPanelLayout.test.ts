import { describe, expect, it } from 'vitest';
import appSource from '../../App.svelte?raw';
import boardSource from '../components/WorkflowBoard.svelte?raw';
import panelsSource from '../components/WorkflowPanels.svelte?raw';

describe('workflow app-level panel column', () => {
  it('renders beside the document and Project instead of inside WorkflowBoard', () => {
    expect(appSource).toContain("import WorkflowPanels from './lib/components/WorkflowPanels.svelte'");
    expect(appSource).toContain('{#if hasWorkflowBoard && !ui.workspaceFocusMode}');
    expect(appSource).toContain('<WorkflowPanels />');
    expect(boardSource).not.toContain('class="workflow-panels"');
    expect(boardSource).not.toContain('WorkflowPropertiesPanel');
  });

  it('peeks Properties and Map while leaving the column collapsed', () => {
    expect(panelsSource).toContain("let peekedPanel = $state<WorkflowPanelId | null>(null)");
    expect(panelsSource).toContain("onclick={() => peekPanel('properties')}");
    expect(panelsSource).toContain("onclick={() => peekPanel('map')}");
    expect(panelsSource).toContain('{#if peekedPanel}');
    expect(panelsSource).toContain('class="peek-popover"');

    const peekFunction = panelsSource.slice(
      panelsSource.indexOf('function peekPanel'),
      panelsSource.indexOf('function requestDirectorAction'),
    );
    expect(peekFunction).not.toContain('setRightCollapsed(false)');
  });
});
