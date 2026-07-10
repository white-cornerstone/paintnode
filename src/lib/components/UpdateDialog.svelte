<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { formatRuntimeBytes } from '../ai/managedRuntime';
  import {
    appUpdater,
    managedRuntimeLabel,
    MANAGED_RUNTIME_PROVIDERS,
  } from '../state/updater.svelte';
  import { ArrowDownload, ArrowSync, Checkmark, ErrorCircle } from '../icons';

  let { onClose }: { onClose: () => void } = $props();

  const appPercent = $derived(appUpdater.progress === null ? null : Math.round(appUpdater.progress * 100));
  const runtimePercent = $derived(appUpdater.managedRuntimeProgressPercent);
  const updateCount = $derived((appUpdater.appAvailable ? 1 : 0) + appUpdater.runtimeUpdates.length);
  const hasRuntimeCheckErrors = $derived(Object.keys(appUpdater.runtimeErrors).length > 0);
  const installLabel = $derived(
    appUpdater.appAvailable
      ? appUpdater.runtimeUpdates.length
        ? 'Update All and Restart'
        : 'Update and Restart'
      : appUpdater.runtimeUpdates.length > 1
        ? 'Update Runtimes'
        : 'Update Runtime',
  );

  function checkNow(): void {
    void appUpdater.checkForUpdates();
  }

  function installNow(): void {
    void appUpdater.installAvailableUpdates();
  }
</script>

