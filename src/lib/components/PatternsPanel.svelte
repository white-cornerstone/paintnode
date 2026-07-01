<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { tooltip } from '../actions/tooltip';
  import Panel from './Panel.svelte';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  const patterns: { id: 'checker' | 'lines' | 'diagonal' | 'dots'; name: string; style: string }[] = [
    {
      id: 'checker',
      name: 'Checker fill',
      style:
        'linear-gradient(45deg, #777 25%, transparent 25%), linear-gradient(-45deg, #777 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #777 75%), linear-gradient(-45deg, transparent 75%, #777 75%)',
    },
    {
      id: 'lines',
      name: 'Fine lines',
      style: 'repeating-linear-gradient(90deg, #6c747d 0 2px, #303236 2px 6px)',
    },
    {
      id: 'diagonal',
      name: 'Diagonal hatch',
      style: 'repeating-linear-gradient(135deg, #69707a 0 2px, #303236 2px 8px)',
    },
    {
      id: 'dots',
      name: 'Dots',
      style: 'radial-gradient(circle, #7e8790 0 2px, transparent 2px)',
    },
  ];
</script>

<Panel title="Patterns" bind:collapsed {onToggle}>
  <div class="pattern-grid">
    {#each patterns as pattern (pattern.name)}
      <button
        class="pattern"
        style={`--pattern:${pattern.style}`}
        use:tooltip={{ text: pattern.name, placement: 'left' }}
        aria-label={pattern.name}
        onclick={() => editor.fillActivePattern(pattern.id)}
      ></button>
    {/each}
  </div>
</Panel>

<style>
  .pattern-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 7px;
    padding: 10px;
  }
  .pattern {
    aspect-ratio: 1;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 3px;
    background-color: #303236;
    background-image: var(--pattern);
    background-position:
      0 0,
      0 6px,
      6px -6px,
      -6px 0;
    background-size: 12px 12px;
  }
  .pattern:hover {
    border-color: var(--text-bright);
  }
</style>
