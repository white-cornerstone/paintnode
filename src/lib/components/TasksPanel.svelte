<script lang="ts">
  import Panel from './Panel.svelte';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { aiTasks, type AiTask } from '../state/aiTasks.svelte';
  import { ArrowSync, Broom, Checkmark, Dismiss, TaskList } from '../icons';

  let { collapsed = $bindable(false), grow = false }: { collapsed?: boolean; grow?: boolean } = $props();

  const runningCount = $derived(aiTasks.tasks.filter((task) => task.status === 'running').length);
  const completedCount = $derived(aiTasks.tasks.filter((task) => task.status === 'completed').length);
  const cancelledCount = $derived(aiTasks.tasks.filter((task) => task.status === 'cancelled').length);
  const nonErrorFinishedCount = $derived(completedCount + cancelledCount);
  const erroredCount = $derived(aiTasks.tasks.filter((task) => task.status === 'error').length);

  // Confirmation before a Clear that would also drop failed tasks the user may
  // still want to retry.
  let confirmClear = $state(false);

  function requestClear(): void {
    if (erroredCount > 0) {
      confirmClear = true;
    } else {
      aiTasks.clearCompleted();
    }
  }

  function clearAll(): void {
    aiTasks.clearFinished();
    confirmClear = false;
  }

  function keepFailed(): void {
    aiTasks.clearCompleted();
    confirmClear = false;
  }

  function statusLabel(task: AiTask): string {
    if (task.status === 'running') return 'Running';
    if (task.status === 'completed') return 'Completed';
    if (task.status === 'cancelled') return 'Cancelled';
    return 'Failed';
  }

  function partsLabel(task: AiTask): string {
    const parts = task.partProgress;
    if (!parts) return '';
    if (task.status === 'running' && parts.completed < parts.total) {
      return `, part ${parts.completed + 1} of ${parts.total}`;
    }
    return `, ${parts.completed} of ${parts.total} parts completed`;
  }

  function openTask(task: AiTask): void {
    aiTasks.open(task.id);
  }
</script>

