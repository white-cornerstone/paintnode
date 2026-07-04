<script lang="ts">
  import type { Action } from 'svelte/action';
  import Panel from './Panel.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { ui } from '../state/ui.svelte';
  import { workflow } from '../state/workflow.svelte';
  import { projectDocumentSourceKey } from '../state/documentSource';
  import type { ProjectAsset, ProjectFile } from '../integrations/desktop';
  import { isDesktop } from '../integrations/desktop';
  import { bytesToBitmap, openFiles } from '../io';
  import { loadOra } from '../ora/load';
  import { loadPsd } from '../psd/load';
  import {
    ArchiveClock,
    Apps,
    AppsList,
    AppsListDetail,
    ArrowSync,
    ChevronDown,
    ChevronRight,
    Delete,
    Dismiss,
    Document,
    Folder,
    FolderOpen,
    Image,
    ImageAdd,
    Open,
    OpenFolder,
    Sparkle,
  } from '../icons';

  type ViewMode = 'list' | 'icon' | 'detail';
  type ProjectSectionId = 'documents' | 'storyboards' | 'workflows' | 'autosave' | 'generated' | 'imported';
  type FileMenu = {
    file: ProjectFile;
    allowDelete: boolean;
    x: number;
    y: number;
  };

  let { collapsed = $bindable(false) }: { collapsed?: boolean } = $props();

  const desktop = isDesktop();
  let viewMode = $state<ViewMode>('list');
  let fileMenu = $state<FileMenu | null>(null);
  let collapsedGroups = $state<Record<ProjectSectionId, boolean>>({
    documents: false,
    storyboards: false,
    workflows: false,
    autosave: false,
    generated: false,
    imported: false,
  });
  const files = $derived(project.current?.files ?? []);
  const assets = $derived(project.current?.assets ?? []);
  const assetByPath = $derived(new Map(assets.map((asset) => [asset.relativePath, asset])));
  const documentFiles = $derived(files.filter((file) => file.kind === 'document'));
  const storyboardFiles = $derived(files.filter((file) => file.kind === 'storyboard'));
  const workflowFiles = $derived(files.filter((file) => file.kind === 'workflow'));
  const autosaveFiles = $derived(files.filter((file) => file.kind === 'autosave'));
  const generatedFiles = $derived(files.filter((file) => file.kind === 'generated'));
  const importedFiles = $derived(files.filter((file) => file.kind === 'imported'));
  const viewModes: { id: ViewMode; label: string; icon: string }[] = [
    { id: 'list', label: 'List view', icon: AppsList },
    { id: 'icon', label: 'Icon view', icon: Apps },
    { id: 'detail', label: 'Detail view', icon: AppsListDetail },
  ];
  const dateFormatter =
    typeof Intl !== 'undefined'
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : null;

  function assetFor(file: ProjectFile): ProjectAsset | null {
    return assetByPath.get(file.relativePath) ?? null;
  }

  function isOra(file: ProjectFile): boolean {
    return /\.ora$/i.test(file.name) || file.mime === 'image/openraster';
  }

  function isPsd(file: ProjectFile): boolean {
    return /\.psd$/i.test(file.name) || file.mime === 'image/vnd.adobe.photoshop';
  }

  function isWorkflow(file: ProjectFile): boolean {
    return file.kind === 'workflow' || /\.cxflow\.json$/i.test(file.name);
  }

  function isImage(file: ProjectFile): boolean {
    return file.mime?.startsWith('image/') === true && !isOra(file) && !isPsd(file);
  }

  function iconFor(file: ProjectFile): string {
    if (file.kind === 'autosave') return ArchiveClock;
    if (isWorkflow(file)) return Sparkle;
    if (isOra(file) || isPsd(file) || file.kind === 'document') return Document;
    if (isImage(file)) return Image;
    return Folder;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function kindLabel(file: ProjectFile): string {
    return file.kind === 'document'
      ? 'document'
      : file.kind === 'storyboard'
        ? 'storyboard'
      : file.kind === 'workflow'
        ? 'workflow'
      : file.kind === 'autosave'
        ? 'autosave'
        : file.kind === 'generated'
          ? 'generated'
          : file.kind === 'imported'
            ? 'imported'
            : file.kind;
  }

  function metaFor(file: ProjectFile): string {
    return `${kindLabel(file)} · ${formatSize(file.size)}`;
  }

  function isTextCropped(node: HTMLElement): boolean {
    return node.scrollWidth - node.clientWidth > 1 || node.scrollHeight - node.clientHeight > 1;
  }

  const croppedNameTooltip: Action<HTMLElement, string> = (node, name) => {
    const tip = tooltip(node, { text: '', placement: 'top' });

    const updateTip = () => {
      if (tip) tip.update?.({ text: isTextCropped(node) ? name : '', placement: 'top' });
    };

    node.addEventListener('pointerenter', updateTip);
    node.addEventListener('focus', updateTip);
    updateTip();

    return {
      update(nextName: string) {
        name = nextName;
        updateTip();
      },
      destroy() {
        node.removeEventListener('pointerenter', updateTip);
        node.removeEventListener('focus', updateTip);
        if (tip) tip.destroy?.();
      },
    };
  };

  function formatDate(ms: number | null | undefined): string {
    if (!ms) return '-';
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return '-';
    return dateFormatter?.format(date) ?? date.toLocaleString();
  }

  function openFileMenu(event: MouseEvent, file: ProjectFile, allowDelete: boolean): void {
    event.preventDefault();
    fileMenu = {
      file,
      allowDelete,
      x: Math.min(event.clientX, window.innerWidth - 172),
      y: Math.min(event.clientY, window.innerHeight - 116),
    };
  }

  function closeFileMenu(): void {
    fileMenu = null;
  }

  function showDetails(): void {
    viewMode = 'detail';
    closeFileMenu();
  }

  async function revealFromMenu(file: ProjectFile): Promise<void> {
    closeFileMenu();
    await revealFile(file);
  }

  async function removeFromMenu(file: ProjectFile): Promise<void> {
    closeFileMenu();
    await remove(file);
  }

  function bufferFrom(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async function openFile(file: ProjectFile) {
    try {
      await ui.withLoading(`Opening ${file.name}…`, () => openFileInner(file));
    } catch (e) {
      editor.flash('Open project file failed: ' + ((e as Error)?.message ?? String(e)));
    }
  }

  async function openFileInner(file: ProjectFile) {
    if (isOra(file)) {
      const sourceKey = projectDocumentSourceKey(file.relativePath);
      if (editor.focusDocumentBySource(sourceKey)) {
        editor.flash(`${file.name} is already open`);
        return;
      }

      const bytes = await project.readFile(file);
      const doc = await loadOra(bufferFrom(bytes));
      doc.name = file.name.replace(/\.ora$/i, '');
      editor.openDocument(doc, true, sourceKey);
      editor.markSaved(file.relativePath);
      editor.flash(`Opened ${file.name}`);
      return;
    }

    if (isPsd(file)) {
      const sourceKey = projectDocumentSourceKey(file.relativePath);
      if (editor.focusDocumentBySource(sourceKey)) {
        editor.flash(`${file.name} is already open`);
        return;
      }

      const bytes = await project.readFile(file);
      const { doc, notices } = await loadPsd(bufferFrom(bytes));
      doc.name = file.name.replace(/\.psd$/i, '');
      // The document stays .psd, but no savedPath is adopted: the first Save
      // prompts for a name, so overwriting the opened file is an explicit choice.
      const session = editor.openDocument(doc, true, sourceKey);
      session.saveFormat = 'psd';
      session.sourceExtension = 'psd';
      editor.flash(notices.length ? `Opened ${file.name} — ${notices.join('; ')}` : `Opened ${file.name}`);
      return;
    }

    if (isWorkflow(file)) {
      const bytes = await project.readFile(file);
      workflow.openFromBytes(bytes, file.relativePath, file.name.replace(/\.cxflow\.json$/i, ''));
      editor.flash(`Opened ${file.name}`);
      return;
    }

    if (isImage(file)) {
      const bytes = await project.readFile(file);
      const bmp = await bytesToBitmap(bytes, file.mime ?? 'image/png');
      try {
        const asset = assetFor(file);
        const placed = editor.placeImage(bmp, bmp.width, bmp.height, file.name.replace(/\.[^.]+$/, ''), {
          assetId: asset?.id ?? null,
          path: file.relativePath,
        });
        editor.flash(
          placed.oversized
            ? `Placed ${file.name} full-size; use Move or Image > Reveal All`
            : `Placed ${file.name}`,
        );
      } finally {
        bmp.close();
      }
      return;
    }

    await project.revealFile(file);
  }

  async function revealFile(file: ProjectFile) {
    try {
      await project.revealFile(file);
    } catch (e) {
      editor.flash('Reveal file failed: ' + ((e as Error)?.message ?? String(e)));
    }
  }

  async function remove(file: ProjectFile) {
    const asset = assetFor(file);
    if (!asset) return;
    try {
      await project.deleteAsset(asset);
      editor.flash(`Moved ${asset.name} to project trash`);
    } catch (e) {
      editor.flash('Delete asset failed: ' + ((e as Error)?.message ?? String(e)));
    }
  }

  async function switchProject(): Promise<void> {
    closeFileMenu();
    await project.openFolder();
  }

  function closeProject(): void {
    closeFileMenu();
    project.clear();
  }

  function toggleGroup(id: ProjectSectionId): void {
    collapsedGroups[id] = !collapsedGroups[id];
  }

  async function importExternalImages(): Promise<void> {
    if (!project.path) return;
    closeFileMenu();
    const selected = await openFiles('image/png,image/jpeg,image/webp,image/gif', true);
    if (!selected.length) return;
    let imported = 0;
    try {
      await ui.withLoading(selected.length === 1 ? `Importing ${selected[0].name}…` : 'Importing images…', async () => {
        for (const file of selected) {
          const bmp = await createImageBitmap(file);
          try {
            await project.storeImportedFile(file, bmp.width, bmp.height);
          } finally {
            bmp.close();
          }
          imported += 1;
        }
      });
      editor.flash(imported === 1 ? `Imported ${selected[0].name}` : `Imported ${imported} images`);
    } catch (e) {
      editor.flash('Import image failed: ' + ((e as Error)?.message ?? String(e)));
    }
  }
</script>

{#snippet fileThumb(file: ProjectFile, actionLabel: 'Open' | 'Place')}
  <button class="thumb" aria-label={`${actionLabel} ${file.name}`} onclick={() => void openFile(file)}>
    {#if file.previewDataUrl}
      <img src={file.previewDataUrl} alt="" />
    {:else}
      <Icon svg={iconFor(file)} size={22} />
    {/if}
  </button>
{/snippet}

{#snippet fileActions(file: ProjectFile, allowDelete: boolean)}
  <div class="file-actions">
    <button
      aria-label={`Reveal ${file.name}`}
      use:tooltip={{ text: 'Reveal file', placement: 'left' }}
      onclick={() => void revealFile(file)}
    >
      <Icon svg={Open} size={14} />
    </button>
    {#if allowDelete && assetFor(file)}
      <button
        aria-label={`Move ${file.name} to trash`}
        use:tooltip={{ text: 'Move to trash', placement: 'left' }}
        onclick={() => void remove(file)}
      >
        <Icon svg={Delete} size={14} />
      </button>
    {/if}
  </div>
{/snippet}

{#snippet fileTile(file: ProjectFile, actionLabel: 'Open' | 'Place', allowDelete: boolean)}
  {#if viewMode === 'icon'}
    <div
      class="file-tile"
      role="listitem"
      oncontextmenu={(event) => openFileMenu(event, file, allowDelete)}
    >
      {@render fileThumb(file, actionLabel)}
      <button class="file-name" use:croppedNameTooltip={file.name} onclick={() => void openFile(file)}>{file.name}</button>
    </div>
  {:else}
    <div class="file-row" role="listitem" oncontextmenu={(event) => openFileMenu(event, file, allowDelete)}>
      {@render fileThumb(file, actionLabel)}
      <div class="meta">
        <button class="file-name" onclick={() => void openFile(file)}>{file.name}</button>
        <span>{metaFor(file)}</span>
      </div>
      {@render fileActions(file, allowDelete)}
    </div>
  {/if}
{/snippet}

{#snippet detailRow(file: ProjectFile, actionLabel: 'Open' | 'Place', allowDelete: boolean)}
  <div
    class="detail-row"
    role="row"
    tabindex="-1"
    oncontextmenu={(event) => openFileMenu(event, file, allowDelete)}
  >
    <div class="detail-file" role="cell">
      {@render fileThumb(file, actionLabel)}
      <button class="file-name" onclick={() => void openFile(file)}>{file.name}</button>
    </div>
    <span role="cell">{kindLabel(file)}</span>
    <span role="cell">{formatSize(file.size)}</span>
    <span role="cell">{formatDate(file.createdAt)}</span>
    <span role="cell">{formatDate(file.modifiedAt)}</span>
    {@render fileActions(file, allowDelete)}
  </div>
{/snippet}

{#snippet fileGroup(
  id: ProjectSectionId,
  title: string,
  groupFiles: ProjectFile[],
  actionLabel: 'Open' | 'Place',
  allowDelete: boolean,
  emptyText: string,
)}
  <section class="group">
    <div class="group-head">
      <button
        class="group-toggle"
        aria-expanded={!collapsedGroups[id]}
        aria-label={`${collapsedGroups[id] ? 'Expand' : 'Collapse'} ${title}`}
        onclick={() => toggleGroup(id)}
      >
        <Icon svg={collapsedGroups[id] ? ChevronRight : ChevronDown} size={16} />
        <Icon svg={collapsedGroups[id] ? Folder : FolderOpen} size={18} />
        <span>{title}</span>
      </button>
      {#if title === 'Assets / Imported'}
        <button
          class="group-action"
          aria-label="Import external images"
          use:tooltip={{ text: 'Import external images', placement: 'left' }}
          onclick={() => void importExternalImages()}
          disabled={project.busy}
        >
          <Icon svg={ImageAdd} size={13} />
        </button>
      {/if}
      <small>{groupFiles.length}</small>
    </div>
    {#if !collapsedGroups[id]}
      {#if groupFiles.length === 0}
        <div class="empty-block">
          <p class="empty">{emptyText}</p>
          {#if title === 'Assets / Imported'}
            <button class="empty-action" onclick={() => void importExternalImages()} disabled={project.busy}>
              <Icon svg={ImageAdd} size={14} />
              Import images
            </button>
          {/if}
        </div>
      {:else if viewMode === 'detail'}
        <div class="detail-scroll">
          <div class="detail-list" role="table" aria-label={title}>
            <div class="detail-head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">Size</span>
              <span role="columnheader">Created</span>
              <span role="columnheader">Modified</span>
              <span role="columnheader" aria-label="Actions"></span>
            </div>
            {#each groupFiles as file (file.relativePath)}
              {@render detailRow(file, actionLabel, allowDelete)}
            {/each}
          </div>
        </div>
      {:else}
        <div class={viewMode === 'icon' ? 'file-grid' : 'file-list'} role="list">
          {#each groupFiles as file (file.relativePath)}
            {@render fileTile(file, actionLabel, allowDelete)}
          {/each}
        </div>
      {/if}
    {/if}
  </section>
{/snippet}

<svelte:window
  onpointerdown={closeFileMenu}
  onkeydown={(event) => {
    if (event.key === 'Escape') closeFileMenu();
  }}
/>

<Panel title="Project" grow bind:collapsed>
  {#snippet actions()}
    {#if desktop && project.current}
      <div class="panel-view-switch" role="group" aria-label="Project view mode">
        {#each viewModes as mode}
          <button
            class:active={viewMode === mode.id}
            aria-label={mode.label}
            aria-pressed={viewMode === mode.id}
            use:tooltip={{ text: mode.label, placement: 'bottom' }}
            onclick={() => (viewMode = mode.id)}
          >
            <Icon svg={mode.icon} size={12} />
          </button>
        {/each}
      </div>
    {/if}
  {/snippet}
  <div class="project">
    {#if !desktop}
      <p class="empty">Projects are available in the desktop app.</p>
    {:else if !project.current}
      <button class="open-project" onclick={() => void project.openFolder()}>
        <Icon svg={FolderOpen} size={16} /> Open Project Folder
      </button>
      <p class="empty">Choose a local folder to store documents, autosaves, and source assets.</p>
    {:else}
      <div class="head">
        <div class="project-name">
          <Icon svg={OpenFolder} size={15} />
          <span>{project.current.name}</span>
        </div>
        <div class="head-actions">
          <button
            aria-label="Refresh project"
            use:tooltip={{ text: 'Refresh project', placement: 'left' }}
            onclick={() => void ui.withLoading('Refreshing project…', () => project.refresh())}
          >
            <Icon svg={ArrowSync} size={15} />
          </button>
          <button
            aria-label="Switch project folder"
            use:tooltip={{ text: 'Switch project folder', placement: 'left' }}
            onclick={() => void switchProject()}
            disabled={project.busy}
          >
            <Icon svg={FolderOpen} size={15} />
          </button>
          <button
            aria-label="Reveal project folder"
            use:tooltip={{ text: 'Reveal project folder', placement: 'left' }}
            onclick={() => void project.reveal()}
          >
            <Icon svg={Open} size={15} />
          </button>
          <button
            aria-label="Close project"
            use:tooltip={{ text: 'Close project', placement: 'left' }}
            onclick={closeProject}
          >
            <Icon svg={Dismiss} size={15} />
          </button>
        </div>
      </div>

      {#if project.error}
        <p class="err">{project.error}</p>
      {/if}

      <div class="browser">
        {@render fileGroup('documents', 'Documents', documentFiles, 'Open', false, 'Saved .ora files appear here.')}
        {@render fileGroup('storyboards', 'Storyboards', storyboardFiles, 'Open', false, 'Composition storyboard .ora files appear here.')}
        {@render fileGroup('workflows', 'Workflows', workflowFiles, 'Open', false, 'Saved composition boards appear here.')}
        {@render fileGroup('autosave', 'Autosave', autosaveFiles, 'Open', false, 'Timed recovery copies appear here.')}
        {@render fileGroup(
          'generated',
          'Assets / Generated',
          generatedFiles,
          'Place',
          true,
          'AI-generated and extracted assets appear here.',
        )}
        {@render fileGroup('imported', 'Assets / Imported', importedFiles, 'Place', true, 'Placed source images appear here.')}
      </div>
    {/if}
  </div>
</Panel>

{#if fileMenu}
  <div
    class="file-menu"
    style={`left:${fileMenu.x}px;top:${fileMenu.y}px`}
    role="menu"
    tabindex="-1"
    onpointerdown={(event) => event.stopPropagation()}
  >
    <button role="menuitem" onclick={showDetails}>View details</button>
    <button role="menuitem" onclick={() => void revealFromMenu(fileMenu!.file)}>Reveal file</button>
    {#if fileMenu.allowDelete && assetFor(fileMenu.file)}
      <button role="menuitem" onclick={() => void removeFromMenu(fileMenu!.file)}>Move to trash</button>
    {/if}
  </div>
{/if}

<style>
  .project {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 8px;
    min-height: 0;
    padding: 8px;
  }
  .open-project,
  .project-name,
  .group-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .project-name {
    min-width: 0;
    flex: 1;
    color: var(--text-bright);
    font-weight: 600;
  }
  .project-name span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .head-actions,
  .file-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 4px;
  }
  .head-actions button,
  .file-actions button {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
  }
  .panel-view-switch {
    display: flex;
    flex: none;
    padding: 1px;
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
  }
  .panel-view-switch button {
    display: grid;
    place-items: center;
    width: 21px;
    height: 18px;
    padding: 0;
    color: var(--text-dim);
    background: transparent;
    border-color: transparent;
  }
  .panel-view-switch button.active {
    color: var(--text-bright);
    background: var(--accent);
    border-color: var(--accent);
  }
  .browser {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0;
    min-height: 0;
    overflow: auto;
    padding-right: 1px;
  }
  .group {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 0;
  }
  .group-head {
    position: sticky;
    top: 0;
    z-index: 1;
    min-height: 31px;
    padding: 0 8px 0 10px;
    background: var(--bg-panel);
    border-top: 1px solid transparent;
    border-bottom: 1px solid color-mix(in srgb, var(--bg-panel) 82%, #000 18%);
    color: var(--text-bright);
    font-size: 12px;
    font-weight: 700;
    text-transform: none;
  }
  .group-head:hover {
    background: color-mix(in srgb, var(--bg-panel) 82%, var(--text-bright) 18%);
  }
  .group-toggle {
    display: flex;
    align-items: center;
    flex: 1;
    gap: 7px;
    min-width: 0;
    min-height: 30px;
    padding: 0;
    background: transparent;
    border-color: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  .group-toggle:hover,
  .group-toggle:focus-visible {
    background: transparent;
    border-color: transparent;
    color: var(--text-bright);
  }
  .group-toggle span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-action {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    margin-left: 4px;
    padding: 0;
    color: var(--text-dim);
    background: transparent;
    border-color: transparent;
  }
  .group-action:hover:not(:disabled) {
    color: var(--text-bright);
    background: var(--bg-input);
    border-color: var(--border-soft);
  }
  .group-head small {
    min-width: 18px;
    margin-left: 8px;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
    text-align: right;
  }
  .empty-block {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin: 6px 0 9px 31px;
  }
  .empty-action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 26px;
    padding: 4px 8px;
    color: var(--text-bright);
    font-size: 12px;
  }
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 6px 0 9px 31px;
  }
  .file-row {
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr) auto;
    align-items: center;
    gap: 7px;
    min-height: 46px;
    padding: 5px;
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
  }
  .file-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(52px, 1fr));
    gap: 7px 5px;
    margin: 5px 0 9px 31px;
  }
  .file-tile {
    display: grid;
    grid-template-rows: 42px 29px;
    align-items: start;
    justify-items: center;
    gap: 4px;
    min-width: 0;
    padding: 3px 2px 4px;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
  }
  .file-tile:hover,
  .file-tile:focus-within {
    background: color-mix(in srgb, var(--bg-panel) 84%, var(--text-bright) 16%);
    border-color: var(--border-soft);
  }
  .file-tile .thumb {
    width: 48px;
    max-width: 100%;
    height: 42px;
    background: transparent;
    border-color: transparent;
    border-radius: 4px;
  }
  .file-tile .thumb:hover,
  .file-tile .thumb:focus-visible {
    background: var(--bg-input);
    border-color: var(--border-soft);
  }
  .file-tile .thumb img {
    object-fit: contain;
    border-radius: 3px;
  }
  .file-tile .file-name {
    display: -webkit-box;
    height: 29px;
    font-size: 11px;
    line-height: 1.2;
    text-align: center;
    white-space: normal;
    overflow-wrap: anywhere;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .detail-scroll {
    max-width: 100%;
    margin: 6px 0 9px 31px;
    overflow-x: auto;
    overflow-y: hidden;
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
  }
  .detail-list {
    min-width: 650px;
  }
  .detail-head,
  .detail-row {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 74px 64px 128px 128px auto;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 5px;
  }
  .detail-head {
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    border-bottom: 1px solid var(--border-soft);
  }
  .detail-row + .detail-row {
    border-top: 1px solid var(--border-soft);
  }
  .detail-file {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    align-items: center;
    gap: 5px;
    min-width: 0;
  }
  .detail-row > span {
    overflow: hidden;
    color: var(--text-dim);
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .detail-row .thumb {
    width: 30px;
    height: 24px;
  }
  .thumb {
    display: grid;
    place-items: center;
    width: 42px;
    height: 34px;
    padding: 0;
    overflow: hidden;
    color: var(--text-dim);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .meta {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 2px;
  }
  .file-name {
    display: block;
    width: 100%;
    padding: 0;
    overflow: hidden;
    background: transparent;
    border: none;
    color: var(--text);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .file-name:hover {
    color: var(--accent);
  }
  .meta span,
  .empty {
    margin: 0;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .empty {
    padding: 0 1px 3px;
  }
  .err {
    margin: 0;
    color: var(--danger);
    font-size: 11px;
    white-space: pre-wrap;
    user-select: text;
    -webkit-user-select: text;
  }
  .file-menu {
    position: fixed;
    z-index: 1000;
    display: grid;
    min-width: 156px;
    padding: 4px;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 4px;
    box-shadow: 0 10px 26px rgb(0 0 0 / 35%);
  }
  .file-menu button {
    display: block;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border-color: transparent;
    color: var(--text);
    font-size: 12px;
    text-align: left;
  }
  .file-menu button:hover,
  .file-menu button:focus-visible {
    background: var(--bg-input);
    color: var(--text-bright);
  }
</style>
