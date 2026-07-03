<script lang="ts">
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import {
    CODEX_MODEL_OPTIONS,
    ANTIGRAVITY_MODEL_OPTIONS,
    type AiProvider,
    type AiRunOptions,
    type CodexModelId,
    type AntigravityApprovalMode,
    type AntigravityModelId,
    type ReasoningEffort,
    type ServiceTier,
  } from '../state/settings';
  import { Bot, Checkmark, ChevronDown, ChevronRight } from '../icons';

  let { options = $bindable<AiRunOptions>(), disabled = false }: { options: AiRunOptions; disabled?: boolean } = $props();

  const reasoningEfforts: { value: ReasoningEffort; label: string; short: string }[] = [
    { value: 'minimal', label: 'Minimal', short: 'Min' },
    { value: 'low', label: 'Light', short: 'Light' },
    { value: 'medium', label: 'Medium', short: 'Med' },
    { value: 'high', label: 'High', short: 'High' },
    { value: 'xhigh', label: 'Extra High', short: 'XHigh' },
  ];
  const serviceTiers: { value: ServiceTier; label: string }[] = [
    { value: 'default', label: 'Default speed' },
    { value: 'fast', label: 'Fast' },
  ];
  const approvalModes: { value: AntigravityApprovalMode; label: string }[] = [
    { value: 'skipPermissions', label: 'Skip job-folder permissions' },
    { value: 'default', label: 'Default permissions' },
  ];
  const providers: { value: AiProvider; label: string }[] = [
    { value: 'codex', label: 'Local Codex CLI' },
    { value: 'antigravity', label: 'Local Antigravity CLI' },
    { value: 'custom', label: 'Custom CLI' },
  ];

  let open = $state(false);
  let submenu = $state<'reasoning' | 'model' | 'speed' | 'antigravityModel' | 'antigravityApproval' | null>(null);

  const providerLabel = $derived(providers.find((item) => item.value === options.provider)?.label ?? 'AI');
  const codexModelLabel = $derived(CODEX_MODEL_OPTIONS.find((item) => item.id === options.model)?.label.replace('GPT-', '') ?? options.model);
  const reasoningShort = $derived(reasoningEfforts.find((item) => item.value === options.reasoningEffort)?.short ?? options.reasoningEffort);
  const antigravityModelLabel = $derived(
    ANTIGRAVITY_MODEL_OPTIONS.find((item) => item.id === options.antigravityModel)?.label ?? options.antigravityModel,
  );
  const summary = $derived.by(() => {
    if (options.provider === 'codex') return `${codexModelLabel} ${reasoningShort}`;
    if (options.provider === 'antigravity') return `Antigravity ${antigravityModelLabel}`;
    return 'Custom CLI';
  });

  function setProvider(provider: AiProvider): void {
    options = { ...options, provider };
    submenu = provider === 'codex' ? 'reasoning' : provider === 'antigravity' ? 'antigravityModel' : null;
  }

  function setReasoning(reasoningEffort: ReasoningEffort): void {
    options = { ...options, reasoningEffort };
  }

  function setCodexModel(model: CodexModelId): void {
    options = { ...options, model };
  }

  function setServiceTier(serviceTier: ServiceTier): void {
    options = { ...options, serviceTier };
  }

  function setAntigravityModel(antigravityModel: AntigravityModelId): void {
    options = { ...options, antigravityModel };
  }

  function setAntigravityApproval(antigravityApprovalMode: AntigravityApprovalMode): void {
    options = { ...options, antigravityApprovalMode };
  }

  function close(): void {
    open = false;
    submenu = null;
  }

  function closeFromWindow(): void {
    if (open) close();
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (open && event.key === 'Escape') close();
  }

  function toggle(event: MouseEvent): void {
    event.stopPropagation();
    open = !open;
  }

  function stopPointer(event: PointerEvent): void {
    event.stopPropagation();
  }
</script>

<svelte:window onpointerdown={closeFromWindow} onkeydown={onWindowKeydown} />

