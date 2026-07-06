<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';

  let { onClose }: { onClose: () => void } = $props();
  let threshold = $state(128);

  function apply() {
    editor.adjustThreshold(threshold);
    onClose();
  }
</script>

<Modal title="Threshold" {onClose} width={360}>
  <div class="dlg-form">
    <label class="dlg-slider">
      <span>Threshold</span>
      <input type="range" min="0" max="255" bind:value={threshold} />
      <input type="number" min="0" max="255" bind:value={threshold} />
    </label>
    <div class="dlg-actions">
      <button type="button" onclick={onClose}>Cancel</button>
      <button type="button" class="dlg-primary" onclick={apply}>Apply</button>
    </div>
  </div>
</Modal>

<style>
  .dlg-slider {
    grid-template-columns: 78px 1fr 70px;
  }
</style>
