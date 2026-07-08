export const SETTINGS_STORAGE_KEY = 'paintnode.settings';

export const CODEX_MODEL_OPTIONS = [
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
] as const;

export const ANTIGRAVITY_MODEL_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'Gemini 3.5 Flash (High)', label: 'Gemini 3.5 Flash High' },
  { id: 'Gemini 3.5 Flash (Medium)', label: 'Gemini 3.5 Flash Medium' },
  { id: 'Gemini 3.5 Flash (Low)', label: 'Gemini 3.5 Flash Low' },
  { id: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro High' },
  { id: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro Low' },
  { id: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 Thinking' },
  { id: 'Claude Opus 4.6 (Thinking)', label: 'Claude Opus 4.6 Thinking' },
  { id: 'GPT-OSS 120B (Medium)', label: 'GPT-OSS 120B Medium' },
] as const;

export const ANTIGRAVITY_IMAGE_MODEL_OPTIONS = [
  { id: 'gemini-3.1-flash-image', label: 'Gemini 3.1 Flash Image' },
  { id: 'auto', label: 'Auto' },
] as const;

export const ANTIGRAVITY_IMAGE_SIZE_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: '1K', label: '1K' },
  { id: '2K', label: '2K' },
  { id: '4K', label: '4K' },
] as const;

export const ANTIGRAVITY_PERSON_GENERATION_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'ALLOW_NONE', label: 'No people' },
  { id: 'ALLOW_ADULT', label: 'Adults only' },
  { id: 'ALLOW_ALL', label: 'Allow people' },
] as const;

export const ANTIGRAVITY_PROMINENT_PEOPLE_OPTIONS = [
  { id: 'auto', label: 'Auto' },
  { id: 'BLOCK_PROMINENT_PEOPLE', label: 'Block prominent people' },
] as const;

export const ANTIGRAVITY_SAFETY_FILTERING_OPTIONS = [
  { id: 'default', label: 'Default' },
  { id: 'lessRestrictive', label: 'Less restrictive' },
  { id: 'moreRestrictive', label: 'More restrictive' },
  { id: 'custom', label: 'Custom' },
] as const;

