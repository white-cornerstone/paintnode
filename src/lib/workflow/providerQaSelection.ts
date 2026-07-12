export type WorkflowQaMode = 'provider-free' | 'provider-e2e' | null;

export interface WorkflowProviderSelection {
  ready: boolean;
  provider: string | null;
  supportedProviders: readonly string[];
  qaFake: boolean;
  label: string;
}

export function workflowProviderSelection(
  resolved: boolean,
  qaMode: WorkflowQaMode,
  defaultProvider: 'codex' | 'antigravity' | 'grok',
): WorkflowProviderSelection {
  if (!resolved) {
    return {
      ready: false,
      provider: null,
      supportedProviders: [],
      qaFake: false,
      label: 'Checking native QA mode…',
    };
  }
  if (qaMode === 'provider-free') {
    return {
      ready: true,
      provider: 'qa-fake',
      supportedProviders: ['qa-fake'],
      qaFake: true,
      label: 'QA Fake · deterministic provider-free output',
    };
  }
  return {
    ready: true,
    provider: defaultProvider,
    supportedProviders: ['codex', 'antigravity', 'grok'],
    qaFake: false,
    label: defaultProvider === 'codex'
      ? 'Codex'
      : defaultProvider === 'antigravity'
        ? 'Antigravity'
        : 'Grok',
  };
}
