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
    height = null,
    minWidth = Math.min(width, 360),
    minHeight = 260,
    resizable = false,
  }: {
    title: string;
    onClose: () => void;
    children: Snippet;
    width?: number;
    height?: number | null;
    minWidth?: number;
    minHeight?: number;
    resizable?: boolean;
  } = $props();

  const modalStyle = $derived(
    [
      `width:${width}px`,
      height ? `height:${height}px` : '',
      `min-width:min(${minWidth}px, calc(100vw - 32px))`,
      `min-height:min(${minHeight}px, calc(100vh - 32px))`,
    ]
      .filter(Boolean)
      .join(';'),
  );

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div
    class="modal"
    class:resizable
    style={modalStyle}
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
    z-index: 2000;
    padding: 16px;
  }
  .modal {
    display: flex;
    flex-direction: column;
    max-width: calc(100vw - 32px);
    max-height: calc(100vh - 32px);
    background: var(--bg-panel);
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }
  .modal.resizable {
    resize: both;
  }
  header {
    flex: 0 0 auto;
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
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    padding: 14px;
  }
  .body > :global(*) {
    flex: 1 1 auto;
    min-height: 0;
  }
</style>