export const ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS = [
  { id: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED', label: 'API default' },
  { id: 'OFF', label: 'Off' },
  { id: 'BLOCK_NONE', label: 'Block none' },
  { id: 'BLOCK_ONLY_HIGH', label: 'Block high' },
  { id: 'BLOCK_MEDIUM_AND_ABOVE', label: 'Block medium+' },
  { id: 'BLOCK_LOW_AND_ABOVE', label: 'Block low+' },
] as const;

export const ANTIGRAVITY_SAFETY_CATEGORY_OPTIONS = [
  { id: 'antigravitySafetyHarassment', label: 'Harassment' },
  { id: 'antigravitySafetyHateSpeech', label: 'Hate speech' },
  { id: 'antigravitySafetySexuallyExplicit', label: 'Sexually explicit' },
  { id: 'antigravitySafetyDangerousContent', label: 'Dangerous content' },
] as const;

export type CodexModelId = (typeof CODEX_MODEL_OPTIONS)[number]['id'];
export type AntigravityModelId = (typeof ANTIGRAVITY_MODEL_OPTIONS)[number]['id'];
export type AntigravityImageModelId = (typeof ANTIGRAVITY_IMAGE_MODEL_OPTIONS)[number]['id'];
export type AntigravityImageSize = (typeof ANTIGRAVITY_IMAGE_SIZE_OPTIONS)[number]['id'];
export type AntigravityPersonGeneration = (typeof ANTIGRAVITY_PERSON_GENERATION_OPTIONS)[number]['id'];
export type AntigravityProminentPeople = (typeof ANTIGRAVITY_PROMINENT_PEOPLE_OPTIONS)[number]['id'];
export type AntigravitySafetyFiltering = (typeof ANTIGRAVITY_SAFETY_FILTERING_OPTIONS)[number]['id'];
export type AntigravitySafetyThreshold = (typeof ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS)[number]['id'];
export type AntigravitySafetyCategorySetting = (typeof ANTIGRAVITY_SAFETY_CATEGORY_OPTIONS)[number]['id'];
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ServiceTier = 'default' | 'fast';
export type CodexImageQuality = 'auto' | 'low' | 'medium' | 'high';
export type CodexImageModeration = 'auto' | 'low';
export type AntigravityApprovalMode = 'default' | 'skipPermissions';
export type AiAutonomyLevel = 'low' | 'guided' | 'open' | 'unmanaged';
export type AiProvider = 'codex' | 'antigravity';
export type AiPlannerMode = 'auto' | 'skip' | 'force';
export type CanvasBackground = 'white' | 'transparent';
/**
 * How strictly PaintNode validates fill/retouch candidates before pasting
 * them back for AI retouch: 0 = no checks, 1 = in-place drift gate only
 * (default), 2 = drift + seam continuity, 3 = strict seam continuity.
 */
export type AiEditChecksLevel = 0 | 1 | 2 | 3;

export interface AiRunOptions {
  /** @deprecated Use imageProvider. Kept so older task/profile records still hydrate safely. */
  provider: AiProvider;
  plannerMode: AiPlannerMode;
  plannerProvider: AiProvider;
  imageProvider: AiProvider;
  codexBin: string;
  model: CodexModelId;
  reasoningEffort: ReasoningEffort;
  serviceTier: ServiceTier;
  imageQuality: CodexImageQuality;
  imageModeration: CodexImageModeration;
  autonomyLevel: AiAutonomyLevel;
  antigravityBin: string;
  antigravityModel: AntigravityModelId;
  antigravityApprovalMode: AntigravityApprovalMode;
  antigravityImageModel: AntigravityImageModelId;
  antigravityImageSize: AntigravityImageSize;
  antigravityPersonGeneration: AntigravityPersonGeneration;
  antigravityProminentPeople: AntigravityProminentPeople;
  antigravityCompressionQuality: number | null;
  antigravityAdvancedOptionsJson: string;
  antigravitySafetyFiltering: AntigravitySafetyFiltering;
  antigravitySafetyHarassment: AntigravitySafetyThreshold;
  antigravitySafetyHateSpeech: AntigravitySafetyThreshold;
  antigravitySafetySexuallyExplicit: AntigravitySafetyThreshold;
  antigravitySafetyDangerousContent: AntigravitySafetyThreshold;
  editChecksLevel: AiEditChecksLevel;
  fillAspectRatio?: string | null;
}

export type AiProfileOptions = Omit<AiRunOptions, 'codexBin' | 'antigravityBin' | 'fillAspectRatio'>;

export interface AiSettingsProfile {
  id: string;
  name: string;
  options: AiProfileOptions;
}

export interface PaintNodeSettings {
  general: {
    autosaveEnabled: boolean;
    autosaveIntervalMs: number;
    reopenLastProject: boolean;
    showContextualTaskBarOnStartup: boolean;
  };
  ai: {
    /** @deprecated Use imageProvider. Kept for backward-compatible settings migration. */
    provider: AiProvider;
    plannerMode: AiPlannerMode;
    plannerProvider: AiProvider;
    imageProvider: AiProvider;
    codexBin: string;
    model: CodexModelId;
    reasoningEffort: ReasoningEffort;
    serviceTier: ServiceTier;
    imageQuality: CodexImageQuality;
    imageModeration: CodexImageModeration;
    autonomyLevel: AiAutonomyLevel;
    antigravityBin: string;
    antigravityModel: AntigravityModelId;
    antigravityApprovalMode: AntigravityApprovalMode;
    antigravityImageModel: AntigravityImageModelId;
    antigravityImageSize: AntigravityImageSize;
    antigravityPersonGeneration: AntigravityPersonGeneration;
    antigravityProminentPeople: AntigravityProminentPeople;
    antigravityCompressionQuality: number | null;
    antigravityAdvancedOptionsJson: string;
    antigravitySafetyFiltering: AntigravitySafetyFiltering;
    antigravitySafetyHarassment: AntigravitySafetyThreshold;
    antigravitySafetyHateSpeech: AntigravitySafetyThreshold;
    antigravitySafetySexuallyExplicit: AntigravitySafetyThreshold;
    antigravitySafetyDangerousContent: AntigravitySafetyThreshold;
    editChecksLevel: AiEditChecksLevel;
    profiles: AiSettingsProfile[];
    defaultProfileId: string | null;
  };
  workspace: {
    defaultCanvasWidth: number;
    defaultCanvasHeight: number;
    defaultBackground: CanvasBackground;
    showTransparencyChecker: boolean;
    keepAiRunInputs: boolean;
    keepAiUpscaleComposedResult: boolean;
    keepAiDebugArtifacts: boolean;
    layerAnnotationsExpanded: boolean;
  };
}

export const AUTOSAVE_INTERVAL_OPTIONS = [
  { value: 30_000, label: 'Every 30 seconds' },
  { value: 60_000, label: 'Every minute' },
  { value: 120_000, label: 'Every 2 minutes' },
  { value: 300_000, label: 'Every 5 minutes' },
] as const;

const MODEL_IDS = new Set<string>(CODEX_MODEL_OPTIONS.map((option) => option.id));
const ANTIGRAVITY_MODEL_IDS = new Set<string>(ANTIGRAVITY_MODEL_OPTIONS.map((option) => option.id));
const ANTIGRAVITY_IMAGE_MODEL_IDS = new Set<string>(ANTIGRAVITY_IMAGE_MODEL_OPTIONS.map((option) => option.id));
const ANTIGRAVITY_IMAGE_SIZE_IDS = new Set<string>(ANTIGRAVITY_IMAGE_SIZE_OPTIONS.map((option) => option.id));
const ANTIGRAVITY_PERSON_GENERATION_IDS = new Set<string>(
  ANTIGRAVITY_PERSON_GENERATION_OPTIONS.map((option) => option.id),
);
const ANTIGRAVITY_PROMINENT_PEOPLE_IDS = new Set<string>(
  ANTIGRAVITY_PROMINENT_PEOPLE_OPTIONS.map((option) => option.id),
);
const ANTIGRAVITY_SAFETY_FILTERING_IDS = new Set<string>(
  ANTIGRAVITY_SAFETY_FILTERING_OPTIONS.map((option) => option.id),
);
const ANTIGRAVITY_SAFETY_THRESHOLD_IDS = new Set<string>(
  ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS.map((option) => option.id),
);
const AUTOSAVE_INTERVALS = new Set<number>(AUTOSAVE_INTERVAL_OPTIONS.map((option) => option.value));
const REASONING_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh']);
const IMAGE_QUALITIES = new Set<string>(['auto', 'low', 'medium', 'high']);
const IMAGE_MODERATIONS = new Set<string>(['auto', 'low']);
const AI_AUTONOMY_LEVELS = new Set<string>(['low', 'guided', 'open', 'unmanaged']);
const AI_PLANNER_MODES = new Set<string>(['auto', 'skip', 'force']);

function normalizeAiProvider(value: unknown, fallback: AiProvider): AiProvider {
  const text = String(value);
  if (text === 'antigravity' || text === 'gemini') return 'antigravity';
  if (text === 'codex') return 'codex';
  return fallback;
}

function normalizePlannerMode(value: unknown, fallback: AiPlannerMode): AiPlannerMode {
  return AI_PLANNER_MODES.has(String(value)) ? (value as AiPlannerMode) : fallback;
}

function normalizeAntigravitySafetyFiltering(value: unknown, fallback: AntigravitySafetyFiltering): AntigravitySafetyFiltering {
  return ANTIGRAVITY_SAFETY_FILTERING_IDS.has(String(value))
    ? (value as AntigravitySafetyFiltering)
    : fallback;
}

function normalizeAntigravitySafetyThreshold(value: unknown, fallback: AntigravitySafetyThreshold): AntigravitySafetyThreshold {
  return ANTIGRAVITY_SAFETY_THRESHOLD_IDS.has(String(value))
    ? (value as AntigravitySafetyThreshold)
    : fallback;
}

export function defaultSettings(): PaintNodeSettings {
  return {
    general: {
      autosaveEnabled: true,
      autosaveIntervalMs: 60_000,
      reopenLastProject: true,
      showContextualTaskBarOnStartup: true,
    },
    ai: {
      provider: 'codex',
      plannerMode: 'auto',
      plannerProvider: 'codex',
      imageProvider: 'codex',
      codexBin: '',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      serviceTier: 'default',
      imageQuality: 'auto',
      imageModeration: 'auto',
      autonomyLevel: 'low',
      antigravityBin: '',
      antigravityModel: 'auto',
      antigravityApprovalMode: 'skipPermissions',
      antigravityImageModel: 'gemini-3.1-flash-image',
      antigravityImageSize: 'auto',
      antigravityPersonGeneration: 'auto',
      antigravityProminentPeople: 'auto',
      antigravityCompressionQuality: null,
      antigravityAdvancedOptionsJson: '{}',
      antigravitySafetyFiltering: 'default',
      antigravitySafetyHarassment: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
      antigravitySafetyHateSpeech: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
      antigravitySafetySexuallyExplicit: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
      antigravitySafetyDangerousContent: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
      editChecksLevel: 1,
      profiles: [],
      defaultProfileId: null,
    },
    workspace: {
      defaultCanvasWidth: 1280,
      defaultCanvasHeight: 800,
      defaultBackground: 'transparent',
      showTransparencyChecker: true,
      keepAiRunInputs: true,
      keepAiUpscaleComposedResult: false,
      keepAiDebugArtifacts: false,
      layerAnnotationsExpanded: true,
    },
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(numberOrDefault(value, fallback))));
}

