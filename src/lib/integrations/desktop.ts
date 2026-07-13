import { invoke } from '@tauri-apps/api/core';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import type {
  AiRunOptions,
  AiAutonomyLevel,
  AiDirectorProvider,
  AiDirectorInvolvement,
  AiDirectorMode,
  AiProvider,
  ClaudeModelId,
  ClaudeEffort,
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
  GrokModelId,
  GrokImageModelId,
  GrokImageResolution,
  GrokReasoningEffort,
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
  /** Preserve large provider request/response debug artifacts in job folders. */
  keepDebugArtifacts?: boolean;
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
  /** Whether the AI Director participates in the workflow. */
  directorMode?: AiDirectorMode | null;
  /** Reasoning provider selected to act as AI Director. */
  directorProvider?: AiDirectorProvider | null;
  /** How far the AI Director should stay involved after planning. */
  directorInvolvement?: AiDirectorInvolvement | null;
  /** Result-check strictness for fill/retouch candidates (0 = off, 1 = drift only, 2-3 = + seam continuity). */
  editChecksLevel?: number | null;
  /** Optional provider aspect-ratio override for mask-guided generative fill. */
  fillAspectRatio?: string | null;
}

export interface ClaudeDirectorConfig {
  /** Optional Claude Code executable override. Empty uses the Claude Agent SDK bundled CLI. */
  bin?: string;
  /** Claude model alias selected for Director runs. */
  model?: ClaudeModelId | null;
  /** Claude effort selected for Director runs. */
  effort?: ClaudeEffort | null;
}

/** @deprecated Use ClaudeDirectorConfig. */
export type ClaudePlannerConfig = ClaudeDirectorConfig;

export interface AntigravityGeneratorConfig {
  /** Optional path to the local Antigravity CLI auth helper. Empty uses the Rust-side defaults. */
  bin?: string;
  /** Optional PaintNode project folder. Generated output is saved there when present. */
  projectPath?: string | null;
  /** Keep the actual provider job folder for inspecting the exact inputs sent to the CLI. */
  keepJobDir?: boolean;
  /** Preserve large provider auth/request/response debug artifacts in job folders. */
  keepDebugArtifacts?: boolean;
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
  /** Whether the AI Director participates in the workflow. */
  directorMode?: AiDirectorMode | null;
  /** Reasoning provider selected to act as AI Director. */
  directorProvider?: AiDirectorProvider | null;
  /** How far the AI Director should stay involved after planning. */
  directorInvolvement?: AiDirectorInvolvement | null;
  /** Codex executable used when Codex is selected as AI Director. */
  codexBin?: string | null;
  /** Codex reasoning model used when Codex is selected as AI Director. */
  codexModel?: CodexModelId | null;
  /** Codex reasoning effort used when Codex is selected as AI Director. */
  codexReasoningEffort?: ReasoningEffort | null;
  /** Codex service tier used when Codex is selected as AI Director. */
  codexServiceTier?: ServiceTier | null;
  /** Claude executable used when Claude is selected as AI Director. */
  claudeBin?: string | null;
  /** Claude model used when Claude is selected as AI Director. */
  claudeModel?: ClaudeModelId | null;
  /** Claude reasoning effort used when Claude is selected as AI Director. */
  claudeEffort?: ClaudeEffort | null;
  /** Grok executable used when Grok is selected as AI Director. */
  grokBin?: string | null;
  /** Grok model used when Grok is selected as AI Director. */
  grokModel?: GrokModelId | null;
  /** Grok reasoning effort used when Grok is selected as AI Director. */
  grokReasoningEffort?: GrokReasoningEffort | null;
  /** Result-check strictness for fill/retouch candidates (0 = off, 1 = drift only, 2-3 = + seam continuity). */
  editChecksLevel?: number | null;
  /** Optional Antigravity aspect-ratio override for mask-guided generative fill. */
  fillAspectRatio?: string | null;
}

