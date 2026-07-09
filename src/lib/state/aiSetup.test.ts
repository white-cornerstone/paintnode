import { describe, expect, it } from 'vitest';
import { hasConfiguredAiCli, parseAiSetupSeen, shouldOfferAiSetup } from './aiSetup';
import { defaultSettings, normalizeSettings } from './settings';

describe('ai setup wizard gating', () => {
  it('treats fresh default settings as unconfigured', () => {
    expect(hasConfiguredAiCli(defaultSettings())).toBe(false);
  });

  it('treats supported saved CLI paths as configured', () => {
    expect(
      hasConfiguredAiCli(
        normalizeSettings({ ai: { codexExecutableMode: 'custom', codexBin: '/opt/homebrew/bin/codex' } }),
      ),
    ).toBe(true);
    expect(
      hasConfiguredAiCli(
        normalizeSettings({ ai: { antigravityExecutableMode: 'custom', antigravityBin: '~/.local/bin/agy' } }),
      ),
    ).toBe(true);
  });

  it('does not treat stored paths as configured while the built-in connector is selected', () => {
    expect(hasConfiguredAiCli(normalizeSettings({ ai: { codexBin: '/opt/homebrew/bin/codex' } }))).toBe(false);
    expect(hasConfiguredAiCli(normalizeSettings({ ai: { antigravityBin: '~/.local/bin/agy' } }))).toBe(false);
  });

  it('ignores whitespace-only CLI paths', () => {
    expect(hasConfiguredAiCli(normalizeSettings({ ai: { codexBin: '   ' } }))).toBe(false);
  });

  it('parses the stored seen flag', () => {
    expect(parseAiSetupSeen(null)).toBe(false);
    expect(parseAiSetupSeen('')).toBe(false);
    expect(parseAiSetupSeen('completed')).toBe(true);
    expect(parseAiSetupSeen('dismissed')).toBe(true);
  });

  it('offers the wizard only to first-time desktop users', () => {
    const fresh = defaultSettings();
    expect(shouldOfferAiSetup(fresh, null, true)).toBe(true);
    expect(shouldOfferAiSetup(fresh, 'dismissed', true)).toBe(false);
    expect(shouldOfferAiSetup(fresh, null, false)).toBe(false);
    expect(
      shouldOfferAiSetup(normalizeSettings({ ai: { codexExecutableMode: 'custom', codexBin: '/bin/codex' } }), null, true),
    ).toBe(false);
  });
});
