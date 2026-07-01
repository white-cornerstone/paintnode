<script lang="ts">
  import { onMount } from 'svelte';
  import MenuBar from './lib/components/MenuBar.svelte';
  import Toolbar from './lib/components/Toolbar.svelte';
  import ToolOptions from './lib/components/ToolOptions.svelte';
  import DocumentTabs from './lib/components/DocumentTabs.svelte';
  import CanvasView from './lib/components/CanvasView.svelte';
  import WorkflowBoard from './lib/components/WorkflowBoard.svelte';
  import LayersPanel from './lib/components/LayersPanel.svelte';
  import ColorPanel from './lib/components/ColorPanel.svelte';
  import SwatchesPanel from './lib/components/SwatchesPanel.svelte';
  import GradientsPanel from './lib/components/GradientsPanel.svelte';
  import PatternsPanel from './lib/components/PatternsPanel.svelte';
  import PropertiesPanel from './lib/components/PropertiesPanel.svelte';
  import AdjustmentsPanel from './lib/components/AdjustmentsPanel.svelte';
  import LibrariesPanel from './lib/components/LibrariesPanel.svelte';
  import ChannelsPanel from './lib/components/ChannelsPanel.svelte';
  import PathsPanel from './lib/components/PathsPanel.svelte';
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
  import {
    Branch,
    Channel,
    ChevronDoubleLeft,
    ChevronDoubleRight,
    ColorBackground,
    ColorFill,
    ColorPalette,
    DataHistogram,
    Folder,
    Grid,
    Layers,
    Library,
    Options,
  } from './lib/icons';
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
  const hasDocument = $derived(ui.activeSurface === 'document' && !!editor.doc);
  const hasDrawingPanels = $derived(hasDocument || (ui.activeSurface === 'workflow' && workflow.storyboardEditing));

  type PanelId =
    | 'color'
    | 'swatches'
    | 'gradients'
    | 'patterns'
    | 'properties'
    | 'adjustments'
    | 'libraries'
    | 'layers'
    | 'channels'
    | 'paths';
  type PanelDef = { id: PanelId; title: string; icon: string; grow?: boolean };
  type PanelGroupId = 'presets' | 'edits' | 'structure';
  type PanelGroupDef = { id: PanelGroupId; panels: PanelDef[]; grow?: boolean };
  const panelGroups: PanelGroupDef[] = [
    {
      id: 'presets',
      panels: [
        { id: 'color', title: 'Color', icon: ColorPalette },
        { id: 'swatches', title: 'Swatches', icon: Grid },
        { id: 'gradients', title: 'Gradients', icon: ColorFill },
        { id: 'patterns', title: 'Patterns', icon: ColorBackground },
      ],
    },
    {
      id: 'edits',
      panels: [
        { id: 'properties', title: 'Properties', icon: Options },
        { id: 'adjustments', title: 'Adjustments', icon: DataHistogram },
        { id: 'libraries', title: 'Libraries', icon: Library },
      ],
    },
    {
      id: 'structure',
      grow: true,
      panels: [
        { id: 'layers', title: 'Layers', icon: Layers, grow: true },
        { id: 'channels', title: 'Channels', icon: Channel },
        { id: 'paths', title: 'Paths', icon: Branch },
      ],
    },
  ];
  let activePanelByGroup = $state<Record<PanelGroupId, PanelId>>({
    presets: 'color',
    edits: 'properties',
    structure: 'layers',
  });

  function groupForPanel(id: PanelId): PanelGroupDef {
    return panelGroups.find((group) => group.panels.some((panel) => panel.id === id)) ?? panelGroups[0];
  }

  function activePanel(group: PanelGroupDef): PanelId {
    const active = activePanelByGroup[group.id];
    return group.panels.some((panel) => panel.id === active) ? active : group.panels[0].id;
  }

  function activatePanel(id: PanelId): void {
    const group = groupForPanel(id);
    activePanelByGroup[group.id] = id;
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
    activatePanel(id);
    peekedPanel = peekedPanel === id ? null : id;
  }

  function closePeekedPanel(): void {
    peekedPanel = null;
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
    let unlistenMenu: UnlistenFn | null = null;
    if (desktop) {
      void listen<string>('app-menu', (event) => runAppMenuAction(event.payload)).then((unlisten) => {
        unlistenMenu = unlisten;
      });
    }
    return () => {
      unlistenMenu?.();
      window.clearInterval(autosave);
      disposeKeyboard();
    };
  });

  $effect(() => {
    if (!rightCollapsed) peekedPanel = null;
  });
</script>

