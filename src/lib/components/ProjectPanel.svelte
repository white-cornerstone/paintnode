<script lang="ts">
  import Panel from './Panel.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import type { ProjectAsset, ProjectFile } from '../integrations/desktop';
  import { isDesktop } from '../integrations/desktop';
  import { bytesToBitmap } from '../io';
  import { loadOra } from '../ora/load';
  import {
    ArchiveClock,
    ArrowSync,
    Delete,
    Document,
    Folder,
    FolderOpen,
    Image,
    Open,
    OpenFolder,
  } from '../icons';

  let { collapsed = $bindable(false) }: { collapsed?: boolean } = $props();

  const desktop = isDesktop();
  const files = $derived(project.current?.files ?? []);
  const assets = $derived(project.current?.assets ?? []);
  const assetByPath = $derived(new Map(assets.map((asset) => [asset.relativePath, asset])));
  const documentFiles = $derived(files.filter((file) => file.kind === 'document'));
  const autosaveFiles = $derived(files.filter((file) => file.kind === 'autosave'));
  const generatedFiles = $derived(files.filter((file) => file.kind === 'generated'));
  const importedFiles = $derived(files.filter((file) => file.kind === 'imported'));

  function assetFor(file: ProjectFile): ProjectAsset | null {
    return assetByPath.get(file.relativePath) ?? null;
  }

  function isOra(file: ProjectFile): boolean {
    return /\.ora$/i.test(file.name) || file.mime === 'image/openraster';
  }

  function isImage(file: ProjectFile): boolean {
    return file.mime?.startsWith('image/') === true && !isOra(file);
  }

  function iconFor(file: ProjectFile): string {
    if (file.kind === 'autosave') return ArchiveClock;
    if (isOra(file) || file.kind === 'document') return Document;
    if (isImage(file)) return Image;
    return Folder;
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  function metaFor(file: ProjectFile): string {
    const label =
      file.kind === 'document'
        ? 'document'
        : file.kind === 'autosave'
          ? 'autosave'
          : file.kind === 'generated'
            ? 'generated'
            : file.kind === 'imported'
              ? 'imported'
              : file.kind;
    return `${label} · ${formatSize(file.size)}`;
  }

  function bufferFrom(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }

  async function openFile(file: ProjectFile) {
    try {
      if (isOra(file)) {
        const bytes = await project.readFile(file);
        const doc = await loadOra(bufferFrom(bytes));
        doc.name = file.name.replace(/\.ora$/i, '');
        editor.openDocument(doc);
        editor.markSaved(file.relativePath);
        editor.flash(`Opened ${file.name}`);
        return;
      }

      if (isImage(file)) {
        const bytes = await project.readFile(file);
        const bmp = await bytesToBitmap(bytes, file.mime ?? 'image/png');
        const asset = assetFor(file);
        const placed = editor.placeImage(bmp, bmp.width, bmp.height, file.name.replace(/\.[^.]+$/, ''), {
          assetId: asset?.id ?? null,
          path: file.relativePath,
        });
        bmp.close();
        editor.flash(
          placed.oversized
            ? `Placed ${file.name} full-size; use Move or Image > Reveal All`
            : `Placed ${file.name}`,
        );
        return;
      }

      await project.revealFile(file);
    } catch (e) {
      editor.flash('Open project file failed: ' + ((e as Error)?.message ?? String(e)));
    }
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
</script>

<Panel title="Project" grow bind:collapsed>
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
            onclick={() => void project.refresh()}
          >
            <Icon svg={ArrowSync} size={15} />
          </button>
          <button
            aria-label="Reveal project folder"
            use:tooltip={{ text: 'Reveal project folder', placement: 'left' }}
            onclick={() => void project.reveal()}
          >
            <Icon svg={Open} size={15} />
          </button>
        </div>
      </div>

      {#if project.error}
        <p class="err">{project.error}</p>
      {/if}

      <div class="browser">
        <section class="group">
          <div class="group-head">
            <Icon svg={Document} size={14} />
            <span>Documents</span>
            <small>{documentFiles.length}</small>
          </div>
          {#if documentFiles.length === 0}
            <p class="empty">Saved .ora files appear here.</p>
          {:else}
            {#each documentFiles as file (file.relativePath)}
              <div class="file-row">
                <button class="thumb" aria-label={`Open ${file.name}`} onclick={() => void openFile(file)}>
                  {#if file.previewDataUrl}
                    <img src={file.previewDataUrl} alt="" />
                  {:else}
                    <Icon svg={iconFor(file)} size={22} />
                  {/if}
                </button>
                <div class="meta">
                  <button class="file-name" onclick={() => void openFile(file)}>{file.name}</button>
                  <span>{metaFor(file)}</span>
                </div>
                <div class="file-actions">
                  <button
                    aria-label={`Reveal ${file.name}`}
                    use:tooltip={{ text: 'Reveal file', placement: 'left' }}
                    onclick={() => void revealFile(file)}
                  >
                    <Icon svg={Open} size={14} />
                  </button>
                </div>
              </div>
            {/each}
          {/if}
        </section>

        <section class="group">
          <div class="group-head">
            <Icon svg={ArchiveClock} size={14} />
            <span>Autosave</span>
            <small>{autosaveFiles.length}</small>
          </div>
          {#if autosaveFiles.length === 0}
            <p class="empty">Timed recovery copies appear here.</p>
          {:else}
            {#each autosaveFiles as file (file.relativePath)}
              <div class="file-row">
                <button class="thumb" aria-label={`Open ${file.name}`} onclick={() => void openFile(file)}>
                  {#if file.previewDataUrl}
                    <img src={file.previewDataUrl} alt="" />
                  {:else}
                    <Icon svg={iconFor(file)} size={22} />
                  {/if}
                </button>
                <div class="meta">
                  <button class="file-name" onclick={() => void openFile(file)}>{file.name}</button>
                  <span>{metaFor(file)}</span>
                </div>
                <div class="file-actions">
                  <button
                    aria-label={`Reveal ${file.name}`}
                    use:tooltip={{ text: 'Reveal file', placement: 'left' }}
                    onclick={() => void revealFile(file)}
                  >
                    <Icon svg={Open} size={14} />
                  </button>
                </div>
              </div>
            {/each}
          {/if}
        </section>

        <section class="group">
          <div class="group-head">
            <Icon svg={Image} size={14} />
            <span>Assets / Generated</span>
            <small>{generatedFiles.length}</small>
          </div>
          {#if generatedFiles.length === 0}
            <p class="empty">AI-generated source images appear here.</p>
          {:else}
            {#each generatedFiles as file (file.relativePath)}
              <div class="file-row">
                <button class="thumb" aria-label={`Place ${file.name}`} onclick={() => void openFile(file)}>
                  {#if file.previewDataUrl}
                    <img src={file.previewDataUrl} alt="" />
                  {:else}
                    <Icon svg={iconFor(file)} size={22} />
                  {/if}
                </button>
                <div class="meta">
                  <button class="file-name" onclick={() => void openFile(file)}>{file.name}</button>
                  <span>{metaFor(file)}</span>
                </div>
                <div class="file-actions">
                  <button
                    aria-label={`Reveal ${file.name}`}
                    use:tooltip={{ text: 'Reveal file', placement: 'left' }}
                    onclick={() => void revealFile(file)}
                  >
                    <Icon svg={Open} size={14} />
                  </button>
                  {#if assetFor(file)}
                    <button
                      aria-label={`Move ${file.name} to trash`}
                      use:tooltip={{ text: 'Move to trash', placement: 'left' }}
                      onclick={() => void remove(file)}
                    >
                      <Icon svg={Delete} size={14} />
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          {/if}
        </section>

        <section class="group">
          <div class="group-head">
            <Icon svg={Folder} size={14} />
            <span>Assets / Imported</span>
            <small>{importedFiles.length}</small>
          </div>
          {#if importedFiles.length === 0}
            <p class="empty">Placed source images appear here.</p>
          {:else}
            {#each importedFiles as file (file.relativePath)}
              <div class="file-row">
                <button class="thumb" aria-label={`Place ${file.name}`} onclick={() => void openFile(file)}>
                  {#if file.previewDataUrl}
                    <img src={file.previewDataUrl} alt="" />
                  {:else}
                    <Icon svg={iconFor(file)} size={22} />
                  {/if}
                </button>
                <div class="meta">
                  <button class="file-name" onclick={() => void openFile(file)}>{file.name}</button>
                  <span>{metaFor(file)}</span>
                </div>
                <div class="file-actions">
                  <button
                    aria-label={`Reveal ${file.name}`}
                    use:tooltip={{ text: 'Reveal file', placement: 'left' }}
                    onclick={() => void revealFile(file)}
                  >
                    <Icon svg={Open} size={14} />
                  </button>
                  {#if assetFor(file)}
                    <button
                      aria-label={`Move ${file.name} to trash`}
                      use:tooltip={{ text: 'Move to trash', placement: 'left' }}
                      onclick={() => void remove(file)}
                    >
                      <Icon svg={Delete} size={14} />
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          {/if}
        </section>
      </div>
    {/if}
  </div>
</Panel>

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
  .browser {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 10px;
    min-height: 0;
    overflow: auto;
    padding-right: 1px;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .group-head {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 5px 0 3px;
    background: var(--bg-panel);
    color: var(--text-bright);
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .group-head span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .group-head small {
    margin-left: auto;
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 600;
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
</style>
