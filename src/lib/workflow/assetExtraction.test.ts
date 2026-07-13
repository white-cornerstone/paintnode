import { describe, expect, it } from 'vitest';
import { assetSheetCells, workflowAssetExtractionPrompt } from './assetExtraction';

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
});
