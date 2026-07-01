<script lang="ts">
  import { importImageCommand } from '../state/commands';
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { tooltip } from '../actions/tooltip';
  import Icon from './Icon.svelte';
  import {
    ArrowReset,
    Checkmark,
    Crop,
    Dismiss,
    EyeOff,
    ImageAdd,
    ImageGlobe,
    MoreHorizontal,
    Pin,
    PinOff,
    Settings,
    Sparkle,
    SquareHintSparkles,
    Video,
  } from '../icons';

  interface Anchor {
    x: number;
    y: number;
    viewportWidth: number;
    viewportHeight: number;
    key: string;
  }

  interface TaskAction {
    id: string;
    label: string;
    icon: string;
    run: () => void | Promise<void>;
    primary?: boolean;
    disabled?: boolean;
  }

  interface Props {
    anchor: Anchor;
  }

  let { anchor }: Props = $props();
  let offset = $state({ x: 0, y: 0 });
  let pinned = $state(false);
  let menuOpen = $state(false);
  let dragStart: { pointerX: number; pointerY: number; x: number; y: number } | null = null;
  let lastAnchorKey = $state('');
  let lastResetToken = $state(0);

  const context = $derived.by(() => {
    if (editor.freeTransform) return 'transform';
    if (editor.selection) return 'selection';
    if (editor.activeLayer) return 'canvas';
    return 'empty';
  });

  const actions = $derived.by<TaskAction[]>(() => {
    if (context === 'transform') {
      return [
        { id: 'transform-done', label: 'Done', icon: Checkmark, primary: true, run: () => editor.commitFreeTransform() },
        { id: 'transform-cancel', label: 'Cancel', icon: Dismiss, run: () => editor.cancelFreeTransform() },
      ];
    }

    if (context === 'selection') {
      return [
        { id: 'generative-fill', label: 'Generative fill', icon: SquareHintSparkles, primary: true, run: () => ui.open('aiGenerate') },
        { id: 'deselect', label: 'Deselect', icon: Dismiss, run: () => editor.deselect() },
        { id: 'invert', label: 'Invert', icon: ArrowReset, run: () => editor.invertSelection() },
        { id: 'crop', label: 'Crop', icon: Crop, run: () => editor.cropToSelection() },
      ];
    }

    return [
      { id: 'generate-image', label: 'Generate image', icon: Sparkle, primary: true, run: () => ui.open('aiGenerate') },
      { id: 'add-from-device', label: 'Add from device', icon: ImageAdd, run: () => void importImageCommand() },
      {
        id: 'add-stock',
        label: 'Add open-license images',
        icon: ImageGlobe,
        run: () => ui.open('stockImages'),
      },
    ];
  });

  const style = $derived.by(() => {
    const desiredX = anchor.x + offset.x;
    const desiredY = anchor.y + offset.y;
    const x = Math.max(24, Math.min(anchor.viewportWidth - 24, desiredX));
    const y = Math.max(12, Math.min(anchor.viewportHeight - 48, desiredY));
    return `left:${x}px; top:${y}px`;
  });

  $effect(() => {
    if (anchor.key !== lastAnchorKey) {
      lastAnchorKey = anchor.key;
      if (!pinned) offset = { x: 0, y: 0 };
    }
  });

  $effect(() => {
    if (ui.contextualTaskBarResetToken !== lastResetToken) {
      lastResetToken = ui.contextualTaskBarResetToken;
      pinned = false;
      offset = { x: 0, y: 0 };
      menuOpen = false;
    }
  });

  function startDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    menuOpen = false;
    dragStart = { pointerX: event.clientX, pointerY: event.clientY, x: offset.x, y: offset.y };
    window.addEventListener('pointermove', updateDrag);
    window.addEventListener('pointerup', stopDrag);
  }

  function updateDrag(event: PointerEvent): void {
    if (!dragStart) return;
    offset = {
      x: dragStart.x + event.clientX - dragStart.pointerX,
      y: dragStart.y + event.clientY - dragStart.pointerY,
    };
  }

  function stopDrag(): void {
    dragStart = null;
    window.removeEventListener('pointermove', updateDrag);
    window.removeEventListener('pointerup', stopDrag);
  }

  function runAction(action: TaskAction): void {
    if (action.disabled) return;
    menuOpen = false;
    void action.run();
  }

  function moreProperties(): void {
    menuOpen = false;
    window.dispatchEvent(new CustomEvent('paintnode:show-properties-panel'));
  }

  function hideBar(): void {
    menuOpen = false;
    ui.hideContextualTaskBar();
    editor.flash('Contextual Task Bar hidden');
  }

  function resetPosition(): void {
    ui.resetContextualTaskBarPosition();
  }

  function togglePinned(): void {
    pinned = !pinned;
    menuOpen = false;
  }

  function watchQuickVideo(): void {
    menuOpen = false;
    window.open('https://helpx.adobe.com/photoshop/desktop/get-started/learn-the-basics/boost-workflows-with-the-contextual-task-bar.html', '_blank', 'noopener,noreferrer');
  }
</script>

