<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';

  let { onClose }: { onClose: () => void } = $props();

  let inputBlack = $state(0);
  let gamma = $state(1);
  let inputWhite = $state(255);
  let outputBlack = $state(0);
  let outputWhite = $state(255);

  function apply() {
    editor.adjustLevels({ inputBlack, gamma, inputWhite, outputBlack, outputWhite });
    onClose();
  }
</script>

<Modal title="Levels" {onClose} width={420}>
  <div class="dlg-form">
    <fieldset>
      <legend>Input Levels</legend>
      <label class="dlg-slider">
        <span>Black</span>
        <input type="range" min="0" max="254" bind:value={inputBlack} />
        <input type="number" min="0" max="254" bind:value={inputBlack} />
      </label>
      <label class="dlg-slider">
        <span>Midtone</span>
        <input type="range" min="0.1" max="3" step="0.01" bind:value={gamma} />
        <input type="number" min="0.1" max="9.99" step="0.01" bind:value={gamma} />
      </label>
      <label class="dlg-slider">
        <span>White</span>
        <input type="range" min="1" max="255" bind:value={inputWhite} />
        <input type="number" min="1" max="255" bind:value={inputWhite} />
      </label>
    </fieldset>

    <fieldset>
      <legend>Output Levels</legend>
      <label class="dlg-slider">
        <span>Black</span>
        <input type="range" min="0" max="255" bind:value={outputBlack} />
        <input type="number" min="0" max="255" bind:value={outputBlack} />
      </label>
      <label class="dlg-slider">
        <span>White</span>
        <input type="range" min="0" max="255" bind:value={outputWhite} />
        <input type="number" min="0" max="255" bind:value={outputWhite} />
      </label>
    </fieldset>

    <div class="dlg-actions">
      <button type="button" onclick={onClose}>Cancel</button>
      <button type="button" class="dlg-primary" onclick={apply}>Apply</button>
    </div>
  </div>
</Modal>

<style>
  fieldset {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 5px;
  }
  legend {
    padding: 0 4px;
    color: var(--text);
    font-weight: 600;
  }
  .dlg-slider {
    grid-template-columns: 70px 1fr 70px;
  }
</style>
