import { isRecord } from './settings';
import { ui } from './ui.svelte';

const TASKS_STORAGE_PREFIX = 'paintnode.aiTasks.';

export type AiTaskKind = 'generate' | 'retouch' | 'decouple';
export type AiTaskStatus = 'running' | 'completed' | 'error';

export interface GenerateTaskDetail {
  kind: 'generate';
  providerLabel: string;
  prompt: string;
  fillMode: boolean;
}

export interface RetouchTaskDetail {
  kind: 'retouch';
  providerLabel: string;
  prompt: string;
  toolName: string;
  gestureKind: string;
  sourcePreview: string;
  maskPreview: string;
  referencePreview: string;
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

export type AiTaskDetail = GenerateTaskDetail | RetouchTaskDetail | DecoupleTaskDetail;

export interface AiTask {
  id: string;
  projectPath: string | null;
  kind: AiTaskKind;
  title: string;
  subtitle: string;
  status: AiTaskStatus;
  progress: string;
  error: string;
  startedAt: number;
  completedAt: number | null;
  detail: AiTaskDetail;
  retry: (() => Promise<void> | void) | null;
}

export interface AiTaskDraft {
  projectPath?: string | null;
  kind: AiTaskKind;
  title: string;
  subtitle: string;
  progress: string;
  detail: AiTaskDetail;
}

function createTaskId(kind: AiTaskKind): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type StoredAiTask = Omit<AiTask, 'retry'>;

function storageKey(projectPath: string): string {
  return `${TASKS_STORAGE_PREFIX}${encodeURIComponent(projectPath)}`;
}

function storedTaskFrom(value: unknown, projectPath: string): StoredAiTask | null {
  if (!isRecord(value)) return null;
  const kind = value.kind;
  const status = value.status;
  if (kind !== 'generate' && kind !== 'retouch' && kind !== 'decouple') return null;
  if (status !== 'running' && status !== 'completed' && status !== 'error') return null;
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
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : Date.now(),
    completedAt: typeof value.completedAt === 'number' ? value.completedAt : Date.now(),
    detail: detail as unknown as AiTaskDetail,
  };
}

function storedDetailFrom(detail: AiTaskDetail): AiTaskDetail {
  if (detail.kind !== 'retouch') return detail;
  return {
    ...detail,
    sourcePreview: '',
    maskPreview: '',
    referencePreview: '',
  };
}

class AiTaskStore {
  private allTasks = $state<AiTask[]>([]);
  private activeProjectPath = $state<string | null>(null);
  private loadedProjectPaths = new Set<string>();

  get tasks(): AiTask[] {
    // Tasks started with no project open (projectPath null) stay visible after
    // a project is opened; otherwise a running task vanishes from the panel.
    return this.allTasks.filter(
      (task) => task.projectPath === this.activeProjectPath || task.projectPath === null,
    );
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
      startedAt: Date.now(),
      completedAt: null,
      detail: draft.detail,
      retry: null,
    };
    this.allTasks.unshift(task);
    this.persistProject(projectPath);
    return task;
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

  setDecoupleNotes(id: string, notes: string): void {
    const task = this.find(id);
    if (!task || task.detail.kind !== 'decouple') return;
    task.detail.notes = notes;
    this.persistProject(task.projectPath);
  }

  setRetry(id: string, retry: (() => Promise<void> | void) | null): void {
    const task = this.find(id);
    if (!task) return;
    task.retry = retry;
  }

  complete(id: string, progress = 'Completed'): void {
    const task = this.find(id);
    if (!task) return;
    task.status = 'completed';
    task.progress = progress;
    task.completedAt = Date.now();
    this.persistProject(task.projectPath);
  }

  fail(id: string, error: string): void {
    const task = this.find(id);
    if (!task) return;
    task.status = 'error';
    task.error = error;
    task.progress = error.split('\n')[0] || 'Failed';
    task.completedAt = Date.now();
    this.persistProject(task.projectPath);
  }

  retry(id: string): void {
    const task = this.find(id);
    if (!task || task.status !== 'error' || !task.retry) return;
    task.status = 'running';
    task.error = '';
    task.progress = 'Retrying...';
    task.startedAt = Date.now();
    task.completedAt = null;
    this.persistProject(task.projectPath);
    void Promise.resolve(task.retry()).catch((e) => {
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
      (task) => (task.projectPath !== projectPath && task.projectPath !== null) || task.status !== 'completed',
    );
    this.persistProject(projectPath);
  }

  clearCompletedTask(id: string): void {
    const task = this.find(id);
    this.allTasks = this.allTasks.filter((item) => item.id !== id || item.status !== 'completed');
    this.persistProject(task?.projectPath ?? this.activeProjectPath);
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
        .map((task) => ({ ...task, retry: null }));
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
      .map(({ retry, ...task }) => ({
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
