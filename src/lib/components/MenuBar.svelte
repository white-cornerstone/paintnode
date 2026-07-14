<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { workflow } from '../state/workflow.svelte';
  import { aiTasks } from '../state/aiTasks.svelte';
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
  const hasDocument = () => !!editor.doc;
  const hasOpenTarget = () => hasDocument() || (ui.activeSurface === 'workflow' && workflow.active);
  const workflowAuthoringLocked = () => workflow.active
    && aiTasks.runningForWorkflow(workflow.graphSnapshot().id).length > 0;
  const canUndo = () => ui.activeSurface === 'workflow' && workflow.active
    ? !workflowAuthoringLocked() && workflow.canUndoAuthoring
    : editor.canUndo;
  const canRedo = () => ui.activeSurface === 'workflow' && workflow.active
    ? !workflowAuthoringLocked() && workflow.canRedoAuthoring
    : editor.canRedo;
  const undo = () => ui.activeSurface === 'workflow' && workflow.active
    ? !workflowAuthoringLocked() && workflow.undoAuthoring()
    : editor.undo();
  const redo = () => ui.activeSurface === 'workflow' && workflow.active
    ? !workflowAuthoringLocked() && workflow.redoAuthoring()
    : editor.redo();
  const activeLayer = () => editor.activeLayer;
  const hasActiveLayer = () => !!activeLayer();
  const hasEditableActiveLayer = () => {
    const layer = activeLayer();
    return !!layer && !layer.locked;
  };
  const activeLayerIndex = () => {
    const doc = editor.doc;
    const id = activeId();
    return doc && id ? doc.indexOf(id) : -1;
  };
  const hasLockedLayer = () => !!editor.doc?.layers.some((layer) => layer.locked);
  const hasPsdProtectedLayer = () =>
    !!editor.doc?.layers.some((layer) => layer.locked || layer.psdMask || layer.psd?.clipping);
  const canTransformDocument = () => hasDocument() && !hasPsdProtectedLayer();
  const canRevealAll = () => hasDocument() && !hasLockedLayer();
  const canDeleteActiveLayer = () => {
    const doc = editor.doc;
    const id = activeId();
    if (!doc || !id) return false;
    const deletionIds = doc.linkedLayerDeletionIds(id);
    if (!deletionIds.length || doc.layers.length - deletionIds.length <= 0) return false;
    return deletionIds.every((layerId) => !doc.layers.find((layer) => layer.id === layerId)?.locked);
  };
  const canDuplicateActiveLayer = () => hasEditableActiveLayer();
  const canMergeDown = () => {
    const doc = editor.doc;
    const idx = activeLayerIndex();
    return !!doc && idx > 0 && !doc.layers[idx]?.locked && !doc.layers[idx - 1]?.locked;
  };
  const canFlatten = () => !!editor.doc && editor.doc.layers.length > 1 && !hasLockedLayer();
  const canRasterizeType = () => editor.activeLayer?.kind === 'text' && !editor.activeLayer.locked;
  const canUseViewport = () => hasDocument() && !!editor.viewport;
  const vp = () => editor.viewport;
  const hasSel = () => !!editor.selection;
  const itemDisabled = (item: MItem): boolean => {
    if (item.disabled?.()) return true;
    if (!item.items) return false;
    return item.items.filter((child) => !child.sep).every(itemDisabled);
  };

  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        { label: 'New…', shortcut: '⌘N', action: () => ui.open('new') },
        { label: 'Open…', shortcut: '⌘O', action: () => void openCommand() },
        { label: 'Place Image…', action: () => void importImageCommand(), disabled: () => !hasDocument() },
        { sep: true },
        { label: 'Save', shortcut: '⌘S', action: () => void saveActiveCommand(), disabled: () => !hasOpenTarget() },
        {
          label: 'Save a Copy…',
          shortcut: '⇧⌘S',
          action: () => void saveActiveCopyCommand(),
          disabled: () => !hasOpenTarget(),
        },
        { label: 'Export PNG…', action: () => void exportPngCommand(), disabled: () => !hasDocument() },
        { label: 'Export PSD…', action: () => void exportPsdCommand(), disabled: () => !hasDocument() },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', shortcut: '⌘Z', action: undo, disabled: () => !canUndo() },
        { label: 'Redo', shortcut: '⇧⌘Z', action: redo, disabled: () => !canRedo() },
        { sep: true },
        { label: 'Cut', shortcut: '⌘X', action: () => editor.cut(), disabled: () => !hasEditableActiveLayer() },
        { label: 'Copy', shortcut: '⌘C', action: () => editor.copy(), disabled: () => !hasActiveLayer() },
        { label: 'Paste', shortcut: '⌘V', action: () => editor.paste(), disabled: () => !hasDocument() || !editor.clipboard },
        { sep: true },
        {
          label: 'Fill with Foreground',
          action: () => editor.fillActive(editor.foreground),
          disabled: () => !hasEditableActiveLayer(),
        },
        {
          label: 'Fill with Background',
          action: () => editor.fillActive(editor.background),
          disabled: () => !hasEditableActiveLayer(),
        },
        { label: 'Clear', shortcut: 'Del', action: () => editor.clearActive(), disabled: () => !hasEditableActiveLayer() },
        { sep: true },
        {
          label: 'Free Transform',
          shortcut: '⌘T',
          action: () => editor.beginFreeTransform(),
          disabled: () => !hasEditableActiveLayer() || !!editor.freeTransform || !!editor.activeLayer?.psdMask,
        },
      ],
    },
    {
      label: 'Image',
      items: [
        {
          label: 'Adjustments',
          items: [
            {
              label: 'Brightness/Contrast…',
              action: () => ui.open('brightnessContrast'),
              disabled: () => !hasEditableActiveLayer(),
            },
            { label: 'Levels…', shortcut: '⌘L', action: () => ui.open('levels'), disabled: () => !hasEditableActiveLayer() },
            {
              label: 'Hue/Saturation…',
              shortcut: '⌘U',
              action: () => ui.open('hueSaturation'),
              disabled: () => !hasEditableActiveLayer(),
            },
            { label: 'Threshold…', action: () => ui.open('threshold'), disabled: () => !hasEditableActiveLayer() },
            { sep: true },
            { label: 'Invert', shortcut: '⌘I', action: () => editor.adjustInvert(), disabled: () => !hasEditableActiveLayer() },
            { sep: true },
            { label: 'Desaturate', shortcut: '⇧⌘U', action: () => editor.adjustDesaturate(), disabled: () => !hasEditableActiveLayer() },
          ],
        },
        { sep: true },
        { label: 'Auto Tone', shortcut: '⇧⌘L', action: () => ui.openAiAutoAdjust('tone'), disabled: () => !hasDocument() },
        {
          label: 'Auto Contrast',
          shortcut: '⌥⇧⌘L',
          action: () => ui.openAiAutoAdjust('contrast'),
          disabled: () => !hasDocument(),
        },
        { label: 'Auto Color', shortcut: '⇧⌘B', action: () => ui.openAiAutoAdjust('color'), disabled: () => !hasDocument() },
        { sep: true },
        {
          label: 'Image Size…',
          shortcut: '⌥⌘I',
          action: () => ui.open('imageSize'),
          disabled: () => !canTransformDocument(),
        },
        { label: 'AI Upscale…', shortcut: '⌥⇧⌘U', action: () => ui.open('aiUpscale'), disabled: () => !hasDocument() },
        {
          label: 'Canvas Size…',
          shortcut: '⌥⌘C',
          action: () => ui.open('canvasSize'),
          disabled: () => !canTransformDocument(),
        },
        {
          label: 'Image Rotation',
          items: [
            { label: '180°', action: () => editor.rotate(180), disabled: () => !canTransformDocument() },
            { label: '90° Clockwise', action: () => editor.rotate(90), disabled: () => !canTransformDocument() },
            {
              label: '90° Counter Clockwise',
              action: () => editor.rotate(270),
              disabled: () => !canTransformDocument(),
            },
            { sep: true },
            { label: 'Flip Canvas Horizontal', action: () => editor.flip('h'), disabled: () => !canTransformDocument() },
            { label: 'Flip Canvas Vertical', action: () => editor.flip('v'), disabled: () => !canTransformDocument() },
          ],
        },
        { label: 'Crop', action: () => editor.cropToSelection(), disabled: () => !canTransformDocument() || !hasSel() },
        { label: 'Trim…', action: () => ui.open('trim'), disabled: () => !canTransformDocument() },
        { label: 'Reveal All', action: () => editor.revealAll(), disabled: () => !canRevealAll() },
        { sep: true },
        { label: 'Duplicate…', action: () => ui.open('duplicateDocument'), disabled: () => !hasDocument() },
      ],
    },
    {
      label: 'Layer',
      items: [
        { label: 'New Layer', action: () => editor.addLayer(), disabled: () => !hasDocument() },
        {
          label: 'Duplicate Layer',
          action: () => {
            const id = activeId();
            if (id) editor.duplicateLayer(id);
          },
          disabled: () => !canDuplicateActiveLayer(),
        },
        {
          label: 'Delete Layer',
          action: () => {
            const id = activeId();
            if (id) editor.deleteLayer(id);
          },
          disabled: () => !canDeleteActiveLayer(),
        },
        { sep: true },
        {
          label: 'Rasterize Type',
          action: () => {
            const id = activeId();
            if (id) editor.rasterizeType(id);
          },
          disabled: () => !canRasterizeType(),
        },
        { sep: true },
        {
          label: 'Merge Down',
          shortcut: '⌘E',
          action: () => {
            const id = activeId();
            if (id) editor.mergeDown(id);
          },
          disabled: () => !canMergeDown(),
        },
        { label: 'Flatten Image', action: () => editor.flatten(), disabled: () => !canFlatten() },
      ],
    },
    {
      label: 'Select',
      items: [
        { label: 'All', shortcut: '⌘A', action: () => editor.selectAll(), disabled: () => !hasDocument() },
        { label: 'Deselect', shortcut: '⌘D', action: () => editor.deselect(), disabled: () => !hasDocument() || !hasSel() },
        { label: 'Inverse', shortcut: '⇧⌘I', action: () => editor.invertSelection(), disabled: () => !hasDocument() || !hasSel() },
      ],
    },
    {
      label: 'Filter',
      items: [
        { label: 'Gaussian Blur…', action: () => ui.open('gaussianBlur'), disabled: () => !hasEditableActiveLayer() },
        { label: 'Sharpen', action: () => editor.filterSharpen(1), disabled: () => !hasEditableActiveLayer() },
      ],
    },
    {
      label: 'AI',
      items: [
        { label: 'Generate Image…', action: () => ui.open('aiGenerate') },
        {
          label: 'Extract Assets…',
          action: () => ui.open('aiDecouple'),
          disabled: () => !hasActiveLayer(),
        },
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom In', shortcut: '⌘+', action: () => vp()?.zoomBy(1.25), disabled: () => !canUseViewport() },
        { label: 'Zoom Out', shortcut: '⌘-', action: () => vp()?.zoomBy(1 / 1.25), disabled: () => !canUseViewport() },
        { label: 'Fit on Screen', shortcut: '⌘0', action: () => vp()?.fitToView(), disabled: () => !canUseViewport() },
        { label: 'Actual Pixels (100%)', shortcut: '⌘1', action: () => vp()?.setZoom(1), disabled: () => !canUseViewport() },
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
    if (itemDisabled(item)) return;
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
                  disabled={itemDisabled(item)}
                  onclick={() => run(item)}
                  onpointerenter={() => (openSub = item.items && !itemDisabled(item) ? j : null)}
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
                        <button class="item" disabled={itemDisabled(child)} onclick={() => run(child)}>
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
  .item:disabled {
    opacity: 1;
    color: #6f7378;
  }
  .item.has-sub {
    position: relative;
  }
  .sc {
    color: var(--text-dim);
  }
  .item:disabled .sc {
    color: #5a5f65;
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
