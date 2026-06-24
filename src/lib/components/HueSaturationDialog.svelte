<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';

  let { onClose }: { onClose: () => void } = $props();
  let hue = $state(0);
  let saturation = $state(0);
  let lightness = $state(0);

  function apply() {
    editor.adjustHueSaturation(hue, saturation, lightness);
    onClose();
  }
</script>

<Modal title="Hue / Saturation" {onClose} width={360}>
  <div class="dlg-form">
    <label class="dlg-slider">
      <span>Hue</span>
      <input type="range" min="-180" max="180" bind:value={hue} />
      <span class="val">{hue}°</span>
    </label>
    <label class="dlg-slider">
      <span>Saturation</span>
      <input type="range" min="-100" max="100" bind:value={saturation} />
      <span class="val">{saturation}</span>
    </label>
    <label class="dlg-slider">
      <span>Lightness</span>
      <input type="range" min="-100" max="100" bind:value={lightness} />
      <span class="val">{lightness}</span>
    </label>
    <div class="dlg-actions">
      <button onclick={onClose}>Cancel</button>
      <button class="dlg-primary" onclick={apply}>Apply</button>
    </div>
  </div>
</Modal>
