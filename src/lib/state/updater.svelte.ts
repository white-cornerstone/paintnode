import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isDesktop } from '../integrations/desktop';

type UpdateStatus = 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error' | 'unsupported';

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

  get available(): boolean {
    return !!this.update && this.status === 'available';
  }

  get progress(): number | null {
    if (!this.contentLength || this.contentLength <= 0) return null;
    return Math.min(1, this.downloadedBytes / this.contentLength);
  }

  async checkForUpdates(): Promise<boolean> {
    if (!isDesktop()) {
      this.status = 'unsupported';
      return false;
    }

    this.status = 'checking';
    this.error = null;
    this.downloadedBytes = 0;
    this.contentLength = null;

    try {
      const next = await check({ timeout: 30000 });
      if (!next) {
        this.clearUpdate();
        this.status = 'current';
        return false;
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
