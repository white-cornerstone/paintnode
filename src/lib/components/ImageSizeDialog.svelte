<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor, type ImageResampleMethod } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';

  let { onClose }: { onClose: () => void } = $props();

  const ratio = (editor.doc?.width ?? 1) / (editor.doc?.height ?? 1);
  const originalW = editor.doc?.width ?? 1280;
  const originalH = editor.doc?.height ?? 800;
  let w = $state(originalW);
  let h = $state(originalH);
  let linked = $state(true);
  let fitTo = $state('original');
  let resample = $state<ImageResampleMethod>('automatic');

  const imageSize = $derived(`${((w * h * 4) / (1024 * 1024)).toFixed(2)}M`);

  function onW(v: number) {
    w = Math.max(1, Math.round(v || 1));
    if (linked) h = Math.max(1, Math.round(v / ratio));
  }
  function onH(v: number) {
    h = Math.max(1, Math.round(v || 1));
    if (linked) w = Math.max(1, Math.round(v * ratio));
  }
  function applyFit(value: string) {
    fitTo = value;
    if (value === 'original') {
      w = originalW;
      h = originalH;
    } else if (value === 'half') {
      w = Math.max(1, Math.round(originalW / 2));
      h = Math.max(1, Math.round(originalH / 2));
    } else if (value === 'double') {
      w = originalW * 2;
      h = originalH * 2;
    }
  }
  function openUpscale() {
    onClose();
    ui.open('aiUpscale');
  }
  function apply() {
    editor.resizeImage(w, h, resample);
    onClose();
  }
</script>

<Modal title="Image Size" {onClose} width={460}>
  <div class="image-size-form">
    <div class="summary">
      <span>Image Size:</span>
      <strong>{imageSize}</strong>
    </div>
    <div class="dimensions">
      <span>Dimensions</span>
      <strong>{w} px × {h} px</strong>
    </div>
    <label class="dlg-field">
      <span>Fit To</span>
      <select value={fitTo} onchange={(e) => applyFit(e.currentTarget.value)}>
        <option value="original">Original Size</option>
        <option value="half">50%</option>
        <option value="double">200%</option>
        <option value="custom">Custom</option>
      </select>
    </label>
    <div class="size-grid">
      <button
        type="button"
        class:active={linked}
        aria-pressed={linked}
        aria-label="Constrain proportions"
        onclick={() => (linked = !linked)}
      >
        Link
      </button>
      <label class="dlg-field"><span>Width</span>
        <input type="number" min="1" max="32768" value={w} oninput={(e) => { fitTo = 'custom'; onW(+e.currentTarget.value); }} />
      </label>
      <label class="dlg-field"><span>Units</span>
        <select disabled><option>Pixels</option></select>
      </label>
      <span></span>
      <label class="dlg-field"><span>Height</span>
        <input type="number" min="1" max="32768" value={h} oninput={(e) => { fitTo = 'custom'; onH(+e.currentTarget.value); }} />
      </label>
      <label class="dlg-field"><span>Units</span>
        <select disabled><option>Pixels</option></select>
      </label>
    </div>
    <label class="chk">
      <input type="checkbox" checked disabled />
      <span>Resample</span>
      <select bind:value={resample} aria-label="Resample method">
        <option value="automatic">Automatic</option>
        <option value="bicubic">Bicubic smoother</option>
        <option value="nearest">Nearest neighbor</option>
      </select>
    </label>
    <div class="upscale-callout">
      <span>Create a larger document with restored detail</span>
      <button type="button" onclick={openUpscale}>Open AI Upscale...</button>
    </div>
    <div class="dlg-actions">
      <button onclick={onClose}>Cancel</button>
      <button class="dlg-primary" onclick={apply}>Resize</button>
    </div>
  </div>
</Modal>

<style>
  .image-size-form {
    display: grid;
    gap: 12px;
  }
  .summary,
  .dimensions {
    display: flex;
    justify-content: space-between;
    color: var(--text-dim);
  }
  .summary strong,
  .dimensions strong {
    color: var(--text);
  }
  .size-grid {
    display: grid;
    grid-template-columns: 54px 1fr 130px;
    gap: 8px;
    align-items: end;
  }
  .size-grid button {
    align-self: center;
  }
  .size-grid button.active {
    border-color: var(--accent);
    color: var(--accent);
  }
  .chk {
    display: grid;
    grid-template-columns: auto auto 1fr;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
  }
  .upscale-callout {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    color: var(--text-dim);
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  .upscale-callout button {
    color: var(--accent);
  }
</style>
