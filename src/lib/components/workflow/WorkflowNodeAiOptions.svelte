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
    workflowNodeAiCapabilities,
    workflowNodeAiOverrides,
  } from '../../workflow';
  import type { WorkflowNodeV2 } from '../../workflow/schema';

  let { node }: { node: WorkflowNodeV2 } = $props();

  const capabilities = $derived(workflowNodeAiCapabilities(node.type, node.config));
  const overrides = $derived(workflowNodeAiOverrides(node));
  const sourceIdentity = $derived(JSON.stringify({
    revision: workflow.rev,
    defaults: workflow.aiDefaults,
    nodeAi: node.config.ai ?? null,
    runtime: settings.value.ai,
  }));

  let options = $state<AiRunOptions>(resolveOptions());
  let syncedIdentity = '';

  function resolveOptions(): AiRunOptions {
    return resolveWorkflowNodeAiRunOptions(
      aiRunOptionsFromSettings(settings.value),
      workflow.aiDefaults,
      node,
    );
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
      next.director = {
        ...portable.director,
        mode: capabilities.director === 'required' && portable.director.mode === 'skip'
          ? 'auto'
          : portable.director.mode,
      };
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
    directorInherited={!overrides?.director}
    imageInherited={!overrides?.image}
    imageRoleLabel={capabilities.image === 'edit' ? 'Image Editor' : 'Image Generator'}
    controlLabel={`AI providers for ${node.title}`}
    onOptionsChange={persistOptions}
    onInheritDirector={capabilities.director !== 'none' ? inheritDirector : undefined}
    onInheritImage={capabilities.image !== 'none' ? inheritImage : undefined}
  />
{/if}
