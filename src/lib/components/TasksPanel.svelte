<script lang="ts">
  import Panel from './Panel.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { aiTasks, type AiTask } from '../state/aiTasks.svelte';
  import { Checkmark, Copy, Dismiss, TaskList } from '../icons';

  let { collapsed = $bindable(false) }: { collapsed?: boolean } = $props();

  const runningCount = $derived(aiTasks.tasks.filter((task) => task.status === 'running').length);
  const hasFinished = $derived(aiTasks.tasks.some((task) => task.status !== 'running'));

  function statusLabel(task: AiTask): string {
    if (task.status === 'running') return 'Running';
    if (task.status === 'completed') return 'Completed';
    return 'Failed';
  }

  function openTask(task: AiTask): void {
    aiTasks.open(task.id);
  }
</script>

<Panel title={runningCount > 0 ? `Tasks (${runningCount})` : 'Tasks'} bind:collapsed>
  {#snippet actions()}
    {#if hasFinished}
      <button
        class="clear-finished"
        type="button"
        aria-label="Clear finished tasks"
        use:tooltip={{ text: 'Clear finished tasks', placement: 'left' }}
        onclick={() => aiTasks.clearFinished()}
      >
        <Icon svg={Dismiss} size={13} />
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
          <button
            class="task-row"
            class:running={task.status === 'running'}
            class:completed={task.status === 'completed'}
            class:error={task.status === 'error'}
            type="button"
            aria-label={`Open ${task.title}: ${statusLabel(task)}`}
            onclick={() => openTask(task)}
          >
            <span class="status" aria-hidden="true">
              {#if task.status === 'running'}
                <span class="spinner"></span>
              {:else if task.status === 'completed'}
                <Icon svg={Checkmark} size={13} />
              {:else}
                <Icon svg={Dismiss} size={13} />
              {/if}
            </span>
            <span class="task-main">
              <span class="task-title">{task.title}</span>
              <span class="task-progress">{task.progress || task.subtitle}</span>
            </span>
            {#if task.status === 'error'}
              <Icon svg={Copy} size={13} />
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</Panel>

<style>
  .clear-finished {
    display: grid;
    place-items: center;
    width: 22px;
    height: 20px;
    padding: 0;
    color: var(--text-dim);
    background: transparent;
    border-color: transparent;
  }
  .clear-finished:hover {
    color: var(--text-bright);
    background: var(--bg-input);
    border-color: var(--border-soft);
  }
  .tasks {
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 8px;
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
    grid-template-columns: 18px minmax(0, 1fr) auto;
    align-items: center;
    gap: 7px;
    min-height: 42px;
    padding: 6px 7px;
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    text-align: left;
  }
  .task-row:hover,
  .task-row:focus-visible {
    background: color-mix(in srgb, var(--bg-input) 80%, var(--text-bright) 12%);
    border-color: color-mix(in srgb, var(--border-soft) 70%, var(--accent) 30%);
  }
  .task-row.completed {
    border-color: color-mix(in srgb, #42b883 42%, var(--border-soft));
  }
  .task-row.error {
    border-color: color-mix(in srgb, var(--danger) 58%, var(--border-soft));
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
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
