<script lang="ts">
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { aiTasks, type AiTask } from '../state/aiTasks.svelte';
  import { cancelAiRun } from '../integrations/desktop';
  import { Dismiss } from '../icons';

  /** How long a task may run before we surface the toast. */
  const LONG_RUNNING_AFTER_MS = 5 * 60_000;

  let now = $state(Date.now());
  let dismissed = $state<Record<string, true>>({});
  let stopping = $state<Record<string, true>>({});

  const anyRunning = $derived(aiTasks.tasks.some((task) => task.status === 'running'));

  $effect(() => {
    if (!anyRunning) return;
    now = Date.now();
    const timer = window.setInterval(() => (now = Date.now()), 15_000);
    return () => window.clearInterval(timer);
  });

  const task = $derived(
    aiTasks.tasks.find(
      (candidate) =>
        candidate.status === 'running' &&
        now - candidate.startedAt >= LONG_RUNNING_AFTER_MS &&
        !dismissed[candidate.id],
    ) ?? null,
  );
  const minutes = $derived(task ? Math.max(1, Math.round((now - task.startedAt) / 60_000)) : 0);

  async function stopTask(target: AiTask): Promise<void> {
    if (!target.runId || stopping[target.id]) return;
    stopping = { ...stopping, [target.id]: true };
    aiTasks.setProgress(target.id, 'Stopping...');
    try {
      await cancelAiRun(target.runId);
    } catch (error) {
      aiTasks.setProgress(target.id, 'Stop failed: ' + ((error as Error)?.message ?? String(error)));
      const { [target.id]: _, ...rest } = stopping;
      stopping = rest;
    }
  }
</script>

{#if task}
  <div class="long-running-toast" role="status">
    <span class="message">
      “{task.title}” has been running for {minutes} min — longer than usual.
    </span>
    {#if task.runId}
      <button
        type="button"
        class="stop"
        disabled={stopping[task.id]}
        onclick={() => task && stopTask(task)}
      >
        {stopping[task.id] ? 'Stopping...' : 'Stop task'}
      </button>
    {/if}
    <button
      type="button"
      class="close"
      aria-label="Hide long-running task message"
      use:tooltip={{ text: 'Hide message', placement: 'bottom' }}
      onclick={() => (dismissed = { ...dismissed, [task.id]: true })}
    >
      <Icon svg={Dismiss} size={13} />
    </button>
  </div>
{/if}

<style>
  .long-running-toast {
    position: fixed;
    z-index: 60;
    top: 64px;
    left: 50%;
    transform: translateX(-50%);
    width: fit-content;
    max-width: min(560px, calc(100% - 32px));
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 6px 5px 10px;
    border: 1px solid color-mix(in srgb, var(--border) 78%, #fff 10%);
    border-radius: 6px;
    background: color-mix(in srgb, var(--bg-panel) 92%, transparent);
    color: color-mix(in srgb, var(--text) 82%, #fff 12%);
    font-size: 12px;
    line-height: 18px;
    box-shadow: 0 6px 16px rgb(0 0 0 / 0.18);
  }
  .message {
    min-width: 0;
  }
  .stop {
    flex: none;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 600;
    color: #ffd1d1;
    background: color-mix(in srgb, var(--danger) 26%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 58%, var(--border-soft));
    border-radius: 4px;
  }
  .stop:hover:not(:disabled) {
    color: #fff;
    background: color-mix(in srgb, var(--danger) 45%, transparent);
    border-color: var(--danger);
  }
  .stop:disabled {
    opacity: 0.6;
  }
  .close {
    flex: none;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    color: var(--text-dim);
    background: transparent;
    border: none;
  }
  .close:hover {
    color: var(--text-bright);
    background: var(--bg-elevated);
  }
</style>
