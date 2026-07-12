import { describe, expect, it, vi } from 'vitest';
import { WorkflowStore } from '../state/workflow.svelte';
import { createProviderFreeWorkflowDirector } from '../integrations/workflowDirectorAdapters';
import { buildWorkflowDirectorContext, isCampaignRequirementsEquivalent } from './directorDraft';
import { instantiateWorkflowTemplate } from './templates';
import {
  acceptDirectorProposalPreview,
  rejectDirectorProposalPreview,
  requestDirectorProposalPreview,
  workflowDirectorRequestKey,
  workflowDirectorProviderSelection,
} from './directorProposalSession';

const campaignContext = buildWorkflowDirectorContext({
  brief: 'Build a coordinated launch campaign.',
  assets: [{
    id: 'product-asset',
    name: 'Bottle.png',
    kind: 'imported',
    mime: 'image/png',
    width: 1200,
    height: 1200,
    exists: true,
  }],
  requestedOutputs: [
    { id: 'square', name: 'Square 1:1', width: 1024, height: 1024 },
    { id: 'portrait', name: 'Portrait 4:5', width: 1024, height: 1280 },
    { id: 'landscape', name: 'Landscape 16:9', width: 1280, height: 720 },
  ],
  capabilities: [
    { id: 'generate', available: true, reason: null },
    { id: 'candidate-review', available: false, reason: 'Review execution is not available yet.' },
  ],
});

describe('Workflow Director proposal session', () => {
  it('previews and rejects without changing the workflow byte-for-byte', async () => {
    const store = new WorkflowStore();
    store.newFromTemplate('asset-composition', 'Untouched workflow');
    const before = JSON.stringify(store.serialize());

    const preview = await requestDirectorProposalPreview(
      createProviderFreeWorkflowDirector(),
      campaignContext,
      store,
      { graphId: 'qa-preview' },
    );

    expect(preview.result.proposal?.canAccept).toBe(true);
    expect(JSON.stringify(store.serialize())).toBe(before);
    expect(rejectDirectorProposalPreview(preview)).toBeNull();
    expect(JSON.stringify(store.serialize())).toBe(before);
  });

  it('accepts only the validated preview through the atomic store boundary', async () => {
    const store = new WorkflowStore();
    store.newFromTemplate('asset-composition');
    const preview = await requestDirectorProposalPreview(
      createProviderFreeWorkflowDirector(),
      campaignContext,
      store,
      { graphId: 'qa-accepted' },
    );

    acceptDirectorProposalPreview(preview, store);

    expect(store.graphSnapshot()).toEqual(preview.result.proposal?.graph);
    expect(store.rev).toBe(1);
    expect(store.dirty).toBe(true);
  });

  it('keeps malformed Director output out of the store', async () => {
    const store = new WorkflowStore();
    store.newFromTemplate('asset-composition');
    const before = JSON.stringify(store.serialize());
    const preview = await requestDirectorProposalPreview(
      { draft: vi.fn().mockResolvedValue({ version: 1, nodes: 'invalid' }) },
      campaignContext,
      store,
    );

    expect(preview.result.proposal).toBeNull();
    expect(preview.result.schemaIssues.length).toBeGreaterThan(0);
    expect(() => acceptDirectorProposalPreview(preview, store)).toThrow(/cannot be accepted/i);
    expect(JSON.stringify(store.serialize())).toBe(before);
  });

  it('rejects a preview after the captured graph becomes stale', async () => {
    const store = new WorkflowStore();
    store.newFromTemplate('asset-composition');
    const preview = await requestDirectorProposalPreview(
      createProviderFreeWorkflowDirector(),
      campaignContext,
      store,
    );
    store.setPrompt('Changed while reviewing the preview.');
    const before = JSON.stringify(store.serialize());

    expect(() => acceptDirectorProposalPreview(preview, store)).toThrow(/workflow changed/i);
    expect(JSON.stringify(store.serialize())).toBe(before);
  });

  it('makes the provider-free Campaign proposal semantically equivalent to Campaign Composer', async () => {
    const store = new WorkflowStore();
    store.newBoard();
    const preview = await requestDirectorProposalPreview(
      createProviderFreeWorkflowDirector(),
      campaignContext,
      store,
      { graphId: 'qa-campaign' },
    );

    expect(isCampaignRequirementsEquivalent(
      preview.result.proposal!.graph,
      instantiateWorkflowTemplate('campaign-composer', { graphId: 'supported-campaign' }),
    )).toEqual({ equivalent: true, differences: [] });
  });

  it.each([
    ['brief', {
      ...campaignContext,
      brief: 'A changed brief.',
    }, 'qa-fake'],
    ['outputs', {
      ...campaignContext,
      requestedOutputs: campaignContext.requestedOutputs.slice(0, 1),
    }, 'qa-fake'],
    ['asset metadata', {
      ...campaignContext,
      assets: [{
        id: 'new-product', name: 'New.png', kind: 'imported', mime: 'image/png',
        width: 1000, height: 1000, available: true,
      }],
    }, 'qa-fake'],
    ['capabilities', {
      ...campaignContext,
      capabilities: [{ id: 'generate', available: false, reason: 'Executor unavailable.' }],
    }, 'qa-fake'],
    ['provider', campaignContext, 'codex'],
  ])('rejects acceptance after the Director request %s changes', async (_change, currentContext, currentSource) => {
    const store = new WorkflowStore();
    store.newFromTemplate('asset-composition');
    const before = JSON.stringify(store.serialize());
    const preview = await requestDirectorProposalPreview(
      createProviderFreeWorkflowDirector(),
      campaignContext,
      store,
      { requestSource: 'qa-fake' },
    );

    expect(() => acceptDirectorProposalPreview(
      preview,
      store,
      workflowDirectorRequestKey(currentContext, currentSource),
    )).toThrow(/request changed/i);
    expect(JSON.stringify(store.serialize())).toBe(before);
  });
});

describe('Workflow Director provider selection', () => {
  it.each(['codex', 'claude', 'antigravity'] as const)('uses the configured %s Director on desktop', (provider) => {
    expect(workflowDirectorProviderSelection(true, null, true, provider)).toEqual({
      ready: true,
      provider,
      qaFake: false,
      label: provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'Antigravity',
      reason: null,
    });
  });

  it('reports configured providers unavailable outside the native app', () => {
    expect(workflowDirectorProviderSelection(true, null, false, 'codex')).toMatchObject({
      ready: false,
      provider: 'codex',
      qaFake: false,
      reason: expect.stringMatching(/desktop app/i),
    });
  });

  it('selects QA Fake without a configured provider when provider-free mode is active', () => {
    expect(workflowDirectorProviderSelection(true, 'provider-free', true, 'antigravity')).toMatchObject({
      ready: true,
      provider: 'qa-fake',
      qaFake: true,
      reason: null,
    });
  });
});
