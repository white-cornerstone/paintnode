<script lang="ts">
  import AiRunOptionsControl from '../AiRunOptionsControl.svelte';
  import { aiRunOptionsFromSettings, type AiRunOptions } from '../../state/settings';
  import { settings } from '../../state/settings.svelte';
  import { workflow } from '../../state/workflow.svelte';
  import {
    WORKFLOW_AI_CONFIG_VERSION,
    copyWorkflowNodeAiOverrides,
    resolveWorkflowNodeAiRunOptions,
    workflowAiDefaultsFromRunOptions,
    workflowBriefAiAssistMode,
    workflowNodeAiCapabilities,
    workflowNodeAiOverrides,
  } from '../../workflow';
  import type { WorkflowNodeV2 } from '../../workflow/schema';

  let { node }: { node: WorkflowNodeV2 } = $props();

  const capabilities = $derived(workflowNodeAiCapabilities(node.type, node.config));
  const overrides = $derived(workflowNodeAiOverrides(node));
  const briefAssistMode = $derived(workflowBriefAiAssistMode(node));
  const directorInherited = $derived(node.type === 'brief'
    ? briefAssistMode === 'workflow-default'
    : !overrides?.director);
  const sourceIdentity = $derived(JSON.stringify({
    revision: workflow.rev,
    defaults: workflow.aiDefaults,
    nodeAi: node.config.ai ?? null,
    briefAssistMode,
    runtime: settings.value.ai,
  }));

  let options = $state<AiRunOptions>(resolveOptions());
  let syncedIdentity = '';

  function resolveOptions(): AiRunOptions {
    const resolved = resolveWorkflowNodeAiRunOptions(
      aiRunOptionsFromSettings(settings.value),
      workflow.aiDefaults,
      node,
    );
    return briefAssistMode === 'manual' ? { ...resolved, directorMode: 'skip' } : resolved;
  }

  function setBriefAssistMode(mode: 'manual' | 'workflow-default' | 'configured'): void {
    if (node.type === 'brief') workflow.configureCreatorNode(node.id, { aiAssistMode: mode });
  }

  function setOverrides(next: ReturnType<typeof copyWorkflowNodeAiOverrides>): void {
    workflow.setNodeAiOverrides(node.id, next.director || next.image ? next : null);
  }

  function persistOptions(nextOptions: AiRunOptions, scope: 'director' | 'image' | 'both'): void {
    const portable = workflowAiDefaultsFromRunOptions(nextOptions);
    const next = overrides
      ? copyWorkflowNodeAiOverrides(overrides)
      : { version: WORKFLOW_AI_CONFIG_VERSION };
    if ((scope === 'director' || scope === 'both') && capabilities.director !== 'none') {
      if (node.type === 'brief' && portable.director.mode === 'skip') {
        delete next.director;
        setBriefAssistMode('manual');
      } else {
        next.director = {
          ...portable.director,
          mode: capabilities.director === 'required' && portable.director.mode === 'skip'
            ? 'auto'
            : portable.director.mode,
        };
        setBriefAssistMode('configured');
      }
    }
    if ((scope === 'image' || scope === 'both') && capabilities.image !== 'none') {
      next.image = portable.image;
    }
    setOverrides(next);
  }

  function inheritDirector(): void {
    const next = overrides
      ? copyWorkflowNodeAiOverrides(overrides)
      : { version: WORKFLOW_AI_CONFIG_VERSION };
    delete next.director;
    setOverrides(next);
    setBriefAssistMode('workflow-default');
  }

  function inheritImage(): void {
    const next = overrides
      ? copyWorkflowNodeAiOverrides(overrides)
      : { version: WORKFLOW_AI_CONFIG_VERSION };
    delete next.image;
    setOverrides(next);
  }

  $effect(() => {
    const identity = sourceIdentity;
    if (identity === syncedIdentity) return;
    syncedIdentity = identity;
    options = resolveOptions();
  });
</script>

{#if capabilities.director !== 'none' || capabilities.image !== 'none'}
  <AiRunOptionsControl
    bind:options
    compact
    showProfiles={false}
    showDirector={capabilities.director !== 'none'}
    showImage={capabilities.image !== 'none'}
    directorRequired={capabilities.director === 'required'}
    directorSectionLabel={node.type === 'brief' ? 'AI assistance' : 'AI Director'}
    directorOnRequest={node.type === 'brief'}
    showDirectorInvolvement={node.type !== 'brief'}
    {directorInherited}
    directorOffLabel={node.type === 'brief' ? 'Manual · use text verbatim' : 'Skip'}
    directorOffSummary={node.type === 'brief' ? 'Manual · text used verbatim' : 'Director: Off'}
    directorOffDetail={node.type === 'brief' ? 'Manual. Brief text is used verbatim.' : 'Director: Off.'}
    imageInherited={!overrides?.image}
    imageRoleLabel={capabilities.image === 'edit' ? 'Image Editor' : 'Image Generator'}
    controlLabel={`AI providers for ${node.title}`}
    onOptionsChange={persistOptions}
    onInheritDirector={capabilities.director !== 'none' ? inheritDirector : undefined}
    onInheritImage={capabilities.image !== 'none' ? inheritImage : undefined}
  />
{/if}
