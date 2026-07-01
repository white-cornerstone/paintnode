<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import Icon from './Icon.svelte';
  import Panel from './Panel.svelte';
  import { ArrowTrending, Branch, CommentNote, Tag, Textbox } from '../icons';
  import type { AnnotationItem } from '../engine/annotations';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  const annotationPaths = $derived(editor.doc?.annotations ?? []);

  function iconFor(item: AnnotationItem): string {
    if (item.kind === 'arrow') return ArrowTrending;
    if (item.kind === 'badge') return Tag;
    if (item.kind === 'divider') return Textbox;
    return CommentNote;
  }
</script>

<Panel title="Paths" bind:collapsed {onToggle}>
  <div class="paths">
    {#if annotationPaths.length}
      {#each annotationPaths as item (item.id)}
        <button class="path" class:active={editor.selectedAnnotationId === item.id} onclick={() => editor.selectAnnotation(item.id)}>
          <Icon svg={iconFor(item)} size={15} />
          <span>{item.text.trim() || item.kind}</span>
        </button>
      {/each}
    {:else}
      <div class="empty">
        <Icon svg={Branch} size={18} />
        <span>No vector paths in this document.</span>
      </div>
    {/if}
  </div>
</Panel>

<style>
  .paths {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
  }
  .path {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    padding: 6px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    text-align: left;
  }
  .path:hover,
  .path.active {
    background: var(--bg-elevated);
    border-color: var(--border-soft);
    color: var(--text-bright);
  }
  .path span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 42px;
    color: var(--text-dim);
    font-size: 12px;
  }
</style>