{#if ui.contextualTaskBarVisible}
  <div class="context-bar-wrap" style={style} role="toolbar" aria-label="Contextual task bar">
    <div class="context-bar" role="presentation" onpointerdown={(event) => event.stopPropagation()}>
      <button
        class="drag-handle"
        aria-label="Move contextual task bar"
        use:tooltip={{ text: 'Move contextual task bar', placement: 'top' }}
        onpointerdown={startDrag}
      >
        <span aria-hidden="true"></span>
      </button>

      {#each actions as action (action.id)}
        <button
          class="task-action"
          class:primary={action.primary}
          disabled={action.disabled}
          onclick={() => runAction(action)}
        >
          <Icon svg={action.icon} size={16} />
          <span>{action.label}</span>
        </button>
      {/each}

      <button
        class="more"
        aria-label="More contextual task bar options"
        aria-expanded={menuOpen}
        use:tooltip={{ text: 'More options', placement: 'top' }}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <Icon svg={MoreHorizontal} size={18} />
      </button>
    </div>

    {#if menuOpen}
      <div class="context-menu" role="menu" tabindex="-1" onpointerdown={(event) => event.stopPropagation()}>
        <button role="menuitem" onclick={moreProperties}>
          <Icon svg={Settings} size={16} />
          <span>More Properties</span>
        </button>
        <div class="menu-separator"></div>
        <button role="menuitem" onclick={hideBar}>
          <Icon svg={EyeOff} size={16} />
          <span>Hide bar</span>
        </button>
        <button role="menuitem" onclick={resetPosition}>
          <Icon svg={ArrowReset} size={16} />
          <span>Reset bar position</span>
        </button>
        <button role="menuitem" onclick={togglePinned}>
          <Icon svg={pinned ? PinOff : Pin} size={16} />
          <span>{pinned ? 'Unpin bar position' : 'Pin bar position'}</span>
        </button>
        <button role="menuitem" onclick={watchQuickVideo}>
          <Icon svg={Video} size={16} />
          <span>Watch quick video</span>
        </button>
      </div>
    {/if}
  </div>
{:else}
  <button
    class="restore-bar"
    style={style}
    aria-label="Show contextual task bar"
    use:tooltip={{ text: 'Show Contextual Task Bar', placement: 'top' }}
    onclick={() => ui.showContextualTaskBar()}
  >
    <Icon svg={MoreHorizontal} size={18} />
  </button>
{/if}

<style>
  .context-bar-wrap {
    position: fixed;
    z-index: 1000;
    transform: translateX(-50%);
    pointer-events: none;
  }

  .restore-bar {
    position: fixed;
    z-index: 1000;
    width: 32px;
    height: 28px;
    padding: 0;
    border: 1px solid #6b6b6b;
    border-radius: 4px;
    background: #4d4d4d;
    box-shadow: 0 10px 20px rgb(0 0 0 / 32%);
    color: #f1f1f1;
    transform: translateX(-50%);
  }

  .restore-bar:hover,
  .restore-bar:focus-visible {
    background: #666;
    border-color: #9a9a9a;
    color: #fff;
  }

  .context-bar {
    display: flex;
    align-items: center;
    gap: 5px;
    min-height: 36px;
    padding: 5px 8px 5px 5px;
    border: 1px solid #6b6b6b;
    border-radius: 4px;
    background: #4d4d4d;
    box-shadow: 0 14px 28px rgb(0 0 0 / 36%);
    color: #f1f1f1;
    pointer-events: auto;
    user-select: none;
  }

  .drag-handle,
  .more,
  .task-action {
    height: 26px;
    border: 1px solid #757575;
    border-radius: 4px;
    background: #555;
    color: inherit;
  }

  .drag-handle {
    width: 18px;
    padding: 0;
    border-color: transparent;
    background: transparent;
    cursor: grab;
  }

  .drag-handle:active {
    cursor: grabbing;
  }

  .drag-handle span {
    display: block;
    width: 6px;
    height: 22px;
    margin: 1px auto;
    background-image: radial-gradient(circle, currentColor 1.5px, transparent 1.6px);
    background-size: 6px 5px;
    opacity: 0.95;
  }

  .task-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    max-width: 210px;
    padding: 0 10px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
    white-space: nowrap;
  }

  .task-action.primary {
    background: #5c5c5c;
    border-color: #858585;
  }

  .task-action:hover:not(:disabled),
  .task-action:focus-visible,
  .more:hover,
  .more:focus-visible,
  .drag-handle:hover,
  .drag-handle:focus-visible {
    background: #666;
    border-color: #9a9a9a;
    color: #fff;
  }

  .task-action:disabled {
    color: #aaa;
    opacity: 0.7;
  }

  .more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    padding: 0;
    border-color: transparent;
    background: transparent;
  }

  .context-menu {
    position: absolute;
    top: calc(100% + 8px);
    right: -24px;
    min-width: 220px;
    padding: 8px 0;
    border: 1px solid #686868;
    border-radius: 5px;
    background: #5b5b5b;
    box-shadow: 0 12px 26px rgb(0 0 0 / 38%);
    color: #f3f3f3;
    pointer-events: auto;
  }

  .context-menu button {
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    gap: 9px;
    align-items: center;
    width: 100%;
    min-height: 30px;
    padding: 4px 14px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font-size: 12px;
    font-weight: 600;
    text-align: left;
  }

  .context-menu button:hover,
  .context-menu button:focus-visible {
    background: #6d6d6d;
    color: #fff;
  }

  .menu-separator {
    height: 1px;
    margin: 6px 14px;
    background: #747474;
  }
</style>
