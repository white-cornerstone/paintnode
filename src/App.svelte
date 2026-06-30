<script lang="ts">
  import { tick } from 'svelte';
  import { onMount } from 'svelte';
  import MenuBar from './lib/components/MenuBar.svelte';
  import Toolbar from './lib/components/Toolbar.svelte';
  import ToolOptions from './lib/components/ToolOptions.svelte';
  import DocumentTabs from './lib/components/DocumentTabs.svelte';
  import CanvasView from './lib/components/CanvasView.svelte';
  import WorkflowBoard from './lib/components/WorkflowBoard.svelte';
  import LayersPanel from './lib/components/LayersPanel.svelte';
  import ColorPanel from './lib/components/ColorPanel.svelte';
  import ProjectPanel from './lib/components/ProjectPanel.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import NewDocumentDialog from './lib/components/NewDocumentDialog.svelte';
  import AboutDialog from './lib/components/AboutDialog.svelte';
  import ImageSizeDialog from './lib/components/ImageSizeDialog.svelte';
  import BrightnessContrastDialog from './lib/components/BrightnessContrastDialog.svelte';
  import HueSaturationDialog from './lib/components/HueSaturationDialog.svelte';
  import GaussianBlurDialog from './lib/components/GaussianBlurDialog.svelte';
  import AiGenerateDialog from './lib/components/AiGenerateDialog.svelte';
  import AiDecoupleDialog from './lib/components/AiDecoupleDialog.svelte';
  import FontEmbedDialog from './lib/components/FontEmbedDialog.svelte';
  import RasterizeTypeDialog from './lib/components/RasterizeTypeDialog.svelte';
  import Icon from './lib/components/Icon.svelte';
  import { tooltip } from './lib/actions/tooltip';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { ChevronDoubleLeft, ChevronDoubleRight, ColorPalette, Folder, Layers } from './lib/icons';
  import { installKeyboard } from './lib/state/keyboard';
  import {
    autosaveOpenDocuments,
    exportPngCommand,
    importImageCommand,
    openCommand,
    saveActiveCommand,
    saveActiveCopyCommand,
  } from './lib/state/commands';
  import { editor } from './lib/state/editor.svelte';
  import { isDesktop } from './lib/integrations/desktop';
  import { project } from './lib/state/project.svelte';
  import { ui } from './lib/state/ui.svelte';
  import { workflow } from './lib/state/workflow.svelte';

  const desktop = isDesktop();
  const appWindow = desktop ? getCurrentWindow() : null;
  let rightCollapsed = $state(false);
  let projectCollapsed = $state(false);
  let colorCollapsed = $state(false);
  let layersCollapsed = $state(false);
  let panelStackEl = $state<HTMLDivElement>();
  let autoCollapsedIds = $state<PanelId[]>([]);
  let fittingPanels = false;
  const hasDocument = $derived(ui.activeSurface === 'document' && !!editor.doc);
  const hasDrawingPanels = $derived(hasDocument || (ui.activeSurface === 'workflow' && workflow.storyboardEditing));

  type PanelId = 'color' | 'layers';
  const panelOrder: PanelId[] = ['color', 'layers'];
  const collapseOrder: PanelId[] = ['layers', 'color'];
  const expandOrder: PanelId[] = ['color', 'layers'];
  const restoreBlockedAtHeight = new Map<PanelId, number>();

  function isPanelCollapsed(id: PanelId): boolean {
    if (id === 'color') return colorCollapsed;
    return layersCollapsed;
  }

  function setPanelCollapsed(id: PanelId, collapsed: boolean): void {
    if (id === 'color') colorCollapsed = collapsed;
    else layersCollapsed = collapsed;
  }

  function rememberAutoCollapsed(id: PanelId): void {
    if (!autoCollapsedIds.includes(id)) autoCollapsedIds = [...autoCollapsedIds, id];
  }

  function forgetAutoCollapsed(id: PanelId): void {
    autoCollapsedIds = autoCollapsedIds.filter((existing) => existing !== id);
  }

  function panelStackOverflows(): boolean {
    return !!panelStackEl && panelStackEl.scrollHeight > panelStackEl.clientHeight + 1;
  }

  function afterLayout(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }

  function collapseNeighborsFor(id: PanelId): PanelId[] {
    const index = panelOrder.indexOf(id);
    const below = panelOrder.slice(index + 1);
    const above = panelOrder.slice(0, index).reverse();
    return [...below, ...above];
  }

  async function expandPanel(id: PanelId): Promise<void> {
    if (rightCollapsed) rightCollapsed = false;
    if (!panelStackEl || fittingPanels) {
      setPanelCollapsed(id, false);
      forgetAutoCollapsed(id);
      return;
    }

    fittingPanels = true;
    try {
      setPanelCollapsed(id, false);
      forgetAutoCollapsed(id);
      for (const neighbor of collapseNeighborsFor(id)) {
        await tick();
        await afterLayout();
        if (!panelStackOverflows()) break;
        if (!isPanelCollapsed(neighbor)) {
          setPanelCollapsed(neighbor, true);
          rememberAutoCollapsed(neighbor);
        }
      }
    } finally {
      fittingPanels = false;
    }
  }

  function requestPanelCollapsed(id: PanelId, collapsed: boolean): void {
    if (collapsed) {
      setPanelCollapsed(id, true);
      forgetAutoCollapsed(id);
      requestAnimationFrame(() => void fitRightPanels());
    } else {
      void expandPanel(id);
    }
  }

  let peekedPanel = $state<PanelId | null>(null);

  function expandRightPanels(): void {
    peekedPanel = null;
    rightCollapsed = false;
  }

  function collapseRightPanels(): void {
    peekedPanel = null;
    rightCollapsed = true;
  }

  function peekPanel(id: PanelId): void {
    rightCollapsed = true;
    peekedPanel = peekedPanel === id ? null : id;
  }

  function closePeekedPanel(): void {
    peekedPanel = null;
  }

  async function fitRightPanels(): Promise<void> {
    if (rightCollapsed || !panelStackEl || fittingPanels) return;
    fittingPanels = true;
    try {
      for (let i = 0; i < 8; i++) {
        await tick();
        await afterLayout();

        if (panelStackOverflows()) {
          const expandedCount = panelOrder.filter((id) => !isPanelCollapsed(id)).length;
          if (expandedCount <= 1) break;
          const next = collapseOrder.find((id) => !isPanelCollapsed(id));
          if (!next) break;
          setPanelCollapsed(next, true);
          rememberAutoCollapsed(next);
          continue;
        }

        const h = panelStackEl.clientHeight;
        const restore = expandOrder.find((id) => {
          const blockedAt = restoreBlockedAtHeight.get(id) ?? -Infinity;
          return autoCollapsedIds.includes(id) && h > blockedAt + 8;
        });
        if (!restore) break;
        setPanelCollapsed(restore, false);
        forgetAutoCollapsed(restore);
        await tick();
        await afterLayout();
        if (panelStackOverflows()) {
          setPanelCollapsed(restore, true);
          rememberAutoCollapsed(restore);
          restoreBlockedAtHeight.set(restore, panelStackEl.clientHeight);
          break;
        }
        restoreBlockedAtHeight.delete(restore);
      }
    } finally {
      fittingPanels = false;
    }
  }

  function runAppMenuAction(id: string): void {
    const activeId = () => editor.activeLayer?.id;
    switch (id) {
      case 'app:new':
        ui.open('new');
        break;
      case 'app:open':
        void openCommand();
        break;
      case 'app:place-image':
        void importImageCommand();
        break;
      case 'app:save-ora':
        void saveActiveCommand();
        break;
      case 'app:save-copy-ora':
        void saveActiveCopyCommand();
        break;
      case 'app:export-png':
        void exportPngCommand();
        break;
      case 'app:undo':
        editor.undo();
        break;
      case 'app:redo':
        editor.redo();
        break;
      case 'app:cut':
        editor.cut();
        break;
      case 'app:copy':
        editor.copy();
        break;
      case 'app:paste':
        if (editor.clipboard) editor.paste();
        break;
      case 'app:fill-foreground':
        editor.fillActive(editor.foreground);
        break;
      case 'app:fill-background':
        editor.fillActive(editor.background);
        break;
      case 'app:clear':
        editor.clearActive();
        break;
      case 'app:free-transform':
        editor.beginFreeTransform();
        break;
      case 'app:image-size':
        ui.open('imageSize');
        break;
      case 'app:reveal-all':
        editor.revealAll();
        break;
      case 'app:crop-to-selection':
        if (editor.selection) editor.cropToSelection();
        break;
      case 'app:rotate-cw':
        editor.rotate(90);
        break;
      case 'app:rotate-ccw':
        editor.rotate(270);
        break;
      case 'app:rotate-180':
        editor.rotate(180);
        break;
      case 'app:flip-horizontal':
        editor.flip('h');
        break;
      case 'app:flip-vertical':
        editor.flip('v');
        break;
      case 'app:brightness-contrast':
        ui.open('brightnessContrast');
        break;
      case 'app:hue-saturation':
        ui.open('hueSaturation');
        break;
      case 'app:desaturate':
        editor.adjustDesaturate();
        break;
      case 'app:invert':
        editor.adjustInvert();
        break;
      case 'app:flatten':
        editor.flatten();
        break;
      case 'app:new-layer':
        editor.addLayer();
        break;
      case 'app:duplicate-layer': {
        const id = activeId();
        if (id) editor.duplicateLayer(id);
        break;
      }
      case 'app:delete-layer': {
        const id = activeId();
        if (id) editor.deleteLayer(id);
        break;
      }
      case 'app:merge-down': {
        const id = activeId();
        if (id) editor.mergeDown(id);
        break;
      }
      case 'app:select-all':
        editor.selectAll();
        break;
      case 'app:deselect':
        if (editor.selection) editor.deselect();
        break;
      case 'app:inverse-selection':
        if (editor.selection) editor.invertSelection();
        break;
      case 'app:gaussian-blur':
        ui.open('gaussianBlur');
        break;
      case 'app:sharpen':
        editor.filterSharpen(1);
        break;
      case 'app:ai-generate':
        ui.open('aiGenerate');
        break;
      case 'app:ai-decouple':
        ui.open('aiDecouple');
        break;
      case 'app:workflow-board':
        workflow.newBoard();
        break;
      case 'app:zoom-in':
        editor.viewport?.zoomBy(1.25);
        break;
      case 'app:zoom-out':
        editor.viewport?.zoomBy(1 / 1.25);
        break;
      case 'app:fit-screen':
        editor.viewport?.fitToView();
        break;
      case 'app:actual-pixels':
        editor.viewport?.setZoom(1);
        break;
      case 'app:about':
      case 'app:help-about':
        ui.open('about');
        break;
    }
  }

  function handleTitlebarPointerDown(event: PointerEvent): void {
    if (!appWindow || event.button !== 0) return;
    if (event.detail === 2) {
      void appWindow.toggleMaximize();
      return;
    }
    void appWindow.startDragging();
  }

  function titlebarDrag(node: HTMLElement): { destroy: () => void } {
    node.addEventListener('pointerdown', handleTitlebarPointerDown);
    return {
      destroy() {
        node.removeEventListener('pointerdown', handleTitlebarPointerDown);
      },
    };
  }

  onMount(() => {
    const disposeKeyboard = installKeyboard();
    void project.restore();
    const autosave = window.setInterval(() => void autosaveOpenDocuments(), 60_000);
    const resizeObserver = new ResizeObserver(() => void fitRightPanels());
    let unlistenMenu: UnlistenFn | null = null;
    if (desktop) {
      void listen<string>('app-menu', (event) => runAppMenuAction(event.payload)).then((unlisten) => {
        unlistenMenu = unlisten;
      });
    }
    if (panelStackEl) resizeObserver.observe(panelStackEl);
    requestAnimationFrame(() => void fitRightPanels());
    return () => {
      unlistenMenu?.();
      resizeObserver.disconnect();
      window.clearInterval(autosave);
      disposeKeyboard();
    };
  });

  $effect(() => {
    colorCollapsed;
    layersCollapsed;
    rightCollapsed;
    if (!rightCollapsed) requestAnimationFrame(() => void fitRightPanels());
  });

  $effect(() => {
    if (!rightCollapsed) peekedPanel = null;
  });
