import type {
  WorkflowSelectivePreflightProjection,
  WorkflowStoreRunOptions,
} from './workflow.svelte';

export class WorkflowSelectiveUiState {
  preflight = $state.raw<WorkflowSelectivePreflightProjection | null>(null);
  runOptions = $state.raw<WorkflowStoreRunOptions | null>(null);
  busy = $state(false);
  private previewEpoch = 0;

  beginPreview(): number {
    this.previewEpoch += 1;
    this.clear();
    this.busy = true;
    return this.previewEpoch;
  }

  invalidatePreview(): void {
    this.previewEpoch += 1;
    this.clear();
    this.busy = false;
  }

  isCurrentPreview(epoch: number): boolean {
    return epoch === this.previewEpoch;
  }

  settlePreview(epoch: number): void {
    if (this.isCurrentPreview(epoch)) this.busy = false;
  }

  beginRun(): void {
    this.busy = true;
  }

  settleRun(): void {
    this.busy = false;
  }

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
