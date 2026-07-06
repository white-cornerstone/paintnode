<script lang="ts">
  import { onDestroy } from 'svelte';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import AiRunOptionsControl from './AiRunOptionsControl.svelte';
  import {
    AiProgressListener,
    canvasPreviewDataUrl,
    copyTextToClipboard,
    createRunId,
    providerLabel,
  } from '../ai/taskSupport';
  import { tooltip } from '../actions/tooltip';
  import { aiTasks } from '../state/aiTasks.svelte';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { settings } from '../state/settings.svelte';
  import { aiRunOptionsFromSettings } from '../state/settings';
  import { PaintDocument } from '../engine/Document.svelte';
  import { Layer } from '../engine/Layer.svelte';
  import { compositeToCanvas } from '../engine/compositor';
  import { createCanvas, ctx2d } from '../engine/types';
  import {
    antigravityConfigFromRunOptions,
    codexConfigFromRunOptions,
    generateAntigravityRetouchImage,
    generateCodexRetouchImage,
    isDesktop,
  } from '../integrations/desktop';
  import { ui, type AiAutoAdjustKind } from '../state/ui.svelte';
  import { Copy } from '../icons';

  let { onClose, taskId = null }: { onClose: () => void; taskId?: string | null } = $props();

  const desktop = isDesktop();
  let runOptions = $state(aiRunOptionsFromSettings(settings.value));
  let busy = $state(false);
  let error = $state('');
  let copied = $state(false);
  const progressListener = new AiProgressListener();
  let runningTaskId: string | null = null;

  const task = $derived(aiTasks.find(taskId));
  const taskDetail = $derived(task?.detail.kind === 'autoAdjust' ? task.detail : null);
  const kind = $derived(taskDetail?.adjustment ?? ui.aiAutoAdjustKind);
  const doc = $derived(editor.doc);
  const currentError = $derived(task?.error ?? error);
  const currentProgress = $derived(task?.progress ?? '');
  const currentBusy = $derived(task?.status === 'running' || busy);
  let prompt = $state(autoPrompt(ui.aiAutoAdjustKind));

  $effect(() => {
    if (!taskDetail) prompt = autoPrompt(ui.aiAutoAdjustKind);
  });

  const title = $derived(`AI Auto ${labelFor(kind)}`);

  onDestroy(() => {
    if (!runningTaskId) progressListener.clear();
  });

  function labelFor(value: AiAutoAdjustKind): string {
    return value === 'tone' ? 'Tone' : value === 'contrast' ? 'Contrast' : 'Color';
  }

  function autoPrompt(value: AiAutoAdjustKind): string {
    const common =
      'Preserve the document content, composition, crop, transparency, subject identity, text, logos, line art, and all object positions. Do not add, remove, move, restyle, denoise, sharpen, upscale, or repaint content. Only make a natural global photographic adjustment.';
    if (value === 'contrast') {
      return `Apply an automatic contrast correction to this full PaintNode document. Improve black/white points and local readability while keeping colors and brightness believable. ${common}`;
    }
    if (value === 'color') {
      return `Apply an automatic color correction to this full PaintNode document. Neutralize unwanted color cast, balance highlights/midtones/shadows, and keep skin tones and brand colors natural. ${common}`;
    }
    return `Apply an automatic tonal correction to this full PaintNode document. Balance shadows, midtones, and highlights, recover a natural exposure, and avoid clipping important detail. ${common}`;
  }

  async function copyError() {
    if (!currentError) return;
    await copyTextToClipboard(currentError);
    copied = true;
    window.setTimeout(() => (copied = false), 1200);
  }

  async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => {
        if (value) resolve(value);
        else reject(new Error('Unable to encode the document for AI auto adjustment.'));
      }, 'image/png');
    });
    return new Uint8Array(await blob.arrayBuffer());
  }

  function fullMask(width: number, height: number): HTMLCanvasElement {
    const mask = createCanvas(width, height);
    const c = ctx2d(mask);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, width, height);
    return mask;
  }

  async function run() {
    error = '';
    copied = false;
    const activeDoc = editor.doc;
    if (!activeDoc) {
      error = 'Open a document to adjust.';
      return;
    }
    if (!desktop) {
      error = 'AI Auto adjustments are available only in the desktop app.';
      return;
    }
    if (!prompt.trim()) {
      error = 'Enter an adjustment prompt.';
      return;
    }
    if (runOptions.provider === 'custom') {
      error = 'AI Auto adjustments are currently available with Local Codex or Antigravity CLI.';
      return;
    }

    busy = true;
    const adjustment = kind;
    const taskProjectPath = project.path;
    const docName = activeDoc.name || 'Untitled';
    const source = compositeToCanvas(activeDoc);
    const mask = fullMask(source.width, source.height);
    const sourcePreview = canvasPreviewDataUrl(source);
    const runId = createRunId(`auto-${adjustment}`);
    const task = aiTasks.create({
      kind: 'autoAdjust',
      runId,
      title: `AI Auto ${labelFor(adjustment)}`,
      subtitle: providerLabel(runOptions.provider),
      progress: 'Preparing AI auto adjustment input...',
      detail: {
        kind: 'autoAdjust',
        providerLabel: providerLabel(runOptions.provider),
        adjustment,
        prompt: prompt.trim(),
        sourceName: docName,
        sourcePreview,
      },
    });
    runningTaskId = task.id;
    onClose();

    const executeTask = async () => {
      aiTasks.setProgress(task.id, 'Preparing AI auto adjustment input...');
      editor.flash('Preparing AI auto adjustment...');
      const keepJobDir = settings.value.workspace.keepAiRunInputs;
      progressListener.start(
        runId,
        (message, payload) => {
          aiTasks.setProgress(task.id, message);
          if (payload.partIndex && payload.partCount) {
            aiTasks.setPartProgress(task.id, payload.partIndex, payload.partCount);
          }
        },
        () =>
          aiTasks.setProgress(
            task.id,
            runOptions.provider === 'antigravity' ? 'Local Antigravity is running...' : 'Local Codex is running...',
          ),
      );

      try {
        const sourcePng = await canvasToPngBytes(source);
        const maskPng = await canvasToPngBytes(mask);
        const generated =
          runOptions.provider === 'antigravity'
            ? await generateAntigravityRetouchImage(
                antigravityConfigFromRunOptions(runOptions, taskProjectPath, runId, keepJobDir),
                sourcePng,
                sourcePng,
                maskPng,
                null,
                null,
                prompt.trim(),
              )
            : await generateCodexRetouchImage(
                codexConfigFromRunOptions(runOptions, taskProjectPath, runId, keepJobDir),
                sourcePng,
                sourcePng,
                maskPng,
                null,
                null,
                prompt.trim(),
              );
        if (generated.asset) await project.refresh(taskProjectPath);
        const blob = await (await fetch(generated.dataUrl)).blob();
        const bmp = await createImageBitmap(blob);
        const adjustedDoc = new PaintDocument(bmp.width, bmp.height, `${docName} AI Auto ${labelFor(adjustment)}`);
        const layer = new Layer(bmp.width, bmp.height, 'Adjusted image');
        layer.sourceAssetId = generated.asset?.id ?? null;
        layer.sourcePath = generated.asset?.relativePath ?? null;
        layer.ctx.drawImage(bmp, 0, 0);
        layer.touch();
        bmp.close();
        adjustedDoc.layers = [layer];
        adjustedDoc.activeLayerId = layer.id;
        editor.openDocument(adjustedDoc);
        editor.flash(`AI Auto ${labelFor(adjustment)} opened as a new document`);
        aiTasks.complete(task.id, `AI Auto ${labelFor(adjustment)} completed`);
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        error = message;
        aiTasks.fail(task.id, message);
        editor.flash(`AI Auto ${labelFor(adjustment)} failed`);
      } finally {
        busy = false;
        progressListener.clear();
        runningTaskId = null;
      }
    };
    aiTasks.setRetry(task.id, executeTask);
    void executeTask();
  }
