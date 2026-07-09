<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from './Icon.svelte';
  import { ArrowDownload, ArrowSync, CheckmarkCircle, ErrorCircle } from '../icons';
  import {
    formatRuntimeBytes,
    getManagedRuntimeStatus,
    installManagedRuntime,
    loginManagedRuntime,
    onManagedRuntimeProgress,
    runtimeProgressPercent,
    type ManagedRuntimeProgress,
    type ManagedRuntimeProvider,
    type ManagedRuntimeStatus,
  } from '../ai/managedRuntime';

  let {
    provider,
    compact = false,
    onStatusChange,
  }: {
    provider: ManagedRuntimeProvider;
    compact?: boolean;
    onStatusChange?: (status: ManagedRuntimeStatus | null) => void;
  } = $props();

  let status = $state<ManagedRuntimeStatus | null>(null);
  let progress = $state<ManagedRuntimeProgress | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);
  const label = $derived(provider === 'codex' ? 'Codex' : 'Claude');
  const percent = $derived(runtimeProgressPercent(progress));
  const ready = $derived(status?.state === 'ready' || status?.state === 'updateAvailable');
  const signedIn = $derived(status?.authenticated !== false);

  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onManagedRuntimeProgress((event) => {
      if (event.provider !== provider || disposed) return;
      progress = event;
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });
    void refresh(true);
    return () => {
      disposed = true;
      unlisten?.();
    };
  });

  function applyStatus(next: ManagedRuntimeStatus): void {
    status = next;
    onStatusChange?.(next);
  }

  async function refresh(checkUpdates = false): Promise<void> {
    error = null;
    try {
      applyStatus(await getManagedRuntimeStatus(provider, checkUpdates));
    } catch (reason) {
      error = (reason as Error)?.message ?? String(reason);
      onStatusChange?.(null);
    }
  }

  async function install(): Promise<void> {
    busy = true;
    error = null;
    try {
      const next = await installManagedRuntime(provider);
      applyStatus(next);
      progress = null;
    } catch (reason) {
      error = (reason as Error)?.message ?? String(reason);
      progress = null;
    } finally {
      busy = false;
    }
  }

  async function signIn(): Promise<void> {
    busy = true;
    error = null;
    try {
      applyStatus(await loginManagedRuntime(provider));
      progress = null;
    } catch (reason) {
      error = (reason as Error)?.message ?? String(reason);
      progress = null;
    } finally {
      busy = false;
    }
  }
</script>

<section class:compact class="runtime-card" aria-label={`${label} managed runtime`}>
  <div class="runtime-main">
    <span class:ready class:error={Boolean(error)} class="runtime-icon" aria-hidden="true">
      <Icon svg={error ? ErrorCircle : ready && signedIn ? CheckmarkCircle : ArrowDownload} size={18} />
    </span>
    <div class="runtime-copy">
      <strong>
        {#if busy}
          {progress?.message ?? `Preparing ${label}…`}
        {:else if ready && signedIn}
          {label} is ready
        {:else if ready}
          Sign in to {label}
        {:else}
          Install {label} support
        {/if}
      </strong>
      <small>
        {#if status?.installedVersion}
          Runtime {status.installedVersion}{status.sdkVersion ? ` · SDK ${status.sdkVersion}` : ''}
        {:else if status?.downloadSize}
          One-time {formatRuntimeBytes(status.downloadSize)} download. Keep editing while it installs.
        {:else}
          PaintNode downloads and updates this provider privately. No Terminal setup required.
        {/if}
      </small>
    </div>
    <div class="runtime-actions">
      {#if !busy && status?.state === 'updateAvailable'}
        <button type="button" onclick={install}>
          <Icon svg={ArrowSync} size={14} />
          <span>Update</span>
        </button>
      {:else if !busy && ready && !signedIn}
        <button type="button" class="primary" onclick={signIn}>Sign in</button>
      {:else if !busy && !ready}
        <button type="button" class="primary" onclick={install}>Install</button>
      {/if}
    </div>
  </div>

  {#if busy}
    <div
      class:indeterminate={percent === null}
      class="progress-track"
      role="progressbar"
      aria-label={progress?.message ?? `Preparing ${label}`}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={percent ?? undefined}
    >
      <span style:width={percent === null ? '36%' : `${percent}%`}></span>
    </div>
  {/if}

  {#if error}
    <div class="runtime-error" role="alert">
      <span>{error}</span>
      <button type="button" class="link-button" onclick={() => void refresh(true)}>Try again</button>
    </div>
  {:else if status?.message}
    <p class="runtime-note">{status.message}</p>
  {/if}
</section>

<style>
  .runtime-card {
    padding: 12px;
    border: 1px solid var(--border, #d8d8d8);
    border-radius: 7px;
    background: color-mix(in srgb, var(--surface, #fff) 92%, var(--accent, #0f6cbd) 8%);
  }

  .runtime-card.compact { padding: 10px; }
  .runtime-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .runtime-icon { display: grid; place-items: center; width: 28px; height: 28px; flex: 0 0 auto; color: #666; }
  .runtime-icon.ready { color: #18794e; }
  .runtime-icon.error { color: #b42318; }
  .runtime-copy { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 2px; }
  .runtime-copy strong { font-size: 12px; font-weight: 600; }
  .runtime-copy small, .runtime-note { color: var(--muted, #666); font-size: 11px; line-height: 1.4; }
  .runtime-actions { flex: 0 0 auto; }
  .runtime-actions button { display: inline-flex; align-items: center; gap: 5px; }
  .progress-track { height: 3px; margin: 9px 0 0 38px; overflow: hidden; border-radius: 2px; background: rgba(0, 0, 0, 0.1); }
  .progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--accent, #0f6cbd); transition: width 140ms ease; }
  .progress-track.indeterminate span { animation: travel 1.2s ease-in-out infinite alternate; }
  .runtime-error { display: flex; align-items: baseline; gap: 8px; margin: 8px 0 0 38px; color: #b42318; font-size: 11px; line-height: 1.4; }
  .runtime-error span { flex: 1; }
  .link-button { padding: 0; border: 0; background: none; color: inherit; text-decoration: underline; }
  .runtime-note { margin: 7px 0 0 38px; }
  @keyframes travel { from { transform: translateX(-75%); } to { transform: translateX(180%); } }
</style>