function nullableClampedInt(value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeAiProfileOptions(raw: unknown, fallback: PaintNodeSettings['ai']): AiProfileOptions {
  const value = isRecord(raw) ? raw : {};
  const provider = normalizeAiProvider(value.provider, fallback.provider);
  const imageProvider = normalizeAiProvider(value.imageProvider, provider);
  const legacyPlannerMode: AiPlannerMode = provider === 'antigravity' ? 'skip' : fallback.plannerMode;
  const savedReasoningEffort = value.reasoningEffort === 'minimal' ? 'low' : value.reasoningEffort;
  return {
    provider: imageProvider,
    plannerMode: normalizePlannerMode(value.plannerMode, legacyPlannerMode),
    plannerProvider: normalizeAiProvider(value.plannerProvider, provider),
    imageProvider,
    model: MODEL_IDS.has(String(value.model)) ? (value.model as CodexModelId) : fallback.model,
    reasoningEffort: REASONING_EFFORTS.has(String(savedReasoningEffort))
      ? (savedReasoningEffort as ReasoningEffort)
      : fallback.reasoningEffort,
    serviceTier: value.serviceTier === 'fast' ? 'fast' : fallback.serviceTier,
    imageQuality: IMAGE_QUALITIES.has(String(value.imageQuality))
      ? (value.imageQuality as CodexImageQuality)
      : fallback.imageQuality,
    imageModeration: IMAGE_MODERATIONS.has(String(value.imageModeration))
      ? (value.imageModeration as CodexImageModeration)
      : fallback.imageModeration,
    autonomyLevel: AI_AUTONOMY_LEVELS.has(String(value.autonomyLevel))
      ? (value.autonomyLevel as AiAutonomyLevel)
      : fallback.autonomyLevel,
    antigravityModel: ANTIGRAVITY_MODEL_IDS.has(String(value.antigravityModel))
      ? (value.antigravityModel as AntigravityModelId)
      : fallback.antigravityModel,
    antigravityApprovalMode:
      value.antigravityApprovalMode === 'default' || value.antigravityApprovalMode === 'skipPermissions'
        ? (value.antigravityApprovalMode as AntigravityApprovalMode)
        : fallback.antigravityApprovalMode,
    antigravityImageModel: ANTIGRAVITY_IMAGE_MODEL_IDS.has(String(value.antigravityImageModel))
      ? (value.antigravityImageModel as AntigravityImageModelId)
      : fallback.antigravityImageModel,
    antigravityImageSize: ANTIGRAVITY_IMAGE_SIZE_IDS.has(String(value.antigravityImageSize))
      ? (value.antigravityImageSize as AntigravityImageSize)
      : fallback.antigravityImageSize,
    antigravityPersonGeneration: ANTIGRAVITY_PERSON_GENERATION_IDS.has(String(value.antigravityPersonGeneration))
      ? (value.antigravityPersonGeneration as AntigravityPersonGeneration)
      : fallback.antigravityPersonGeneration,
    antigravityProminentPeople: ANTIGRAVITY_PROMINENT_PEOPLE_IDS.has(String(value.antigravityProminentPeople))
      ? (value.antigravityProminentPeople as AntigravityProminentPeople)
      : fallback.antigravityProminentPeople,
    antigravityCompressionQuality: nullableClampedInt(value.antigravityCompressionQuality, 0, 100),
    antigravityAdvancedOptionsJson: stringOrDefault(
      value.antigravityAdvancedOptionsJson,
      fallback.antigravityAdvancedOptionsJson,
    ),
    antigravitySafetyFiltering: normalizeAntigravitySafetyFiltering(
      value.antigravitySafetyFiltering,
      fallback.antigravitySafetyFiltering,
    ),
    antigravitySafetyHarassment: normalizeAntigravitySafetyThreshold(
      value.antigravitySafetyHarassment,
      fallback.antigravitySafetyHarassment,
    ),
    antigravitySafetyHateSpeech: normalizeAntigravitySafetyThreshold(
      value.antigravitySafetyHateSpeech,
      fallback.antigravitySafetyHateSpeech,
    ),
    antigravitySafetySexuallyExplicit: normalizeAntigravitySafetyThreshold(
      value.antigravitySafetySexuallyExplicit,
      fallback.antigravitySafetySexuallyExplicit,
    ),
    antigravitySafetyDangerousContent: normalizeAntigravitySafetyThreshold(
      value.antigravitySafetyDangerousContent,
      fallback.antigravitySafetyDangerousContent,
    ),
    editChecksLevel: clampInt(value.editChecksLevel, fallback.editChecksLevel, 0, 3) as AiEditChecksLevel,
  };
}

function normalizeAiProfiles(raw: unknown, fallback: PaintNodeSettings['ai']): AiSettingsProfile[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const profiles: AiSettingsProfile[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 80) : 'AI Profile';
    seen.add(id);
    profiles.push({
      id,
      name,
      options: normalizeAiProfileOptions(item.options, fallback),
    });
  }
  return profiles.slice(0, 24);
}

