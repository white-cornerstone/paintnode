import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { isDesktop } from '../integrations/desktop';

export type ManagedRuntimeProvider = 'codex' | 'claude';
export type ManagedRuntimeState = 'notInstalled' | 'ready' | 'updateAvailable';

export interface ManagedRuntimeStatus {
  provider: ManagedRuntimeProvider;
  state: ManagedRuntimeState;
  installedVersion: string | null;
  availableVersion: string | null;
  sdkVersion: string | null;
  engineVersion: string | null;
  downloadSize: number | null;
  authenticated: boolean | null;
  message: string | null;
}

export interface ManagedRuntimeProgress {
  provider: ManagedRuntimeProvider;
  phase: 'checking' | 'downloading' | 'installing' | 'authenticating' | 'ready';
  downloadedBytes: number;
  totalBytes: number | null;
  message: string;
}

export function formatRuntimeBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function runtimeProgressPercent(progress: ManagedRuntimeProgress | null): number | null {
  if (!progress?.totalBytes || progress.totalBytes <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100)));
}

function requireDesktop(): void {
  if (!isDesktop()) throw new Error('Managed AI providers are available in the PaintNode desktop app.');
}

export async function getManagedRuntimeStatus(
  provider: ManagedRuntimeProvider,
  checkUpdates = false,
): Promise<ManagedRuntimeStatus> {
  requireDesktop();
  return invoke<ManagedRuntimeStatus>('managed_runtime_status', {
    provider,
    checkUpdates,
    manifestUrl: null,
  });
}

export async function installManagedRuntime(provider: ManagedRuntimeProvider): Promise<ManagedRuntimeStatus> {
  requireDesktop();
  return invoke<ManagedRuntimeStatus>('install_managed_runtime', { provider, manifestUrl: null });
}

export async function loginManagedRuntime(provider: ManagedRuntimeProvider): Promise<ManagedRuntimeStatus> {
  requireDesktop();
  return invoke<ManagedRuntimeStatus>('login_managed_runtime', { provider });
}

export async function onManagedRuntimeProgress(
  handler: (progress: ManagedRuntimeProgress) => void,
): Promise<UnlistenFn> {
  requireDesktop();
  return listen<ManagedRuntimeProgress>('managed-runtime-progress', (event) => handler(event.payload));
}
