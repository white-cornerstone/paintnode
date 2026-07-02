import { defaultSettings, normalizeSettings, SETTINGS_STORAGE_KEY, type PaintNodeSettings } from './settings';

type SettingsPatch = Partial<{
  general: Partial<PaintNodeSettings['general']>;
  ai: Partial<PaintNodeSettings['ai']>;
  workspace: Partial<PaintNodeSettings['workspace']>;
}>;

function readStoredSettings(): PaintNodeSettings {
  if (typeof localStorage === 'undefined') return defaultSettings();
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || 'null'));
  } catch {
    return defaultSettings();
  }
}

class SettingsStore {
  value = $state<PaintNodeSettings>(readStoredSettings());

  update(patch: SettingsPatch): void {
    this.value = normalizeSettings({
      ...this.value,
      general: { ...this.value.general, ...patch.general },
      ai: { ...this.value.ai, ...patch.ai },
      workspace: { ...this.value.workspace, ...patch.workspace },
    });
    this.persist();
  }

  reset(): void {
    this.value = defaultSettings();
    this.persist();
  }

  persist(): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(this.value));
  }
}

export const settings = new SettingsStore();
