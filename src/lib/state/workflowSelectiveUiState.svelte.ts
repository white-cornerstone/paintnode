import type {
  WorkflowSelectivePreflightProjection,
  WorkflowStoreRunOptions,
} from './workflow.svelte';

export class WorkflowSelectiveUiState {
  preflight = $state.raw<WorkflowSelectivePreflightProjection | null>(null);
  runOptions = $state.raw<WorkflowStoreRunOptions | null>(null);

  capture(
    preflight: WorkflowSelectivePreflightProjection,
    runOptions: WorkflowStoreRunOptions,
  ): void {
    this.preflight = preflight;
    this.runOptions = runOptions;
  }

  clear(): void {
    this.preflight = null;
    this.runOptions = null;
  }
}
