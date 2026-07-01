<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import Icon from './Icon.svelte';
  import Panel from './Panel.svelte';
  import { Eye } from '../icons';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  const channels = [
    { name: 'RGB', tone: 'rgb' },
    { name: 'Red', tone: 'red' },
    { name: 'Green', tone: 'green' },
    { name: 'Blue', tone: 'blue' },
    { name: 'Transparency', tone: 'alpha' },
  ];
</script>

<Panel title="Channels" bind:collapsed {onToggle}>
  <div class="channels">
    {#each channels as channel (channel.name)}
      <div class="channel">
        <Icon svg={Eye} size={15} />
        <span class={`sample ${channel.tone}`}></span>
        <span>{channel.name}</span>
      </div>
    {/each}
    <small>{editor.selection ? 'Selection mask active' : 'No saved masks'}</small>
  </div>
</Panel>

<style>
  .channels {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 10px;
  }
  .channel {
    display: grid;
    grid-template-columns: 18px 24px 1fr;
    align-items: center;
    gap: 7px;
    color: var(--text);
    font-size: 12px;
  }
  .sample {
    height: 17px;
    border: 1px solid var(--border-soft);
    border-radius: 3px;
    background: linear-gradient(90deg, #252525, #e0e0e0);
  }
  .red {
    background: linear-gradient(90deg, #2a1010, #e64b4b);
  }
  .green {
    background: linear-gradient(90deg, #102411, #5fc768);
  }
  .blue {
    background: linear-gradient(90deg, #10192b, #5c8ff0);
  }
  .alpha {
    background:
      linear-gradient(45deg, #555 25%, transparent 25%),
      linear-gradient(-45deg, #555 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #555 75%),
      linear-gradient(-45deg, transparent 75%, #555 75%),
      #2e2e2e;
    background-position:
      0 0,
      0 5px,
      5px -5px,
      -5px 0;
    background-size: 10px 10px;
  }
  small {
    margin-top: 4px;
    color: var(--text-dim);
    font-size: 11px;
  }
</style>
