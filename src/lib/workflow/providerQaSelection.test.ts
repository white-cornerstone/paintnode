import { describe, expect, it } from 'vitest';
import { workflowProviderSelection } from './providerQaSelection';
import boardSource from '../components/WorkflowBoard.svelte?raw';

describe('workflow provider QA selection', () => {
  it('blocks execution until native QA mode resolution completes', () => {
    expect(workflowProviderSelection(false, null, 'codex')).toEqual({
      ready: false,
      provider: null,
      supportedProviders: [],
      qaFake: false,
      label: 'Checking native QA mode…',
    });
  });

  it('selects only truthful QA Fake execution in provider-free mode', () => {
    expect(workflowProviderSelection(true, 'provider-free', 'codex')).toEqual({
      ready: true,
      provider: 'qa-fake',
      supportedProviders: ['qa-fake'],
      qaFake: true,
      label: 'QA Fake · deterministic provider-free output',
    });
  });

  it.each([null, 'provider-e2e'] as const)('never exposes QA Fake in resolved mode %s', (mode) => {
    expect(workflowProviderSelection(true, mode, 'antigravity')).toEqual({
      ready: true,
      provider: 'antigravity',
      supportedProviders: ['codex', 'antigravity'],
      qaFake: false,
      label: 'Antigravity',
    });
  });

  it('keeps the visible Board path truthful and conditional on the resolved QA selection', () => {
    expect(boardSource).toContain("createProviderFreeQaWorkflowExecutor('provider-free', undefined, { scenario: qaScenario })");
    expect(boardSource).toContain('Deterministic provider-free output. No AI provider or authentication is used.');
    expect(boardSource).toContain('aria-label="QA Fake scenario"');
    expect(boardSource).toContain('<option value="slow-success">Slow / cancellable</option>');
    expect(boardSource).toContain('<option value="failure">Failure / retry</option>');
    expect(boardSource).toContain("providerSelection.qaFake ? 'Generate QA Fake' : 'Generate'");
    expect(boardSource).toMatch(/const executors = runSelection\.qaFake\s*\?/);
  });
});
