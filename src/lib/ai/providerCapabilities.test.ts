import { describe, expect, it } from 'vitest';
import {
  FALLBACK_CODEX_CAPABILITIES,
  FALLBACK_CLAUDE_CAPABILITIES,
  FALLBACK_ANTIGRAVITY_CAPABILITIES,
  claudeEffortForModel,
  claudeReasoningOptions,
  codexEffortForModel,
  codexModelOptions,
  codexReasoningOptions,
} from './providerCapabilities';
import type { AiProviderCapabilitiesResult } from '../integrations/desktop';

const discovered: AiProviderCapabilitiesResult = {
  source: 'appServer',
  warning: null,
  features: FALLBACK_CODEX_CAPABILITIES.features,
  models: [
    {
      id: 'vision-a',
      label: 'Vision A',
      description: null,
      supportedReasoningEfforts: [
        { value: 'medium', label: 'Balanced' },
        { value: 'high', label: 'Deep' },
      ],
      defaultReasoningEffort: 'high',
      isDefault: true,
    },
  ],
};

describe('Codex capabilities', () => {
  it('preserves the runtime model and reasoning order', () => {
    expect(codexModelOptions(discovered, 'vision-a').map((model) => model.id)).toEqual(['vision-a']);
    expect(codexReasoningOptions(discovered, 'vision-a', 'high').map((effort) => effort.value)).toEqual([
      'medium',
      'high',
    ]);
  });

  it('uses the model default when the current effort is unsupported', () => {
    expect(codexEffortForModel(discovered, 'vision-a', 'low')).toBe('high');
  });

  it('retains a saved model while only fallback capabilities are available', () => {
    expect(codexModelOptions(FALLBACK_CODEX_CAPABILITIES, 'future-image-model').at(-1)?.id).toBe(
      'future-image-model',
    );
  });

  it('provides Claude effort and Antigravity model fallbacks', () => {
    expect(claudeReasoningOptions(FALLBACK_CLAUDE_CAPABILITIES, 'opus', 'max').at(-1)?.value).toBe('max');
    expect(claudeEffortForModel(FALLBACK_CLAUDE_CAPABILITIES, 'opus', 'max')).toBe('max');
    expect(FALLBACK_ANTIGRAVITY_CAPABILITIES.models[0].id).toBe('auto');
    expect(FALLBACK_CLAUDE_CAPABILITIES.features.managedSubagents).toBe(true);
    expect(FALLBACK_ANTIGRAVITY_CAPABILITIES.features.transport).toBe('cli');
    expect(FALLBACK_ANTIGRAVITY_CAPABILITIES.features.structuredOutput).toBe(false);
  });

  it('shows only automatic effort when a discovered Claude model has no effort support', () => {
    const capabilities: AiProviderCapabilitiesResult = {
      source: 'agentSdk',
      warning: null,
      features: FALLBACK_CLAUDE_CAPABILITIES.features,
      models: [
        {
          id: 'haiku',
          label: 'Haiku',
          description: null,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: 'auto',
          isDefault: false,
        },
      ],
    };
    expect(claudeReasoningOptions(capabilities, 'haiku', 'high')).toEqual([{ value: 'auto', label: 'Auto' }]);
    expect(claudeEffortForModel(capabilities, 'haiku', 'high')).toBe('auto');
  });
});
