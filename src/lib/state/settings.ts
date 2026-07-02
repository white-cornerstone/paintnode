export const SETTINGS_STORAGE_KEY = 'paintnode.settings';
export const DEFAULT_CUSTOM_GENERATOR_ARGS = '{prompt}\n--output\n{output}';

export const CODEX_MODEL_OPTIONS = [
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
] as const;

export type CodexModelId = (typeof CODEX_MODEL_OPTIONS)[number]['id'];
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ServiceTier = 'default' | 'fast';
export type AiProvider = 'codex' | 'custom';
export type CanvasBackground = 'white' | 'transparent';

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
    customBin: string;
    customArgsText: string;
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
const AUTOSAVE_INTERVALS = new Set<number>(AUTOSAVE_INTERVAL_OPTIONS.map((option) => option.value));
const REASONING_EFFORTS = new Set<string>(['minimal', 'low', 'medium', 'high', 'xhigh']);

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
      customBin: '',
      customArgsText: DEFAULT_CUSTOM_GENERATOR_ARGS,
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

function isRecord(value: unknown): value is Record<string, unknown> {
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
      provider: ai.provider === 'custom' ? 'custom' : 'codex',
      codexBin: stringOrDefault(ai.codexBin, defaults.ai.codexBin),
      model: MODEL_IDS.has(String(ai.model)) ? (ai.model as CodexModelId) : defaults.ai.model,
      reasoningEffort: REASONING_EFFORTS.has(String(ai.reasoningEffort))
        ? (ai.reasoningEffort as ReasoningEffort)
        : defaults.ai.reasoningEffort,
      serviceTier: ai.serviceTier === 'fast' ? 'fast' : 'default',
      customBin: stringOrDefault(ai.customBin, defaults.ai.customBin),
      customArgsText: stringOrDefault(ai.customArgsText, defaults.ai.customArgsText),
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

export function parseSettingsJson(raw: string | null): PaintNodeSettings {
  if (!raw) return defaultSettings();
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}
