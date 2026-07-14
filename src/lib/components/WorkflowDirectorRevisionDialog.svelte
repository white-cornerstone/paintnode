<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { ArrowSync, CheckmarkCircle, ErrorCircle } from '../icons';
  import { createProviderFreeWorkflowRevisionRequester } from '../integrations/providerFreeWorkflowRevision';
  import { aiTasks } from '../state/aiTasks.svelte';
  import { project } from '../state/project.svelte';
  import { workflow } from '../state/workflow.svelte';
  import { createWorkflowDirectorRevisionHistoryState } from '../workflow/directorRevisionHistory.svelte';
  import {
    WorkflowDirectorRevisionCancelledError,
    acceptWorkflowDirectorRevisionPreview,
    createWorkflowDirectorRevisionViewModel,
    rejectWorkflowDirectorRevisionPreview,
    requestWorkflowDirectorRevisionPreview,
    workflowDirectorRevisionPreviewIsCurrent,
    type WorkflowDirectorRevisionPreview,
    type WorkflowDirectorRevisionRequester,
  } from '../workflow';

  let {
    onClose,
    requester = createProviderFreeWorkflowRevisionRequester(),
    initialInstruction = 'Refine this workflow while preserving accepted candidates and run history.',
    title = 'Revise current workflow',
  }: {
    onClose: () => void;
    requester?: WorkflowDirectorRevisionRequester;
    initialInstruction?: string;
    title?: string;
  } = $props();

  let instruction = $state(untrack(() => initialInstruction));
  let preview = $state<WorkflowDirectorRevisionPreview | null>(null);
  let requesting = $state(false);
  let error = $state('');
  let historyStatus = $state('No revision has been accepted in this review session.');
  let controller: AbortController | null = null;
  let activeTaskId: string | null = null;
  let requestEpoch = 0;

  const view = $derived(preview ? createWorkflowDirectorRevisionViewModel(preview.result) : null);
  const previewCurrent = $derived(preview
    ? workflowDirectorRevisionPreviewIsCurrent(preview, workflow, instruction)
    : false);
  const revisionHistory = createWorkflowDirectorRevisionHistoryState(workflow);

  $effect(() => {
    if (!preview || preview.instruction === instruction.trim()) return;
    rejectWorkflowDirectorRevisionPreview(preview, workflow);
    preview = null;
    error = 'The revision instruction changed. Request a current preview before accepting.';
    historyStatus = 'Stale revision preview discarded; the workflow was not changed.';
  });

  function discardPreview(): void {
    if (preview) rejectWorkflowDirectorRevisionPreview(preview, workflow);
    preview = null;
  }

  function cancelRequest(status = 'Revision request cancelled; the workflow was not changed.'): void {
    requestEpoch += 1;
    const taskId = activeTaskId;
    activeTaskId = null;
    controller?.abort();
    controller = null;
    requesting = false;
    if (taskId) {
      aiTasks.setCancel(taskId, null);
      aiTasks.markCancelled(taskId, 'Director revision cancelled');
    }
    if (status) historyStatus = status;
  }

  async function requestRevision(): Promise<void> {
    if (!instruction.trim()) {
      error = 'Describe the revision before requesting a preview.';
      return;
    }
    cancelRequest('');
    discardPreview();
    const currentController = new AbortController();
    const epoch = ++requestEpoch;
    controller = currentController;
    requesting = true;
    error = '';
    historyStatus = requester.providerFree
      ? 'Preparing a provider-free revision preview…'
      : 'Preparing a configured Director revision preview…';
    const task = aiTasks.create({
      projectPath: project.path,
      kind: 'workflow',
      title: `AI Director: ${title}`,
      subtitle: requester.label,
      progress: historyStatus,
      detail: { kind: 'workflow', providerLabel: requester.label, outputName: title },
    });
    activeTaskId = task.id;
    aiTasks.setCancel(task.id, async () => currentController.abort());
    try {
      const result = await requestWorkflowDirectorRevisionPreview(
        requester,
        workflow,
        instruction,
        currentController.signal,
      );
      if (epoch !== requestEpoch || currentController.signal.aborted) return;
      preview = result;
      historyStatus = result.result.proposal
        ? 'Revision preview ready. Review every change before accepting.'
        : 'Revision response failed validation; the workflow was not changed.';
      if (result.result.proposal) aiTasks.complete(task.id, 'Director revision ready for review');
      else aiTasks.fail(task.id, 'The Director revision failed workflow validation.');
    } catch (caught) {
      if (epoch !== requestEpoch) return;
      if (caught instanceof WorkflowDirectorRevisionCancelledError) {
        aiTasks.markCancelled(task.id, 'Director revision cancelled');
        return;
      }
      error = caught instanceof Error ? caught.message : String(caught);
      historyStatus = 'Revision request failed; the workflow was not changed.';
      aiTasks.fail(task.id, error);
    } finally {
      if (epoch === requestEpoch) {
        aiTasks.setCancel(task.id, null);
        if (activeTaskId === task.id) activeTaskId = null;
        controller = null;
        requesting = false;
      }
    }
  }

  function rejectRevision(): void {
    if (!preview) return;
    rejectWorkflowDirectorRevisionPreview(preview, workflow);
    preview = null;
    error = '';
    historyStatus = 'Revision rejected; the workflow was not changed.';
  }

  function acceptRevision(): void {
    if (!preview) return;
    try {
      const accepted = acceptWorkflowDirectorRevisionPreview(preview, workflow, instruction);
      preview = null;
      error = '';
      historyStatus = `Accepted as one transaction: ${accepted.patch.summary}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
      historyStatus = 'Revision acceptance was rejected; request a current preview.';
    }
  }

  function undoRevision(): void {
    historyStatus = workflow.undoDirectorPatch()
      ? 'Accepted revision undone. Redo is available.'
      : 'Nothing current can be undone.';
  }

  function redoRevision(): void {
    historyStatus = workflow.redoDirectorPatch()
      ? 'Revision reapplied. Undo is available.'
      : 'Nothing current can be redone.';
  }

  function closeDialog(): void {
    cancelRequest('');
    discardPreview();
    onClose();
  }

  onDestroy(() => {
    cancelRequest('');
    if (preview) rejectWorkflowDirectorRevisionPreview(preview, workflow);
  });
</script>

<Modal {title} onClose={closeDialog} width={760} height={650} minWidth={560} minHeight={480} resizable>
  <div class="revision-dialog">
    <section class="request-panel" aria-labelledby="revision-request-heading">
      <div class="heading" id="revision-request-heading">
        <Icon svg={ArrowSync} size={18} />
        <span><strong>Current-workflow revision</strong><small>This edits the open graph through a reviewable patch. It never creates a fresh replacement workflow.</small></span>
      </div>

      {#if requester.providerFree}
        <div class="qa-banner" role="status">
          <strong>QA Fake · provider-free</strong>
          <span>Deterministic revision fixture. No discovery, sign-in, AI provider, or image execution is invoked.</span>
        </div>
      {:else}
        <div class="qa-banner configured" role="status">
          <strong>{requester.label}</strong>
          <span>Configured Director revision only. No image executor runs; every returned patch still requires review and acceptance.</span>
        </div>
      {/if}

      <label for="workflow-revision-instruction">Revision instruction</label>
      <textarea
        id="workflow-revision-instruction"
        bind:value={instruction}
        disabled={requesting}
        maxlength="1000"
        placeholder="Describe what should change in the current workflow…"
      ></textarea>
      <small>{instruction.length} / 1,000 characters</small>

      {#if error}<p class="notice error" role="alert">{error}</p>{/if}

      <div class="request-actions">
        <button type="button" onclick={closeDialog}>Close</button>
        {#if requesting}
          <button type="button" class="danger" onclick={() => cancelRequest()}>Cancel request</button>
        {:else}
          <button type="button" class="primary" onclick={() => void requestRevision()}>
            <Icon svg={ArrowSync} size={14} />
            {preview ? 'Request again' : requester.providerFree ? 'Preview QA Fake revision' : 'Preview Director revision'}
          </button>
        {/if}
      </div>
    </section>

    <section class="preview-panel" aria-label="Revision preview" aria-live="polite" aria-busy={requesting}>
      {#if requesting}
        <div class="empty-preview"><Icon svg={ArrowSync} size={24} /><strong>Preparing revision preview…</strong><span>The current workflow remains unchanged.</span></div>
      {:else if view}
        <div class="proposal-heading">
          <span><strong>{view.summary}</strong><small>{view.canAccept && previewCurrent ? 'Validated against the current graph revision.' : view.canAccept ? 'The workflow changed after this preview. Request it again.' : 'Rejected before acceptance.'}</small></span>
          <span class:valid={view.canAccept && previewCurrent} class="status-chip">{view.canAccept ? previewCurrent ? 'Ready to review' : 'Stale preview' : 'Invalid'}</span>
        </div>

        <section class="change-section" aria-labelledby="revision-operations-heading">
          <h3 id="revision-operations-heading">Patch operations <span>{view.operations.length}</span></h3>
          {#if view.operations.length}
            <ol class="change-list">
              {#each view.operations as operation}
                <li><code>{operation.index}. {operation.kind}</code><span><b>{operation.label}</b><small>{operation.detail}</small></span></li>
              {/each}
            </ol>
          {:else}<p class="empty-row">No valid operations.</p>{/if}
        </section>

        <div class="change-grid">
          <section class="change-section" aria-labelledby="revision-nodes-heading">
            <h3 id="revision-nodes-heading">Node changes <span>{view.nodeChanges.length}</span></h3>
            {#if view.nodeChanges.length}<ul class="change-list">{#each view.nodeChanges as change}<li><code>{change.kind}</code><span><b>{change.title}</b><small>{change.detail}</small></span></li>{/each}</ul>{:else}<p class="empty-row">No node changes.</p>{/if}
          </section>
          <section class="change-section" aria-labelledby="revision-connections-heading">
            <h3 id="revision-connections-heading">Connection changes <span>{view.connectionChanges.length}</span></h3>
            {#if view.connectionChanges.length}<ul class="change-list">{#each view.connectionChanges as change}<li><code>{change.kind}</code><span><b>{change.edgeId}</b><small>{change.source.nodeId}.{change.source.portId} → {change.target.nodeId}.{change.target.portId}</small></span></li>{/each}</ul>{:else}<p class="empty-row">No connection changes.</p>{/if}
          </section>
          <section class="change-section" aria-labelledby="revision-requirements-heading">
            <h3 id="revision-requirements-heading">Requirement changes <span>{view.requirementChanges.length}</span></h3>
            {#if view.requirementChanges.length}<ul class="change-list">{#each view.requirementChanges as change}<li><Icon svg={change.after === 'ready' ? CheckmarkCircle : ErrorCircle} size={13} /><span><b>{change.nodeTitle}: {change.portLabel}</b><small>{change.before} → {change.after}</small></span></li>{/each}</ul>{:else}<p class="empty-row">No requirement changes.</p>{/if}
          </section>
          <section class="change-section" aria-labelledby="revision-stale-heading">
            <h3 id="revision-stale-heading">Downstream stale impact <span>{view.downstreamStaleness.length}</span></h3>
            {#if view.downstreamStaleness.length}<ul class="change-list">{#each view.downstreamStaleness as change}<li><Icon svg={ErrorCircle} size={13} /><span><b>{change.nodeTitle}</b><small>{change.reason}</small></span></li>{/each}</ul>{:else}<p class="empty-row">No downstream results become stale.</p>{/if}
          </section>
        </div>

        <section class:invalid={view.validationIssues.length > 0} class="change-section" aria-labelledby="revision-validation-heading">
          <h3 id="revision-validation-heading">Validation issues <span>{view.validationIssues.length}</span></h3>
          {#if view.validationIssues.length}<ul>{#each view.validationIssues as issue}<li><code>{issue.code}</code> {issue.path}: {issue.message}</li>{/each}</ul>{:else}<p class="empty-row">No validation issues.</p>{/if}
        </section>

        <div class="preview-actions">
          <button type="button" onclick={rejectRevision}>Reject revision</button>
          <button type="button" class="primary" disabled={!view.canAccept || !previewCurrent} onclick={acceptRevision}>Accept revision as one transaction</button>
        </div>
      {:else}
        <div class="empty-preview"><Icon svg={ArrowSync} size={24} /><strong>No revision preview yet</strong><span>Enter an instruction to inspect the exact patch and its downstream impact.</span></div>
      {/if}

      <section class="history" aria-labelledby="revision-history-heading">
        <span><strong id="revision-history-heading">Revision transaction</strong><small role="status">{historyStatus}</small></span>
        <div>
          <button type="button" disabled={!revisionHistory.canUndo} onclick={undoRevision}>Undo revision</button>
          <button type="button" disabled={!revisionHistory.canRedo} onclick={redoRevision}>Redo revision</button>
        </div>
      </section>
    </section>
  </div>
</Modal>

<style>
  .revision-dialog { display: grid; grid-template-columns: 260px minmax(0, 1fr); height: 100%; min-height: 0; color: var(--text); font-size: 12px; }
  .request-panel, .preview-panel { min-height: 0; overflow: auto; padding: 14px; }
  .request-panel { display: flex; flex-direction: column; gap: 11px; border-right: 1px solid var(--border); background: color-mix(in srgb, var(--bg-panel) 90%, #232427); }
  .preview-panel { display: flex; flex-direction: column; gap: 10px; }
  .heading, .proposal-heading, .history { display: flex; align-items: flex-start; justify-content: space-between; gap: 9px; }
  .heading > span, .proposal-heading > span:first-child, .history > span, .change-list li > span { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
  small { color: var(--text-dim); font-size: 10px; line-height: 1.35; }
  label { color: var(--text-dim); font-size: 10px; font-weight: 700; text-transform: uppercase; }
  textarea { min-height: 132px; resize: vertical; font: inherit; line-height: 1.45; }
  .qa-banner, .notice, .change-section, .history { padding: 9px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg-panel); line-height: 1.4; }
  .qa-banner { display: flex; flex-direction: column; gap: 3px; background: color-mix(in srgb, var(--accent) 9%, var(--bg-input)); }
  .qa-banner strong { color: var(--accent); }
  .error, .invalid { border-color: color-mix(in srgb, #ff9d9d 46%, var(--border)); }
  .request-actions, .preview-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: auto; }
  button { min-height: 28px; }
  button.primary { display: inline-flex; align-items: center; gap: 6px; background: var(--accent); color: white; }
  button.danger { color: #ffc4c4; }
  button:disabled { opacity: 0.45; }
  .empty-preview { display: flex; flex: 1; min-height: 180px; align-items: center; justify-content: center; flex-direction: column; gap: 7px; color: var(--text-dim); text-align: center; }
  .proposal-heading { align-items: flex-start; }
  .status-chip { flex: none; padding: 3px 7px; border-radius: 999px; background: #583638; color: #ffc4c4; font-size: 10px; font-weight: 700; }
  .status-chip.valid { background: #294b39; color: #bff6d0; }
  .change-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 9px; }
  h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 7px; font-size: 11px; }
  h3 span { color: var(--text-dim); font-weight: 400; }
  ul, ol { margin: 0; padding-left: 18px; }
  .change-list { display: flex; flex-direction: column; gap: 6px; padding: 0; list-style: none; }
  .change-list li { display: flex; align-items: flex-start; gap: 6px; }
  code { border-radius: 3px; padding: 1px 4px; background: #26272a; color: #bfc8ff; font-size: 10px; }
  .empty-row { margin: 0; color: var(--text-dim); font-size: 10px; }
  .history { align-items: center; margin-top: auto; }
  .history > div { display: flex; gap: 7px; }
  @media (max-width: 680px) {
    .revision-dialog { grid-template-columns: 1fr; overflow: auto; }
    .request-panel { border-right: 0; border-bottom: 1px solid var(--border); }
    .change-grid { grid-template-columns: 1fr; }
  }
</style>
