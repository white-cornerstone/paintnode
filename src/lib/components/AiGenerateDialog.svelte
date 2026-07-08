<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import AiRunOptionsControl from './AiRunOptionsControl.svelte';
  import { copyTextToClipboard, providerLabel } from '../ai/taskSupport';
  import { defaultFillPrompt } from '../ai/generateExecutor';
  import { fillFrameSummary } from '../ai/imageModelCapabilities';
  import { loadAiReferenceImages, type AiReferenceImage } from '../ai/references';
  import { tooltip } from '../actions/tooltip';
  import { aiTasks } from '../state/aiTasks.svelte';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { settings } from '../state/settings.svelte';
  import { ui } from '../state/ui.svelte';
  import { DEFAULT_CUSTOM_GENERATOR_ARGS, aiRunOptionsFromSettings, cloneAiRunOptions } from '../state/settings';
  import { isDesktop } from '../integrations/desktop';
  import { Add, Copy, Dismiss } from '../icons';

  let { onClose, taskId = null }: { onClose: () => void; taskId?: string | null } = $props();

  const desktop = isDesktop();

  let runOptions = $state(aiRunOptionsFromSettings(settings.value));
  let argsText = $state(settings.value.ai.customGenerateArgsText || settings.value.ai.customArgsText || DEFAULT_CUSTOM_GENERATOR_ARGS);
  // A prompt handed off by the AI setup wizard pre-fills the dialog once.
  let prompt = $state(ui.consumeAiGeneratePrefill() ?? '');
  let busy = $state(false);
  let error = $state('');
  let copied = $state(false);
  let references = $state<AiReferenceImage[]>([]);
  let antigravityRatioOverride = $state<string | null>(null);
  const task = $derived(aiTasks.find(taskId));
  const taskDetail = $derived(task?.detail.kind === 'generate' ? task.detail : null);
  const currentError = $derived(task?.error ?? error);
  const currentProgress = $derived(task?.progress ?? '');
  const currentBusy = $derived(task?.status === 'running' || busy);
  const fillFrame = $derived.by(() => {
    const doc = editor.doc;
    const selection = editor.selection;
    if (!doc || !selection || runOptions.provider === 'custom') return null;
    return fillFrameSummary(
      runOptions.provider,
      doc.width,
      doc.height,
      selection.bounds.w,
      selection.bounds.h,
      runOptions.provider === 'antigravity' ? antigravityRatioOverride : null,
    );
  });

  async function copyError() {
    if (!currentError) return;
    await copyTextToClipboard(currentError);
    copied = true;
    window.setTimeout(() => (copied = false), 1200);
  }

  async function addReferences() {
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

  function run() {
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
    if (runOptions.provider === 'custom' && references.length) {
      error = 'Reference images are currently available with Local Codex or Antigravity CLI.';
      return;
    }
    const userPrompt = prompt.trim();
    const capturedRunOptions = cloneAiRunOptions({
      ...runOptions,
      fillAspectRatio:
        runOptions.provider === 'antigravity' && fillFrame ? (antigravityRatioOverride ?? fillFrame.ratioLabel) : null,
    });
    busy = true;
    const task = aiTasks.create({
      kind: 'generate',
      title: hasSelection ? 'Generative Fill' : 'Generate Image',
      subtitle: providerLabel(runOptions.provider),
      progress:
        runOptions.provider === 'codex'
          ? 'Preparing Codex request...'
          : runOptions.provider === 'antigravity'
            ? 'Preparing Antigravity request...'
            : 'Running local generator...',
      documentId: editor.activeDocumentId,
      detail: {
        kind: 'generate',
        providerLabel: providerLabel(runOptions.provider),
        prompt: userPrompt || defaultFillPrompt(),
        fillMode: hasSelection,
        runOptions: capturedRunOptions,
        customArgs: argsText,
        references: references.map((reference) => ({ name: reference.name, bytes: reference.bytes })),
        referenceNames: references.map((reference) => reference.name),
        referencePreviews: references.map((reference) => reference.previewDataUrl),
      },
    });
    onClose();
    aiTasks.launch(task.id);
  }
</script>

<Modal title="Generate Image (AI)" {onClose} width={560}>
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

      {#if taskDetail.referenceNames?.length}
        <div class="reference-section">
          <div class="reference-title">
            <span>References</span>
          </div>
          <div class="reference-strip" aria-label="Reference images">
            {#each taskDetail.referenceNames as name, index}
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
    {:else}
      <div class="provider-tabs" role="group" aria-label="Image generator">
        <button class:active={runOptions.provider === 'codex'} onclick={() => (runOptions.provider = 'codex')}>
          Local Codex
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

      <div class="reference-section">
        <div class="reference-title">
          <span>References</span>
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
        {#if references.length}
          <div class="reference-strip" aria-label="Reference images">
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
        {/if}
      </div>

      {#if fillFrame}
        <div class="frame-summary">
          <div>
            <span>Selection</span>
            <strong>{fillFrame.selectionLabel}</strong>
          </div>
          <div>
            <span>{runOptions.provider === 'antigravity' ? 'Ratio' : 'Frame'}</span>
            <strong>{runOptions.provider === 'antigravity' ? fillFrame.ratioLabel : fillFrame.frameLabel}</strong>
          </div>
          <div>
            <span>Scale</span>
            <strong>{fillFrame.needsRestoration ? `${fillFrame.scalePercent}% + restore` : '100%'}</strong>
          </div>
        </div>
        {#if runOptions.provider === 'antigravity' && (fillFrame.needsRatioChoice || antigravityRatioOverride)}
          <label class="dlg-field">
            <span>Antigravity ratio</span>
            <select
              value={antigravityRatioOverride ?? fillFrame.ratioLabel}
              onchange={(event) => (antigravityRatioOverride = (event.currentTarget as HTMLSelectElement).value)}
            >
              {#each fillFrame.choices as choice (choice.label)}
                <option value={choice.label}>{choice.label}</option>
              {/each}
            </select>
          </label>
        {/if}
      {/if}
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
        <AiRunOptionsControl bind:options={runOptions} disabled={busy} antigravityModelScope="image" />
      {/if}
      <span class="dlg-action-spacer"></span>
      <button onclick={onClose}>{task ? 'Close' : 'Cancel'}</button>
      {#if task && aiTasks.canRetry(task)}
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
  .frame-summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-input);
  }
  .frame-summary div {
    min-width: 0;
    display: grid;
    gap: 2px;
  }
  .frame-summary span {
    color: var(--text-dim);
    font-size: 10px;
    text-transform: uppercase;
  }
  .frame-summary strong {
    min-width: 0;
    color: var(--text);
    font-size: 11px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .reference-section {
    display: grid;
    gap: 6px;
    min-width: 0;
  }
  .reference-title {
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
  .reference-strip {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 2px;
  }
  figure {
    position: relative;
    flex: 0 0 138px;
    min-width: 0;
    margin: 0;
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
    font-size: 11px;
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
