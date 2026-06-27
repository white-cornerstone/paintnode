import { describe, expect, it } from 'vitest';
import { wheelZoomFactor } from './zoomGesture';

describe('wheelZoomFactor', () => {
  it('zooms in for negative deltas and out for positive deltas', () => {
    expect(wheelZoomFactor(-20)).toBeGreaterThan(1);
    expect(wheelZoomFactor(20)).toBeLessThan(1);
  });

  it('keeps small trackpad deltas precise', () => {
    expect(wheelZoomFactor(-5)).toBeCloseTo(1.006, 3);
    expect(wheelZoomFactor(5)).toBeCloseTo(0.994, 3);
  });

  it('caps large deltas to prevent jumpy zoom', () => {
    expect(wheelZoomFactor(-800)).toBeCloseTo(wheelZoomFactor(-80), 6);
    expect(wheelZoomFactor(800)).toBeCloseTo(wheelZoomFactor(80), 6);
  });
});
