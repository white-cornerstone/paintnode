<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';

  let { onClose }: { onClose: () => void } = $props();
  let radius = $state(4);

  function apply() {
    editor.filterGaussianBlur(radius);
    onClose();
  }
</script>

<Modal title="Gaussian Blur" {onClose} width={340}>
  <div class="dlg-form">
    <label class="dlg-slider">
      <span>Radius</span>
      <input type="range" min="0" max="50" step="0.5" bind:value={radius} />
      <span class="val">{radius}px</span>
    </label>
    <div class="dlg-actions">
      <button onclick={onClose}>Cancel</button>
      <button class="dlg-primary" onclick={apply}>Apply</button>
    </div>
  </div>
</Modal>
