<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { appUpdater } from '../state/updater.svelte';
  import { ArrowDownload, ArrowSync, Checkmark } from '../icons';

  let { onClose }: { onClose: () => void } = $props();

  const percent = $derived(appUpdater.progress === null ? null : Math.round(appUpdater.progress * 100));

  function checkNow(): void {
    void appUpdater.checkForUpdates();
  }

  function installNow(): void {
    void appUpdater.installAndRelaunch();
  }
</script>

<Modal title="PaintNode Updates" {onClose} width={440}>
  <div class="update-dialog">
    {#if appUpdater.status === 'available'}
      <div class="status available">
        <Icon svg={ArrowDownload} size={22} />
        <div>
          <h2>Version {appUpdater.version} is available</h2>
          <p>Installed version {appUpdater.currentVersion}</p>
        </div>
      </div>
      {#if appUpdater.body}
        <section class="notes-panel" aria-label="Release notes">
          <h3>Release notes</h3>
          <div class="notes">{appUpdater.body}</div>
        </section>
      {/if}
      <div class="actions">
        <button type="button" onclick={checkNow}>
          <Icon svg={ArrowSync} size={15} />
          <span>Check Again</span>
        </button>
        <button type="button" class="primary" onclick={installNow}>
          <Icon svg={ArrowDownload} size={15} />
          <span>Update and Restart</span>
        </button>
      </div>
    {:else if appUpdater.status === 'checking'}
      <div class="status">
        <Icon svg={ArrowSync} size={22} />
        <div>
          <h2>Checking for updates</h2>
          <p>Contacting GitHub Releases.</p>
        </div>
      </div>
    {:else if appUpdater.status === 'downloading' || appUpdater.status === 'ready'}
      <div class="status available">
        <Icon svg={ArrowDownload} size={22} />
        <div>
          <h2>{appUpdater.status === 'ready' ? 'Restarting' : 'Installing update'}</h2>
          <p>{percent === null ? 'Downloading update package.' : `${percent}% downloaded`}</p>
        </div>
      </div>
      <div class="progress" aria-label="Update download progress">
        <span style={`width:${percent ?? 8}%`}></span>
      </div>
    {:else if appUpdater.status === 'current'}
      <div class="status">
        <Icon svg={Checkmark} size={22} />
        <div>
          <h2>PaintNode is up to date</h2>
          <p>No newer release is available.</p>
        </div>
      </div>
      <div class="actions">
        <button type="button" onclick={checkNow}>
          <Icon svg={ArrowSync} size={15} />
          <span>Check Again</span>
        </button>
      </div>
    {:else if appUpdater.status === 'unsupported'}
      <div class="status">
        <Icon svg={Checkmark} size={22} />
        <div>
          <h2>Updates are available in the desktop app</h2>
          <p>This browser preview cannot install app updates.</p>
        </div>
      </div>
    {:else if appUpdater.status === 'error'}
      <div class="status error">
        <Icon svg={ArrowSync} size={22} />
        <div>
          <h2>Update check failed</h2>
          <p>{appUpdater.error}</p>
        </div>
      </div>
      <div class="actions">
        <button type="button" onclick={checkNow}>
          <Icon svg={ArrowSync} size={15} />
          <span>Try Again</span>
        </button>
      </div>
    {:else}
      <div class="status">
        <Icon svg={ArrowSync} size={22} />
        <div>
          <h2>Check for updates</h2>
          <p>PaintNode uses GitHub Releases for app updates.</p>
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
    background: var(--accent);
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
</style>
