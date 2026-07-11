<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { ui } from '../state/ui.svelte';
  import { DocumentSave } from '../icons';

  const prompt = $derived(ui.saveChanges);
  const itemLabel = $derived(prompt?.kind === 'workflow' ? 'workflow' : 'document');
  const isWorkflowReturn = $derived(prompt?.kind === 'workflow-return');
  const progress = $derived(prompt && prompt.total > 1 ? `${prompt.index} of ${prompt.total}` : '');
</script>

{#if prompt}
  <Modal title="Save Changes?" onClose={() => ui.resolveSaveChanges('cancel')} width={500}>
    <div class="save-prompt">
      <div class="icon" aria-hidden="true">
        <Icon svg={DocumentSave} size={32} />
      </div>
      <div class="message">
        {#if progress}
          <div class="progress">{progress}</div>
        {/if}
        <p class="question">
          {isWorkflowReturn
            ? `Return changes in "${prompt.name}" to the workflow before closing?`
            : `Save changes to the PaintNode ${itemLabel} "${prompt.name}" before closing?`}
        </p>
        <p class="note">{isWorkflowReturn ? 'If you discard them, these editor changes will not update the workflow.' : "If you don't save, your changes will be lost."}</p>
      </div>
    </div>
    <div class="dlg-actions">
      <button onclick={() => ui.resolveSaveChanges('discard')}>{isWorkflowReturn ? 'Discard' : "Don't Save"}</button>
      <button onclick={() => ui.resolveSaveChanges('cancel')}>Cancel</button>
      <button class="dlg-primary" onclick={() => ui.resolveSaveChanges('save')}>{isWorkflowReturn ? 'Return to Workflow' : 'Save'}</button>
    </div>
  </Modal>
{/if}

<style>
  .save-prompt {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 12px;
    align-items: start;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 42px;
    height: 42px;
    color: var(--text);
  }
  .message {
    min-width: 0;
  }
  .progress {
    margin-bottom: 4px;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.35;
  }
  .question {
    margin: 0;
    color: var(--text-bright);
    font-size: 13px;
    line-height: 1.45;
  }
  .note {
    margin: 8px 0 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.45;
  }
  .dlg-actions {
    margin-top: 18px;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .dlg-actions button {
    min-width: 96px;
  }
</style>
