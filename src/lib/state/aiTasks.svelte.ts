import { isRecord, type AiRunOptions } from './settings';
import { ui } from './ui.svelte';
import type { WorkflowSourceImage } from '../integrations/desktop';

const TASKS_STORAGE_PREFIX = 'paintnode.aiTasks.';

export type AiTaskKind = 'generate' | 'retouch' | 'upscale' | 'decouple' | 'autoAdjust' | 'workflow';
export type AiTaskStatus = 'running' | 'completed' | 'cancelled' | 'error';

export interface GenerateTaskDetail {
  kind: 'generate';
  providerLabel: string;
  prompt: string;
  fillMode: boolean;
  /**
   * Run configuration captured at creation, persisted so Retry re-runs the
   * task as recorded — including after an app restart. Absent on tasks saved
   * by older versions; the executor falls back to current settings.
   */
  runOptions?: AiRunOptions;
  /** Reference PNGs captured for the active in-session run. Stripped before persistence. */
  references?: WorkflowSourceImage[];
  referenceNames?: string[];
  referencePreviews?: string[];
}

export interface RetouchTaskDetail {
  kind: 'retouch';
  providerLabel: string;
  prompt: string;
  toolName: string;
  gestureKind: string;
  sourcePreview: string;
  maskPreview: string;
  annotatedSourcePreview: string;
  referencePreview: string;
  referenceNames?: string[];
  referencePreviews?: string[];
  references?: WorkflowSourceImage[];
}

export interface UpscaleTaskDetail {
  kind: 'upscale';
  providerLabel: string;
  scalePercent: number;
  sourceName: string;
  /** Preview of the flattened source. Stripped before persistence. */
  sourcePreview: string;
}

export interface AutoAdjustTaskDetail {
  kind: 'autoAdjust';
  providerLabel: string;
  adjustment: 'tone' | 'contrast' | 'color';
  prompt: string;
  sourceName: string;
  sourcePreview: string;
}

export interface DecoupleTaskDetail {
  kind: 'decouple';
  providerLabel: string;
  prompt: string;
  sourceLayerName: string;
  addToWorkflow: boolean;
  placeOnCanvas: boolean;
  tolerance: number;
  notes: string;
}

export interface WorkflowTaskDetail {
  kind: 'workflow';
  providerLabel: string;
  outputName: string;
}

export type AiTaskDetail = GenerateTaskDetail | RetouchTaskDetail | UpscaleTaskDetail | DecoupleTaskDetail | AutoAdjustTaskDetail | WorkflowTaskDetail;

/** Live sub-task progress for placement-split runs (in-memory, like `progress`). */
export interface AiTaskPartProgress {
  completed: number;
  total: number;
}

export interface AiTask {
  id: string;
  projectPath: string | null;
  kind: AiTaskKind;
  title: string;
  subtitle: string;
  status: AiTaskStatus;
  progress: string;
  error: string;
  warning: string;
  startedAt: number;
  completedAt: number | null;
  /**
   * Document the task acts on; null means the active document. Document ids
   * do not survive a restart, so restored tasks always carry null.
   */
  documentId: string | null;
  /**
   * CLI run id, stable across retries so a retry reuses the same job folder
   * and resumes from completed parts; also targets Stop for running tasks.
   */
  runId: string | null;
  detail: AiTaskDetail;
  partProgress: AiTaskPartProgress | null;
  retry: (() => Promise<void> | void) | null;
  cancel: (() => Promise<void> | void) | null;
}

export interface AiTaskDraft {
  projectPath?: string | null;
  kind: AiTaskKind;
  title: string;
  subtitle: string;
  progress: string;
  documentId?: string | null;
  runId?: string | null;
  detail: AiTaskDetail;
}

/**
 * Runs (and re-runs) a task of one kind purely from the task record. Kinds
 * with a registered executor keep Retry across app restarts; kinds whose
 * inputs are live canvases use per-task setRetry closures instead and lose
 * Retry on reload.
 */
