<script lang="ts">
  import { tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import {
    ANTIGRAVITY_IMAGE_MODEL_OPTIONS,
    ANTIGRAVITY_IMAGE_SIZE_OPTIONS,
    ANTIGRAVITY_PERSON_GENERATION_OPTIONS,
    ANTIGRAVITY_PROMINENT_PEOPLE_OPTIONS,
    ANTIGRAVITY_SAFETY_CATEGORY_OPTIONS,
    ANTIGRAVITY_SAFETY_FILTERING_OPTIONS,
    ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS,
    type AiDirectorProvider,
    type AiProvider,
    type AiRunOptions,
    type AiAutonomyLevel,
    type AiDirectorInvolvement,
    type CodexImageModeration,
    type CodexImageQuality,
    type CodexModelId,
    type ClaudeModelId,
    type ClaudeEffort,
    type AntigravityApprovalMode,
    type AntigravityImageModelId,
    type AntigravityImageSize,
    type AntigravityModelId,
    type AntigravityPersonGeneration,
    type AntigravityProminentPeople,
    type AntigravitySafetyCategorySetting,
    type AntigravitySafetyFiltering,
    type AntigravitySafetyThreshold,
    type ReasoningEffort,
    type ServiceTier,
    aiProfileOptionsFromRunOptions,
    aiProfileRunOptionsFromSettings,
    aiProviderDefaultsFromSettings,
  } from '../state/settings';
  import { settings } from '../state/settings.svelte';
  import {
    FALLBACK_CODEX_CAPABILITIES,
    FALLBACK_CLAUDE_CAPABILITIES,
    FALLBACK_ANTIGRAVITY_CAPABILITIES,
    claudeEffortForModel,
    claudeReasoningOptions,
    codexEffortForModel,
    codexModelOptions,
    codexReasoningOptions,
    loadCodexCapabilities,
    loadClaudeCapabilities,
    loadAntigravityCapabilities,
    providerModelOptions,
  } from '../ai/providerCapabilities';
  import { directorProviderLabel, providerLabel } from '../ai/taskSupport';
  import { Bot, Checkmark, ChevronDown, ChevronRight } from '../icons';

  type AntigravityModelScope = 'all' | 'image';

  let {
    options = $bindable<AiRunOptions>(),
    disabled = false,
    antigravityModelScope = 'image',
  }: { options: AiRunOptions; disabled?: boolean; antigravityModelScope?: AntigravityModelScope } = $props();

  const serviceTiers: { value: ServiceTier; label: string }[] = [
    { value: 'default', label: 'Default speed' },
    { value: 'fast', label: 'Fast' },
  ];
  const imageQualities: { value: CodexImageQuality; label: string; short: string }[] = [
    { value: 'auto', label: 'Auto quality', short: 'AutoQ' },
    { value: 'low', label: 'Low quality', short: 'LowQ' },
    { value: 'medium', label: 'Medium quality', short: 'MedQ' },
    { value: 'high', label: 'High quality', short: 'HighQ' },
  ];
  const imageModerations: { value: CodexImageModeration; label: string }[] = [
    { value: 'auto', label: 'Default moderation' },
    { value: 'low', label: 'Low moderation' },
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
  const directorInvolvementLevels: { value: AiDirectorInvolvement; label: string; short: string }[] = [
    { value: 'planOnly', label: 'Plan only', short: 'Plan' },
    { value: 'ensureCompletion', label: 'Ensure completion', short: 'Complete' },
    { value: 'fullReview', label: 'Full review', short: 'Full' },
  ];
  const providers: { value: AiProvider; label: string }[] = [
    { value: 'codex', label: 'Codex' },
    { value: 'antigravity', label: 'Antigravity' },
    { value: 'grok', label: 'Grok' },
  ];
  const directorProviders: { value: AiDirectorProvider; label: string }[] = [
    { value: 'codex', label: 'Codex' },
    { value: 'antigravity', label: 'Antigravity' },
    { value: 'claude', label: 'Claude' },
    { value: 'grok', label: 'Grok' },
  ];
  let open = $state(false);
  let codexCapabilities = $state(FALLBACK_CODEX_CAPABILITIES);
  let claudeCapabilities = $state(FALLBACK_CLAUDE_CAPABILITIES);
  let antigravityCapabilities = $state(FALLBACK_ANTIGRAVITY_CAPABILITIES);
  let submenu = $state<
    | 'autonomy'
    | 'imageProvider'
    | 'directorInvolvement'
    | 'reasoning'
    | 'model'
    | 'claudeModel'
    | 'claudeEffort'
    | 'speed'
    | 'quality'
    | 'moderation'
    | 'antigravityModel'
    | 'antigravityApproval'
    | 'antigravityImageModel'
    | 'antigravityImageSize'
    | 'antigravityPersonGeneration'
    | 'antigravityProminentPeople'
    | 'antigravitySafetyFiltering'
    | AntigravitySafetyCategorySetting
    | null
  >(null);
  let pillElement = $state<HTMLButtonElement | null>(null);
  let menuElement = $state<HTMLDivElement | null>(null);
  let menuStyle = $state('visibility: hidden; left: 8px; top: 8px;');
  const menuMargin = 8;
  const menuGap = 6;
  const floatingMenuClass = 'ai-run-options-floating-menu';
  const dismissLayerClass = 'ai-run-options-dismiss-layer';

  const directorEnabled = $derived((options.directorMode ?? options.plannerMode) !== 'skip');
  const imageProvider = $derived(options.imageProvider ?? options.provider ?? 'codex');
  const directorProvider = $derived(options.directorProvider ?? options.plannerProvider ?? 'codex');
  const directorMode = $derived(options.directorMode ?? options.plannerMode ?? 'auto');
  const directorModeShort = $derived(directorMode === 'force' ? 'Always' : 'Auto');
  const directorInvolvement = $derived(options.directorInvolvement ?? 'fullReview');
  const directorInvolvementShort = $derived(
    directorInvolvementLevels.find((item) => item.value === directorInvolvement)?.short ?? 'Full',
  );
  const directorInvolvementLabel = $derived(
    directorInvolvementLevels.find((item) => item.value === directorInvolvement)?.label ?? 'Full review',
  );
  const showCodexAgentOptions = $derived((directorEnabled && directorProvider === 'codex') || (!directorEnabled && imageProvider === 'codex'));
  const showAntigravityAgentOptions = $derived(
    (directorEnabled && directorProvider === 'antigravity') ||
      (!directorEnabled && imageProvider === 'antigravity' && antigravityModelScope === 'all'),
  );
  const showClaudeDirectorOptions = $derived(directorEnabled && directorProvider === 'claude');
  const availableCodexModels = $derived(codexModelOptions(codexCapabilities, options.model));
  const availableReasoningEfforts = $derived(
    codexReasoningOptions(codexCapabilities, options.model, options.reasoningEffort),
  );
  const reasoningShort = $derived(
    options.reasoningEffort === 'xhigh'
      ? 'XHigh'
      : (availableReasoningEfforts.find((item) => item.value === options.reasoningEffort)?.label ?? options.reasoningEffort),
  );
  const autonomyShort = $derived(autonomyLevels.find((item) => item.value === options.autonomyLevel)?.short ?? options.autonomyLevel);
  const imageQualityShort = $derived(
    imageQualities.find((item) => item.value === options.imageQuality)?.short ?? 'AutoQ',
  );
  const antigravityModelOptions = $derived(
    providerModelOptions(antigravityCapabilities, options.antigravityModel),
  );
  const antigravityModelTitle = $derived('Agent model');
  const antigravityModelLabel = $derived(
    antigravityModelOptions.find((item) => item.id === options.antigravityModel)?.label ?? 'Auto',
  );
  const antigravityImageModelLabel = $derived(
    ANTIGRAVITY_IMAGE_MODEL_OPTIONS.find((item) => item.id === options.antigravityImageModel)?.label ?? 'Gemini 3.1 Flash Image',
  );
  const antigravityImageSizeLabel = $derived(
    ANTIGRAVITY_IMAGE_SIZE_OPTIONS.find((item) => item.id === options.antigravityImageSize)?.label ?? 'Auto',
  );
  const antigravityPersonGenerationLabel = $derived(
    ANTIGRAVITY_PERSON_GENERATION_OPTIONS.find((item) => item.id === options.antigravityPersonGeneration)?.label ?? 'Auto',
  );
  const antigravityProminentPeopleLabel = $derived(
    ANTIGRAVITY_PROMINENT_PEOPLE_OPTIONS.find((item) => item.id === options.antigravityProminentPeople)?.label ?? 'Auto',
  );
  const antigravitySafetyFilteringLabel = $derived(
    ANTIGRAVITY_SAFETY_FILTERING_OPTIONS.find((item) => item.id === options.antigravitySafetyFiltering)?.label ?? 'Default',
  );
  const antigravitySafetyHarassmentLabel = $derived(
    ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS.find((item) => item.id === options.antigravitySafetyHarassment)?.label ?? 'API default',
  );
  const antigravitySafetyHateSpeechLabel = $derived(
    ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS.find((item) => item.id === options.antigravitySafetyHateSpeech)?.label ?? 'API default',
  );
  const antigravitySafetySexuallyExplicitLabel = $derived(
    ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS.find((item) => item.id === options.antigravitySafetySexuallyExplicit)?.label ?? 'API default',
  );
  const antigravitySafetyDangerousContentLabel = $derived(
    ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS.find((item) => item.id === options.antigravitySafetyDangerousContent)?.label ?? 'API default',
  );
  const claudeModelOptions = $derived(providerModelOptions(claudeCapabilities, options.claudeModel));
  const claudeEffortOptions = $derived(
    claudeReasoningOptions(claudeCapabilities, options.claudeModel, options.claudeEffort),
  );
  const claudeModelLabel = $derived(
    claudeModelOptions.find((item) => item.id === options.claudeModel)?.label ?? options.claudeModel,
  );
  const claudeEffortLabel = $derived(
    claudeEffortOptions.find((item) => item.value === options.claudeEffort)?.label ?? options.claudeEffort,
  );

  const summary = $derived.by(() => {
    const imageName = providerLabel(imageProvider);
    if (!directorEnabled) return `Director: Off · Image: ${imageName}`;
    const directorName = directorProviderLabel(directorProvider);
    if (directorProvider === imageProvider) return `Director: ${directorModeShort}, ${directorInvolvementShort} · Image: ${imageName}`;
    return `Director: ${directorModeShort} ${directorName}, ${directorInvolvementShort} · Image: ${imageName}`;
  });
  const detailedSummary = $derived.by(() => {
    const imageDetail = imageProvider === 'codex'
      ? `Image: Codex, ${imageQualityShort} quality`
      : imageProvider === 'grok'
        ? 'Image: Grok'
        : `Image: Antigravity, ${antigravityImageSizeLabel}`;
    if (!directorEnabled) return `Director: Off. ${imageDetail}`;
    const directorDetail = directorProvider === 'codex'
      ? `Director: ${directorModeShort}, ${directorInvolvementLabel}, Codex, ${reasoningShort} reasoning`
      : directorProvider === 'claude'
        ? `Director: ${directorModeShort}, ${directorInvolvementLabel}, Claude, ${claudeModelLabel}, ${claudeEffortLabel} effort`
      : directorProvider === 'grok'
        ? `Director: ${directorModeShort}, ${directorInvolvementLabel}, Grok`
        : `Director: ${directorModeShort}, ${directorInvolvementLabel}, Antigravity, ${autonomyShort} autonomy`;
    return `${directorDetail}. ${imageDetail}`;
  });

  function activeDirectorMode(): 'auto' | 'force' {
    if (directorMode === 'force' || directorMode === 'auto') return directorMode;
    return settings.value.ai.directorMode === 'force' ? 'force' : 'auto';
  }

  function setDirectorProvider(provider: AiDirectorProvider): void {
    options = { ...options, directorMode: activeDirectorMode(), directorProvider: provider, directorInvolvement };
    submenu =
      provider === 'codex'
        ? 'reasoning'
        : provider === 'claude'
          ? 'claudeModel'
          : provider === 'grok'
            ? null
            : 'antigravityModel';
  }

  function skipDirector(): void {
    options = { ...options, directorMode: 'skip' };
    submenu = 'imageProvider';
  }

  function setDirectorInvolvement(next: AiDirectorInvolvement): void {
    options = { ...options, directorMode: activeDirectorMode(), directorInvolvement: next };
  }

  function setImageProvider(provider: AiProvider): void {
    options = { ...options, provider, imageProvider: provider };
    submenu = provider === 'codex' ? 'quality' : provider === 'grok' ? null : 'antigravityImageModel';
  }

  function applyProfile(profileId: string): void {
    options = aiProfileRunOptionsFromSettings(settings.value, profileId);
    submenu = null;
    close();
  }

  function applySettingsDefaults(): void {
    options = aiProviderDefaultsFromSettings(settings.value);
    submenu = null;
    close();
  }

  function runOptionsMatch(left: AiRunOptions, right: AiRunOptions): boolean {
    return JSON.stringify(aiProfileOptionsFromRunOptions(left)) === JSON.stringify(aiProfileOptionsFromRunOptions(right));
  }

  function settingsDefaultsActive(): boolean {
    const defaults = aiProviderDefaultsFromSettings(settings.value);
    if (!runOptionsMatch(options, defaults)) return false;
    return !settings.value.ai.profiles.some((profile) => profileActive(profile.id));
  }

  function profileActive(profileId: string): boolean {
    return runOptionsMatch(options, aiProfileRunOptionsFromSettings(settings.value, profileId));
  }

  function profileMenuSummary(profileId: string | null): string {
    const profileOptions = profileId
      ? aiProfileRunOptionsFromSettings(settings.value, profileId)
      : aiProviderDefaultsFromSettings(settings.value);
    const profileImageProvider = profileOptions.imageProvider ?? profileOptions.provider ?? 'codex';
    if (profileOptions.directorMode === 'skip') return `Director: Off · Image: ${providerLabel(profileImageProvider)}`;
    return `Director: ${directorProviderLabel(profileOptions.directorProvider)} · Image: ${providerLabel(profileImageProvider)}`;
  }

  function setReasoning(reasoningEffort: ReasoningEffort): void {
    options = { ...options, reasoningEffort };
  }

  function setCodexModel(model: CodexModelId): void {
    options = {
      ...options,
      model,
      reasoningEffort: codexEffortForModel(codexCapabilities, model, options.reasoningEffort),
    };
  }

  function setClaudeModel(claudeModel: ClaudeModelId): void {
    options = {
      ...options,
      claudeModel,
      claudeEffort: claudeEffortForModel(claudeCapabilities, claudeModel, options.claudeEffort),
    };
  }

  function setClaudeEffort(claudeEffort: ClaudeEffort): void {
    options = { ...options, claudeEffort };
  }

  function setServiceTier(serviceTier: ServiceTier): void {
    options = { ...options, serviceTier };
  }

  function setImageQuality(imageQuality: CodexImageQuality): void {
    options = { ...options, imageQuality };
  }

  function setImageModeration(imageModeration: CodexImageModeration): void {
    options = { ...options, imageModeration };
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

  function setAntigravityImageModel(antigravityImageModel: AntigravityImageModelId): void {
    options = { ...options, antigravityImageModel };
  }

  function setAntigravityImageSize(antigravityImageSize: AntigravityImageSize): void {
    options = { ...options, antigravityImageSize };
  }

  function setAntigravityPersonGeneration(antigravityPersonGeneration: AntigravityPersonGeneration): void {
    options = { ...options, antigravityPersonGeneration };
  }

  function setAntigravityProminentPeople(antigravityProminentPeople: AntigravityProminentPeople): void {
    options = { ...options, antigravityProminentPeople };
  }

  function setAntigravitySafetyFiltering(antigravitySafetyFiltering: AntigravitySafetyFiltering): void {
    options = { ...options, antigravitySafetyFiltering };
  }

  function setAntigravitySafetyThreshold(
    setting: AntigravitySafetyCategorySetting,
    value: AntigravitySafetyThreshold,
  ): void {
    options = { ...options, [setting]: value };
  }

  function antigravitySafetyCategoryValue(setting: AntigravitySafetyCategorySetting): AntigravitySafetyThreshold {
    return options[setting];
  }

  function antigravitySafetyCategoryLabel(setting: AntigravitySafetyCategorySetting): string {
    switch (setting) {
      case 'antigravitySafetyHarassment':
        return antigravitySafetyHarassmentLabel;
      case 'antigravitySafetyHateSpeech':
        return antigravitySafetyHateSpeechLabel;
      case 'antigravitySafetySexuallyExplicit':
        return antigravitySafetySexuallyExplicitLabel;
      case 'antigravitySafetyDangerousContent':
        return antigravitySafetyDangerousContentLabel;
    }
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
    if (!showCodexAgentOptions) return;
    void loadCodexCapabilities(
      options.codexExecutableMode === 'custom' ? options.codexBin : '',
    ).then((capabilities) => {
      codexCapabilities = capabilities;
    });
  });

  $effect(() => {
    if (!showClaudeDirectorOptions) return;
    void loadClaudeCapabilities(
      options.claudeExecutableMode === 'custom' ? options.claudeBin : '',
    ).then((capabilities) => {
      claudeCapabilities = capabilities;
    });
  });

  $effect(() => {
    if (!showAntigravityAgentOptions) return;
    void loadAntigravityCapabilities(
      options.antigravityExecutableMode === 'custom' ? options.antigravityBin : '',
    ).then((capabilities) => {
      antigravityCapabilities = capabilities;
    });
  });

  $effect(() => {
    if (!open) return;
    submenu;
    options.directorMode;
    options.directorProvider;
    options.directorInvolvement;
    options.imageProvider;
    options.antigravitySafetyFiltering;
    options.claudeModel;
    void updateMenuPosition();
  });

  $effect(() => {
    if (imageProvider !== 'antigravity') return;
    if (ANTIGRAVITY_IMAGE_MODEL_OPTIONS.some((item) => item.id === options.antigravityImageModel)) return;
    options = { ...options, antigravityImageModel: 'gemini-3.1-flash-image' };
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
      <div class="menu-title">Profile</div>
      <button type="button" class="profile-choice" class:active={settingsDefaultsActive()} onclick={applySettingsDefaults}>
        <span class="profile-choice-text">
          <span>Settings Defaults</span>
          <small>{profileMenuSummary(null)}</small>
        </span>
        {#if settingsDefaultsActive()}<Icon svg={Checkmark} size={15} />{/if}
      </button>
      {#if settings.value.ai.profiles.length}
        {#each settings.value.ai.profiles as profile (profile.id)}
          <button type="button" class="profile-choice" class:active={profileActive(profile.id)} onclick={() => applyProfile(profile.id)}>
            <span class="profile-choice-text">
              <span>{profile.name}</span>
              <small>{profileMenuSummary(profile.id)}</small>
            </span>
            {#if settings.value.ai.defaultProfileId === profile.id}<span class="profile-default">Default</span>{/if}
            {#if profileActive(profile.id)}<Icon svg={Checkmark} size={15} />{/if}
          </button>
        {/each}
      {/if}
      <div class="separator"></div>

        <div class="menu-title">AI Director</div>
        {#each directorProviders as provider (provider.value)}
          <button type="button" class:active={directorEnabled && directorProvider === provider.value} onclick={() => setDirectorProvider(provider.value)}>
            <span>{provider.label}</span>
            {#if directorEnabled && directorProvider === provider.value}<Icon svg={Checkmark} size={15} />{/if}
          </button>
        {/each}
        <button type="button" class:active={!directorEnabled} onclick={skipDirector}>
          <span>Skip</span>
          {#if !directorEnabled}<Icon svg={Checkmark} size={15} />{/if}
        </button>

        {#if directorEnabled}
          <button type="button" onclick={() => (submenu = submenu === 'directorInvolvement' ? null : 'directorInvolvement')}>
            <span>Involvement</span>
            <span class="value">{directorInvolvementLabel}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'directorInvolvement'}
            <div class="subitems">
              {#each directorInvolvementLevels as item (item.value)}
                <button type="button" class:active={directorInvolvement === item.value} onclick={() => setDirectorInvolvement(item.value)}>
                  <span>{item.label}</span>
                  {#if directorInvolvement === item.value}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
        {/if}

        <div class="separator"></div>
        <div class="menu-title">Image Generator</div>
        {#each providers as provider (provider.value)}
          <button type="button" class:active={imageProvider === provider.value} onclick={() => setImageProvider(provider.value)}>
            <span>{provider.label}</span>
            {#if imageProvider === provider.value}<Icon svg={Checkmark} size={15} />{/if}
          </button>
        {/each}

        {#if showCodexAgentOptions}
          <div class="separator"></div>
          <div class="menu-title">{directorEnabled ? 'Codex Director' : 'Codex Request'}</div>
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
            <span class="value">{availableReasoningEfforts.find((item) => item.value === options.reasoningEffort)?.label}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'reasoning'}
            <div class="subitems">
              {#each availableReasoningEfforts as item (item.value)}
                <button type="button" class:active={options.reasoningEffort === item.value} onclick={() => setReasoning(item.value as ReasoningEffort)}>
                  <span>{item.label}</span>
                  {#if options.reasoningEffort === item.value}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
          <button type="button" onclick={() => (submenu = submenu === 'model' ? null : 'model')}>
            <span>Model</span>
            <span class="value">{availableCodexModels.find((item) => item.id === options.model)?.label}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'model'}
            <div class="subitems">
              {#each availableCodexModels as item (item.id)}
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
        {/if}

        {#if showAntigravityAgentOptions}
          <div class="separator"></div>
          <div class="menu-title">Antigravity Director</div>
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

        {#if showClaudeDirectorOptions}
          <div class="separator"></div>
          <div class="menu-title">Claude Director</div>
          <button type="button" onclick={() => (submenu = submenu === 'claudeModel' ? null : 'claudeModel')}>
            <span>Model</span>
            <span class="value">{claudeModelLabel}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'claudeModel'}
            <div class="subitems">
              {#each claudeModelOptions as item (item.id)}
                <button type="button" class:active={options.claudeModel === item.id} onclick={() => setClaudeModel(item.id)}>
                  <span>{item.label}</span>
                  {#if options.claudeModel === item.id}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
          <button type="button" onclick={() => (submenu = submenu === 'claudeEffort' ? null : 'claudeEffort')}>
            <span>Effort</span>
            <span class="value">{claudeEffortLabel}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'claudeEffort'}
            <div class="subitems">
              {#each claudeEffortOptions as item (item.value)}
                <button type="button" class:active={options.claudeEffort === item.value} onclick={() => setClaudeEffort(item.value as ClaudeEffort)}>
                  <span>{item.label}</span>
                  {#if options.claudeEffort === item.value}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
        {/if}

        {#if imageProvider === 'codex'}
          <div class="separator"></div>
          <div class="menu-title">Codex Image</div>
          <button type="button" onclick={() => (submenu = submenu === 'quality' ? null : 'quality')}>
            <span>Quality</span>
            <span class="value">{imageQualities.find((item) => item.value === options.imageQuality)?.label}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'quality'}
            <div class="subitems">
              {#each imageQualities as item (item.value)}
                <button type="button" class:active={options.imageQuality === item.value} onclick={() => setImageQuality(item.value)}>
                  <span>{item.label}</span>
                  {#if options.imageQuality === item.value}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
          <button type="button" onclick={() => (submenu = submenu === 'moderation' ? null : 'moderation')}>
            <span>Moderation</span>
            <span class="value">{options.imageModeration === 'low' ? 'Low' : 'Default'}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'moderation'}
            <div class="subitems">
              {#each imageModerations as item (item.value)}
                <button type="button" class:active={options.imageModeration === item.value} onclick={() => setImageModeration(item.value)}>
                  <span>{item.label}</span>
                  {#if options.imageModeration === item.value}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
        {:else if imageProvider === 'antigravity'}
          <div class="separator"></div>
          <div class="menu-title">Antigravity Image</div>
          <button type="button" onclick={() => (submenu = submenu === 'antigravityImageModel' ? null : 'antigravityImageModel')}>
            <span>Image model</span>
            <span class="value">{antigravityImageModelLabel}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'antigravityImageModel'}
            <div class="subitems">
              {#each ANTIGRAVITY_IMAGE_MODEL_OPTIONS as item (item.id)}
                <button type="button" class:active={options.antigravityImageModel === item.id} onclick={() => setAntigravityImageModel(item.id)}>
                  <span>{item.label}</span>
                  {#if options.antigravityImageModel === item.id}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
          <button type="button" onclick={() => (submenu = submenu === 'antigravityImageSize' ? null : 'antigravityImageSize')}>
            <span>Image size</span>
            <span class="value">{antigravityImageSizeLabel}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'antigravityImageSize'}
            <div class="subitems">
              {#each ANTIGRAVITY_IMAGE_SIZE_OPTIONS as item (item.id)}
                <button type="button" class:active={options.antigravityImageSize === item.id} onclick={() => setAntigravityImageSize(item.id)}>
                  <span>{item.label}</span>
                  {#if options.antigravityImageSize === item.id}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
          <button type="button" onclick={() => (submenu = submenu === 'antigravityPersonGeneration' ? null : 'antigravityPersonGeneration')}>
            <span>Person generation</span>
            <span class="value">{antigravityPersonGenerationLabel}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'antigravityPersonGeneration'}
            <div class="subitems">
              {#each ANTIGRAVITY_PERSON_GENERATION_OPTIONS as item (item.id)}
                <button type="button" class:active={options.antigravityPersonGeneration === item.id} onclick={() => setAntigravityPersonGeneration(item.id)}>
                  <span>{item.label}</span>
                  {#if options.antigravityPersonGeneration === item.id}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
          <button type="button" onclick={() => (submenu = submenu === 'antigravityProminentPeople' ? null : 'antigravityProminentPeople')}>
            <span>Prominent people</span>
            <span class="value">{antigravityProminentPeopleLabel}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'antigravityProminentPeople'}
            <div class="subitems">
              {#each ANTIGRAVITY_PROMINENT_PEOPLE_OPTIONS as item (item.id)}
                <button type="button" class:active={options.antigravityProminentPeople === item.id} onclick={() => setAntigravityProminentPeople(item.id)}>
                  <span>{item.label}</span>
                  {#if options.antigravityProminentPeople === item.id}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
          <button type="button" onclick={() => (submenu = submenu === 'antigravitySafetyFiltering' ? null : 'antigravitySafetyFiltering')}>
            <span>Safety filtering</span>
            <span class="value">{antigravitySafetyFilteringLabel}</span>
            <Icon svg={ChevronRight} size={14} />
          </button>
          {#if submenu === 'antigravitySafetyFiltering'}
            <div class="subitems">
              {#each ANTIGRAVITY_SAFETY_FILTERING_OPTIONS as item (item.id)}
                <button type="button" class:active={options.antigravitySafetyFiltering === item.id} onclick={() => setAntigravitySafetyFiltering(item.id)}>
                  <span>{item.label}</span>
                  {#if options.antigravitySafetyFiltering === item.id}<Icon svg={Checkmark} size={15} />{/if}
                </button>
              {/each}
            </div>
          {/if}
          {#if options.antigravitySafetyFiltering === 'custom'}
            {#each ANTIGRAVITY_SAFETY_CATEGORY_OPTIONS as category (category.id)}
              <button type="button" onclick={() => (submenu = submenu === category.id ? null : category.id)}>
                <span>{category.label}</span>
                <span class="value">{antigravitySafetyCategoryLabel(category.id)}</span>
                <Icon svg={ChevronRight} size={14} />
              </button>
              {#if submenu === category.id}
                <div class="subitems">
                  {#each ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS as item (item.id)}
                    <button
                      type="button"
                      class:active={antigravitySafetyCategoryValue(category.id) === item.id}
                      onclick={() => setAntigravitySafetyThreshold(category.id, item.id)}
                    >
                      <span>{item.label}</span>
                      {#if antigravitySafetyCategoryValue(category.id) === item.id}<Icon svg={Checkmark} size={15} />{/if}
                    </button>
                  {/each}
                </div>
              {/if}
            {/each}
          {/if}
        {/if}
    </div>
  {/if}

  <button
    bind:this={pillElement}
    class="pill"
    type="button"
    disabled={disabled}
    aria-label={`AI generation flow: ${detailedSummary}`}
    use:tooltip={{ text: `AI generation flow: ${detailedSummary}`, placement: 'top' }}
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
    max-width: min(320px, 58vw);
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
  .menu button.profile-choice {
    align-items: start;
  }
  .profile-choice-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .profile-choice-text span {
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .profile-choice-text small {
    overflow: hidden;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .profile-default {
    padding: 1px 5px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    color: var(--text-dim);
    font-size: 10px;
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
