<script lang="ts">
  import type { RGB } from '../engine/types';
  import { rgbToCss } from '../engine/color';
  import { editor } from '../state/editor.svelte';
  import { tooltip } from '../actions/tooltip';
  import Panel from './Panel.svelte';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  const swatches: { name: string; color: RGB }[] = [
    { name: 'Black', color: { r: 0, g: 0, b: 0 } },
    { name: 'White', color: { r: 255, g: 255, b: 255 } },
    { name: 'Warm red', color: { r: 221, g: 64, b: 58 } },
    { name: 'Orange', color: { r: 242, g: 142, b: 43 } },
    { name: 'Yellow', color: { r: 244, g: 203, b: 64 } },
    { name: 'Leaf green', color: { r: 86, g: 171, b: 84 } },
    { name: 'Teal', color: { r: 36, g: 170, b: 175 } },
    { name: 'Sky blue', color: { r: 71, g: 147, b: 227 } },
    { name: 'Violet', color: { r: 134, g: 94, b: 199 } },
    { name: 'Magenta', color: { r: 210, g: 86, b: 157 } },
    { name: 'Ink gray', color: { r: 54, g: 57, b: 63 } },
    { name: 'Paper gray', color: { r: 210, g: 214, b: 220 } },
  ];

  function choose(color: RGB): void {
    editor.setForeground({ ...color });
  }
</script>

<Panel title="Swatches" bind:collapsed {onToggle}>
  <div class="swatch-grid" aria-label="Color swatches">
    {#each swatches as swatch (swatch.name)}
      <button
        class="swatch"
        class:active={rgbToCss(editor.foreground) === rgbToCss(swatch.color)}
        style={`--swatch:${rgbToCss(swatch.color)}`}
        use:tooltip={{ text: swatch.name, placement: 'left' }}
        aria-label={swatch.name}
        onclick={() => choose(swatch.color)}
      ></button>
    {/each}
  </div>
</Panel>

<style>
  .swatch-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
    padding: 10px;
  }
  .swatch {
    aspect-ratio: 1;
    min-width: 0;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 3px;
    background: var(--swatch);
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.34);
  }
  .swatch:hover,
  .swatch.active {
    border-color: var(--text-bright);
    box-shadow:
      inset 0 0 0 1px rgba(0, 0, 0, 0.4),
      0 0 0 1px var(--text-bright);
  }
</style>
