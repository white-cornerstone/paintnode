<script lang="ts">
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { Dismiss } from '../icons';
  import { filesFromDataTransfer, hasFileDrag } from '../io';
  import { openDocumentFiles, saveDocumentCommand } from '../state/commands';
  import { editor, type DocumentSession } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { workflow } from '../state/workflow.svelte';

  let dragOverTabs = $state(false);

  function documentName(session: DocumentSession): string {
    return editor.documentFileName(session);
  }

  function documentNameWithMarker(session: DocumentSession): string {
    const dirty = editor.hasUnsavedChanges(session) ? ' *' : '';
    return `${documentName(session)}${dirty}`;
  }

  function label(session: DocumentSession): string {
    const zoom =
      ui.activeSurface === 'document' && editor.activeDocumentId === session.id
        ? Math.round((editor.viewport?.scale ?? 1) * 100)
        : 100;
    return `${documentNameWithMarker(session)} @ ${zoom}%`;
  }

  function documentTooltip(session: DocumentSession): string {
    return documentNameWithMarker(session);
  }

  function workflowLabel(): string {
    return `${workflow.name || 'Untitled Workflow'}${workflow.dirty ? ' *' : ''}`;
  }

  function onTabsDragOver(event: DragEvent): void {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragOverTabs = true;
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }

  function onTabsDragLeave(event: DragEvent): void {
    const root = event.currentTarget as HTMLElement;
    const next = event.relatedTarget as Node | null;
    if (next && root.contains(next)) return;
    dragOverTabs = false;
  }

  async function onTabsDrop(event: DragEvent): Promise<void> {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    dragOverTabs = false;
    const files = filesFromDataTransfer(event.dataTransfer);
    if (files.length) await openDocumentFiles(files);
  }

  async function closeDocumentTab(session: DocumentSession): Promise<void> {
    if (!editor.hasUnsavedChanges(session)) {
      editor.closeDocument(session.id);
      return;
    }

    editor.switchDocument(session.id);
    const choice = await ui.askSaveChanges({
      kind: session.workflowReturnState ? 'workflow-return' : 'document',
      name: documentName(session),
      index: 1,
      total: 1,
    });
    if (choice === 'cancel') return;
    if (choice === 'save') {
      await saveDocumentCommand();
      const updated = editor.documents.find((documentSession) => documentSession.id === session.id);
      if (updated && editor.hasUnsavedChanges(updated)) return;
    }
    editor.closeDocument(session.id);
  }
</script>

<div
  class="doc-tabs"
  class:dragover={dragOverTabs}
  role="tablist"
  aria-label="Open documents"
  tabindex="-1"
  ondragenter={onTabsDragOver}
  ondragover={onTabsDragOver}
  ondragleave={onTabsDragLeave}
  ondrop={onTabsDrop}
>
  {#each editor.documentTabs as session (session.id)}
    <div
      class="tab"
      class:active={ui.activeSurface === 'document' && editor.activeDocumentId === session.id}
      role="presentation"
    >
      <button
        class="tab-main"
        role="tab"
        aria-selected={ui.activeSurface === 'document' && editor.activeDocumentId === session.id}
        aria-label={label(session)}
        use:tooltip={{ text: documentTooltip(session), placement: 'bottom' }}
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
          void closeDocumentTab(session);
        }}
      >
        <Icon svg={Dismiss} size={13} />
      </button>
    </div>
  {/each}
  {#if workflow.active}
    <div class="tab workflow-tab" class:active={ui.activeSurface === 'workflow'} role="presentation">
      <button
        class="tab-main"
        role="tab"
        aria-selected={ui.activeSurface === 'workflow'}
        aria-label={workflowLabel()}
        use:tooltip={{ text: workflowLabel(), placement: 'bottom' }}
        onclick={() => workflow.show()}
      >
        <span>{workflowLabel()}</span>
      </button>
      <button
        class="tab-close"
        aria-label={`Close ${workflow.name || 'workflow'}`}
        use:tooltip={{ text: `Close ${workflow.name || 'workflow'}`, placement: 'bottom' }}
        onclick={(e) => {
          e.stopPropagation();
          workflow.close();
        }}
      >
        <Icon svg={Dismiss} size={13} />
      </button>
    </div>
  {/if}
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
  .doc-tabs.dragover {
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .tab {
    display: flex;
    align-items: center;
    flex: 0 1 max-content;
    min-width: 128px;
    max-width: 100%;
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
