<script lang="ts">
  import { tick } from 'svelte';
  import Icon from '../Icon.svelte';
  import { tooltip } from '../../actions/tooltip';
  import { Dismiss } from '../../icons';

  let {
    name,
    fallback = 'Untitled',
    onBegin,
    onCommit,
  }: {
    name: string;
    fallback?: string;
    onBegin?: () => void;
    onCommit: (name: string) => void;
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let original = $state('');
  let inputElement = $state<HTMLInputElement | null>(null);
  let canceling = false;
  let blurCommitTimer: number | null = null;

  async function begin(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    original = name || fallback;
    draft = original;
    canceling = false;
    if (blurCommitTimer !== null) window.clearTimeout(blurCommitTimer);
    blurCommitTimer = null;
    editing = true;
    onBegin?.();
    await tick();
    inputElement?.focus();
    inputElement?.select();
  }

  function commit(): void {
    if (!editing || canceling) return;
    if (blurCommitTimer !== null) window.clearTimeout(blurCommitTimer);
    blurCommitTimer = null;
    editing = false;
    onCommit(draft.trim() || fallback);
  }

  function scheduleBlurCommit(): void {
    if (blurCommitTimer !== null) window.clearTimeout(blurCommitTimer);
    blurCommitTimer = window.setTimeout(() => {
      blurCommitTimer = null;
      commit();
    }, 75);
  }

  function cancel(): void {
    if (!editing) return;
    canceling = true;
    if (blurCommitTimer !== null) window.clearTimeout(blurCommitTimer);
    blurCommitTimer = null;
    draft = original;
    editing = false;
  }

  function editorKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }

  $effect(() => () => {
    if (blurCommitTimer !== null) window.clearTimeout(blurCommitTimer);
  });
</script>

<span class="title-editor" class:editing>
  {#if editing}
    <input
      bind:this={inputElement}
      bind:value={draft}
      aria-label={`Edit node name: ${original || fallback}`}
      onpointerdown={(event) => event.stopPropagation()}
      onkeydown={editorKeydown}
      onblur={scheduleBlurCommit}
    />
    <button
      type="button"
      class="cancel"
      aria-label="Cancel node name edit"
      use:tooltip={{ text: 'Revert name', placement: 'top' }}
      onpointerdown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
      onclick={(event) => {
        event.stopPropagation();
        cancel();
      }}
    ><Icon svg={Dismiss} size={11} /></button>
  {:else}
    <button
      type="button"
      class="name"
      aria-label={`Rename node: ${name || fallback}`}
      use:tooltip={{ text: 'Rename node', placement: 'top' }}
      onpointerdown={(event) => event.stopPropagation()}
      onclick={(event) => void begin(event)}
    >{name || fallback}</button>
  {/if}
</span>

<style>
  .title-editor {
    display: inline-flex;
    align-items: center;
    min-width: 0;
    max-width: 100%;
  }
  .title-editor.editing {
    flex: 1;
    gap: 3px;
  }
  .name {
    display: block;
    width: auto;
    max-width: 100%;
    height: 24px;
    padding: 0 2px;
    overflow: hidden;
    border: 1px solid transparent;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: text;
  }
  .name:hover,
  .name:focus-visible {
    border-color: color-mix(in srgb, var(--text-bright) 28%, transparent);
    background: rgb(0 0 0 / 12%);
    outline: none;
  }
  input {
    min-width: 0;
    width: 100%;
    height: 24px;
    padding: 0 5px;
    border: 1px solid var(--accent);
    border-radius: 3px;
    background: var(--bg-input);
    color: var(--text-bright);
    font: inherit;
    font-weight: 600;
  }
  .cancel {
    display: grid;
    place-items: center;
    flex: none;
    width: 18px;
    height: 18px;
    padding: 0;
    border-color: transparent;
    background: rgb(0 0 0 / 16%);
    color: var(--text-dim);
  }
  .cancel:hover,
  .cancel:focus-visible {
    color: var(--text-bright);
    border-color: var(--border-soft);
  }
</style>
