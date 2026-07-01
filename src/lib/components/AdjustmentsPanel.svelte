<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import Panel from './Panel.svelte';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  const hasLayer = $derived(!!editor.activeLayer);
</script>

<Panel title="Adjustments" bind:collapsed {onToggle}>
  <div class="adjustments">
    <button disabled={!hasLayer} onclick={() => ui.open('brightnessContrast')}>Brightness / Contrast</button>
    <button disabled={!hasLayer} onclick={() => ui.open('hueSaturation')}>Hue / Saturation</button>
    <button disabled={!hasLayer} onclick={() => editor.adjustDesaturate()}>Desaturate</button>
    <button disabled={!hasLayer} onclick={() => editor.adjustInvert()}>Invert</button>
  </div>
</Panel>

<style>
  .adjustments {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 7px;
    padding: 10px;
  }
  button {
    min-height: 30px;
    padding: 5px 7px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-elevated);
    color: var(--text);
    font-size: 11px;
  }
  button:hover:not(:disabled) {
    color: var(--text-bright);
    border-color: var(--text-dim);
  }
</style>
