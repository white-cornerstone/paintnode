<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import {
    CODEX_MODEL_OPTIONS,
    ANTIGRAVITY_IMAGE_AGENT_MODEL_OPTIONS,
    ANTIGRAVITY_MODEL_OPTIONS,
    type AiProvider,
    type AiRunOptions,
    type AiAutonomyLevel,
    type CodexModelId,
    type AntigravityApprovalMode,
    type AntigravityModelId,
    type ReasoningEffort,
    type ServiceTier,
  } from '../state/settings';
  import { Bot, Checkmark, ChevronDown, ChevronRight } from '../icons';

  type AntigravityModelScope = 'all' | 'image';

  let {
    options = $bindable<AiRunOptions>(),
    disabled = false,
    antigravityModelScope = 'all',
  }: { options: AiRunOptions; disabled?: boolean; antigravityModelScope?: AntigravityModelScope } = $props();

  const reasoningEfforts: { value: ReasoningEffort; label: string; short: string }[] = [
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
  const autonomyLevels: { value: AiAutonomyLevel; label: string; short: string }[] = [
    { value: 'low', label: 'Low autonomy', short: 'Low' },
    { value: 'guided', label: 'Guided tools', short: 'Guided' },
    { value: 'open', label: 'Open-ended', short: 'Open' },
    { value: 'unmanaged', label: 'Unmanaged', short: 'Unmanaged' },
  ];
  const providers: { value: AiProvider; label: string }[] = [
    { value: 'codex', label: 'Local Codex CLI' },
    { value: 'antigravity', label: 'Local Antigravity CLI' },
    { value: 'custom', label: 'Custom CLI' },
  ];

  let open = $state(false);
  let submenu = $state<'autonomy' | 'reasoning' | 'model' | 'speed' | 'antigravityModel' | 'antigravityApproval' | null>(null);
  let pillElement = $state<HTMLButtonElement | null>(null);
  let menuElement = $state<HTMLDivElement | null>(null);
  let menuStyle = $state('visibility: hidden; left: 8px; top: 8px;');
  const menuMargin = 8;
  const menuGap = 6;
  const floatingMenuClass = 'ai-run-options-floating-menu';
  const dismissLayerClass = 'ai-run-options-dismiss-layer';

  const providerLabel = $derived(providers.find((item) => item.value === options.provider)?.label ?? 'AI');
  const codexModelLabel = $derived(CODEX_MODEL_OPTIONS.find((item) => item.id === options.model)?.label.replace('GPT-', '') ?? options.model);
  const reasoningShort = $derived(reasoningEfforts.find((item) => item.value === options.reasoningEffort)?.short ?? options.reasoningEffort);
  const autonomyShort = $derived(autonomyLevels.find((item) => item.value === options.autonomyLevel)?.short ?? options.autonomyLevel);
  const antigravityModelOptions = $derived(
    antigravityModelScope === 'image' ? ANTIGRAVITY_IMAGE_AGENT_MODEL_OPTIONS : ANTIGRAVITY_MODEL_OPTIONS,
  );
  const antigravityModelTitle = $derived(antigravityModelScope === 'image' ? 'Agent model' : 'Model');
  const antigravityModelLabel = $derived(
    antigravityModelOptions.find((item) => item.id === options.antigravityModel)?.label ?? 'Auto',
  );
  const summary = $derived.by(() => {
    if (options.provider === 'codex') return `${codexModelLabel} ${reasoningShort} ${autonomyShort}`;
    if (options.provider === 'antigravity') return `Antigravity ${antigravityModelLabel} ${autonomyShort}`;
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

  function setAutonomy(autonomyLevel: AiAutonomyLevel): void {
    options = { ...options, autonomyLevel };
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
    cleanupFloatingMenus();
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (open && event.key === 'Escape') close();
  }

  function toggle(event: MouseEvent): void {
    event.stopPropagation();
    if (open) {
      close();
      return;
    }
    cleanupFloatingMenus();
    open = true;
    void updateMenuPosition();
  }

  function stopPointer(event: PointerEvent): void {
    event.stopPropagation();
  }

  function cleanupFloatingMenus(currentMenu: HTMLElement | undefined = undefined, currentDismissLayer: HTMLElement | undefined = undefined): void {
    document.querySelectorAll<HTMLElement>(`.${floatingMenuClass}`).forEach((node) => {
      if (node !== currentMenu) node.remove();
    });
    document.querySelectorAll<HTMLElement>(`.${dismissLayerClass}`).forEach((node) => {
      if (node !== currentDismissLayer) node.remove();
    });
  }

  function portal(node: HTMLElement): { destroy: () => void } {
    const parent = node.parentNode;
    const anchor = document.createComment('ai-run-options-menu');
    parent?.insertBefore(anchor, node);
    const dismissLayer = document.createElement('div');
    dismissLayer.className = dismissLayerClass;
    dismissLayer.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
    });
    node.classList.add(floatingMenuClass);
    cleanupFloatingMenus(node, dismissLayer);
    document.body.appendChild(dismissLayer);
    document.body.appendChild(node);

    return {
      destroy() {
        dismissLayer.remove();
        node.remove();
        anchor.remove();
      },
    };
  }

  async function updateMenuPosition(): Promise<void> {
    if (!open || !pillElement) return;
    await tick();
    const anchor = pillElement.getBoundingClientRect();
    const menu = menuElement?.getBoundingClientRect();
    const menuWidth = menu?.width ?? 248;
    const menuHeight = menu?.height ?? 320;
    const maxLeft = Math.max(menuMargin, window.innerWidth - menuWidth - menuMargin);
    const left = Math.min(Math.max(menuMargin, anchor.right - menuWidth), maxLeft);
    const above = anchor.top - menuHeight - menuGap;
    const below = anchor.bottom + menuGap;
    const maxTop = Math.max(menuMargin, window.innerHeight - menuHeight - menuMargin);
    const top = above >= menuMargin ? above : Math.min(Math.max(menuMargin, below), maxTop);
    menuStyle = `left: ${Math.round(left)}px; top: ${Math.round(top)}px;`;
  }

  $effect(() => {
    if (!open) return;
    submenu;
    options.provider;
    void updateMenuPosition();
  });

  $effect(() => {
    if (options.provider !== 'antigravity') return;
    if (antigravityModelOptions.some((item) => item.id === options.antigravityModel)) return;
    options = { ...options, antigravityModel: 'auto' };
  });

  $effect(() => () => cleanupFloatingMenus());
</script>

<svelte:window
  onkeydown={onWindowKeydown}
  onresize={() => void updateMenuPosition()}
  onscroll={() => void updateMenuPosition()}
/>

<div class="ai-options">
  {#if open}
    <div bind:this={menuElement} use:portal class="menu" style={menuStyle} role="presentation" onpointerdown={stopPointer}>
      <div class="menu-title">Provider</div>
      {#each providers as provider (provider.value)}
        <button type="button" class:active={options.provider === provider.value} onclick={() => setProvider(provider.value)}>
          <span>{provider.label}</span>
          {#if options.provider === provider.value}<Icon svg={Checkmark} size={15} />{/if}
        </button>
      {/each}

      {#if options.provider === 'codex'}
        <div class="separator"></div>
        <button type="button" onclick={() => (submenu = submenu === 'autonomy' ? null : 'autonomy')}>
          <span>Autonomy</span>
          <span class="value">{autonomyLevels.find((item) => item.value === options.autonomyLevel)?.label}</span>
          <Icon svg={ChevronRight} size={14} />
        </button>
        {#if submenu === 'autonomy'}
          <div class="subitems">
            {#each autonomyLevels as item (item.value)}
              <button type="button" class:active={options.autonomyLevel === item.value} onclick={() => setAutonomy(item.value)}>
                <span>{item.label}</span>
                {#if options.autonomyLevel === item.value}<Icon svg={Checkmark} size={15} />{/if}
              </button>
            {/each}
          </div>
        {/if}
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
        <button type="button" onclick={() => (submenu = submenu === 'autonomy' ? null : 'autonomy')}>
          <span>Autonomy</span>
          <span class="value">{autonomyLevels.find((item) => item.value === options.autonomyLevel)?.label}</span>
          <Icon svg={ChevronRight} size={14} />
        </button>
        {#if submenu === 'autonomy'}
          <div class="subitems">
            {#each autonomyLevels as item (item.value)}
              <button type="button" class:active={options.autonomyLevel === item.value} onclick={() => setAutonomy(item.value)}>
                <span>{item.label}</span>
                {#if options.autonomyLevel === item.value}<Icon svg={Checkmark} size={15} />{/if}
              </button>
            {/each}
          </div>
        {/if}
        <button type="button" onclick={() => (submenu = submenu === 'antigravityModel' ? null : 'antigravityModel')}>
          <span>{antigravityModelTitle}</span>
          <span class="value">{antigravityModelLabel}</span>
          <Icon svg={ChevronRight} size={14} />
        </button>
        {#if submenu === 'antigravityModel'}
          <div class="subitems">
            {#each antigravityModelOptions as item (item.id)}
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
    bind:this={pillElement}
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
  :global(.ai-run-options-dismiss-layer) {
    position: fixed;
    inset: 0;
    z-index: 2499;
    background: transparent;
  }
  .menu {
    position: fixed;
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
