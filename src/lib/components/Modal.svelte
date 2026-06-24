<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { Dismiss } from '../icons';

  let {
    title,
    onClose,
    children,
    width = 360,
  }: { title: string; onClose: () => void; children: Snippet; width?: number } = $props();

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div
    class="modal"
    style="width:{width}px"
    onpointerdown={(e) => e.stopPropagation()}
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label={title}
  >
    <header>
      <span>{title}</span>
      <button class="x" onclick={onClose} aria-label="Close" use:tooltip={{ text: 'Close', placement: 'bottom' }}><Icon svg={Dismiss} size={16} /></button>
    </header>
    <div class="body">
      {@render children()}
    </div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .modal {
    background: var(--bg-panel);
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    color: var(--text-bright);
  }
  .x {
    background: transparent;
    border: none;
    color: var(--text-dim);
    padding: 2px 6px;
  }
  .x:hover {
    color: var(--text-bright);
  }
  .body {
    padding: 14px;
  }
</style>
