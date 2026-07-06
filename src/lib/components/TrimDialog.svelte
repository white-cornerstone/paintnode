<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor, type TrimBasis } from '../state/editor.svelte';

  let { onClose }: { onClose: () => void } = $props();

  let basis = $state<TrimBasis>('transparent');
  let top = $state(true);
  let bottom = $state(true);
  let left = $state(true);
  let right = $state(true);

  function apply() {
    editor.trimImage({ basis, top, bottom, left, right });
    onClose();
  }
</script>

<Modal title="Trim" {onClose} width={420}>
  <div class="trim-form">
    <section>
      <h3>Based on</h3>
      <label><input type="radio" bind:group={basis} value="transparent" /> Transparent pixels</label>
      <label><input type="radio" bind:group={basis} value="top-left" /> Top left pixel color</label>
      <label><input type="radio" bind:group={basis} value="bottom-right" /> Bottom right pixel color</label>
    </section>

    <section>
      <h3>Trim away</h3>
      <div class="side-grid">
        <label><input type="checkbox" bind:checked={top} /> Top</label>
        <label><input type="checkbox" bind:checked={left} /> Left</label>
        <label><input type="checkbox" bind:checked={bottom} /> Bottom</label>
        <label><input type="checkbox" bind:checked={right} /> Right</label>
      </div>
    </section>

    <div class="dlg-actions">
      <button type="button" onclick={onClose}>Cancel</button>
      <button type="button" class="dlg-primary" onclick={apply}>OK</button>
    </div>
  </div>
</Modal>

<style>
  .trim-form {
    display: grid;
    gap: 14px;
  }
  section {
    display: grid;
    gap: 9px;
  }
  h3 {
    margin: 0;
    font-size: 12px;
    color: var(--text);
  }
  label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-dim);
  }
  .side-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px 18px;
  }
</style>
