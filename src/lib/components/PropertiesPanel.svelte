<script lang="ts">
  import type { BlendMode } from '../engine/types';
  import { BLEND_MODES } from '../engine/types';
  import { PSD_LOCK_LABELS } from '../engine/psdSource';
  import { editor } from '../state/editor.svelte';
  import Panel from './Panel.svelte';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  const layer = $derived(editor.activeLayer);
  const doc = $derived(editor.doc);
  const opacityPercent = $derived(Math.round((layer?.opacity ?? 1) * 100));
  const lockLabel = $derived(layer?.psd?.lockReason ? PSD_LOCK_LABELS[layer.psd.lockReason] : null);

  function setLayerNumber(field: 'x' | 'y', value: number): void {
    if (!layer || !Number.isFinite(value)) return;
    if (editor.blockIfLocked(layer)) return;
    layer[field] = Math.round(value);
    editor.bump();
    editor.invalidate();
  }

  function setOpacity(value: number): void {
    if (!layer || !Number.isFinite(value)) return;
    editor.setLayerOpacity(layer, Math.round(value) / 100);
  }

  function setBlend(value: string): void {
    if (!layer) return;
    editor.setLayerBlendMode(layer, value as BlendMode);
  }

  function rename(value: string): void {
    if (!layer) return;
    editor.setLayerName(layer, value);
  }
</script>

<Panel title="Properties" bind:collapsed {onToggle}>
  <div class="properties">
    <div class="section">
      <div class="section-title">Document</div>
      <div class="metrics">
        <label>
          <span>W</span>
          <input value={doc?.width ?? 0} readonly aria-label="Document width" />
        </label>
        <label>
          <span>H</span>
          <input value={doc?.height ?? 0} readonly aria-label="Document height" />
        </label>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Active layer</div>
      {#if layer}
        {#if lockLabel}
          <p class="lock-note">{lockLabel} from Photoshop — locked so it survives PSD export unchanged.</p>
        {/if}
        <label class="field">
          <span>Name</span>
          <input value={layer.name} onblur={(e) => rename(e.currentTarget.value)} aria-label="Layer name" />
        </label>
        <div class="metrics">
          <label>
            <span>X</span>
            <input
              type="number"
              value={layer.x}
              readonly={layer.locked}
              oninput={(e) => setLayerNumber('x', e.currentTarget.valueAsNumber)}
              aria-label="Layer x position"
            />
          </label>
          <label>
            <span>Y</span>
            <input
              type="number"
              value={layer.y}
              readonly={layer.locked}
              oninput={(e) => setLayerNumber('y', e.currentTarget.valueAsNumber)}
              aria-label="Layer y position"
            />
          </label>
          <label>
            <span>W</span>
            <input value={layer.width} readonly aria-label="Layer width" />
          </label>
          <label>
            <span>H</span>
            <input value={layer.height} readonly aria-label="Layer height" />
          </label>
        </div>
        <label class="field">
          <span>Blend</span>
          <select value={layer.blendMode} onchange={(e) => setBlend(e.currentTarget.value)} aria-label="Layer blend mode">
            {#each BLEND_MODES as mode (mode.value)}
              <option value={mode.value}>{mode.label}</option>
            {/each}
          </select>
        </label>
        <label class="field">
          <span>Opacity</span>
          <input
            type="range"
            min="0"
            max="100"
            value={opacityPercent}
            oninput={(e) => setOpacity(e.currentTarget.valueAsNumber)}
            aria-label="Layer opacity"
          />
          <b>{opacityPercent}%</b>
        </label>
      {:else}
        <p>No active layer.</p>
      {/if}
    </div>
  </div>
</Panel>

<style>
  .properties {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px;
  }
  .section {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .section + .section {
    padding-top: 8px;
    border-top: 1px solid var(--border-soft);
  }
  .section-title {
    color: var(--text-bright);
    font-size: 11px;
    font-weight: 700;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  label {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--text);
    font-size: 11px;
  }
  label span {
    flex: none;
    width: 34px;
    color: var(--text-dim);
  }
  .metrics span {
    width: 14px;
  }
  input,
  select {
    min-width: 0;
    width: 100%;
    height: 24px;
    border: 1px solid var(--border-soft);
    border-radius: 3px;
    background: var(--bg-elevated);
    color: var(--text-bright);
    font-size: 11px;
  }
  input {
    padding: 0 6px;
  }
  input[type='range'] {
    padding: 0;
  }
  .field b {
    width: 38px;
    text-align: right;
    color: var(--text-bright);
    font-size: 11px;
  }
  p {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
  }
  .lock-note {
    color: #f2c14e;
    font-size: 11px;
  }
</style>
