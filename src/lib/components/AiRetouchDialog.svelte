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
    focusTaskDocument,
    aiRoleSummary,
    aiRunningLabel,
    imageProviderFromRunOptions,
  } from '../ai/taskSupport';
  import { loadAiReferenceImages, type AiReferenceImage } from '../ai/references';
  import { tooltip } from '../actions/tooltip';
  import { aiTasks } from '../state/aiTasks.svelte';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { settings } from '../state/settings.svelte';
  import { aiRunOptionsFromSettings, type AiEditChecksLevel } from '../state/settings';
  import {
    codexConfigFromRunOptions,
    antigravityConfigFromRunOptions,
    generateCodexRetouchImage,
    generateAntigravityRetouchImage,
    isDesktop,
  } from '../integrations/desktop';
  import { Add, Copy, Dismiss } from '../icons';

  let { onClose, taskId = null }: { onClose: () => void; taskId?: string | null } = $props();

  const desktop = isDesktop();
  let runOptions = $state(aiRunOptionsFromSettings(settings.value));

  const editChecksLevels: { value: AiEditChecksLevel; label: string; hint: string }[] = [
    { value: 0, label: 'Off', hint: 'No result checks — use when the edited areas are meant to differ from their surroundings (e.g. a grid or index sheet)' },
    { value: 1, label: 'In-place', hint: 'Reject candidates that repaint pixels outside the mask (default)' },
    { value: 2, label: '+ Seam', hint: 'Also reject content that does not continue the surrounding scene across the mask boundary' },
    { value: 3, label: 'Strict', hint: 'Strictest seam-continuity checking; retries or fails on any visible content break' },
  ];
  let prompt = $state(editor.pendingAiRetouch?.prompt ?? '');
  let busy = $state(false);
  let error = $state('');
  let copied = $state(false);
  let references = $state<AiReferenceImage[]>([]);
  const progressListener = new AiProgressListener();
  let runningTaskId: string | null = null;

  const task = $derived(aiTasks.find(taskId));
  const taskDetail = $derived(task?.detail.kind === 'retouch' ? task.detail : null);
  const currentError = $derived(task?.error ?? error);
  const currentProgress = $derived(task?.progress ?? '');
  const currentBusy = $derived(task?.status === 'running' || busy);
  const request = $derived(editor.pendingAiRetouch);
  const sourcePreview = $derived(taskDetail?.sourcePreview ?? (request ? canvasPreviewDataUrl(request.source) : ''));
  const maskPreview = $derived(taskDetail?.maskPreview ?? (request ? canvasPreviewDataUrl(request.mask) : ''));
  const annotatedSourcePreview = $derived(taskDetail?.annotatedSourcePreview ?? (request?.annotatedSource ? canvasPreviewDataUrl(request.annotatedSource) : ''));
  const referencePreview = $derived(taskDetail?.referencePreview ?? (request?.reference ? canvasPreviewDataUrl(request.reference) : ''));
  const imageProvider = $derived(imageProviderFromRunOptions(runOptions));
  const roleSummary = $derived(aiRoleSummary(runOptions));

  function promptWithAnnotationNotes(requestPrompt: string, annotationNotes: string[] | undefined): string {
    const notes = annotationNotes?.map((note) => note.trim()).filter(Boolean) ?? [];
    if (!notes.length) return requestPrompt;
    return `${requestPrompt}

Visible PaintNode annotations:
${notes.join('\n')}

Use these annotations as direct user instructions for the regions they point to.`;
  }

  onDestroy(() => {
    if (!runningTaskId) progressListener.clear();
  });

  function close(): void {
    if (!task) editor.dismissAiRetouch();
    onClose();
  }

  async function copyError() {
    if (!currentError) return;
    await copyTextToClipboard(currentError);
    copied = true;
    window.setTimeout(() => (copied = false), 1200);
  }

  async function addReferences(): Promise<void> {
    error = '';
    copied = false;
    if (!desktop) {
      error = 'Reference files are available only in the desktop app.';
      return;
    }
    try {
      references = [...references, ...(await loadAiReferenceImages(project.path))];
    } catch (e) {
      error = 'Add reference failed: ' + ((e as Error)?.message ?? String(e));
    }
  }

  function removeReference(id: string): void {
    references = references.filter((reference) => reference.id !== id);
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
    busy = true;
    const targetDocumentId = editor.activeDocumentId;
    const taskProjectPath = project.path;
    const runId = createRunId('retouch');
    const task = aiTasks.create({
      kind: 'retouch',
      runId,
      title: 'AI Retouch',
      subtitle: `${active.toolName} · ${roleSummary}`,
      progress: 'Preparing AI retouch inputs...',
      detail: {
        kind: 'retouch',
        providerLabel: roleSummary,
        prompt: prompt.trim(),
        toolName: active.toolName,
        gestureKind: active.gesture.kind,
        sourcePreview,
        maskPreview,
        annotatedSourcePreview,
        referencePreview,
        references: references.map((reference) => ({ name: reference.name, bytes: reference.bytes })),
        referenceNames: references.map((reference) => reference.name),
        referencePreviews: references.map((reference) => reference.previewDataUrl),
      },
    });
    runningTaskId = task.id;
    editor.dismissAiRetouch();
    onClose();
    const executeTask = async () => {
      const maskLayer =
        editor.documents
          .flatMap((session) => session.doc.layers)
          .find((layer) => layer.id === active.maskLayerId && layer.kind === 'ai-retouch-mask') ?? null;
      // Captured per invocation so a retry restores the lock state the user
      // had at that point, not the one from the original run.
      const previousMaskLock = maskLayer ? maskLayer.userLocked : null;
      if (maskLayer) maskLayer.userLocked = true;
      aiTasks.setProgress(task.id, 'Preparing AI retouch inputs...');
      editor.flash('Preparing AI retouch...');
      const keepJobDir = settings.value.workspace.keepAiRunInputs;
      const keepDebugArtifacts = settings.value.workspace.keepAiDebugArtifacts;
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
              aiRunningLabel(imageProvider),
            ),
        );

      try {
        const bytes = await editor.prepareAiRetouchInput(active);
        if (!bytes) throw new Error('Unable to prepare AI retouch input.');
        const retouchPrompt = promptWithAnnotationNotes(prompt.trim(), bytes.annotationNotes);
        if (imageProvider === 'grok') {
          throw new Error(
            'Grok image retouch is coming soon. Switch the image generator to Codex or Antigravity for retouching.',
          );
        }
        const generated =
          imageProvider === 'antigravity'
            ? await generateAntigravityRetouchImage(
                antigravityConfigFromRunOptions(runOptions, taskProjectPath, runId, keepJobDir, keepDebugArtifacts),
                bytes.sourcePng,
                bytes.editTargetPng,
                bytes.maskPng,
                bytes.annotatedSourcePng,
                bytes.referencePng,
                retouchPrompt,
                references,
              )
            : await generateCodexRetouchImage(
                codexConfigFromRunOptions(runOptions, taskProjectPath, runId, keepJobDir, keepDebugArtifacts),
                bytes.sourcePng,
                bytes.editTargetPng,
                bytes.maskPng,
                bytes.annotatedSourcePng,
                bytes.referencePng,
                retouchPrompt,
                references,
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
        error = message;
        aiTasks.fail(task.id, error);
        editor.flash('AI retouch failed');
      } finally {
        const currentMaskLayer = editor.documents
          .flatMap((session) => session.doc.layers)
          .find((layer) => layer.id === active.maskLayerId && layer.kind === 'ai-retouch-mask');
        if (currentMaskLayer && previousMaskLock !== null) currentMaskLayer.userLocked = previousMaskLock;
        busy = false;
        progressListener.clear();
        runningTaskId = null;
      }
    };
    aiTasks.setRetry(task.id, executeTask);
    void executeTask();
  }
