<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { CheckmarkCircle, ErrorCircle, Sparkle } from '../icons';
  import type { ProjectAsset } from '../integrations/desktop';
  import {
    createConfiguredWorkflowDirector,
    createProviderFreeWorkflowDirector,
    type CancellableWorkflowDirector,
  } from '../integrations/workflowDirectorAdapters';
  import { aiTasks } from '../state/aiTasks.svelte';
  import { project } from '../state/project.svelte';
  import { cloneAiRunOptions, type AiDirectorProvider, type AiRunOptions } from '../state/settings';
  import { workflow } from '../state/workflow.svelte';
  import {
    acceptDirectorProposalPreview,
    buildWorkflowDirectorContext,
    rejectDirectorProposalPreview,
    requestDirectorProposalPreview,
    workflowDirectorProviderSelection,
    workflowDirectorRequestKey,
    type WorkflowDirectorAssetInput,
    type WorkflowDirectorProposalPreview,
    type WorkflowDirectorRequestedOutput,
    type WorkflowQaMode,
  } from '../workflow';

  let {
    assets,
    runOptions,
    desktop,
    qaMode,
    qaModeResolved,
    imageCapabilityAvailable,
    imageCapabilityReason,
    onClose,
  }: {
    assets: readonly ProjectAsset[];
    runOptions: AiRunOptions;
    desktop: boolean;
    qaMode: WorkflowQaMode;
    qaModeResolved: boolean;
    imageCapabilityAvailable: boolean;
    imageCapabilityReason: string | null;
    onClose: () => void;
  } = $props();

  const configuredProviders = ['codex', 'claude', 'antigravity'] as const;
  const outputs: readonly WorkflowDirectorRequestedOutput[] = [
    { id: 'square', name: 'Square 1:1', width: 1024, height: 1024 },
    { id: 'portrait', name: 'Portrait 4:5', width: 1024, height: 1280 },
    { id: 'landscape', name: 'Landscape 16:9', width: 1280, height: 720 },
  ];
  let localRunOptions = $state(untrack(() => cloneAiRunOptions(runOptions)));
  let brief = $state(workflow.prompt.trim() || 'Build a cohesive creative campaign from the available project assets.');
  let outputEnabled = $state<Record<string, boolean>>({ square: true, portrait: true, landscape: true });
  let preview = $state<WorkflowDirectorProposalPreview | null>(null);
  let drafting = $state(false);
  let error = $state('');
  let activeDirector: CancellableWorkflowDirector | null = null;
  let activeTaskId: string | null = null;
  let requestEpoch = 0;

  const selection = $derived(workflowDirectorProviderSelection(
    qaModeResolved,
    qaMode,
    desktop,
    localRunOptions.directorProvider,
  ));
  const proposal = $derived(preview?.result.proposal ?? null);

  function providerName(provider: AiDirectorProvider): string {
    if (provider === 'codex') return 'Codex';
    if (provider === 'claude') return 'Claude';
    return 'Antigravity';
  }

  function directorAssetMetadata(asset: ProjectAsset): WorkflowDirectorAssetInput {
    return {
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      mime: asset.mime ?? null,
      width: asset.width ?? null,
      height: asset.height ?? null,
      exists: asset.exists,
    };
  }

  function selectedOutputs(): WorkflowDirectorRequestedOutput[] {
    return outputs.filter((output) => outputEnabled[output.id]);
  }

  function directorRequestSource(): string {
    return `${selection.provider}:${qaMode ?? 'standard'}`;
  }

  function directorContext() {
    return buildWorkflowDirectorContext({
      brief,
      assets: assets.map((asset) => directorAssetMetadata(asset)),
      requestedOutputs: selectedOutputs(),
      capabilities: [
        {
          id: 'generate',
          available: selection.qaFake || imageCapabilityAvailable,
          reason: selection.qaFake || imageCapabilityAvailable
            ? null
            : imageCapabilityReason ?? 'No configured image executor is available for Generate.',
        },
        {
          id: 'candidate-review',
          available: false,
          reason: 'AI candidate review is not executable in this milestone.',
        },
      ],
    });
  }

  const liveRequestKey = $derived(workflowDirectorRequestKey(directorContext(), directorRequestSource()));

  $effect(() => {
    if (!preview || preview.requestKey === liveRequestKey) return;
    preview = null;
    error = 'The Director request changed. Draft a fresh proposal before accepting.';
  });

  function chooseProvider(provider: AiDirectorProvider): void {
    localRunOptions = { ...localRunOptions, directorProvider: provider };
    preview = null;
    error = '';
  }

  async function draftProposal(): Promise<void> {
    const requestedOutputs = selectedOutputs();
    if (!brief.trim()) {
      error = 'Describe the creative outcome before asking the Director to draft.';
      return;
    }
    if (requestedOutputs.length === 0) {
      error = 'Select at least one requested output.';
      return;
    }
    if (!selection.ready) {
      error = selection.reason ?? 'The selected Director is unavailable.';
      return;
    }
    const context = directorContext();
    const director = selection.qaFake
      ? createProviderFreeWorkflowDirector()
      : createConfiguredWorkflowDirector(localRunOptions);
    const epoch = ++requestEpoch;
    activeDirector = director;
    drafting = true;
    preview = null;
    error = '';
    const graph = workflow.graphSnapshot();
    const task = aiTasks.create({
      projectPath: project.path,
      kind: 'workflow',
      title: 'AI Director: Draft workflow',
      subtitle: selection.label,
      progress: 'Drafting and validating a workflow proposal…',
      detail: {
        kind: 'workflow',
        providerLabel: selection.label,
        outputName: 'Workflow proposal',
        workflowId: graph.id,
        nodeIds: graph.nodes.map((node) => node.id),
      },
    });
    activeTaskId = task.id;
    aiTasks.setCancel(task.id, async () => {
      await director.cancel();
      if (aiTasks.find(task.id)?.status === 'running') {
        aiTasks.markCancelled(task.id, 'Workflow drafting cancelled');
      }
    });
    try {
      const result = await requestDirectorProposalPreview(director, context, workflow, {
        requestSource: directorRequestSource(),
      });
      if (epoch === requestEpoch && aiTasks.find(task.id)?.status === 'running') {
        preview = result;
        if (result.result.proposal) aiTasks.complete(task.id, 'Workflow proposal ready for review');
        else aiTasks.fail(task.id, 'The Director response failed workflow validation.');
      }
    } catch (caught) {
      if (epoch === requestEpoch) {
        if (aiTasks.find(task.id)?.status === 'running') {
          error = caught instanceof Error ? caught.message : String(caught);
          if (/cancelled|stopped/i.test(error)) aiTasks.markCancelled(task.id, 'Workflow drafting cancelled');
          else aiTasks.fail(task.id, error);
        }
      } else if (aiTasks.find(task.id)?.status === 'running') {
        aiTasks.markCancelled(task.id, 'Workflow drafting cancelled');
      }
    } finally {
      aiTasks.setCancel(task.id, null);
      if (activeTaskId === task.id) activeTaskId = null;
      if (epoch === requestEpoch) {
        activeDirector = null;
        drafting = false;
      }
    }
  }

  function rejectProposal(): void {
    if (preview) rejectDirectorProposalPreview(preview);
    preview = null;
    error = '';
  }

  function acceptProposal(): void {
    if (!preview) return;
    try {
      acceptDirectorProposalPreview(preview, workflow, liveRequestKey);
      preview = null;
      onClose();
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  function closeDialog(): void {
    requestEpoch += 1;
    const director = activeDirector;
    const taskId = activeTaskId;
    activeDirector = null;
    activeTaskId = null;
    drafting = false;
    if (director) void director.cancel();
    if (taskId && aiTasks.find(taskId)?.status === 'running') {
      aiTasks.setCancel(taskId, null);
      aiTasks.markCancelled(taskId, 'Workflow drafting cancelled');
    }
    onClose();
  }

  onDestroy(() => {
    if (activeDirector) void activeDirector.cancel();
    if (activeTaskId && aiTasks.find(activeTaskId)?.status === 'running') {
      aiTasks.setCancel(activeTaskId, null);
      aiTasks.markCancelled(activeTaskId, 'Workflow drafting cancelled');
    }
  });
</script>

<Modal title="Draft with AI Director" onClose={closeDialog} width={680} height={620} minWidth={520} minHeight={460} resizable>
  <div class="director-dialog">
    <section class="request-panel" aria-label="Director request">
      <div class="intro">
        <Icon svg={Sparkle} size={18} />
        <span><strong>Creative Blueprint</strong><small>The Director drafts a validated workflow. It does not generate images or modify the board until you accept.</small></span>
      </div>

      {#if selection.qaFake}
        <div class="qa-banner" role="status"><strong>QA Fake</strong> Deterministic provider-free drafting; no discovery, sign-in, or command is invoked.</div>
      {:else}
        <fieldset class="provider-picker" disabled={drafting}>
          <legend>Configured Director</legend>
          {#each configuredProviders as provider}
            <label class:active={localRunOptions.directorProvider === provider}>
              <input
                type="radio"
                name="workflow-director-provider"
                value={provider}
                checked={localRunOptions.directorProvider === provider}
                onchange={() => chooseProvider(provider)}
              />
              {providerName(provider)}
            </label>
          {/each}
        </fieldset>
      {/if}

      <label class="brief-field">
        Creative brief
        <textarea bind:value={brief} disabled={drafting} placeholder="Outcome, audience, brand cues, and non-negotiables…"></textarea>
      </label>

      <fieldset class="output-picker" disabled={drafting}>
        <legend>Requested outputs</legend>
        {#each outputs as output}
          <label>
            <input type="checkbox" bind:checked={outputEnabled[output.id]} />
            <span>{output.name}<small>{output.width} x {output.height}</small></span>
          </label>
        {/each}
      </fieldset>

      {#if !selection.ready && selection.reason}<p class="notice error" role="status">{selection.reason}</p>{/if}
      {#if error}<p class="notice error" role="alert">{error}</p>{/if}

      <div class="request-actions">
        <button type="button" onclick={closeDialog}>Cancel</button>
        <button type="button" class="primary" disabled={drafting || !selection.ready} onclick={() => void draftProposal()}>
          <Icon svg={Sparkle} size={14} />
          {drafting ? `Drafting with ${selection.label}…` : preview ? 'Draft again' : 'Draft proposal'}
        </button>
      </div>
    </section>

    <section class="preview-panel" aria-label="Director proposal preview" aria-live="polite">
      {#if drafting}
        <div class="empty-preview"><Icon svg={Sparkle} size={24} /><strong>Drafting the workflow…</strong><span>PaintNode will validate the full GraphDraft before showing it here.</span></div>
      {:else if preview?.result.schemaIssues.length}
        <div class="validation-block invalid">
          <h3><Icon svg={ErrorCircle} size={15} /> Invalid GraphDraft</h3>
          <p>The response was rejected before any workflow was constructed.</p>
          <ul>{#each preview.result.schemaIssues as issue}<li><code>{issue.path}</code> {issue.message}</li>{/each}</ul>
        </div>
      {:else if proposal}
        <div class="proposal-heading">
          <span><strong>{proposal.graph.metadata.name}</strong><small>{proposal.summary}</small></span>
          <span class:valid={proposal.canAccept} class="status-chip">{proposal.canAccept ? 'Validated' : 'Needs changes'}</span>
        </div>

        <div class="preview-grid">
          <div class="preview-section">
            <h3>Creator nodes <span>{proposal.nodes.length}</span></h3>
            <ol class="node-list">
              {#each proposal.nodes as node}<li><code>{node.type}</code><span>{node.title}</span></li>{/each}
            </ol>
          </div>
          <div class="preview-section">
            <h3>Requirements</h3>
            <ul class="requirement-list">
              {#each proposal.requirements as requirement}
                <li class:ready={requirement.status === 'ready'}>
                  <Icon svg={requirement.status === 'ready' ? CheckmarkCircle : ErrorCircle} size={13} />
                  <span><b>{requirement.label}</b><small>{requirement.detail}</small></span>
                </li>
              {/each}
            </ul>
          </div>
        </div>

        {#if proposal.unsupportedCapabilities.length}
          <div class="validation-block invalid">
            <h3>Unsupported capabilities</h3>
            <ul>{#each proposal.unsupportedCapabilities as item}<li><code>{item.capability}</code> {item.reason}</li>{/each}</ul>
          </div>
        {/if}
        {#if proposal.issues.length}
          <div class="validation-block invalid">
            <h3>Validation issues</h3>
            <ul>{#each proposal.issues as issue}<li><code>{issue.stage}</code> {issue.message}</li>{/each}</ul>
          </div>
        {/if}

        <div class="preview-actions">
          <button type="button" onclick={rejectProposal}>Reject proposal</button>
          <button type="button" class="primary" disabled={!proposal.canAccept} onclick={acceptProposal}>Accept and replace workflow</button>
        </div>
      {:else}
        <div class="empty-preview"><Icon svg={Sparkle} size={24} /><strong>No proposal yet</strong><span>Choose the requested outputs, then draft. Your current workflow remains untouched during preview.</span></div>
      {/if}
    </section>
  </div>
</Modal>

<style>
  .director-dialog {
    display: grid;
    grid-template-columns: 250px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    color: var(--text);
    font-size: 12px;
  }
  .request-panel,
  .preview-panel {
    min-height: 0;
    overflow: auto;
    padding: 14px;
  }
  .request-panel {
    display: flex;
    flex-direction: column;
    gap: 13px;
    border-right: 1px solid var(--border);
    background: color-mix(in srgb, var(--bg-panel) 90%, #232427);
  }
  .preview-panel {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .intro {
    display: flex;
    gap: 9px;
    align-items: flex-start;
  }
  .intro > span,
  .proposal-heading > span:first-child,
  .requirement-list span {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 3px;
  }
  small {
    color: var(--text-dim);
    font-size: 10px;
    line-height: 1.35;
  }
  fieldset {
    margin: 0;
    padding: 0;
    border: 0;
  }
  legend,
  .brief-field {
    margin-bottom: 6px;
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .provider-picker,
  .output-picker {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .provider-picker label,
  .output-picker label {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 28px;
    padding: 3px 7px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text);
    cursor: pointer;
  }
  .provider-picker label.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-input));
  }
  .output-picker label > span {
    display: flex;
    flex: 1;
    justify-content: space-between;
    gap: 8px;
  }
  .brief-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  textarea {
    min-height: 96px;
    resize: vertical;
    font: inherit;
    line-height: 1.4;
    text-transform: none;
  }
  .qa-banner,
  .notice,
  .validation-block {
    margin: 0;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-input));
    line-height: 1.4;
  }
  .qa-banner strong { color: var(--accent); }
  .error,
  .invalid { border-color: color-mix(in srgb, #ff9d9d 46%, var(--border)); }
  .request-actions,
  .preview-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: auto;
  }
  button {
    min-height: 28px;
  }
  button.primary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--accent);
    color: white;
  }
  button.primary:disabled { opacity: 0.45; }
  .empty-preview {
    display: flex;
    flex: 1;
    min-height: 220px;
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 7px;
    color: var(--text-dim);
    text-align: center;
  }
  .proposal-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  .status-chip {
    flex: none;
    padding: 3px 7px;
    border-radius: 999px;
    background: #583638;
    color: #ffc4c4;
    font-size: 10px;
    font-weight: 700;
  }
  .status-chip.valid { background: #294b39; color: #bff6d0; }
  .preview-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
  }
  .preview-section {
    min-width: 0;
    padding: 9px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg-panel);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    font-size: 11px;
  }
  h3 span { color: var(--text-dim); font-weight: 400; }
  ul,
  ol {
    margin: 0;
    padding-left: 18px;
  }
  .node-list,
  .requirement-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0;
    list-style: none;
  }
  .node-list li,
  .requirement-list li {
    display: flex;
    align-items: flex-start;
    gap: 6px;
  }
  code {
    border-radius: 3px;
    padding: 1px 4px;
    background: #26272a;
    color: #bfc8ff;
    font-size: 10px;
  }
  .requirement-list li { color: #ffc1c1; }
  .requirement-list li.ready { color: #aeeec4; }
  .validation-block p { margin: 0 0 7px; }
  .validation-block li + li { margin-top: 5px; }
  @media (max-width: 620px) {
    .director-dialog { grid-template-columns: 1fr; overflow: auto; }
    .request-panel { border-right: 0; border-bottom: 1px solid var(--border); }
    .preview-grid { grid-template-columns: 1fr; }
  }
</style>