</script>

<Modal title={title} onClose={onClose} width={540}>
  <div class="dlg-form auto-adjust">
    {#if !desktop}
      <p class="warn">AI Auto adjustments run a local AI provider and only work in the desktop app.</p>
    {/if}

    {#if taskDetail}
      <div class="summary">
        <strong>{taskDetail.sourceName}</strong>
        <span>{labelFor(taskDetail.adjustment)} · {taskDetail.providerLabel}</span>
      </div>
      {#if taskDetail.sourcePreview}
        <figure>
          <img src={taskDetail.sourcePreview} alt="" />
          <figcaption>Source</figcaption>
        </figure>
      {/if}
      <label class="dlg-field">
        <span>Prompt</span>
        <textarea value={taskDetail.prompt} rows="4" readonly></textarea>
      </label>
    {:else}
      <label class="dlg-field">
        <span>Adjustment prompt</span>
        <textarea bind:value={prompt} rows="5" spellcheck="true"></textarea>
      </label>
      <p class="hint">
        The result opens as a new single-layer document so you can compare it with the original.
      </p>
    {/if}

    {#if currentBusy}
      <div class="progress-line" role="status" aria-live="polite">
        <span class="progress-dot" aria-hidden="true"></span>
        <span>{currentProgress}</span>
      </div>
    {:else if task}
      <div class="progress-line done" role="status" aria-live="polite">
        <span class="progress-dot" aria-hidden="true"></span>
        <span>{currentProgress}</span>
      </div>
    {/if}

    {#if currentError}
      <div class="error-box">
        <div class="error-head">
          <span>AI auto adjustment failed</span>
          <button
            class="copy-error"
            type="button"
            aria-label="Copy error"
            use:tooltip={{ text: copied ? 'Copied' : 'Copy error', placement: 'left' }}
            onclick={copyError}
          >
            <Icon svg={Copy} size={15} />
          </button>
        </div>
        <pre>{currentError}</pre>
      </div>
    {/if}

    <div class="dlg-actions">
      {#if !task}
        <AiRunOptionsControl bind:options={runOptions} disabled={busy} />
      {/if}
      <span class="dlg-action-spacer"></span>
      <button type="button" onclick={onClose}>{task ? 'Close' : 'Cancel'}</button>
      {#if task && aiTasks.canRetry(task)}
        <button type="button" class="dlg-primary" onclick={() => aiTasks.retry(task.id)}>Retry</button>
      {/if}
      {#if !task}
        <button type="button" class="dlg-primary" onclick={run} disabled={busy || !desktop || !doc}>
          {busy ? 'Running...' : 'Adjust'}
        </button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .auto-adjust {
    font-size: 12px;
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .summary span,
  .hint {
    color: var(--text-dim);
  }
  .hint,
  .warn {
    margin: 0;
    line-height: 1.45;
  }
  .warn {
    color: #ffd28a;
  }
  textarea {
    resize: vertical;
  }
  figure {
    margin: 0;
    max-width: 220px;
  }
  figure img {
    width: 100%;
    background: #2d2d2d;
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  figcaption {
    margin-top: 4px;
    color: var(--text-dim);
  }
  .progress-line {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text);
  }
  .progress-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 4px rgba(74, 144, 226, 0.18);
  }
  .progress-line.done .progress-dot {
    background: #58c488;
    box-shadow: none;
  }
  .error-box {
    border: 1px solid rgba(255, 96, 96, 0.45);
    background: rgba(80, 24, 24, 0.45);
    border-radius: 5px;
    overflow: hidden;
  }
  .error-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 9px;
    color: #ffd1d1;
  }
  .error-box pre {
    margin: 0;
    padding: 9px;
    white-space: pre-wrap;
    user-select: text;
    color: #ffe5e5;
    border-top: 1px solid rgba(255, 96, 96, 0.25);
  }
  .copy-error {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
  }
  .dlg-actions {
    align-items: center;
  }
  .dlg-action-spacer {
    flex: 1;
  }
</style>
