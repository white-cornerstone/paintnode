<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import { ChevronDown, ChevronRight } from '../icons';

  let {
    title,
    grow = false,
    collapsed = $bindable(false),
    onToggle,
    actions,
    children,
  }: {
    title: string;
    grow?: boolean;
    collapsed?: boolean;
    onToggle?: (collapsed: boolean) => void;
    actions?: Snippet;
    children: Snippet;
  } = $props();

  function toggle() {
    const next = !collapsed;
    if (onToggle) onToggle(next);
    else collapsed = next;
  }
</script>

<section class="panel" class:grow class:collapsed>
  <div class="panel-head">
    <button
      class="panel-h"
      onclick={toggle}
      aria-expanded={!collapsed}
      title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
    >
      <span class="chev"><Icon svg={collapsed ? ChevronRight : ChevronDown} size={12} /></span>
      <span class="title">{title}</span>
    </button>
    {#if actions && !collapsed}
      <div class="panel-actions">
        {@render actions()}
      </div>
    {/if}
  </div>
  {#if !collapsed}
    <div class="panel-body">{@render children()}</div>
  {/if}
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    flex: none;
    border-bottom: 1px solid var(--border);
    min-height: 0;
  }
  .panel.grow:not(.collapsed) {
    flex: 1;
  }
  .panel-head {
    display: flex;
    align-items: center;
    min-width: 0;
    background: var(--bg-panel-2);
  }
  .panel-h {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 5px;
    min-width: 0;
    text-align: left;
    padding: 6px 9px;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--text-bright);
    font-weight: 600;
    cursor: pointer;
  }
  .panel-h:hover {
    background: var(--bg-elevated);
  }
  .panel-actions {
    display: flex;
    flex: none;
    align-items: center;
    padding-right: 7px;
  }
  .chev {
    display: inline-flex;
    color: var(--text-dim);
  }
  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .panel-body {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .panel.grow .panel-body {
    flex: 1;
    min-height: 0;
  }
</style>
