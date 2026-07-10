<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../Icon.svelte';
  import { tooltip } from '../../actions/tooltip';
  import { CheckmarkCircle, Dismiss, Document, Image, Open, PaintBrush, Sparkle } from '../../icons';
  import {
    filterCreatorNodeDefinitions,
    paletteIndexAfterKey,
    type CreatorNodeDefinition,
    type CreatorNodeIconKey,
    type CreatorNodeType,
  } from '../../workflow';

  let {
    onAdd,
    onClose,
  }: {
    onAdd: (type: CreatorNodeType) => void;
    onClose: () => void;
  } = $props();

  let query = $state('');
  let activeIndex = $state(0);
  let searchInput = $state<HTMLInputElement>();
  const items = $derived(filterCreatorNodeDefinitions(query));

  $effect(() => {
    query;
    activeIndex = items.length > 0 ? Math.min(Math.max(activeIndex, 0), items.length - 1) : -1;
  });

  onMount(() => searchInput?.focus());

  function iconFor(key: CreatorNodeIconKey): string {
    if (key === 'image') return Image;
    if (key === 'document') return Document;
    if (key === 'paint-brush') return PaintBrush;
    if (key === 'sparkle') return Sparkle;
    if (key === 'review') return CheckmarkCircle;
    return Open;
  }

  function optionId(definition: CreatorNodeDefinition): string {
    return `creator-palette-${definition.type}`;
  }

  function choose(index = activeIndex): void {
    const definition = items[index];
    if (definition) onAdd(definition.type);
  }

  function onSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    activeIndex = paletteIndexAfterKey(activeIndex, event.key, items.length);
  }
</script>

<div class="node-palette" role="dialog" aria-label="Add workflow node">
  <header>
    <strong>Add node</strong>
    <button type="button" aria-label="Close node palette" use:tooltip={{ text: 'Close palette', placement: 'left' }} onclick={onClose}>
      <Icon svg={Dismiss} size={14} />
    </button>
  </header>
  <input
    bind:this={searchInput}
    bind:value={query}
    type="search"
    placeholder="Search creator nodes…"
    aria-label="Search creator nodes"
    aria-controls="creator-node-options"
    aria-activedescendant={activeIndex >= 0 && items[activeIndex] ? optionId(items[activeIndex]) : undefined}
    onkeydown={onSearchKeydown}
  />
  <div id="creator-node-options" class="node-options" role="listbox" aria-label="Creator node types">
    {#each items as definition, index (definition.type)}
      <button
        id={optionId(definition)}
        type="button"
        role="option"
        aria-selected={index === activeIndex}
        class:active={index === activeIndex}
        onpointerenter={() => (activeIndex = index)}
        onclick={() => choose(index)}
      >
        <Icon svg={iconFor(definition.iconKey)} size={18} />
        <span>
          <b>{definition.label}</b>
          <small>{definition.description}</small>
          {#if definition.executor.status === 'draft-only'}
            <em>Draft only</em>
          {/if}
        </span>
      </button>
    {:else}
      <p role="status">No creator nodes match “{query}”.</p>
    {/each}
  </div>
  <footer>↑↓ navigate · Enter add · Esc close</footer>
</div>

<style>
  .node-palette {
    position: absolute;
    top: 34px;
    left: 8px;
    z-index: 40;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr) auto;
    width: min(300px, calc(100vw - 32px));
    max-height: min(430px, calc(100vh - 112px));
    padding: 8px;
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: var(--bg-panel);
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.42);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 26px;
    color: var(--text-bright);
    font-size: 12px;
  }
  header button {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
  }
  input {
    width: 100%;
    height: 29px;
    margin: 4px 0 7px;
    font-size: 11px;
  }
  .node-options {
    min-height: 0;
    overflow-y: auto;
  }
  .node-options button {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 7px;
    width: 100%;
    min-height: 54px;
    padding: 7px;
    border-color: transparent;
    background: transparent;
    text-align: left;
  }
  .node-options button.active,
  .node-options button:hover {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-elevated));
  }
  .node-options span {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .node-options b {
    color: var(--text-bright);
    font-size: 11px;
  }
  .node-options small {
    color: var(--text-dim);
    font-size: 10px;
    line-height: 1.25;
  }
  .node-options em {
    justify-self: start;
    color: #ffd38a;
    font-size: 9px;
    font-style: normal;
    font-weight: 700;
    text-transform: uppercase;
  }
  .node-options p {
    margin: 14px 6px;
    color: var(--text-dim);
    font-size: 11px;
  }
  footer {
    padding-top: 7px;
    color: var(--text-dim);
    font-size: 9px;
    text-align: center;
  }
</style>
