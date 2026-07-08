// First-run AI setup wizard: decides when the wizard should offer itself and
// remembers that the user has already seen it (finished or dismissed).
import type { PaintNodeSettings } from './settings';

export const AI_SETUP_STORAGE_KEY = 'paintnode.aiSetup';

/** True when a supported AI CLI path has been configured. */
export function hasConfiguredAiCli(settings: PaintNodeSettings): boolean {
  const ai = settings.ai;
  return Boolean(ai.codexBin.trim() || ai.antigravityBin.trim());
}

/** Parse the stored seen-flag; any non-empty stored value counts as seen. */
export function parseAiSetupSeen(raw: string | null): boolean {
  return typeof raw === 'string' && raw.trim().length > 0;
}

/**
 * Offer the wizard only to first-time desktop users: never seen before and
 * no CLI configured yet (settings may predate the wizard).
 */
export function shouldOfferAiSetup(settings: PaintNodeSettings, storedSeen: string | null, desktop: boolean): boolean {
  return desktop && !parseAiSetupSeen(storedSeen) && !hasConfiguredAiCli(settings);
}

export function aiSetupSeen(): boolean {
  if (typeof localStorage === 'undefined') return true;
  return parseAiSetupSeen(localStorage.getItem(AI_SETUP_STORAGE_KEY));
}

export function markAiSetupSeen(outcome: 'completed' | 'dismissed'): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(AI_SETUP_STORAGE_KEY, outcome);
}
