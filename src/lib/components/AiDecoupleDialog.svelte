<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import AiRunOptionsControl from './AiRunOptionsControl.svelte';
  import { tooltip } from '../actions/tooltip';
  import { applyAlphaMask, chromaKeyToAlpha, connectedMatteToAlpha, parseHexColor } from '../engine/decouple/chroma';
  import { aiTasks } from '../state/aiTasks.svelte';
  import { editor, type DecoupledLayerImport } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { settings } from '../state/settings.svelte';
  import { aiRunOptionsFromSettings } from '../state/settings';
  import { workflow } from '../state/workflow.svelte';
  import {
    codexConfigFromRunOptions,
    decoupleCodexImage,
    decoupleAntigravityImage,
    antigravityConfigFromRunOptions,
    isDesktop,
    type DecoupledLayerResult,
    type ProjectAsset,
  } from '../integrations/desktop';
  import { Copy } from '../icons';

  let { onClose, taskId = null }: { onClose: () => void; taskId?: string | null } = $props();

  type CodexProgressPayload = { runId: string; message: string };

  const desktop = isDesktop();
  const DEFAULT_PROMPT =
    'Extract clean standalone storyboard assets for a later AI composition workflow. Regenerate hidden or occluded parts when useful, avoid duplicate props across assets, and prefer transparent PNGs or alpha masks over keyed backgrounds.';

  let runOptions = $state(aiRunOptionsFromSettings(settings.value));
  let prompt = $state(DEFAULT_PROMPT);
  let addToWorkflow = $state(true);
  let placeOnCanvas = $state(false);
  let tolerance = $state(30);
  let busy = $state(false);
  let error = $state('');
  let copied = $state(false);
  let progress = $state('');
  let notes = $state('');
  let stopProgress: UnlistenFn | null = null;
  let runningTaskId: string | null = null;
  const task = $derived(aiTasks.find(taskId));
  const taskDetail = $derived(task?.detail.kind === 'decouple' ? task.detail : null);
  const currentError = $derived(task?.error ?? error);
  const currentProgress = $derived(task?.progress ?? progress);
  const currentBusy = $derived(task?.status === 'running' || busy);
  const currentNotes = $derived(taskDetail?.notes ?? notes);

  $effect(() => {
    if (!project.path && addToWorkflow) addToWorkflow = false;
  });

  function createRunId(): string {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `decouple-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function clearProgressListener() {
    stopProgress?.();
    stopProgress = null;
  }

  onDestroy(() => {
    if (!runningTaskId) clearProgressListener();
  });

  async function copyError() {
    if (!currentError) return;
    try {
      await navigator.clipboard.writeText(currentError);
    } catch {
      const area = document.createElement('textarea');
      area.value = currentError;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    copied = true;
    window.setTimeout(() => (copied = false), 1200);
  }

  async function canvasPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
    return new Uint8Array(await (await canvasToPngBlob(canvas)).arrayBuffer());
  }

  async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((next) => (next ? resolve(next) : reject(new Error('Could not encode asset PNG.'))), 'image/png');
    });
    return blob;
  }

  function providerLabel(): string {
    return runOptions.provider === 'antigravity' ? 'Local Antigravity CLI' : 'Local Codex CLI';
  }

  function focusTaskDocument(documentId: string | null): void {
    if (!documentId || editor.activeDocumentId === documentId) return;
    if (editor.documents.some((session) => session.id === documentId)) {
      editor.switchDocument(documentId);
    }
  }

  async function layerToImport(layer: DecoupledLayerResult): Promise<DecoupledLayerImport> {
    const blob = await (await fetch(layer.dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Unable to prepare extracted asset.');
    ctx.drawImage(bmp, 0, 0);
    bmp.close();

    if (layer.alphaMaskDataUrl) {
      const maskBlob = await (await fetch(layer.alphaMaskDataUrl)).blob();
      const maskBmp = await createImageBitmap(maskBlob);
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = canvas.width;
      maskCanvas.height = canvas.height;
      const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
      if (!maskCtx) throw new Error(`Unable to prepare alpha mask for "${layer.name}".`);
      maskCtx.drawImage(maskBmp, 0, 0, canvas.width, canvas.height);
      maskBmp.close();

      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const mask = maskCtx.getImageData(0, 0, canvas.width, canvas.height);
      applyAlphaMask(img.data, mask.data);
      ctx.putImageData(img, 0, 0);
    }

    const key = layer.keyColor ? parseHexColor(layer.keyColor) : null;
    if (layer.keyColor && !key) {
      throw new Error(`Asset "${layer.name}" returned invalid keyColor "${layer.keyColor}".`);
    }
    if (key) {
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      connectedMatteToAlpha(img.data, {
        key,
        width: canvas.width,
        height: canvas.height,
        tolerance,
        softness: Math.max(12, tolerance * 1.2),
        floodTolerance: Math.min(260, tolerance + Math.max(24, tolerance * 3.2)),
        despill: 0.35,
      });
      chromaKeyToAlpha(img.data, {
        key,
        tolerance: Math.max(8, tolerance * 0.55),
        softness: Math.max(4, tolerance * 0.25),
        despill: 0.35,
      });
      ctx.putImageData(img, 0, 0);
    }

    return {
      name: layer.name,
      source: canvas,
      width: canvas.width,
      height: canvas.height,
      x: layer.x,
      y: layer.y,
      opacity: layer.opacity,
      visible: layer.visible,
      sourceMeta: {},
    };
  }

  async function run() {
    error = '';
    copied = false;
    notes = '';
    const sourceLayer = editor.activeLayer;
    if (!desktop) {
      error = 'Available only in the desktop app.';
      return;
    }
    if (!sourceLayer) {
      error = 'Select a source layer to extract assets from.';
      return;
    }
    if (!project.path && !placeOnCanvas) {
      error = 'Open a project folder, or enable placing extracted assets on the canvas.';
      return;
    }
    if (runOptions.provider === 'custom') {
      error = 'Asset extraction is currently available with Local Codex or Antigravity CLI.';
      return;
    }

    busy = true;
    const targetDocumentId = editor.activeDocumentId;
    const taskProjectPath = project.path;
    const task = aiTasks.create({
      kind: 'decouple',
      title: 'Extract Assets',
      subtitle: `${sourceLayer.name} · ${providerLabel()}`,
      progress: 'Preparing source layer...',
      detail: {
        kind: 'decouple',
        providerLabel: providerLabel(),
        prompt: prompt.trim() || DEFAULT_PROMPT,
        sourceLayerName: sourceLayer.name,
        addToWorkflow,
        placeOnCanvas,
        tolerance,
        notes: '',
      },
    });
    runningTaskId = task.id;
    onClose();
    const executeTask = async () => {
      progress = 'Preparing source layer...';
      aiTasks.setProgress(task.id, progress);
      editor.flash(runOptions.provider === 'antigravity' ? 'Extracting assets with Antigravity...' : 'Extracting assets with Codex...');
      clearProgressListener();
      let progressListenerStale = false;
      const runId = createRunId();
      void listen<CodexProgressPayload>('codex-generation-progress', (event) => {
        if (event.payload.runId === runId && event.payload.message.trim()) {
          progress = event.payload.message.trim();
          aiTasks.setProgress(task.id, progress);
        }
      })
        .then((unlisten) => {
          // The run may have finished before listen() resolved; unlisten
          // immediately instead of leaking the registration.
          if (progressListenerStale) {
            unlisten();
            return;
          }
          stopProgress = unlisten;
        })
        .catch(() => {
          progress = runOptions.provider === 'antigravity' ? 'Local Antigravity is running...' : 'Local Codex is running...';
          aiTasks.setProgress(task.id, progress);
        });

      try {
        const sourcePng = await canvasPngBytes(sourceLayer.canvas);
        const result =
          runOptions.provider === 'antigravity'
            ? await decoupleAntigravityImage(
                antigravityConfigFromRunOptions(runOptions, taskProjectPath, runId),
                sourcePng,
                prompt.trim() || DEFAULT_PROMPT,
                false,
              )
            : await decoupleCodexImage(
                codexConfigFromRunOptions(runOptions, taskProjectPath, runId),
                sourcePng,
                prompt.trim() || DEFAULT_PROMPT,
                false,
              );
        progress = 'Cleaning and saving extracted assets...';
        aiTasks.setProgress(task.id, progress);
        const imports = await Promise.all(result.layers.map((layer) => layerToImport(layer)));
        const extractedAssets: ProjectAsset[] = [];
        for (const item of imports) {
          const blob = await canvasToPngBlob(item.source as HTMLCanvasElement);
          const asset = await project.storeGeneratedBlobAt(
            taskProjectPath,
            blob,
            `${item.name || 'Extracted asset'}.png`,
            `Extracted asset from ${sourceLayer.name}`,
            item.width,
            item.height,
          );
          item.sourceMeta = {
            assetId: asset?.id ?? null,
            path: asset?.relativePath ?? null,
          };
          if (asset) extractedAssets.push(asset);
        }
        const addedToWorkflow = addToWorkflow && extractedAssets.length > 0;
        if (addedToWorkflow) {
          if (!workflow.active) workflow.newBoard(`${sourceLayer.name} Assets`);
          for (const asset of extractedAssets) workflow.addAsset(asset);
          if (!workflow.prompt.trim()) {
            workflow.setPrompt('Use these extracted assets as visual references to compose a new image.');
          }
          workflow.show();
        }
        focusTaskDocument(targetDocumentId);
        const inserted = placeOnCanvas
          ? editor.insertDecoupledLayers(sourceLayer.id, imports, { hideSource: false })
          : 0;
        notes = result.notes ?? '';
        aiTasks.setDecoupleNotes(task.id, notes);
        editor.flash(
          placeOnCanvas
            ? `Extracted ${imports.length} assets and placed ${inserted} layers`
            : addedToWorkflow
              ? `Extracted ${imports.length} assets to workflow`
              : `Extracted ${imports.length} assets`,
        );
        aiTasks.complete(task.id, `Extracted ${imports.length} assets`);
      } catch (e) {
        error = (e as Error)?.message ?? String(e);
        aiTasks.fail(task.id, error);
        editor.flash('Asset extraction failed');
      } finally {
        busy = false;
        progress = '';
        progressListenerStale = true;
        clearProgressListener();
        runningTaskId = null;
      }
    };
    aiTasks.setRetry(task.id, executeTask);
    window.setTimeout(() => void executeTask(), 0);
  }
</script>

<Modal title="Extract Assets (AI)" {onClose} width={500}>
  <div class="dlg-form">
    {#if !desktop}
      <p class="warn">
        This runs local Codex and only works in the desktop app. Launch it with
        <code>npm run tauri:dev</code>.
      </p>
    {/if}

    {#if taskDetail}
      <div class="task-summary">
        <strong>{taskDetail.sourceLayerName}</strong>
        <span>{taskDetail.providerLabel}</span>
      </div>
    {/if}

    {#if !taskDetail && runOptions.provider === 'codex'}
      <label class="dlg-field">
        <span>Codex command (optional)</span>
        <input type="text" bind:value={runOptions.codexBin} placeholder="codex, /opt/homebrew/bin/codex, or /usr/local/bin/codex" spellcheck="false" />
      </label>
    {:else if !taskDetail && runOptions.provider === 'antigravity'}
      <label class="dlg-field">
        <span>Antigravity command (optional)</span>
        <input type="text" bind:value={runOptions.antigravityBin} placeholder="agy, ~/.local/bin/agy, /opt/homebrew/bin/agy, or /usr/local/bin/agy" spellcheck="false" />
      </label>
    {/if}

    <label class="dlg-field">
      <span>Asset guidance</span>
      {#if taskDetail}
        <textarea value={taskDetail.prompt} rows="4" readonly></textarea>
      {:else}
        <textarea bind:value={prompt} rows="4" spellcheck="true"></textarea>
      {/if}
    </label>

    <div class="split-row">
      <div class="check-stack">
        <label class="check-row">
          <input type="checkbox" checked={taskDetail ? taskDetail.addToWorkflow : addToWorkflow} disabled={!!taskDetail || !project.path} onchange={(event) => (addToWorkflow = event.currentTarget.checked)} />
          <span>Add assets to workflow board</span>
        </label>
        <label class="check-row">
          <input type="checkbox" checked={taskDetail ? taskDetail.placeOnCanvas : placeOnCanvas} disabled={!!taskDetail} onchange={(event) => (placeOnCanvas = event.currentTarget.checked)} />
          <span>Place extracted assets on canvas</span>
        </label>
      </div>
      <label class="compact-field">
        <span>Key tolerance</span>
        <input
          type="number"
          min="0"
          max="120"
          step="1"
          value={taskDetail ? taskDetail.tolerance : tolerance}
          readonly={!!taskDetail}
          oninput={(event) => {
            const next = event.currentTarget.valueAsNumber;
            if (Number.isFinite(next)) tolerance = Math.min(120, Math.max(0, next));
          }}
        />
      </label>
    </div>

    <p class="hint">
      Codex returns named workflow assets and a manifest. PaintNode saves transparent assets to the
      project, applies alpha masks when provided, and uses color-key cleanup only as a fallback.
    </p>

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

    {#if currentNotes}
      <p class="hint">{currentNotes}</p>
    {/if}

    {#if currentError}
      <div class="error-box">
        <div class="error-head">
          <span>Extraction failed</span>
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
      <button onclick={onClose}>{task ? 'Close' : 'Cancel'}</button>
      {#if task?.status === 'error' && task.retry}
        <button class="dlg-primary" onclick={() => aiTasks.retry(task.id)}>Retry</button>
      {/if}
      {#if !task}
        <button class="dlg-primary" onclick={run} disabled={busy || !desktop || !editor.activeLayer}>
          {busy ? 'Extracting...' : 'Extract'}
        </button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .split-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 132px;
    gap: 12px;
    align-items: end;
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text);
    font-size: 13px;
  }
  .check-stack {
    display: grid;
    gap: 7px;
  }
  .compact-field {
    display: grid;
    gap: 4px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .compact-field input {
    width: 100%;
  }
  .task-summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    padding: 7px 8px;
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
  }
  .task-summary strong,
  .task-summary span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-summary span {
    color: var(--text-dim);
    font-size: 11px;
  }
  .hint {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.4;
  }
  .warn {
    margin: 0;
    color: #ffd27a;
    font-size: 12px;
    line-height: 1.4;
  }
  .progress-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
    color: var(--text);
    font-size: 12px;
  }
  .progress-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 20%, transparent);
  }
  .progress-line.done .progress-dot {
    background: #58c488;
    box-shadow: none;
  }
  .error-box {
    border: 1px solid #7a2d2d;
    background: #2a1717;
    border-radius: 4px;
    overflow: hidden;
  }
  .error-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid #7a2d2d;
    color: #ffb0b0;
    font-size: 12px;
    font-weight: 700;
  }
  .copy-error {
    display: grid;
    place-items: center;
    width: 24px;
    height: 22px;
    padding: 0;
  }
  pre {
    max-height: 180px;
    margin: 0;
    padding: 8px;
    overflow: auto;
    white-space: pre-wrap;
    color: #ffd6d6;
    font-size: 11px;
  }
  .dlg-action-spacer {
    flex: 1;
  }
</style>
