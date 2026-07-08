import { describe, expect, it } from 'vitest';
import { codexConfigFromRunOptions } from './desktop';
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
});