</script>

<Modal title="AI Retouch" onClose={close} width={560} height={640} minWidth={520} minHeight={420} resizable>
  <div class="dlg-form">
    <div class="dlg-scroll">
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

      {#if taskDetail.sourcePreview || taskDetail.maskPreview || taskDetail.referenceNames?.length}
        <div class="preview-section">
          <div class="preview-title">
            <span>Images</span>
          </div>
          <div class="previews" aria-label="AI retouch input images">
            {#if taskDetail.sourcePreview}
              <figure>
                <img src={taskDetail.sourcePreview} alt="" />
                <figcaption>Source</figcaption>
              </figure>
            {/if}
            {#if taskDetail.maskPreview}
              <figure>
                <img src={taskDetail.maskPreview} alt="" />
                <figcaption>Mask</figcaption>
              </figure>
            {/if}
            {#if taskDetail.annotatedSourcePreview}
              <figure>
                <img src={taskDetail.annotatedSourcePreview} alt="" />
                <figcaption>Annotated</figcaption>
              </figure>
            {/if}
            {#if taskDetail.referencePreview}
              <figure>
                <img src={taskDetail.referencePreview} alt="" />
                <figcaption>Reference</figcaption>
              </figure>
            {/if}
            {#each taskDetail.referenceNames ?? [] as name, index}
              <figure>
                {#if taskDetail.referencePreviews?.[index]}
                  <img src={taskDetail.referencePreviews[index]} alt="" />
                {:else}
                  <div class="missing-preview" aria-hidden="true"></div>
                {/if}
                <figcaption>{name}</figcaption>
              </figure>
            {/each}
          </div>
        </div>
      {/if}
    {:else if request}
      <div class="summary">
        <strong>{request.toolName}</strong>
        <span>{request.gesture.kind}</span>
      </div>

      <div class="preview-section">
        <div class="preview-title">
          <span>Images</span>
          <button
            type="button"
            class="icon-btn"
            aria-label="Add reference"
            use:tooltip={{ text: 'Add reference', placement: 'left' }}
            onclick={addReferences}
            disabled={currentBusy || !desktop}
          >
            <Icon svg={Add} size={16} />
          </button>
        </div>
        <div class="previews" aria-label="AI retouch input images">
          <figure>
            <img src={sourcePreview} alt="" />
            <figcaption>Source</figcaption>
          </figure>
          <figure>
            <img src={maskPreview} alt="" />
            <figcaption>Mask</figcaption>
          </figure>
          {#if annotatedSourcePreview}
            <figure>
              <img src={annotatedSourcePreview} alt="" />
              <figcaption>Annotated</figcaption>
            </figure>
          {/if}
          {#if referencePreview}
            <figure>
              <img src={referencePreview} alt="" />
              <figcaption>Reference</figcaption>
            </figure>
          {/if}
          {#each references as reference (reference.id)}
            <figure>
              <img src={reference.previewDataUrl} alt="" />
              <button
                type="button"
                class="remove-ref"
                aria-label={`Remove ${reference.name}`}
                use:tooltip={{ text: 'Remove reference', placement: 'top' }}
                onclick={() => removeReference(reference.id)}
              >
                <Icon svg={Dismiss} size={13} />
              </button>
              <figcaption>{reference.name}</figcaption>
            </figure>
          {/each}
        </div>
      </div>
    {/if}

    <label class="dlg-field prompt-field">
      <span>Retouch prompt</span>
      {#if taskDetail}
        <textarea value={taskDetail.prompt} rows="5" readonly></textarea>
      {:else}
        <textarea bind:value={prompt} rows="5" spellcheck="true"></textarea>
      {/if}
    </label>

    {#if !taskDetail}
      <div class="dlg-field">
        <span>Result checks</span>
        <div class="checks-tabs" role="group" aria-label="Result checks level">
          {#each editChecksLevels as level (level.value)}
            <button
              type="button"
              class:active={runOptions.editChecksLevel === level.value}
              use:tooltip={{ text: level.hint, placement: 'top' }}
              onclick={() => (runOptions.editChecksLevel = level.value)}
            >
              {level.label}
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <p class="hint">
      PaintNode crops the canvas around the selected AI mask to a size the provider supports (splitting
      into sequential parts when the document is too wide or tall), sends it with the photo edit target
      and any sampled reference, then pastes the result back in place. The generated pixels are inserted
      as a new layer and the mask remains reusable.
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
    </div>

    <div class="dlg-actions">
      {#if !task}
        <AiRunOptionsControl bind:options={runOptions} disabled={busy} />
      {/if}
      <span class="dlg-action-spacer"></span>
      <button onclick={close}>{task ? 'Close' : 'Cancel'}</button>
      {#if task && aiTasks.canRetry(task)}
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
  .preview-section {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .preview-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--text-dim);
  }
  .icon-btn,
  .remove-ref {
    display: grid;
    place-items: center;
    width: 26px;
    height: 26px;
    padding: 0;
  }
  .previews {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 2px;
  }
  figure {
    position: relative;
    flex: 0 0 166px;
    margin: 0;
    min-width: 0;
  }
  figure img,
  .missing-preview {
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
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .remove-ref {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 22px;
    height: 22px;
    background: rgba(22, 22, 22, 0.78);
  }
  .dlg-field {
    display: grid;
    gap: 5px;
    color: var(--text-dim);
  }
  .prompt-field {
    display: flex;
    flex: 1 1 180px;
    flex-direction: column;
    min-height: 140px;
  }
  .prompt-field textarea {
    flex: 1 1 auto;
    min-height: 100px;
  }
  .checks-tabs {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    overflow: hidden;
  }
  .checks-tabs button {
    border: none;
    border-radius: 0;
    background: var(--bg-input);
    color: var(--text-dim);
    padding: 5px 8px;
  }
  .checks-tabs button + button {
    border-left: 1px solid var(--border-soft);
  }
  .checks-tabs button.active {
    background: var(--accent);
    color: #fff;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
  }
  textarea {
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