export type AiTaskExecutor = (task: AiTask) => Promise<void> | void;

function createTaskId(kind: AiTaskKind): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type StoredAiTask = Omit<AiTask, 'retry' | 'cancel' | 'partProgress'>;

function storageKey(projectPath: string): string {
  return `${TASKS_STORAGE_PREFIX}${encodeURIComponent(projectPath)}`;
}

function storedTaskFrom(value: unknown, projectPath: string): StoredAiTask | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const status = value.status;
  if (kind !== 'generate' && kind !== 'retouch' && kind !== 'upscale' && kind !== 'decouple' && kind !== 'autoAdjust' && kind !== 'workflow') return null;
  if (status !== 'running' && status !== 'completed' && status !== 'cancelled' && status !== 'error') return null;
  const detail = value.detail;
  if (!isRecord(detail) || detail.kind !== kind) return null;
  const id = typeof value.id === 'string' ? value.id : createTaskId(kind);
  const progress = typeof value.progress === 'string' ? value.progress : '';
  const error = typeof value.error === 'string' ? value.error : '';
  const normalizedStatus = status === 'running' ? 'error' : status;
  return {
    id,
    projectPath,
    kind,
    title: typeof value.title === 'string' ? value.title : 'AI Task',
    subtitle: typeof value.subtitle === 'string' ? value.subtitle : '',
    status: normalizedStatus,
    progress: status === 'running' ? 'Interrupted when PaintNode closed' : progress,
    error: status === 'running' ? 'This task was still running when PaintNode closed.' : error,
    warning: status === 'running' ? '' : typeof value.warning === 'string' ? value.warning : '',
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : Date.now(),
    completedAt: typeof value.completedAt === 'number' ? value.completedAt : Date.now(),
    // Document ids are session-scoped; a restored task acts on the active document.
    documentId: null,
    runId: typeof value.runId === 'string' ? value.runId : null,
    detail: detail as unknown as AiTaskDetail,
  };
}

function storedDetailFrom(detail: AiTaskDetail): AiTaskDetail {
  if (detail.kind === 'upscale' || detail.kind === 'autoAdjust') {
    return { ...detail, sourcePreview: '' };
  }
  if (detail.kind === 'generate') {
    const { references, referencePreviews, ...stored } = detail;
    return {
      ...stored,
      referencePreviews: referencePreviews?.length ? [] : undefined,
    };
  }
  if (detail.kind !== 'retouch') return detail;
  const { references, referencePreviews, ...stored } = detail;
  return {
    ...stored,
    sourcePreview: '',
    maskPreview: '',
    annotatedSourcePreview: '',
    referencePreview: '',
    referencePreviews: referencePreviews?.length ? [] : undefined,
  };
}

export class AiTaskStore {
  private allTasks = $state<AiTask[]>([]);
  private activeProjectPath = $state<string | null>(null);
  private loadedProjectPaths = new Set<string>();
  private executors = new Map<AiTaskKind, AiTaskExecutor>();

  get tasks(): AiTask[] {
    // Tasks started with no project open (projectPath null) stay visible after
    // a project is opened; otherwise a running task vanishes from the panel.
    return this.allTasks.filter(
      (task) => task.projectPath === this.activeProjectPath || task.projectPath === null,
    );
  }

  registerExecutor(kind: AiTaskKind, executor: AiTaskExecutor): void {
    this.executors.set(kind, executor);
  }

  create(draft: AiTaskDraft): AiTask {
    const projectPath = draft.projectPath ?? this.activeProjectPath;
    const task: AiTask = {
      id: createTaskId(draft.kind),
      projectPath,
      kind: draft.kind,
      title: draft.title,
      subtitle: draft.subtitle,
      status: 'running',
      progress: draft.progress,
      error: '',
      warning: '',
      startedAt: Date.now(),
      completedAt: null,
      documentId: draft.documentId ?? null,
      runId: draft.runId ?? null,
      detail: draft.detail,
      partProgress: null,
      retry: null,
      cancel: null,
    };
    this.allTasks.unshift(task);
    this.persistProject(projectPath);
    return task;
  }

