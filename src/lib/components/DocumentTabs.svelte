<script lang="ts">
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { Dismiss } from '../icons';
  import { editor, type DocumentSession } from '../state/editor.svelte';

  function label(session: DocumentSession): string {
    const zoom = editor.activeDocumentId === session.id ? Math.round((editor.viewport?.scale ?? 1) * 100) : 100;
    const dirty = editor.hasUnsavedChanges(session) ? ' *' : '';
    return `${session.doc.name || 'Untitled'}${dirty} @ ${zoom}%`;
  }
</script>

<div class="doc-tabs" role="tablist" aria-label="Open documents">
  {#each editor.documentTabs as session (session.id)}
    <div class="tab" class:active={editor.activeDocumentId === session.id} role="presentation">
      <button
        class="tab-main"
        role="tab"
        aria-selected={editor.activeDocumentId === session.id}
        onclick={() => editor.switchDocument(session.id)}
      >
        <span>{label(session)}</span>
      </button>
      <button
        class="tab-close"
        aria-label={`Close ${session.doc.name || 'document'}`}
        use:tooltip={{ text: `Close ${session.doc.name || 'document'}`, placement: 'bottom' }}
        onclick={(e) => {
          e.stopPropagation();
          editor.closeDocument(session.id);
        }}
      >
        <Icon svg={Dismiss} size={13} />
      </button>
    </div>
  {/each}
</div>

<style>
  .doc-tabs {
    display: flex;
    flex: none;
    height: 32px;
    min-width: 0;
    overflow-x: auto;
    overflow-y: hidden;
    background: #262626;
    border-bottom: 1px solid var(--border);
  }
  .tab {
    display: flex;
    align-items: center;
    min-width: 140px;
    max-width: 260px;
    border-right: 1px solid var(--border);
    background: var(--bg-panel);
    color: var(--text-dim);
  }
  .tab.active {
    background: var(--bg-elevated);
    color: var(--text-bright);
  }
  .tab-main {
    flex: 1;
    min-width: 0;
    height: 31px;
    padding: 0 8px 0 10px;
    border: 0;
    border-radius: 0;
    background: transparent;
    text-align: left;
    color: inherit;
  }
  .tab-main span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tab-close {
    display: grid;
    place-items: center;
    width: 26px;
    height: 31px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
  }
  .tab-main:hover,
  .tab-close:hover {
    background: rgba(255, 255, 255, 0.06);
  }
</style>
