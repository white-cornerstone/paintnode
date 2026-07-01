<script lang="ts">
  import { project } from '../state/project.svelte';
  import Icon from './Icon.svelte';
  import Panel from './Panel.svelte';
  import { Image, Sparkle } from '../icons';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  const assets = $derived(project.current?.assets.slice(0, 4) ?? []);
</script>

<Panel title="Libraries" bind:collapsed {onToggle}>
  <div class="libraries">
    {#if assets.length}
      {#each assets as asset (asset.id)}
        <div class="asset">
          <span class="asset-icon"><Icon svg={asset.kind === 'generated' ? Sparkle : Image} size={15} /></span>
          <span>{asset.name}</span>
        </div>
      {/each}
    {:else}
      <div class="empty">
        <Icon svg={Image} size={18} />
        <span>Project assets will appear here.</span>
      </div>
    {/if}
  </div>
</Panel>

<style>
  .libraries {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
  }
  .asset {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    padding: 6px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-elevated);
    color: var(--text);
    font-size: 12px;
  }
  .asset span:last-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .asset-icon,
  .empty {
    color: var(--text-dim);
  }
  .empty {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 42px;
    font-size: 12px;
  }
</style>
