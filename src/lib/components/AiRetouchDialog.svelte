<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { generateCodexRetouchImage, isDesktop, writeProjectDocumentPath } from '../integrations/desktop';
  import { Copy } from '../icons';

  let { onClose }: { onClose: () => void } = $props();

  type CodexProgressPayload = { runId: string; message: string };

  const desktop = isDesktop();
  const KEY = 'paintnode.aiRetouch';
  const init = (() => {
    try {
      return JSON.parse(localStorage.getItem(KEY) || '{}') as { codexBin?: string };
    } catch {
      return {};
    }
  })();

  let codexBin = $state(init.codexBin ?? '');
  let prompt = $state(editor.pendingAiRetouch?.prompt ?? '');
  let busy = $state(false);
  let error = $state('');
  let copied = $state(false);
  let progress = $state('');
  let stopProgress: UnlistenFn | null = null;

  const request = $derived(editor.pendingAiRetouch);
  const sourcePreview = $derived(request?.source.toDataURL('image/png') ?? '');
  const maskPreview = $derived(request?.mask.toDataURL('image/png') ?? '');
  const referencePreview = $derived(request?.reference?.toDataURL('image/png') ?? '');

  function createRunId(): string {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `retouch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function textBytes(text: string): Uint8Array {
    return new TextEncoder().encode(text);
  }

  function clearProgressListener() {
    stopProgress?.();
    stopProgress = null;
  }

  onDestroy(clearProgressListener);

  function close(): void {
    editor.dismissAiRetouch();
    onClose();
  }

  async function copyError() {
    if (!error) return;
    try {
      await navigator.clipboard.writeText(error);
    } catch {
      const area = document.createElement('textarea');
      area.value = error;
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

  async function saveDebugInputs(bytes: NonNullable<Awaited<ReturnType<typeof editor.prepareAiRetouchInput>>>, requestPrompt: string): Promise<string | null> {
    if (!project.path || !request) return null;
    const dir = `.paintnode/codex-runs/retouch-inputs-${Date.now()}`;
    await writeProjectDocumentPath({ projectPath: project.path, path: `${dir}/source.png`, bytes: bytes.sourcePng });
    await writeProjectDocumentPath({ projectPath: project.path, path: `${dir}/edit_target.png`, bytes: bytes.editTargetPng });
    await writeProjectDocumentPath({ projectPath: project.path, path: `${dir}/mask.png`, bytes: bytes.maskPng });
    if (bytes.referencePng) {
      await writeProjectDocumentPath({ projectPath: project.path, path: `${dir}/reference.png`, bytes: bytes.referencePng });
    }
    await writeProjectDocumentPath({
      projectPath: project.path,
      path: `${dir}/prompt.txt`,
      bytes: textBytes(`${request.toolName}\n\n${requestPrompt}`),
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
    try {
      localStorage.setItem(KEY, JSON.stringify({ codexBin }));
    } catch {
      /* ignore */
    }
    busy = true;
    let debugDir: string | null = null;
    progress = 'Preparing AI retouch inputs...';
    editor.flash('Preparing AI retouch...');
    clearProgressListener();
    const runId = createRunId();
    try {
      stopProgress = await listen<CodexProgressPayload>('codex-generation-progress', (event) => {
        if (event.payload.runId === runId && event.payload.message.trim()) {
          progress = event.payload.message.trim();
        }
      });
    } catch {
      progress = 'Local Codex is running...';
    }

    try {
      const bytes = await editor.prepareAiRetouchInput(active);
      if (!bytes) throw new Error('Unable to prepare AI retouch input.');
      debugDir = await saveDebugInputs(bytes, prompt.trim());
      if (debugDir) progress = `Saved retouch inputs: ${debugDir}`;
      const generated = await generateCodexRetouchImage(
        { bin: codexBin, projectPath: project.path, runId },
        bytes.sourcePng,
        bytes.editTargetPng,
        bytes.maskPng,
        bytes.referencePng,
        prompt.trim(),
      );
      const savedAssetCount = generated.assets?.length ?? (generated.asset ? 1 : 0);
      if (generated.asset || savedAssetCount > 0) await project.refresh();
      const blob = await (await fetch(generated.dataUrl)).blob();
      const bmp = await createImageBitmap(blob);
      editor.insertAiRetouchResult(active, bmp, bmp.width, bmp.height, {
        assetId: generated.asset?.id ?? null,
        path: generated.asset?.relativePath ?? null,
      });
      bmp.close();
      editor.flash(
        savedAssetCount > 0
          ? `AI retouch added; ${savedAssetCount} generated asset${savedAssetCount === 1 ? '' : 's'} saved`
          : 'AI retouch added',
      );
      onClose();
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      error = debugDir ? `${message}\n\nRetouch input files were saved at:\n${debugDir}` : message;
      editor.flash('AI retouch failed');
    } finally {
      busy = false;
      progress = '';
      clearProgressListener();
    }
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

    {#if request}
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

    <label class="dlg-field">
      <span>Codex command (optional)</span>
      <input type="text" bind:value={codexBin} placeholder="codex, /opt/homebrew/bin/codex, or /usr/local/bin/codex" spellcheck="false" />
    </label>

    <label class="dlg-field">
      <span>Retouch prompt</span>
      <textarea bind:value={prompt} rows="5" spellcheck="true"></textarea>
    </label>

    <p class="hint">
      PaintNode sends the full canvas, the current photo edit target, the selected AI mask, and any
      sampled reference to Codex. The generated pixels are inserted as a new layer and the mask remains reusable.
    </p>

    {#if busy}
      <div class="progress-line" role="status" aria-live="polite">
        <span class="progress-dot" aria-hidden="true"></span>
        <span>{progress}</span>
      </div>
    {/if}

    {#if error}
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
        <pre>{error}</pre>
      </div>
    {/if}

    <div class="dlg-actions">
      <button onclick={close}>Cancel</button>
      <button class="dlg-primary" onclick={run} disabled={busy || !desktop || !request}>
        {busy ? 'Running...' : 'Run'}
      </button>
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
</style>
