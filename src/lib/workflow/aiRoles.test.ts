import { describe, expect, it } from 'vitest';
import { defaultAiRunOptions } from '../state/settings';
import {
  copyWorkflowAiDefaults,
  parseWorkflowAiDefaults,
  resolveWorkflowNodeAiRunOptions,
  sanitizeWorkflowAiOptions,
  workflowAiDefaultsFromRunOptions,
  workflowAiRoleSummary,
  workflowBriefAiAssistMode,
  workflowNodeAiCapabilities,
  workflowNodeAiOverrides,
} from './aiRoles';
import type { WorkflowNodeV2 } from './schema';

function node(type: WorkflowNodeV2['type'], config: Record<string, unknown>): WorkflowNodeV2 {
  return {
    id: 'node', type, title: 'Node', position: { x: 0, y: 0 }, size: { width: 100, height: 100 },
    color: '#000', ports: { inputs: [], outputs: [] }, config, runRecordIds: [],
  };
}

describe('workflow AI roles', () => {
  it('copies reactive proxy-shaped defaults into persistable plain data', () => {
    const defaults = workflowAiDefaultsFromRunOptions(defaultAiRunOptions());
    const proxied = new Proxy({
      ...defaults,
      director: new Proxy({
        ...defaults.director,
        options: new Proxy({ ...defaults.director.options }, {}),
      }, {}),
      image: new Proxy({
        ...defaults.image,
        options: new Proxy({ ...defaults.image.options }, {}),
      }, {}),
    }, {});

    expect(() => structuredClone(proxied)).toThrow();
    expect(copyWorkflowAiDefaults(proxied)).toEqual(defaults);
  });

  it('persists portable defaults without runtime paths or arbitrary advanced JSON', () => {
    const options = defaultAiRunOptions();
    options.directorProvider = 'claude';
    options.claudeModel = 'claude-opus';
    options.imageProvider = 'antigravity';
    options.provider = 'antigravity';
    options.antigravityImageModel = 'gemini-3.1-flash-image';
    options.codexBin = '/secret/codex';
    options.antigravityAdvancedOptionsJson = '{"api_key":"secret"}';
    const defaults = workflowAiDefaultsFromRunOptions(options);
    expect(defaults.director).toMatchObject({ provider: 'claude', model: 'claude-opus' });
    expect(defaults.image).toMatchObject({ provider: 'antigravity', model: 'gemini-3.1-flash-image' });
    expect(JSON.stringify(defaults)).not.toContain('/secret/codex');
    expect(JSON.stringify(defaults)).not.toContain('api_key');
  });

  it('sanitizes unknown, path-bearing, and secret-bearing options', () => {
    expect(sanitizeWorkflowAiOptions({
      reasoningEffort: 'high', unknown: 'value', agentModel: '/tmp/model', imageQuality: 'high',
      serviceTier: 'api_key=secret', editChecksLevel: 2,
    })).toEqual({ reasoningEffort: 'high', imageQuality: 'high', editChecksLevel: 2 });
  });

  it('resolves independent Director and Image overrides over workflow defaults', () => {
    const runtime = defaultAiRunOptions();
    const defaults = workflowAiDefaultsFromRunOptions(runtime);
    const configured = node('extract-assets', {
      ai: {
        version: 1,
        director: { provider: 'claude', mode: 'force', involvement: 'fullReview', model: 'claude-opus', options: { claudeEffort: 'high' } },
        image: { provider: 'antigravity', model: 'gemini-3.1-flash-image', options: { imageSize: '2K' } },
      },
    });
    const result = resolveWorkflowNodeAiRunOptions(runtime, defaults, configured);
    expect(result.directorProvider).toBe('claude');
    expect(result.claudeModel).toBe('claude-opus');
    expect(result.imageProvider).toBe('antigravity');
    expect(result.antigravityImageModel).toBe('gemini-3.1-flash-image');
    expect(result.antigravityImageSize).toBe('2K');
  });

  it('reads legacy Transform image overrides when config.ai is absent', () => {
    const configured = node('transform', {
      capability: 'generate',
      advanced: { provider: 'grok', model: 'grok-imagine-image', options: { imageResolution: '2k' } },
    });
    expect(workflowNodeAiOverrides(configured)?.image).toMatchObject({
      provider: 'grok', model: 'grok-imagine-image', options: { imageResolution: '2k' },
    });
  });

  it('maps roles by node capability', () => {
    expect(workflowNodeAiCapabilities('brief', {})).toEqual({ director: 'optional', image: 'none' });
    expect(workflowNodeAiCapabilities('extract-assets', {})).toEqual({ director: 'optional', image: 'edit' });
    expect(workflowNodeAiCapabilities('transform', { capability: 'generate' })).toEqual({ director: 'optional', image: 'generate' });
    expect(workflowNodeAiCapabilities('transform', { capability: 'relight' })).toEqual({ director: 'optional', image: 'edit' });
    expect(workflowNodeAiCapabilities('review', { mode: 'human' })).toEqual({ director: 'none', image: 'none' });
    expect(workflowNodeAiCapabilities('review', { mode: 'ai' })).toEqual({ director: 'required', image: 'none' });
  });

  it('treats legacy and new Brief nodes as manual until AI assistance is explicitly selected', () => {
    const defaults = workflowAiDefaultsFromRunOptions(defaultAiRunOptions());
    const legacyBrief = node('brief', { objective: 'Keep these exact words.' });
    const workflowDefaultBrief = node('brief', {
      aiAssistMode: 'workflow-default',
      objective: 'Use the workflow Director when requested.',
    });
    const configuredBrief = node('brief', {
      aiAssistMode: 'configured',
      objective: 'Use Claude when requested.',
      ai: {
        version: 1,
        director: {
          provider: 'claude', mode: 'auto', involvement: 'planOnly', model: null, options: {},
        },
      },
    });

    expect(workflowBriefAiAssistMode(legacyBrief)).toBe('manual');
    expect(workflowAiRoleSummary(defaults, legacyBrief)).toBe('Manual · text used verbatim');
    expect(workflowBriefAiAssistMode(workflowDefaultBrief)).toBe('workflow-default');
    expect(workflowAiRoleSummary(defaults, workflowDefaultBrief)).toContain('↳');
    expect(workflowBriefAiAssistMode(configuredBrief)).toBe('configured');
    expect(workflowAiRoleSummary(defaults, configuredBrief)).toContain('claude');
  });

  it('rejects malformed persisted workflow defaults', () => {
    expect(parseWorkflowAiDefaults({ version: 1, director: { provider: 'evil' }, image: { provider: 'codex' } })).toBeNull();
  });
});