</script>

<div class="app">
  {#if desktop}
    <div class="desktop-titlebar" data-tauri-drag-region use:titlebarDrag>
      <div class="desktop-title">PaintNode</div>
    </div>
  {:else}
    <MenuBar />
  {/if}
  <div class="middle">
    <Toolbar />
    <div class="workspace">
      <ToolOptions />
      <div class="content-row">
        <section class="center">
          <DocumentTabs />
          {#if ui.activeSurface === 'workflow' && workflow.active}
            <WorkflowBoard />
          {:else}
            <CanvasView />
          {/if}
        </section>
        {#if hasDrawingPanels}
          <aside class="right" class:collapsed={rightCollapsed}>
            {#if rightCollapsed}
              <div class="dock-rail">
                <button
                  class="panel-toggle expand"
                  onclick={expandRightPanels}
                  use:tooltip={{ text: 'Expand panels', placement: 'left' }}
                  aria-label="Expand panels"
                ><Icon svg={ChevronDoubleLeft} size={16} /></button>
                <button
                  class="rail-item"
                  class:active={peekedPanel === 'color'}
                  onclick={() => peekPanel('color')}
                  aria-label="Color"
                  aria-pressed={peekedPanel === 'color'}
                >
                  <Icon svg={ColorPalette} size={18} /><span>Color</span>
                </button>
                <button
                  class="rail-item"
                  class:active={peekedPanel === 'layers'}
                  onclick={() => peekPanel('layers')}
                  aria-label="Layers"
                  aria-pressed={peekedPanel === 'layers'}
                >
                  <Icon svg={Layers} size={18} /><span>Layers</span>
                </button>
              </div>
              {#if peekedPanel}
                <div class="peek-popover" class:layers={peekedPanel === 'layers'}>
                  <div class="peek-bar">
                    <button
                      class="panel-toggle"
                      onclick={closePeekedPanel}
                      use:tooltip={{ text: 'Hide panel', placement: 'left' }}
                      aria-label="Hide panel"
                    ><Icon svg={ChevronDoubleRight} size={16} /></button>
                  </div>
                  <div class="peek-content">
                    {#if peekedPanel === 'color'}
                      <ColorPanel collapsed={false} onToggle={(collapsed) => collapsed && closePeekedPanel()} />
                    {:else}
                      <LayersPanel collapsed={false} onToggle={(collapsed) => collapsed && closePeekedPanel()} />
                    {/if}
                  </div>
                </div>
              {/if}
            {:else}
              <div class="column-bar">
                <button
                  class="panel-toggle"
                  onclick={collapseRightPanels}
                  use:tooltip={{ text: 'Collapse panels', placement: 'left' }}
                  aria-label="Collapse panels"
                ><Icon svg={ChevronDoubleRight} size={16} /></button>
              </div>
              <div class="panel-stack" bind:this={panelStackEl}>
                <ColorPanel
                  bind:collapsed={colorCollapsed}
                  onToggle={(collapsed) => requestPanelCollapsed('color', collapsed)}
                />
                <LayersPanel
                  bind:collapsed={layersCollapsed}
                  onToggle={(collapsed) => requestPanelCollapsed('layers', collapsed)}
                />
              </div>
            {/if}
          </aside>
        {/if}
        <aside class="project-side" class:collapsed={projectCollapsed}>
          {#if projectCollapsed}
            <div class="project-rail">
              <button
                class="rail-icon"
                onclick={() => (projectCollapsed = false)}
                use:tooltip={{ text: 'Expand project', placement: 'left' }}
                aria-label="Expand project"
              >
                <Icon svg={Folder} size={18} />
              </button>
            </div>
          {:else}
            <div class="column-bar">
              <button
                class="panel-toggle"
                onclick={() => (projectCollapsed = true)}
                use:tooltip={{ text: 'Collapse project', placement: 'left' }}
                aria-label="Collapse project"
              ><Icon svg={ChevronDoubleRight} size={16} /></button>
            </div>
            <ProjectPanel />
          {/if}
        </aside>
        </div>
    </div>
  </div>
  <StatusBar />
</div>

{#if ui.dialog === 'new'}
  <NewDocumentDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'about'}
  <AboutDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'imageSize'}
  <ImageSizeDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'brightnessContrast'}
  <BrightnessContrastDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'hueSaturation'}
  <HueSaturationDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'gaussianBlur'}
  <GaussianBlurDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'aiGenerate'}
  <AiGenerateDialog onClose={() => ui.close()} />
{:else if ui.dialog === 'aiDecouple'}
  <AiDecoupleDialog onClose={() => ui.close()} />
{/if}

{#if ui.fontEmbed}
  <FontEmbedDialog />
{/if}

{#if editor.rasterizePrompt}
  <RasterizeTypeDialog />
{/if}

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
  }
  .desktop-titlebar {
    position: relative;
    flex: none;
    height: 38px;
    display: grid;
    place-items: center;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    user-select: none;
    -webkit-user-select: none;
  }
  .desktop-title {
    color: var(--text);
    font-size: 13px;
    font-weight: 700;
    pointer-events: none;
  }
  .middle {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .workspace {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .content-row {
    flex: 1;
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  .center {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .project-side {
    width: 292px;
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    overflow: hidden;
  }
  .project-side.collapsed {
    width: 42px;
  }
  .right {
    width: var(--rightpanel-w);
    flex: none;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border-left: 1px solid var(--border);
    min-height: 0;
    overflow: hidden;
  }
  .right.collapsed {
    position: relative;
    width: 108px;
    overflow: visible;
    z-index: 20;
  }
  .column-bar {
    height: 26px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 6px;
    background: var(--bg-panel-2);
    border-bottom: 1px solid var(--border);
  }
  .project-rail {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: 5px;
  }
  .rail-icon {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--text);
  }
  .rail-icon:hover {
    background: var(--bg-elevated);
  }
  .panel-stack {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .panel-toggle {
    display: grid;
    place-items: center;
    width: 22px;
    height: 20px;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--text-dim);
  }
  .panel-toggle:hover {
    color: var(--text-bright);
  }
  /* Edge-collapsed dock: keep panel labels (Photoshop icon+label rail) */
  .dock-rail {
    display: flex;
    flex-direction: column;
  }
  .dock-rail .panel-toggle.expand {
    align-self: flex-end;
    margin: 4px 5px 4px 0;
  }
  .rail-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: 0;
    color: var(--text);
    text-align: left;
    cursor: pointer;
  }
  .rail-item:hover {
    background: var(--bg-elevated);
  }
  .rail-item.active {
    background: color-mix(in srgb, var(--bg-elevated) 72%, var(--accent) 28%);
    color: var(--text-bright);
  }
  .peek-popover {
    position: absolute;
    top: 0;
    right: 100%;
    width: var(--rightpanel-w);
    max-height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    box-shadow: -8px 10px 22px rgba(0, 0, 0, 0.34);
  }
  .peek-popover.layers {
    max-height: min(520px, 100%);
  }
  .peek-bar {
    height: 26px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    padding: 0 6px;
    background: var(--bg-panel-2);
    border-bottom: 1px solid var(--border);
  }
  .peek-content {
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .peek-popover.layers .peek-content {
    flex: 1;
  }
  .peek-content :global(.panel) {
    border-bottom: 0;
  }
  .peek-popover.layers .peek-content :global(.panel) {
    flex: 1;
  }
</style>
