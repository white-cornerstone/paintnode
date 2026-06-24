<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';
  import { isDesktop, generateImage } from '../integrations/desktop';

  let { onClose }: { onClose: () => void } = $props();

  const desktop = isDesktop();
  const KEY = 'cxpaint.generator';
  const DEFAULT_ARGS = '{prompt}\n--output\n{output}';

  function loadCfg(): { bin: string; argsText: string } {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { bin: '', argsText: DEFAULT_ARGS, ...JSON.parse(raw) };
    } catch {
      /* ignore */
    }
    return { bin: '', argsText: DEFAULT_ARGS };
  }
  const init = loadCfg();

  let bin = $state(init.bin);
  let argsText = $state(init.argsText);
  let prompt = $state('');
  let busy = $state(false);
  let error = $state('');

  async function run() {
    error = '';
    if (!desktop) {
      error = 'Available only in the desktop app.';
      return;
    }
    if (!bin.trim()) {
      error = 'Enter the generator command.';
      return;
    }
    if (!prompt.trim()) {
      error = 'Enter a prompt.';
      return;
    }
    try {
      localStorage.setItem(KEY, JSON.stringify({ bin, argsText }));
    } catch {
      /* ignore */
    }
    busy = true;
    editor.flash('Generating image…');
    try {
      const args = argsText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const dataUrl = await generateImage({ bin: bin.trim(), args }, prompt.trim());
      const blob = await (await fetch(dataUrl)).blob();
      const bmp = await createImageBitmap(blob);
      editor.placeImage(bmp, bmp.width, bmp.height, `AI: ${prompt.slice(0, 24)}`);
      bmp.close();
      editor.flash('Image generated');
      onClose();
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
      editor.flash('Generation failed');
    } finally {
      busy = false;
    }
  }
</script>

<Modal title="Generate Image (AI)" {onClose} width={470}>
  <div class="dlg-form">
    {#if !desktop}
      <p class="warn">
        ⚠ This runs a <strong>local command</strong> and only works in the desktop app. Launch it
        with <code>npm run tauri:dev</code> (requires Rust). In the browser it stays disabled.
      </p>
    {/if}

    <label class="dlg-field">
      <span>Prompt</span>
      <textarea bind:value={prompt} rows="3" placeholder="a serene mountain lake at sunset"></textarea>
    </label>

    <label class="dlg-field">
      <span>Command (local CLI)</span>
      <input type="text" bind:value={bin} placeholder="codex  — or full path to your image-gen CLI" spellcheck="false" />
    </label>

    <label class="dlg-field">
      <span>Arguments — one per line; <code>{'{prompt}'}</code> and <code>{'{output}'}</code> are substituted</span>
      <textarea bind:value={argsText} rows="4" spellcheck="false"></textarea>
    </label>

    <p class="hint">
      Your CLI must write a PNG to the <code>{'{output}'}</code> path. The result is added as a new layer.
    </p>

    {#if error}<p class="err">{error}</p>{/if}

    <div class="dlg-actions">
      <button onclick={onClose}>Cancel</button>
      <button class="dlg-primary" onclick={run} disabled={busy || !desktop}>
        {busy ? 'Generating…' : 'Generate'}
      </button>
    </div>
  </div>
</Modal>

<style>
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
  .err {
    margin: 0;
    color: var(--danger);
    font-size: 11px;
    white-space: pre-wrap;
  }
  textarea {
    resize: vertical;
    font-family: inherit;
  }
</style>
