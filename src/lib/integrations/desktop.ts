import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import type {
  AiRunOptions,
  AiAutonomyLevel,
  CodexModelId,
  CodexImageModeration,
  CodexImageQuality,
  AntigravityApprovalMode,
  AntigravityImageModelId,
  AntigravityImageSize,
  AntigravityModelId,
  AntigravityPersonGeneration,
  AntigravityProminentPeople,
  AntigravitySafetyFiltering,
  AntigravitySafetyThreshold,
  ReasoningEffort,
  ServiceTier,
} from '../state/settings';

/** True when running inside the Tauri desktop shell (vs. a plain browser tab). */
export function isDesktop(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window ||
      '__TAURI__' in window ||
      (window as unknown as { isTauri?: boolean }).isTauri === true)
  );
}

export async function readDesktopClipboardText(): Promise<string | null> {
  if (!isDesktop()) return null;
  try {
    return await invoke<string | null>('clipboard_read_text');
  } catch {
    return null;
  }
}

export async function writeDesktopClipboardText(text: string): Promise<boolean> {
  if (!isDesktop()) return false;
  try {
    await invoke('clipboard_write_text', { text });
    return true;
  } catch {
    return false;
  }
}

export async function setNativeMenuEnabledStates(enabled: Record<string, boolean>): Promise<void> {
  if (!isDesktop()) return;
  try {
    await invoke('set_app_menu_enabled', { enabled });
  } catch (error) {
    console.warn('Failed to update native menu state', error);
  }
}

export async function readAppMemoryInfo(): Promise<AppMemoryInfo | null> {
  if (!isDesktop()) return null;
  try {
    return await invoke<AppMemoryInfo>('app_memory_info');
  } catch {
    return null;
  }
}

function safeStem(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'untitled';
}

function safeDocumentDialogName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.toLowerCase().endsWith('.cxflow.json')) {
    const stem = trimmed.replace(/\.json$/i, '').replace(/\.cxflow$/i, '');
    return `${safeStem(stem)}.cxflow.json`;
  }
  const fileName = trimmed.split(/[\\/]/).pop() || trimmed;
  const ext = fileName.toLowerCase().endsWith('.psd') ? 'psd' : 'ora';
  const stem = fileName.replace(/\.(ora|psd)$/i, '').replace(/\.[^.]*$/, '');
  return `${safeStem(stem || name)}.${ext}`;
}

export interface CodexGeneratorConfig {
  /** Optional Codex binary override passed through the SDK runner. Empty uses the SDK package's bundled CLI. */
  bin?: string;
  /** Optional PaintNode project folder. Generated output is saved there when present. */
  projectPath?: string | null;
  /** Keep the actual provider job folder for inspecting the exact inputs sent to the CLI. */
  keepJobDir?: boolean;
  /** Per-request id used to filter Codex progress events. */
  runId?: string;
  /** Codex model selected in PaintNode settings. */
  model: CodexModelId;
  /** Reasoning effort selected in PaintNode settings. */
  reasoningEffort?: ReasoningEffort | null;
  /** Speed tier selected in PaintNode settings. */
  serviceTier?: ServiceTier | null;
  /** Image-generation quality forwarded to the owned imagegen runner when available. */
  imageQuality?: CodexImageQuality | null;
  /** Image-generation moderation mode forwarded to the owned imagegen runner when available. */
  imageModeration?: CodexImageModeration | null;
  /** How much deterministic tool-building autonomy the local agent may use for this run. */
  autonomyLevel?: AiAutonomyLevel | null;
  /** Result-check strictness for fill/retouch candidates (0 = off, 1 = drift only, 2-3 = + seam continuity). */
  editChecksLevel?: number | null;
  /** Optional provider aspect-ratio override for mask-guided generative fill. */
  fillAspectRatio?: string | null;
}

