<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor, type CanvasAnchor, type CanvasExtensionFill } from '../state/editor.svelte';

  let { onClose }: { onClose: () => void } = $props();

  const originalW = editor.doc?.width ?? 1280;
  const originalH = editor.doc?.height ?? 800;
  let w = $state(originalW);
  let h = $state(originalH);
  let relative = $state(false);
  let anchor = $state<CanvasAnchor>('center');
  let fillKind = $state<CanvasExtensionFill['kind']>('transparent');
  let customColor = $state('#ffffff');

  const newW = $derived(relative ? Math.max(1, originalW + Math.round(w || 0)) : Math.max(1, Math.round(w || 1)));
  const newH = $derived(relative ? Math.max(1, originalH + Math.round(h || 0)) : Math.max(1, Math.round(h || 1)));
  const newSize = $derived(`${((newW * newH * 4) / (1024 * 1024)).toFixed(2)}M`);
  const swatch = $derived(
    fillKind === 'foreground'
      ? editor.foregroundCss
      : fillKind === 'background'
        ? editor.backgroundCss
        : fillKind === 'white'
          ? '#ffffff'
          : fillKind === 'black'
            ? '#000000'
            : fillKind === 'gray'
              ? '#808080'
              : fillKind === 'custom'
                ? customColor
                : 'transparent',
  );

  const anchors: { value: CanvasAnchor; label: string }[] = [
    { value: 'top-left', label: 'Top left' },
    { value: 'top', label: 'Top' },
    { value: 'top-right', label: 'Top right' },
    { value: 'left', label: 'Left' },
    { value: 'center', label: 'Center' },
    { value: 'right', label: 'Right' },
    { value: 'bottom-left', label: 'Bottom left' },
    { value: 'bottom', label: 'Bottom' },
    { value: 'bottom-right', label: 'Bottom right' },
  ];

  function fill(): CanvasExtensionFill {
    return fillKind === 'custom' ? { kind: 'custom', color: customColor } : { kind: fillKind };
  }

  function apply() {
    editor.resizeCanvas(newW, newH, anchor, fill());
    onClose();
  }
</script>

<Modal title="Canvas Size" {onClose} width={520}>
  <div class="canvas-form">
    <section class="summary">
      <strong>Current Size: {((originalW * originalH * 4) / (1024 * 1024)).toFixed(2)}M</strong>
      <span>Width {originalW} px</span>
      <span>Height {originalH} px</span>
    </section>

    <section class="summary">
      <strong>New Size: {newSize}</strong>
      <div class="size-row">
        <label class="dlg-field">
          <span>Width</span>
          <input type="number" step="1" value={w} oninput={(e) => (w = e.currentTarget.valueAsNumber)} />
        </label>
        <label class="dlg-field">
          <span>Units</span>
          <select disabled><option>Pixels</option></select>
        </label>
      </div>
      <div class="size-row">
        <label class="dlg-field">
          <span>Height</span>
          <input type="number" step="1" value={h} oninput={(e) => (h = e.currentTarget.valueAsNumber)} />
        </label>
        <label class="dlg-field">
          <span>Units</span>
          <select disabled><option>Pixels</option></select>
        </label>
      </div>
      <label class="check"><input type="checkbox" bind:checked={relative} /> Relative to current dimensions</label>
    </section>

    <section class="anchor-section">
      <span>Anchor</span>
      <div class="anchor-grid" role="radiogroup" aria-label="Canvas anchor">
        {#each anchors as item (item.value)}
          <button
            type="button"
            class:active={anchor === item.value}
            aria-label={item.label}
            aria-pressed={anchor === item.value}
            onclick={() => (anchor = item.value)}
          ></button>
        {/each}
      </div>
    </section>

    <section class="extension-row">
      <label class="dlg-field">
        <span>Canvas extension color</span>
        <select bind:value={fillKind}>
          <option value="transparent">Transparent</option>
          <option value="foreground">Foreground</option>
          <option value="background">Background</option>
          <option value="white">White</option>
          <option value="black">Black</option>
          <option value="gray">Gray</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <span class="swatch" style:background={swatch}></span>
      {#if fillKind === 'custom'}
        <input class="color" type="color" bind:value={customColor} aria-label="Custom canvas extension color" />
      {/if}
    </section>

    <div class="dlg-actions">
      <button type="button" onclick={onClose}>Cancel</button>
      <button type="button" class="dlg-primary" onclick={apply}>OK</button>
    </div>
  </div>
</Modal>

<style>
  .canvas-form {
    display: grid;
    gap: 14px;
  }
  .summary {
    display: grid;
    gap: 8px;
    color: var(--text-dim);
    border-bottom: 1px solid var(--border);
    padding-bottom: 10px;
  }
  .summary strong {
    color: var(--text);
  }
  .size-row {
    display: grid;
    grid-template-columns: 1fr 140px;
    gap: 10px;
  }
  .check,
  .anchor-section,
  .extension-row {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--text-dim);
  }
  .anchor-grid {
    display: grid;
    grid-template-columns: repeat(3, 34px);
    border: 1px solid var(--border);
  }
  .anchor-grid button {
    width: 34px;
    height: 34px;
    border: 0;
    border-radius: 0;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    background: transparent;
  }
  .anchor-grid button:nth-child(3n) {
    border-right: 0;
  }
  .anchor-grid button:nth-child(n + 7) {
    border-bottom: 0;
  }
  .anchor-grid button.active::after {
    content: '';
    display: block;
    width: 9px;
    height: 9px;
    margin: auto;
    border-radius: 50%;
    background: var(--accent);
  }
  .extension-row {
    align-items: end;
  }
  .extension-row .dlg-field {
    flex: 1;
  }
  .swatch {
    width: 40px;
    height: 28px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background-image:
      linear-gradient(45deg, #555 25%, transparent 25%),
      linear-gradient(-45deg, #555 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #555 75%),
      linear-gradient(-45deg, transparent 75%, #555 75%);
    background-size: 12px 12px;
    background-position: 0 0, 0 6px, 6px -6px, -6px 0;
  }
  .color {
    width: 40px;
    height: 28px;
  }
</style>
