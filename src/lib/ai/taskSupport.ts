import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { editor } from '../state/editor.svelte';
import type { AiPlannerMode, AiProvider, AiRunOptions } from '../state/settings';

/** Shared support for the background AI tasks and their dialogs (Generate, Retouch, Extract Assets). */

export type CodexProgressPayload = {
  runId: string;
  message: string;
  /** 1-based position of the placement part this message belongs to. */
  partIndex?: number;
  partCount?: number;
};

export function providerLabel(provider: AiProvider): string {
  if (provider === 'antigravity') return 'Antigravity';
  return 'Codex';
}

export function providerRunDir(provider: AiProvider): string {
  if (provider === 'antigravity') return 'antigravity-runs';
  return 'codex-runs';
}

export function imageProviderFromRunOptions(options: Pick<AiRunOptions, 'imageProvider' | 'provider'>): AiProvider {
  return options.imageProvider ?? options.provider ?? 'codex';
}

export function plannerProviderFromRunOptions(options: Pick<AiRunOptions, 'plannerProvider'>): AiProvider {
  return options.plannerProvider ?? 'codex';
}

export function plannerModeFromRunOptions(options: Pick<AiRunOptions, 'plannerMode'>): AiPlannerMode {
  return options.plannerMode ?? 'auto';
}

export function plannerModeLabel(mode: AiPlannerMode): string {
  if (mode === 'skip') return 'Skip planner';
  if (mode === 'force') return 'Always plan';
  return 'Auto plan';
}

export function aiRoleSummary(options: Pick<AiRunOptions, 'plannerMode' | 'plannerProvider' | 'imageProvider' | 'provider'>): string {
  const imageProvider = imageProviderFromRunOptions(options);
  const plannerMode = plannerModeFromRunOptions(options);
  if (plannerMode === 'skip') return `Image: ${providerLabel(imageProvider)}`;
  return `${plannerMode === 'force' ? 'Planner' : 'Auto'}: ${providerLabel(plannerProviderFromRunOptions(options))} -> Image: ${providerLabel(imageProvider)}`;
}

export function aiRunningLabel(provider: AiProvider): string {
  return provider === 'antigravity' ? 'Antigravity is running...' : 'Codex is running...';
}

export function createRunId(prefix: string): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Switch back to the document a background task was started in before acting
 * on its result. Throws when that document has been closed (`required`), so
 * the task fails instead of acting on whichever document happens to be
 * active; pass `required = false` when the completion work is document-free
 * and losing the document only skips an optional step.
 */
export function focusTaskDocument(documentId: string | null, required = true): void {
  if (!documentId || editor.activeDocumentId === documentId) return;
  if (!editor.documents.some((session) => session.id === documentId)) {
    if (required) throw new Error('The document this task was started in has been closed.');
    return;
  }
  editor.switchDocument(documentId);
}

/**
 * Owns one dialog's subscription to the streamed CLI progress events.
 * listen() resolves asynchronously, so a run can finish before the
 * registration lands; the generation counter makes such late registrations
 * unlisten immediately instead of leaking.
 */
export class AiProgressListener {
  private unlisten: UnlistenFn | null = null;
  private generation = 0;

  start(
    runId: string,
    onMessage: (message: string, payload: CodexProgressPayload) => void,
    onUnavailable: () => void,
  ): void {
    this.clear();
    const generation = this.generation;
    void listen<CodexProgressPayload>('codex-generation-progress', (event) => {
      if (event.payload.runId === runId && event.payload.message.trim()) {
        onMessage(event.payload.message.trim(), event.payload);
      }
    })
      .then((stop) => {
        if (this.generation !== generation) {
          stop();
          return;
        }
        this.unlisten = stop;
      })
      .catch(onUnavailable);
  }

  clear(): void {
    this.generation += 1;
    this.unlisten?.();
    this.unlisten = null;
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
}

/**
 * PNG data URL of the canvas downscaled to fit `maxDim`. Task details live in
 * the session-long task list, so previews must be thumbnails, not
 * full-resolution encodes of document-sized canvases.
 */
export function canvasPreviewDataUrl(canvas: HTMLCanvasElement, maxDim = 256): string {
  const scale = Math.min(1, maxDim / Math.max(canvas.width, canvas.height, 1));
  if (scale >= 1) return canvas.toDataURL('image/png');
  const thumb = document.createElement('canvas');
  thumb.width = Math.max(1, Math.round(canvas.width * scale));
  thumb.height = Math.max(1, Math.round(canvas.height * scale));
  thumb.getContext('2d')?.drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return thumb.toDataURL('image/png');
}
