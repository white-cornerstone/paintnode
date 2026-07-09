<script lang="ts">
  import { onDestroy } from 'svelte';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import AiRunOptionsControl from './AiRunOptionsControl.svelte';
  import {
    AiProgressListener,
    aiRunningLabel,
    copyTextToClipboard,
    createRunId,
    directorModeFromRunOptions,
    directorProviderFromRunOptions,
    focusTaskDocument,
    imageProviderFromRunOptions,
    providerLabel,
  } from '../ai/taskSupport';
  import { tooltip } from '../actions/tooltip';
  import {
    PAINTNODE_CHROMA_KEY_HEX,
    PAINTNODE_CHROMA_KEY_RGB,
    applyAlphaMask,
    chromaKeyToAlpha,
    connectedMatteToAlpha,
    parseHexColor,
  } from '../engine/decouple/chroma';
  import { aiTasks } from '../state/aiTasks.svelte';
  import { editor, type DecoupledLayerImport } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { settings } from '../state/settings.svelte';
  import { aiRunOptionsFromSettings, type AiProvider } from '../state/settings';
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
  let notes = $state('');
  const progressListener = new AiProgressListener();
  let runningTaskId: string | null = null;
  const task = $derived(aiTasks.find(taskId));
  const taskDetail = $derived(task?.detail.kind === 'decouple' ? task.detail : null);
  const currentError = $derived(task?.error ?? error);
  const currentProgress = $derived(task?.progress ?? '');
  const currentBusy = $derived(task?.status === 'running' || busy);
  const currentNotes = $derived(taskDetail?.notes ?? notes);
  const decoupleProvider = $derived.by((): AiProvider => {
    const directorProvider = directorProviderFromRunOptions(runOptions);
    if (directorModeFromRunOptions(runOptions) === 'skip' || directorProvider === 'claude') {
      return imageProviderFromRunOptions(runOptions);
    }
    return directorProvider;
  });
  const decoupleProviderLabel = $derived(providerLabel(decoupleProvider));

  $effect(() => {
    if (!project.path && addToWorkflow) addToWorkflow = false;
  });

  onDestroy(() => {
    if (!runningTaskId) progressListener.clear();
  });

  async function copyError() {
    if (!currentError) return;
    await copyTextToClipboard(currentError);
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
      const isPaintNodeKey =
        key.r === PAINTNODE_CHROMA_KEY_RGB.r &&
        key.g === PAINTNODE_CHROMA_KEY_RGB.g &&
        key.b === PAINTNODE_CHROMA_KEY_RGB.b;
      if (!isPaintNodeKey) {
        throw new Error(`Asset "${layer.name}" returned keyColor "${layer.keyColor}". PaintNode only accepts ${PAINTNODE_CHROMA_KEY_HEX}.`);
      }
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
    busy = true;
    const targetDocumentId = editor.activeDocumentId;
    const taskProjectPath = project.path;
    const runId = createRunId('decouple');
    const task = aiTasks.create({
      kind: 'decouple',
      runId,
      title: 'Extract Assets',
      subtitle: `${sourceLayer.name} · ${decoupleProviderLabel}`,
      progress: 'Preparing source layer...',
      detail: {
        kind: 'decouple',
        providerLabel: decoupleProviderLabel,
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
      aiTasks.setProgress(task.id, 'Preparing source layer...');
      editor.flash(decoupleProvider === 'antigravity' ? 'Extracting assets with Antigravity...' : 'Extracting assets with Codex...');
      progressListener.start(
        runId,
        (message) => aiTasks.setProgress(task.id, message),
        () =>
          aiTasks.setProgress(
            task.id,
            aiRunningLabel(decoupleProvider),
          ),
      );

      try {
        const sourcePng = await canvasPngBytes(sourceLayer.canvas);
        const result =
          decoupleProvider === 'antigravity'
            ? await decoupleAntigravityImage(
                antigravityConfigFromRunOptions(
                  runOptions,
                  taskProjectPath,
                  runId,
                  false,
                  settings.value.workspace.keepAiDebugArtifacts,
                ),
                sourcePng,
                prompt.trim() || DEFAULT_PROMPT,
                false,
              )
            : await decoupleCodexImage(
                codexConfigFromRunOptions(
                  runOptions,
                  taskProjectPath,
                  runId,
                  false,
                  settings.value.workspace.keepAiDebugArtifacts,
                ),
                sourcePng,
                prompt.trim() || DEFAULT_PROMPT,
                false,
              );
        aiTasks.setProgress(task.id, 'Cleaning and saving extracted assets...');
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
        // Not required: the extracted assets are already saved to the project,
        // so a closed document only skips the optional canvas placement.
        focusTaskDocument(targetDocumentId, false);
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
        progressListener.clear();
        runningTaskId = null;
      }
    };
    aiTasks.setRetry(task.id, executeTask);
    void executeTask();
  }
</script>

<Modal title="Extract Assets (AI)" {onClose} width={500} height={560} minWidth={480} minHeight={420} resizable>
  <div class="dlg-form">
    <div class="dlg-scroll">
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

    <label class="dlg-field prompt-field">
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
      The selected agent returns named workflow assets and a manifest. PaintNode saves transparent
      assets to the project, applies alpha masks when provided, and uses color-key cleanup only as a fallback.
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
    </div>

    <div class="dlg-actions">
      {#if !task}
        <AiRunOptionsControl bind:options={runOptions} disabled={busy} antigravityModelScope="all" />
      {/if}
      <span class="dlg-action-spacer"></span>
      <button onclick={onClose}>{task ? 'Close' : 'Cancel'}</button>
      {#if task && aiTasks.canRetry(task)}
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
  .dlg-form {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
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
  .prompt-field {
    display: flex;
    flex: 1 1 160px;
    flex-direction: column;
    min-height: 120px;
  }
  .prompt-field textarea {
    flex: 1 1 auto;
    min-height: 88px;
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
  .dlg-actions {
    display: flex;
    flex: 0 0 auto;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 12px;
    margin-top: 12px;
    border-top: 1px solid var(--border);
  }
</style>
