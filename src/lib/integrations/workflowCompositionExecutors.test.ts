import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AntigravityGeneratorConfig, CodexGeneratorConfig } from './desktop';
import type { WorkflowTransformExecutionRequest } from '../workflow/transformExecutor';

const services = vi.hoisted(() => ({
  codex: vi.fn(),
  antigravity: vi.fn(),
}));

vi.mock('./desktop', () => ({
  composeCodexWorkflow: services.codex,
  composeAntigravityWorkflow: services.antigravity,
}));

import {
  createAntigravityWorkflowTransformExecutor,
  createCodexWorkflowTransformExecutor,
} from './workflowCompositionExecutors';

function request(advanced: Record<string, unknown>): WorkflowTransformExecutionRequest {
  return {
    workflowId: 'workflow-test',
    nodeId: 'transform-generate-square',
    capability: 'generate',
    provider: typeof advanced.provider === 'string' ? advanced.provider : 'codex',
    projectPath: '/virtual/project',
    brief: 'Launch campaign',
    artDirection: 'Keep the product left',
    transform: { capability: 'generate', instructions: 'Generate square', advanced },
    prompt: 'Use the storyboard as the primary spatial plan.',
    sources: [{
      nodeId: 'slot-product', portId: 'asset', name: 'Product', role: 'Hero product',
      assetId: 'product', relativePath: 'assets/product.png', bytes: new Uint8Array([1]),
    }],
    storyboard: {
      dataUrl: null,
      oraPath: 'storyboards/campaign.ora',
      width: 1440,
      height: 900,
      annotations: ['keep the product left'],
      annotationItems: [],
      annotationsVisible: true,
      placementConstraints: ['Use the storyboard as the primary spatial plan.'],
      source: { name: 'Storyboard sketch - mandatory layout guide', bytes: new Uint8Array([2]) },
    },
    output: { nodeId: 'output-square', title: 'Square 1:1', width: 1024, height: 1024 },
  };
}

const storedResult = {
  dataUrl: 'data:image/png;base64,AA==',
  asset: {
    id: 'result', kind: 'generated', name: 'result.png', relativePath: 'generated/result.png',
    createdAt: 1, width: 1024, height: 1024, mime: 'image/png', exists: true,
  },
};

describe('desktop workflow composition adapters', () => {
  beforeEach(() => {
    services.codex.mockReset().mockResolvedValue(storedResult);
    services.antigravity.mockReset().mockResolvedValue(storedResult);
  });

  it('uses persisted Codex model/options over global defaults without allowing boundary overrides', async () => {
    const config = {
      model: 'global-codex-model', reasoningEffort: 'low', serviceTier: 'default',
      projectPath: '/virtual/project',
    } satisfies CodexGeneratorConfig;
    const executor = createCodexWorkflowTransformExecutor(config);
    await executor.execute(request({
      provider: 'codex',
      model: 'saved-codex-model',
      options: {
        reasoningEffort: 'high', serviceTier: 'fast', imageQuality: 'high',
        projectPath: '/must-not-override-project', directorMode: 'force',
      },
    }));

    expect(services.codex).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'saved-codex-model', reasoningEffort: 'high', serviceTier: 'fast',
        imageQuality: 'high', projectPath: '/virtual/project', directorMode: 'skip',
      }),
      expect.any(String),
      [
        { name: 'Storyboard sketch - mandatory layout guide', bytes: new Uint8Array([2]) },
        { name: 'Product', bytes: new Uint8Array([1]) },
      ],
      expect.objectContaining({ width: 1024, height: 1024 }),
    );
  });

  it('forwards a persisted Antigravity image model/options and storyboard before visual inputs', async () => {
    const config = {
      model: 'global-agent-model', imageModel: 'auto', imageSize: 'auto',
      approvalMode: 'default', projectPath: '/virtual/project',
    } satisfies AntigravityGeneratorConfig;
    const executor = createAntigravityWorkflowTransformExecutor(config);
    await executor.execute(request({
      provider: 'antigravity',
      model: 'gemini-3.1-flash-image',
      options: {
        imageSize: '2K', compressionQuality: 88, safetyFiltering: 'moreRestrictive',
        agentModel: 'saved-agent-model', projectPath: '/must-not-override-project',
      },
    }));

    expect(services.antigravity).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'saved-agent-model', imageModel: 'gemini-3.1-flash-image', imageSize: '2K',
        compressionQuality: 88, safetyFiltering: 'moreRestrictive',
        projectPath: '/virtual/project', directorMode: 'skip',
      }),
      'Use the storyboard as the primary spatial plan.',
      [
        { name: 'Storyboard sketch - mandatory layout guide', bytes: new Uint8Array([2]) },
        { name: 'Product', bytes: new Uint8Array([1]) },
      ],
      expect.objectContaining({ width: 1024, height: 1024 }),
    );
    expect(services.codex).not.toHaveBeenCalled();
  });
});