export interface AntigravityGeneratorConfig {
  /** Optional path to the local Antigravity CLI auth helper. Empty uses the Rust-side defaults. */
  bin?: string;
  /** Optional PaintNode project folder. Generated output is saved there when present. */
  projectPath?: string | null;
  /** Keep the actual provider job folder for inspecting the exact inputs sent to the CLI. */
  keepJobDir?: boolean;
  /** Per-request id used to filter progress events. */
  runId?: string;
  /** Antigravity agent model used only by agent-backed asset extraction. */
  model: AntigravityModelId;
  /** Whether to skip Antigravity permission prompts inside PaintNode's temporary job folder. */
  approvalMode?: AntigravityApprovalMode | null;
  /** Direct Antigravity image model used by PaintNode's owned image executor. */
  imageModel?: AntigravityImageModelId | null;
  /** Optional direct image size tier. Auto lets placement choose the tier. */
  imageSize?: AntigravityImageSize | null;
  /** Optional person-generation policy accepted by Antigravity image generation. */
  personGeneration?: AntigravityPersonGeneration | null;
  /** Optional prominent-people policy accepted by Antigravity image generation. */
  prominentPeople?: AntigravityProminentPeople | null;
  /** Optional compression quality for confirmed Antigravity output options. */
  compressionQuality?: number | null;
  /** Advanced confirmed non-internal image options as JSON. */
  advancedJson?: string | null;
  /** Antigravity safety filtering preset for direct image generation. */
  safetyFiltering?: AntigravitySafetyFiltering | null;
  /** Custom harassment safety threshold for direct image generation. */
  safetyHarassment?: AntigravitySafetyThreshold | null;
  /** Custom hate-speech safety threshold for direct image generation. */
  safetyHateSpeech?: AntigravitySafetyThreshold | null;
  /** Custom sexually-explicit safety threshold for direct image generation. */
  safetySexuallyExplicit?: AntigravitySafetyThreshold | null;
  /** Custom dangerous-content safety threshold for direct image generation. */
  safetyDangerousContent?: AntigravitySafetyThreshold | null;
  /** How much deterministic tool-building autonomy the local agent may use for this run. */
  autonomyLevel?: AiAutonomyLevel | null;
  /** Result-check strictness for fill/retouch candidates (0 = off, 1 = drift only, 2-3 = + seam continuity). */
  editChecksLevel?: number | null;
  /** Optional Antigravity aspect-ratio override for mask-guided generative fill. */
  fillAspectRatio?: string | null;
}

export interface TargetDimensions {
  width: number;
  height: number;
}

export interface CodexDetectionResult {
  found: boolean;
  path: string | null;
  version: string | null;
  error: string | null;
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
  kind: 'document' | 'storyboard' | 'autosave' | 'generated' | 'imported' | string;
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
  assets?: ProjectAsset[];
  maskDataUrl?: string | null;
  layers?: GeneratedImageLayerResult[];
}

