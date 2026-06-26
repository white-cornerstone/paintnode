import { invoke } from '@tauri-apps/api/core';

/** True when running inside the Tauri desktop shell (vs. a plain browser tab). */
export function isDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window ||
      '__TAURI__' in window ||
      (window as unknown as { isTauri?: boolean }).isTauri === true)
  );
}

export interface GeneratorConfig {
  /** The local binary to run, e.g. "codex" or an absolute path. */
  bin: string;
  /** Argument template; "{prompt}" and "{output}" are substituted by the Rust bridge. */
  args: string[];
}

export interface CodexGeneratorConfig {
  /** Optional path to the local Codex binary. Empty uses the Rust-side defaults. */
  bin?: string;
  /** Optional CX Paint project folder. Generated output is saved there when present. */
  projectPath?: string | null;
  /** Per-request id used to filter Codex progress events. */
  runId?: string;
}

export interface ProjectAsset {
  id: string;
  kind: 'generated' | 'imported' | string;
  name: string;
  relativePath: string;
  createdAt: number;
  prompt?: string | null;
  sourceFileName?: string | null;
  width?: number | null;
  height?: number | null;
  mime?: string | null;
  previewDataUrl?: string | null;
  exists: boolean;
}

export interface ProjectFile {
  kind: 'document' | 'autosave' | 'generated' | 'imported' | string;
  name: string;
  relativePath: string;
  createdAt: number;
  modifiedAt: number;
  size: number;
  mime?: string | null;
  previewDataUrl?: string | null;
  exists: boolean;
}

export interface ProjectState {
  path: string;
  name: string;
  documentPath: string;
  assets: ProjectAsset[];
  files: ProjectFile[];
}

export interface GeneratedImageResult {
  dataUrl: string;
  asset?: ProjectAsset | null;
}

export interface WorkflowSourceImage {
  name: string;
  bytes: Uint8Array;
}

export interface DecoupledLayerResult {
  name: string;
  dataUrl: string;
  alphaMaskDataUrl?: string | null;
  keyColor?: string | null;
  x?: number | null;
  y?: number | null;
  opacity?: number | null;
  visible?: boolean | null;
  asset?: ProjectAsset | null;
}

export interface DecoupleImageResult {
  layers: DecoupledLayerResult[];
  threadId?: string | null;
  notes?: string | null;
}

export interface StoredAssetResult {
  dataUrl: string;
  asset: ProjectAsset;
}

export interface SavedDocumentResult {
  relativePath: string;
  name: string;
}

/**
 * Run the configured local image-generator via the Tauri Rust bridge and return a PNG data URL.
 * Only works in the desktop app; throws in the browser.
 */
export async function generateImage(config: GeneratorConfig, prompt: string): Promise<string> {
  if (!isDesktop()) {
    throw new Error('Image generation is only available in the desktop app.');
  }
  return invoke<string>('generate_image', { bin: config.bin, args: config.args, prompt });
}

/**
 * Run local Codex headlessly through the Tauri Rust bridge and return a PNG data URL.
 * Codex auth is owned by the user's local Codex installation.
 */
export async function generateCodexImage(
  config: CodexGeneratorConfig,
  prompt: string,
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Codex image generation is only available in the desktop app.');
  }
  const bin = config.bin?.trim() ? config.bin.trim() : null;
  const projectPath = config.projectPath?.trim() ? config.projectPath.trim() : null;
  const runId = config.runId?.trim() ? config.runId.trim() : `codex-${Date.now()}`;
  return invoke<GeneratedImageResult>('generate_codex_image', { bin, prompt, projectPath, runId });
}

export async function decoupleCodexImage(
  config: CodexGeneratorConfig,
  sourcePng: Uint8Array,
  prompt: string,
  storeAssets = true,
): Promise<DecoupleImageResult> {
  if (!isDesktop()) {
    throw new Error('Codex image decoupling is only available in the desktop app.');
  }
  const bin = config.bin?.trim() ? config.bin.trim() : null;
  const projectPath = config.projectPath?.trim() ? config.projectPath.trim() : null;
  const runId = config.runId?.trim() ? config.runId.trim() : `decouple-${Date.now()}`;
  return invoke<DecoupleImageResult>('decouple_codex_image', {
    bin,
    prompt,
    projectPath,
    sourcePng: Array.from(sourcePng),
    runId,
    storeAssets,
  });
}