  /** Run a freshly created task through its kind's registered executor. */
  launch(id: string): void {
    const task = this.find(id);
    const executor = task ? this.executors.get(task.kind) : undefined;
    if (!task || !executor) return;
    void Promise.resolve(executor(task)).catch((e) => {
      this.fail(id, (e as Error)?.message ?? String(e));
    });
  }

  find(id: string | null | undefined): AiTask | null {
    if (!id) return null;
    return this.allTasks.find((task) => task.id === id) ?? null;
  }

  setProgress(id: string, progress: string): void {
    const task = this.find(id);
    if (!task) return;
    // In-memory only: progress can stream many times per second, and a running
    // task's persisted progress is discarded on load anyway. Status
    // transitions (create/complete/fail) persist the task list.
    task.progress = progress;
  }

  /**
   * Track which placement part a split run is on. In-memory only: part
   * progress streams with the run and is meaningless after a restart.
   */
  setPartProgress(id: string, partIndex: number, partCount: number): void {
    const task = this.find(id);
    if (!task || partCount < 1) return;
    task.partProgress = {
      completed: Math.min(partCount, Math.max(0, Math.round(partIndex) - 1)),
      total: Math.round(partCount),
    };
  }

  setDecoupleNotes(id: string, notes: string): void {
    const task = this.find(id);
    if (!task || task.detail.kind !== 'decouple') return;
    task.detail.notes = notes;
    this.persistProject(task.projectPath);
  }

  setRunId(id: string, runId: string | null): void {
    const task = this.find(id);
    if (!task) return;
    task.runId = runId;
    this.persistProject(task.projectPath);
  }

  setRetry(id: string, retry: (() => Promise<void> | void) | null): void {
    const task = this.find(id);
    if (!task) return;
    task.retry = retry;
  }

  setCancel(id: string, cancel: (() => Promise<void> | void) | null): void {
    const task = this.find(id);
    if (!task) return;
    task.cancel = cancel;
  }

  canCancel(task: AiTask): boolean {
    return task.status === 'running' && task.cancel !== null;
  }

  async cancel(id: string): Promise<void> {
    const task = this.find(id);
    if (!task || !this.canCancel(task)) return;
    task.progress = 'Cancelling…';
    await task.cancel?.();
  }

  complete(id: string, progress = 'Completed', warning = ''): void {
    const task = this.find(id);
    if (!task) return;
    task.status = 'completed';
    task.progress = progress;
    task.warning = warning;
    if (task.partProgress) task.partProgress = { ...task.partProgress, completed: task.partProgress.total };
    task.completedAt = Date.now();
    // Release the closure: Retry is only offered on error, and retry closures
    // can pin document-sized canvases for the rest of the session.
    task.retry = null;
    task.cancel = null;
    this.persistProject(task.projectPath);
  }

  markCancelled(id: string, progress = 'Cancelled'): void {
    const task = this.find(id);
    if (!task) return;
    task.status = 'cancelled';
    task.progress = progress;
    task.error = '';
    task.warning = '';
    task.completedAt = Date.now();
    task.retry = null;
    task.cancel = null;
    this.persistProject(task.projectPath);
  }

  fail(id: string, error: string): void {
    const task = this.find(id);
    if (!task) return;
    task.status = 'error';
    task.error = error;
    task.warning = '';
    task.progress = error.split('\n')[0] || 'Failed';
    task.completedAt = Date.now();
    task.cancel = null;
    this.persistProject(task.projectPath);
  }

  /** Whether Retry is available: an in-session closure or a kind executor. */
  canRetry(task: AiTask): boolean {
    return task.status === 'error' && (task.retry !== null || this.executors.has(task.kind));
  }

