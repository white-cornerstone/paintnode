<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { workflow, type WorkflowTool } from '../state/workflow.svelte';

  const doc = $derived(editor.doc);
  const hasDocument = $derived(ui.activeSurface === 'document' && !!doc);
  const hasWorkflow = $derived(ui.activeSurface === 'workflow' && workflow.active);
  const hasZoomSurface = $derived(hasDocument || hasWorkflow);
  const pct = $derived(Math.round((hasWorkflow ? workflow.zoom : ui.zoom) * 100));
  const layerCount = $derived(doc?.layers.length ?? 0);
  const workflowToolNames: Record<WorkflowTool, string> = {
    hand: 'Hand',
    zoom: 'Zoom',
    asset: 'Asset Node',
    composition: 'Composition Node',
    output: 'Output Node',
  };

  let editing = $state(false);
  let draft = $state('');

  function startEdit(e: FocusEvent) {
    if (!hasZoomSurface) return;
    editing = true;
    draft = String(pct);
    const el = e.currentTarget as HTMLInputElement;
    queueMicrotask(() => el.select());
  }
  function applyZoom() {
    if (!hasZoomSurface) {
      editing = false;
      return;
    }
    const v = parseFloat(draft);
    if (!Number.isNaN(v) && v > 0) {
      if (hasWorkflow) workflow.setZoom(v / 100);
      else editor.viewport?.setZoom(v / 100);
    }
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
  <span class="item">{hasDocument && doc ? `${doc.width} × ${doc.height} px` : ''}</span>
  <span class="sep"></span>
  <input
    class="zoom-input"
    type="text"
    inputmode="decimal"
    value={hasZoomSurface ? (editing ? draft : `${pct}%`) : ''}
    oninput={(e) => (draft = e.currentTarget.value)}
    onfocus={startEdit}
    onblur={applyZoom}
    onkeydown={onKey}
    aria-label="Zoom level (type a percentage)"
    title="Zoom — click and type a percentage"
    disabled={!hasZoomSurface}
  />
  <span class="sep"></span>
  <span class="item pos">{hasDocument && ui.cursor ? `${ui.cursor.x}, ${ui.cursor.y}` : ''}</span>
  {#if editor.flashMessage}
    <span class="flash">{editor.flashMessage}</span>
  {/if}
  <span class="spacer"></span>
  <span class="item dim">{hasDocument ? `${layerCount} layer${layerCount === 1 ? '' : 's'}` : ''}</span>
  <span class="sep"></span>
  <span class="item dim">{hasDocument ? editor.activeTool.name : hasWorkflow ? workflowToolNames[workflow.tool] : ''}</span>
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
