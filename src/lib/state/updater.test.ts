import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedRuntimeStatus } from '../ai/managedRuntime';

const installManagedRuntime = vi.hoisted(() => vi.fn());

vi.mock('../ai/managedRuntime', () => ({
  getManagedRuntimeStatus: vi.fn(),
  installManagedRuntime,
  onManagedRuntimeProgress: vi.fn(),
  runtimeProgressPercent: vi.fn(() => null),
}));

import { AppUpdaterStore, hasRuntimeCheckErrors } from './updater.svelte';

function runtimeStatus(
  provider: ManagedRuntimeStatus['provider'],
  state: ManagedRuntimeStatus['state'],
): ManagedRuntimeStatus {
  return {
    provider,
    state,
    installedVersion: '1.0.0',
    availableVersion: state === 'updateAvailable' ? '1.1.0' : '1.0.0',
    sdkVersion: '1.1.0',
    engineVersion: '1.1.0',
    downloadSize: null,
    authenticated: true,
    message: null,
  };
}

describe('managed runtime updater errors', () => {
  beforeEach(() => {
    installManagedRuntime.mockReset();
  });

  it('returns the dialog to the current state after a successful runtime update clears its prior error', async () => {
    const updater = new AppUpdaterStore();
    updater.status = 'current';
    updater.runtimeStatuses = { codex: runtimeStatus('codex', 'updateAvailable') };
    updater.runtimeErrors = { codex: 'Previous Codex update check failed.' };
    installManagedRuntime.mockResolvedValue(runtimeStatus('codex', 'ready'));

    await updater.installAvailableUpdates();

    expect(updater.available).toBe(false);
    expect(updater.status).toBe('current');
    expect(updater.runtimeErrors).toEqual({});
    expect(Object.hasOwn(updater.runtimeErrors, 'codex')).toBe(false);
    expect(hasRuntimeCheckErrors(updater.runtimeErrors)).toBe(false);
  });

  it('clears only the installed provider error and preserves another provider failure', async () => {
    const updater = new AppUpdaterStore();
    updater.status = 'current';
    updater.runtimeStatuses = {
      codex: runtimeStatus('codex', 'updateAvailable'),
      claude: runtimeStatus('claude', 'ready'),
    };
    updater.runtimeErrors = {
      codex: 'Previous Codex update check failed.',
      claude: 'Claude update service is unavailable.',
    };
    installManagedRuntime.mockResolvedValue(runtimeStatus('codex', 'ready'));

    await updater.installAvailableUpdates();

    expect(updater.runtimeErrors).toEqual({ claude: 'Claude update service is unavailable.' });
    expect(hasRuntimeCheckErrors(updater.runtimeErrors)).toBe(true);
  });

  it('ignores missing and blank error values in the dialog predicate', () => {
    expect(hasRuntimeCheckErrors({ codex: undefined, claude: '  ' })).toBe(false);
    expect(hasRuntimeCheckErrors({ codex: undefined, claude: 'Network error' })).toBe(true);
  });
});
