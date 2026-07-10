import { describe, expect, it } from 'vitest';
import {
  planUpdateCheck,
  shouldRunBackgroundRuntimeUpdateCheck,
  UPDATE_CHECK_INTERVAL_MS,
} from './updatePolicy';

describe('background runtime update policy', () => {
  it('checks runtimes on first launch and after the daily interval', () => {
    expect(shouldRunBackgroundRuntimeUpdateCheck(null, null, 1000)).toBe(true);
    expect(shouldRunBackgroundRuntimeUpdateCheck('1000', 'false', 1000 + UPDATE_CHECK_INTERVAL_MS - 1)).toBe(false);
    expect(shouldRunBackgroundRuntimeUpdateCheck('1000', 'false', 1000 + UPDATE_CHECK_INTERVAL_MS)).toBe(true);
  });

  it('rechecks runtimes while a previously detected update remains outstanding', () => {
    expect(shouldRunBackgroundRuntimeUpdateCheck('1000', 'true', 1001)).toBe(true);
  });

  it('recovers from invalid persisted timestamps', () => {
    expect(shouldRunBackgroundRuntimeUpdateCheck('not-a-time', 'false', 1000)).toBe(true);
  });

  it('always checks PaintNode even when a runtime check is throttled', () => {
    expect(planUpdateCheck(true, '1000', 'false', 1001)).toEqual({
      checkApp: true,
      checkManagedRuntimes: false,
    });
  });

  it('fully refreshes both update sources for a manual check', () => {
    expect(planUpdateCheck(false, '1000', 'false')).toEqual({
      checkApp: true,
      checkManagedRuntimes: true,
    });
  });
});