export interface GeneratedImageLayerResult {
  name: string;
  dataUrl: string;
  asset?: ProjectAsset | null;
  maskDataUrl?: string | null;
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

export interface AppMemoryInfo {
  residentBytes: number;
  processCount: number;
}

export interface NativeDroppedFile {
  path: string;
  name: string;
  bytes: Uint8Array;
  size: number;
  modifiedAt: number;
  mime?: string | null;
}

function codexInvokeConfig(config: CodexGeneratorConfig) {
  // Tasks persisted before "minimal" was retired may still carry it; Codex CLI
  // rejects the value, so clamp to the closest supported level.
  const reasoningEffort =
    (config.reasoningEffort as string) === 'minimal' ? 'low' : (config.reasoningEffort ?? null);
  return {
    bin: config.bin?.trim() ? config.bin.trim() : null,
    projectPath: config.projectPath?.trim() ? config.projectPath.trim() : null,
    keepJobDir: config.keepJobDir ?? false,
    runId: config.runId?.trim() ? config.runId.trim() : null,
    model: config.model,
    reasoningEffort,
    serviceTier: config.serviceTier ?? 'default',
    imageQuality: config.imageQuality ?? 'auto',
    imageModeration: config.imageModeration ?? 'auto',
    autonomyLevel: config.autonomyLevel ?? 'low',
    editChecksLevel: config.editChecksLevel ?? 1,
    fillAspectRatio: config.fillAspectRatio?.trim() ? config.fillAspectRatio.trim() : null,
  };
}

function antigravityInvokeConfig(config: AntigravityGeneratorConfig, includeImageOptions = true) {
  const base = {
    bin: config.bin?.trim() ? config.bin.trim() : null,
    projectPath: config.projectPath?.trim() ? config.projectPath.trim() : null,
    keepJobDir: config.keepJobDir ?? false,
    runId: config.runId?.trim() ? config.runId.trim() : null,
    model: config.model,
    approvalMode: config.approvalMode ?? 'skipPermissions',
    autonomyLevel: config.autonomyLevel ?? 'low',
    editChecksLevel: config.editChecksLevel ?? 1,
    fillAspectRatio: config.fillAspectRatio?.trim() ? config.fillAspectRatio.trim() : null,
  };
  if (!includeImageOptions) return base;
  return {
    ...base,
    imageModel: config.imageModel ?? 'gemini-3.1-flash-image',
    imageSize: config.imageSize ?? 'auto',
    personGeneration: config.personGeneration ?? 'auto',
    prominentPeople: config.prominentPeople ?? 'auto',
    compressionQuality: config.compressionQuality ?? null,
    advancedJson: config.advancedJson?.trim() ? config.advancedJson.trim() : null,
    safetyFiltering: config.safetyFiltering ?? 'default',
    safetyHarassment: config.safetyHarassment ?? 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
    safetyHateSpeech: config.safetyHateSpeech ?? 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
    safetySexuallyExplicit: config.safetySexuallyExplicit ?? 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
    safetyDangerousContent: config.safetyDangerousContent ?? 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
  };
}

export function codexConfigFromRunOptions(
  options: AiRunOptions,
  projectPath?: string | null,
  runId?: string,
  keepJobDir = false,
): CodexGeneratorConfig {
  return {
    bin: options.codexBin,
    projectPath,
    keepJobDir,
    runId,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    serviceTier: options.serviceTier,
    imageQuality: options.imageQuality,
    imageModeration: options.imageModeration,
    autonomyLevel: options.autonomyLevel,
    editChecksLevel: options.editChecksLevel,
    fillAspectRatio: options.fillAspectRatio ?? null,
  };
}

export function antigravityConfigFromRunOptions(
  options: AiRunOptions,
  projectPath?: string | null,
  runId?: string,
  keepJobDir = false,
): AntigravityGeneratorConfig {
  return {
    bin: options.antigravityBin,
    projectPath,
    keepJobDir,
    runId,
    model: options.antigravityModel,
    approvalMode: options.antigravityApprovalMode,
    imageModel: options.antigravityImageModel,
    imageSize: options.antigravityImageSize,
    personGeneration: options.antigravityPersonGeneration,
    prominentPeople: options.antigravityProminentPeople,
    compressionQuality: options.antigravityCompressionQuality,
    advancedJson: options.antigravityAdvancedOptionsJson,
    safetyFiltering: options.antigravitySafetyFiltering,
    safetyHarassment: options.antigravitySafetyHarassment,
    safetyHateSpeech: options.antigravitySafetyHateSpeech,
    safetySexuallyExplicit: options.antigravitySafetySexuallyExplicit,
    safetyDangerousContent: options.antigravitySafetyDangerousContent,
    autonomyLevel: options.autonomyLevel,
    editChecksLevel: options.editChecksLevel,
    fillAspectRatio: options.fillAspectRatio ?? null,
  };
}

export async function detectCodex(bin?: string): Promise<CodexDetectionResult> {
  if (!isDesktop()) {
    throw new Error('Codex detection is only available in the desktop app.');
  }
  return invoke<CodexDetectionResult>('detect_codex', {
    bin: bin?.trim() ? bin.trim() : null,
  });
}

export async function detectAntigravity(bin?: string): Promise<CodexDetectionResult> {
  if (!isDesktop()) {
    throw new Error('Antigravity detection is only available in the desktop app.');
  }
  return invoke<CodexDetectionResult>('detect_antigravity', {
    bin: bin?.trim() ? bin.trim() : null,
  });
}

/**
 * Run local Codex headlessly through the Tauri Rust bridge and return a PNG data URL.
 * Codex auth is owned by the user's local Codex installation.
 */
export async function generateCodexImage(
  config: CodexGeneratorConfig,
  prompt: string,
  targetDimensions?: TargetDimensions | null,
  references: WorkflowSourceImage[] = [],
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Codex image generation is only available in the desktop app.');
  }
  const bin = config.bin?.trim() ? config.bin.trim() : null;
  const projectPath = config.projectPath?.trim() ? config.projectPath.trim() : null;
  const runId = config.runId?.trim() ? config.runId.trim() : `codex-${Date.now()}`;
  return invoke<GeneratedImageResult>('generate_codex_image', {
    ...codexInvokeConfig({ ...config, runId }),
    bin,
    prompt,
    projectPath,
    runId,
    targetWidth: targetDimensions?.width ?? null,
    targetHeight: targetDimensions?.height ?? null,
    referencePngs: references.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
  });
}

