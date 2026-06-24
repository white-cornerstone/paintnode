<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';

  let { onClose }: { onClose: () => void } = $props();
  let brightness = $state(0);
  let contrast = $state(0);

  function apply() {
    editor.adjustBrightnessContrast(brightness, contrast);
    onClose();
  }
</script>

<Modal title="Brightness / Contrast" {onClose} width={360}>
  <div class="dlg-form">
    <label class="dlg-slider">
      <span>Brightness</span>
      <input type="range" min="-100" max="100" bind:value={brightness} />
      <span class="val">{brightness}</span>
    </label>
    <label class="dlg-slider">
      <span>Contrast</span>
      <input type="range" min="-100" max="100" bind:value={contrast} />
      <span class="val">{contrast}</span>
    </label>
    <div class="dlg-actions">
      <button onclick={onClose}>Cancel</button>
      <button class="dlg-primary" onclick={apply}>Apply</button>
    </div>
  </div>
</Modal>
