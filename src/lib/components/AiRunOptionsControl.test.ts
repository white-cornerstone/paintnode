import { describe, expect, it } from 'vitest';
import controlSource from './AiRunOptionsControl.svelte?raw';

describe('AI run options control', () => {
  it('offers the App Settings Grok Director overrides for an individual run', () => {
    expect(controlSource).toContain('Grok Director');
    expect(controlSource).toContain('GROK_REASONING_EFFORT_OPTIONS');
    expect(controlSource).toContain('setGrokModel(item.id)');
    expect(controlSource).toContain('setGrokReasoningEffort(item.id)');
  });

  it('offers the App Settings Grok image overrides for an individual run', () => {
    expect(controlSource).toContain('Grok Image');
    expect(controlSource).toContain('GROK_IMAGE_MODEL_OPTIONS');
    expect(controlSource).toContain('GROK_IMAGE_RESOLUTION_OPTIONS');
    expect(controlSource).toContain('setGrokImageModel(item.id)');
    expect(controlSource).toContain('setGrokImageResolution(item.id)');
  });

  it('opens the first relevant Grok setting after selecting Grok', () => {
    expect(controlSource).toContain("provider === 'grok'\n            ? 'grokModel'");
    expect(controlSource).toContain("provider === 'grok' ? 'grokImageModel'");
  });

  it('allows a caller to describe an off Director as manual authoring', () => {
    expect(controlSource).toContain("directorOffLabel = 'Skip'");
    expect(controlSource).toContain("directorOffSummary = 'Director: Off'");
    expect(controlSource).toContain('<span>{directorOffLabel}</span>');
    expect(controlSource).toContain('AI assist: ${directorName} on request');
    expect(controlSource).toContain('{directorSectionLabel}');
  });

  it('separates the Director selector from another role, not from its own advanced options', () => {
    expect(controlSource).toContain(
      '{#if showImage}<div class="separator" data-between="director-image"></div>{/if}',
    );
  });
});
