// Tracks overlapping background waits (project scan, document decode) and decides
// which label, if any, the UI should surface. Plain TS with an injected onChange
// callback so the logic stays unit-testable; ui.svelte.ts mirrors the label into
// reactive state.

/** Waits shorter than this never surface an indicator (anti-flash). */
export const LOADING_APPEAR_DELAY_MS = 250;

interface LoadingTask {
  label: string;
  visible: boolean;
}

export interface LoadingOptions {
  immediate?: boolean;
}

export class LoadingTracker {
  private tasks: LoadingTask[] = [];

  constructor(
    private readonly onChange: (label: string | null) => void,
    private readonly delayMs: number = LOADING_APPEAR_DELAY_MS,
  ) {}

  /**
   * Register a background wait. Returns a disposer to call when the work
   * finishes (use try/finally, or ui.withLoading which does it for you).
   * Overlapping waits stack; the most recent one that has outlived the
   * anti-flash delay is the one displayed.
   */
  begin(label: string, options: LoadingOptions = {}): () => void {
    const task: LoadingTask = { label, visible: options.immediate === true };
    this.tasks.push(task);
    if (task.visible) this.emit();
    const timer = options.immediate
      ? null
      : setTimeout(() => {
          task.visible = true;
          this.emit();
        }, this.delayMs);
    return () => {
      if (timer) clearTimeout(timer);
      const index = this.tasks.indexOf(task);
      if (index === -1) return; // disposer already called
      this.tasks.splice(index, 1);
      this.emit();
    };
  }

  /** Label of the most recent wait that outlived the anti-flash delay, or null. */
  label(): string | null {
    for (let i = this.tasks.length - 1; i >= 0; i--) {
      if (this.tasks[i].visible) return this.tasks[i].label;
    }
    return null;
  }

  private emit(): void {
    this.onChange(this.label());
  }
}
