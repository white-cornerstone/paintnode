import type {
  AiDirectorInvolvement,
  AiDirectorMode,
  AiDirectorProvider,
  AiProvider,
  AiRunOptions,
} from '../state/settings';
import type { WorkflowNodeType, WorkflowNodeV2 } from './schema';

export const WORKFLOW_AI_CONFIG_VERSION = 1 as const;

export type WorkflowAiScalar = string | number | boolean | null;

export interface WorkflowAiRoleSelection {
  provider: string;
  model: string | null;
  options: Record<string, WorkflowAiScalar>;
}

export interface WorkflowAiDirectorSelection extends WorkflowAiRoleSelection {
  provider: AiDirectorProvider;
  mode: AiDirectorMode;
  involvement: AiDirectorInvolvement;
}

export interface WorkflowAiImageSelection extends WorkflowAiRoleSelection {
  provider: AiProvider;
}

export interface WorkflowAiDefaultsV1 {
  version: typeof WORKFLOW_AI_CONFIG_VERSION;
  director: WorkflowAiDirectorSelection;
  image: WorkflowAiImageSelection;
}

export interface WorkflowNodeAiOverridesV1 {
  version: typeof WORKFLOW_AI_CONFIG_VERSION;
  director?: WorkflowAiDirectorSelection;
  image?: WorkflowAiImageSelection;
}

export interface WorkflowNodeAiCapabilities {
  director: 'none' | 'required' | 'optional';
  image: 'none' | 'generate' | 'edit';
}

const DIRECTOR_PROVIDERS = new Set<AiDirectorProvider>(['codex', 'antigravity', 'claude', 'grok']);
const IMAGE_PROVIDERS = new Set<AiProvider>(['codex', 'antigravity', 'grok']);
const DIRECTOR_MODES = new Set<AiDirectorMode>(['auto', 'skip', 'force']);
const DIRECTOR_INVOLVEMENT = new Set<AiDirectorInvolvement>(['planOnly', 'ensureCompletion', 'fullReview']);

const SAFE_OPTION_KEYS = new Set([
  'reasoningEffort', 'serviceTier', 'imageQuality', 'imageModeration', 'autonomyLevel',
  'editChecksLevel', 'approvalMode', 'agentModel', 'imageSize', 'personGeneration',
  'prominentPeople', 'compressionQuality', 'safetyFiltering', 'safetyHarassment',
  'safetyHateSpeech', 'safetySexuallyExplicit', 'safetyDangerousContent',
  'claudeEffort', 'grokReasoningEffort', 'imageResolution',
]);

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeIdentifier(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 200 || /[\r\n\0]/.test(value)) return null;
  if (/^\s*(?:\/|~|[A-Za-z]:\\|file:)/i.test(value) || value.includes('..')) return null;
  if (/(?:^|[^A-Za-z])(bearer|access[_-]?token|api[_-]?key|authorization|cookie|secret)(?:[^A-Za-z]|$)/i.test(value)) return null;
  return value;
}

export function sanitizeWorkflowAiOptions(value: unknown): Record<string, WorkflowAiScalar> {
  const result: Record<string, WorkflowAiScalar> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (!SAFE_OPTION_KEYS.has(key)) continue;
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      result[key] = item;
    } else if (typeof item === 'string') {
      const safe = safeIdentifier(item);
      if (safe !== null) result[key] = safe;
    }
  }
  return result;
}

function directorModel(options: AiRunOptions, provider: AiDirectorProvider): string | null {
  if (provider === 'claude') return safeIdentifier(options.claudeModel);
  if (provider === 'antigravity') return safeIdentifier(options.antigravityModel);
  if (provider === 'grok') return safeIdentifier(options.grokModel);
  return safeIdentifier(options.model);
}

function imageModel(options: AiRunOptions, provider: AiProvider): string | null {
  if (provider === 'antigravity') return safeIdentifier(options.antigravityImageModel);
  if (provider === 'grok') return safeIdentifier(options.grokImageModel);
  return null;
}

export function workflowAiDefaultsFromRunOptions(options: AiRunOptions): WorkflowAiDefaultsV1 {
  const directorProvider = options.directorProvider ?? options.plannerProvider ?? 'codex';
  const imageProvider = options.imageProvider ?? options.provider ?? 'codex';
  return {
    version: WORKFLOW_AI_CONFIG_VERSION,
    director: {
      provider: directorProvider,
      mode: options.directorMode ?? options.plannerMode ?? 'auto',
      involvement: options.directorInvolvement ?? 'fullReview',
      model: directorModel(options, directorProvider),
      options: sanitizeWorkflowAiOptions({
        reasoningEffort: options.reasoningEffort,
        serviceTier: options.serviceTier,
        autonomyLevel: options.autonomyLevel,
        approvalMode: options.antigravityApprovalMode,
        claudeEffort: options.claudeEffort,
        grokReasoningEffort: options.grokReasoningEffort,
      }),
    },
    image: {
      provider: imageProvider,
      model: imageModel(options, imageProvider),
      options: sanitizeWorkflowAiOptions({
        imageQuality: options.imageQuality,
        imageModeration: options.imageModeration,
        imageSize: options.antigravityImageSize,
        personGeneration: options.antigravityPersonGeneration,
        prominentPeople: options.antigravityProminentPeople,
        compressionQuality: options.antigravityCompressionQuality,
        safetyFiltering: options.antigravitySafetyFiltering,
        safetyHarassment: options.antigravitySafetyHarassment,
        safetyHateSpeech: options.antigravitySafetyHateSpeech,
        safetySexuallyExplicit: options.antigravitySafetySexuallyExplicit,
        safetyDangerousContent: options.antigravitySafetyDangerousContent,
        imageResolution: options.grokImageResolution,
        editChecksLevel: options.editChecksLevel,
      }),
    },
  };
}

