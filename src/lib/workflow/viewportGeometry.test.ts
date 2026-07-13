import { describe, expect, it } from 'vitest';
import { MIN_VISIBLE_VIEWPORT_CONTENT } from '../engine/viewportBounds';
import { clampWorkflowPan, workflowMapBounds, type WorkflowViewportItem } from './viewportGeometry';

const largeGraph: WorkflowViewportItem[] = [{ x: 100, y: 200, width: 1200, height: 900 }];

describe('workflow viewport geometry', () => {
  it('keeps the same recoverable strip as the image editor on every edge', () => {
    const topLeft = clampWorkflowPan({ panX: 1000, panY: 1000 }, largeGraph, 800, 600, 1);
    expect(100 + topLeft.panX).toBe(800 - MIN_VISIBLE_VIEWPORT_CONTENT);
    expect(200 + topLeft.panY).toBe(600 - MIN_VISIBLE_VIEWPORT_CONTENT);

    const bottomRight = clampWorkflowPan({ panX: -2000, panY: -2000 }, largeGraph, 800, 600, 1);
    expect(100 + bottomRight.panX + 1200).toBe(MIN_VISIBLE_VIEWPORT_CONTENT);
    expect(200 + bottomRight.panY + 900).toBe(MIN_VISIBLE_VIEWPORT_CONTENT);
  });

  it('keeps graph bounds and visibility calculations correct through zoom', () => {
    const result = clampWorkflowPan({ panX: -3000, panY: -3000 }, largeGraph, 800, 600, 2);
    expect((100 * 2) + result.panX + (1200 * 2)).toBe(MIN_VISIBLE_VIEWPORT_CONTENT);
    expect((200 * 2) + result.panY + (900 * 2)).toBe(MIN_VISIBLE_VIEWPORT_CONTENT);
  });

  it('keeps content smaller than the safety strip fully visible', () => {
    const tiny = [{ x: 40, y: 60, width: 48, height: 32 }];
    const before = clampWorkflowPan({ panX: 900, panY: 900 }, tiny, 640, 480, 1);
    expect(40 + before.panX + 48).toBe(640);
    expect(60 + before.panY + 32).toBe(480);

    const after = clampWorkflowPan({ panX: -900, panY: -900 }, tiny, 640, 480, 1);
    expect(40 + after.panX).toBe(0);
    expect(60 + after.panY).toBe(0);
  });

  it('does not invent limits for an empty workflow', () => {
    expect(clampWorkflowPan({ panX: 123, panY: -456 }, [], 800, 600, 1)).toEqual({
      panX: 123,
      panY: -456,
      rejectedX: 0,
      rejectedY: 0,
    });
    expect(workflowMapBounds([], 800, 600, 1, 20)).toBeNull();
  });

  it('reclamps against a resized viewport', () => {
    const wide = clampWorkflowPan({ panX: 704, panY: 504 }, largeGraph, 800, 600, 1);
    const narrow = clampWorkflowPan(wide, largeGraph, 500, 400, 1);
    expect(100 + narrow.panX).toBe(500 - MIN_VISIBLE_VIEWPORT_CONTENT);
    expect(200 + narrow.panY).toBe(400 - MIN_VISIBLE_VIEWPORT_CONTENT);
  });

  it('creates a stable minimap domain containing all permitted viewport positions', () => {
    const bounds = workflowMapBounds(largeGraph, 800, 600, 1, 20)!;
    const leftLimit = clampWorkflowPan({ panX: 10000, panY: 0 }, largeGraph, 800, 600, 1);
    const rightLimit = clampWorkflowPan({ panX: -10000, panY: 0 }, largeGraph, 800, 600, 1);
    const leftViewport = -leftLimit.panX;
    const rightViewport = -rightLimit.panX;

    expect(bounds.minX).toBeLessThan(leftViewport);
    expect(bounds.maxX).toBeGreaterThan(leftViewport + 800);
    expect(bounds.minX).toBeLessThan(rightViewport);
    expect(bounds.maxX).toBeGreaterThan(rightViewport + 800);
    expect(workflowMapBounds(largeGraph, 800, 600, 1, 20)).toEqual(bounds);
  });
});
