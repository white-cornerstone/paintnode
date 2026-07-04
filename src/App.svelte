<script lang="ts">
  import { onMount } from 'svelte';
  import type { Component } from 'svelte';
  import MenuBar from './lib/components/MenuBar.svelte';
  import Toolbar from './lib/components/Toolbar.svelte';
  import ToolOptions from './lib/components/ToolOptions.svelte';
  import DocumentTabs from './lib/components/DocumentTabs.svelte';
  import CanvasView from './lib/components/CanvasView.svelte';
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
  import CharacterPanel from './lib/components/CharacterPanel.svelte';
  import ParagraphPanel from './lib/components/ParagraphPanel.svelte';
  import ProjectPanel from './lib/components/ProjectPanel.svelte';
  import TasksPanel from './lib/components/TasksPanel.svelte';
  import StatusBar from './lib/components/StatusBar.svelte';
  import Icon from './lib/components/Icon.svelte';
  import { tooltip, truncatedTooltip } from './lib/actions/tooltip';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import {
    Branch,
    Channel,
    ChevronDoubleLeft,
    ChevronDoubleRight,
    ArrowDownload,
    ColorBackground,
    ColorFill,
    ColorPalette,
    DataHistogram,
    Folder,
    Grid,
    Layers,
    Library,
    Options,
    TextFont,
    TextParagraphIcon,
    TaskList,
  } from './lib/icons';
  import { installKeyboard } from './lib/state/keyboard';
  import {
    autosaveOpenDocuments,
    exportPngCommand,
    exportPsdCommand,
    importImageCommand,
    openCommand,
    openDocumentPaths,
    saveDocumentCommand,
    saveActiveCommand,
    saveActiveCopyCommand,
    saveWorkflowCommand,
  } from './lib/state/commands';
  import { editor, type DocumentSession } from './lib/state/editor.svelte';
  import { isDesktop, quitApplication } from './lib/integrations/desktop';
  import { PANEL_GROUP_IDS, PANEL_GROUP_PANELS, type PanelGroupId, type PanelId } from './lib/state/panels';
  import { aiTasks } from './lib/state/aiTasks.svelte';
  import { panels } from './lib/state/panels.svelte';
  import { project } from './lib/state/project.svelte';
  import { settings } from './lib/state/settings.svelte';
  import { ui } from './lib/state/ui.svelte';
  import { appUpdater } from './lib/state/updater.svelte';
  import { workflow } from './lib/state/workflow.svelte';
  import { runEditableMenuAction } from './lib/state/editing';

  type LazyComponentModule<Props extends Record<string, unknown> = Record<string, never>> = {
    default: Component<Props>;
  };
  type LazyComponentLoader<Props extends Record<string, unknown> = Record<string, never>> = () => Promise<
    LazyComponentModule<Props>
  >;
  type CloseableDialogProps = { onClose: () => void };
  type AiDialogProps = CloseableDialogProps & { taskId?: string | null };

  const loadWorkflowBoard: LazyComponentLoader = () => import('./lib/components/WorkflowBoard.svelte');
  const loadNewDocumentDialog: LazyComponentLoader<CloseableDialogProps> = () => import('./lib/components/NewDocumentDialog.svelte');
  const loadAboutDialog: LazyComponentLoader<CloseableDialogProps> = () => import('./lib/components/AboutDialog.svelte');
  const loadImageSizeDialog: LazyComponentLoader<CloseableDialogProps> = () => import('./lib/components/ImageSizeDialog.svelte');
  const loadBrightnessContrastDialog: LazyComponentLoader<CloseableDialogProps> = () => import('./lib/components/BrightnessContrastDialog.svelte');
  const loadHueSaturationDialog: LazyComponentLoader<CloseableDialogProps> = () => import('./lib/components/HueSaturationDialog.svelte');
  const loadGaussianBlurDialog: LazyComponentLoader<CloseableDialogProps> = () => import('./lib/components/GaussianBlurDialog.svelte');
  const loadAiGenerateDialog: LazyComponentLoader<AiDialogProps> = () => import('./lib/components/AiGenerateDialog.svelte');
  const loadAiRetouchDialog: LazyComponentLoader<AiDialogProps> = () => import('./lib/components/AiRetouchDialog.svelte');
  const loadAiDecoupleDialog: LazyComponentLoader<AiDialogProps> = () => import('./lib/components/AiDecoupleDialog.svelte');
  const loadStockImagesDialog: LazyComponentLoader<CloseableDialogProps> = () => import('./lib/components/StockImagesDialog.svelte');
  const loadSettingsDialog: LazyComponentLoader<CloseableDialogProps> = () => import('./lib/components/SettingsDialog.svelte');
  const loadUpdateDialog: LazyComponentLoader<CloseableDialogProps> = () => import('./lib/components/UpdateDialog.svelte');
  const loadFontEmbedDialog: LazyComponentLoader = () => import('./lib/components/FontEmbedDialog.svelte');
  const loadRasterizeTypeDialog: LazyComponentLoader = () => import('./lib/components/RasterizeTypeDialog.svelte');
  const loadSaveChangesDialog: LazyComponentLoader = () => import('./lib/components/SaveChangesDialog.svelte');

  const desktop = isDesktop();
  const appWindow = desktop ? getCurrentWindow() : null;
  const hasDocument = $derived(ui.activeSurface === 'document' && !!editor.doc);
  const hasDrawingPanels = $derived(hasDocument || (ui.activeSurface === 'workflow' && workflow.storyboardEditing));

  type PanelDef = { id: PanelId; title: string; icon: string; grow?: boolean };
  type PanelGroupDef = { id: PanelGroupId; panels: PanelDef[]; grow?: boolean };
  const panelMeta: Record<PanelId, { title: string; icon: string; grow?: boolean }> = {
    color: { title: 'Color', icon: ColorPalette },
    swatches: { title: 'Swatches', icon: Grid },
    gradients: { title: 'Gradients', icon: ColorFill },
    patterns: { title: 'Patterns', icon: ColorBackground },
    properties: { title: 'Properties', icon: Options },
    adjustments: { title: 'Adjustments', icon: DataHistogram },
    libraries: { title: 'Libraries', icon: Library },
    character: { title: 'Character', icon: TextFont },
    paragraph: { title: 'Paragraph', icon: TextParagraphIcon },
    layers: { title: 'Layers', icon: Layers, grow: true },
    channels: { title: 'Channels', icon: Channel },
    paths: { title: 'Paths', icon: Branch },
  };
  const panelGroups: PanelGroupDef[] = PANEL_GROUP_IDS.map((id) => ({
    id,
    grow: id === 'structure',
    panels: PANEL_GROUP_PANELS[id].map((panelId) => ({ id: panelId, ...panelMeta[panelId] })),
  }));

  type NativeDropPosition = { x: number; y: number };
  type NativeDropPayload = {
    paths?: string[];
    position?: NativeDropPosition;
  };

  function groupForPanel(id: PanelId): PanelGroupDef {
    return panelGroups.find((group) => group.panels.some((panel) => panel.id === id)) ?? panelGroups[0];
  }

  function activePanel(group: PanelGroupDef): PanelId {
    const active = panels.value.activePanelByGroup[group.id];
    return group.panels.some((panel) => panel.id === active) ? active : group.panels[0].id;
  }

  function activatePanel(id: PanelId): void {
    const group = groupForPanel(id);
    panels.setActivePanel(group.id, id);
    panels.setGroupCollapsed(group.id, false);
  }

  function clickExpandedPanelTab(group: PanelGroupDef, id: PanelId): void {
    const isActive = activePanel(group) === id;
    panels.setActivePanel(group.id, id);
    panels.setGroupCollapsed(group.id, isActive ? !panels.value.collapsedGroups[group.id] : false);
  }

  function clickPeekPanelTab(group: PanelGroupDef, id: PanelId): void {
    if (activePanel(group) === id) {
      closePeekedPanel();
      return;
    }
    panels.setActivePanel(group.id, id);
    peekedPanel = id;
  }

  let peekedPanel = $state<PanelId | null>(null);
  let quitGuardRunning = false;
  let quitApproved = false;

  type UnsavedWorkItem =
    | { kind: 'document'; id: string; name: string }
    | { kind: 'workflow'; name: string };

  function expandRightPanels(): void {
    peekedPanel = null;
    panels.setRightCollapsed(false);
  }

  function collapseRightPanels(): void {
    peekedPanel = null;
    panels.setRightCollapsed(true);
  }

  function peekPanel(id: PanelId): void {
    panels.setRightCollapsed(true);
    activatePanel(id);
    peekedPanel = peekedPanel === id ? null : id;
  }

  function closePeekedPanel(): void {
    peekedPanel = null;
  }

  function showProjectSide(): void {
    panels.setProjectCollapsed(false);
  }

  function documentDisplayName(session: DocumentSession): string {
    return editor.documentFileName(session);
  }

  function unsavedWorkItems(): UnsavedWorkItem[] {
    const items: UnsavedWorkItem[] = editor.documents
      .filter((session) => editor.hasUnsavedChanges(session))
      .map((session) => ({ kind: 'document', id: session.id, name: documentDisplayName(session) }));
    if (workflow.active && workflow.dirty) {
      items.push({ kind: 'workflow', name: workflow.name || 'Untitled Workflow' });
    }
    return items;
  }

  function hasUnsavedWork(): boolean {
    return unsavedWorkItems().length > 0;
  }

  async function saveDocumentForClose(id: string): Promise<boolean> {
    const session = editor.documents.find((documentSession) => documentSession.id === id);
    if (!session) return true;
    editor.switchDocument(id);
    await saveDocumentCommand();
    const updated = editor.documents.find((documentSession) => documentSession.id === id);
    return !updated || !editor.hasUnsavedChanges(updated);
  }

  async function closeDocumentWithPrompt(session: DocumentSession): Promise<void> {
    if (!editor.hasUnsavedChanges(session)) {
      editor.closeDocument(session.id);
      return;
    }

    editor.switchDocument(session.id);
    const choice = await ui.askSaveChanges({
      kind: 'document',
      name: documentDisplayName(session),
      index: 1,
      total: 1,
    });
    if (choice === 'cancel') return;
    if (choice === 'save') {
      const saved = await saveDocumentForClose(session.id);
      if (!saved) return;
    }
    editor.closeDocument(session.id);
  }

  async function closeActiveDocument(): Promise<void> {
    if (ui.activeSurface === 'workflow') {
      workflow.close();
      return;
    }
    const session = editor.activeDocument;
    if (!session) return;
    await closeDocumentWithPrompt(session);
  }

  async function saveWorkflowForClose(): Promise<boolean> {
    workflow.show();
    await saveWorkflowCommand();
    return !workflow.dirty;
  }

  async function confirmUnsavedWorkBeforeClose(items = unsavedWorkItems()): Promise<boolean> {
    const total = items.length;
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.kind === 'document') {
        const session = editor.documents.find((documentSession) => documentSession.id === item.id);
        if (!session || !editor.hasUnsavedChanges(session)) continue;
        editor.switchDocument(item.id);
      } else if (!workflow.active || !workflow.dirty) {
        continue;
      } else {
        workflow.show();
      }

      const choice = await ui.askSaveChanges({
        kind: item.kind,
        name: item.name,
        index: index + 1,
        total,
      });
      if (choice === 'cancel') return false;
      if (choice === 'discard') continue;

      const saved = item.kind === 'document' ? await saveDocumentForClose(item.id) : await saveWorkflowForClose();
      if (!saved) return false;
    }
    return true;
  }

  async function requestApplicationClose(): Promise<void> {
    if (quitGuardRunning) return;
    quitGuardRunning = true;
    quitApproved = false;
    try {
      const canClose = await confirmUnsavedWorkBeforeClose();
      if (!canClose) {
        quitGuardRunning = false;
        return;
      }
      quitApproved = true;
      if (desktop) await quitApplication();
      else window.close();
    } catch (error) {
      quitApproved = false;
      quitGuardRunning = false;
      editor.flash('Quit failed: ' + (error as Error).message);
    }
  }

  function runAppMenuAction(id: string): void {
    if (runEditableMenuAction(id)) return;

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
      case 'app:export-psd':
        void exportPsdCommand();
        break;
      case 'app:close-document':
        void closeActiveDocument();
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
        ui.open('about');
        break;
      case 'app:settings':
        ui.open('settings');
        break;
      case 'app:check-updates':
        ui.open('update');
        void appUpdater.checkForUpdates();
        break;
      case 'app:quit':
        void requestApplicationClose();
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

  function preventWebviewContextMenu(event: MouseEvent): void {
    if (event.defaultPrevented) return;
    event.preventDefault();
  }

  function nativeDropPaths(payload: unknown): string[] {
    if (Array.isArray(payload)) return payload.filter((path): path is string => typeof path === 'string');
    const paths = (payload as NativeDropPayload | null)?.paths;
    return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
  }

  function nativeDropPosition(payload: unknown): NativeDropPosition | null {
    if (!payload || Array.isArray(payload)) return null;
    const position = (payload as NativeDropPayload).position;
    return typeof position?.x === 'number' && typeof position.y === 'number' ? position : null;
  }

  function shouldOpenNativeDrop(payload: unknown): boolean {
    const position = nativeDropPosition(payload);
    if (!position) return true;
    const target = document.elementFromPoint(position.x, position.y) as HTMLElement | null;
    if (!target) return false;
    return !editor.doc || !!target.closest('.doc-tabs, .empty-workspace');
  }

  async function handleNativeFileDrop(payload: unknown): Promise<void> {
    const paths = nativeDropPaths(payload);
    if (!paths.length || !shouldOpenNativeDrop(payload)) return;
    await openDocumentPaths(paths);
  }

  $effect(() => {
    if (!settings.value.general.autosaveEnabled) return;
    const autosave = window.setInterval(
      () => void autosaveOpenDocuments(),
      settings.value.general.autosaveIntervalMs,
    );
    return () => window.clearInterval(autosave);
  });

  $effect(() => {
    aiTasks.setProjectPath(project.path);
  });

  onMount(() => {
    const disposeKeyboard = installKeyboard();
    ui.contextualTaskBarVisible = settings.value.general.showContextualTaskBarOnStartup;
    if (settings.value.general.reopenLastProject) void project.restore();
    let unlistenMenu: UnlistenFn | null = null;
    let unlistenClose: UnlistenFn | null = null;
    const unlistenNativeDrops: UnlistenFn[] = [];
    if (desktop) {
      window.setTimeout(() => void appUpdater.checkForUpdates(), 2500);
      void listen<string>('app-menu', (event) => runAppMenuAction(event.payload)).then((unlisten) => {
        unlistenMenu = unlisten;
      });
      if (appWindow) {
        void appWindow.onCloseRequested(async (event) => {
          if (quitApproved) return;
          event.preventDefault();
          if (quitGuardRunning) {
            return;
          }
          await requestApplicationClose();
        }).then((unlisten) => {
          unlistenClose = unlisten;
        });
      }
      void listen<unknown>('tauri://drag-drop', (event) => void handleNativeFileDrop(event.payload)).then((unlisten) => {
        unlistenNativeDrops.push(unlisten);
      });
      void listen<unknown>('tauri://file-drop', (event) => void handleNativeFileDrop(event.payload)).then((unlisten) => {
        unlistenNativeDrops.push(unlisten);
      });
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (quitApproved || !hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const showPropertiesPanel = () => {
      ui.showDocument();
      activatePanel('properties');
      expandRightPanels();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('contextmenu', preventWebviewContextMenu);
    window.addEventListener('paintnode:show-properties-panel', showPropertiesPanel);
    return () => {
      unlistenMenu?.();
      unlistenClose?.();
      unlistenNativeDrops.forEach((unlisten) => unlisten());
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('contextmenu', preventWebviewContextMenu);
      window.removeEventListener('paintnode:show-properties-panel', showPropertiesPanel);
      disposeKeyboard();
    };
  });

  $effect(() => {
    if (!panels.value.rightCollapsed) peekedPanel = null;
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
  {:else if id === 'character'}
    <CharacterPanel {collapsed} {onToggle} />
  {:else if id === 'paragraph'}
    <ParagraphPanel {collapsed} {onToggle} />
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
      {@const isActive = activePanel(group) === panel.id}
      <button
        class="panel-tab"
        class:active={isActive}
        role="tab"
        aria-selected={isActive}
        aria-expanded={closePeeked ? peekedPanel === panel.id : isActive && !panels.value.collapsedGroups[group.id]}
        onclick={() => (closePeeked ? clickPeekPanelTab(group, panel.id) : clickExpandedPanelTab(group, panel.id))}
        use:truncatedTooltip={{ text: panel.title, placement: 'bottom' }}
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

{#snippet lazyComponent(loader: LazyComponentLoader)}
  {#await loader() then module}
    {@const LazyComponent = module.default}
    <LazyComponent />
  {/await}
{/snippet}

{#snippet lazyDialog(loader: LazyComponentLoader<CloseableDialogProps>)}
  {#await loader() then module}
    {@const Dialog = module.default}
    <Dialog onClose={() => ui.close()} />
  {/await}
{/snippet}

{#snippet lazyAiDialog(loader: LazyComponentLoader<AiDialogProps>)}
  {#await loader() then module}
    {@const Dialog = module.default}
    <Dialog onClose={() => ui.close()} taskId={ui.aiTaskDialog?.id ?? null} />
  {/await}
{/snippet}

<div class="app" class:workspace-focus={ui.workspaceFocusMode}>
  {#if desktop}
    <div class="desktop-titlebar" data-tauri-drag-region use:titlebarDrag>
      <div class="desktop-title">PaintNode</div>
      {#if appUpdater.available}
        <button
          class="titlebar-update"
          type="button"
          onclick={() => ui.open('update')}
          onpointerdown={(event) => event.stopPropagation()}
          use:tooltip={{ text: `Install PaintNode ${appUpdater.version}`, placement: 'bottom' }}
        >
          <Icon svg={ArrowDownload} size={14} />
          <span>Update</span>
        </button>
      {/if}
    </div>
  {:else if !ui.workspaceFocusMode}
    <MenuBar />
  {/if}
  <div class="middle">
    {#if !ui.workspaceFocusMode}
      <Toolbar />
    {/if}
    <div class="workspace">
      {#if !ui.workspaceFocusMode}
        <ToolOptions />
      {/if}
      <div class="content-row">
        <section class="center">
          <DocumentTabs />
          {#if ui.activeSurface === 'workflow' && workflow.active}
            {@render lazyComponent(loadWorkflowBoard)}
          {:else}
            <CanvasView />
          {/if}
        </section>
        {#if hasDrawingPanels && !ui.workspaceFocusMode}
          <aside class="right" class:collapsed={panels.value.rightCollapsed}>
            {#if panels.value.rightCollapsed}
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
                  <div
                    class="panel-group"
                    class:separated={groupIndex > 0}
                    class:grow={group.grow}
                    class:collapsed={panels.value.collapsedGroups[group.id]}
                  >
                    {@render panelTabGroup(group)}
                    {#if !panels.value.collapsedGroups[group.id]}
                      <div class="tab-content">
                        {@render rightPanel(activePanel(group), false, () => undefined)}
                      </div>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
          </aside>
        {/if}
        {#if !ui.workspaceFocusMode}
          <aside class="project-side" class:collapsed={panels.value.projectCollapsed}>
            {#if panels.value.projectCollapsed}
              <div class="project-rail">
                <button
                  class="panel-toggle expand"
                  onclick={showProjectSide}
                  use:tooltip={{ text: 'Expand panels', placement: 'left' }}
                  aria-label="Expand panels"
                ><Icon svg={ChevronDoubleLeft} size={16} /></button>
                <button
                  class="rail-icon"
                  onclick={showProjectSide}
                  use:tooltip={{ text: 'Tasks', placement: 'left' }}
                  aria-label="Tasks"
                >
                  <Icon svg={TaskList} size={18} />
                </button>
                <button
                  class="rail-icon"
                  onclick={showProjectSide}
                  use:tooltip={{ text: 'Project', placement: 'left' }}
                  aria-label="Project"
                >
                  <Icon svg={Folder} size={18} />
                </button>
              </div>
            {:else}
              <div class="column-bar">
                <button
                  class="panel-toggle"
                  onclick={() => panels.setProjectCollapsed(true)}
                  use:tooltip={{ text: 'Collapse panels', placement: 'left' }}
                  aria-label="Collapse panels"
                ><Icon svg={ChevronDoubleRight} size={16} /></button>
              </div>
              <ProjectPanel />
              <TasksPanel />
            {/if}
          </aside>
        {/if}
      </div>
    </div>
  </div>
  {#if !ui.workspaceFocusMode}
    <StatusBar />
  {/if}
</div>

{#if ui.dialog === 'new'}
  {@render lazyDialog(loadNewDocumentDialog)}
{:else if ui.dialog === 'about'}
  {@render lazyDialog(loadAboutDialog)}
{:else if ui.dialog === 'imageSize'}
  {@render lazyDialog(loadImageSizeDialog)}
{:else if ui.dialog === 'brightnessContrast'}
  {@render lazyDialog(loadBrightnessContrastDialog)}
{:else if ui.dialog === 'hueSaturation'}
  {@render lazyDialog(loadHueSaturationDialog)}
{:else if ui.dialog === 'gaussianBlur'}
  {@render lazyDialog(loadGaussianBlurDialog)}
{:else if ui.dialog === 'aiGenerate'}
  {@render lazyAiDialog(loadAiGenerateDialog)}
{:else if ui.dialog === 'aiRetouch'}
  {@render lazyAiDialog(loadAiRetouchDialog)}
{:else if ui.dialog === 'aiDecouple'}
  {@render lazyAiDialog(loadAiDecoupleDialog)}
{:else if ui.dialog === 'stockImages'}
  {@render lazyDialog(loadStockImagesDialog)}
{:else if ui.dialog === 'settings'}
  {@render lazyDialog(loadSettingsDialog)}
{:else if ui.dialog === 'update'}
  {@render lazyDialog(loadUpdateDialog)}
{/if}

{#if ui.fontEmbed}
  {@render lazyComponent(loadFontEmbedDialog)}
{/if}

{#if editor.rasterizePrompt}
  {@render lazyComponent(loadRasterizeTypeDialog)}
{/if}

{#if ui.saveChanges}
  {@render lazyComponent(loadSaveChangesDialog)}
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
  .titlebar-update {
    position: absolute;
    right: 12px;
    top: 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-width: 86px;
    height: 24px;
    padding: 0 11px;
    border: 1px solid color-mix(in srgb, #0a84ff 84%, #fff 16%);
    border-radius: 5px;
    background: #0a84ff;
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.16) inset;
  }
  .titlebar-update:hover {
    background: #1b8dff;
  }
  .titlebar-update:active {
    background: #006fd6;
  }
  .titlebar-update:focus-visible {
    outline: 2px solid color-mix(in srgb, #0a84ff 60%, #fff 40%);
    outline-offset: 2px;
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
    padding-top: 4px;
  }
  .project-rail .panel-toggle.expand {
    align-self: flex-end;
    margin: 0 5px 4px 0;
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
  .panel-group.grow.collapsed {
    flex: none;
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
  /* Edge-collapsed dock: keep panel labels in the icon+label rail. */
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
  .peek-content :global(.panel-head) {
    display: none;
  }
  .peek-popover.layers .peek-content :global(.panel) {
    flex: 1;
  }
</style>
