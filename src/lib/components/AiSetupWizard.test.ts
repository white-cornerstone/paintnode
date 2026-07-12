import { describe, expect, it } from 'vitest';
import wizardSource from './AiSetupWizard.svelte?raw';

describe('AI setup wizard provider coverage', () => {
  it('offers Grok as a first-class detected provider with image defaults', () => {
    expect(wizardSource).toContain("type WizardProvider = 'codex' | 'antigravity' | 'grok'");
    expect(wizardSource).toContain("id: 'grok'");
    expect(wizardSource).toContain("await detectGrok(bin)");
    expect(wizardSource).toContain("grokExecutableMode: 'custom'");
    expect(wizardSource).toContain('GROK_IMAGE_MODEL_OPTIONS');
    expect(wizardSource).toContain('GROK_IMAGE_RESOLUTION_OPTIONS');
  });
});
