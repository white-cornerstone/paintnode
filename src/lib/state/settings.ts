export const SETTINGS_STORAGE_KEY = 'paintnode.settings';
export const DEFAULT_CUSTOM_GENERATOR_ARGS = '{prompt}\n--output\n{output}';
export const DEFAULT_CUSTOM_FILL_ARGS = '-p\n{promptFile}';
export const DEFAULT_CUSTOM_RETOUCH_ARGS = '-p\n{promptFile}';
export const DEFAULT_CUSTOM_EXTRACT_ARGS = '-p\n{promptFile}';
export const DEFAULT_CUSTOM_WORKFLOW_ARGS = '-p\n{promptFile}';

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

// Antigravity image generation is a tool the selected agent can invoke. The
// agy model list therefore remains the agent model list for image runs.
export const ANTIGRAVITY_IMAGE_AGENT_MODEL_OPTIONS = ANTIGRAVITY_MODEL_OPTIONS;

export type CodexModelId = (typeof CODEX_MODEL_OPTIONS)[number]['id'];
export type AntigravityModelId = (typeof ANTIGRAVITY_MODEL_OPTIONS)[number]['id'];
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';
export type ServiceTier = 'default' | 'fast';
export type AntigravityApprovalMode = 'default' | 'skipPermissions';
export type AiAutonomyLevel = 'low' | 'guided' | 'open' | 'unmanaged';
export type AiProvider = 'codex' | 'antigravity' | 'custom';
export type CanvasBackground = 'white' | 'transparent';

export interface AiRunOptions {
  provider: AiProvider;
  codexBin: string;
  model: CodexModelId;
  reasoningEffort: ReasoningEffort;
  serviceTier: ServiceTier;
  autonomyLevel: AiAutonomyLevel;
  antigravityBin: string;
  antigravityModel: AntigravityModelId;
  antigravityApprovalMode: AntigravityApprovalMode;
  customBin: string;
}

