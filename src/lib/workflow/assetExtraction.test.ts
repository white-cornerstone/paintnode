import { describe, expect, it } from 'vitest';
import {
  assertExtractedAssetHasUsefulAlpha,
  assetExtractionImageModelSources,
  assetSheetCells,
  detectUniformBorderMatte,
  extractedAssetAlphaCoverage,
  workflowAssetExtractionPrompt,
  workflowAssetExtractionExecution,
  workflowPlannedAssetSheetPrompt,
  WORKFLOW_ASSET_OPERATION_PROMPT_MAX_CHARS,
} from './assetExtraction';

describe('workflow asset extraction', () => {
  it.each([
    [1, 1, 1],
    [2, 2, 1],
    [4, 2, 2],
    [8, 4, 2],
  ] as const)('lays out %i assets as a deterministic %ix%i sheet', (count, columns, rows) => {
    const cells = assetSheetCells(count);
    expect(cells).toHaveLength(count);
    expect(new Set(cells.map((cell) => cell.column))).toHaveLength(columns);
    expect(new Set(cells.map((cell) => cell.row))).toHaveLength(rows);
    expect(cells.every((cell) => cell.width === 1 / columns && cell.height === 1 / rows)).toBe(true);
  });

  it('keeps quality extraction as one named transparent file per object', () => {
    const prompt = workflowAssetExtractionPrompt('Extract the hat and shoes.', 'quality', 4);
    expect(prompt).toContain('Extract the hat and shoes.');
    expect(prompt).toContain('its own clearly named transparent PNG asset');
    expect(prompt).toContain('labelled SUPPORT');
  });

  it('gives fast extraction a single index-sheet contract with crop order', () => {
    const prompt = workflowAssetExtractionPrompt('', 'fast', 8);
    expect(prompt).toContain('exactly one transparent PNG named asset-index-sheet.png');
    expect(prompt).toContain('exactly one image-generation operation');
    expect(prompt).toContain('4 columns by 2 rows');
    expect(prompt).toContain('left-to-right then top-to-bottom');
    expect(prompt).toContain('semantic component reconstruction');
    expect(prompt).toContain('Never paste, crop, clone');
    expect(prompt).toContain('no asset may span cells');
    expect(prompt).toContain('separate object files');
    expect(prompt).not.toContain('INDEX SHEET GUIDELINE');
  });

  it('keeps fast mode to one image operation even when a Director plans the inventory', () => {
    expect(workflowAssetExtractionExecution('fast', false)).toBe('single-index-sheet');
    expect(workflowAssetExtractionExecution('fast', true)).toBe('single-index-sheet');
    expect(workflowAssetExtractionExecution('quality', true)).toBe('planned-individual-assets');
    expect(workflowAssetExtractionExecution('quality', false)).toBe('provider-asset-pack');
  });

  it('turns a Director inventory into one ordered sheet prompt', () => {
    const prompt = workflowPlannedAssetSheetPrompt('Preserve product identity.', [
      { name: 'Bottle', instruction: 'Isolate the labelled bottle.' },
      { name: 'Glass', instruction: 'Isolate the transparent whisky glass.' },
    ], 8);
    expect(prompt).toContain('AI DIRECTOR INVENTORY (final; one image operation only)');
    expect(prompt).toContain('1. Bottle');
    expect(prompt).toContain('2. Glass');
    expect(prompt).toContain('Reconstruct these 2 fresh, complete canonical assets');
    expect(prompt).toContain('fixed 4x2 equal-cell grid');
    expect(prompt).toContain('single index sheet is the only image deliverable');
    expect(prompt).toContain('means reconstruct, never cut out source pixels');
  });

  it('keeps the complete Director inventory within the strictest image-provider prompt budget', () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      name: `Asset ${index + 1} ${'n'.repeat(200)}`,
      instruction: `Reconstruct component ${index + 1}. ${'detail '.repeat(400)}`,
    }));
    const prompt = workflowPlannedAssetSheetPrompt('goal '.repeat(5000), items, 8);
    expect(prompt.length).toBeLessThanOrEqual(WORKFLOW_ASSET_OPERATION_PROMPT_MAX_CHARS);
    for (let index = 1; index <= 8; index += 1) {
      expect(prompt).toContain(`${index}. Asset ${index}`);
      expect(prompt).toContain(`Reconstruct component ${index}`);
    }
    expect(prompt).toContain('single index sheet is the only image deliverable');
  });

  it('keeps synthetic index guidelines out of image-model inputs', () => {
    const sources = assetExtractionImageModelSources([
      { name: 'Photo', dataUrl: 'data:image/png;base64,source', role: 'source' },
      { name: 'Annotations', dataUrl: 'data:image/png;base64,support', role: 'support' },
      { name: 'INDEX SHEET GUIDELINE', dataUrl: 'data:image/png;base64,grid', role: 'support', synthetic: true },
    ]);
    expect(sources.map((source) => source.name)).toEqual(['Photo', 'Annotations']);
  });

  it('rejects opaque and empty extraction results before saving them', () => {
    const opaque = new Uint8ClampedArray([
      20, 30, 40, 255,
      50, 60, 70, 255,
    ]);
    expect(() => assertExtractedAssetHasUsefulAlpha(opaque, 'Bottle')).toThrow(/no usable transparent background/i);

    const empty = new Uint8ClampedArray([
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    expect(() => assertExtractedAssetHasUsefulAlpha(empty, 'Bottle')).toThrow(/became empty/i);
  });

  it('accepts a visible asset surrounded by transparency and reports coverage', () => {
    const keyed = new Uint8ClampedArray([
      0, 0, 0, 0,
      120, 80, 40, 255,
      120, 80, 40, 128,
      0, 0, 0, 0,
    ]);
    expect(assertExtractedAssetHasUsefulAlpha(keyed, 'Bottle')).toEqual({
      transparentFraction: 0.5,
      visibleFraction: 0.5,
    });
    expect(extractedAssetAlphaCoverage(keyed).visibleFraction).toBe(0.5);
  });

  it('detects a provider-shifted flat border matte but rejects checkerboards', () => {
    const flat = new Uint8ClampedArray(4 * 4 * 4);
    for (let pixel = 0; pixel < 16; pixel += 1) {
      flat.set([246 + (pixel % 2), 245, 242, 255], pixel * 4);
    }
    flat.set([120, 80, 40, 255], (1 * 4 + 1) * 4);
    expect(detectUniformBorderMatte(flat, 4, 4)).toMatchObject({
      key: { r: 247, g: 245, b: 242 },
      borderCoverage: 1,
    });

    const checkerboard = new Uint8ClampedArray(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const value = (x + y) % 2 === 0 ? 220 : 160;
        checkerboard.set([value, value, value, 255], (y * 4 + x) * 4);
      }
    }
    expect(detectUniformBorderMatte(checkerboard, 4, 4)).toBeNull();

    const labelledBottomEdge = new Uint8ClampedArray(8 * 8 * 4);
    for (let pixel = 0; pixel < 64; pixel += 1) {
      labelledBottomEdge.set([8, 182, 72, 255], pixel * 4);
    }
    for (let x = 0; x < 8; x += 1) {
      labelledBottomEdge.set([36, 77, 112, 255], (7 * 8 + x) * 4);
    }
    expect(detectUniformBorderMatte(labelledBottomEdge, 8, 8)).toMatchObject({
      key: { r: 8, g: 182, b: 72 },
    });
  });
});
