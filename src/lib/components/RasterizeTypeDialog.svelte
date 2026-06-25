<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';

  const prompt = $derived(editor.rasterizePrompt);
</script>

{#if prompt}
  <Modal title="Rasterize type?" onClose={() => editor.dismissRasterize()} width={440}>
    <div class="dlg-form">
      <p class="note">
        “{prompt.name}” is an editable text layer. This tool paints pixels, so the layer must
        be rasterized first. You won’t be able to edit the text afterwards (this can be undone).
      </p>
      <div class="dlg-actions">
        <button onclick={() => editor.dismissRasterize()}>Cancel</button>
        <button class="dlg-primary" onclick={() => editor.confirmRasterize()}>Rasterize</button>
      </div>
    </div>
  </Modal>
{/if}

<style>
  .note {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.5;
  }
</style>