export function parseWorkflowAiDefaults(value: unknown): WorkflowAiDefaultsV1 | null {
  const source = record(value);
  if (source.version !== WORKFLOW_AI_CONFIG_VERSION) return null;
  const director = record(source.director);
  const image = record(source.image);
  if (!DIRECTOR_PROVIDERS.has(director.provider as AiDirectorProvider)
    || !IMAGE_PROVIDERS.has(image.provider as AiProvider)) return null;
  return {
    version: WORKFLOW_AI_CONFIG_VERSION,
    director: {
      provider: director.provider as AiDirectorProvider,
      mode: DIRECTOR_MODES.has(director.mode as AiDirectorMode) ? director.mode as AiDirectorMode : 'auto',
      involvement: DIRECTOR_INVOLVEMENT.has(director.involvement as AiDirectorInvolvement)
        ? director.involvement as AiDirectorInvolvement
        : 'fullReview',
      model: safeIdentifier(director.model),
      options: sanitizeWorkflowAiOptions(director.options),
    },
    image: {
      provider: image.provider as AiProvider,
      model: safeIdentifier(image.model),
      options: sanitizeWorkflowAiOptions(image.options),
    },
  };
}

/**
 * Returns a validated plain-data copy that is safe to persist or pass across an
 * IPC boundary. Svelte 5 deep state values are Proxies, which structuredClone
 * cannot clone in browsers even though their contents are serializable.
 */
export function copyWorkflowAiDefaults(value: unknown): WorkflowAiDefaultsV1 {
  const parsed = parseWorkflowAiDefaults(value);
  if (!parsed) throw new Error('Workflow AI defaults are invalid.');
  return parsed;
}

export function parseWorkflowNodeAiOverrides(value: unknown): WorkflowNodeAiOverridesV1 | null {
  const source = record(value);
  if (source.version !== WORKFLOW_AI_CONFIG_VERSION) return null;
  const defaults = parseWorkflowAiDefaults({
    version: WORKFLOW_AI_CONFIG_VERSION,
    director: source.director,
    image: source.image,
  });
  const directorSource = record(source.director);
  const imageSource = record(source.image);
  const director = DIRECTOR_PROVIDERS.has(directorSource.provider as AiDirectorProvider)
    ? {
        provider: directorSource.provider as AiDirectorProvider,
        mode: DIRECTOR_MODES.has(directorSource.mode as AiDirectorMode) ? directorSource.mode as AiDirectorMode : 'auto',
        involvement: DIRECTOR_INVOLVEMENT.has(directorSource.involvement as AiDirectorInvolvement)
          ? directorSource.involvement as AiDirectorInvolvement : 'fullReview',
        model: safeIdentifier(directorSource.model),
        options: sanitizeWorkflowAiOptions(directorSource.options),
      }
    : undefined;
  const image = IMAGE_PROVIDERS.has(imageSource.provider as AiProvider)
    ? {
        provider: imageSource.provider as AiProvider,
        model: safeIdentifier(imageSource.model),
        options: sanitizeWorkflowAiOptions(imageSource.options),
      }
    : undefined;
  if (!director && !image && !defaults) return { version: WORKFLOW_AI_CONFIG_VERSION };
  return { version: WORKFLOW_AI_CONFIG_VERSION, ...(director ? { director } : {}), ...(image ? { image } : {}) };
}

export function copyWorkflowNodeAiOverrides(value: unknown): WorkflowNodeAiOverridesV1 {
  return parseWorkflowNodeAiOverrides(value) ?? { version: WORKFLOW_AI_CONFIG_VERSION };
}

export function workflowNodeAiCapabilities(type: WorkflowNodeType, config: Record<string, unknown>): WorkflowNodeAiCapabilities {
  if (type === 'brief' || type === 'art-direction') return { director: 'required', image: 'none' };
  if (type === 'extract-assets') return { director: 'optional', image: 'edit' };
  if (type === 'transform') {
    const capability = typeof config.capability === 'string' ? config.capability : 'generate';
    return { director: 'optional', image: capability === 'generate' ? 'generate' : 'edit' };
  }
  if (type === 'review' && config.mode === 'ai') return { director: 'required', image: 'none' };
  return { director: 'none', image: 'none' };
}

