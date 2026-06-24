<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import { ChevronDown, ChevronRight } from '../icons';

  let {
    title,
    grow = false,
    collapsed = $bindable(false),
    children,
  }: { title: string; grow?: boolean; collapsed?: boolean; children: Snippet } = $props();
</script>

<section class="panel" class:grow class:collapsed>
  <button
    class="panel-h"
    onclick={() => (collapsed = !collapsed)}
    aria-expanded={!collapsed}
    title={collapsed ? `Expand ${title}` : `Collapse ${title}`}
  >
    <span class="chev"><Icon svg={collapsed ? ChevronRight : ChevronDown} size={12} /></span>
    <span class="title">{title}</span>
  </button>
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
  .panel-h {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    text-align: left;
    padding: 6px 9px;
    background: var(--bg-panel-2);
    border: none;
    border-radius: 0;
    color: var(--text-bright);
    font-weight: 600;
    cursor: pointer;
  }
  .panel-h:hover {
    background: var(--bg-elevated);
  }
  .chev {
    display: inline-flex;
    color: var(--text-dim);
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