export async function generateCodexFillImage(
  config: CodexGeneratorConfig,
  sourcePng: Uint8Array,
  editTargetPng: Uint8Array,
  maskPng: Uint8Array,
  prompt: string,
  references: WorkflowSourceImage[] = [],
  storeAsset = true,
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Codex generative fill is only available in the desktop app.');
  }
  const bin = config.bin?.trim() ? config.bin.trim() : null;
  const projectPath = config.projectPath?.trim() ? config.projectPath.trim() : null;
  const runId = config.runId?.trim() ? config.runId.trim() : `fill-${Date.now()}`;
  return invoke<GeneratedImageResult>('generate_codex_fill_image', {
    ...codexInvokeConfig({ ...config, runId }),
    bin,
    prompt,
    projectPath,
    sourcePng: Array.from(sourcePng),
    editTargetPng: Array.from(editTargetPng),
    maskPng: Array.from(maskPng),
    storeAsset,
    referencePngs: references.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
    runId,
  });
}

export async function generateCodexRetouchImage(
  config: CodexGeneratorConfig,
  sourcePng: Uint8Array,
  editTargetPng: Uint8Array,
  maskPng: Uint8Array,
  annotatedSourcePng: Uint8Array | null | undefined,
  referencePng: Uint8Array | null | undefined,
  prompt: string,
  references: WorkflowSourceImage[] = [],
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Codex AI retouch is only available in the desktop app.');
  }
  const bin = config.bin?.trim() ? config.bin.trim() : null;
  const projectPath = config.projectPath?.trim() ? config.projectPath.trim() : null;
  const runId = config.runId?.trim() ? config.runId.trim() : `retouch-${Date.now()}`;
  return invoke<GeneratedImageResult>('generate_codex_retouch_image', {
    ...codexInvokeConfig({ ...config, runId }),
    bin,
    prompt,
    projectPath,
    sourcePng: Array.from(sourcePng),
    editTargetPng: Array.from(editTargetPng),
    maskPng: Array.from(maskPng),
    annotatedSourcePng: annotatedSourcePng ? Array.from(annotatedSourcePng) : null,
    referencePng: referencePng ? Array.from(referencePng) : null,
    referencePngs: references.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
    runId,
  });
}

/** Ask a running AI job to stop; its CLI is killed and the task fails as stopped. */
export async function cancelAiRun(runId: string): Promise<void> {
  if (!isDesktop() || !runId.trim()) return;
  await invoke('cancel_ai_run', { runId: runId.trim() });
}

export async function upscaleCodexImage(
  config: CodexGeneratorConfig,
  sourcePng: Uint8Array,
  scalePercent: number,
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Codex AI upscale is only available in the desktop app.');
  }
  const bin = config.bin?.trim() ? config.bin.trim() : null;
  const projectPath = config.projectPath?.trim() ? config.projectPath.trim() : null;
  const runId = config.runId?.trim() ? config.runId.trim() : `upscale-${Date.now()}`;
  return invoke<GeneratedImageResult>('upscale_codex_image', {
    ...codexInvokeConfig({ ...config, runId }),
    bin,
    projectPath,
    sourcePng: Array.from(sourcePng),
    scalePercent: Math.round(scalePercent),
    runId,
  });
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
    ...codexInvokeConfig({ ...config, runId }),
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
    ...codexInvokeConfig({ ...config, runId }),
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

