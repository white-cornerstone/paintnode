import type { WorkflowReadinessCode } from '../workflow/readiness';

export interface FocusableTrigger {
  focus(): void;
  isConnected?: boolean;
}

export function restoreExternalDialogTrigger(trigger: FocusableTrigger): void {
  if (trigger.isConnected !== false) trigger.focus();
}

export function workflowInitialFocusSelector(code: WorkflowReadinessCode | null): string {
  if (code === 'required-assets') return '[data-workflow-required-slot]';
  if (code !== null) return '[data-workflow-checklist]';
  return '[data-workflow-board]';
}