export function normalizeSettings(raw: unknown): PaintNodeSettings {
  const defaults = defaultSettings();
  if (!isRecord(raw)) return defaults;

  const general = isRecord(raw.general) ? raw.general : {};
  const ai = isRecord(raw.ai) ? raw.ai : {};
  const workspace = isRecord(raw.workspace) ? raw.workspace : {};
  const autosaveIntervalMs = numberOrDefault(general.autosaveIntervalMs, defaults.general.autosaveIntervalMs);

  const provider = normalizeAiProvider(ai.provider, defaults.ai.provider);
  const imageProvider = normalizeAiProvider(ai.imageProvider, provider);
  const legacyPlannerMode: AiPlannerMode = provider === 'antigravity' ? 'skip' : defaults.ai.plannerMode;
  // Codex CLI retired the "minimal" reasoning effort; map old saves to the closest level.
  const savedReasoningEffort = ai.reasoningEffort === 'minimal' ? 'low' : ai.reasoningEffort;
  const savedAntigravityBin = ai.antigravityBin ?? ai.geminiBin;
  const savedAntigravityModel = ai.antigravityModel ?? ai.geminiModel;
  const savedAntigravityApprovalMode = ai.antigravityApprovalMode ?? ai.geminiApprovalMode;
  const normalizedAiBase: Omit<PaintNodeSettings['ai'], 'profiles' | 'defaultProfileId'> = {
    provider: imageProvider,
    plannerMode: normalizePlannerMode(ai.plannerMode, legacyPlannerMode),
    plannerProvider: normalizeAiProvider(ai.plannerProvider, provider),
    imageProvider,
    codexBin: stringOrDefault(ai.codexBin, defaults.ai.codexBin),
    model: MODEL_IDS.has(String(ai.model)) ? (ai.model as CodexModelId) : defaults.ai.model,
    reasoningEffort: REASONING_EFFORTS.has(String(savedReasoningEffort))
      ? (savedReasoningEffort as ReasoningEffort)
      : defaults.ai.reasoningEffort,
    serviceTier: ai.serviceTier === 'fast' ? 'fast' : 'default',
    imageQuality: IMAGE_QUALITIES.has(String(ai.imageQuality))
      ? (ai.imageQuality as CodexImageQuality)
      : defaults.ai.imageQuality,
    imageModeration: IMAGE_MODERATIONS.has(String(ai.imageModeration))
      ? (ai.imageModeration as CodexImageModeration)
      : defaults.ai.imageModeration,
    autonomyLevel: AI_AUTONOMY_LEVELS.has(String(ai.autonomyLevel))
      ? (ai.autonomyLevel as AiAutonomyLevel)
      : defaults.ai.autonomyLevel,
    antigravityBin: stringOrDefault(savedAntigravityBin, defaults.ai.antigravityBin),
    antigravityModel: ANTIGRAVITY_MODEL_IDS.has(String(savedAntigravityModel))
      ? (savedAntigravityModel as AntigravityModelId)
      : defaults.ai.antigravityModel,
    antigravityApprovalMode:
      savedAntigravityApprovalMode === 'default' ? 'default' : defaults.ai.antigravityApprovalMode,
    antigravityImageModel: ANTIGRAVITY_IMAGE_MODEL_IDS.has(String(ai.antigravityImageModel))
      ? (ai.antigravityImageModel as AntigravityImageModelId)
      : defaults.ai.antigravityImageModel,
    antigravityImageSize: ANTIGRAVITY_IMAGE_SIZE_IDS.has(String(ai.antigravityImageSize))
      ? (ai.antigravityImageSize as AntigravityImageSize)
      : defaults.ai.antigravityImageSize,
    antigravityPersonGeneration: ANTIGRAVITY_PERSON_GENERATION_IDS.has(String(ai.antigravityPersonGeneration))
      ? (ai.antigravityPersonGeneration as AntigravityPersonGeneration)
      : defaults.ai.antigravityPersonGeneration,
    antigravityProminentPeople: ANTIGRAVITY_PROMINENT_PEOPLE_IDS.has(String(ai.antigravityProminentPeople))
      ? (ai.antigravityProminentPeople as AntigravityProminentPeople)
      : defaults.ai.antigravityProminentPeople,
    antigravityCompressionQuality: nullableClampedInt(ai.antigravityCompressionQuality, 0, 100),
    antigravityAdvancedOptionsJson: stringOrDefault(
      ai.antigravityAdvancedOptionsJson,
      defaults.ai.antigravityAdvancedOptionsJson,
    ),
    antigravitySafetyFiltering: normalizeAntigravitySafetyFiltering(
      ai.antigravitySafetyFiltering,
      defaults.ai.antigravitySafetyFiltering,
    ),
    antigravitySafetyHarassment: normalizeAntigravitySafetyThreshold(
      ai.antigravitySafetyHarassment,
      defaults.ai.antigravitySafetyHarassment,
    ),
    antigravitySafetyHateSpeech: normalizeAntigravitySafetyThreshold(
      ai.antigravitySafetyHateSpeech,
      defaults.ai.antigravitySafetyHateSpeech,
    ),
    antigravitySafetySexuallyExplicit: normalizeAntigravitySafetyThreshold(
      ai.antigravitySafetySexuallyExplicit,
      defaults.ai.antigravitySafetySexuallyExplicit,
    ),
    antigravitySafetyDangerousContent: normalizeAntigravitySafetyThreshold(
      ai.antigravitySafetyDangerousContent,
      defaults.ai.antigravitySafetyDangerousContent,
    ),
    editChecksLevel: clampInt(ai.editChecksLevel, defaults.ai.editChecksLevel, 0, 3) as AiEditChecksLevel,
  };
  const profileFallback = { ...normalizedAiBase, profiles: [], defaultProfileId: null };
  const profiles = normalizeAiProfiles(ai.profiles, profileFallback);
  const defaultProfileId =
    typeof ai.defaultProfileId === 'string' && profiles.some((profile) => profile.id === ai.defaultProfileId)
      ? ai.defaultProfileId
      : null;

  return {
    general: {
      autosaveEnabled: booleanOrDefault(general.autosaveEnabled, defaults.general.autosaveEnabled),
      autosaveIntervalMs: AUTOSAVE_INTERVALS.has(autosaveIntervalMs)
        ? autosaveIntervalMs
        : defaults.general.autosaveIntervalMs,
      reopenLastProject: booleanOrDefault(general.reopenLastProject, defaults.general.reopenLastProject),
      showContextualTaskBarOnStartup: booleanOrDefault(
        general.showContextualTaskBarOnStartup,
        defaults.general.showContextualTaskBarOnStartup,
      ),
    },
    ai: {
      ...normalizedAiBase,
      profiles,
      defaultProfileId,
    },
    workspace: {
      defaultCanvasWidth: clampInt(
        workspace.defaultCanvasWidth,
        defaults.workspace.defaultCanvasWidth,
        1,
        8192,
      ),
      defaultCanvasHeight: clampInt(
        workspace.defaultCanvasHeight,
        defaults.workspace.defaultCanvasHeight,
        1,
        8192,
      ),
      defaultBackground:
        workspace.defaultBackground === 'white' || workspace.defaultBackground === 'transparent'
          ? workspace.defaultBackground
          : defaults.workspace.defaultBackground,
      showTransparencyChecker: booleanOrDefault(
        workspace.showTransparencyChecker,
        defaults.workspace.showTransparencyChecker,
      ),
      keepAiRunInputs: booleanOrDefault(workspace.keepAiRunInputs, defaults.workspace.keepAiRunInputs),
      keepAiUpscaleComposedResult: booleanOrDefault(
        workspace.keepAiUpscaleComposedResult,
        defaults.workspace.keepAiUpscaleComposedResult,
      ),
      keepAiDebugArtifacts: booleanOrDefault(
        workspace.keepAiDebugArtifacts ?? workspace.keepAntigravityDebugArtifacts,
        defaults.workspace.keepAiDebugArtifacts,
      ),
      layerAnnotationsExpanded: booleanOrDefault(
        workspace.layerAnnotationsExpanded,
        defaults.workspace.layerAnnotationsExpanded,
      ),
    },
  };
}

