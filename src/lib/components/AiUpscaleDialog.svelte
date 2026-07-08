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
  import {
    codexConfigFromRunOptions,
    antigravityConfigFromRunOptions,
    upscaleCodexImage,
    upscaleAntigravityImage,
    isDesktop,
  } from '../integrations/desktop';
  import { Copy } from '../icons';

  let { onClose, taskId = null }: { onClose: () => void; taskId?: string | null } = $props();

  const desktop = isDesktop();
  let runOptions = $state(aiRunOptionsFromSettings(settings.value));
  let scalePercent = $state(200);
  let busy = $state(false);
  let error = $state('');
  let copied = $state(false);
  const progressListener = new AiProgressListener();
  let runningTaskId: string | null = null;

  const task = $derived(aiTasks.find(taskId));
  const taskDetail = $derived(task?.detail.kind === 'upscale' ? task.detail : null);
  const currentError = $derived(task?.error ?? error);
  const currentProgress = $derived(task?.progress ?? '');
  const currentBusy = $derived(task?.status === 'running' || busy);
  const doc = $derived(editor.doc);
  const clampedScale = $derived(Math.min(1000, Math.max(100, Math.round(scalePercent || 100))));
  const outputSize = $derived(
    doc
      ? {
          width: Math.round((doc.width * clampedScale) / 100),
          height: Math.round((doc.height * clampedScale) / 100),
        }
      : null,
  );

  onDestroy(() => {
    if (!runningTaskId) progressListener.clear();
  });

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
        else reject(new Error('Unable to encode the document for AI upscale.'));
      }, 'image/png');
    });
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function run() {
    error = '';
    copied = false;
    const activeDoc = editor.doc;
    if (!activeDoc) {
      error = 'Open a document to upscale.';
      return;
    }
    if (!desktop) {
      error = 'AI Upscale is available only in the desktop app.';
      return;
    }
    if (runOptions.provider === 'custom') {
      error = 'AI Upscale is currently available with Local Codex or Antigravity account.';
      return;
    }
    const scale = clampedScale;
    busy = true;
    const taskProjectPath = project.path;
    const docName = activeDoc.name || 'Untitled';
    const source = compositeToCanvas(activeDoc);
    const runId = createRunId('upscale');
    const task = aiTasks.create({
      kind: 'upscale',
      runId,
      title: 'AI Upscale',
      subtitle: `${scale}% · ${providerLabel(runOptions.provider)}`,
      progress: 'Preparing AI upscale input...',
      detail: {
        kind: 'upscale',
        providerLabel: providerLabel(runOptions.provider),
        scalePercent: scale,
        sourceName: docName,
        sourcePreview: canvasPreviewDataUrl(source),
      },
    });
    runningTaskId = task.id;
    onClose();
    const executeTask = async () => {
      aiTasks.setProgress(task.id, 'Preparing AI upscale input...');
      editor.flash('Preparing AI upscale...');
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
        const generated =
          runOptions.provider === 'antigravity'
            ? await upscaleAntigravityImage(
                antigravityConfigFromRunOptions(runOptions, taskProjectPath, runId, keepJobDir),
                sourcePng,
                scale,
              )
            : await upscaleCodexImage(
                codexConfigFromRunOptions(runOptions, taskProjectPath, runId, keepJobDir),
                sourcePng,
                scale,
              );
        if (generated.asset) await project.refresh(taskProjectPath);
        const blob = await (await fetch(generated.dataUrl)).blob();
        const bmp = await createImageBitmap(blob);
        const upscaledDoc = new PaintDocument(bmp.width, bmp.height, `${docName} ${scale}%`);
        const layer = new Layer(bmp.width, bmp.height, 'Layer 1');
        layer.sourceAssetId = generated.asset?.id ?? null;
        layer.sourcePath = generated.asset?.relativePath ?? null;
        layer.ctx.drawImage(bmp, 0, 0);
        layer.touch();
        bmp.close();
        upscaledDoc.layers = [layer];
        upscaledDoc.activeLayerId = layer.id;
        editor.openDocument(upscaledDoc);
        editor.flash('AI upscale added as a new document');
        aiTasks.complete(task.id, 'AI upscale completed');
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        error = message;
        aiTasks.fail(task.id, message);
        editor.flash('AI upscale failed');
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

<Modal title="AI Upscale" onClose={onClose} width={480} height={520} minWidth={460} minHeight={420} resizable>
  <div class="dlg-form">
    <div class="dlg-scroll">
    {#if !desktop}
      <p class="warn">AI Upscale runs a local AI provider and only works in the desktop app.</p>
    {/if}

    {#if taskDetail}
      <div class="summary">
        <strong>{taskDetail.sourceName}</strong>
        <span>{taskDetail.scalePercent}% · {taskDetail.providerLabel}</span>
      </div>
      {#if taskDetail.sourcePreview}
        <figure>
          <img src={taskDetail.sourcePreview} alt="" />
          <figcaption>Source</figcaption>
        </figure>
      {/if}
    {:else}
      <label class="dlg-field">
        <span>Scale</span>
        <div class="preset-row" aria-label="Scale presets">
          {#each [100, 200, 400] as preset (preset)}
            <button
              type="button"
              class:active={clampedScale === preset}
              disabled={currentBusy}
              onclick={() => (scalePercent = preset)}
            >
              {preset / 100}x
            </button>
          {/each}
        </div>
        <div class="scale-row">
          <input
            type="number"
            min="100"
            max="1000"
            step="25"
            bind:value={scalePercent}
            disabled={currentBusy}
          />
          <span class="unit">%</span>
          {#if outputSize}
            <span class="output-size">{outputSize.width} × {outputSize.height} px</span>
          {/if}
        </div>
      </label>

      <p class="hint">
        PaintNode enlarges the flattened document, splits it into parts the provider can regenerate
        at native detail, and asks the AI to restore crisp detail part by part. 100% keeps the size
        and only re-renders detail. The result opens as a new document. Large scales run one AI job
        per part and can take several minutes.
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
          <span>AI upscale failed</span>
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
    </div>

    <div class="dlg-actions">
      {#if !task}
        <AiRunOptionsControl bind:options={runOptions} disabled={busy} />
      {/if}
      <span class="dlg-action-spacer"></span>
      <button onclick={onClose}>{task ? 'Close' : 'Cancel'}</button>
      {#if task && aiTasks.canRetry(task)}
        <button class="dlg-primary" onclick={() => aiTasks.retry(task.id)}>Retry</button>
      {/if}
      {#if !task}
        <button class="dlg-primary" onclick={run} disabled={busy || !desktop || !doc}>
          {busy ? 'Running...' : 'Upscale'}
        </button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .dlg-form {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    font-size: 12px;
  }
  .dlg-scroll {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow: auto;
    padding-right: 2px;
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text);
  }
  .summary span {
    color: var(--text-dim);
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
  .dlg-field {
    display: grid;
    gap: 5px;
    color: var(--text-dim);
  }
  .scale-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .preset-row {
    display: flex;
    gap: 6px;
  }
  .preset-row button {
    min-width: 42px;
  }
  .preset-row button.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .scale-row input {
    width: 90px;
  }
  .unit {
    color: var(--text-dim);
  }
  .output-size {
    margin-left: auto;
    color: var(--text-dim);
  }
  .hint,
  .warn {
    margin: 0;
    color: var(--text-dim);
    line-height: 1.45;
  }
  .warn {
    color: #ffd28a;
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
  .copy-error {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
  }
  pre {
    margin: 0;
    padding: 0 9px 9px;
    max-height: 150px;
    overflow: auto;
    white-space: pre-wrap;
    color: #ffe0e0;
  }
  .dlg-actions {
    display: flex;
    flex: 0 0 auto;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 12px;
    margin-top: 12px;
    border-top: 1px solid var(--border);
  }
  .dlg-action-spacer {
    flex: 1;
  }
</style>