export async function generateAntigravityImage(
  config: AntigravityGeneratorConfig,
  prompt: string,
  targetDimensions?: TargetDimensions | null,
  references: WorkflowSourceImage[] = [],
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Antigravity image generation is only available in the desktop app.');
  }
  const runId = config.runId?.trim() ? config.runId.trim() : `antigravity-${Date.now()}`;
  return invoke<GeneratedImageResult>('generate_antigravity_image', {
    ...antigravityInvokeConfig({ ...config, runId }),
    prompt,
    runId,
    targetWidth: targetDimensions?.width ?? null,
    targetHeight: targetDimensions?.height ?? null,
    referencePngs: references.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
  });
}

export async function generateAntigravityFillImage(
  config: AntigravityGeneratorConfig,
  sourcePng: Uint8Array,
  editTargetPng: Uint8Array,
  maskPng: Uint8Array,
  prompt: string,
  references: WorkflowSourceImage[] = [],
  storeAsset = true,
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Antigravity generative fill is only available in the desktop app.');
  }
  const runId = config.runId?.trim() ? config.runId.trim() : `antigravity-fill-${Date.now()}`;
  return invoke<GeneratedImageResult>('generate_antigravity_fill_image', {
    ...antigravityInvokeConfig({ ...config, runId }),
    prompt,
    sourcePng: Array.from(sourcePng),
    editTargetPng: Array.from(editTargetPng),
    maskPng: Array.from(maskPng),
    storeAsset,
    referencePngs: references.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
    runId,
  });
}

export async function generateAntigravityRetouchImage(
  config: AntigravityGeneratorConfig,
  sourcePng: Uint8Array,
  editTargetPng: Uint8Array,
  maskPng: Uint8Array,
  annotatedSourcePng: Uint8Array | null | undefined,
  referencePng: Uint8Array | null | undefined,
  prompt: string,
  references: WorkflowSourceImage[] = [],
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Antigravity AI retouch is only available in the desktop app.');
  }
  const runId = config.runId?.trim() ? config.runId.trim() : `antigravity-retouch-${Date.now()}`;
  return invoke<GeneratedImageResult>('generate_antigravity_retouch_image', {
    ...antigravityInvokeConfig({ ...config, runId }),
    prompt,
    sourcePng: Array.from(sourcePng),
    editTargetPng: Array.from(editTargetPng),
    maskPng: Array.from(maskPng),
    annotatedSourcePng: annotatedSourcePng ? Array.from(annotatedSourcePng) : null,
    referencePng: referencePng ? Array.from(referencePng) : null,
    referencePngs: references.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
    runId,
  });
}

export async function upscaleAntigravityImage(
  config: AntigravityGeneratorConfig,
  sourcePng: Uint8Array,
  scalePercent: number,
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Antigravity AI upscale is only available in the desktop app.');
  }
  const bin = config.bin?.trim() ? config.bin.trim() : null;
  const projectPath = config.projectPath?.trim() ? config.projectPath.trim() : null;
  const runId = config.runId?.trim() ? config.runId.trim() : `antigravity-upscale-${Date.now()}`;
  return invoke<GeneratedImageResult>('upscale_antigravity_image', {
    ...antigravityInvokeConfig({ ...config, runId }),
    bin,
    projectPath,
    sourcePng: Array.from(sourcePng),
    scalePercent: Math.round(scalePercent),
    runId,
  });
}

