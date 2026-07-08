import { describe, expect, it } from 'vitest';
import {
  CODEX_MODEL_OPTIONS,
  ANTIGRAVITY_IMAGE_AGENT_MODEL_OPTIONS,
  ANTIGRAVITY_MODEL_OPTIONS,
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
      },
      workspace: {
        defaultCanvasWidth: 20_000,
        defaultCanvasHeight: -5,
        defaultBackground: 'white',
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
    expect(normalized.workspace.defaultCanvasWidth).toBe(8192);
    expect(normalized.workspace.defaultCanvasHeight).toBe(1);
    expect(normalized.workspace.defaultBackground).toBe('white');
    expect(normalized.workspace.layerAnnotationsExpanded).toBe(false);
  });

  it('defaults the annotation layer group to expanded for older settings', () => {
    expect(normalizeSettings({ workspace: {} }).workspace.layerAnnotationsExpanded).toBe(true);
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
    expect(defaults.ai.autonomyLevel).toBe('low');
    expect(defaults.ai.antigravityModel).toBe('auto');
    expect(defaults.ai.antigravityApprovalMode).toBe('skipPermissions');
    expect(ANTIGRAVITY_MODEL_OPTIONS.map((option) => option.id)).toContain('Gemini 3.5 Flash (High)');
  });

  it('keeps all Antigravity agent models available for image runs', () => {
    expect(ANTIGRAVITY_IMAGE_AGENT_MODEL_OPTIONS.map((option) => option.id)).toEqual(
      ANTIGRAVITY_MODEL_OPTIONS.map((option) => option.id),
    );
  });

  it('falls back to safe Antigravity defaults for unknown saved Antigravity settings', () => {
    const normalized = normalizeSettings({
      ai: {
        provider: 'antigravity',
        autonomyLevel: 'agentic',
        antigravityModel: 'antigravity-1-old',
        antigravityApprovalMode: 'wild',
      },
    });

    expect(normalized.ai.provider).toBe('antigravity');
    expect(normalized.ai.autonomyLevel).toBe('low');
    expect(normalized.ai.antigravityModel).toBe('auto');
    expect(normalized.ai.antigravityApprovalMode).toBe('skipPermissions');
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
    expect(normalized.ai.antigravityBin).toBe('/bin/gemini');
    expect(normalized.ai.antigravityModel).toBe('Gemini 3.5 Flash (Medium)');
    expect(normalized.ai.antigravityApprovalMode).toBe('default');
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
    expect(runOptions.fillAspectRatio).toBeNull();
    expect(value.ai.provider).toBe('antigravity');
  });
});
