<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { isDesktop, generateCodexImage, generateImage } from '../integrations/desktop';
  import { Copy } from '../icons';

  let { onClose }: { onClose: () => void } = $props();

  type Provider = 'codex' | 'custom';
  type CodexProgressPayload = { runId: string; message: string };

  const desktop = isDesktop();
  const KEY = 'paintnode.generator';
  const DEFAULT_ARGS = '{prompt}\n--output\n{output}';

  function loadCfg(): { provider: Provider; codexBin: string; bin: string; argsText: string } {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const provider = parsed.provider ?? (parsed.bin ? 'custom' : 'codex');
        return {
          provider: provider === 'custom' ? 'custom' : 'codex',
          codexBin: '',
          bin: '',
          argsText: DEFAULT_ARGS,
          ...parsed,
        };
      }
    } catch {
      /* ignore */
    }
    return { provider: 'codex', codexBin: '', bin: '', argsText: DEFAULT_ARGS };
  }
  const init = loadCfg();

  let provider = $state<Provider>(init.provider);
  let codexBin = $state(init.codexBin);
  let bin = $state(init.bin);
  let argsText = $state(init.argsText);
  let prompt = $state('');
  let busy = $state(false);
  let error = $state('');
  let copied = $state(false);
  let progress = $state('');
  let stopProgress: UnlistenFn | null = null;

  function createRunId(): string {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `codex-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function clearProgressListener() {
    stopProgress?.();
    stopProgress = null;
  }

  onDestroy(clearProgressListener);

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

  function promptWithCanvasSize(userPrompt: string): string {
    const base = userPrompt.trim();
    const doc = editor.doc;
    if (!doc) return base;
    return `${base}

Canvas size requirement: generate the image to match the current PaintNode canvas exactly: ${doc.width}x${doc.height} pixels, landscape/portrait orientation and aspect ratio included. Do not crop, letterbox, pillarbox, or add extra margins beyond this canvas.`;
  }

  async function run() {
    error = '';
    copied = false;
    if (!desktop) {
      error = 'Available only in the desktop app.';
      return;
    }
    if (provider === 'custom' && !bin.trim()) {
      error = 'Enter the generator command.';
      return;
    }
    if (!prompt.trim()) {
      error = 'Enter a prompt.';
      return;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify({ provider, codexBin, bin, argsText }));
    } catch {
      /* ignore */
    }
    const userPrompt = prompt.trim();
    const generationPrompt = promptWithCanvasSize(userPrompt);
    busy = true;
    progress = provider === 'codex' ? 'Starting local Codex...' : 'Running local generator...';
    editor.flash(provider === 'codex' ? 'Generating with Codex...' : 'Generating image...');
    clearProgressListener();
    const runId = provider === 'codex' ? createRunId() : '';
    if (provider === 'codex') {
      try {
        stopProgress = await listen<CodexProgressPayload>('codex-generation-progress', (event) => {
          if (event.payload.runId === runId && event.payload.message.trim()) {
            progress = event.payload.message.trim();
          }
        });
      } catch {
        progress = 'Local Codex is running...';
      }
    }
    try {
      const generated =
        provider === 'codex'
          ? await generateCodexImage({ bin: codexBin, projectPath: project.path, runId }, generationPrompt)
          : null;
      if (generated?.asset) await project.refresh();
      const dataUrl =
        generated?.dataUrl ??
        (await generateImage(
          {
            bin: bin.trim(),
            args: argsText
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean),
          },
          generationPrompt,
        ));
      const blob = await (await fetch(dataUrl)).blob();
      const bmp = await createImageBitmap(blob);
      const customAsset =
        !generated && project.path
          ? await project.storeGeneratedBlob(blob, `AI ${userPrompt.slice(0, 48) || 'generated'}.png`, generationPrompt, bmp.width, bmp.height)
          : null;
      const oversized = editor.placeImage(bmp, bmp.width, bmp.height, `AI: ${userPrompt.slice(0, 24)}`, {
        assetId: generated?.asset?.id ?? customAsset?.id ?? null,
        path: generated?.asset?.relativePath ?? customAsset?.relativePath ?? null,
      }).oversized;
      bmp.close();
      editor.flash(
        oversized ? 'Image generated full-size; use Move or Image > Reveal All to show hidden edges' : 'Image generated',
      );
      onClose();
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
      editor.flash('Generation failed');
    } finally {
      busy = false;
      progress = '';
      clearProgressListener();
    }
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

    <div class="provider-tabs" role="group" aria-label="Image generator">
      <button class:active={provider === 'codex'} onclick={() => (provider = 'codex')}>
        Local Codex
      </button>
      <button class:active={provider === 'custom'} onclick={() => (provider = 'custom')}>
        Custom CLI
      </button>
    </div>

    <label class="dlg-field">
      <span>Prompt</span>
      <textarea bind:value={prompt} rows="3" placeholder="a serene mountain lake at sunset"></textarea>
    </label>

    {#if provider === 'codex'}
      <label class="dlg-field">
        <span>Codex command (optional)</span>
        <input type="text" bind:value={codexBin} placeholder="codex, /opt/homebrew/bin/codex, or /usr/local/bin/codex" spellcheck="false" />
      </label>

      <p class="hint">
        Uses your local Codex login. If this fails, run <code>codex login</code> in Terminal and try again.
        PaintNode copies the newest generated PNG from Codex's local image cache into the project and adds it as a new layer.
      </p>
    {:else}
      <label class="dlg-field">
        <span>Command (local CLI)</span>
        <input type="text" bind:value={bin} placeholder="Full path to your image-gen CLI" spellcheck="false" />
      </label>

      <label class="dlg-field">
        <span>Arguments, one per line; <code>{'{prompt}'}</code> and <code>{'{output}'}</code> are substituted</span>
        <textarea bind:value={argsText} rows="4" spellcheck="false"></textarea>
      </label>

      <p class="hint">
        Your CLI must write a PNG to the <code>{'{output}'}</code> path. The result is added as a new layer.
      </p>
    {/if}

    {#if busy}
      <div class="progress-line" role="status" aria-live="polite">
        <span class="progress-dot" aria-hidden="true"></span>
        <span>{progress}</span>
      </div>
    {/if}

    {#if error}
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
        <pre>{error}</pre>
      </div>
    {/if}

    <div class="dlg-actions">
      <button onclick={onClose}>Cancel</button>
      <button class="dlg-primary" onclick={run} disabled={busy || !desktop}>
        {busy ? 'Generating…' : 'Generate'}
      </button>
    </div>
  </div>
</Modal>

<style>
  .provider-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
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
</style>
