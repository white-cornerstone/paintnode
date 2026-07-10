<script lang="ts">
  import { onMount } from 'svelte';
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { workflow } from '../state/workflow.svelte';
  import { tooltip } from '../actions/tooltip';
  import { isDesktop, readAppMemoryInfo, type AppMemoryInfo } from '../integrations/desktop';
  import { runtimeProgressPercent } from '../ai/managedRuntime';
  import { managedRuntimeOperations } from '../state/managedRuntimeOperations.svelte';
  import Icon from './Icon.svelte';
  import { DeveloperBoard } from '../icons';

  const doc = $derived(editor.doc);
  const hasDocument = $derived(ui.activeSurface === 'document' && !!doc);
  const hasWorkflow = $derived(ui.activeSurface === 'workflow' && workflow.active);
  const hasZoomSurface = $derived(hasDocument || hasWorkflow);
  const pct = $derived(Math.round((hasWorkflow ? workflow.zoom : ui.zoom) * 100));
  const layerCount = $derived(doc?.layers.length ?? 0);
  const managedRuntimeProgress = $derived(managedRuntimeOperations.active?.progress ?? null);
  const busyLabel = $derived(managedRuntimeProgress?.message ?? ui.loadingLabel);
  const busyPercent = $derived(runtimeProgressPercent(managedRuntimeProgress));

  let editing = $state(false);
  let draft = $state('');
  let memoryInfo = $state<AppMemoryInfo | null>(null);
  const memoryLabel = $derived(memoryInfo ? formatBytes(memoryInfo.residentBytes) : '');
  const memoryTooltip = $derived(
    memoryInfo
      ? `Resident memory used by PaintNode desktop process tree (${memoryInfo.processCount} process${memoryInfo.processCount === 1 ? '' : 'es'}).`
      : '',
  );

  function formatBytes(bytes: number): string {
    const mb = bytes / 1024 / 1024;
    if (mb < 1024) return `${Math.max(1, Math.round(mb))} MB`;
    return `${(mb / 1024).toFixed(1)} GB`;
  }

  onMount(() => {
    if (!isDesktop()) return;

    let disposed = false;
    const refresh = async () => {
      const info = await readAppMemoryInfo();
      if (!disposed) memoryInfo = info;
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  });

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
  {#if busyLabel}
    <span class="loading" role="status">
      <span class="loading-label">{busyLabel}</span>
      <span class="loading-bar">
        <span
          class:determinate={busyPercent !== null}
          class="loading-fill"
          style:width={busyPercent === null ? undefined : `${busyPercent}%`}
        ></span>
      </span>
    </span>
    <span class="sep"></span>
  {/if}
  <span class="item dim">{hasDocument ? `${layerCount} layer${layerCount === 1 ? '' : 's'}` : ''}</span>
  {#if memoryLabel}
    <span class="sep"></span>
    <span class="item dim memory" aria-label={`RAM ${memoryLabel}`} use:tooltip={{ text: memoryTooltip, placement: 'top' }}>
      <Icon svg={DeveloperBoard} size={13} />
      <span>{memoryLabel}</span>
    </span>
  {/if}
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
  .memory {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .loading {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    /* Sub-250ms waits never mount at all (ui.beginLoading's anti-flash delay);
       this is just a quick fade for the ones that do. */
    animation: loading-appear 120ms ease-out both;
  }
  .loading-label {
    color: var(--text-dim);
  }
  .loading-bar {
    position: relative;
    width: 110px;
    height: 3px;
    border-radius: 2px;
    background: var(--border-soft);
    overflow: hidden;
  }
  .loading-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 40%;
    border-radius: 2px;
    background: var(--accent);
    /* Sweep with transform (not `left`) so it composites without per-frame layout. */
    animation: loading-sweep 1.2s ease-in-out infinite;
  }
  .loading-fill.determinate {
    animation: none;
    transform: none;
  }
  @keyframes loading-sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(250%);
    }
  }
  @keyframes loading-appear {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
