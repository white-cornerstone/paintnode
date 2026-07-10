import { describe, expect, it } from 'vitest';
import { managedRuntimeCompletionMessage, managedRuntimeLabel } from './managedRuntimeOperationMessages';

describe('managed runtime operation presentation', () => {
  it('uses the provider name in background-install messages', () => {
    expect(managedRuntimeLabel('codex')).toBe('Codex');
    expect(managedRuntimeLabel('claude')).toBe('Claude');
    expect(managedRuntimeCompletionMessage('codex')).toBe('Codex support is installed and ready to sign in.');
  });
});
