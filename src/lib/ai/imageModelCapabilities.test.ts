import { describe, expect, it } from 'vitest';
import { fillFrameSummary, isGrokImageRatio } from './imageModelCapabilities';

describe('fill frame summary', () => {
  it('keeps Codex fills on a direct document-sized frame when supported', () => {
    const summary = fillFrameSummary('codex', 1280, 800, 526, 309);

    expect(summary.provider).toBe('codex');
    expect(summary.selectionLabel).toBe('526 x 309');
    expect(summary.frameLabel).toBe('1280 x 800');
    expect(summary.ratioLabel).toBe('8:5');
    expect(summary.scalePercent).toBe(100);
    expect(summary.needsRestoration).toBe(false);
    expect(summary.needsRatioChoice).toBe(false);
    expect(summary.choices).toEqual([]);
  });

  it('picks the closest Antigravity ratio without asking when the match is close', () => {
    const summary = fillFrameSummary('antigravity', 1280, 800, 526, 309);

    expect(summary.provider).toBe('antigravity');
    expect(summary.selectionLabel).toBe('526 x 309');
    expect(summary.ratioLabel).toBe('16:9');
    expect(summary.scalePercent).toBe(100);
    expect(summary.needsRestoration).toBe(false);
    expect(summary.needsRatioChoice).toBe(false);
    expect(summary.choices.map((choice) => choice.label)).toContain('21:9');
  });

  it('caps Grok fill frames at twice the ratio grid (1k/2k output tiers)', () => {
    const summary = fillFrameSummary('grok', 4000, 2250, 526, 309);

    expect(summary.provider).toBe('grok');
    expect(summary.ratioLabel).toBe('16:9');
    expect(summary.frameLabel).toBe('2688 x 1536');
    expect(summary.scalePercent).toBe(67);
    expect(summary.needsRestoration).toBe(true);

    const small = fillFrameSummary('grok', 1280, 720, 526, 309);
    expect(small.frameLabel).toBe('1344 x 768');
    expect(small.scalePercent).toBe(100);
    expect(small.needsRestoration).toBe(false);
  });

  it('classifies only real Grok output-grid ratios as Grok-friendly presets', () => {
    expect(isGrokImageRatio(1024, 1024)).toBe(true);
    expect(isGrokImageRatio(1344, 768)).toBe(true);
    expect(isGrokImageRatio(1408, 704)).toBe(true);
    expect(isGrokImageRatio(1456, 672)).toBe(true);
    expect(isGrokImageRatio(1280, 576)).toBe(true);
    expect(isGrokImageRatio(1280, 800)).toBe(false);
  });

  it('exposes every concrete aspect ratio documented by the xAI Images API', () => {
    const labels = fillFrameSummary('grok', 1024, 1024, 1024, 1024).choices.map((choice) => choice.label);

    expect(labels).toEqual([
      '1:1',
      '2:3',
      '3:2',
      '3:4',
      '4:3',
      '1:2',
      '2:1',
      '9:16',
      '16:9',
      '9:19.5',
      '19.5:9',
      '9:20',
      '20:9',
    ]);
  });

  it('asks for an Antigravity ratio when the selected area is between supported shapes', () => {
    const auto = fillFrameSummary('antigravity', 1280, 800, 1000, 200);
    expect(auto.ratioLabel).toBe('4:1');
    expect(auto.needsRatioChoice).toBe(true);

    const overridden = fillFrameSummary('antigravity', 1280, 800, 1000, 200, '8:1');
    expect(overridden.ratioLabel).toBe('8:1');
    expect(overridden.needsRatioChoice).toBe(false);
  });
});
