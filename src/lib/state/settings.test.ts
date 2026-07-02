import { describe, expect, it } from 'vitest';
import { CODEX_MODEL_OPTIONS, defaultSettings, normalizeSettings, parseSettingsJson } from './settings';

describe('settings normalization', () => {
  it('uses GPT-5.5 as the default model', () => {
    expect(defaultSettings().ai.model).toBe('gpt-5.5');
  });

  it('keeps the model dropdown limited to supported image-capable models', () => {
    expect(CODEX_MODEL_OPTIONS.map((option) => option.label)).toEqual(['GPT-5.5', 'GPT-5.4', 'GPT-5.4-Mini']);
  });

  it('falls back to GPT-5.5 for unknown saved models', () => {
    expect(normalizeSettings({ ai: { model: 'gpt-5.3-codex-spark' } }).ai.model).toBe('gpt-5.5');
  });

  it('normalizes valid saved settings and clamps canvas dimensions', () => {
    const normalized = normalizeSettings({
      general: { autosaveEnabled: false, autosaveIntervalMs: 120_000 },
      ai: { provider: 'custom', model: 'gpt-5.4-mini', reasoningEffort: 'high', serviceTier: 'fast' },
      workspace: {
        defaultCanvasWidth: 20_000,
        defaultCanvasHeight: -5,
        defaultBackground: 'white',
        layerAnnotationsExpanded: false,
      },
    });

    expect(normalized.general.autosaveEnabled).toBe(false);
    expect(normalized.general.autosaveIntervalMs).toBe(120_000);
    expect(normalized.ai.provider).toBe('custom');
    expect(normalized.ai.model).toBe('gpt-5.4-mini');
    expect(normalized.ai.reasoningEffort).toBe('high');
    expect(normalized.ai.serviceTier).toBe('fast');
    expect(normalized.workspace.defaultCanvasWidth).toBe(8192);
    expect(normalized.workspace.defaultCanvasHeight).toBe(1);
    expect(normalized.workspace.defaultBackground).toBe('white');
    expect(normalized.workspace.layerAnnotationsExpanded).toBe(false);
  });

  it('defaults the annotation layer group to expanded for older settings', () => {
    expect(normalizeSettings({ workspace: {} }).workspace.layerAnnotationsExpanded).toBe(true);
  });

  it('recovers from malformed JSON', () => {
    expect(parseSettingsJson('{not json').ai.model).toBe('gpt-5.5');
  });
});
