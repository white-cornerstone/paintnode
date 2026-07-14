import { describe, expect, it } from 'vitest';
import { canConsumeWheel, wheelDeltaPixels, type ScrollMetrics } from './wheelScrollChain';

const metrics = (overrides: Partial<ScrollMetrics> = {}): ScrollMetrics => ({
  scrollLeft: 0,
  scrollTop: 0,
  scrollWidth: 200,
  scrollHeight: 600,
  clientWidth: 200,
  clientHeight: 200,
  ...overrides,
});

describe('canConsumeWheel', () => {
  it('keeps downward scrolling in a node until it reaches the bottom', () => {
    expect(canConsumeWheel(metrics(), 0, 40)).toBe(true);
    expect(canConsumeWheel(metrics({ scrollTop: 200 }), 0, 40)).toBe(true);
    expect(canConsumeWheel(metrics({ scrollTop: 400 }), 0, 40)).toBe(false);
  });

  it('hands upward scrolling off only at the top edge', () => {
    expect(canConsumeWheel(metrics({ scrollTop: 400 }), 0, -40)).toBe(true);
    expect(canConsumeWheel(metrics({ scrollTop: 1 }), 0, -40)).toBe(true);
    expect(canConsumeWheel(metrics(), 0, -40)).toBe(false);
  });

  it('supports horizontal node scrolling independently', () => {
    const horizontal = metrics({ scrollWidth: 500, scrollHeight: 200 });
    expect(canConsumeWheel(horizontal, 30, 0)).toBe(true);
    expect(canConsumeWheel({ ...horizontal, scrollLeft: 300 }, 30, 0)).toBe(false);
    expect(canConsumeWheel({ ...horizontal, scrollLeft: 300 }, -30, 0)).toBe(true);
  });

  it('does not capture a wheel event when there is no overflow', () => {
    expect(canConsumeWheel(metrics({ scrollHeight: 200 }), 0, 40)).toBe(false);
  });
});

describe('wheelDeltaPixels', () => {
  it('normalizes pixel, line, and page wheel deltas', () => {
    expect(wheelDeltaPixels(3, 0, 240)).toBe(3);
    expect(wheelDeltaPixels(3, 1, 240)).toBe(48);
    expect(wheelDeltaPixels(3, 2, 240)).toBe(720);
  });
});