export function defaultAiRunOptions(): AiRunOptions {
  const ai = defaultSettings().ai;
  return {
    provider: ai.imageProvider,
    plannerMode: ai.plannerMode,
    plannerProvider: ai.plannerProvider,
    imageProvider: ai.imageProvider,
    codexBin: ai.codexBin,
    model: ai.model,
    reasoningEffort: ai.reasoningEffort,
    serviceTier: ai.serviceTier,
    imageQuality: ai.imageQuality,
    imageModeration: ai.imageModeration,
    autonomyLevel: ai.autonomyLevel,
    antigravityBin: ai.antigravityBin,
    antigravityModel: ai.antigravityModel,
    antigravityApprovalMode: ai.antigravityApprovalMode,
    antigravityImageModel: ai.antigravityImageModel,
    antigravityImageSize: ai.antigravityImageSize,
    antigravityPersonGeneration: ai.antigravityPersonGeneration,
    antigravityProminentPeople: ai.antigravityProminentPeople,
    antigravityCompressionQuality: ai.antigravityCompressionQuality,
    antigravityAdvancedOptionsJson: ai.antigravityAdvancedOptionsJson,
    antigravitySafetyFiltering: ai.antigravitySafetyFiltering,
    antigravitySafetyHarassment: ai.antigravitySafetyHarassment,
    antigravitySafetyHateSpeech: ai.antigravitySafetyHateSpeech,
    antigravitySafetySexuallyExplicit: ai.antigravitySafetySexuallyExplicit,
    antigravitySafetyDangerousContent: ai.antigravitySafetyDangerousContent,
    editChecksLevel: ai.editChecksLevel,
    fillAspectRatio: null,
  };
}