  retry(id: string): void {
    const task = this.find(id);
    if (!task || !this.canRetry(task)) return;
    const retry = task.retry;
    const executor = this.executors.get(task.kind);
    task.status = 'running';
    task.error = '';
    task.warning = '';
    task.progress = 'Retrying...';
    task.startedAt = Date.now();
    task.completedAt = null;
    this.persistProject(task.projectPath);
    void Promise.resolve(retry ? retry() : executor?.(task)).catch((e) => {
      this.fail(id, (e as Error)?.message ?? String(e));
    });
  }

  open(id: string): void {
    const task = this.find(id);
    if (!task) return;
    ui.openAiTask(task.kind, id);
  }

  clearCompleted(): void {
    const projectPath = this.activeProjectPath;
    // Clears everything the panel currently shows: the active project's tasks
    // plus project-less (null-path) tasks.
    this.allTasks = this.allTasks.filter(
      (task) => (task.projectPath !== projectPath && task.projectPath !== null)
        || (task.status !== 'completed' && task.status !== 'cancelled'),
    );
    this.persistProject(projectPath);
  }

  clearCompletedTask(id: string): void {
    const task = this.find(id);
    this.allTasks = this.allTasks.filter((item) => item.id !== id
      || (item.status !== 'completed' && item.status !== 'cancelled'));
    this.persistProject(task?.projectPath ?? this.activeProjectPath);
  }

  /** Dismiss a single failed task, leaving running/completed tasks untouched. */
  dismissErrorTask(id: string): void {
    const task = this.find(id);
    this.allTasks = this.allTasks.filter((item) => item.id !== id || item.status !== 'error');
    this.persistProject(task?.projectPath ?? this.activeProjectPath);
  }

  /** Clear every finished task the panel shows — both completed and failed. */
  clearFinished(): void {
    const projectPath = this.activeProjectPath;
    this.allTasks = this.allTasks.filter(
      (task) =>
        (task.projectPath !== projectPath && task.projectPath !== null) ||
        (task.status !== 'completed' && task.status !== 'cancelled' && task.status !== 'error'),
    );
    this.persistProject(projectPath);
  }

  setProjectPath(projectPath: string | null): void {
    this.activeProjectPath = projectPath;
    if (!projectPath || this.loadedProjectPaths.has(projectPath)) return;
    this.loadedProjectPaths.add(projectPath);
    this.loadProject(projectPath);
  }

  private loadProject(projectPath: string): void {
    if (typeof localStorage === 'undefined') return;
    try {
      const parsed = JSON.parse(localStorage.getItem(storageKey(projectPath)) || '[]');
      if (!Array.isArray(parsed)) return;
      const existingIds = new Set(this.allTasks.map((task) => task.id));
      const loaded = parsed
        .map((item) => storedTaskFrom(item, projectPath))
        .filter((task): task is StoredAiTask => !!task)
        .filter((task) => !existingIds.has(task.id))
        .map((task) => ({ ...task, partProgress: null, retry: null, cancel: null }));
      this.allTasks = [...this.allTasks, ...loaded].sort((a, b) => b.startedAt - a.startedAt);
      this.persistProject(projectPath);
    } catch {
      // Ignore corrupt task history; new task updates will overwrite it.
    }
  }

  private persistProject(projectPath: string | null): void {
    if (!projectPath || typeof localStorage === 'undefined') return;
    const serializable: StoredAiTask[] = this.allTasks
      .filter((task) => task.projectPath === projectPath)
      .map(({ retry, cancel, partProgress, ...task }) => ({
        ...task,
        detail: storedDetailFrom(task.detail),
      }));
    try {
      localStorage.setItem(storageKey(projectPath), JSON.stringify(serializable));
    } catch {
      // Task rows are useful but must never block the AI action itself. If the
      // browser storage quota is full, keep the in-memory task list and continue.
    }
  }
}

export const aiTasks = new AiTaskStore();
