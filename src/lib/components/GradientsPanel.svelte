<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import Panel from './Panel.svelte';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  const presets: { id: typeof editor.gradientType; label: string; preview: string }[] = [
    { id: 'fg-bg', label: 'Foreground to background', preview: 'linear-gradient(90deg, var(--fg), var(--bg))' },
    { id: 'fg-transparent', label: 'Foreground to transparent', preview: 'linear-gradient(90deg, var(--fg), transparent)' },
  ];
</script>

<Panel title="Gradients" bind:collapsed {onToggle}>
  <div class="gradient-list" style={`--fg:${editor.foregroundCss}; --bg:${editor.backgroundCss}`}>
    {#each presets as preset (preset.id)}
      <button
        class="gradient-row"
        class:active={editor.gradientType === preset.id}
        onclick={() => (editor.gradientType = preset.id)}
      >
        <span class="preview" style={`background:${preset.preview}`}></span>
        <span>{preset.label}</span>
      </button>
    {/each}
  </div>
</Panel>

<style>
  .gradient-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px;
  }
  .gradient-row {
    display: grid;
    grid-template-columns: 72px 1fr;
    align-items: center;
    gap: 8px;
    padding: 6px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
    text-align: left;
  }
  .gradient-row:hover,
  .gradient-row.active {
    background: var(--bg-elevated);
    border-color: var(--border-soft);
    color: var(--text-bright);
  }
  .preview {
    height: 22px;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 3px;
    background-color: var(--bg-panel-2);
    background-image:
      linear-gradient(45deg, rgba(255, 255, 255, 0.12) 25%, transparent 25%),
      linear-gradient(-45deg, rgba(255, 255, 255, 0.12) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, rgba(255, 255, 255, 0.12) 75%),
      linear-gradient(-45deg, transparent 75%, rgba(255, 255, 255, 0.12) 75%);
    background-position:
      0 0,
      0 5px,
      5px -5px,
      -5px 0;
    background-size: 10px 10px;
  }
</style>
