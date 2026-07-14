import { describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke }));

import {
  antigravityConfigFromRunOptions,
  claudeConfigFromRunOptions,
  codexConfigFromRunOptions,
  composeGrokWorkflow,
  grokConfigFromRunOptions,
  parseProjectAssetMaterialEnvelope,
  resolveProjectAssetMaterial,
  storeProjectClipboardImage,
} from './desktop';
import { defaultAiRunOptions } from '../state/settings';

const MATERIAL_MAGIC = new TextEncoder().encode('PNMATRAW');

function materialEnvelope(
  bytes: Uint8Array,
  metadata: Record<string, unknown> = {
    assetId: 'asset-1',
    relativePath: 'assets/imported/asset.png',
    contentHash: `sha256:${'a'.repeat(64)}`,
  },
  options: { version?: number; metadataLength?: number; materialLength?: number } = {},
): Uint8Array {
  const encodedMetadata = new TextEncoder().encode(JSON.stringify(metadata));
  const envelope = new Uint8Array(18 + encodedMetadata.length + bytes.length);
  envelope.set(MATERIAL_MAGIC, 0);
  const view = new DataView(envelope.buffer);
  view.setUint16(8, options.version ?? 1, false);
  view.setUint32(10, options.metadataLength ?? encodedMetadata.length, false);
  view.setUint32(14, options.materialLength ?? bytes.length, false);
  envelope.set(encodedMetadata, 18);
  envelope.set(bytes, 18 + encodedMetadata.length);
  return envelope;
}

describe('codexConfigFromRunOptions', () => {
  it('preserves selected image moderation for Codex image generation', () => {
    const options = {
      ...defaultAiRunOptions(),
      imageQuality: 'high' as const,
      imageModeration: 'low' as const,
      directorMode: 'force' as const,
      directorProvider: 'claude' as const,
      directorInvolvement: 'ensureCompletion' as const,
    };

    const config = codexConfigFromRunOptions(options, '/tmp/project', 'fill-test', true);

    expect(config.imageQuality).toBe('high');
    expect(config.imageModeration).toBe('low');
    expect(config.directorMode).toBe('force');
    expect(config.directorProvider).toBe('claude');
    expect(config.directorInvolvement).toBe('ensureCompletion');
  });

  it('only passes binary overrides when the custom executable route is selected', () => {
    const builtin = {
      ...defaultAiRunOptions(),
      codexBin: '/bin/codex',
      claudeBin: '/bin/claude',
      antigravityBin: '/bin/agy',
    };

    expect(codexConfigFromRunOptions(builtin).bin).toBe('');
    expect(claudeConfigFromRunOptions(builtin).bin).toBe('');
    expect(antigravityConfigFromRunOptions(builtin).bin).toBe('');

    const custom = {
      ...builtin,
      codexExecutableMode: 'custom' as const,
      claudeExecutableMode: 'custom' as const,
      antigravityExecutableMode: 'custom' as const,
    };

    expect(codexConfigFromRunOptions(custom).bin).toBe('/bin/codex');
    expect(claudeConfigFromRunOptions(custom).bin).toBe('/bin/claude');
    expect(antigravityConfigFromRunOptions(custom).bin).toBe('/bin/agy');
  });
});

describe('grokConfigFromRunOptions', () => {
  it('forwards the Grok Director settings used by AI Upscale', () => {
    const options = {
      ...defaultAiRunOptions(),
      directorMode: 'force' as const,
      directorProvider: 'grok' as const,
      directorInvolvement: 'fullReview' as const,
      grokModel: 'grok-4.5' as const,
      grokReasoningEffort: 'high' as const,
    };

    const config = grokConfigFromRunOptions(options);

    expect(config.directorMode).toBe('force');
    expect(config.directorProvider).toBe('grok');
    expect(config.directorInvolvement).toBe('fullReview');
    expect(config.directorModel).toBe('grok-4.5');
    expect(config.directorReasoningEffort).toBe('high');
  });
});

