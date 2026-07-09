import {
  discoverAntigravityCapabilities,
  discoverClaudeCapabilities,
  discoverCodexCapabilities,
  isDesktop,
  type AiProviderCapabilitiesResult,
  type AiModelCapability,
  type AiReasoningCapability,
} from '../integrations/desktop';
import {
  ANTIGRAVITY_MODEL_OPTIONS,
  CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  type ClaudeEffort,
  type ReasoningEffort,
} from '../state/settings';

const fallbackEfforts: AiReasoningCapability[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
];

export const FALLBACK_CODEX_CAPABILITIES: AiProviderCapabilitiesResult = {
  models: CODEX_MODEL_OPTIONS.map((model, index) => ({
    id: model.id,
    label: model.label,
    description: null,
    supportedReasoningEfforts: fallbackEfforts,
    defaultReasoningEffort: 'medium',
    isDefault: index === 0,
  })),
  source: 'fallback',
  warning: null,
  features: {
    transport: 'sdk',
    sessionReuse: true,
    structuredOutput: true,
    appMediatedUserInput: true,
    autonomousSubagents: true,
    managedSubagents: false,
    structuredProgress: true,
  },
};

const fallbackClaudeEfforts: AiReasoningCapability[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
];

export const FALLBACK_CLAUDE_CAPABILITIES: AiProviderCapabilitiesResult = {
  models: CLAUDE_MODEL_OPTIONS.map((model, index) => ({
    id: model.id,
    label: model.label,
    description: null,
    supportedReasoningEfforts: fallbackClaudeEfforts,
    defaultReasoningEffort: 'auto',
    isDefault: index === 0,
  })),
  source: 'fallback',
  warning: null,
  features: {
    transport: 'sdk',
    sessionReuse: true,
    structuredOutput: true,
    appMediatedUserInput: true,
    autonomousSubagents: true,
    managedSubagents: true,
    structuredProgress: true,
  },
};

export const FALLBACK_ANTIGRAVITY_CAPABILITIES: AiProviderCapabilitiesResult = {
  models: ANTIGRAVITY_MODEL_OPTIONS.map((model, index) => ({
    id: model.id,
    label: model.label,
    description: null,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: null,
    isDefault: index === 0,
  })),
  source: 'fallback',
  warning: null,
  features: {
    transport: 'cli',
    sessionReuse: true,
    structuredOutput: false,
    appMediatedUserInput: true,
    autonomousSubagents: true,
    managedSubagents: false,
    structuredProgress: false,
  },
};

const cache = new Map<string, Promise<AiProviderCapabilitiesResult>>();

export function loadCodexCapabilities(bin = '', refresh = false): Promise<AiProviderCapabilitiesResult> {
  if (!isDesktop()) return Promise.resolve(FALLBACK_CODEX_CAPABILITIES);
  const key = bin.trim();
  if (refresh) cache.delete(key);
  const existing = cache.get(key);
  if (existing) return existing;
  const request = discoverCodexCapabilities(key).catch(() => FALLBACK_CODEX_CAPABILITIES);
  cache.set(key, request);
  return request;
}

function loadCapabilities(
  provider: 'claude' | 'antigravity',
  bin: string,
  refresh: boolean,
): Promise<AiProviderCapabilitiesResult> {
  const fallback = provider === 'claude' ? FALLBACK_CLAUDE_CAPABILITIES : FALLBACK_ANTIGRAVITY_CAPABILITIES;
  if (!isDesktop()) return Promise.resolve(fallback);
  const key = `${provider}:${bin.trim()}`;
  if (refresh) cache.delete(key);
  const existing = cache.get(key);
  if (existing) return existing;
  const request = (provider === 'claude' ? discoverClaudeCapabilities(bin) : discoverAntigravityCapabilities(bin)).catch(
    () => fallback,
  );
  cache.set(key, request);
  return request;
}

export function loadClaudeCapabilities(bin = '', refresh = false): Promise<AiProviderCapabilitiesResult> {
  return loadCapabilities('claude', bin, refresh);
}

export function loadAntigravityCapabilities(bin = '', refresh = false): Promise<AiProviderCapabilitiesResult> {
  return loadCapabilities('antigravity', bin, refresh);
}

export function providerModelOptions(
  capabilities: AiProviderCapabilitiesResult,
  selectedModel: string,
): AiModelCapability[] {
  if (capabilities.models.some((model) => model.id === selectedModel)) return capabilities.models;
  return [
    ...capabilities.models,
    {
      id: selectedModel,
      label: selectedModel,
      description: 'Previously selected model',
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      isDefault: false,
    },
  ];
}

export function codexModelOptions(
  capabilities: AiProviderCapabilitiesResult,
  selectedModel: string,
): AiModelCapability[] {
  if (capabilities.models.some((model) => model.id === selectedModel)) return capabilities.models;
  return [
    ...capabilities.models,
    {
      id: selectedModel,
      label: selectedModel,
      description: 'Previously selected model',
      supportedReasoningEfforts: fallbackEfforts,
      defaultReasoningEffort: null,
      isDefault: false,
    },
  ];
}

export function claudeReasoningOptions(
  capabilities: AiProviderCapabilitiesResult,
  selectedModel: string,
  selectedEffort: ClaudeEffort,
): AiReasoningCapability[] {
  const capability = capabilities.models.find((model) => model.id === selectedModel);
  if (!capability || capabilities.source === 'fallback') {
    return providerReasoningOptions(capabilities, selectedModel, selectedEffort, fallbackClaudeEfforts);
  }
  const options = [{ value: 'auto', label: 'Auto' }, ...capability.supportedReasoningEfforts];
  if (options.some((effort) => effort.value === selectedEffort)) return options;
  return options;
}

function providerReasoningOptions(
  capabilities: AiProviderCapabilitiesResult,
  selectedModel: string,
  selectedEffort: string,
  fallback: AiReasoningCapability[],
): AiReasoningCapability[] {
  const advertised = capabilities.models.find((model) => model.id === selectedModel)?.supportedReasoningEfforts;
  const options = advertised?.length ? advertised : fallback;
  if (options.some((effort) => effort.value === selectedEffort)) return options;
  return [...options, { value: selectedEffort, label: reasoningEffortLabel(selectedEffort) }];
}

export function codexReasoningOptions(
  capabilities: AiProviderCapabilitiesResult,
  selectedModel: string,
  selectedEffort: ReasoningEffort,
): AiReasoningCapability[] {
  return providerReasoningOptions(capabilities, selectedModel, selectedEffort, fallbackEfforts);
}

export function codexEffortForModel(
  capabilities: AiProviderCapabilitiesResult,
  model: string,
  current: ReasoningEffort,
): ReasoningEffort {
  const capability = capabilities.models.find((item) => item.id === model);
  if (!capability || capability.supportedReasoningEfforts.some((effort) => effort.value === current)) {
    return current;
  }
  return (capability.defaultReasoningEffort ?? capability.supportedReasoningEfforts[0]?.value ?? current) as ReasoningEffort;
}

export function claudeEffortForModel(
  capabilities: AiProviderCapabilitiesResult,
  model: string,
  current: ClaudeEffort,
): ClaudeEffort {
  const capability = capabilities.models.find((item) => item.id === model);
  if (current === 'auto' || !capability) return current;
  if (capability.supportedReasoningEfforts.some((effort) => effort.value === current)) return current;
  return 'auto';
}

function reasoningEffortLabel(value: string): string {
  if (value === 'xhigh') return 'Extra High';
  return value.charAt(0).toUpperCase() + value.slice(1);
}
