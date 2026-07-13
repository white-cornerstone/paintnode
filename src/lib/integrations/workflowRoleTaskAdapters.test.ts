import { describe, expect, it, vi } from 'vitest';
import { aiRunOptionsFromSettings, defaultSettings } from '../state/settings';
import { createWorkflowAssetExtractionManifest, planWorkflowAssetExtraction, workflowExtractionCapability } from './workflowExtractionAdapters';
import { reviewWorkflowCandidates, workflowAiReviewProvider } from './workflowReviewAdapters';

describe('workflow role task adapters', () => {
  it('gates only unsupported direct extraction and allows Director plus Grok', () => {
    expect(workflowExtractionCapability('grok', false)).toMatchObject({ supported: false });
    expect(workflowExtractionCapability('grok', true)).toEqual({ supported: true, reason: null });
    expect(workflowExtractionCapability('codex', false)).toEqual({ supported: true, reason: null });
  });

  it('sends a typed extraction plan to the selected Director and rejects malformed plans', async () => {
    const options = aiRunOptionsFromSettings(defaultSettings());
    options.directorProvider = 'claude';
    options.claudeModel = 'sonnet';
    const invokePlan = vi.fn(async () => ({
      version: 1,
      items: [{ id: 'product', name: 'Product', instruction: 'Isolate the complete product.' }],
      notes: 'One clear foreground asset.',
    }));
    const plan = await planWorkflowAssetExtraction(options, {
      sourcePng: new Uint8Array([137, 80, 78, 71]), guidance: 'Extract the product', mode: 'quality', maximumAssets: 8,
    }, { invokePlan, runId: () => 'plan-1' });
    expect(plan.items[0].name).toBe('Product');
    expect(invokePlan).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude', runId: 'plan-1', claudeModel: 'sonnet', codexModel: null,
      context: expect.objectContaining({ maximumAssets: 8, mode: 'quality' }),
    }));
    await expect(planWorkflowAssetExtraction(options, {
      sourcePng: new Uint8Array([1]), guidance: '', mode: 'fast', maximumAssets: 2,
    }, { invokePlan: async () => ({ version: 1, items: [], notes: '' }) })).rejects.toThrow(/invalid extraction plan/i);
  });

  it('requires extraction manifests to account for every planned item without duplicates', () => {
    const plan = {
      version: 1 as const,
      items: [
        { id: 'product', name: 'Product', instruction: 'Isolate product.' },
        { id: 'shadow', name: 'Shadow', instruction: 'Isolate shadow.' },
      ],
      notes: '',
    };
    const manifest = createWorkflowAssetExtractionManifest(plan, {
      outputs: [{ itemId: 'product', name: 'Product', assetId: 'asset-1', relativePath: 'generated/product.png' }],
      failedItemIds: ['shadow'],
      director: { provider: 'claude', model: 'sonnet' },
      image: { provider: 'grok', model: 'grok-imagine-image' },
      completedAt: 100,
    });
    expect(manifest).toMatchObject({
      version: 1, failures: [{ itemId: 'shadow', code: 'IMAGE_OPERATION_FAILED' }],
      roles: { director: { provider: 'claude' }, image: { provider: 'grok' } },
    });
    expect(() => createWorkflowAssetExtractionManifest(plan, {
      outputs: [], failedItemIds: ['product'], director: { provider: 'claude', model: null },
      image: { provider: 'grok', model: null }, completedAt: 100,
    })).toThrow(/every planned item/i);
  });

  it('routes candidate review through the selected Director and records portable provenance', async () => {
    const options = aiRunOptionsFromSettings(defaultSettings());
    options.directorProvider = 'grok';
    options.grokModel = 'grok-4';
    options.grokReasoningEffort = 'high';
    const invokeReview = vi.fn(async () => ({
      rankings: [{ candidateId: 'candidate-1', reason: 'Best hierarchy.' }],
      recommendedCandidateId: 'candidate-1',
    }));
    const result = await reviewWorkflowCandidates(options, {
      reviewNodeId: 'review-1', instructions: 'Prefer clarity',
      candidates: [{
        candidateId: 'candidate-1', candidateRunId: 'run-1', materialKey: `workflow-cache-v1:${'a'.repeat(64)}`,
        contentHash: `sha256:${'b'.repeat(64)}`, providerId: 'codex', model: null,
        previewPng: new Uint8Array([137, 80, 78, 71]),
      }],
    }, { invokeReview, runId: () => 'review-run-1' });
    expect(result.recommendedCandidateId).toBe('candidate-1');
    expect(invokeReview).toHaveBeenCalledWith(expect.objectContaining({ provider: 'grok', grokModel: 'grok-4' }));
    expect(workflowAiReviewProvider(options)).toEqual({
      id: 'grok', model: 'grok-4', effectiveOptions: { grokReasoningEffort: 'high' },
    });
  });
});
