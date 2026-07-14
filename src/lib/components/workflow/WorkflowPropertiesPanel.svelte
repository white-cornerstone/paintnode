<script lang="ts">
  import type { AiDirectorInvolvement, AiDirectorMode, AiDirectorProvider, AiProvider } from '../../state/settings';
  import { workflow } from '../../state/workflow.svelte';
  import {
    WORKFLOW_AI_CONFIG_VERSION,
    copyWorkflowAiDefaults,
    copyWorkflowNodeAiOverrides,
    workflowBriefAiAssistMode,
    workflowNodeAiCapabilities,
    workflowNodeAiOverrides,
    type WorkflowAiDefaultsV1,
    type WorkflowAiDirectorSelection,
    type WorkflowAiImageSelection,
    type WorkflowAiScalar,
    type WorkflowNodeAiOverridesV1,
  } from '../../workflow';
  import type { WorkflowNodeV2 } from '../../workflow/schema';

  let {
    node,
    onDirectorAction,
    embedded = false,
  }: {
    node: WorkflowNodeV2 | null;
    onDirectorAction?: (node: WorkflowNodeV2) => void;
    embedded?: boolean;
  } = $props();

  const directorProviders: Array<{ value: AiDirectorProvider; label: string }> = [
    { value: 'codex', label: 'Codex' },
    { value: 'antigravity', label: 'Antigravity' },
    { value: 'claude', label: 'Claude' },
    { value: 'grok', label: 'Grok' },
  ];
  const imageProviders: Array<{ value: AiProvider; label: string }> = [
    { value: 'codex', label: 'Codex' },
    { value: 'antigravity', label: 'Antigravity' },
    { value: 'grok', label: 'Grok' },
  ];

  const capabilities = $derived(node
    ? workflowNodeAiCapabilities(node.type, node.config)
    : { director: 'optional' as const, image: 'generate' as const });
  const overrides = $derived(node ? workflowNodeAiOverrides(node) : null);
  const briefAssistMode = $derived(node ? workflowBriefAiAssistMode(node) : null);
  const briefManual = $derived(briefAssistMode === 'manual');
  const director = $derived(overrides?.director ?? workflow.aiDefaults.director);
  const image = $derived(overrides?.image ?? workflow.aiDefaults.image);

  function updateDefaults(update: Partial<WorkflowAiDefaultsV1>): void {
    workflow.setAiDefaults({
      ...workflow.aiDefaults,
      ...update,
      director: { ...workflow.aiDefaults.director, ...update.director },
      image: { ...workflow.aiDefaults.image, ...update.image },
    });
  }

  function nodeOverrides(): WorkflowNodeAiOverridesV1 {
    return overrides ? copyWorkflowNodeAiOverrides(overrides) : { version: WORKFLOW_AI_CONFIG_VERSION };
  }

  function setNodeDirector(value: WorkflowAiDirectorSelection | undefined): void {
    if (!node) return;
    const next = nodeOverrides();
    if (value) next.director = value;
    else delete next.director;
    workflow.setNodeAiOverrides(node.id, next.director || next.image ? next : null);
  }

  function setNodeImage(value: WorkflowAiImageSelection | undefined): void {
    if (!node) return;
    const next = nodeOverrides();
    if (value) next.image = value;
    else delete next.image;
    workflow.setNodeAiOverrides(node.id, next.director || next.image ? next : null);
  }

  function updateDirector(update: Partial<WorkflowAiDirectorSelection>): void {
    if (!node) updateDefaults({ director: { ...workflow.aiDefaults.director, ...update } });
    else {
      setNodeDirector({ ...director, ...update });
      if (node.type === 'brief') workflow.configureCreatorNode(node.id, { aiAssistMode: 'configured' });
    }
  }

  function updateImage(update: Partial<WorkflowAiImageSelection>): void {
    if (!node) updateDefaults({ image: { ...workflow.aiDefaults.image, ...update } });
    else setNodeImage({ ...image, ...update });
  }

  function updateDirectorOption(key: string, value: WorkflowAiScalar): void {
    updateDirector({ options: { ...director.options, [key]: value } });
  }

  function updateImageOption(key: string, value: WorkflowAiScalar): void {
    updateImage({ options: { ...image.options, [key]: value } });
  }

  function inheritDirector(checked: boolean): void {
    if (checked) {
      setNodeDirector(undefined);
      if (node?.type === 'brief') workflow.configureCreatorNode(node.id, { aiAssistMode: 'workflow-default' });
    } else {
      setNodeDirector({
        ...copyWorkflowAiDefaults(workflow.aiDefaults).director,
        mode: capabilities.director === 'required' && workflow.aiDefaults.director.mode === 'skip'
          ? 'auto'
          : workflow.aiDefaults.director.mode,
      });
      if (node?.type === 'brief') workflow.configureCreatorNode(node.id, { aiAssistMode: 'configured' });
    }
  }

  function inheritImage(checked: boolean): void {
    if (checked) setNodeImage(undefined);
    else setNodeImage(copyWorkflowAiDefaults(workflow.aiDefaults).image);
  }

  function setDirectorSource(value: string): void {
    if (node?.type === 'brief' && value === 'manual') {
      setNodeDirector(undefined);
      workflow.configureCreatorNode(node.id, { aiAssistMode: 'manual' });
      return;
    }
    inheritDirector(value === 'inherit');
  }

  function setImageSource(value: string): void {
    inheritImage(value === 'inherit');
  }
