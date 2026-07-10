import {
  deleteProjectAsset,
  isDesktop,
  openProjectFolderAt,
  pickProjectFolder,
  readProjectFile,
  readProjectAsset,
  refreshProject,
  revealProjectFile,
  revealProjectPath,
  saveProjectDocumentAs,
  storeProjectAssetBytes,
  writeProjectDocumentPath,
  writeProjectDocument,
  type ProjectAsset,
  type ProjectFile,
  type ProjectState,
} from '../integrations/desktop';
import { ui } from './ui.svelte';

const KEY = 'paintnode.projectPath';

class ProjectStore {
  current = $state<ProjectState | null>(null);
  busy = $state(false);
  error = $state('');
  private identityRevision = 0;

  get path(): string | null {
    return this.current?.path ?? null;
  }

  get identity(): string {
    return `${this.identityRevision}:${this.path ?? ''}`;
  }

  async restore(): Promise<void> {
    if (!isDesktop()) return;
    const path = localStorage.getItem(KEY);
    if (!path) return;
    await ui.withLoading('Loading project…', () => this.refresh(path));
  }

  async openFolder(): Promise<boolean> {
    this.error = '';
    if (!isDesktop()) {
      this.error = 'Projects are available in the desktop app.';
      return false;
    }
    this.busy = true;
    try {
      // Pick first: the indicator should cover the scan, not the OS dialog.
      const selected = await pickProjectFolder();
      if (!selected) return false;
      this.setProject(await ui.withLoading('Opening project…', () => openProjectFolderAt(selected)));
      return true;
    } catch (e) {
      this.error = (e as Error)?.message ?? String(e);
      return false;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Re-scan the project folder. Silent — it also runs as a background side
   * effect (autosave, post-import); user-initiated call sites wrap it in
   * ui.withLoading to surface the wait.
   */
  async refresh(path = this.path): Promise<void> {
    if (!path || !isDesktop()) return;
    this.error = '';
    this.busy = true;
    try {
      const state = await refreshProject(path);
      // Background tasks refresh the project they were started in; if the user
      // has since opened a different project, don't switch them back to it.
      if (!this.current || this.path === path) this.setProject(state);
    } catch (e) {
      this.error = (e as Error)?.message ?? String(e);
    } finally {
      this.busy = false;
    }
  }

  async storeImportedFile(file: File, width?: number, height?: number): Promise<ProjectAsset | null> {
    const path = this.path;
    if (!path) return null;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await storeProjectAssetBytes({
      projectPath: path,
      name: file.name,
      bytes,
      kind: 'imported',
      width,
      height,
      mime: file.type || null,
    });
    await this.refresh(path);
    return result.asset;
  }

  async storeGeneratedBlobAt(
    path: string | null,
    blob: Blob,
    name: string,
    prompt?: string | null,
    width?: number,
    height?: number,
  ): Promise<ProjectAsset | null> {
    if (!path) return null;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const result = await storeProjectAssetBytes({
      projectPath: path,
      name,
      bytes,
      kind: 'generated',
      prompt,
      width,
      height,
      mime: blob.type || 'image/png',
    });
    await this.refresh(path);
    return result.asset;
  }

  async readAsset(asset: ProjectAsset) {
    const path = this.path;
    if (!path) throw new Error('No project is open.');
    return readProjectAsset(path, asset.id);
  }

  async reveal(asset?: ProjectAsset): Promise<void> {
    const path = this.path;
    if (!path) return;
    await revealProjectPath(path, asset?.id ?? null);
  }

  async readFile(file: ProjectFile): Promise<Uint8Array> {
    const path = this.path;
    if (!path) throw new Error('No project is open.');
    return readProjectFile(path, file.relativePath);
  }

  async revealFile(file: ProjectFile): Promise<void> {
    const path = this.path;
    if (!path) return;
    await revealProjectFile(path, file.relativePath);
  }

  async deleteAsset(asset: ProjectAsset): Promise<void> {
    const path = this.path;
    if (!path) return;
    this.setProject(await deleteProjectAsset(path, asset.id));
  }

  async saveDocument(name: string, bytes: Uint8Array): Promise<string | null> {
    const path = this.path;
    if (!path) return null;
    const relativePath = await writeProjectDocument({
      projectPath: path,
      name,
      bytes,
      autosave: false,
    });
    await this.refresh(path);
    return relativePath;
  }

  async saveDocumentAs(
    name: string,
    bytes: Uint8Array,
    previousName?: string | null,
    dialogTitle?: string | null,
  ) {
    const result = await saveProjectDocumentAs({
      projectPath: this.path,
      name,
      previousName,
      dialogTitle,
      bytes,
    });
    if (this.path && result) await this.refresh(this.path);
    return result;
  }

  async saveDocumentToPath(savedPath: string, bytes: Uint8Array): Promise<string> {
    const relativePath = await writeProjectDocumentPath({
      projectPath: this.path,
      path: savedPath,
      bytes,
    });
    if (this.path) await this.refresh(this.path);
    return relativePath;
  }

  async autosaveDocument(name: string, bytes: Uint8Array): Promise<string | null> {
    const path = this.path;
    if (!path) return null;
    return writeProjectDocument({
      projectPath: path,
      name,
      bytes,
      autosave: true,
    });
  }

  setProject(state: ProjectState): void {
    if (state.path !== this.path) this.identityRevision += 1;
    this.current = state;
    localStorage.setItem(KEY, state.path);
  }

  clear(): void {
    if (this.current) this.identityRevision += 1;
    this.current = null;
    localStorage.removeItem(KEY);
  }
}

export const project = new ProjectStore();
