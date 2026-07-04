<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import AiRunOptionsControl from './AiRunOptionsControl.svelte';
  import { tooltip } from '../actions/tooltip';
  import { aiTasks } from '../state/aiTasks.svelte';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { settings } from '../state/settings.svelte';
  import { DEFAULT_CUSTOM_GENERATOR_ARGS, aiRunOptionsFromSettings } from '../state/settings';
  import {
    codexConfigFromRunOptions,
    antigravityConfigFromRunOptions,
    isDesktop,
    generateCodexFillImage,
    generateCodexImage,
    generateAntigravityFillImage,
    generateAntigravityImage,
    generateImage,
    writeProjectDocumentPath,
    type ProjectAsset,
    type TargetDimensions,
  } from '../integrations/desktop';
  import { Copy } from '../icons';

  let { onClose, taskId = null }: { onClose: () => void; taskId?: string | null } = $props();

  type CodexProgressPayload = { runId: string; message: string };

  const desktop = isDesktop();

  let runOptions = $state(aiRunOptionsFromSettings(settings.value));
  let argsText = $state(settings.value.ai.customGenerateArgsText || settings.value.ai.customArgsText || DEFAULT_CUSTOM_GENERATOR_ARGS);
  let prompt = $state('');
  let busy = $state(false);
  let error = $state('');
  let copied = $state(false);
  let progress = $state('');
  let stopProgress: UnlistenFn | null = null;
  let runningTaskId: string | null = null;
  const task = $derived(aiTasks.find(taskId));
  const taskDetail = $derived(task?.detail.kind === 'generate' ? task.detail : null);
  const currentError = $derived(task?.error ?? error);
  const currentProgress = $derived(task?.progress ?? progress);
  const currentBusy = $derived(task?.status === 'running' || busy);

  function createRunId(): string {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `codex-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

  function promptWithCanvasSize(userPrompt: string): string {
    const base = userPrompt.trim();
    const doc = editor.doc;
    if (!doc) return base;
    return `${base}

Final PaintNode canvas target: ${doc.width}x${doc.height} pixels. If the image generator uses fixed aspect-ratio buckets, PaintNode may use a supported working canvas with this target area centered and crop that area after generation. Keep the meaningful composition inside the final PaintNode target area.`;
  }

  function targetDimensions(): TargetDimensions | null {
    const doc = editor.doc;
    if (!doc) return null;
    return { width: doc.width, height: doc.height };
  }

  function defaultFillPrompt(): string {
    return 'Naturally extend the existing image into the masked transparent area, matching the original scene, perspective, lighting, color, grain, and camera style.';
  }

  function textBytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  function providerRunDir(): string {
    if (runOptions.provider === 'antigravity') return 'antigravity-runs';
    if (runOptions.provider === 'custom') return 'custom-runs';
    return 'codex-runs';
  }

  function providerLabel(): string {
    if (runOptions.provider === 'antigravity') return 'Local Antigravity CLI';
    if (runOptions.provider === 'custom') return 'Custom CLI';
    return 'Local Codex CLI';
  }

  function focusTaskDocument(documentId: string | null): void {
    if (!documentId || editor.activeDocumentId === documentId) return;
    if (!editor.documents.some((session) => session.id === documentId)) {
      throw new Error('The document this task was started in has been closed.');
    }
    editor.switchDocument(documentId);
  }

  async function saveFillDebugInputs(
    fillInput: Awaited<ReturnType<typeof editor.prepareGenerativeFillInput>>,
    generationPrompt: string,
    projectPath: string | null,
  ): Promise<string | null> {
    if (!settings.value.workspace.keepAiRunInputs || !fillInput || !projectPath) return null;
    const dir = `paintnode/${providerRunDir()}/fill-inputs-${Date.now()}`;
    await writeProjectDocumentPath({ projectPath, path: `${dir}/source.png`, bytes: fillInput.sourcePng });
    await writeProjectDocumentPath({ projectPath, path: `${dir}/edit_target.png`, bytes: fillInput.editTargetPng });
    await writeProjectDocumentPath({ projectPath, path: `${dir}/mask.png`, bytes: fillInput.maskPng });
    await writeProjectDocumentPath({
      projectPath,
      path: `${dir}/prompt.txt`,
      bytes: textBytes(generationPrompt),
    });
    return dir;
  }

  async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Unable to encode generated fill preview.'));
      }, 'image/png');
    });
  }

  async function run() {
    error = '';
    copied = false;
    if (!desktop) {
      error = 'Available only in the desktop app.';
      return;
    }
    if (runOptions.provider === 'custom' && !runOptions.customBin.trim()) {
      error = 'Enter the generator command.';
      return;
    }
    const hasSelection = !!editor.selection;
    if (!prompt.trim() && !hasSelection) {
      error = 'Enter a prompt.';
      return;
    }
    if (runOptions.provider === 'custom' && hasSelection) {
      error = 'Mask-guided generative fill is currently available with Local Codex or Antigravity CLI.';
      return;
    }
    const userPrompt = prompt.trim();
    busy = true;
    const targetDocumentId = editor.activeDocumentId;
    const taskProjectPath = project.path;
    const task = aiTasks.create({
      kind: 'generate',
      title: hasSelection ? 'Generative Fill' : 'Generate Image',
      subtitle: providerLabel(),
      progress:
        runOptions.provider === 'codex'
          ? 'Preparing Codex request...'
          : runOptions.provider === 'antigravity'
            ? 'Preparing Antigravity request...'
            : 'Running local generator...',
      detail: {
        kind: 'generate',
        providerLabel: providerLabel(),
        prompt: userPrompt || defaultFillPrompt(),
        fillMode: hasSelection,
      },
    });
    runningTaskId = task.id;
    onClose();
    const executeTask = async () => {
      let fillDebugDir: string | null = null;
      progress =
        runOptions.provider === 'codex'
          ? 'Preparing Codex request...'
          : runOptions.provider === 'antigravity'
            ? 'Preparing Antigravity request...'
            : 'Running local generator...';
      aiTasks.setProgress(task.id, progress);
      editor.flash(
        hasSelection
          ? 'Preparing generative fill...'
          : runOptions.provider === 'codex'
            ? 'Generating with Codex...'
            : runOptions.provider === 'antigravity'
              ? 'Generating with Antigravity...'
              : 'Generating image...',
      );
      clearProgressListener();
      let progressListenerStale = false;
      const runId = runOptions.provider === 'codex' || runOptions.provider === 'antigravity' ? createRunId() : '';
      if (runOptions.provider === 'codex' || runOptions.provider === 'antigravity') {
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
      }
      try {
        // On retry another document may be active; the fill input must come
        // from the document the task was started in.
        focusTaskDocument(targetDocumentId);
        const fillInput = hasSelection ? await editor.prepareGenerativeFillInput() : null;
        if (hasSelection && !fillInput) throw new Error('The current selection has no editable pixels.');
        const generationPrompt = fillInput ? userPrompt || defaultFillPrompt() : promptWithCanvasSize(userPrompt);
        const generationTarget = fillInput ? null : targetDimensions();
        fillDebugDir = fillInput ? await saveFillDebugInputs(fillInput, generationPrompt, taskProjectPath) : null;
        if (fillDebugDir) {
          progress = `Saved fill inputs: ${fillDebugDir}`;
          aiTasks.setProgress(task.id, progress);
        }
        if (fillInput) {
          progress = fillDebugDir ? `Starting mask-guided generative fill (${fillDebugDir})...` : 'Starting mask-guided generative fill...';
          aiTasks.setProgress(task.id, progress);
        }
        const generated =
          runOptions.provider === 'codex'
            ? fillInput
              ? await generateCodexFillImage(
                  codexConfigFromRunOptions(runOptions, null, runId),
                  fillInput.sourcePng,
                  fillInput.editTargetPng,
                  fillInput.maskPng,
                  generationPrompt,
                )
              : await generateCodexImage(
                  codexConfigFromRunOptions(runOptions, taskProjectPath, runId),
                  generationPrompt,
                  generationTarget,
                )
            : runOptions.provider === 'antigravity'
              ? fillInput
                ? await generateAntigravityFillImage(
                    antigravityConfigFromRunOptions(runOptions, null, runId),
                    fillInput.sourcePng,
                    fillInput.editTargetPng,
                    fillInput.maskPng,
                    generationPrompt,
                  )
                : await generateAntigravityImage(
                    antigravityConfigFromRunOptions(runOptions, taskProjectPath, runId),
                    generationPrompt,
                    generationTarget,
                  )
              : null;
        if (generated?.asset) await project.refresh(taskProjectPath);
        const dataUrl =
          generated?.dataUrl ??
          (await generateImage(
            {
              bin: runOptions.customBin.trim(),
              args: argsText
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean),
            },
            generationPrompt,
          ));
        const blob = await (await fetch(dataUrl)).blob();
        const bmp = await createImageBitmap(blob);
        let fillAsset: ProjectAsset | null = null;
        if (fillInput && taskProjectPath) {
          const composite = editor.renderGenerativeFillComposite(bmp, bmp.width, bmp.height, fillInput.mask, fillInput.source);
          if (!composite) throw new Error('Unable to prepare the generated fill preview.');
          const compositeBlob = await canvasToBlob(composite);
          fillAsset = await project.storeGeneratedBlobAt(
            taskProjectPath,
            compositeBlob,
            `Generative fill ${generationPrompt.slice(0, 48) || 'outpaint'}.png`,
            generationPrompt,
            composite.width,
            composite.height,
          );
        }
        const customAsset =
          !fillInput && !generated && taskProjectPath
            ? await project.storeGeneratedBlobAt(taskProjectPath, blob, `AI ${userPrompt.slice(0, 48) || 'generated'}.png`, generationPrompt, bmp.width, bmp.height)
            : null;
        const sourceMeta = {
          assetId: fillAsset?.id ?? generated?.asset?.id ?? customAsset?.id ?? null,
          path: fillAsset?.relativePath ?? generated?.asset?.relativePath ?? customAsset?.relativePath ?? null,
        };
        focusTaskDocument(targetDocumentId);
        const oversized = fillInput
          ? false
          : editor.placeImage(bmp, bmp.width, bmp.height, `AI: ${userPrompt.slice(0, 24)}`, sourceMeta).oversized;
        if (fillInput) {
          editor.insertGenerativeFill(bmp, bmp.width, bmp.height, fillInput.mask, `Generative fill: ${generationPrompt.slice(0, 24)}`, sourceMeta);
        }
        bmp.close();
        editor.flash(
          fillInput
            ? 'Generative fill added'
            : oversized
              ? 'Image generated full-size; use Move or Image > Reveal All to show hidden edges'
              : 'Image generated',
        );
        aiTasks.complete(task.id, fillInput ? 'Generative fill added' : 'Image generated');
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        error = fillDebugDir ? `${message}\n\nFill input files were saved at:\n${fillDebugDir}` : message;
        aiTasks.fail(task.id, error);
        editor.flash('Generation failed');
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

<Modal title="Generate Image (AI)" {onClose} width={470}>
  <div class="dlg-form">
    {#if !desktop}
      <p class="warn">
        This runs a <strong>local command</strong> and only works in the desktop app. Launch it
        with <code>npm run tauri:dev</code> (requires Rust). In the browser it stays disabled.
      </p>
    {/if}

    {#if taskDetail}
      <div class="task-summary">
        <strong>{taskDetail.fillMode ? 'Generative Fill' : 'Generate Image'}</strong>
        <span>{taskDetail.providerLabel}</span>
      </div>

      <label class="dlg-field">
        <span>Prompt</span>
        <textarea value={taskDetail.prompt} rows="3" readonly></textarea>
      </label>
    {:else}
      <div class="provider-tabs" role="group" aria-label="Image generator">
        <button class:active={runOptions.provider === 'codex'} onclick={() => (runOptions.provider = 'codex')}>
          Local Codex CLI
        </button>
        <button class:active={runOptions.provider === 'antigravity'} onclick={() => (runOptions.provider = 'antigravity')}>
          Local Antigravity CLI
        </button>
        <button class:active={runOptions.provider === 'custom'} onclick={() => (runOptions.provider = 'custom')}>
          Custom CLI
        </button>
      </div>

      <label class="dlg-field">
        <span>Prompt</span>
        <textarea bind:value={prompt} rows="3" placeholder="a serene mountain lake at sunset"></textarea>
      </label>
    {/if}

    {#if !taskDetail && runOptions.provider === 'codex'}
      <label class="dlg-field">
        <span>Codex command (optional)</span>
        <input type="text" bind:value={runOptions.codexBin} placeholder="codex, /opt/homebrew/bin/codex, or /usr/local/bin/codex" spellcheck="false" />
      </label>

      <p class="hint">
        Uses your local Codex login. If this fails, run <code>codex login</code> in Terminal and try again.
        PaintNode copies the newest generated PNG from Codex's local image cache into the project and adds it as a new layer.
      </p>
    {:else if !taskDetail && runOptions.provider === 'antigravity'}
      <label class="dlg-field">
        <span>Antigravity command (optional)</span>
        <input type="text" bind:value={runOptions.antigravityBin} placeholder="agy, ~/.local/bin/agy, /opt/homebrew/bin/agy, or /usr/local/bin/agy" spellcheck="false" />
      </label>

      <p class="hint">
        Uses your local Antigravity CLI login. If this fails, run <code>agy</code> in Terminal and sign in.
        PaintNode asks Antigravity to write a validated <code>result.png</code> in an isolated job folder.
      </p>
    {:else if !taskDetail}
      <label class="dlg-field">
        <span>Command (local CLI)</span>
        <input type="text" bind:value={runOptions.customBin} placeholder="Full path to your image-gen CLI" spellcheck="false" />
      </label>

      <label class="dlg-field">
        <span>Arguments, one per line; <code>{'{prompt}'}</code> and <code>{'{output}'}</code> are substituted</span>
        <textarea bind:value={argsText} rows="4" spellcheck="false"></textarea>
      </label>

      <p class="hint">
        Your CLI must write a PNG to the <code>{'{output}'}</code> path. The result is added as a new layer.
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
          <span>Generation failed</span>
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
        <button class="dlg-primary" onclick={run} disabled={busy || !desktop}>
          {busy ? 'Generating…' : 'Generate'}
        </button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .provider-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 0;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    overflow: hidden;
  }
  .provider-tabs button {
    border: none;
    border-radius: 0;
    background: var(--bg-input);
    color: var(--text-dim);
    padding: 6px 8px;
  }
  .provider-tabs button + button {
    border-left: 1px solid var(--border-soft);
  }
  .provider-tabs button.active {
    background: var(--accent);
    color: #fff;
  }
  .warn {
    margin: 0;
    padding: 8px 10px;
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.5;
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
  .warn code,
  .dlg-field code,
  .hint code {
    color: var(--text-bright);
    background: var(--bg-input);
    padding: 0 3px;
    border-radius: 3px;
  }
  .hint {
    margin: 0;
    color: var(--text-dim);
    font-size: 11px;
  }
  .progress-line {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-height: 24px;
    padding: 5px 8px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-input));
    color: var(--text);
    font-size: 11px;
    line-height: 1.3;
  }
  .progress-line span:last-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .progress-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--accent);
    animation: progress-pulse 1s ease-in-out infinite;
  }
  .progress-line.done {
    background: var(--bg-input);
  }
  .progress-line.done .progress-dot {
    animation: none;
    background: #58c488;
  }
  @keyframes progress-pulse {
    0%,
    100% {
      opacity: 0.4;
      transform: scale(0.75);
    }
    50% {
      opacity: 1;
      transform: scale(1);
    }
  }
  .error-box {
    border: 1px solid color-mix(in srgb, var(--danger) 55%, var(--border-soft));
    border-radius: 4px;
    background: rgba(224, 83, 61, 0.08);
    overflow: hidden;
  }
  .error-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border-soft));
    color: var(--danger);
    font-size: 11px;
    font-weight: 700;
  }
  .copy-error {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    color: var(--danger);
    background: transparent;
    border: 1px solid transparent;
  }
  .copy-error:hover {
    background: rgba(224, 83, 61, 0.12);
    border-color: color-mix(in srgb, var(--danger) 45%, transparent);
  }
  .error-box pre {
    margin: 0;
    max-height: 180px;
    overflow: auto;
    padding: 8px;
    color: var(--danger);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre-wrap;
    user-select: text;
    -webkit-user-select: text;
  }
  textarea {
    resize: vertical;
    font-family: inherit;
  }
  .dlg-action-spacer {
    flex: 1;
  }
</style>
