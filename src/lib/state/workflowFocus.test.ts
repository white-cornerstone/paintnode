import { describe, expect, it, vi } from 'vitest';
import { restoreExternalDialogTrigger, workflowInitialFocusSelector } from './workflowFocus';

describe('workflow focus handoff', () => {
  it('restores the explicit picker trigger after cancel or return', () => {
    const focus = vi.fn();
    restoreExternalDialogTrigger({ focus, isConnected: true });
    expect(focus).toHaveBeenCalledOnce();

    const detachedFocus = vi.fn();
    restoreExternalDialogTrigger({ focus: detachedFocus, isConnected: false });
    expect(detachedFocus).not.toHaveBeenCalled();
  });

  it('focuses the checklist for setup blockers and the required slot when assets are next', () => {
    expect(workflowInitialFocusSelector('project-folder')).toBe('[data-workflow-checklist]');
    expect(workflowInitialFocusSelector('brief')).toBe('[data-workflow-checklist]');
    expect(workflowInitialFocusSelector('required-assets')).toBe('[data-workflow-required-slot]');
    expect(workflowInitialFocusSelector(null)).toBe('[data-workflow-board]');
  });
});