<Panel title={runningCount > 0 ? `Tasks (${runningCount})` : 'Tasks'} {grow} bind:collapsed>
  {#snippet actions()}
    {#if completedCount > 0 || cancelledCount > 0 || erroredCount > 0}
      <button
        class="clear-completed"
        type="button"
        aria-label="Clear finished tasks"
        use:tooltip={{ text: 'Clear finished tasks', placement: 'left' }}
        onclick={requestClear}
      >
        <Icon svg={Broom} size={14} />
      </button>
    {/if}
  {/snippet}

  <div class="tasks">
    {#if aiTasks.tasks.length === 0}
      <div class="empty">
        <Icon svg={TaskList} size={20} />
        <span>AI jobs appear here while they run.</span>
      </div>
    {:else}
      <div class="task-list">
        {#each aiTasks.tasks as task (task.id)}
          <div
            class="task-row"
            class:running={task.status === 'running'}
            class:completed={task.status === 'completed'}
            class:cancelled={task.status === 'cancelled'}
            class:error={task.status === 'error'}
          >
            <button
              class="task-open"
              type="button"
              aria-label={`Open ${task.title}: ${statusLabel(task)}${partsLabel(task)}`}
              onclick={() => openTask(task)}
            >
              <span class="status" aria-hidden="true">
                {#if task.status === 'running'}
                  <span class="spinner"></span>
                {:else if task.status === 'completed'}
                  <Icon svg={Checkmark} size={13} />
                {:else if task.status === 'cancelled'}
                  <Icon svg={Dismiss} size={13} />
                {:else}
                  <Icon svg={Dismiss} size={13} />
                {/if}
              </span>
              <span class="task-main">
                <span class="task-title-row">
                  <span class="task-title">{task.title}</span>
                  {#if task.partProgress && task.partProgress.total > 1}
                    <span
                      class="parts"
                      style:grid-template-columns={`repeat(${Math.min(4, task.partProgress.total)}, 5px)`}
                      aria-hidden="true"
                    >
                      {#each { length: task.partProgress.total } as _, index (index)}
                        <span
                          class="part-block"
                          class:done={index < task.partProgress.completed}
                          class:active={task.status === 'running' && index === task.partProgress.completed}
                        ></span>
                      {/each}
                    </span>
                  {/if}
                </span>
                <span class="task-progress">{task.progress || task.subtitle}</span>
                {#if task.status === 'error' && task.error}
                  <span class="task-error" role="alert">{task.error}</span>
                {/if}
              </span>
            </button>
            {#if task.status === 'running' && aiTasks.canCancel(task)}
              <button
                class="task-action"
                type="button"
                aria-label={`Cancel ${task.title}`}
                use:tooltip={{ text: 'Cancel task', placement: 'left' }}
                onclick={() => void aiTasks.cancel(task.id)}
              >
                <Icon svg={Dismiss} size={13} />
              </button>
            {:else if task.status === 'completed' || task.status === 'cancelled'}
              <button
                class="task-action"
                type="button"
                aria-label={`Clear ${task.status === 'cancelled' ? 'cancelled ' : ''}${task.title}`}
                use:tooltip={{ text: task.status === 'cancelled' ? 'Clear cancelled task' : 'Clear task', placement: 'left' }}
                onclick={() => aiTasks.clearCompletedTask(task.id)}
              >
                <Icon svg={Dismiss} size={13} />
              </button>
            {:else if task.status === 'error'}
              <div class="task-actions">
                {#if aiTasks.canRetry(task)}
                  <button
                    class="task-action"
                    type="button"
                    aria-label={`Retry ${task.title}`}
                    use:tooltip={{ text: 'Retry task', placement: 'left' }}
                    onclick={() => aiTasks.retry(task.id)}
                  >
                    <Icon svg={ArrowSync} size={13} />
                  </button>
                {/if}
                <button
                  class="task-action"
                  type="button"
                  aria-label={`Dismiss ${task.title}`}
                  use:tooltip={{ text: 'Dismiss task', placement: 'left' }}
                  onclick={() => aiTasks.dismissErrorTask(task.id)}
                >
                  <Icon svg={Dismiss} size={13} />
                </button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</Panel>

{#if confirmClear}
  <Modal title="Clear Tasks" onClose={() => (confirmClear = false)} width={420}>
    <p class="confirm-text">
      {#if nonErrorFinishedCount > 0}
        This clears {nonErrorFinishedCount} completed or cancelled
        {nonErrorFinishedCount === 1 ? 'task' : 'tasks'}. Also dismiss {erroredCount} failed
        {erroredCount === 1 ? 'task' : 'tasks'}?
      {:else}
        Dismiss {erroredCount} failed {erroredCount === 1 ? 'task' : 'tasks'}?
      {/if}
    </p>
    <p class="confirm-note">Dismissed failed tasks can no longer be retried.</p>
    <div class="dlg-actions">
      {#if nonErrorFinishedCount > 0}
        <button type="button" onclick={keepFailed}>Keep Failed</button>
      {/if}
      <button type="button" onclick={() => (confirmClear = false)}>Cancel</button>
      <button type="button" class="dlg-primary" onclick={clearAll}>
        {nonErrorFinishedCount > 0 ? 'Clear All' : 'Dismiss All'}
      </button>
    </div>
  </Modal>
{/if}

<style>
  .clear-completed {
    display: grid;
    place-items: center;
    width: 24px;
    height: 22px;
    padding: 0;
    color: var(--text-dim);
    background: var(--bg-input);
    border-color: var(--border-soft);
  }
  .clear-completed:hover {
    color: var(--text-bright);
    background: var(--bg-input);
    border-color: var(--border-soft);
  }
  .tasks {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    padding: 8px;
    overflow-y: auto;
  }
  .empty {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    color: var(--text-dim);
    font-size: 11px;
  }
  .task-list {
    display: grid;
    gap: 6px;
  }
  .task-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 4px;
    min-height: 42px;
    padding: 0 6px 0 0;
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    overflow: hidden;
  }
  .task-row:hover {
    background: color-mix(in srgb, var(--bg-input) 80%, var(--text-bright) 12%);
    border-color: color-mix(in srgb, var(--border-soft) 70%, var(--accent) 30%);
  }
  .task-row:focus-within {
    border-color: color-mix(in srgb, var(--border-soft) 55%, var(--accent) 45%);
  }
  .task-row.completed {
    border-color: color-mix(in srgb, #42b883 42%, var(--border-soft));
  }
  .task-row.cancelled {
    border-color: color-mix(in srgb, var(--text-dim) 58%, var(--border-soft));
  }
  .task-row.error {
    border-color: color-mix(in srgb, var(--danger) 58%, var(--border-soft));
  }
  .task-open {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    align-items: center;
    gap: 7px;
    min-width: 0;
    min-height: 42px;
    padding: 6px 7px;
    background: transparent;
    border: 0;
    border-radius: 0;
    text-align: left;
  }
  .task-open:hover,
  .task-open:focus-visible {
    background: transparent;
  }
  .task-actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .task-action {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    color: var(--text-dim);
    background: transparent;
    border-color: transparent;
  }
  .task-action:hover,
  .task-action:focus-visible {
    color: var(--text-bright);
    background: var(--bg-elevated);
    border-color: var(--border-soft);
  }
  .status {
    display: grid;
    place-items: center;
    color: var(--text-dim);
  }
  .task-row.running .status {
    color: var(--accent);
  }
  .task-row.completed .status {
    color: #58c488;
  }
  .task-row.error .status {
    color: var(--danger);
  }
  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid color-mix(in srgb, var(--accent) 22%, transparent);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  .task-main {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .task-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    min-width: 0;
  }
  .parts {
    display: grid;
    gap: 2px;
    grid-auto-rows: 5px;
    flex: none;
  }
  .part-block {
    width: 5px;
    height: 5px;
    border-radius: 1px;
    background: color-mix(in srgb, var(--text-dim) 32%, transparent);
  }
  .part-block.done {
    background: #58c488;
  }
  .part-block.active {
    background: var(--accent);
    animation: part-pulse 1.2s ease-in-out infinite;
  }
  @keyframes part-pulse {
    50% {
      opacity: 0.35;
    }
  }
  .task-title,
  .task-progress {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .task-title {
    color: var(--text);
    font-size: 12px;
    font-weight: 700;
  }
  .task-progress {
    color: var(--text-dim);
    font-size: 11px;
  }
  .task-error {
    color: color-mix(in srgb, var(--danger) 78%, var(--text-bright));
    font-size: 11px;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .confirm-text {
    margin: 0;
    color: var(--text-bright);
    font-size: 13px;
    line-height: 1.45;
  }
  .confirm-note {
    margin: 8px 0 16px;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.45;
  }
</style>