<Modal title="PaintNode Updates" {onClose} width={480}>
  <div class="update-dialog">
    {#if appUpdater.installing}
      <div class="status available">
        <Icon svg={ArrowDownload} size={22} />
        <div>
          {#if appUpdater.runtimeInstalling}
            <h2>Updating {managedRuntimeLabel(appUpdater.runtimeInstalling)}</h2>
            <p>{appUpdater.runtimeProgress?.message ?? 'Installing managed AI provider support.'}</p>
          {:else}
            <h2>{appUpdater.status === 'ready' ? 'Restarting PaintNode' : 'Updating PaintNode'}</h2>
            <p>{appPercent === null ? 'Downloading the application update.' : `${appPercent}% downloaded`}</p>
          {/if}
        </div>
      </div>
      <div class:indeterminate={(appUpdater.runtimeInstalling ? runtimePercent : appPercent) === null} class="progress" aria-label="Update progress">
        <span style={`width:${(appUpdater.runtimeInstalling ? runtimePercent : appPercent) ?? 16}%`}></span>
      </div>
    {:else if appUpdater.checking}
      <div class="status">
        <Icon svg={ArrowSync} size={22} />
        <div>
          <h2>Checking for updates</h2>
          <p>Checking PaintNode, Codex, and Claude support.</p>
        </div>
      </div>
    {:else if appUpdater.available}
      <div class="status available">
        <Icon svg={ArrowDownload} size={22} />
        <div>
          <h2>{updateCount} {updateCount === 1 ? 'update is' : 'updates are'} available</h2>
          <p>Runtime updates install independently and do not require a new PaintNode release.</p>
        </div>
      </div>

      <div class="update-list" aria-label="Available updates">
        {#if appUpdater.appAvailable}
          <article class="update-item">
            <div>
              <strong>PaintNode {appUpdater.version}</strong>
              <small>Application · installed {appUpdater.currentVersion}</small>
            </div>
            <span class="update-badge">Restart required</span>
          </article>
        {/if}
        {#each appUpdater.runtimeUpdates as runtime (runtime.provider)}
          <article class="update-item">
            <div>
              <strong>{managedRuntimeLabel(runtime.provider)} runtime {runtime.availableVersion}</strong>
              <small>
                SDK {runtime.sdkVersion ?? 'update'} · installed {runtime.installedVersion}
                {runtime.downloadSize ? ` · ${formatRuntimeBytes(runtime.downloadSize)}` : ''}
              </small>
            </div>
            <span class="update-badge">No restart</span>
          </article>
        {/each}
      </div>

      {#if appUpdater.body && appUpdater.appAvailable}
        <section class="notes-panel" aria-label="Release notes">
          <h3>PaintNode release notes</h3>
          <div class="notes">{appUpdater.body}</div>
        </section>
      {/if}

      {#if appUpdater.runtimeInstallError}
        <p class="inline-error" role="alert">{appUpdater.runtimeInstallError}</p>
      {/if}
      {#if appUpdater.status === 'error' && appUpdater.error}
        <p class="inline-warning">PaintNode app update check failed: {appUpdater.error}</p>
      {/if}

      <div class="actions">
        <button type="button" onclick={checkNow}>
          <Icon svg={ArrowSync} size={15} />
          <span>Check Again</span>
        </button>
        <button type="button" class="primary" onclick={installNow}>
          <Icon svg={ArrowDownload} size={15} />
          <span>{installLabel}</span>
        </button>
      </div>
    {:else if appUpdater.status === 'unsupported'}
      <div class="status">
        <Icon svg={Checkmark} size={22} />
        <div>
          <h2>Updates are available in the desktop app</h2>
          <p>This browser preview cannot install updates.</p>
        </div>
      </div>
    {:else if appUpdater.status === 'error' || hasRuntimeCheckErrors}
      <div class="status error">
        <Icon svg={ErrorCircle} size={22} />
        <div>
          <h2>{hasRuntimeCheckErrors ? 'Some update checks failed' : 'Update check failed'}</h2>
          <p>Installed components remain available and can continue working.</p>
        </div>
      </div>
      {#if appUpdater.error}
        <p class="inline-warning">PaintNode: {appUpdater.error}</p>
      {/if}
      {#each MANAGED_RUNTIME_PROVIDERS as provider}
        {#if appUpdater.runtimeErrors[provider]}
          <p class="inline-warning">{managedRuntimeLabel(provider)}: {appUpdater.runtimeErrors[provider]}</p>
        {/if}
      {/each}
      <div class="actions">
        <button type="button" onclick={checkNow}>
          <Icon svg={ArrowSync} size={15} />
          <span>Try Again</span>
        </button>
      </div>
    {:else if appUpdater.status === 'current'}
      <div class="status">
        <Icon svg={Checkmark} size={22} />
        <div>
          <h2>Everything is up to date</h2>
          <p>PaintNode and installed managed AI runtimes are current.</p>
        </div>
      </div>
      <div class="actions">
        <button type="button" onclick={checkNow}>
          <Icon svg={ArrowSync} size={15} />
          <span>Check Again</span>
        </button>
      </div>
    {:else}
      <div class="status">
        <Icon svg={ArrowSync} size={22} />
        <div>
          <h2>Check for updates</h2>
          <p>Check PaintNode and installed Codex or Claude runtimes.</p>
        </div>
      </div>
      <div class="actions">
        <button type="button" class="primary" onclick={checkNow}>
          <Icon svg={ArrowSync} size={15} />
          <span>Check Now</span>
        </button>
      </div>
    {/if}
  </div>
</Modal>

<style>
  .update-dialog {
    display: grid;
    gap: 14px;
    color: var(--text);
  }
  .status {
    display: grid;
    grid-template-columns: 28px 1fr;
    gap: 10px;
    align-items: start;
  }
  .status :global(svg) {
    margin-top: 2px;
    color: var(--text-dim);
  }
  .status.available :global(svg) {
    color: var(--accent);
  }
  .status.error :global(svg) {
    color: var(--danger);
  }
  h2 {
    margin: 0 0 4px;
    color: var(--text-bright);
    font-size: 14px;
    line-height: 1.25;
  }
  p {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.45;
  }
  .update-list {
    display: grid;
    overflow: hidden;
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: var(--bg-input);
  }
  .update-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 11px;
  }
  .update-item + .update-item {
    border-top: 1px solid var(--border-soft);
  }
  .update-item > div {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .update-item strong {
    color: var(--text-bright);
    font-size: 12px;
    font-weight: 650;
  }
  .update-item small {
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .update-badge {
    flex: 0 0 auto;
    padding: 2px 6px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent);
    font-size: 10px;
    font-weight: 650;
  }
  .notes-panel {
    display: grid;
    gap: 6px;
    min-height: 0;
  }
  h3 {
    margin: 0;
    color: var(--text-bright);
    font-size: 12px;
    line-height: 1.25;
    font-weight: 700;
  }
  .notes {
    max-height: min(160px, 34vh);
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: 5px;
    background: var(--bg-input);
    color: var(--text);
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .progress {
    height: 6px;
    border-radius: 999px;
    background: var(--bg-input);
    overflow: hidden;
  }
  .progress span {
    display: block;
    height: 100%;
    min-width: 8%;
    border-radius: inherit;
    background: var(--accent);
    transition: width 140ms ease;
  }
  .progress.indeterminate span {
    animation: travel 1.2s ease-in-out infinite alternate;
  }
  .inline-error,
  .inline-warning {
    padding: 8px 10px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--danger) 9%, var(--bg-input));
  }
  .inline-error {
    color: var(--danger);
  }
  .inline-warning {
    color: var(--text-dim);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-elevated);
    color: var(--text);
    padding: 4px 10px;
  }
  button.primary {
    border-color: var(--accent);
    background: var(--accent);
    color: var(--text-bright);
  }
  @keyframes travel {
    from { transform: translateX(-75%); }
    to { transform: translateX(180%); }
  }
</style>