</script>

<aside class="workflow-properties" class:embedded aria-label="Workflow properties">
  <header>
    <strong>{node ? node.title : 'Workflow Properties'}</strong>
    <small>{node ? node.type.replaceAll('-', ' ') : 'Saved with this workflow'}</small>
  </header>

  {#if node}
    <label class="field">
      <span>Name</span>
      <input value={node.title} oninput={(event) => workflow.setSelectedLabel(event.currentTarget.value)} />
    </label>
  {:else}
    <label class="field">
      <span>Workflow name</span>
      <input value={workflow.name} oninput={(event) => workflow.setName(event.currentTarget.value)} />
    </label>
    <p class="hint">These portable defaults are inherited by nodes without an override.</p>
  {/if}

  {#if capabilities.director !== 'none'}
    <section>
      <div class="section-title">
        <strong>{node?.type === 'brief' ? 'AI assistance' : 'AI Director'}</strong>
      </div>
      {#if node}
        <label class="field role-source">
          <span>Configuration</span>
          <select
            id={`workflow-role-source-${node.id}-director`}
            aria-label={`${node.title} AI Director configuration`}
            value={node.type === 'brief' ? briefAssistMode : overrides?.director ? 'override' : 'inherit'}
            onchange={(event) => setDirectorSource(event.currentTarget.value)}
          >
            {#if node.type === 'brief'}<option value="manual">Manual · use text verbatim</option>{/if}
            <option value="inherit">Inherit workflow default</option>
            <option value={node.type === 'brief' ? 'configured' : 'override'}>Override for this node</option>
          </select>
        </label>
        {#if briefManual}
          <p class="role-hint">No AI request is made. The Brief text is passed downstream exactly as written.</p>
        {:else if !overrides?.director}
          <p class="role-hint">Using the saved workflow Director. Choose an override to edit this node independently.</p>
        {/if}
      {/if}
      {#if !briefManual}
      {#if node?.type !== 'brief'}
      <label class="field">
        <span>Mode</span>
        <select
          aria-label={node ? `${node.title} AI Director mode` : 'Workflow AI Director mode'}
          value={capabilities.director === 'required' && director.mode === 'skip' ? 'auto' : director.mode}
          disabled={!!node && !overrides?.director}
          onchange={(event) => updateDirector({ mode: event.currentTarget.value as AiDirectorMode })}
        >
          <option value="auto">Auto by task</option>
          <option value="force">Always direct</option>
          {#if capabilities.director !== 'required'}<option value="skip">Direct image / off</option>{/if}
        </select>
      </label>
      {/if}
      <label class="field">
        <span>Provider</span>
        <select
          aria-label={node ? `${node.title} AI Director provider` : 'Workflow AI Director provider'}
          value={director.provider}
          disabled={!!node && !overrides?.director}
          onchange={(event) => updateDirector({ provider: event.currentTarget.value as AiDirectorProvider, model: null })}
        >
          {#each directorProviders as provider}<option value={provider.value}>{provider.label}</option>{/each}
        </select>
      </label>
      {#if node?.type !== 'brief'}<label class="field">
        <span>Involvement</span>
        <select
          aria-label={node ? `${node.title} AI Director involvement` : 'Workflow AI Director involvement'}
          value={director.involvement}
          disabled={!!node && !overrides?.director}
          onchange={(event) => updateDirector({ involvement: event.currentTarget.value as AiDirectorInvolvement })}
        >
          <option value="planOnly">Plan only</option>
          <option value="ensureCompletion">Ensure completion</option>
          <option value="fullReview">Full review</option>
        </select>
      </label>{/if}
      <label class="field">
        <span>Model</span>
        <input
          aria-label={node ? `${node.title} AI Director model` : 'Workflow AI Director model'}
          value={director.model ?? ''}
          placeholder="Provider default"
          disabled={!!node && !overrides?.director}
          oninput={(event) => updateDirector({ model: event.currentTarget.value.trim() || null })}
        />
      </label>
      {#if director.provider === 'codex'}
        <label class="field"><span>Reasoning effort</span><select value={String(director.options.reasoningEffort ?? 'medium')} disabled={!!node && !overrides?.director} onchange={(event) => updateDirectorOption('reasoningEffort', event.currentTarget.value)}><option value="minimal">Minimal</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="xhigh">Extra high</option></select></label>
      {:else if director.provider === 'claude'}
        <label class="field"><span>Effort</span><select value={String(director.options.claudeEffort ?? 'auto')} disabled={!!node && !overrides?.director} onchange={(event) => updateDirectorOption('claudeEffort', event.currentTarget.value)}><option value="auto">Automatic</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Maximum</option></select></label>
      {:else if director.provider === 'grok'}
        <label class="field"><span>Reasoning effort</span><select value={String(director.options.grokReasoningEffort ?? 'auto')} disabled={!!node && !overrides?.director} onchange={(event) => updateDirectorOption('grokReasoningEffort', event.currentTarget.value)}><option value="auto">Automatic</option><option value="low">Low</option><option value="high">High</option></select></label>
      {/if}
      {/if}
    </section>
  {/if}

  {#if capabilities.image !== 'none'}
    <section>
      <div class="section-title">
        <strong>Image Model</strong>
      </div>
      {#if node}
        <label class="field role-source">
          <span>Configuration</span>
          <select
            id={`workflow-role-source-${node.id}-image`}
            aria-label={`${node.title} Image Model configuration`}
            value={overrides?.image ? 'override' : 'inherit'}
            onchange={(event) => setImageSource(event.currentTarget.value)}
          >
            <option value="inherit">Inherit workflow default</option>
            <option value="override">Override for this node</option>
          </select>
        </label>
        {#if !overrides?.image}
          <p class="role-hint">Using the saved workflow Image Model. Choose an override to edit this node independently.</p>
        {/if}
      {/if}
      <small class="capability">{capabilities.image === 'generate' ? 'Image generation' : 'Image-to-image editing'}</small>
      <label class="field">
        <span>Provider</span>
        <select
          aria-label={node ? `${node.title} Image Model provider` : 'Workflow Image Model provider'}
          value={image.provider}
          disabled={!!node && !overrides?.image}
          onchange={(event) => updateImage({ provider: event.currentTarget.value as AiProvider, model: null })}
        >
          {#each imageProviders as provider}<option value={provider.value}>{provider.label}</option>{/each}
        </select>
      </label>
      {#if image.provider === 'codex'}
        <label class="field"><span>Quality</span><select value={String(image.options.imageQuality ?? 'auto')} disabled={!!node && !overrides?.image} onchange={(event) => updateImageOption('imageQuality', event.currentTarget.value)}><option value="auto">Automatic</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
      {:else if image.provider === 'antigravity'}
        <label class="field"><span>Image size</span><select value={String(image.options.imageSize ?? 'auto')} disabled={!!node && !overrides?.image} onchange={(event) => updateImageOption('imageSize', event.currentTarget.value)}><option value="auto">Automatic</option><option value="1K">1K</option><option value="2K">2K</option><option value="4K">4K</option></select></label>
      {:else if image.provider === 'grok'}
        <label class="field"><span>Resolution</span><select value={String(image.options.imageResolution ?? 'auto')} disabled={!!node && !overrides?.image} onchange={(event) => updateImageOption('imageResolution', event.currentTarget.value)}><option value="auto">Automatic</option><option value="1k">1K</option><option value="2k">2K</option></select></label>
      {/if}
      {#if capabilities.image === 'edit'}
        <label class="field"><span>Edit checks</span><select value={String(image.options.editChecksLevel ?? 1)} disabled={!!node && !overrides?.image} onchange={(event) => updateImageOption('editChecksLevel', Number(event.currentTarget.value))}><option value="0">Off</option><option value="1">Drift</option><option value="2">Drift + seams</option><option value="3">Strict seams</option></select></label>
      {/if}
      <label class="field">
        <span>Model</span>
        <input
          aria-label={node ? `${node.title} Image Model model` : 'Workflow Image Model model'}
          value={image.model ?? ''}
          placeholder="Provider default"
          disabled={!!node && !overrides?.image}
          oninput={(event) => updateImage({ model: event.currentTarget.value.trim() || null })}
        />
      </label>
      {#if node?.type === 'extract-assets' && image.provider === 'grok' && director.mode === 'skip'}
        <p class="warning">Direct Grok extraction cannot create the required asset inventory. Enable an AI Director or choose another image provider.</p>
      {/if}
    </section>
  {/if}

  {#if node && capabilities.director === 'none' && capabilities.image === 'none'}
    <p class="hint">This node does not run AI.</p>
  {/if}

  {#if node && (node.type === 'brief' || node.type === 'art-direction' || (node.type === 'review' && node.config.mode === 'ai'))}
    <button class="ai-action" type="button" onclick={() => onDirectorAction?.(node)}>
      {node.type === 'brief' ? 'Enhance with AI…' : node.type === 'art-direction' ? 'Develop Art Direction…' : 'Review Candidates…'}
    </button>
  {/if}
</aside>

<style>
  .workflow-properties { width: 286px; min-width: 286px; overflow: auto; padding: 12px; border-left: 1px solid var(--border); background: #292b2f; color: var(--text); box-sizing: border-box; }
  .workflow-properties.embedded { width: 100%; min-width: 0; flex: 1; border-left: 0; }
  header { display: grid; gap: 2px; margin-bottom: 14px; }
  header strong { color: var(--text-bright); font-size: 13px; }
  header small, .hint, .capability { color: var(--text-muted); font-size: 11px; }
  section { display: grid; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border-soft); }
  .section-title { display: flex; align-items: center; justify-content: space-between; color: var(--text-bright); font-size: 12px; }
  .field { display: grid; gap: 4px; color: var(--text-muted); font-size: 11px; }
  .field > input, .field > select { width: 100%; min-width: 0; height: 28px; border: 1px solid var(--border); border-radius: 4px; background: #1f2022; color: var(--text-bright); padding: 0 7px; box-sizing: border-box; font: inherit; }
  .field > input:disabled, .field > select:disabled { opacity: .55; }
  .role-source > select { border-color: #477eb6; background: #222b35; }
  .role-hint { margin: -1px 0 1px; color: var(--text-muted); font-size: 10px; line-height: 1.4; }
  .warning { margin: 0; padding: 7px; border: 1px solid #765b32; border-radius: 4px; background: #3b3123; color: #f0c987; font-size: 10px; line-height: 1.35; }
  .ai-action { width: 100%; margin-top: 14px; min-height: 30px; border: 1px solid #477eb6; border-radius: 4px; background: #245b8f; color: white; font: inherit; }
</style>
