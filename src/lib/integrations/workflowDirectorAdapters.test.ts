import { describe, expect, it, vi } from 'vitest';
import { defaultAiRunOptions } from '../state/settings';
import { buildWorkflowDirectorContext, createWorkflowDirectorProposal } from '../workflow';
import {
  createConfiguredWorkflowDirector,
  createProviderFreeWorkflowDirector,
  type InvokeWorkflowDirector,
} from './workflowDirectorAdapters';

const context = buildWorkflowDirectorContext({
  brief: 'Create a coordinated campaign.',
  assets: [{ id: 'product', name: 'Product.png', kind: 'imported', mime: 'image/png', width: 1000, height: 1000, exists: true }],
  requestedOutputs: [
    { id: 'square', name: 'Square 1:1', width: 1024, height: 1024 },
    { id: 'portrait', name: 'Portrait 4:5', width: 1024, height: 1280 },
  ],
  capabilities: [{ id: 'generate', available: true, reason: null }],
});

describe('workflow Director adapters', () => {
  it.each(['codex', 'claude', 'antigravity'] as const)('invokes exactly the configured %s Director without discovery or image options', async (provider) => {
    const invoke = vi.fn<InvokeWorkflowDirector>().mockResolvedValue({ version: 1 });
    const runOptions = {
      ...defaultAiRunOptions(),
      directorProvider: provider,
      codexExecutableMode: 'custom' as const,
      codexBin: '/safe/codex',
      claudeExecutableMode: 'custom' as const,
      claudeBin: '/safe/claude',
      antigravityExecutableMode: 'custom' as const,
      antigravityBin: '/safe/agy',
    };
    const director = createConfiguredWorkflowDirector(runOptions, invoke, () => 'director-run-fixed');

    await director.draft(context);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({
      provider,
      context,
      runId: 'director-run-fixed',
      codexBin: provider === 'codex' ? '/safe/codex' : null,
      claudeBin: provider === 'claude' ? '/safe/claude' : null,
      antigravityBin: provider === 'antigravity' ? '/safe/agy' : null,
    }));
    const payload = invoke.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual([
      'antigravityApprovalMode', 'antigravityBin', 'antigravityModel',
      'claudeBin', 'claudeEffort', 'claudeModel',
      'codexBin', 'codexModel', 'codexReasoningEffort', 'codexServiceTier',
      'context', 'provider', 'runId',
    ].sort());
  });

  it('returns a deterministic provider-free proposal through the same strict validation path', async () => {
    const director = createProviderFreeWorkflowDirector();
    const first = await director.draft(context);
    const second = await director.draft(context);
    expect(first).toEqual(second);
    const result = createWorkflowDirectorProposal(first, context, { graphId: 'qa-fake-director' });
    expect(result.schemaIssues).toEqual([]);
    expect(result.proposal?.canAccept).toBe(true);
    expect(result.proposal?.nodes.map((node) => node.type)).toEqual([
      'input', 'brief', 'art-direction', 'transform', 'output', 'output',
    ]);
    expect(result.proposal?.graph.nodes.find((node) => node.type === 'input')?.config.assetId).toBe('product');
  });
});