export async function composeCodexWorkflow(
  config: CodexGeneratorConfig,
  prompt: string,
  sources: WorkflowSourceImage[],
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Codex workflow composition is only available in the desktop app.');
  }
  const bin = config.bin?.trim() ? config.bin.trim() : null;
  const projectPath = config.projectPath?.trim() ? config.projectPath.trim() : null;
  const runId = config.runId?.trim() ? config.runId.trim() : `workflow-${Date.now()}`;
  return invoke<GeneratedImageResult>('compose_codex_workflow', {
    bin,
    prompt,
    projectPath,
    sources: sources.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
    runId,
  });
}

export async function openProjectFolder(): Promise<ProjectState | null> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<ProjectState | null>('project_open_folder');
}

export async function refreshProject(projectPath: string): Promise<ProjectState> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<ProjectState>('project_refresh', { projectPath });
}

export async function storeProjectAssetBytes(args: {
  projectPath: string;
  name: string;
  bytes: Uint8Array;
  kind: 'generated' | 'imported';
  prompt?: string | null;
  width?: number | null;
  height?: number | null;
  mime?: string | null;
}): Promise<StoredAssetResult> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<StoredAssetResult>('project_store_asset_bytes', {
    ...args,
    bytes: Array.from(args.bytes),
  });
}

export async function readProjectAsset(projectPath: string, assetId: string): Promise<StoredAssetResult> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<StoredAssetResult>('project_read_asset', { projectPath, assetId });
}

export async function revealProjectPath(projectPath: string, assetId?: string | null): Promise<void> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<void>('project_reveal', { projectPath, assetId: assetId ?? null });
}

export async function revealProjectFile(projectPath: string, relativePath: string): Promise<void> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<void>('project_reveal_file', { projectPath, relativePath });
}

export async function readProjectFile(projectPath: string, relativePath: string): Promise<Uint8Array> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  const bytes = await invoke<number[]>('project_read_file', { projectPath, relativePath });
  return new Uint8Array(bytes);
}

export async function deleteProjectAsset(projectPath: string, assetId: string): Promise<ProjectState> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<ProjectState>('project_delete_asset', { projectPath, assetId });
}

export async function writeProjectDocument(args: {
  projectPath: string;
  name: string;
  bytes: Uint8Array;
  autosave?: boolean;
}): Promise<string> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<string>('project_write_document', {
    projectPath: args.projectPath,
    name: args.name,
    bytes: Array.from(args.bytes),
    autosave: args.autosave ?? false,
  });
}

export async function saveProjectDocumentAs(args: {
  projectPath?: string | null;
  name: string;
  previousName?: string | null;
  dialogTitle?: string | null;
  bytes: Uint8Array;
}): Promise<SavedDocumentResult | null> {
  if (!isDesktop()) throw new Error('Native save is only available in the desktop app.');
  return invoke<SavedDocumentResult | null>('project_save_document_as', {
    projectPath: args.projectPath?.trim() ? args.projectPath.trim() : null,
    name: args.name,
    previousName: args.previousName?.trim() ? args.previousName.trim() : null,
    dialogTitle: args.dialogTitle?.trim() ? args.dialogTitle.trim() : null,
    bytes: Array.from(args.bytes),
  });
}

export async function writeProjectDocumentPath(args: {
  projectPath?: string | null;
  path: string;
  bytes: Uint8Array;
}): Promise<string> {
  if (!isDesktop()) throw new Error('Native save is only available in the desktop app.');
  return invoke<string>('project_write_document_path', {
    projectPath: args.projectPath?.trim() ? args.projectPath.trim() : null,
    path: args.path,
    bytes: Array.from(args.bytes),
  });
}
