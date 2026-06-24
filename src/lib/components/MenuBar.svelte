<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import {
    openCommand,
    saveOraCommand,
    saveCopyOraCommand,
    exportPngCommand,
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
        { label: 'Save', shortcut: '⌘S', action: () => void saveOraCommand() },
        { label: 'Save a Copy…', shortcut: '⇧⌘S', action: () => void saveCopyOraCommand() },
        { label: 'Export PNG…', shortcut: '⌘E', action: () => void exportPngCommand() },
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
      ],
    },
    {
      label: 'Image',
      items: [
        { label: 'Image Size…', action: () => ui.open('imageSize') },
        { label: 'Reveal All', action: () => editor.revealAll() },
        { label: 'Crop to Selection', action: () => editor.cropToSelection(), disabled: () => !hasSel() },
        { sep: true },
        { label: 'Rotate 90° CW', action: () => editor.rotate(90) },
        { label: 'Rotate 90° CCW', action: () => editor.rotate(270) },
        { label: 'Rotate 180°', action: () => editor.rotate(180) },
        { label: 'Flip Horizontal', action: () => editor.flip('h') },
        { label: 'Flip Vertical', action: () => editor.flip('v') },
        { sep: true },
        { label: 'Brightness/Contrast…', action: () => ui.open('brightnessContrast') },
        { label: 'Hue/Saturation…', action: () => ui.open('hueSaturation') },
        { label: 'Desaturate', action: () => editor.adjustDesaturate() },
        { label: 'Invert', shortcut: '⌘I', action: () => editor.adjustInvert() },
        { sep: true },
        { label: 'Flatten Image', action: () => editor.flatten() },
      ],
    },
    {
      label: 'Layer',
      items: [
        { label: 'New Layer', action: () => editor.addLayer() },
        { label: 'Duplicate Layer', action: () => { const id = activeId(); if (id) editor.duplicateLayer(id); } },
        { label: 'Delete Layer', action: () => { const id = activeId(); if (id) editor.deleteLayer(id); } },
        { sep: true },
        { label: 'Merge Down', action: () => { const id = activeId(); if (id) editor.mergeDown(id); } },
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
      items: [{ label: 'Generate Image…', action: () => ui.open('aiGenerate') }],
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom In', shortcut: '⌘+', action: () => vp()?.zoomBy(1.25) },
        { label: 'Zoom Out', shortcut: '⌘-', action: () => vp()?.zoomBy(1 / 1.25) },
        { label: 'Fit on Screen', shortcut: '⌘0', action: () => vp()?.fitToView() },
        { label: 'Actual Pixels (100%)', shortcut: '⌘1', action: () => vp()?.setZoom(1) },
      ],
    },
    {
      label: 'Help',
      items: [{ label: 'About CX Paint', action: () => ui.open('about') }],
    },
  ];

  let open = $state<number | null>(null);

  function toggle(i: number) {
    open = open === i ? null : i;
  }
  function enter(i: number) {
    if (open !== null) open = i;
  }
  function run(item: MItem) {
    if (item.disabled?.()) return;
    open = null;
    item.action?.();
  }
  function closeAll() {
    open = null;
  }
</script>

<svelte:window onpointerdown={closeAll} />

<nav class="menubar">
  <div class="brand"><Icon svg={Image} size={15} /><span>CX&nbsp;Paint</span></div>
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
              <button class="item" disabled={item.disabled?.()} onclick={() => run(item)}>
                <span>{item.label}</span>
                {#if item.shortcut}<span class="sc">{item.shortcut}</span>{/if}
              </button>
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
