import { describe, expect, it } from 'vitest';
import {
  MIN_VISIBLE_VIEWPORT_CONTENT,
  clampViewportOffset,
  viewportOffsetBounds,
} from './viewportBounds';

describe('viewport pan bounds', () => {
  it('allows small content to pan until only a visible slice remains', () => {
    expect(viewportOffsetBounds(1000, 300)).toEqual({
      min: MIN_VISIBLE_VIEWPORT_CONTENT - 300,
      max: 1000 - MIN_VISIBLE_VIEWPORT_CONTENT,
    });
    expect(clampViewportOffset(-240, 1000, 300)).toBe(MIN_VISIBLE_VIEWPORT_CONTENT - 300);
    expect(clampViewportOffset(940, 1000, 300)).toBe(1000 - MIN_VISIBLE_VIEWPORT_CONTENT);
    expect(clampViewportOffset(350, 1000, 300)).toBe(350);
  });

  it('lets large content scroll mostly out of view without disappearing', () => {
    expect(viewportOffsetBounds(800, 1200)).toEqual({
      min: MIN_VISIBLE_VIEWPORT_CONTENT - 1200,
      max: 800 - MIN_VISIBLE_VIEWPORT_CONTENT,
    });
    expect(clampViewportOffset(730, 800, 1200)).toBe(800 - MIN_VISIBLE_VIEWPORT_CONTENT);
    expect(clampViewportOffset(-1120, 800, 1200)).toBe(MIN_VISIBLE_VIEWPORT_CONTENT - 1200);
    expect(clampViewportOffset(-240, 800, 1200)).toBe(-240);
  });

  it('keeps tiny content fully visible when it is smaller than the visible slice', () => {
    expect(viewportOffsetBounds(640, 48)).toEqual({ min: 0, max: 592 });
    expect(clampViewportOffset(-1, 640, 48)).toBe(0);
    expect(clampViewportOffset(620, 640, 48)).toBe(592);
  });
});