export function workflowNodeAiOverrides(node: Pick<WorkflowNodeV2, 'type' | 'config'>): WorkflowNodeAiOverridesV1 | null {
  const current = parseWorkflowNodeAiOverrides(node.config.ai);
  if (current) return current;
  if (node.type !== 'transform') return null;
  const advanced = record(node.config.advanced);
  if (!IMAGE_PROVIDERS.has(advanced.provider as AiProvider)) return null;
  return {
    version: WORKFLOW_AI_CONFIG_VERSION,
    image: {
      provider: advanced.provider as AiProvider,
      model: safeIdentifier(advanced.model),
      options: sanitizeWorkflowAiOptions(advanced.options),
    },
  };
}

const RUN_OPTION_KEYS: Record<string, keyof AiRunOptions> = {
  reasoningEffort: 'reasoningEffort',
  serviceTier: 'serviceTier',
  imageQuality: 'imageQuality',
  imageModeration: 'imageModeration',
  autonomyLevel: 'autonomyLevel',
  editChecksLevel: 'editChecksLevel',
  approvalMode: 'antigravityApprovalMode',
  agentModel: 'antigravityModel',
  imageSize: 'antigravityImageSize',
  personGeneration: 'antigravityPersonGeneration',
  prominentPeople: 'antigravityProminentPeople',
  compressionQuality: 'antigravityCompressionQuality',
  safetyFiltering: 'antigravitySafetyFiltering',
  safetyHarassment: 'antigravitySafetyHarassment',
  safetyHateSpeech: 'antigravitySafetyHateSpeech',
  safetySexuallyExplicit: 'antigravitySafetySexuallyExplicit',
  safetyDangerousContent: 'antigravitySafetyDangerousContent',
  claudeEffort: 'claudeEffort',
  grokReasoningEffort: 'grokReasoningEffort',
  imageResolution: 'grokImageResolution',
};

export function resolveWorkflowNodeAiRunOptions(
  runtime: AiRunOptions,
  defaults: WorkflowAiDefaultsV1,
  node: Pick<WorkflowNodeV2, 'type' | 'config'>,
): AiRunOptions {
  const overrides = workflowNodeAiOverrides(node);
  const capabilities = workflowNodeAiCapabilities(node.type, node.config);
  const selectedDirector = overrides?.director ?? defaults.director;
  const director = capabilities.director === 'required' && selectedDirector.mode === 'skip'
    ? { ...selectedDirector, mode: 'auto' as const }
    : selectedDirector;
  const image = overrides?.image ?? defaults.image;
  const result: AiRunOptions = { ...runtime, provider: image.provider, imageProvider: image.provider };
  result.directorProvider = director.provider;
  result.directorMode = director.mode;
  result.directorInvolvement = director.involvement;
  if (director.provider === 'codex' && director.model) result.model = director.model;
  if (director.provider === 'claude' && director.model) result.claudeModel = director.model;
  if (director.provider === 'antigravity' && director.model) result.antigravityModel = director.model;
  if (director.provider === 'grok' && director.model) result.grokModel = director.model;
  if (image.provider === 'antigravity' && image.model) {
    result.antigravityImageModel = image.model as AiRunOptions['antigravityImageModel'];
  }
  if (image.provider === 'grok' && image.model) result.grokImageModel = image.model as AiRunOptions['grokImageModel'];
  for (const [key, value] of Object.entries({ ...director.options, ...image.options })) {
    const targetKey = RUN_OPTION_KEYS[key];
    if (targetKey) (result as unknown as Record<string, unknown>)[targetKey] = value;
  }
  return result;
}

export function workflowAiRoleSummary(
  defaults: WorkflowAiDefaultsV1,
  node: Pick<WorkflowNodeV2, 'type' | 'config'>,
): string | null {
  const capabilities = workflowNodeAiCapabilities(node.type, node.config);
  if (capabilities.director === 'none' && capabilities.image === 'none') return null;
  const overrides = workflowNodeAiOverrides(node);
  const selectedDirector = overrides?.director ?? defaults.director;
  const director = capabilities.director === 'required' && selectedDirector.mode === 'skip'
    ? { ...selectedDirector, mode: 'auto' as const }
    : selectedDirector;
  const image = overrides?.image ?? defaults.image;
  const inheritedDirector = !overrides?.director;
  const inheritedImage = !overrides?.image;
  const labels: string[] = [];
  if (capabilities.director !== 'none') {
    labels.push(`Director: ${director.mode === 'skip' ? 'Off' : director.provider}${inheritedDirector ? ' ↳' : ''}`);
  }
  if (capabilities.image !== 'none') labels.push(`Image: ${image.provider}${inheritedImage ? ' ↳' : ''}`);
  return labels.join(' · ');
}