describe('Grok workflow composition boundary', () => {
  it('forwards the requested workflow canvas to the native composer', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    api.invoke.mockResolvedValueOnce({ dataUrl: 'data:image/png;base64,AA==', asset: null, assets: [] });
    try {
      await composeGrokWorkflow(
        { imageModel: 'grok-imagine-image', projectPath: '/virtual/project', runId: 'candidate-1' },
        'Compose the campaign image.',
        [{ name: 'Product', role: 'Hero product', bytes: new Uint8Array([1, 2, 3]) }],
        { width: 1024, height: 1280 },
      );

      expect(api.invoke).toHaveBeenCalledWith('compose_grok_workflow', expect.objectContaining({
        prompt: 'Compose the campaign image.',
        targetWidth: 1024,
        targetHeight: 1280,
        runId: 'candidate-1',
      }));
    } finally {
      vi.unstubAllGlobals();
      api.invoke.mockReset();
    }
  });
});

describe('project asset material boundary', () => {
  it('stores a native clipboard image directly in the selected project', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    const stored = {
      dataUrl: 'data:image/png;base64,AA==',
      asset: {
        id: 'asset-clipboard', kind: 'imported', name: 'Clipboard Image.png',
        relativePath: 'assets/imported/clipboard.png', createdAt: 1, exists: true,
        width: 2, height: 1, mime: 'image/png',
      },
    };
    api.invoke.mockResolvedValueOnce(stored);
    try {
      await expect(storeProjectClipboardImage('/virtual/project')).resolves.toEqual(stored);
      expect(api.invoke).toHaveBeenCalledWith('project_store_clipboard_image', {
        projectPath: '/virtual/project',
        name: 'Clipboard Image.png',
      });
    } finally {
      vi.unstubAllGlobals();
      api.invoke.mockReset();
    }
  });

  it('requests material by asset ID and preserves exact bytes and hash', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    api.invoke.mockResolvedValueOnce(materialEnvelope(new Uint8Array([1, 2, 3, 4])).buffer);
    try {
      await expect(resolveProjectAssetMaterial('/virtual/project', 'asset-1')).resolves.toEqual({
        assetId: 'asset-1',
        relativePath: 'assets/imported/asset.png',
        bytes: new Uint8Array([1, 2, 3, 4]),
        contentHash: `sha256:${'a'.repeat(64)}`,
      });
      expect(api.invoke).toHaveBeenCalledWith('project_resolve_asset_material', {
        projectPath: '/virtual/project',
        assetId: 'asset-1',
      });
    } finally {
      vi.unstubAllGlobals();
      api.invoke.mockReset();
    }
  });

  it('rejects an invalid magic, version, or inconsistent envelope lengths', () => {
    const badMagic = materialEnvelope(new Uint8Array([1]));
    badMagic[0] ^= 0xff;
    expect(() => parseProjectAssetMaterialEnvelope(badMagic)).toThrow(/invalid header/i);
    expect(() => parseProjectAssetMaterialEnvelope(materialEnvelope(
      new Uint8Array([1]), {}, { version: 2 },
    ))).toThrow(/invalid lengths or version/i);
    expect(() => parseProjectAssetMaterialEnvelope(materialEnvelope(
      new Uint8Array([1]), {}, { materialLength: 2 },
    ))).toThrow(/invalid lengths or version/i);
    expect(() => parseProjectAssetMaterialEnvelope(materialEnvelope(
      new Uint8Array([1]), {}, { metadataLength: 4097 },
    ))).toThrow(/invalid lengths or version/i);
    expect(() => parseProjectAssetMaterialEnvelope(materialEnvelope(
      new Uint8Array([1]), {}, { materialLength: 32 * 1024 * 1024 + 1 },
    ))).toThrow(/invalid lengths or version/i);
  });

  it.each([
    { assetId: '../asset', relativePath: 'assets/asset.png', contentHash: `sha256:${'a'.repeat(64)}` },
    { assetId: 'asset-1', relativePath: '../asset.png', contentHash: `sha256:${'a'.repeat(64)}` },
    { assetId: 'asset-1', relativePath: 'assets/asset.png', contentHash: 'sha256:not-a-hash' },
    { assetId: 'asset-1', relativePath: 'assets/asset.png', contentHash: `sha256:${'a'.repeat(64)}`, extra: true },
  ])('rejects unsafe or non-canonical metadata %#', (metadata) => {
    expect(() => parseProjectAssetMaterialEnvelope(
      materialEnvelope(new Uint8Array([1]), metadata),
    )).toThrow(/identity|metadata/i);
  });

  it('rejects malformed UTF-8 JSON metadata', () => {
    const envelope = materialEnvelope(new Uint8Array([1]));
    envelope[18] = 0xff;
    expect(() => parseProjectAssetMaterialEnvelope(envelope)).toThrow(/metadata is invalid/i);
  });
});
