<script lang="ts">
  import Modal from './Modal.svelte';
  import { aiTasks, type AiTask } from '../state/aiTasks.svelte';

  let { onClose, taskId = null }: { onClose: () => void; taskId?: string | null } = $props();

  const task = $derived(aiTasks.find(taskId));
  const detail = $derived(task?.detail.kind === 'workflow' ? task.detail : null);
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  function statusLabel(value: AiTask['status']): string {
    if (value === 'running') return 'Running';
    if (value === 'completed') return 'Completed';
    if (value === 'cancelled') return 'Cancelled';
    return 'Failed';
  }

  function formatTime(value: number | null): string {
    return value === null ? 'In progress' : dateFormatter.format(new Date(value));
  }
</script>

<Modal title="Workflow Task" onClose={onClose} width={480}>
  {#if task && detail}
    <div class="task-details">
      <div class="summary">
        <div class="summary-copy">
          <strong>{task.title}</strong>
          {#if task.subtitle}<span>{task.subtitle}</span>{/if}
        </div>
        <span
          class="status-pill"
          class:running={task.status === 'running'}
          class:completed={task.status === 'completed'}
          class:cancelled={task.status === 'cancelled'}
          class:error={task.status === 'error'}
        >{statusLabel(task.status)}</span>
      </div>

      <section>
        <h3>Current activity</h3>
        <p class="progress" role="status" aria-live="polite">{task.progress || task.subtitle}</p>
      </section>

      <dl>
        <div>
          <dt>Provider</dt>
          <dd>{detail.providerLabel}</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd>{detail.outputName}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>{formatTime(task.startedAt)}</dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>{formatTime(task.completedAt)}</dd>
        </div>
      </dl>

      {#if task.error}
        <section class="error-box">
          <h3>Error</h3>
          <pre>{task.error}</pre>
        </section>
      {/if}

      {#if task.warning}
        <section class="warning-box">
          <h3>Warning</h3>
          <p>{task.warning}</p>
        </section>
      {/if}

      <div class="dlg-actions">
        <span class="dlg-action-spacer"></span>
        {#if aiTasks.canCancel(task)}
          <button type="button" onclick={() => void aiTasks.cancel(task.id)}>Cancel Task</button>
        {/if}
        {#if aiTasks.canRetry(task)}
          <button type="button" class="dlg-primary" onclick={() => aiTasks.retry(task.id)}>Retry</button>
        {/if}
        <button type="button" class:dlg-primary={!aiTasks.canCancel(task) && !aiTasks.canRetry(task)} onclick={onClose}>Close</button>
      </div>
    </div>
  {:else}
    <div class="task-details">
      <p class="missing">This task is no longer available.</p>
      <div class="dlg-actions">
        <span class="dlg-action-spacer"></span>
        <button type="button" class="dlg-primary" onclick={onClose}>Close</button>
      </div>
    </div>
  {/if}
</Modal>

<style>
  .task-details {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
    font-size: 12px;
  }
  .summary {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .summary-copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .summary-copy strong {
    overflow-wrap: anywhere;
    color: var(--text-bright);
    font-size: 13px;
  }
  .summary-copy span,
  .missing {
    color: var(--text-dim);
  }
  .status-pill {
    flex: 0 0 auto;
    padding: 3px 7px;
    color: var(--text-dim);
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-pill.running {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 48%, var(--border-soft));
  }
  .status-pill.completed {
    color: #58c488;
    border-color: color-mix(in srgb, #42b883 48%, var(--border-soft));
  }
  .status-pill.error {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 58%, var(--border-soft));
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h3 {
    margin: 0;
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .progress {
    min-height: 34px;
    margin: 0;
    padding: 9px 10px;
    color: var(--text);
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    overflow-wrap: anywhere;
  }
  dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1px;
    margin: 0;
    overflow: hidden;
    background: var(--border-soft);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
  }
  dl div {
    display: grid;
    grid-template-columns: 62px minmax(0, 1fr);
    gap: 8px;
    padding: 8px 9px;
    background: var(--bg-panel);
  }
  dt {
    color: var(--text-dim);
  }
  dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
    color: var(--text);
  }
  .error-box {
    padding: 9px 10px;
    background: color-mix(in srgb, var(--danger) 10%, var(--bg-input));
    border: 1px solid color-mix(in srgb, var(--danger) 55%, var(--border-soft));
    border-radius: 4px;
  }
  .error-box pre {
    max-height: 160px;
    margin: 0;
    overflow: auto;
    color: var(--danger);
    font: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .warning-box {
    padding: 9px 10px;
    background: color-mix(in srgb, var(--warning, #d6a84b) 10%, var(--bg-input));
    border: 1px solid color-mix(in srgb, var(--warning, #d6a84b) 55%, var(--border-soft));
    border-radius: 4px;
  }
  .warning-box p {
    margin: 0;
    color: var(--warning, #d6a84b);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .dlg-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 2px;
  }
  .dlg-action-spacer {
    flex: 1;
  }
  @media (max-width: 520px) {
    dl {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
