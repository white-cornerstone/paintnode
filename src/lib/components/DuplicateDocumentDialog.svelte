<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';

  let { onClose }: { onClose: () => void } = $props();

  let name = $state(`${editor.doc?.name ?? 'Untitled'} copy`);
  let merged = $state(false);

  function apply() {
    editor.duplicateDocument(name, merged);
    onClose();
  }
</script>

<Modal title="Duplicate Document" {onClose} width={380}>
  <div class="dlg-form">
    <label class="dlg-field">
      <span>Name</span>
      <input bind:value={name} />
    </label>
    <label class="check"><input type="checkbox" bind:checked={merged} /> Duplicate merged image only</label>
    <div class="dlg-actions">
      <button type="button" onclick={onClose}>Cancel</button>
      <button type="button" class="dlg-primary" onclick={apply}>Duplicate</button>
    </div>
  </div>
</Modal>

<style>
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-dim);
  }
</style>
