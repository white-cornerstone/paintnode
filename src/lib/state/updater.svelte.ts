import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import {
  getManagedRuntimeStatus,
  installManagedRuntime,
  onManagedRuntimeProgress,
  runtimeProgressPercent,
  type ManagedRuntimeProgress,
  type ManagedRuntimeProvider,
  type ManagedRuntimeStatus,
} from '../ai/managedRuntime';
import { isDesktop } from '../integrations/desktop';
import { settings } from './settings.svelte';
import { shouldRunBackgroundUpdateCheck } from './updatePolicy';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error' | 'unsupported';
type RuntimeStatusMap = Partial<Record<ManagedRuntimeProvider, ManagedRuntimeStatus>>;
type RuntimeErrorMap = Partial<Record<ManagedRuntimeProvider, string>>;

export const UPDATE_CHECK_STORAGE_KEY = 'paintnode.updates.lastCheckedAt';
export const UPDATE_AVAILABLE_STORAGE_KEY = 'paintnode.updates.previouslyAvailable';
export const MANAGED_RUNTIME_PROVIDERS: readonly ManagedRuntimeProvider[] = ['codex', 'claude'];

export function managedRuntimeLabel(provider: ManagedRuntimeProvider): string {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

class AppUpdaterStore {
  status = $state<UpdateStatus>('idle');
  update = $state<Update | null>(null);
  version = $state<string | null>(null);
  currentVersion = $state<string | null>(null);
  body = $state<string | null>(null);
  date = $state<string | null>(null);
  error = $state<string | null>(null);
  downloadedBytes = $state(0);
  contentLength = $state<number | null>(null);
  runtimeStatuses = $state<RuntimeStatusMap>({});
  runtimeErrors = $state<RuntimeErrorMap>({});
  runtimeChecking = $state(false);
  runtimeInstalling = $state<ManagedRuntimeProvider | null>(null);
  runtimeProgress = $state<ManagedRuntimeProgress | null>(null);
  runtimeInstallError = $state<string | null>(null);
  private checkInFlight: Promise<boolean> | null = null;

  get appAvailable(): boolean {
    return !!this.update && this.status === 'available';
  }

  get runtimeUpdates(): ManagedRuntimeStatus[] {
    return MANAGED_RUNTIME_PROVIDERS
      .map((provider) => this.runtimeStatuses[provider])
      .filter((status): status is ManagedRuntimeStatus => status?.state === 'updateAvailable');
  }

  get available(): boolean {
    return this.appAvailable || this.runtimeUpdates.length > 0;
  }

  get checking(): boolean {
    return this.status === 'checking' || this.runtimeChecking;
  }

  get installing(): boolean {
    return this.status === 'downloading' || this.status === 'ready' || this.runtimeInstalling !== null;
  }

  get progress(): number | null {
    if (!this.contentLength || this.contentLength <= 0) return null;
    return Math.min(1, this.downloadedBytes / this.contentLength);
  }

  get managedRuntimeProgressPercent(): number | null {
    return runtimeProgressPercent(this.runtimeProgress);
  }

  async listenForRuntimeProgress(): Promise<() => void> {
    return onManagedRuntimeProgress((progress) => {
      if (progress.provider !== this.runtimeInstalling) return;
      this.runtimeProgress = progress;
    });
  }

  async checkForUpdates(options: { background?: boolean } = {}): Promise<boolean> {
    if (!isDesktop()) {
      this.status = 'unsupported';
      return false;
    }
    if (options.background && this.available) return true;
    if (
      options.background &&
      !shouldRunBackgroundUpdateCheck(
        localStorage.getItem(UPDATE_CHECK_STORAGE_KEY),
        localStorage.getItem(UPDATE_AVAILABLE_STORAGE_KEY),
      )
    ) {
      return this.available;
    }
    if (this.checkInFlight) return this.checkInFlight;

    this.checkInFlight = this.performUpdateCheck();
    try {
      return await this.checkInFlight;
    } finally {
      this.checkInFlight = null;
    }
  }

  private async performUpdateCheck(): Promise<boolean> {
    this.status = 'checking';
    this.runtimeChecking = true;
    this.error = null;
    this.runtimeErrors = {};
    this.runtimeInstallError = null;
    this.downloadedBytes = 0;
    this.contentLength = null;

    const [appCheckSucceeded] = await Promise.all([this.checkAppUpdate(), this.checkManagedRuntimes()]);
    this.runtimeChecking = false;
    const checkSucceeded = appCheckSucceeded && Object.keys(this.runtimeErrors).length === 0;
    if (checkSucceeded) {
      localStorage.setItem(UPDATE_CHECK_STORAGE_KEY, String(Date.now()));
      localStorage.setItem(UPDATE_AVAILABLE_STORAGE_KEY, String(this.available));
    }
    return this.available;
  }

  private async checkAppUpdate(): Promise<boolean> {
    try {
      const next = await check({ timeout: 30000 });
      if (!next) {
        this.clearUpdate();
        this.status = 'current';
        return true;
      }

      this.update?.close().catch(() => undefined);
      this.update = next;
      this.version = next.version;
      this.currentVersion = next.currentVersion;
      this.body = next.body || null;
      this.date = next.date || null;
      this.status = 'available';
      return true;
    } catch (error) {
      this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private async checkManagedRuntimes(): Promise<void> {
    const providers = MANAGED_RUNTIME_PROVIDERS.filter((provider) =>
      provider === 'codex'
        ? settings.value.ai.codexExecutableMode === 'builtin'
        : settings.value.ai.claudeExecutableMode === 'builtin',
    );
    const nextStatuses: RuntimeStatusMap = {};
    const nextErrors: RuntimeErrorMap = {};

    await Promise.all(
      providers.map(async (provider) => {
        try {
          const local = await getManagedRuntimeStatus(provider, false);
          if (!local.installedVersion) return;
          nextStatuses[provider] = await getManagedRuntimeStatus(provider, true);
        } catch (error) {
          nextStatuses[provider] = this.runtimeStatuses[provider];
          nextErrors[provider] = error instanceof Error ? error.message : String(error);
        }
      }),
    );

    this.runtimeStatuses = nextStatuses;
    this.runtimeErrors = nextErrors;
  }

  async installAvailableUpdates(): Promise<void> {
    if (this.installing || !this.available) return;
    this.runtimeInstallError = null;

    for (const update of [...this.runtimeUpdates]) {
      const provider = update.provider;
      this.runtimeInstalling = provider;
      this.runtimeProgress = null;
      try {
        const status = await installManagedRuntime(provider);
        this.runtimeStatuses = { ...this.runtimeStatuses, [provider]: status };
        this.runtimeErrors = { ...this.runtimeErrors, [provider]: undefined };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.runtimeInstallError = `${managedRuntimeLabel(provider)} update failed: ${message}`;
        this.runtimeInstalling = null;
        this.runtimeProgress = null;
        return;
      }
    }

    this.runtimeInstalling = null;
    this.runtimeProgress = null;
    if (this.appAvailable) await this.installAndRelaunch();
  }

  async installAndRelaunch(): Promise<void> {
    if (!this.update) return;

    this.status = 'downloading';
    this.error = null;
    this.downloadedBytes = 0;
    this.contentLength = null;

    try {
      await this.update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === 'Started') {
          this.contentLength = event.data.contentLength ?? null;
          this.downloadedBytes = 0;
        } else if (event.event === 'Progress') {
          this.downloadedBytes += event.data.chunkLength;
        } else if (event.event === 'Finished') {
          this.status = 'ready';
        }
      });
      this.status = 'ready';
      await relaunch();
    } catch (error) {
      this.status = 'error';
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private clearUpdate(): void {
    this.update?.close().catch(() => undefined);
    this.update = null;
    this.version = null;
    this.currentVersion = null;
    this.body = null;
    this.date = null;
  }
}

export const appUpdater = new AppUpdaterStore();
