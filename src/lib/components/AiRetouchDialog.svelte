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
  import { aiRunOptionsFromSettings } from '../state/settings';
  import {
    codexConfigFromRunOptions,
    antigravityConfigFromRunOptions,
    generateCodexRetouchImage,
    generateAntigravityRetouchImage,
    isDesktop,
    writeProjectDocumentPath,
  } from '../integrations/desktop';
  import { Copy } from '../icons';

  let { onClose, taskId = null }: { onClose: () => void; taskId?: string | null } = $props();

  type CodexProgressPayload = { runId: string; message: string };

  const desktop = isDesktop();
  let runOptions = $state(aiRunOptionsFromSettings(settings.value));
  let prompt = $state(editor.pendingAiRetouch?.prompt ?? '');
  let busy = $state(false);
  let error = $state('');
  let copied = $state(false);
  let progress = $state('');
  let stopProgress: UnlistenFn | null = null;
  let runningTaskId: string | null = null;

  const task = $derived(aiTasks.find(taskId));
  const taskDetail = $derived(task?.detail.kind === 'retouch' ? task.detail : null);
  const currentError = $derived(task?.error ?? error);
  const currentProgress = $derived(task?.progress ?? progress);
  const currentBusy = $derived(task?.status === 'running' || busy);
  const request = $derived(editor.pendingAiRetouch);
  const sourcePreview = $derived(taskDetail?.sourcePreview ?? request?.source.toDataURL('image/png') ?? '');
  const maskPreview = $derived(taskDetail?.maskPreview ?? request?.mask.toDataURL('image/png') ?? '');
  const referencePreview = $derived(taskDetail?.referencePreview ?? request?.reference?.toDataURL('image/png') ?? '');

  function createRunId(): string {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `retouch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function textBytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  function promptWithAnnotationNotes(requestPrompt: string, annotationNotes: string[] | undefined): string {
    const notes = annotationNotes?.map((note) => note.trim()).filter(Boolean) ?? [];
    if (!notes.length) return requestPrompt;
    return `${requestPrompt}

Visible PaintNode annotations:
${notes.join('\n')}

Use these annotations as direct user instructions for the regions they point to.`;
  }

  function providerRunDir(): string {
    if (runOptions.provider === 'antigravity') return 'antigravity-runs';
    if (runOptions.provider === 'custom') return 'custom-runs';
    return 'codex-runs';
  }

  function providerLabel(): string {
    return runOptions.provider === 'antigravity' ? 'Local Antigravity CLI' : 'Local Codex CLI';
  }

  function focusTaskDocument(documentId: string | null): void {
    if (!documentId || editor.activeDocumentId === documentId) return;
    if (!editor.documents.some((session) => session.id === documentId)) {
      throw new Error('The document this task was started in has been closed.');
    }
    editor.switchDocument(documentId);
  }

  function clearProgressListener() {
    stopProgress?.();
    stopProgress = null;
  }

  onDestroy(() => {
    if (!runningTaskId) clearProgressListener();
  });

  function close(): void {
    if (!task) editor.dismissAiRetouch();
    onClose();
  }

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

  async function saveDebugInputs(
    bytes: NonNullable<Awaited<ReturnType<typeof editor.prepareAiRetouchInput>>>,
    requestPrompt: string,
    activeRequest: NonNullable<typeof request>,
    projectPath: string | null,
  ): Promise<string | null> {
    if (!settings.value.workspace.keepAiRunInputs || !projectPath) return null;
    const dir = `paintnode/${providerRunDir()}/retouch-inputs-${Date.now()}`;
    await writeProjectDocumentPath({ projectPath, path: `${dir}/source.png`, bytes: bytes.sourcePng });
    await writeProjectDocumentPath({ projectPath, path: `${dir}/edit_target.png`, bytes: bytes.editTargetPng });
    await writeProjectDocumentPath({ projectPath, path: `${dir}/mask.png`, bytes: bytes.maskPng });
    if (bytes.annotatedSourcePng) {
      await writeProjectDocumentPath({ projectPath, path: `${dir}/annotated_source.png`, bytes: bytes.annotatedSourcePng });
    }
    if (bytes.referencePng) {
      await writeProjectDocumentPath({ projectPath, path: `${dir}/reference.png`, bytes: bytes.referencePng });
    }
    await writeProjectDocumentPath({
      projectPath,
      path: `${dir}/prompt.txt`,
      bytes: textBytes(`${activeRequest.toolName}\n\n${promptWithAnnotationNotes(requestPrompt, bytes.annotationNotes)}`),
    });
    return dir;
  }

  async function run() {
    error = '';
    copied = false;
    const active = request;
    if (!active) {
      error = 'No AI retouch request is pending.';
      return;
    }
    if (!desktop) {
      error = 'AI Retouch is available only in the desktop app.';
      return;
    }
    if (!prompt.trim()) {
      error = 'Enter a retouch prompt.';
      return;
    }
    if (runOptions.provider === 'custom') {
      error = 'AI Retouch is currently available with Local Codex or Antigravity CLI.';
      return;
    }
    busy = true;
    const targetDocumentId = editor.activeDocumentId;
    const taskProjectPath = project.path;
    const task = aiTasks.create({
      kind: 'retouch',
      title: 'AI Retouch',
      subtitle: `${active.toolName} · ${providerLabel()}`,
      progress: 'Preparing AI retouch inputs...',
      detail: {
        kind: 'retouch',
        providerLabel: providerLabel(),
        prompt: prompt.trim(),
        toolName: active.toolName,
        gestureKind: active.gesture.kind,
        sourcePreview,
        maskPreview,
        referencePreview,
      },
    });
    runningTaskId = task.id;
    editor.dismissAiRetouch();
    onClose();
    const executeTask = async () => {
      let debugDir: string | null = null;
      const maskLayer =
        editor.documents
          .flatMap((session) => session.doc.layers)
          .find((layer) => layer.id === active.maskLayerId && layer.kind === 'ai-retouch-mask') ?? null;
      // Captured per invocation so a retry restores the lock state the user
      // had at that point, not the one from the original run.
      const previousMaskLock = maskLayer ? maskLayer.userLocked : null;
      if (maskLayer) maskLayer.userLocked = true;
      progress = 'Preparing AI retouch inputs...';
      aiTasks.setProgress(task.id, progress);
      editor.flash('Preparing AI retouch...');
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
        const bytes = await editor.prepareAiRetouchInput(active);
        if (!bytes) throw new Error('Unable to prepare AI retouch input.');
        debugDir = await saveDebugInputs(bytes, prompt.trim(), active, taskProjectPath);
        if (debugDir) {
          progress = `Saved retouch inputs: ${debugDir}`;
          aiTasks.setProgress(task.id, progress);
        }
        const retouchPrompt = promptWithAnnotationNotes(prompt.trim(), bytes.annotationNotes);
        const generated =
          runOptions.provider === 'antigravity'
            ? await generateAntigravityRetouchImage(
                antigravityConfigFromRunOptions(runOptions, taskProjectPath, runId),
                bytes.sourcePng,
                bytes.editTargetPng,
                bytes.maskPng,
                bytes.annotatedSourcePng,
                bytes.referencePng,
                retouchPrompt,
              )
            : await generateCodexRetouchImage(
                codexConfigFromRunOptions(runOptions, taskProjectPath, runId),
                bytes.sourcePng,
                bytes.editTargetPng,
                bytes.maskPng,
                bytes.annotatedSourcePng,
                bytes.referencePng,
                retouchPrompt,
              );
        const savedAssetCount = generated.assets?.length ?? (generated.asset ? 1 : 0);
        if (generated.asset || savedAssetCount > 0) await project.refresh(taskProjectPath);
        const blob = await (await fetch(generated.dataUrl)).blob();
        const bmp = await createImageBitmap(blob);
        const maskBmp = generated.maskDataUrl
          ? await createImageBitmap(await (await fetch(generated.maskDataUrl)).blob())
          : null;
        focusTaskDocument(targetDocumentId);
        const insertedLayerId = editor.insertAiRetouchResult(active, bmp, bmp.width, bmp.height, {
          assetId: generated.asset?.id ?? null,
          path: generated.asset?.relativePath ?? null,
        }, maskBmp, maskBmp?.width ?? 0, maskBmp?.height ?? 0);
        maskBmp?.close();
        bmp.close();
        if (!insertedLayerId) throw new Error('Unable to place the AI retouch result in the document.');
        editor.flash(
          savedAssetCount > 0
            ? `AI retouch added; ${savedAssetCount} generated asset${savedAssetCount === 1 ? '' : 's'} saved`
            : 'AI retouch added',
        );
        aiTasks.complete(task.id, 'AI retouch added');
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        error = debugDir ? `${message}\n\nRetouch input files were saved at:\n${debugDir}` : message;
        aiTasks.fail(task.id, error);
        editor.flash('AI retouch failed');
      } finally {
        const currentMaskLayer = editor.documents
          .flatMap((session) => session.doc.layers)
          .find((layer) => layer.id === active.maskLayerId && layer.kind === 'ai-retouch-mask');
        if (currentMaskLayer && previousMaskLock !== null) currentMaskLayer.userLocked = previousMaskLock;
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

<Modal title="AI Retouch" onClose={close} width={560}>
  <div class="dlg-form">
    {#if !desktop}
      <p class="warn">
        This runs local Codex and only works in the desktop app. The captured retouch request is kept
        here so you can review it, but Run is disabled in the browser.
      </p>
    {/if}

    {#if taskDetail}
      <div class="summary">
        <strong>{taskDetail.toolName}</strong>
        <span>{taskDetail.gestureKind} · {taskDetail.providerLabel}</span>
      </div>
    {:else if request}
      <div class="summary">
        <strong>{request.toolName}</strong>
        <span>{request.gesture.kind}</span>
      </div>

      <div class="previews">
        <figure>
          <img src={sourcePreview} alt="" />
          <figcaption>Source</figcaption>
        </figure>
        <figure>
          <img src={maskPreview} alt="" />
          <figcaption>Mask</figcaption>
        </figure>
        {#if referencePreview}
          <figure>
            <img src={referencePreview} alt="" />
            <figcaption>Reference</figcaption>
          </figure>
        {/if}
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
      <span>Retouch prompt</span>
      {#if taskDetail}
        <textarea value={taskDetail.prompt} rows="5" readonly></textarea>
      {:else}
        <textarea bind:value={prompt} rows="5" spellcheck="true"></textarea>
      {/if}
    </label>

    <p class="hint">
      PaintNode sends the full canvas, the current photo edit target, the selected AI mask, and any
      sampled reference to the selected local AI provider. The generated pixels are inserted as a new layer and the mask remains reusable.
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

    {#if currentError}
      <div class="error-box">
        <div class="error-head">
          <span>AI retouch failed</span>
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
      <button onclick={close}>{task ? 'Close' : 'Cancel'}</button>
      {#if task?.status === 'error' && task.retry}
        <button class="dlg-primary" onclick={() => aiTasks.retry(task.id)}>Retry</button>
      {/if}
      {#if !task}
        <button class="dlg-primary" onclick={run} disabled={busy || !desktop || !request}>
          {busy ? 'Running...' : 'Run'}
        </button>
      {/if}
    </div>
  </div>
</Modal>

<style>
  .dlg-form {
    display: grid;
    gap: 12px;
    font-size: 12px;
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
  .previews {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  figure {
    margin: 0;
    min-width: 0;
  }
  figure img {
    width: 100%;
    aspect-ratio: 1.45;
    object-fit: contain;
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
  input,
  textarea {
    width: 100%;
    box-sizing: border-box;
  }
  textarea {
    resize: vertical;
    min-height: 92px;
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
    justify-content: flex-end;
    gap: 8px;
  }
  .dlg-action-spacer {
    flex: 1;
  }
</style>