<div class="ai-options">
  {#if open}
    <div class="menu" role="presentation" onpointerdown={stopPointer}>
      <div class="menu-title">Provider</div>
      {#each providers as provider (provider.value)}
        <button type="button" class:active={options.provider === provider.value} onclick={() => setProvider(provider.value)}>
          <span>{provider.label}</span>
          {#if options.provider === provider.value}<Icon svg={Checkmark} size={15} />{/if}
        </button>
      {/each}

      {#if options.provider === 'codex'}
        <div class="separator"></div>
        <button type="button" onclick={() => (submenu = submenu === 'reasoning' ? null : 'reasoning')}>
          <span>Reasoning</span>
          <span class="value">{reasoningEfforts.find((item) => item.value === options.reasoningEffort)?.label}</span>
          <Icon svg={ChevronRight} size={14} />
        </button>
        {#if submenu === 'reasoning'}
          <div class="subitems">
            {#each reasoningEfforts as item (item.value)}
              <button type="button" class:active={options.reasoningEffort === item.value} onclick={() => setReasoning(item.value)}>
                <span>{item.label}</span>
                {#if options.reasoningEffort === item.value}<Icon svg={Checkmark} size={15} />{/if}
              </button>
            {/each}
          </div>
        {/if}
        <button type="button" onclick={() => (submenu = submenu === 'model' ? null : 'model')}>
          <span>Model</span>
          <span class="value">{CODEX_MODEL_OPTIONS.find((item) => item.id === options.model)?.label}</span>
          <Icon svg={ChevronRight} size={14} />
        </button>
        {#if submenu === 'model'}
          <div class="subitems">
            {#each CODEX_MODEL_OPTIONS as item (item.id)}
              <button type="button" class:active={options.model === item.id} onclick={() => setCodexModel(item.id)}>
                <span>{item.label}</span>
                {#if options.model === item.id}<Icon svg={Checkmark} size={15} />{/if}
              </button>
            {/each}
          </div>
        {/if}
        <button type="button" onclick={() => (submenu = submenu === 'speed' ? null : 'speed')}>
          <span>Speed</span>
          <span class="value">{options.serviceTier === 'fast' ? 'Fast' : 'Default'}</span>
          <Icon svg={ChevronRight} size={14} />
        </button>
        {#if submenu === 'speed'}
          <div class="subitems">
            {#each serviceTiers as item (item.value)}
              <button type="button" class:active={options.serviceTier === item.value} onclick={() => setServiceTier(item.value)}>
                <span>{item.label}</span>
                {#if options.serviceTier === item.value}<Icon svg={Checkmark} size={15} />{/if}
              </button>
            {/each}
          </div>
        {/if}
      {:else if options.provider === 'antigravity'}
        <div class="separator"></div>
        <button type="button" onclick={() => (submenu = submenu === 'antigravityModel' ? null : 'antigravityModel')}>
          <span>Model</span>
          <span class="value">{ANTIGRAVITY_MODEL_OPTIONS.find((item) => item.id === options.antigravityModel)?.label}</span>
          <Icon svg={ChevronRight} size={14} />
        </button>
        {#if submenu === 'antigravityModel'}
          <div class="subitems">
            {#each ANTIGRAVITY_MODEL_OPTIONS as item (item.id)}
              <button type="button" class:active={options.antigravityModel === item.id} onclick={() => setAntigravityModel(item.id)}>
                <span>{item.label}</span>
                {#if options.antigravityModel === item.id}<Icon svg={Checkmark} size={15} />{/if}
              </button>
            {/each}
          </div>
        {/if}
        <button type="button" onclick={() => (submenu = submenu === 'antigravityApproval' ? null : 'antigravityApproval')}>
          <span>Automation</span>
          <span class="value">{options.antigravityApprovalMode === 'skipPermissions' ? 'Skip' : 'Default'}</span>
          <Icon svg={ChevronRight} size={14} />
        </button>
        {#if submenu === 'antigravityApproval'}
          <div class="subitems">
            {#each approvalModes as item (item.value)}
              <button type="button" class:active={options.antigravityApprovalMode === item.value} onclick={() => setAntigravityApproval(item.value)}>
                <span>{item.label}</span>
                {#if options.antigravityApprovalMode === item.value}<Icon svg={Checkmark} size={15} />{/if}
              </button>
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  <button
    class="pill"
    type="button"
    disabled={disabled}
    aria-label={`AI provider: ${providerLabel}, ${summary}`}
    use:tooltip={{ text: `AI provider: ${providerLabel}`, placement: 'top' }}
    onpointerdown={stopPointer}
    onclick={toggle}
  >
    <Icon svg={Bot} size={14} />
    <span>{summary}</span>
    <Icon svg={ChevronDown} size={14} />
  </button>
</div>

<style>
  .ai-options {
    position: relative;
    display: inline-flex;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding: 4px 9px;
    border-radius: 999px;
    color: var(--text-bright);
    background: var(--bg-elevated);
    border-color: var(--border-soft);
    white-space: nowrap;
  }
  .pill span {
    max-width: 128px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 6px);
    z-index: 2500;
    min-width: 248px;
    max-height: min(430px, calc(100vh - 96px));
    overflow: auto;
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: 8px;
    background: var(--bg-panel);
    box-shadow: 0 12px 34px rgba(0, 0, 0, 0.55);
  }
  .menu-title {
    padding: 4px 7px 7px;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 700;
  }
  .menu button,
  .subitems button {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 28px;
    padding: 5px 7px;
    border: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
  }
  .menu button:hover,
  .menu button.active,
  .subitems button:hover,
  .subitems button.active {
    background: var(--bg-elevated);
  }
  .value {
    color: var(--text-dim);
    font-size: 11px;
  }
  .separator {
    height: 1px;
    margin: 8px 7px;
    background: var(--border-soft);
  }
  .subitems {
    margin: 2px 0 4px 12px;
    padding-left: 8px;
    border-left: 1px solid var(--border-soft);
  }
</style>