export function aiProviderDefaultsFromSettings(value: PaintNodeSettings): AiRunOptions {
  return {
    provider: value.ai.imageProvider,
    plannerMode: value.ai.plannerMode,
    plannerProvider: value.ai.plannerProvider,
    imageProvider: value.ai.imageProvider,
    codexBin: value.ai.codexBin,
    model: value.ai.model,
    reasoningEffort: value.ai.reasoningEffort,
    serviceTier: value.ai.serviceTier,
    imageQuality: value.ai.imageQuality,
    imageModeration: value.ai.imageModeration,
    autonomyLevel: value.ai.autonomyLevel,
    antigravityBin: value.ai.antigravityBin,
    antigravityModel: value.ai.antigravityModel,
    antigravityApprovalMode: value.ai.antigravityApprovalMode,
    antigravityImageModel: value.ai.antigravityImageModel,
    antigravityImageSize: value.ai.antigravityImageSize,
    antigravityPersonGeneration: value.ai.antigravityPersonGeneration,
    antigravityProminentPeople: value.ai.antigravityProminentPeople,
    antigravityCompressionQuality: value.ai.antigravityCompressionQuality,
    antigravityAdvancedOptionsJson: value.ai.antigravityAdvancedOptionsJson,
    antigravitySafetyFiltering: value.ai.antigravitySafetyFiltering,
    antigravitySafetyHarassment: value.ai.antigravitySafetyHarassment,
    antigravitySafetyHateSpeech: value.ai.antigravitySafetyHateSpeech,
    antigravitySafetySexuallyExplicit: value.ai.antigravitySafetySexuallyExplicit,
    antigravitySafetyDangerousContent: value.ai.antigravitySafetyDangerousContent,
    editChecksLevel: value.ai.editChecksLevel,
    fillAspectRatio: null,
  };
}

