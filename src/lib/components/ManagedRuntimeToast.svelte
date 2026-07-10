<script lang="ts">
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { CheckmarkCircle, Dismiss, ErrorCircle } from '../icons';
  import { managedRuntimeOperations } from '../state/managedRuntimeOperations.svelte';

  const notice = $derived(managedRuntimeOperations.notification);

  $effect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => managedRuntimeOperations.dismissNotification(), 8_000);
    return () => window.clearTimeout(timer);
  });
</script>

{#if notice}
  <div class:error={notice.kind === 'error'} class="runtime-toast" role={notice.kind === 'error' ? 'alert' : 'status'}>
    <Icon svg={notice.kind === 'success' ? CheckmarkCircle : ErrorCircle} size={16} />
    <span>{notice.message}</span>
    <button
      type="button"
      aria-label="Dismiss provider setup notification"
      use:tooltip={{ text: 'Dismiss', placement: 'bottom' }}
      onclick={() => managedRuntimeOperations.dismissNotification()}
    >
      <Icon svg={Dismiss} size={14} />
    </button>
  </div>
{/if}

<style>
  .runtime-toast {
    position: fixed;
    z-index: 61;
    top: 104px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
    width: fit-content;
    max-width: min(560px, calc(100% - 32px));
    padding: 7px 7px 7px 10px;
    border: 1px solid color-mix(in srgb, #2d9d63 58%, var(--border));
    border-radius: 6px;
    background: color-mix(in srgb, var(--bg-panel) 92%, #2d9d63 8%);
    color: var(--text);
    box-shadow: 0 6px 16px rgb(0 0 0 / 0.18);
    font-size: 12px;
    line-height: 18px;
  }
  .runtime-toast > :global(svg) { color: #2d9d63; flex: 0 0 auto; }
  .runtime-toast.error { border-color: color-mix(in srgb, var(--danger) 62%, var(--border)); }
  .runtime-toast.error > :global(svg) { color: var(--danger); }
  .runtime-toast span { min-width: 0; }
  .runtime-toast button {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-dim);
  }
  .runtime-toast button:hover { color: var(--text); background: var(--bg-elevated); }
</style>
