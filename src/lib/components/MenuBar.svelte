<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import {
    openCommand,
    saveActiveCommand,
    saveActiveCopyCommand,
    exportPngCommand,
    exportPsdCommand,
    importImageCommand,
  } from '../state/commands';
  import Icon from './Icon.svelte';
  import { Image } from '../icons';

  interface MItem {
    label?: string;
    shortcut?: string;
    sep?: boolean;
    action?: () => void;
    disabled?: () => boolean;
    items?: MItem[];
  }
  interface Menu {
    label: string;
    items: MItem[];
  }

  const activeId = () => editor.activeLayer?.id;
  const vp = () => editor.viewport;
  const hasSel = () => !!editor.selection;

  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        { label: 'New…', shortcut: '⌘N', action: () => ui.open('new') },
        { label: 'Open…', shortcut: '⌘O', action: () => void openCommand() },
        { label: 'Place Image…', action: () => void importImageCommand() },
        { sep: true },
        { label: 'Save', shortcut: '⌘S', action: () => void saveActiveCommand() },
        { label: 'Save a Copy…', shortcut: '⇧⌘S', action: () => void saveActiveCopyCommand() },
        { label: 'Export PNG…', action: () => void exportPngCommand() },
        { label: 'Export PSD…', action: () => void exportPsdCommand() },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: '⌘Z', action: () => editor.undo(), disabled: () => !editor.canUndo },
        { label: 'Redo', shortcut: '⇧⌘Z', action: () => editor.redo(), disabled: () => !editor.canRedo },
        { sep: true },
        { label: 'Cut', shortcut: '⌘X', action: () => editor.cut() },
        { label: 'Copy', shortcut: '⌘C', action: () => editor.copy() },
        { label: 'Paste', shortcut: '⌘V', action: () => editor.paste(), disabled: () => !editor.clipboard },
        { sep: true },
        { label: 'Fill with Foreground', action: () => editor.fillActive(editor.foreground) },
        { label: 'Fill with Background', action: () => editor.fillActive(editor.background) },
        { label: 'Clear', shortcut: 'Del', action: () => editor.clearActive() },
        { sep: true },
        {
          label: 'Free Transform',
          shortcut: '⌘T',
          action: () => editor.beginFreeTransform(),
          disabled: () => !editor.activeLayer || !!editor.freeTransform,
        },
      ],
    },
    {
      label: 'Image',
      items: [
        {
          label: 'Adjustments',
          items: [
            { label: 'Brightness/Contrast…', action: () => ui.open('brightnessContrast') },
            { label: 'Levels…', shortcut: '⌘L', action: () => ui.open('levels') },
            { label: 'Hue/Saturation…', shortcut: '⌘U', action: () => ui.open('hueSaturation') },
            { label: 'Threshold…', action: () => ui.open('threshold') },
            { sep: true },
            { label: 'Invert', shortcut: '⌘I', action: () => editor.adjustInvert() },
            { sep: true },
            { label: 'Desaturate', shortcut: '⇧⌘U', action: () => editor.adjustDesaturate() },
          ],
        },
        { sep: true },
        { label: 'Auto Tone', shortcut: '⇧⌘L', action: () => ui.openAiAutoAdjust('tone') },
        { label: 'Auto Contrast', shortcut: '⌥⇧⌘L', action: () => ui.openAiAutoAdjust('contrast') },
        { label: 'Auto Color', shortcut: '⇧⌘B', action: () => ui.openAiAutoAdjust('color') },
        { sep: true },
        { label: 'Image Size…', shortcut: '⌥⌘I', action: () => ui.open('imageSize') },
        { label: 'AI Upscale…', shortcut: '⌥⇧⌘U', action: () => ui.open('aiUpscale') },
        { label: 'Canvas Size…', shortcut: '⌥⌘C', action: () => ui.open('canvasSize') },
        {
          label: 'Image Rotation',
          items: [
            { label: '180°', action: () => editor.rotate(180) },
            { label: '90° Clockwise', action: () => editor.rotate(90) },
            { label: '90° Counter Clockwise', action: () => editor.rotate(270) },
            { sep: true },
            { label: 'Flip Canvas Horizontal', action: () => editor.flip('h') },
            { label: 'Flip Canvas Vertical', action: () => editor.flip('v') },
          ],
        },
        { label: 'Crop', action: () => editor.cropToSelection(), disabled: () => !hasSel() },
        { label: 'Trim…', action: () => ui.open('trim') },
        { label: 'Reveal All', action: () => editor.revealAll() },
        { sep: true },
        { label: 'Duplicate…', action: () => ui.open('duplicateDocument') },
      ],
    },
    {
      label: 'Layer',
      items: [
        { label: 'New Layer', action: () => editor.addLayer() },
        { label: 'Duplicate Layer', action: () => { const id = activeId(); if (id) editor.duplicateLayer(id); } },
        { label: 'Delete Layer', action: () => { const id = activeId(); if (id) editor.deleteLayer(id); } },
        { sep: true },
        {
          label: 'Rasterize Type',
          action: () => { const id = activeId(); if (id) editor.rasterizeType(id); },
          disabled: () => editor.activeLayer?.kind !== 'text',
        },
        { sep: true },
        { label: 'Merge Down', shortcut: '⌘E', action: () => { const id = activeId(); if (id) editor.mergeDown(id); } },
        { label: 'Flatten Image', action: () => editor.flatten() },
      ],
    },
    {
      label: 'Select',
      items: [
        { label: 'All', shortcut: '⌘A', action: () => editor.selectAll() },
        { label: 'Deselect', shortcut: '⌘D', action: () => editor.deselect(), disabled: () => !hasSel() },
        { label: 'Inverse', shortcut: '⇧⌘I', action: () => editor.invertSelection(), disabled: () => !hasSel() },
      ],
    },
    {
      label: 'Filter',
      items: [
        { label: 'Gaussian Blur…', action: () => ui.open('gaussianBlur') },
        { label: 'Sharpen', action: () => editor.filterSharpen(1) },
      ],
    },
    {
      label: 'AI',
      items: [
        { label: 'Generate Image…', action: () => ui.open('aiGenerate') },
        {
          label: 'Extract Assets…',
          action: () => ui.open('aiDecouple'),
          disabled: () => !editor.activeLayer,
        },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom In', shortcut: '⌘+', action: () => vp()?.zoomBy(1.25) },
        { label: 'Zoom Out', shortcut: '⌘-', action: () => vp()?.zoomBy(1 / 1.25) },
        { label: 'Fit on Screen', shortcut: '⌘0', action: () => vp()?.fitToView() },
        { label: 'Actual Pixels (100%)', shortcut: '⌘1', action: () => vp()?.setZoom(1) },
        { sep: true },
        {
          label: 'Show Contextual Task Bar',
          action: () => ui.showContextualTaskBar(),
          disabled: () => ui.contextualTaskBarVisible,
        },
        {
          label: 'Reset Contextual Task Bar Position',
          action: () => ui.resetContextualTaskBarPosition(),
        },
      ],
    },
  ];

  let open = $state<number | null>(null);
  let openSub = $state<number | null>(null);

  function toggle(i: number) {
    open = open === i ? null : i;
    openSub = null;
  }
  function enter(i: number) {
    if (open !== null) {
      open = i;
      openSub = null;
    }
  }
  function run(item: MItem) {
    if (item.disabled?.()) return;
    if (item.items) return;
    open = null;
    openSub = null;
    item.action?.();
  }
  function closeAll() {
    open = null;
    openSub = null;
  }
