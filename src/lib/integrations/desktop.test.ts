import { describe, expect, it } from 'vitest';
import { antigravityConfigFromRunOptions, claudeConfigFromRunOptions, codexConfigFromRunOptions } from './desktop';
import { defaultAiRunOptions } from '../state/settings';

describe('codexConfigFromRunOptions', () => {
  it('preserves selected image moderation for Codex image generation', () => {
    const options = {
      ...defaultAiRunOptions(),
      imageQuality: 'high' as const,
      imageModeration: 'low' as const,
    };

    const config = codexConfigFromRunOptions(options, '/tmp/project', 'fill-test', true);

    expect(config.imageQuality).toBe('high');
    expect(config.imageModeration).toBe('low');
  });

  it('only passes binary overrides when the custom executable route is selected', () => {
    const builtin = {
      ...defaultAiRunOptions(),
      codexBin: '/bin/codex',
      claudeBin: '/bin/claude',
      antigravityBin: '/bin/agy',
    };

    expect(codexConfigFromRunOptions(builtin).bin).toBe('');
    expect(claudeConfigFromRunOptions(builtin).bin).toBe('');
    expect(antigravityConfigFromRunOptions(builtin).bin).toBe('');

    const custom = {
      ...builtin,
      codexExecutableMode: 'custom' as const,
      claudeExecutableMode: 'custom' as const,
      antigravityExecutableMode: 'custom' as const,
    };

    expect(codexConfigFromRunOptions(custom).bin).toBe('/bin/codex');
    expect(claudeConfigFromRunOptions(custom).bin).toBe('/bin/claude');
    expect(antigravityConfigFromRunOptions(custom).bin).toBe('/bin/agy');
  });
});
