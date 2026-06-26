<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';

  const doc = $derived(editor.doc);
  const pct = $derived(Math.round(ui.zoom * 100));
  const layerCount = $derived(doc?.layers.length ?? 0);

  let editing = $state(false);
  let draft = $state('');

  function startEdit(e: FocusEvent) {
    if (!doc) return;
    editing = true;
    draft = String(pct);
    const el = e.currentTarget as HTMLInputElement;
    queueMicrotask(() => el.select());
  }
  function applyZoom() {
    if (!doc) {
      editing = false;
      return;
    }
    const v = parseFloat(draft);
    if (!Number.isNaN(v) && v > 0) editor.viewport?.setZoom(v / 100);
    editing = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      applyZoom();
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      editing = false;
      (e.currentTarget as HTMLInputElement).blur();
    }
  }
</script>

<footer class="status">
  <span class="item">{doc ? `${doc.width} × ${doc.height} px` : ''}</span>
  <span class="sep"></span>
  <input
    class="zoom-input"
    type="text"
    inputmode="decimal"
    value={doc ? (editing ? draft : `${pct}%`) : ''}
    oninput={(e) => (draft = e.currentTarget.value)}
    onfocus={startEdit}
    onblur={applyZoom}
    onkeydown={onKey}
    aria-label="Zoom level (type a percentage)"
    title="Zoom — click and type a percentage"
    disabled={!doc}
  />
  <span class="sep"></span>
  <span class="item pos">{doc && ui.cursor ? `${ui.cursor.x}, ${ui.cursor.y}` : ''}</span>
  {#if editor.flashMessage}
    <span class="flash">{editor.flashMessage}</span>
  {/if}
  <span class="spacer"></span>
  <span class="item dim">{doc ? `${layerCount} layer${layerCount === 1 ? '' : 's'}` : ''}</span>
  <span class="sep"></span>
  <span class="item dim">{doc ? editor.activeTool.name : ''}</span>
</footer>

<style>
  .status {
    height: var(--statusbar-h);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 12px;
    background: var(--bg-panel);
    border-top: 1px solid var(--border);
    color: var(--text);
    font-size: 11px;
  }
  .item.pos {
    min-width: 84px;
  }
  .item:empty::before {
    content: '\00a0';
  }
  .sep {
    width: 1px;
    height: 13px;
    background: var(--border-soft);
  }
  .zoom-input {
    width: 50px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--text);
    font-size: 11px;
    padding: 1px 5px;
    text-align: left;
    cursor: text;
  }
  .zoom-input:disabled {
    color: var(--text-dim);
    cursor: default;
    opacity: 0.45;
  }
  .zoom-input:hover {
    border-color: var(--border-soft);
  }
  .zoom-input:disabled:hover {
    border-color: transparent;
  }
  .zoom-input:focus {
    background: var(--bg-input);
    border-color: var(--accent);
    outline: none;
  }
  .flash {
    color: var(--accent);
    margin-left: 8px;
  }
  .spacer {
    flex: 1;
  }
  .dim {
    color: var(--text-dim);
  }
</style>