export function aiProfileOptionsFromRunOptions(options: AiRunOptions): AiProfileOptions {
  const {
    codexBin: _codexBin,
    antigravityBin: _antigravityBin,
    fillAspectRatio: _fillAspectRatio,
    ...profileOptions
  } = options;
  return profileOptions;
}

export function aiProfileRunOptionsFromSettings(value: PaintNodeSettings, profileId: string | null): AiRunOptions {
  const base = aiProviderDefaultsFromSettings(value);
  const profile = value.ai.profiles.find((item) => item.id === profileId);
  if (!profile) return base;
  return {
    ...base,
    ...profile.options,
    provider: profile.options.imageProvider,
    codexBin: value.ai.codexBin,
    antigravityBin: value.ai.antigravityBin,
    fillAspectRatio: null,
  };
}

export function aiRunOptionsFromSettings(value: PaintNodeSettings): AiRunOptions {
  return aiProfileRunOptionsFromSettings(value, value.ai.defaultProfileId);
}

export function cloneAiRunOptions(options: AiRunOptions): AiRunOptions {
  return {
    provider: options.imageProvider,
    plannerMode: options.plannerMode,
    plannerProvider: options.plannerProvider,
    imageProvider: options.imageProvider,
    codexBin: options.codexBin,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    serviceTier: options.serviceTier,
    imageQuality: options.imageQuality,
    imageModeration: options.imageModeration,
    autonomyLevel: options.autonomyLevel,
    antigravityBin: options.antigravityBin,
    antigravityModel: options.antigravityModel,
    antigravityApprovalMode: options.antigravityApprovalMode,
    antigravityImageModel: options.antigravityImageModel,
    antigravityImageSize: options.antigravityImageSize,
    antigravityPersonGeneration: options.antigravityPersonGeneration,
    antigravityProminentPeople: options.antigravityProminentPeople,
    antigravityCompressionQuality: options.antigravityCompressionQuality,
    antigravityAdvancedOptionsJson: options.antigravityAdvancedOptionsJson,
    antigravitySafetyFiltering: options.antigravitySafetyFiltering,
    antigravitySafetyHarassment: options.antigravitySafetyHarassment,
    antigravitySafetyHateSpeech: options.antigravitySafetyHateSpeech,
    antigravitySafetySexuallyExplicit: options.antigravitySafetySexuallyExplicit,
    antigravitySafetyDangerousContent: options.antigravitySafetyDangerousContent,
    editChecksLevel: options.editChecksLevel,
    fillAspectRatio: options.fillAspectRatio ?? null,
  };
}

export function parseSettingsJson(raw: string | null): PaintNodeSettings {
  if (!raw) return defaultSettings();
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}
