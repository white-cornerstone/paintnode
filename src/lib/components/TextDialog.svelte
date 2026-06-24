<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';

  let { onClose }: { onClose: () => void } = $props();

  let text = $state('Hello');
  let size = $state(72);
  let family = $state('sans-serif');

  function add() {
    editor.addText(text, size, family);
    onClose();
  }
</script>

<Modal title="Add Text" {onClose} width={440}>
  <div class="dlg-form">
    <label class="dlg-field">
      <span>Text</span>
      <!-- svelte-ignore a11y_autofocus -->
      <textarea bind:value={text} rows="3" autofocus></textarea>
    </label>
    <div class="dlg-row">
      <label class="dlg-field"><span>Size (px)</span>
        <input type="number" min="4" max="800" bind:value={size} />
      </label>
      <label class="dlg-field"><span>Font</span>
        <select bind:value={family}>
          <option value="sans-serif">Sans-serif</option>
          <option value="serif">Serif</option>
          <option value="monospace">Monospace</option>
          <option value="Impact, sans-serif">Impact</option>
          <option value="Georgia, serif">Georgia</option>
        </select>
      </label>
    </div>
    <p class="note">Text uses the current foreground color and is added as a new layer.</p>
    <div class="dlg-actions">
      <button onclick={onClose}>Cancel</button>
      <button class="dlg-primary" onclick={add}>Add</button>
    </div>
  </div>
</Modal>

<style>
  .note {
    margin: 0;
    color: var(--text-dim);
    font-size: 11px;
  }
</style>
