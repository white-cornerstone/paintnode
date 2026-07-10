export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface UpdateCheckPlan {
  checkApp: boolean;
  checkManagedRuntimes: boolean;
}

export function shouldRunBackgroundRuntimeUpdateCheck(
  lastCheckedAt: string | null,
  previouslyHadUpdates: string | null,
  now = Date.now(),
): boolean {
  // Re-check on every launch while an update is outstanding so the title-bar
  // action never disappears merely because the app restarted.
  if (previouslyHadUpdates === 'true') return true;
  if (!lastCheckedAt) return true;
  const checkedAt = Number(lastCheckedAt);
  return !Number.isFinite(checkedAt) || checkedAt <= 0 || now - checkedAt >= UPDATE_CHECK_INTERVAL_MS;
}

export function planUpdateCheck(
  background: boolean,
  lastRuntimeCheckedAt: string | null,
  previouslyHadRuntimeUpdates: string | null,
  now = Date.now(),
): UpdateCheckPlan {
  return {
    checkApp: true,
    checkManagedRuntimes:
      !background || shouldRunBackgroundRuntimeUpdateCheck(lastRuntimeCheckedAt, previouslyHadRuntimeUpdates, now),
  };
}