</script>

<svelte:window onpointerdown={closeAll} />

<nav class="menubar">
  <div class="brand"><Icon svg={Image} size={15} /><span>PaintNode</span></div>
  {#each menus as menu, i (menu.label)}
    <div class="menu" role="presentation" onpointerdown={(e) => e.stopPropagation()}>
      <button
        class="top"
        class:active={open === i}
        onclick={() => toggle(i)}
        onpointerenter={() => enter(i)}
      >
        {menu.label}
      </button>
      {#if open === i}
        <div class="dropdown">
          {#each menu.items as item, j (j)}
            {#if item.sep}
              <div class="sep"></div>
            {:else}
              <div class="item-wrap">
                <button
                  class="item"
                  class:has-sub={!!item.items}
                  disabled={item.disabled?.()}
                  onclick={() => run(item)}
                  onpointerenter={() => (openSub = item.items ? j : null)}
                >
                  <span>{item.label}</span>
                  {#if item.items}<span class="sc">›</span>{:else if item.shortcut}<span class="sc">{item.shortcut}</span>{/if}
                </button>
                {#if item.items && openSub === j}
                  <div class="submenu">
                    {#each item.items as child, k (k)}
                      {#if child.sep}
                        <div class="sep"></div>
                      {:else}
                        <button class="item" disabled={child.disabled?.()} onclick={() => run(child)}>
                          <span>{child.label}</span>
                          {#if child.shortcut}<span class="sc">{child.shortcut}</span>{/if}
                        </button>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</nav>

<style>
  .menubar {
    height: var(--menubar-h);
    display: flex;
    align-items: stretch;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    padding-left: 6px;
    user-select: none;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 0 14px 0 6px;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: 0.3px;
  }
  .menu {
    position: relative;
    display: flex;
  }
  .top {
    background: transparent;
    border: none;
    border-radius: 0;
    padding: 0 10px;
    color: var(--text);
  }
  .top:hover,
  .top.active {
    background: var(--bg-elevated);
  }
  .dropdown {
    position: absolute;
    top: 100%;
    left: 0;
    min-width: 210px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 0 0 5px 5px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    padding: 4px;
    z-index: 50;
  }
  .item-wrap {
    position: relative;
  }
  .submenu {
    position: absolute;
    left: calc(100% - 4px);
    top: 0;
    min-width: 220px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 5px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
    padding: 4px;
    z-index: 51;
  }
  .item {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    width: 100%;
    background: transparent;
    border: none;
    border-radius: 3px;
    padding: 5px 8px;
    text-align: left;
  }
  .item:hover:not(:disabled) {
    background: var(--accent);
    color: #fff;
  }
  .item.has-sub {
    position: relative;
  }
  .sc {
    color: var(--text-dim);
  }
  .item:hover:not(:disabled) .sc {
    color: #e8f0ff;
  }
  .sep {
    height: 1px;
    background: var(--border-soft);
    margin: 4px 6px;
  }
</style>
