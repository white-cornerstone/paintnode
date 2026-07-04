import { ui } from './ui.svelte';

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
  kind: AiTaskKind;
  title: string;
  subtitle: string;
  status: AiTaskStatus;
  progress: string;
  error: string;
  startedAt: number;
  completedAt: number | null;
  detail: AiTaskDetail;
}

export interface AiTaskDraft {
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

class AiTaskStore {
  tasks = $state<AiTask[]>([]);

  create(draft: AiTaskDraft): AiTask {
    const task: AiTask = {
      id: createTaskId(draft.kind),
      kind: draft.kind,
      title: draft.title,
      subtitle: draft.subtitle,
      status: 'running',
      progress: draft.progress,
      error: '',
      startedAt: Date.now(),
      completedAt: null,
      detail: draft.detail,
    };
    this.tasks.unshift(task);
    return task;
  }

  find(id: string | null | undefined): AiTask | null {
    if (!id) return null;
    return this.tasks.find((task) => task.id === id) ?? null;
  }

  setProgress(id: string, progress: string): void {
    const task = this.find(id);
    if (!task) return;
    task.progress = progress;
  }

  setSubtitle(id: string, subtitle: string): void {
    const task = this.find(id);
    if (!task) return;
    task.subtitle = subtitle;
  }

  setDecoupleNotes(id: string, notes: string): void {
    const task = this.find(id);
    if (!task || task.detail.kind !== 'decouple') return;
    task.detail.notes = notes;
  }

  complete(id: string, progress = 'Completed'): void {
    const task = this.find(id);
    if (!task) return;
    task.status = 'completed';
    task.progress = progress;
    task.completedAt = Date.now();
  }

  fail(id: string, error: string): void {
    const task = this.find(id);
    if (!task) return;
    task.status = 'error';
    task.error = error;
    task.progress = error.split('\n')[0] || 'Failed';
    task.completedAt = Date.now();
  }

  open(id: string): void {
    const task = this.find(id);
    if (!task) return;
    ui.openAiTask(task.kind, id);
  }

  clearFinished(): void {
    this.tasks = this.tasks.filter((task) => task.status === 'running');
  }
}

export const aiTasks = new AiTaskStore();