{#snippet rightPanel(id: PanelId, collapsed: boolean, onToggle: (collapsed: boolean) => void)}
  {#if id === 'color'}
    <ColorPanel {collapsed} {onToggle} />
  {:else if id === 'swatches'}
    <SwatchesPanel {collapsed} {onToggle} />
  {:else if id === 'gradients'}
    <GradientsPanel {collapsed} {onToggle} />
  {:else if id === 'patterns'}
    <PatternsPanel {collapsed} {onToggle} />
  {:else if id === 'properties'}
    <PropertiesPanel {collapsed} {onToggle} />
  {:else if id === 'adjustments'}
    <AdjustmentsPanel {collapsed} {onToggle} />
  {:else if id === 'libraries'}
    <LibrariesPanel {collapsed} {onToggle} />
  {:else if id === 'layers'}
    <LayersPanel {collapsed} {onToggle} />
  {:else if id === 'channels'}
    <ChannelsPanel {collapsed} {onToggle} />
  {:else if id === 'paths'}
    <PathsPanel {collapsed} {onToggle} />
  {/if}
{/snippet}

{#snippet panelTabGroup(group: PanelGroupDef, closePeeked = false)}
  <div class="panel-tabs" role="tablist" aria-label="Panel group">
    {#each group.panels as panel (panel.id)}
      <button
        class="panel-tab"
        class:active={activePanel(group) === panel.id}
        role="tab"
        aria-selected={activePanel(group) === panel.id}
        onclick={() => activatePanel(panel.id)}
      >
        {panel.title}
      </button>
    {/each}
    {#if closePeeked}
      <button
        class="panel-menu close"
        onclick={closePeekedPanel}
        use:tooltip={{ text: 'Hide panel group', placement: 'left' }}
        aria-label="Hide panel group"
      >
        <Icon svg={ChevronDoubleRight} size={16} />
      </button>
    {/if}
  </div>
{/snippet}

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
                {#each panelGroups as group, groupIndex}
                  <div class="rail-group" class:separated={groupIndex > 0}>
                    {#each group.panels as panel (panel.id)}
                      <button
                        class="rail-item"
                        class:active={peekedPanel === panel.id}
                        onclick={() => peekPanel(panel.id)}
                        aria-label={panel.title}
                        aria-pressed={peekedPanel === panel.id}
                      >
                        <Icon svg={panel.icon} size={18} /><span>{panel.title}</span>
                      </button>
                    {/each}
                  </div>
                {/each}
              </div>
              {#if peekedPanel}
                <div class="peek-popover" class:layers={groupForPanel(peekedPanel).id === 'structure'}>
                  {@render panelTabGroup(groupForPanel(peekedPanel), true)}
                  <div class="peek-content">
                    {@render rightPanel(activePanel(groupForPanel(peekedPanel)), false, (collapsed) => collapsed && closePeekedPanel())}
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
              <div class="panel-stack">
                {#each panelGroups as group, groupIndex}
                  <div class="panel-group" class:separated={groupIndex > 0} class:grow={group.grow}>
                    {@render panelTabGroup(group)}
                    <div class="tab-content">
                      {@render rightPanel(activePanel(group), false, () => undefined)}
                    </div>
                  </div>
                {/each}
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
    width: 132px;
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
    overflow-y: auto;
    overflow-x: hidden;
  }
  .panel-group {
    display: flex;
    flex: none;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-panel);
  }
  .panel-group.grow {
    flex: 1 1 180px;
  }
  .panel-group.separated {
    border-top: 1px solid color-mix(in srgb, var(--border) 82%, #000 18%);
  }
  .panel-tabs {
    display: flex;
    flex: none;
    align-items: flex-end;
    min-height: 32px;
    overflow-x: hidden;
    overflow-y: hidden;
    background: color-mix(in srgb, var(--bg-panel-2) 88%, #000 12%);
    border-bottom: 1px solid var(--border);
    padding-top: 2px;
    scrollbar-width: none;
  }
  .panel-tabs::-webkit-scrollbar {
    display: none;
  }
  .panel-tab {
    position: relative;
    flex: 0 1 auto;
    min-width: 0;
    height: 30px;
    margin-bottom: -1px;
    padding: 0 7px;
    background: color-mix(in srgb, var(--bg-panel-2) 86%, #000 14%);
    border: 1px solid var(--border);
    border-left: 0;
    border-right: 1px solid var(--border);
    border-radius: 0;
    color: color-mix(in srgb, var(--text) 72%, #000 28%);
    font-size: 11px;
    font-weight: 700;
    line-height: 29px;
    text-align: center;
    text-overflow: ellipsis;
    overflow: hidden;
    white-space: nowrap;
  }
  .panel-tab:first-child {
    border-left: 0;
  }
  .panel-tab:hover {
    background: color-mix(in srgb, var(--bg-panel-2) 78%, #fff 6%);
    color: var(--text-bright);
  }
  .panel-tab.active {
    height: 32px;
    background: var(--bg-panel);
    border-top-color: color-mix(in srgb, var(--border) 74%, #fff 16%);
    border-bottom-color: var(--bg-panel);
    color: var(--text-bright);
    line-height: 31px;
    z-index: 1;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  }
  .panel-tab.active::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 1px;
    background: var(--bg-panel);
  }
  .panel-menu {
    display: grid;
    flex: 0 0 26px;
    place-items: center;
    align-self: stretch;
    margin-left: auto;
    color: var(--text-dim);
    border-left: 1px solid var(--border);
  }
  .panel-menu.close {
    padding: 0;
    background: transparent;
    border-top: 0;
    border-right: 0;
    border-bottom: 0;
    border-radius: 0;
  }
  .panel-menu.close:hover {
    color: var(--text-bright);
    background: var(--bg-elevated);
  }
  .tab-content {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
  }
  .panel-group.grow .tab-content {
    flex: 1;
  }
  .tab-content :global(.panel) {
    border-bottom: 0;
  }
  .tab-content :global(.panel-head) {
    display: none;
  }
  .tab-content :global(.panel.grow) {
    flex: 1;
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
  .rail-group {
    display: flex;
    flex-direction: column;
    padding: 3px 0;
  }
  .rail-group.separated {
    border-top: 1px solid color-mix(in srgb, var(--border) 82%, #000 18%);
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
  .rail-item span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
