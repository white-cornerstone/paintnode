<script lang="ts">
  import { onDestroy, onMount, tick, type Snippet } from 'svelte';
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
    minHeight = null,
    resizable = false,
  }: {
    title: string;
    onClose: () => void;
    children: Snippet;
    width?: number;
    height?: number | null;
    minWidth?: number;
    minHeight?: number | null;
    resizable?: boolean;
  } = $props();

  let modalEl = $state<HTMLDivElement | null>(null);
  let modalPosition = $state<{ left: number; top: number } | null>(null);
  let drag =
    $state<{
      startX: number;
      startY: number;
      left: number;
      top: number;
    } | null>(null);
  let previousFocus: HTMLElement | null = null;

  const managedSize = $derived(resizable || height !== null || minHeight !== null);
  const modalStyle = $derived(
    [
      `width:${width}px`,
      height ? `height:${height}px` : '',
      `min-width:min(${minWidth}px, calc(100vw - 32px))`,
      minHeight ? `min-height:min(${minHeight}px, calc(100vh - 32px))` : '',
      modalPosition ? `left:${modalPosition.left}px` : '',
      modalPosition ? `top:${modalPosition.top}px` : '',
    ]
      .filter(Boolean)
      .join(';'),
  );

  const focusableSelector = [
    '[data-autofocus]',
    'button:not([disabled]):not([tabindex="-1"])',
    'input:not([disabled]):not([tabindex="-1"])',
    'select:not([disabled]):not([tabindex="-1"])',
    'textarea:not([disabled]):not([tabindex="-1"])',
    '[href]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  function focusableElements(): HTMLElement[] {
    if (!modalEl) return [];
    return Array.from(modalEl.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => element.getAttribute('aria-hidden') !== 'true');
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = focusableElements();
    if (focusable.length === 0) {
      e.preventDefault();
      modalEl?.focus();
      return;
    }
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = e.shiftKey
      ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
      : activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1;
    if ((e.shiftKey && activeIndex <= 0) || (!e.shiftKey && (activeIndex < 0 || activeIndex === focusable.length - 1))) {
      e.preventDefault();
      focusable[nextIndex]?.focus();
    }
  }

  onMount(async () => {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    await tick();
    const initial = modalEl?.querySelector<HTMLElement>('[data-autofocus]') ?? focusableElements()[0] ?? modalEl;
    initial?.focus();
  });

  onDestroy(() => {
    if (previousFocus?.isConnected) previousFocus.focus();
  });

  function clampPosition(left: number, top: number): { left: number; top: number } {
    const rect = modalEl?.getBoundingClientRect();
    const modalWidth = rect?.width ?? width;
    const modalHeight = rect?.height ?? 260;
    const gutter = 8;
    const maxLeft = Math.max(gutter, window.innerWidth - modalWidth - gutter);
    const maxTop = Math.max(gutter, window.innerHeight - modalHeight - gutter);
    return {
      left: Math.round(Math.min(Math.max(left, gutter), maxLeft)),
      top: Math.round(Math.min(Math.max(top, gutter), maxTop)),
    };
  }

  function beginDrag(e: PointerEvent): void {
    if (e.button !== 0) return;
    if ((e.target as Element | null)?.closest('button')) return;
    const rect = modalEl?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    const position = clampPosition(rect.left, rect.top);
    modalPosition = position;
    drag = {
      startX: e.clientX,
      startY: e.clientY,
      left: position.left,
      top: position.top,
    };
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag) return;
    e.preventDefault();
    modalPosition = clampPosition(drag.left + e.clientX - drag.startX, drag.top + e.clientY - drag.startY);
  }

  function onPointerUp(): void {
    drag = null;
  }
</script>

<svelte:window onpointermove={onPointerMove} onpointerup={onPointerUp} />

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div
    bind:this={modalEl}
    class="modal"
    class:resizable
    class:managed-size={managedSize}
    class:dragged={modalPosition !== null}
    style={modalStyle}
    onpointerdown={(e) => e.stopPropagation()}
    role="dialog"
    tabindex="-1"
    aria-modal="true"
    aria-label={title}
    onkeydown={onKey}
  >
    <header role="presentation" onpointerdown={beginDrag}>
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
  .modal.resizable :global(textarea) {
    resize: none;
  }
  .modal.dragged {
    position: fixed;
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
    cursor: move;
    user-select: none;
  }
  .x {
    background: transparent;
    border: none;
    color: var(--text-dim);
    padding: 2px 6px;
    cursor: pointer;
  }
  .x:hover {
    color: var(--text-bright);
  }
  .body {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
    padding: 14px;
  }
  .modal.managed-size .body {
    flex: 1 1 auto;
  }
  .modal.managed-size .body > :global(*) {
    flex: 1 1 auto;
    min-height: 0;
  }
</style>