export interface GrokDirectorConfig {
  /** Optional `grok` binary override. Empty resolves the binary from PATH. */
  bin?: string;
  /** Grok Director model; 'auto' uses the CLI default. */
  model?: GrokModelId;
  /** Grok reasoning effort; 'auto' uses the selected model's default. */
  reasoningEffort?: GrokReasoningEffort;
}

export interface PlannedFillImageConfig {
  directorProvider?: AiDirectorProvider;
  /** @deprecated Use directorProvider. */
  plannerProvider?: AiDirectorProvider;
  claude?: ClaudeDirectorConfig | null;
  grok?: GrokDirectorConfig | null;
  imageProvider?: AiProvider;
  antigravity?: AntigravityGeneratorConfig | null;
  /** Grok image-engine options used when Grok is the fill image provider. */
  grokImage?: GrokGeneratorConfig | null;
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

export interface AiReasoningCapability {
  value: string;
  label: string;
}

export interface AiModelCapability {
  id: string;
  label: string;
  description: string | null;
  supportedReasoningEfforts: AiReasoningCapability[];
  defaultReasoningEffort: string | null;
  isDefault: boolean;
}

export interface AiProviderCapabilitiesResult {
  models: AiModelCapability[];
  source: 'appServer' | 'agentSdk' | 'cli' | 'fallback';
  warning: string | null;
  features: AiProviderFeatureCapabilities;
}

export interface AiProviderFeatureCapabilities {
  transport: 'sdk' | 'cli';
  sessionReuse: boolean;
  structuredOutput: boolean;
  appMediatedUserInput: boolean;
  autonomousSubagents: boolean;
  managedSubagents: boolean;
  structuredProgress: boolean;
}

export interface AiDirectorInputPayload {
  runId: string;
  requestId: string;
  provider: string;
  question: string;
  options: string[];
  allowCustom: boolean;
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
  role?: string;
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

export interface WorkflowEditorReturnResult {
  document: { relativePath: string; contentHash: string; mime: 'image/openraster' };
  output: ProjectAsset;
  outputContentHash: string;
  cleanupToken: string;
}

export interface ProjectAssetMaterial {
  assetId: string;
  relativePath: string;
  bytes: Uint8Array;
  contentHash: string;
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

export interface GrokGeneratorConfig {
  /** Optional `grok` binary override. Empty resolves the binary from PATH. */
  bin?: string;
  /** Optional PaintNode project folder. Generated output is saved there when present. */
  projectPath?: string | null;
  /** Keep the provider job folder for inspecting exact inputs. */
  keepJobDir?: boolean;
  /** Preserve large provider request/response debug artifacts in job folders. */
  keepDebugArtifacts?: boolean;
  /** Per-request id used to filter Grok progress events. */
  runId?: string;
  /** Fixed xAI Imagine image model. */
  imageModel?: GrokImageModelId;
  /** xAI output resolution tier; 'auto' picks 1k or 2k from the target size. */
  imageResolution?: GrokImageResolution;
  /** Optional Grok aspect-ratio override for mask-guided generative fill. */
  fillAspectRatio?: string | null;
  /** Result-check strictness for fill/retouch candidates (0 = off, 1 = drift only, 2-3 = + seam continuity). */
  editChecksLevel?: number | null;
  /** Whether the AI Director participates in workflows that support it. */
  directorMode?: AiDirectorMode | null;
  /** Reasoning provider selected to act as AI Director. */
  directorProvider?: AiDirectorProvider | null;
  /** How far the AI Director should stay involved after planning. */
  directorInvolvement?: AiDirectorInvolvement | null;
  /** Grok chat model used when Grok is the selected AI Director. */
  directorModel?: GrokModelId | null;
  /** Grok reasoning effort used when Grok is the selected AI Director. */
  directorReasoningEffort?: GrokReasoningEffort | null;
}

function grokInvokeConfig(config: GrokGeneratorConfig) {
  return {
    bin: config.bin?.trim() ? config.bin.trim() : null,
    projectPath: config.projectPath?.trim() ? config.projectPath.trim() : null,
    keepJobDir: config.keepJobDir ?? false,
    keepDebugArtifacts: config.keepDebugArtifacts ?? false,
    runId: config.runId?.trim() ? config.runId.trim() : null,
    imageModel: config.imageModel ?? 'grok-imagine-image',
    imageResolution: config.imageResolution ?? 'auto',
  };
}

export function grokConfigFromRunOptions(
  options: AiRunOptions,
  projectPath?: string | null,
  runId?: string,
  keepJobDir = false,
  keepDebugArtifacts = false,
): GrokGeneratorConfig {
  return {
    bin: options.grokExecutableMode === 'custom' ? options.grokBin : '',
    projectPath,
    keepJobDir,
    keepDebugArtifacts,
    runId,
    imageModel: options.grokImageModel,
    imageResolution: options.grokImageResolution,
    fillAspectRatio: options.fillAspectRatio ?? null,
    editChecksLevel: options.editChecksLevel,
    directorMode: options.directorMode ?? options.plannerMode ?? 'auto',
    directorProvider: options.directorProvider ?? options.plannerProvider ?? 'codex',
    directorInvolvement: options.directorInvolvement ?? 'fullReview',
    directorModel: options.grokModel,
    directorReasoningEffort: options.grokReasoningEffort,
  };
}

function codexInvokeConfig(config: CodexGeneratorConfig) {
  return {
    bin: config.bin?.trim() ? config.bin.trim() : null,
    projectPath: config.projectPath?.trim() ? config.projectPath.trim() : null,
    keepJobDir: config.keepJobDir ?? false,
    keepDebugArtifacts: config.keepDebugArtifacts ?? false,
    runId: config.runId?.trim() ? config.runId.trim() : null,
    model: config.model,
    reasoningEffort: config.reasoningEffort ?? null,
    serviceTier: config.serviceTier ?? 'default',
    imageQuality: config.imageQuality ?? 'auto',
    imageModeration: config.imageModeration ?? 'auto',
    autonomyLevel: config.autonomyLevel ?? 'low',
    directorProvider: config.directorProvider ?? 'codex',
    directorMode: config.directorMode ?? 'auto',
    directorInvolvement: config.directorInvolvement ?? 'fullReview',
    editChecksLevel: config.editChecksLevel ?? 1,
    fillAspectRatio: config.fillAspectRatio?.trim() ? config.fillAspectRatio.trim() : null,
  };
}

function antigravityInvokeConfig(config: AntigravityGeneratorConfig, includeImageOptions = true) {
  const base = {
    bin: config.bin?.trim() ? config.bin.trim() : null,
    projectPath: config.projectPath?.trim() ? config.projectPath.trim() : null,
    keepJobDir: config.keepJobDir ?? false,
    keepDebugArtifacts: config.keepDebugArtifacts ?? false,
    runId: config.runId?.trim() ? config.runId.trim() : null,
    model: config.model,
    approvalMode: config.approvalMode ?? 'skipPermissions',
    autonomyLevel: config.autonomyLevel ?? 'low',
    directorProvider: config.directorProvider ?? 'antigravity',
    directorMode: config.directorMode ?? 'auto',
    directorInvolvement: config.directorInvolvement ?? 'fullReview',
    codexBin: config.codexBin?.trim() ? config.codexBin.trim() : null,
    codexModel: config.codexModel ?? null,
    codexReasoningEffort: config.codexReasoningEffort ?? null,
    codexServiceTier: config.codexServiceTier ?? 'default',
    claudeBin: config.claudeBin?.trim() ? config.claudeBin.trim() : null,
    claudeModel: config.claudeModel && config.claudeModel !== 'default' ? config.claudeModel : null,
    claudeEffort: config.claudeEffort ?? null,
    grokBin: config.grokBin?.trim() ? config.grokBin.trim() : null,
    grokModel: config.grokModel ?? null,
    grokReasoningEffort: config.grokReasoningEffort ?? null,
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
  keepDebugArtifacts = false,
): CodexGeneratorConfig {
  return {
    bin: options.codexExecutableMode === 'custom' ? options.codexBin : '',
    projectPath,
    keepJobDir,
    keepDebugArtifacts,
    runId,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    serviceTier: options.serviceTier,
    imageQuality: options.imageQuality,
    imageModeration: options.imageModeration,
    autonomyLevel: options.autonomyLevel,
    directorMode: options.directorMode ?? options.plannerMode ?? 'auto',
    directorProvider: options.directorProvider ?? options.plannerProvider ?? 'codex',
    directorInvolvement: options.directorInvolvement ?? 'fullReview',
    editChecksLevel: options.editChecksLevel,
    fillAspectRatio: options.fillAspectRatio ?? null,
  };
}

export function claudeConfigFromRunOptions(options: AiRunOptions): ClaudeDirectorConfig {
  return {
    bin: options.claudeExecutableMode === 'custom' ? options.claudeBin : '',
    model: options.claudeModel,
    effort: options.claudeEffort,
  };
}

export function antigravityConfigFromRunOptions(
  options: AiRunOptions,
  projectPath?: string | null,
  runId?: string,
  keepJobDir = false,
  keepDebugArtifacts = false,
): AntigravityGeneratorConfig {
  return {
    bin: options.antigravityExecutableMode === 'custom' ? options.antigravityBin : '',
    projectPath,
    keepJobDir,
    keepDebugArtifacts,
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
    directorMode: options.directorMode ?? options.plannerMode ?? 'auto',
    directorProvider: options.directorProvider ?? options.plannerProvider ?? 'antigravity',
    directorInvolvement: options.directorInvolvement ?? 'fullReview',
    codexBin: options.codexExecutableMode === 'custom' ? options.codexBin : '',
    codexModel: options.model,
    codexReasoningEffort: options.reasoningEffort,
    codexServiceTier: options.serviceTier,
    claudeBin: options.claudeExecutableMode === 'custom' ? options.claudeBin : '',
    claudeModel: options.claudeModel,
    claudeEffort: options.claudeEffort,
    grokBin: options.grokExecutableMode === 'custom' ? options.grokBin : '',
    grokModel: options.grokModel,
    grokReasoningEffort: options.grokReasoningEffort,
    editChecksLevel: options.editChecksLevel,
    fillAspectRatio: options.fillAspectRatio ?? null,
  };
}

export function grokDirectorConfigFromRunOptions(options: AiRunOptions): GrokDirectorConfig {
  return {
    bin: options.grokExecutableMode === 'custom' ? options.grokBin : '',
    model: options.grokModel,
    reasoningEffort: options.grokReasoningEffort,
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

export type ProviderQaMode = 'provider-free' | 'provider-e2e' | null;

export async function providerQaMode(): Promise<ProviderQaMode> {
  if (!isDesktop()) return null;
  return invoke<ProviderQaMode>('provider_qa_mode');
}

export async function providerFreeQaPng(width: number, height: number, variant = 0): Promise<Uint8Array> {
  if (!isDesktop()) throw new Error('Provider-free QA output is available only in the desktop QA app.');
  return new Uint8Array(await invoke<number[]>('provider_free_qa_png', { width, height, variant }));
}

export async function providerFreeQaSquarePng(): Promise<Uint8Array> {
  return providerFreeQaPng(1024, 1024);
}

export async function discoverCodexCapabilities(bin?: string): Promise<AiProviderCapabilitiesResult> {
  if (!isDesktop()) {
    throw new Error('Codex capability discovery is only available in the desktop app.');
  }
  return invoke<AiProviderCapabilitiesResult>('discover_codex_capabilities', {
    bin: bin?.trim() ? bin.trim() : null,
  });
}

export async function discoverClaudeCapabilities(bin?: string): Promise<AiProviderCapabilitiesResult> {
  if (!isDesktop()) {
    throw new Error('Claude capability discovery is only available in the desktop app.');
  }
  return invoke<AiProviderCapabilitiesResult>('discover_claude_capabilities', {
    bin: bin?.trim() ? bin.trim() : null,
  });
}

export async function discoverAntigravityCapabilities(bin?: string): Promise<AiProviderCapabilitiesResult> {
  if (!isDesktop()) {
    throw new Error('Antigravity capability discovery is only available in the desktop app.');
  }
  return invoke<AiProviderCapabilitiesResult>('discover_antigravity_capabilities', {
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

export async function detectClaude(bin?: string): Promise<CodexDetectionResult> {
  if (!isDesktop()) {
    return {
      found: false,
      path: null,
      version: null,
      error: 'Claude detection is only available in the desktop app.',
    };
  }
  return invoke<CodexDetectionResult>('detect_claude', {
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
    directorMode: config.directorMode ?? 'auto',
    directorInvolvement: config.directorInvolvement ?? 'fullReview',
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
  plannedImage?: PlannedFillImageConfig,
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Codex generative fill is only available in the desktop app.');
  }
  const bin = config.bin?.trim() ? config.bin.trim() : null;
  const projectPath = config.projectPath?.trim() ? config.projectPath.trim() : null;
  const runId = config.runId?.trim() ? config.runId.trim() : `fill-${Date.now()}`;
  const antigravity = plannedImage?.antigravity ?? null;
  const claude = plannedImage?.claude ?? null;
  const grok = plannedImage?.grok ?? null;
  const grokImage = plannedImage?.grokImage ?? null;
  const directorProvider =
    plannedImage?.directorProvider ?? plannedImage?.plannerProvider ?? config.directorProvider ?? 'codex';
  return invoke<GeneratedImageResult>('generate_codex_fill_image', {
    ...codexInvokeConfig({ ...config, runId }),
    bin,
    prompt,
    projectPath,
    sourcePng: Array.from(sourcePng),
    editTargetPng: Array.from(editTargetPng),
    maskPng: Array.from(maskPng),
    storeAsset,
    directorProvider,
    plannerProvider: directorProvider,
    claudeBin: claude?.bin?.trim() ? claude.bin.trim() : null,
    claudeModel: claude?.model && claude.model !== 'default' ? claude.model : null,
    claudeEffort: claude?.effort ?? null,
    grokBin: grok?.bin?.trim() ? grok.bin.trim() : grokImage?.bin?.trim() ? grokImage.bin.trim() : null,
    grokModel: grok?.model ?? null,
    grokReasoningEffort: grok?.reasoningEffort ?? null,
    grokImageModel: grokImage?.imageModel ?? null,
    grokImageResolution: grokImage?.imageResolution ?? null,
    imageProvider: plannedImage?.imageProvider ?? 'codex',
    antigravityBin: antigravity?.bin?.trim() ? antigravity.bin.trim() : null,
    antigravityModel: antigravity?.model ?? null,
    antigravityApprovalMode: antigravity?.approvalMode ?? null,
    antigravityImageModel: antigravity?.imageModel ?? null,
    antigravityImageSize: antigravity?.imageSize ?? null,
    antigravityPersonGeneration: antigravity?.personGeneration ?? null,
    antigravityProminentPeople: antigravity?.prominentPeople ?? null,
    antigravityCompressionQuality: antigravity?.compressionQuality ?? null,
    antigravityAdvancedJson: antigravity?.advancedJson ?? null,
    antigravitySafetyFiltering: antigravity?.safetyFiltering ?? null,
    antigravitySafetyHarassment: antigravity?.safetyHarassment ?? null,
    antigravitySafetyHateSpeech: antigravity?.safetyHateSpeech ?? null,
    antigravitySafetySexuallyExplicit: antigravity?.safetySexuallyExplicit ?? null,
    antigravitySafetyDangerousContent: antigravity?.safetyDangerousContent ?? null,
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

export async function submitAiDirectorInput(
  request: Pick<AiDirectorInputPayload, 'runId' | 'requestId'>,
  answer: string,
  cancelled = false,
): Promise<void> {
  if (!isDesktop()) return;
  await invoke('submit_ai_director_input', {
    runId: request.runId,
    requestId: request.requestId,
    answer,
    cancelled,
  });
}

export async function upscaleCodexImage(
  config: CodexGeneratorConfig,
  sourcePng: Uint8Array,
  scalePercent: number,
  keepComposedResult = false,
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
    keepComposedResult,
    directorMode: config.directorMode ?? 'auto',
    directorInvolvement: config.directorInvolvement ?? 'fullReview',
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
  targetDimensions?: TargetDimensions | null,
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
      role: source.role?.trim() || 'Connected visual input',
      bytes: Array.from(source.bytes),
    })),
    targetWidth: targetDimensions?.width ?? null,
    targetHeight: targetDimensions?.height ?? null,
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
    directorMode: config.directorMode ?? 'auto',
    directorInvolvement: config.directorInvolvement ?? 'fullReview',
    targetWidth: targetDimensions?.width ?? null,
    targetHeight: targetDimensions?.height ?? null,
    referencePngs: references.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
  });
}

export async function detectGrok(bin?: string): Promise<CodexDetectionResult> {
  if (!isDesktop()) {
    throw new Error('Grok detection is only available in the desktop app.');
  }
  return invoke<CodexDetectionResult>('detect_grok', {
    bin: bin?.trim() ? bin.trim() : null,
  });
}

export async function discoverGrokCapabilities(bin?: string): Promise<AiProviderCapabilitiesResult> {
  if (!isDesktop()) {
    throw new Error('Grok capability discovery is only available in the desktop app.');
  }
  return invoke<AiProviderCapabilitiesResult>('discover_grok_capabilities', {
    bin: bin?.trim() ? bin.trim() : null,
  });
}

/**
 * Decoupled Grok (xAI Imagine) text-to-image generation. Reference images are
 * routed through the xAI edit endpoint (up to 3 supported).
 */
export async function generateGrokImage(
  config: GrokGeneratorConfig,
  prompt: string,
  targetDimensions?: TargetDimensions | null,
  references: WorkflowSourceImage[] = [],
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Grok image generation is only available in the desktop app.');
  }
  // Reject oversize reference sets here so multi-megabyte byte arrays are not
  // serialized over IPC just for the backend to return the same error.
  if (references.length > 3) {
    throw new Error('Grok supports up to 3 reference images per generation. Remove some references, or use Antigravity or Codex.');
  }
  const runId = config.runId?.trim() ? config.runId.trim() : `grok-${Date.now()}`;
  return invoke<GeneratedImageResult>('generate_grok_image', {
    ...grokInvokeConfig({ ...config, runId }),
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

/** Mask-guided Grok generative fill through the xAI image-edit endpoint. */
export async function generateGrokFillImage(
  config: GrokGeneratorConfig,
  sourcePng: Uint8Array,
  editTargetPng: Uint8Array,
  maskPng: Uint8Array,
  prompt: string,
  references: WorkflowSourceImage[] = [],
  storeAsset = true,
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Grok generative fill is only available in the desktop app.');
  }
  const runId = config.runId?.trim() ? config.runId.trim() : `grok-fill-${Date.now()}`;
  return invoke<GeneratedImageResult>('generate_grok_fill_image', {
    ...grokInvokeConfig({ ...config, runId }),
    prompt,
    sourcePng: Array.from(sourcePng),
    editTargetPng: Array.from(editTargetPng),
    maskPng: Array.from(maskPng),
    storeAsset,
    fillAspectRatio: config.fillAspectRatio?.trim() ? config.fillAspectRatio.trim() : null,
    editChecksLevel: config.editChecksLevel ?? 1,
    referencePngs: references.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
    runId,
  });
}

/** Grok retouch / auto-adjust through the xAI image-edit endpoint. */
export async function generateGrokRetouchImage(
  config: GrokGeneratorConfig,
  sourcePng: Uint8Array,
  editTargetPng: Uint8Array,
  maskPng: Uint8Array,
  annotatedSourcePng: Uint8Array | null | undefined,
  referencePng: Uint8Array | null | undefined,
  prompt: string,
  references: WorkflowSourceImage[] = [],
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Grok retouch is only available in the desktop app.');
  }
  const runId = config.runId?.trim() ? config.runId.trim() : `grok-retouch-${Date.now()}`;
  return invoke<GeneratedImageResult>('generate_grok_retouch_image', {
    ...grokInvokeConfig({ ...config, runId }),
    prompt,
    sourcePng: Array.from(sourcePng),
    editTargetPng: Array.from(editTargetPng),
    maskPng: Array.from(maskPng),
    annotatedSourcePng: annotatedSourcePng ? Array.from(annotatedSourcePng) : null,
    referencePng: referencePng ? Array.from(referencePng) : null,
    editChecksLevel: config.editChecksLevel ?? 1,
    referencePngs: references.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
    runId,
  });
}

/** Grok upscale: enlarge, then restore detail tile-by-tile via image edits. */
export async function upscaleGrokImage(
  config: GrokGeneratorConfig,
  sourcePng: Uint8Array,
  scalePercent: number,
  keepComposedResult = false,
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Grok upscale is only available in the desktop app.');
  }
  const runId = config.runId?.trim() ? config.runId.trim() : `grok-upscale-${Date.now()}`;
  return invoke<GeneratedImageResult>('upscale_grok_image', {
    ...grokInvokeConfig({ ...config, runId }),
    sourcePng: Array.from(sourcePng),
    scalePercent: Math.round(scalePercent),
    keepComposedResult,
    directorMode: config.directorMode ?? 'auto',
    directorProvider: config.directorProvider ?? 'codex',
    directorInvolvement: config.directorInvolvement ?? 'fullReview',
    directorModel: config.directorModel ?? null,
    directorReasoningEffort: config.directorReasoningEffort ?? null,
    runId,
  });
}

/** Grok multi-asset compose (up to 3 sources) via the xAI image-edit endpoint. */
export async function composeGrokWorkflow(
  config: GrokGeneratorConfig,
  prompt: string,
  sources: WorkflowSourceImage[],
): Promise<GeneratedImageResult> {
  if (!isDesktop()) {
    throw new Error('Grok workflow compose is only available in the desktop app.');
  }
  if (sources.length > 3) {
    throw new Error('Grok multi-asset compose supports up to 3 source images. Connect at most 3 assets, or switch the image generator to Codex or Antigravity.');
  }
  const runId = config.runId?.trim() ? config.runId.trim() : `grok-workflow-${Date.now()}`;
  return invoke<GeneratedImageResult>('compose_grok_workflow', {
    ...grokInvokeConfig({ ...config, runId }),
    prompt,
    sources: sources.map((source) => ({
      name: source.name,
      bytes: Array.from(source.bytes),
    })),
    runId,
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
  keepComposedResult = false,
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
    keepComposedResult,
    directorMode: config.directorMode ?? 'auto',
    directorInvolvement: config.directorInvolvement ?? 'fullReview',
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
  targetDimensions?: TargetDimensions | null,
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
      role: source.role?.trim() || 'Connected visual input',
      bytes: Array.from(source.bytes),
    })),
    targetWidth: targetDimensions?.width ?? null,
    targetHeight: targetDimensions?.height ?? null,
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

export async function storeProjectClipboardImage(
  projectPath: string,
  name = 'Clipboard Image.png',
): Promise<StoredAssetResult | null> {
  if (!isDesktop()) throw new Error('Clipboard image import is available only in the PaintNode desktop app.');
  return invoke<StoredAssetResult | null>('project_store_clipboard_image', { projectPath, name });
}

export async function commitWorkflowEditorReturn(args: {
  projectPath: string;
  revisionId: string;
  name: string;
  documentBytes: Uint8Array;
  outputBytes: Uint8Array;
  width: number;
  height: number;
}): Promise<WorkflowEditorReturnResult> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<WorkflowEditorReturnResult>('project_commit_workflow_editor_return', {
    ...args,
    documentBytes: Array.from(args.documentBytes),
    outputBytes: Array.from(args.outputBytes),
  });
}

export async function rollbackWorkflowEditorReturn(projectPath: string, cleanupToken: string): Promise<void> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  await invoke<void>('project_rollback_workflow_editor_return', { projectPath, cleanupToken });
}

export async function finalizeWorkflowEditorReturn(projectPath: string, cleanupToken: string): Promise<boolean> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<boolean>('project_finalize_workflow_editor_return', { projectPath, cleanupToken });
}

export async function readProjectAsset(projectPath: string, assetId: string): Promise<StoredAssetResult> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  return invoke<StoredAssetResult>('project_read_asset', { projectPath, assetId });
}

export async function resolveProjectAssetMaterial(
  projectPath: string,
  assetId: string,
): Promise<ProjectAssetMaterial> {
  if (!isDesktop()) throw new Error('Projects are only available in the desktop app.');
  const result = await invoke<ArrayBuffer>('project_resolve_asset_material', {
    projectPath,
    assetId,
  });
  return parseProjectAssetMaterialEnvelope(result);
}

const PROJECT_MATERIAL_MAGIC = new TextEncoder().encode('PNMATRAW');
const PROJECT_MATERIAL_HEADER_BYTES = 18;
const PROJECT_MATERIAL_METADATA_MAX_BYTES = 4 * 1024;
const PROJECT_MATERIAL_MAX_BYTES = 32 * 1024 * 1024;

export function parseProjectAssetMaterialEnvelope(raw: ArrayBuffer | Uint8Array): ProjectAssetMaterial {
  const envelope = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (envelope.length < PROJECT_MATERIAL_HEADER_BYTES
    || !PROJECT_MATERIAL_MAGIC.every((byte, index) => envelope[index] === byte)) {
    throw new Error('Project material response has an invalid header.');
  }
  const view = new DataView(envelope.buffer, envelope.byteOffset, envelope.byteLength);
  const version = view.getUint16(8, false);
  const metadataLength = view.getUint32(10, false);
  const materialLength = view.getUint32(14, false);
  if (version !== 1
    || metadataLength > PROJECT_MATERIAL_METADATA_MAX_BYTES
    || materialLength > PROJECT_MATERIAL_MAX_BYTES
    || PROJECT_MATERIAL_HEADER_BYTES + metadataLength + materialLength !== envelope.length) {
    throw new Error('Project material response has invalid lengths or version.');
  }
  const metadataStart = PROJECT_MATERIAL_HEADER_BYTES;
  const metadataEnd = metadataStart + metadataLength;
  let metadata: unknown;
  try {
    metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      envelope.subarray(metadataStart, metadataEnd),
    )) as unknown;
  } catch {
    throw new Error('Project material response metadata is invalid.');
  }
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new Error('Project material response metadata is invalid.');
  }
  const record = metadata as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== 'assetId' || keys[1] !== 'contentHash' || keys[2] !== 'relativePath') {
    throw new Error('Project material response metadata is invalid.');
  }
  const assetId = typeof record.assetId === 'string' ? record.assetId : '';
  const relativePath = typeof record.relativePath === 'string' ? record.relativePath : '';
  const contentHash = typeof record.contentHash === 'string' ? record.contentHash : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(assetId) || assetId.includes('..')
    || !relativePath || relativePath.startsWith('/') || relativePath.startsWith('~')
    || relativePath.includes('\\') || relativePath.split('/').some((part) => !part || part === '.' || part === '..' || part.includes(':'))
    || !/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
    throw new Error('Project material response identity is invalid.');
  }
  return {
    assetId,
    relativePath,
    contentHash,
    bytes: envelope.slice(metadataEnd),
  };
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