export interface PaintNodeSettings {
  general: {
    autosaveEnabled: boolean;
    autosaveIntervalMs: number;
    reopenLastProject: boolean;
    showContextualTaskBarOnStartup: boolean;
  };
  ai: {
    provider: AiProvider;
    codexBin: string;
    model: CodexModelId;
    reasoningEffort: ReasoningEffort;
    serviceTier: ServiceTier;
    autonomyLevel: AiAutonomyLevel;
    antigravityBin: string;
    antigravityModel: AntigravityModelId;
    antigravityApprovalMode: AntigravityApprovalMode;
    customBin: string;
    customArgsText: string;
    customGenerateArgsText: string;
    customFillArgsText: string;
    customRetouchArgsText: string;
    customExtractArgsText: string;
    customWorkflowArgsText: string;
  };
  workspace: {
    defaultCanvasWidth: number;
    defaultCanvasHeight: number;
    defaultBackground: CanvasBackground;
    showTransparencyChecker: boolean;
    keepAiRunInputs: boolean;
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
const AUTOSAVE_INTERVALS = new Set<number>(AUTOSAVE_INTERVAL_OPTIONS.map((option) => option.value));
const REASONING_EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh']);
const AI_AUTONOMY_LEVELS = new Set<string>(['low', 'guided', 'open', 'unmanaged']);

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
      codexBin: '',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      serviceTier: 'default',
      autonomyLevel: 'low',
      antigravityBin: '',
      antigravityModel: 'auto',
      antigravityApprovalMode: 'skipPermissions',
      customBin: '',
      customArgsText: DEFAULT_CUSTOM_GENERATOR_ARGS,
      customGenerateArgsText: DEFAULT_CUSTOM_GENERATOR_ARGS,
      customFillArgsText: DEFAULT_CUSTOM_FILL_ARGS,
      customRetouchArgsText: DEFAULT_CUSTOM_RETOUCH_ARGS,
      customExtractArgsText: DEFAULT_CUSTOM_EXTRACT_ARGS,
      customWorkflowArgsText: DEFAULT_CUSTOM_WORKFLOW_ARGS,
    },
    workspace: {
      defaultCanvasWidth: 1280,
      defaultCanvasHeight: 800,
      defaultBackground: 'transparent',
      showTransparencyChecker: true,
      keepAiRunInputs: true,
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

export function normalizeSettings(raw: unknown): PaintNodeSettings {
  const defaults = defaultSettings();
  if (!isRecord(raw)) return defaults;

  const general = isRecord(raw.general) ? raw.general : {};
  const ai = isRecord(raw.ai) ? raw.ai : {};
  const workspace = isRecord(raw.workspace) ? raw.workspace : {};
  const autosaveIntervalMs = numberOrDefault(general.autosaveIntervalMs, defaults.general.autosaveIntervalMs);

  const savedProvider = String(ai.provider);
  const provider: AiProvider =
    savedProvider === 'custom' ? 'custom' : savedProvider === 'antigravity' || savedProvider === 'gemini' ? 'antigravity' : 'codex';
  // Codex CLI retired the "minimal" reasoning effort; map old saves to the closest level.
  const savedReasoningEffort = ai.reasoningEffort === 'minimal' ? 'low' : ai.reasoningEffort;
  const savedAntigravityBin = ai.antigravityBin ?? ai.geminiBin;
  const savedAntigravityModel = ai.antigravityModel ?? ai.geminiModel;
  const savedAntigravityApprovalMode = ai.antigravityApprovalMode ?? ai.geminiApprovalMode;

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
      provider,
      codexBin: stringOrDefault(ai.codexBin, defaults.ai.codexBin),
      model: MODEL_IDS.has(String(ai.model)) ? (ai.model as CodexModelId) : defaults.ai.model,
      reasoningEffort: REASONING_EFFORTS.has(String(savedReasoningEffort))
        ? (savedReasoningEffort as ReasoningEffort)
        : defaults.ai.reasoningEffort,
      serviceTier: ai.serviceTier === 'fast' ? 'fast' : 'default',
      autonomyLevel: AI_AUTONOMY_LEVELS.has(String(ai.autonomyLevel))
        ? (ai.autonomyLevel as AiAutonomyLevel)
        : defaults.ai.autonomyLevel,
      antigravityBin: stringOrDefault(savedAntigravityBin, defaults.ai.antigravityBin),
      antigravityModel: ANTIGRAVITY_MODEL_IDS.has(String(savedAntigravityModel))
        ? (savedAntigravityModel as AntigravityModelId)
        : defaults.ai.antigravityModel,
      antigravityApprovalMode:
        savedAntigravityApprovalMode === 'default' ? 'default' : defaults.ai.antigravityApprovalMode,
      customBin: stringOrDefault(ai.customBin, defaults.ai.customBin),
      customArgsText: stringOrDefault(ai.customArgsText, defaults.ai.customArgsText),
      customGenerateArgsText: stringOrDefault(
        ai.customGenerateArgsText ?? ai.customArgsText,
        defaults.ai.customGenerateArgsText,
      ),
      customFillArgsText: stringOrDefault(ai.customFillArgsText, defaults.ai.customFillArgsText),
      customRetouchArgsText: stringOrDefault(ai.customRetouchArgsText, defaults.ai.customRetouchArgsText),
      customExtractArgsText: stringOrDefault(ai.customExtractArgsText, defaults.ai.customExtractArgsText),
      customWorkflowArgsText: stringOrDefault(ai.customWorkflowArgsText, defaults.ai.customWorkflowArgsText),
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
    provider: ai.provider,
    codexBin: ai.codexBin,
    model: ai.model,
    reasoningEffort: ai.reasoningEffort,
    serviceTier: ai.serviceTier,
    autonomyLevel: ai.autonomyLevel,
    antigravityBin: ai.antigravityBin,
    antigravityModel: ai.antigravityModel,
    antigravityApprovalMode: ai.antigravityApprovalMode,
    customBin: ai.customBin,
  };
}

export function aiRunOptionsFromSettings(value: PaintNodeSettings): AiRunOptions {
  return {
    provider: value.ai.provider,
    codexBin: value.ai.codexBin,
    model: value.ai.model,
    reasoningEffort: value.ai.reasoningEffort,
    serviceTier: value.ai.serviceTier,
    autonomyLevel: value.ai.autonomyLevel,
    antigravityBin: value.ai.antigravityBin,
    antigravityModel: value.ai.antigravityModel,
    antigravityApprovalMode: value.ai.antigravityApprovalMode,
    customBin: value.ai.customBin,
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
