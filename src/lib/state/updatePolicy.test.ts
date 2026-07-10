import { describe, expect, it } from 'vitest';
import { shouldRunBackgroundUpdateCheck, UPDATE_CHECK_INTERVAL_MS } from './updatePolicy';

describe('background update policy', () => {
  it('checks on first launch and after the daily interval', () => {
    expect(shouldRunBackgroundUpdateCheck(null, null, 1000)).toBe(true);
    expect(shouldRunBackgroundUpdateCheck('1000', 'false', 1000 + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldRunBackgroundUpdateCheck('1000', 'false', 1000 + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });

  it('rechecks while a previously detected update remains outstanding', () => {
    expect(shouldRunBackgroundUpdateCheck('1000', 'true', 1001)).toBe(true);
  });

  it('recovers from invalid persisted timestamps', () => {
    expect(shouldRunBackgroundUpdateCheck('not-a-time', 'false', 1000)).toBe(true);
  });
});
