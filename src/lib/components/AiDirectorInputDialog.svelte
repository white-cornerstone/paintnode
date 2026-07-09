<script lang="ts">
  import { onMount } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import Modal from './Modal.svelte';
  import {
    submitAiDirectorInput,
    type AiDirectorInputPayload,
  } from '../integrations/desktop';
  import { aiTasks } from '../state/aiTasks.svelte';

  let queue = $state<AiDirectorInputPayload[]>([]);
  let selected = $state('');
  let customAnswer = $state('');
  let submitting = $state(false);
  let error = $state('');

  const request = $derived(queue[0] ?? null);
  const answer = $derived(customAnswer.trim() || selected);

  onMount(() => {
    let unlisten: UnlistenFn | null = null;
    void listen<AiDirectorInputPayload>('ai-director-input-required', (event) => {
      if (queue.some((item) => item.requestId === event.payload.requestId)) return;
      queue = [...queue, event.payload];
      const task = aiTasks.tasks.find((item) => item.runId === event.payload.runId);
      if (task) aiTasks.setProgress(task.id, 'AI Director is waiting for your answer');
    }).then((stop) => {
      unlisten = stop;
    });
    return () => unlisten?.();
  });

  function advance(): void {
    queue = queue.slice(1);
    selected = '';
    customAnswer = '';
    error = '';
    submitting = false;
  }

  async function respond(cancelled = false): Promise<void> {
    if (!request || submitting) return;
    if (!cancelled && !answer.trim()) {
      error = 'Choose an option or enter an answer.';
      return;
    }
    submitting = true;
    error = '';
    try {
      await submitAiDirectorInput(request, cancelled ? '' : answer.trim(), cancelled);
      advance();
    } catch (cause) {
      error = (cause as Error)?.message ?? String(cause);
      submitting = false;
    }
  }
</script>

{#if request}
  <Modal title={request.provider + ' Director question'} onClose={() => void respond(true)} width={500}>
    <div class="question">{request.question}</div>
    {#if request.options.length}
      <div class="options" role="radiogroup" aria-label="Director answer options">
        {#each request.options as option}
          <label>
            <input
              type="radio"
              name="director-answer"
              value={option}
              checked={selected === option}
              onchange={() => {
                selected = option;
                customAnswer = '';
                error = '';
              }}
            />
            <span>{option}</span>
          </label>
        {/each}
      </div>
    {/if}
    {#if request.allowCustom}
      <label class="custom">
        <span>Custom answer</span>
        <textarea
          rows="3"
          maxlength="1000"
          bind:value={customAnswer}
          oninput={() => {
            if (customAnswer.trim()) selected = '';
            error = '';
          }}
          placeholder="Describe what you want the Director to do"
        ></textarea>
      </label>
    {/if}
    {#if error}
      <div class="error" role="alert">{error}</div>
    {/if}
    <div class="actions">
      <button disabled={submitting} onclick={() => void respond(true)}>Cancel task</button>
      <button
        class="dlg-primary"
        disabled={submitting || !answer.trim()}
        onclick={() => void respond(false)}
      >
        {submitting ? 'Sending...' : 'Continue'}
      </button>
    </div>
  </Modal>
{/if}

<style>
  .question {
    color: var(--text-bright);
    font-size: 13px;
    line-height: 1.5;
  }
  .options {
    display: grid;
    gap: 6px;
    margin-top: 14px;
  }
  .options label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 6px 9px;
    border: 1px solid var(--border-soft);
    border-radius: 5px;
    background: var(--bg-elevated);
    cursor: pointer;
  }
  .options label:hover {
    border-color: var(--border);
  }
  .custom {
    display: grid;
    gap: 6px;
    margin-top: 14px;
    color: var(--text-dim);
    font-size: 12px;
  }
  textarea {
    min-height: 70px;
    padding: 8px;
    color: var(--text);
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 4px;
    font: inherit;
    line-height: 1.4;
  }
  .error {
    margin-top: 10px;
    color: var(--danger);
    font-size: 12px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
  .actions button {
    min-width: 104px;
  }
</style>
