import { describe, expect, it } from 'vitest';
import {
  CODEX_MODEL_OPTIONS,
  ANTIGRAVITY_IMAGE_MODEL_OPTIONS,
  ANTIGRAVITY_IMAGE_SIZE_OPTIONS,
  ANTIGRAVITY_MODEL_OPTIONS,
  ANTIGRAVITY_SAFETY_FILTERING_OPTIONS,
  ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS,
  aiProfileRunOptionsFromSettings,
  aiProviderDefaultsFromSettings,
  aiRunOptionsFromSettings,
  defaultSettings,
  normalizeSettings,
  parseSettingsJson,
} from './settings';

describe('settings normalization', () => {
  it('uses GPT-5.5 as the default model', () => {
    expect(defaultSettings().ai.model).toBe('gpt-5.5');
  });

  it('uses automatic Codex image settings by default', () => {
    expect(defaultSettings().ai.imageQuality).toBe('auto');
    expect(defaultSettings().ai.imageModeration).toBe('auto');
  });

  it('keeps the model dropdown limited to supported image-capable models', () => {
    expect(CODEX_MODEL_OPTIONS.map((option) => option.label)).toEqual(['GPT-5.5', 'GPT-5.4', 'GPT-5.4-Mini']);
  });

  it('falls back to GPT-5.5 for unknown saved models', () => {
    expect(normalizeSettings({ ai: { model: 'gpt-5.3-codex-spark' } }).ai.model).toBe('gpt-5.5');
  });

  it('migrates the retired minimal reasoning effort to low', () => {
    expect(normalizeSettings({ ai: { reasoningEffort: 'minimal' } }).ai.reasoningEffort).toBe('low');
  });

  it('falls back to the default reasoning effort for unknown saved values', () => {
    expect(normalizeSettings({ ai: { reasoningEffort: 'turbo' } }).ai.reasoningEffort).toBe('medium');
  });

  it('normalizes valid saved settings and clamps canvas dimensions', () => {
    const normalized = normalizeSettings({
      general: { autosaveEnabled: false, autosaveIntervalMs: 120_000 },
      ai: {
        provider: 'antigravity',
        autonomyLevel: 'unmanaged',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'high',
        serviceTier: 'fast',
        imageQuality: 'high',
        imageModeration: 'low',
        antigravityModel: 'Gemini 3.5 Flash (High)',
        antigravityApprovalMode: 'default',
        antigravityImageModel: 'auto',
        antigravityImageSize: '2K',
        antigravityPersonGeneration: 'ALLOW_NONE',
        antigravityProminentPeople: 'BLOCK_PROMINENT_PEOPLE',
        antigravityCompressionQuality: 88,
        antigravityAdvancedOptionsJson: '{"imageOutputOptions":{"mimeType":"IMAGE_JPEG"}}',
        antigravitySafetyFiltering: 'custom',
        antigravitySafetyHarassment: 'BLOCK_NONE',
        antigravitySafetyHateSpeech: 'BLOCK_ONLY_HIGH',
        antigravitySafetySexuallyExplicit: 'BLOCK_MEDIUM_AND_ABOVE',
        antigravitySafetyDangerousContent: 'BLOCK_LOW_AND_ABOVE',
      },
      workspace: {
        defaultCanvasWidth: 20_000,
        defaultCanvasHeight: -5,
        defaultBackground: 'white',
        keepAiUpscaleComposedResult: true,
        keepAiDebugArtifacts: true,
        layerAnnotationsExpanded: false,
      },
    });

    expect(normalized.general.autosaveEnabled).toBe(false);
    expect(normalized.general.autosaveIntervalMs).toBe(120_000);
    expect(normalized.ai.provider).toBe('antigravity');
    expect(normalized.ai.model).toBe('gpt-5.4-mini');
    expect(normalized.ai.reasoningEffort).toBe('high');
    expect(normalized.ai.serviceTier).toBe('fast');
    expect(normalized.ai.imageQuality).toBe('high');
    expect(normalized.ai.imageModeration).toBe('low');
    expect(normalized.ai.autonomyLevel).toBe('unmanaged');
    expect(normalized.ai.antigravityModel).toBe('Gemini 3.5 Flash (High)');
    expect(normalized.ai.antigravityApprovalMode).toBe('default');
    expect(normalized.ai.antigravityImageModel).toBe('auto');
    expect(normalized.ai.antigravityImageSize).toBe('2K');
    expect(normalized.ai.antigravityPersonGeneration).toBe('ALLOW_NONE');
    expect(normalized.ai.antigravityProminentPeople).toBe('BLOCK_PROMINENT_PEOPLE');
    expect(normalized.ai.antigravityCompressionQuality).toBe(88);
    expect(normalized.ai.antigravityAdvancedOptionsJson).toBe('{"imageOutputOptions":{"mimeType":"IMAGE_JPEG"}}');
    expect(normalized.ai.antigravitySafetyFiltering).toBe('custom');
    expect(normalized.ai.antigravitySafetyHarassment).toBe('BLOCK_NONE');
    expect(normalized.ai.antigravitySafetyHateSpeech).toBe('BLOCK_ONLY_HIGH');
    expect(normalized.ai.antigravitySafetySexuallyExplicit).toBe('BLOCK_MEDIUM_AND_ABOVE');
    expect(normalized.ai.antigravitySafetyDangerousContent).toBe('BLOCK_LOW_AND_ABOVE');
    expect(normalized.workspace.defaultCanvasWidth).toBe(8192);
    expect(normalized.workspace.defaultCanvasHeight).toBe(1);
    expect(normalized.workspace.defaultBackground).toBe('white');
    expect(normalized.workspace.keepAiUpscaleComposedResult).toBe(true);
    expect(normalized.workspace.keepAiDebugArtifacts).toBe(true);
    expect(normalized.workspace.layerAnnotationsExpanded).toBe(false);
  });

  it('defaults the annotation layer group to expanded for older settings', () => {
    expect(normalizeSettings({ workspace: {} }).workspace.layerAnnotationsExpanded).toBe(true);
  });

  it('does not keep composed AI upscale results by default', () => {
    expect(defaultSettings().workspace.keepAiUpscaleComposedResult).toBe(false);
    expect(normalizeSettings({ workspace: {} }).workspace.keepAiUpscaleComposedResult).toBe(false);
  });

  it('does not keep AI debug artifacts by default', () => {
    expect(defaultSettings().workspace.keepAiDebugArtifacts).toBe(false);
    expect(normalizeSettings({ workspace: {} }).workspace.keepAiDebugArtifacts).toBe(false);
  });

  it('accepts the older provider-specific debug artifact setting name', () => {
    expect(
      normalizeSettings({ workspace: { keepAntigravityDebugArtifacts: true } }).workspace.keepAiDebugArtifacts,
    ).toBe(true);
  });

  it('defaults and clamps the AI result-checks level', () => {
    // Older settings without the field keep the drift-gate-only behavior.
    expect(normalizeSettings({ ai: {} }).ai.editChecksLevel).toBe(1);
    expect(normalizeSettings({ ai: { editChecksLevel: 0 } }).ai.editChecksLevel).toBe(0);
    expect(normalizeSettings({ ai: { editChecksLevel: 3 } }).ai.editChecksLevel).toBe(3);
    expect(normalizeSettings({ ai: { editChecksLevel: 9 } }).ai.editChecksLevel).toBe(3);
    expect(normalizeSettings({ ai: { editChecksLevel: -2 } }).ai.editChecksLevel).toBe(0);
    expect(normalizeSettings({ ai: { editChecksLevel: 'strict' } }).ai.editChecksLevel).toBe(1);
  });

  it('recovers from malformed JSON', () => {
    expect(parseSettingsJson('{not json').ai.model).toBe('gpt-5.5');
  });

  it('keeps Codex as the default provider and exposes Antigravity model defaults', () => {
    const defaults = defaultSettings();
    expect(defaults.ai.provider).toBe('codex');
    expect(defaults.ai.plannerMode).toBe('auto');
    expect(defaults.ai.plannerProvider).toBe('codex');
    expect(defaults.ai.imageProvider).toBe('codex');
    expect(defaults.ai.autonomyLevel).toBe('low');
    expect(defaults.ai.antigravityModel).toBe('auto');
    expect(defaults.ai.antigravityApprovalMode).toBe('skipPermissions');
    expect(defaults.ai.antigravityImageModel).toBe('gemini-3.1-flash-image');
    expect(defaults.ai.antigravityImageSize).toBe('auto');
    expect(defaults.ai.antigravityPersonGeneration).toBe('auto');
    expect(defaults.ai.antigravityProminentPeople).toBe('auto');
    expect(defaults.ai.antigravityCompressionQuality).toBeNull();
    expect(defaults.ai.antigravityAdvancedOptionsJson).toBe('{}');
    expect(defaults.ai.antigravitySafetyFiltering).toBe('default');
    expect(defaults.ai.antigravitySafetyHarassment).toBe('HARM_BLOCK_THRESHOLD_UNSPECIFIED');
    expect(defaults.ai.antigravitySafetyHateSpeech).toBe('HARM_BLOCK_THRESHOLD_UNSPECIFIED');
    expect(defaults.ai.antigravitySafetySexuallyExplicit).toBe('HARM_BLOCK_THRESHOLD_UNSPECIFIED');
    expect(defaults.ai.antigravitySafetyDangerousContent).toBe('HARM_BLOCK_THRESHOLD_UNSPECIFIED');
    expect(defaults.ai.profiles).toEqual([]);
    expect(defaults.ai.defaultProfileId).toBeNull();
    expect(ANTIGRAVITY_MODEL_OPTIONS.map((option) => option.id)).toContain('Gemini 3.5 Flash (High)');
  });

  it('exposes direct Antigravity image controls separately from agent models', () => {
    expect(ANTIGRAVITY_IMAGE_MODEL_OPTIONS.map((option) => option.id)).toEqual([
      'gemini-3.1-flash-image',
      'auto',
    ]);
    expect(ANTIGRAVITY_IMAGE_SIZE_OPTIONS.map((option) => option.id)).toEqual(['auto', '1K', '2K', '4K']);
    expect(ANTIGRAVITY_SAFETY_FILTERING_OPTIONS.map((option) => option.id)).toEqual([
      'default',
      'lessRestrictive',
      'moreRestrictive',
      'custom',
    ]);
    expect(ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS.map((option) => option.id)).toEqual([
      'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
      'OFF',
      'BLOCK_NONE',
      'BLOCK_ONLY_HIGH',
      'BLOCK_MEDIUM_AND_ABOVE',
      'BLOCK_LOW_AND_ABOVE',
    ]);
  });

  it('falls back to safe Antigravity defaults for unknown saved Antigravity settings', () => {
    const normalized = normalizeSettings({
      ai: {
        provider: 'antigravity',
        autonomyLevel: 'agentic',
        antigravityModel: 'antigravity-1-old',
        antigravityApprovalMode: 'wild',
        antigravityImageModel: 'old-image-model',
        antigravityImageSize: '8K',
        antigravityPersonGeneration: 'BLOCK_ALL',
        antigravityProminentPeople: 'ALLOW_PROMINENT_PEOPLE',
        antigravityCompressionQuality: 140,
        antigravitySafetyFiltering: 'none',
        antigravitySafetyHarassment: 'ALLOW_ALL',
        antigravitySafetyHateSpeech: 'BLOCK_NONE',
        antigravitySafetySexuallyExplicit: 'BLOCK_MORE',
        antigravitySafetyDangerousContent: 'OFF',
      },
    });

    expect(normalized.ai.provider).toBe('antigravity');
    expect(normalized.ai.plannerMode).toBe('skip');
    expect(normalized.ai.plannerProvider).toBe('antigravity');
    expect(normalized.ai.imageProvider).toBe('antigravity');
    expect(normalized.ai.autonomyLevel).toBe('low');
    expect(normalized.ai.antigravityModel).toBe('auto');
    expect(normalized.ai.antigravityApprovalMode).toBe('skipPermissions');
    expect(normalized.ai.antigravityImageModel).toBe('gemini-3.1-flash-image');
    expect(normalized.ai.antigravityImageSize).toBe('auto');
    expect(normalized.ai.antigravityPersonGeneration).toBe('auto');
    expect(normalized.ai.antigravityProminentPeople).toBe('auto');
    expect(normalized.ai.antigravityCompressionQuality).toBe(100);
    expect(normalized.ai.antigravitySafetyFiltering).toBe('default');
    expect(normalized.ai.antigravitySafetyHarassment).toBe('HARM_BLOCK_THRESHOLD_UNSPECIFIED');
    expect(normalized.ai.antigravitySafetyHateSpeech).toBe('BLOCK_NONE');
    expect(normalized.ai.antigravitySafetySexuallyExplicit).toBe('HARM_BLOCK_THRESHOLD_UNSPECIFIED');
    expect(normalized.ai.antigravitySafetyDangerousContent).toBe('OFF');
  });

  it('falls back to safe Codex image-generation controls for unknown saved values', () => {
    const normalized = normalizeSettings({
      ai: {
        imageQuality: 'ultra',
        imageModeration: 'off',
      },
    });

    expect(normalized.ai.imageQuality).toBe('auto');
    expect(normalized.ai.imageModeration).toBe('auto');
  });

  it('migrates old Gemini provider settings to Antigravity settings', () => {
    const normalized = normalizeSettings({
      ai: {
        provider: 'gemini',
        geminiBin: '/bin/gemini',
        geminiModel: 'Gemini 3.5 Flash (Medium)',
        geminiApprovalMode: 'default',
      },
    });

    expect(normalized.ai.provider).toBe('antigravity');
    expect(normalized.ai.plannerMode).toBe('skip');
    expect(normalized.ai.imageProvider).toBe('antigravity');
    expect(normalized.ai.antigravityBin).toBe('/bin/gemini');
    expect(normalized.ai.antigravityModel).toBe('Gemini 3.5 Flash (Medium)');
    expect(normalized.ai.antigravityApprovalMode).toBe('default');
  });

  it('normalizes split planner and image providers independently', () => {
    const normalized = normalizeSettings({
      ai: {
        provider: 'codex',
        plannerMode: 'force',
        plannerProvider: 'codex',
        imageProvider: 'antigravity',
      },
    });

    expect(normalized.ai.provider).toBe('antigravity');
    expect(normalized.ai.plannerMode).toBe('force');
    expect(normalized.ai.plannerProvider).toBe('codex');
    expect(normalized.ai.imageProvider).toBe('antigravity');
    const runOptions = aiRunOptionsFromSettings(normalized);
    expect(runOptions.provider).toBe('antigravity');
    expect(runOptions.plannerProvider).toBe('codex');
    expect(runOptions.imageProvider).toBe('antigravity');
  });

  it('migrates retired custom provider settings back to Codex', () => {
    const normalized = normalizeSettings({
      ai: {
        provider: 'custom',
        profiles: [
          {
            id: 'old-custom',
            name: 'Old Custom',
            options: { provider: 'custom' },
          },
        ],
        defaultProfileId: 'old-custom',
      },
    });

    expect(normalized.ai.provider).toBe('codex');
    expect(normalized.ai.profiles[0].options.provider).toBe('codex');
    expect(aiRunOptionsFromSettings(normalized).provider).toBe('codex');
  });

  it('creates per-run AI options from settings without mutating defaults', () => {
    const value = normalizeSettings({
      ai: {
        provider: 'antigravity',
        autonomyLevel: 'guided',
        codexBin: '/bin/codex',
        antigravityBin: '/bin/agy',
        antigravityModel: 'Gemini 3.1 Pro (High)',
      },
    });

    const runOptions = aiRunOptionsFromSettings(value);
    runOptions.provider = 'codex';

    expect(runOptions.antigravityBin).toBe('/bin/agy');
    expect(runOptions.autonomyLevel).toBe('guided');
    expect(runOptions.imageQuality).toBe('auto');
    expect(runOptions.imageModeration).toBe('auto');
    expect(runOptions.antigravityImageModel).toBe('gemini-3.1-flash-image');
    expect(runOptions.antigravityImageSize).toBe('auto');
    expect(runOptions.antigravitySafetyFiltering).toBe('default');
    expect(runOptions.antigravitySafetyHarassment).toBe('HARM_BLOCK_THRESHOLD_UNSPECIFIED');
    expect(runOptions.fillAspectRatio).toBeNull();
    expect(value.ai.provider).toBe('antigravity');
  });

  it('normalizes saved AI profiles and applies the default profile to new run options', () => {
    const value = normalizeSettings({
      ai: {
        provider: 'codex',
        codexBin: '/new/codex',
        antigravityBin: '/new/agy',
        profiles: [
          {
            id: 'final-pass',
            name: ' Final pass ',
            options: {
              provider: 'antigravity',
              plannerMode: 'force',
              plannerProvider: 'codex',
              imageProvider: 'antigravity',
              model: 'gpt-5.4-mini',
              reasoningEffort: 'high',
              imageQuality: 'ultra',
              antigravityImageSize: '2K',
              antigravitySafetyFiltering: 'custom',
              antigravitySafetyHarassment: 'BLOCK_NONE',
            },
          },
        ],
        defaultProfileId: 'final-pass',
      },
    });

    const runOptions = aiRunOptionsFromSettings(value);

    expect(value.ai.profiles).toHaveLength(1);
    expect(value.ai.profiles[0].name).toBe('Final pass');
    expect(value.ai.defaultProfileId).toBe('final-pass');
    expect(runOptions.provider).toBe('antigravity');
    expect(runOptions.plannerMode).toBe('force');
    expect(runOptions.plannerProvider).toBe('codex');
    expect(runOptions.imageProvider).toBe('antigravity');
    expect(runOptions.antigravityImageSize).toBe('2K');
    expect(runOptions.antigravitySafetyFiltering).toBe('custom');
    expect(runOptions.antigravitySafetyHarassment).toBe('BLOCK_NONE');
    expect(runOptions.imageQuality).toBe('auto');
    expect(runOptions.codexBin).toBe('/new/codex');
    expect(runOptions.antigravityBin).toBe('/new/agy');
  });

  it('can fetch provider defaults separately from a selected default profile', () => {
    const value = normalizeSettings({
      ai: {
        provider: 'codex',
        profiles: [
          {
            id: 'draft',
            name: 'Draft',
            options: {
              provider: 'antigravity',
              antigravityImageSize: '1K',
            },
          },
        ],
        defaultProfileId: 'draft',
      },
    });

    expect(aiProviderDefaultsFromSettings(value).provider).toBe('codex');
    expect(aiProfileRunOptionsFromSettings(value, 'draft').provider).toBe('antigravity');
    expect(aiRunOptionsFromSettings(value).provider).toBe('antigravity');
  });
});
