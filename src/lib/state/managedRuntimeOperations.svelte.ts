import {
  installManagedRuntime,
  onManagedRuntimeProgress,
  type ManagedRuntimeProgress,
  type ManagedRuntimeProvider,
  type ManagedRuntimeStatus,
} from '../ai/managedRuntime';
import { isDesktop } from '../integrations/desktop';
import { managedRuntimeCompletionMessage, managedRuntimeLabel } from './managedRuntimeOperationMessages';

export interface ManagedRuntimeOperation {
  provider: ManagedRuntimeProvider;
  progress: ManagedRuntimeProgress | null;
  startedAt: number;
}

export interface ManagedRuntimeNotification {
  kind: 'success' | 'error';
  message: string;
}

class ManagedRuntimeOperationStore {
  active = $state<ManagedRuntimeOperation | null>(null);
  notification = $state<ManagedRuntimeNotification | null>(null);
  private progressListenerReady = false;

  private ensureProgressListener(): void {
    if (this.progressListenerReady || !isDesktop()) return;
    this.progressListenerReady = true;
    void onManagedRuntimeProgress((progress) => this.updateProgress(progress)).catch(() => {
      // The install command itself reports actionable failures. A missing event
      // listener must not prevent it from continuing in the background.
      this.progressListenerReady = false;
    });
  }

  private updateProgress(progress: ManagedRuntimeProgress): void {
    if (this.active?.provider !== progress.provider) return;
    this.active = { ...this.active, progress };
  }

  async install(provider: ManagedRuntimeProvider): Promise<ManagedRuntimeStatus> {
    if (this.active) {
      throw new Error(`${managedRuntimeLabel(this.active.provider)} setup is already in progress.`);
    }

    this.ensureProgressListener();
    this.notification = null;
    this.active = {
      provider,
      progress: {
        provider,
        phase: 'checking',
        downloadedBytes: 0,
        totalBytes: null,
        message: `Preparing ${managedRuntimeLabel(provider)} support...`,
      },
      startedAt: Date.now(),
    };

    try {
      const status = await installManagedRuntime(provider);
      this.active = null;
      this.notification = { kind: 'success', message: managedRuntimeCompletionMessage(provider) };
      return status;
    } catch (reason) {
      const message = (reason as Error)?.message ?? String(reason);
      this.active = null;
      this.notification = { kind: 'error', message: `${managedRuntimeLabel(provider)} setup failed: ${message}` };
      throw reason;
    }
  }

  dismissNotification(): void {
    this.notification = null;
  }
}

export const managedRuntimeOperations = new ManagedRuntimeOperationStore();
