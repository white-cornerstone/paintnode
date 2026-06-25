<script lang="ts">
  import Modal from './Modal.svelte';
  import { ui } from '../state/ui.svelte';

  const prompt = $derived(ui.fontEmbed);
</script>

{#if prompt}
  <Modal title="Embed fonts?" onClose={() => ui.resolveFontEmbed(null)} width={480}>
    <div class="dlg-form">
      <p class="note">
        This document uses imported fonts. Embedding them keeps the text editable with the
        correct fonts on another machine. Either way the text looks correct (the rendered
        image is saved); without embedding, editing it elsewhere substitutes a system font.
      </p>
      <p class="fonts"><strong>Will embed:</strong> {prompt.embeddable.join(', ')}</p>
      {#if prompt.missing.length}
        <p class="fonts dim">
          <strong>Can’t embed (system fonts):</strong> {prompt.missing.join(', ')}
        </p>
      {/if}
      <div class="dlg-actions">
        <button onclick={() => ui.resolveFontEmbed(null)}>Cancel</button>
        <button onclick={() => ui.resolveFontEmbed('system')}>Use system fonts</button>
        <button class="dlg-primary" onclick={() => ui.resolveFontEmbed('embed')}>Embed fonts</button>
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
  .fonts {
    margin: 0;
    font-size: 12px;
    color: var(--text);
  }
  .fonts.dim {
    color: var(--text-dim);
  }
</style>
