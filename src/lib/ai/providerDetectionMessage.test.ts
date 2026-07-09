import { describe, expect, it } from 'vitest';
import { providerDetectionSuccessMessage } from './providerDetectionMessage';

describe('provider detection success messages', () => {
  it.each([
    ['codex', 'codex-cli 0.144.0', 'the bundled SDK'],
    ['claude', 'Claude Agent SDK 0.3.205', 'the bundled Agent SDK'],
    ['antigravity', 'Antigravity 1.1.0', 'the local CLI'],
  ] as const)('uses the same version and connection format for %s', (provider, version, connection) => {
    expect(
      providerDetectionSuccessMessage(
        provider,
        { found: true, path: '/provider/bin', version, error: null },
        'builtin',
      ),
    ).toBe(`${version} is available through ${connection}.`);
  });

  it('shows the detected version and path for a custom executable', () => {
    expect(
      providerDetectionSuccessMessage(
        'claude',
        { found: true, path: '/opt/claude', version: 'Claude Code 2.1.0', error: null },
        'custom',
      ),
    ).toBe('Claude Code 2.1.0 is available at /opt/claude.');
  });
});
