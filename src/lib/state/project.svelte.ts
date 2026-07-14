import {
  commitWorkflowEditorReturn,
  deleteProjectAsset,
  isDesktop,
  openProjectFolderAt,
  pickProjectDocumentSavePath,
  pickProjectFolder,
  readProjectFile,
  readProjectAsset,
  refreshProject,
  revealProjectFile,
  revealProjectPath,
  rollbackWorkflowEditorReturn,
  finalizeWorkflowEditorReturn,
  saveProjectDocumentAs,
  saveProjectDocumentAtPath,
  storeProjectAssetBytes,
  storeProjectClipboardImage,
  writeProjectDocumentPath,
  writeProjectDocument,
  type ProjectAsset,
  type ProjectFile,
  type ProjectState,
} from '../integrations/desktop';
import { ui } from './ui.svelte';
import { hasWorkflowRoundTripSessions } from './workflowEditorSession';

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

  get lastPath(): string | null {
    return localStorage.getItem(KEY);
  }

  async restore(): Promise<void> {
    if (!isDesktop()) return;
    const path = localStorage.getItem(KEY);
    if (!path) return;
    await ui.withLoading('Loading project…', () => this.refresh(path));
  }

  async reopenLastProject(): Promise<boolean> {
    const path = this.lastPath;
    if (!path || !isDesktop()) return false;
    this.error = '';
    await ui.withLoading('Reopening last project…', () => this.refresh(path));
    return this.path === path;
  }

  async openFolder(): Promise<boolean> {
    this.error = '';
    if (hasWorkflowRoundTripSessions()) {
      this.error = 'Close or discard workflow-linked editor tabs before switching projects.';
      return false;
    }
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

  async storeClipboardImage(name = 'Clipboard Image.png'): Promise<ProjectAsset | null> {
    const path = this.path;
    if (!path) throw new Error('Open a project folder before pasting an image.');
    const result = await storeProjectClipboardImage(path, name);
    if (!result) return null;
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

  async commitWorkflowEditorReturn(args: Omit<Parameters<typeof commitWorkflowEditorReturn>[0], 'projectPath'>) {
    const path = this.path;
    if (!path) throw new Error('No project is open.');
    const result = await commitWorkflowEditorReturn({ ...args, projectPath: path });
    await this.refresh(path);
    return result;
  }

  async rollbackWorkflowEditorReturn(cleanupToken: string): Promise<void> {
    const path = this.path;
    if (!path) throw new Error('No project is open.');
    await rollbackWorkflowEditorReturn(path, cleanupToken);
    await this.refresh(path);
  }

  async finalizeWorkflowEditorReturn(cleanupToken: string): Promise<boolean> {
    const path = this.path;
    if (!path) throw new Error('No project is open.');
    return finalizeWorkflowEditorReturn(path, cleanupToken);
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

  async pickDocumentSavePath(name: string, dialogTitle?: string | null): Promise<string | null> {
    return pickProjectDocumentSavePath({
      projectPath: this.path,
      name,
      dialogTitle,
    });
  }

  async saveDocumentAtPathAs(args: {
    targetPath: string;
    name: string;
    previousName?: string | null;
    bytes: Uint8Array;
  }) {
    const result = await saveProjectDocumentAtPath({
      projectPath: this.path,
      ...args,
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

  clear(): boolean {
    if (hasWorkflowRoundTripSessions()) {
      this.error = 'Close or discard workflow-linked editor tabs before closing the project.';
      return false;
    }
    if (this.current) this.identityRevision += 1;
    this.current = null;
    localStorage.removeItem(KEY);
    return true;
  }
}

export const project = new ProjectStore();
