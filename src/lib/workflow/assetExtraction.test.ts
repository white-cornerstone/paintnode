import { describe, expect, it } from 'vitest';
import {
  assertExtractedAssetHasUsefulAlpha,
  assetExtractionImageModelSources,
  assetSheetCells,
  extractedAssetAlphaCoverage,
  workflowAssetExtractionPrompt,
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
    expect(prompt).toContain('4 columns by 2 rows');
    expect(prompt).toContain('left-to-right then top-to-bottom');
    expect(prompt).toContain('Do not return separate object files');
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
});