export async function decoupleAntigravityImage(
  config: AntigravityGeneratorConfig,
  sourcePng: Uint8Array,
  prompt: string,
  storeAssets = true,
): Promise<DecoupleImageResult> {
  if (!isDesktop()) {
    throw new Error('Antigravity image decoupling is only available in the desktop app.');
  }
  const runId = config.runId?.trim() ? config.runId.trim() : `antigravity-decouple-${Date.now()}`;
  return invoke<DecoupleImageResult>('decouple_antigravity_image', {
    ...antigravityInvokeConfig({ ...config, runId }, false),
    prompt,
    sourcePng: Array.from(sourcePng),
    runId,
    storeAssets,
  });
}

export async function composeAntigravityWorkflow(
  config: AntigravityGeneratorConfig,
  prompt: string,
  sources: WorkflowSourceImage[],
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Antigravity workflow composition is only available in the desktop app.');
  }
  const runId = config.runId?.trim() ? config.runId.trim() : `antigravity-workflow-${Date.now()}`;
  return invoke<GeneratedImageResult>('compose_antigravity_workflow', {
    ...antigravityInvokeConfig({ ...config, runId }),
    prompt,
    sources: sources.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
    runId,
  });
}

/** Show the OS directory picker; null when the user cancels. */
export async function pickProjectFolder(): Promise<string | null> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  const selected = await openDialog({
    title: 'Open PaintNode Project Folder',
    directory: true,
    multiple: false,
    canCreateDirectories: true,
  });
  return !selected || Array.isArray(selected) ? null : selected;
}

export async function openProjectFolderAt(projectPath: string): Promise<ProjectState> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<ProjectState>('project_open_folder', { projectPath });
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
  const defaultName = safeDocumentDialogName(args.name);
  const isWorkflow = defaultName.toLowerCase().endsWith('.cxflow.json');
  const isPsd = defaultName.toLowerCase().endsWith('.psd');
  const defaultPath = args.projectPath?.trim()
    ? `${args.projectPath.trim()}/documents/${defaultName}`
    : defaultName;
  const targetPath = await saveDialog({
    title: args.dialogTitle?.trim()
      ? args.dialogTitle.trim()
      : isWorkflow
        ? 'Save Workflow Board'
        : isPsd
          ? 'Save Photoshop Document'
          : 'Save OpenRaster Document',
    defaultPath,
    filters: isWorkflow
      ? [{ name: 'PaintNode Workflow', extensions: ['json'] }]
      : isPsd
        ? [{ name: 'Photoshop Document', extensions: ['psd'] }]
      : [{ name: 'OpenRaster', extensions: ['ora'] }],
    canCreateDirectories: true,
  });
  if (!targetPath) return null;
  return invoke<SavedDocumentResult>('project_save_document_as', {
    projectPath: args.projectPath?.trim() ? args.projectPath.trim() : null,
    targetPath,
    name: args.name,
    previousName: args.previousName?.trim() ? args.previousName.trim() : null,
    bytes: Array.from(args.bytes),
  });
}

/** Pick image/reference files for an AI request, defaulting to the active project folder. */
export async function pickAiReferenceFiles(projectPath?: string | null): Promise<string[]> {
  if (!isDesktop()) throw new Error('AI reference files are only available in the desktop app.');
  const selected = await openDialog({
    title: 'Add AI Reference',
    directory: false,
    multiple: true,
    defaultPath: projectPath?.trim() ? projectPath.trim() : undefined,
    filters: [
      { name: 'AI reference images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'ora', 'psd'] },
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      { name: 'PaintNode/OpenRaster', extensions: ['ora'] },
      { name: 'Photoshop Document', extensions: ['psd'] },
    ],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
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

export async function quitApplication(): Promise<void> {
  if (!isDesktop()) throw new Error('Native quit is only available in the desktop app.');
  return invoke<void>('quit_app');
}

export async function takePendingOpenPaths(): Promise<string[]> {
  if (!isDesktop()) return [];
  return invoke<string[]>('take_pending_open_paths');
}

export async function readNativeDroppedFile(path: string): Promise<NativeDroppedFile> {
  if (!isDesktop()) throw new Error('Native file drops are only available in the desktop app.');
  const result = await invoke<Omit<NativeDroppedFile, 'bytes'> & { bytes: number[] }>('read_dropped_file', { path });
  return { ...result, bytes: new Uint8Array(result.bytes) };
}
