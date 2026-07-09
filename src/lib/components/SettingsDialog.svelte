<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { detectCodex, detectAntigravity, detectClaude, isDesktop, type CodexDetectionResult } from '../integrations/desktop';
  import { ChevronDown, ChevronRight, Delete, Edit } from '../icons';
  import {
    AUTOSAVE_INTERVAL_OPTIONS,
    ANTIGRAVITY_IMAGE_MODEL_OPTIONS,
    ANTIGRAVITY_IMAGE_SIZE_OPTIONS,
    ANTIGRAVITY_PERSON_GENERATION_OPTIONS,
    ANTIGRAVITY_PROMINENT_PEOPLE_OPTIONS,
    ANTIGRAVITY_SAFETY_CATEGORY_OPTIONS,
    ANTIGRAVITY_SAFETY_FILTERING_OPTIONS,
    ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS,
    type AiDirectorProvider,
    type AiDirectorInvolvement,
    type AiDirectorMode,
    type AiProvider,
    type AiRunOptions,
    type AiAutonomyLevel,
    type AiExecutableMode,
    type CanvasBackground,
    type CodexImageModeration,
    type CodexImageQuality,
    type CodexModelId,
    type ClaudeModelId,
    type ClaudeEffort,
    type AntigravityApprovalMode,
    type AntigravityModelId,
    type AntigravityImageModelId,
    type AntigravityImageSize,
    type AntigravityPersonGeneration,
    type AntigravityProminentPeople,
    type AntigravitySafetyCategorySetting,
    type AntigravitySafetyFiltering,
    type AntigravitySafetyThreshold,
    type ReasoningEffort,
    type ServiceTier,
    aiProfileOptionsFromRunOptions,
    aiProviderDefaultsFromSettings,
    aiProfileRunOptionsFromSettings,
    cloneAiRunOptions,
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
  import { providerDetectionSuccessMessage } from '../ai/providerDetectionMessage';
  import { ui } from '../state/ui.svelte';

  let { onClose }: { onClose: () => void } = $props();

  type SettingsGroupId = 'general' | 'workspace' | 'ai';
  type SettingsSectionId =
    | 'general-startup'
    | 'workspace-canvas'
    | 'workspace-view'
    | 'ai-general'
    | 'ai-provider-codex'
    | 'ai-provider-claude'
    | 'ai-provider-antigravity'
    | 'ai-profiles'
    | 'ai-artifacts';

  interface SettingsSection {
    id: SettingsSectionId;
    label: string;
    description: string;
  }

  interface SettingsGroup {
    id: SettingsGroupId;
    label: string;
    sections: SettingsSection[];
  }

  const SETTINGS_GROUPS: SettingsGroup[] = [
    {
      id: 'general',
      label: 'General',
      sections: [
        {
          id: 'general-startup',
          label: 'Startup & Recovery',
          description: 'Startup, recovery, and small editor behavior defaults.',
        },
      ],
    },
    {
      id: 'workspace',
      label: 'Workspace',
      sections: [
        {
          id: 'workspace-canvas',
          label: 'Canvas Defaults',
          description: 'New document size and background defaults.',
        },
        {
          id: 'workspace-view',
          label: 'View',
          description: 'Workspace display preferences.',
        },
      ],
    },
    {
      id: 'ai',
      label: 'AI',
      sections: [
        {
          id: 'ai-general',
          label: 'General',
          description: 'Cross-provider defaults for local AI planning, generation, and workflows.',
        },
        {
          id: 'ai-provider-codex',
          label: 'Codex',
          description: 'Codex Director, image-generation, and local connection defaults.',
        },
        {
          id: 'ai-provider-claude',
          label: 'Claude',
          description: 'Claude Director and local connection defaults.',
        },
        {
          id: 'ai-provider-antigravity',
          label: 'Antigravity',
          description: 'Antigravity Director, image-generation, safety, and local connection defaults.',
        },
        {
          id: 'ai-profiles',
          label: 'Profiles',
          description: 'Saved AI defaults for recurring generation and editing workflows.',
        },
        {
          id: 'ai-artifacts',
          label: 'Workflow Artifacts',
          description: 'User-facing AI run files and optional debug artifact retention.',
        },
      ],
    },
  ];

  const SECTION_BY_ID = new Map<SettingsSectionId, SettingsSection>(
    SETTINGS_GROUPS.flatMap((group) => group.sections.map((section) => [section.id, section] as const)),
  );

  const desktop = isDesktop();
  const serviceTiers: { value: ServiceTier; label: string; hint: string }[] = [
    { value: 'default', label: 'Default', hint: 'Use normal Codex speed.' },
    { value: 'fast', label: 'Fast', hint: 'Ask Codex to use fast mode for AI runs.' },
  ];
  const imageQualities: { value: CodexImageQuality; label: string; hint: string }[] = [
    { value: 'auto', label: 'Auto', hint: 'Let the image-generation tool choose quality.' },
    { value: 'low', label: 'Low', hint: 'Prefer faster draft generations.' },
    { value: 'medium', label: 'Medium', hint: 'Balance latency and output detail.' },
    { value: 'high', label: 'High', hint: 'Prefer final-quality output when the image tool supports it.' },
  ];
  const imageModerations: { value: CodexImageModeration; label: string; hint: string }[] = [
    { value: 'auto', label: 'Default', hint: 'Use normal image-generation moderation.' },
    { value: 'low', label: 'Low', hint: 'Use the image API low moderation mode when the owned runner supports it.' },
  ];
  const autonomyLevels: { value: AiAutonomyLevel; label: string; hint: string }[] = [
    { value: 'low', label: 'Low', hint: 'Keep Director/tool use conservative.' },
    { value: 'guided', label: 'Guided', hint: 'Allow focused tool use while staying close to the prompt.' },
    { value: 'open', label: 'Open', hint: 'Allow broader investigation and planning.' },
    { value: 'unmanaged', label: 'Unmanaged', hint: 'Let the agent decide how much autonomy the task needs.' },
  ];
  let selectedSection = $state<SettingsSectionId>('general-startup');
  let expandedGroups = $state<Record<SettingsGroupId, boolean>>({
    general: true,
    workspace: true,
    ai: true,
  });
  let detectBusy = $state(false);
  let claudeDetectBusy = $state(false);
  let antigravityDetectBusy = $state(false);
  let codexDetection = $state<CodexDetectionResult | null>(null);
  let claudeDetection = $state<CodexDetectionResult | null>(null);
  let antigravityDetection = $state<CodexDetectionResult | null>(null);
  let codexCapabilities = $state(FALLBACK_CODEX_CAPABILITIES);
  let claudeCapabilities = $state(FALLBACK_CLAUDE_CAPABILITIES);
  let antigravityCapabilities = $state(FALLBACK_ANTIGRAVITY_CAPABILITIES);
  const initialProfileId = settings.value.ai.defaultProfileId ?? settings.value.ai.profiles[0]?.id ?? '';
  let profileEditorMode = $state<'none' | 'new' | 'existing'>('none');
  let selectedProfileId = $state(initialProfileId);
  let profileDraftName = $state(settings.value.ai.profiles.find((profile) => profile.id === initialProfileId)?.name ?? '');
  let profileDraftOptions = $state(cloneAiRunOptions(aiProfileRunOptionsFromSettings(settings.value, initialProfileId || null)));
  let profileAdvancedOpen = $state(false);
  let antigravityGlobalAdvancedOpen = $state(false);
  let profileDeleteTargetId = $state<string | null>(null);
  const availableCodexModels = $derived(codexModelOptions(codexCapabilities, settings.value.ai.model));
  const availableCodexReasoningEfforts = $derived(
    codexReasoningOptions(codexCapabilities, settings.value.ai.model, settings.value.ai.reasoningEffort),
  );
  const profileCodexModels = $derived(codexModelOptions(codexCapabilities, profileDraftOptions.model));
  const profileCodexReasoningEfforts = $derived(
    codexReasoningOptions(codexCapabilities, profileDraftOptions.model, profileDraftOptions.reasoningEffort),
  );
  const availableClaudeModels = $derived(
    providerModelOptions(claudeCapabilities, settings.value.ai.claudeModel),
  );
  const availableClaudeEfforts = $derived(
    claudeReasoningOptions(claudeCapabilities, settings.value.ai.claudeModel, settings.value.ai.claudeEffort),
  );
  const availableAntigravityModels = $derived(
    providerModelOptions(antigravityCapabilities, settings.value.ai.antigravityModel),
  );
  const profileClaudeModels = $derived(providerModelOptions(claudeCapabilities, profileDraftOptions.claudeModel));
  const profileClaudeEfforts = $derived(
    claudeReasoningOptions(claudeCapabilities, profileDraftOptions.claudeModel, profileDraftOptions.claudeEffort),
  );
  const profileAntigravityModels = $derived(
    providerModelOptions(antigravityCapabilities, profileDraftOptions.antigravityModel),
  );
  const profileDeleteTarget = $derived(
    settings.value.ai.profiles.find((profile) => profile.id === profileDeleteTargetId) ?? null,
  );

  void loadCodexCapabilities(
    settings.value.ai.codexExecutableMode === 'custom' ? settings.value.ai.codexBin : '',
  ).then((capabilities) => {
    codexCapabilities = capabilities;
  });
  void loadClaudeCapabilities(
    settings.value.ai.claudeExecutableMode === 'custom' ? settings.value.ai.claudeBin : '',
  ).then((capabilities) => {
    claudeCapabilities = capabilities;
  });
  void loadAntigravityCapabilities(
    settings.value.ai.antigravityExecutableMode === 'custom' ? settings.value.ai.antigravityBin : '',
  ).then((capabilities) => {
    antigravityCapabilities = capabilities;
  });

  function sectionMeta(id: SettingsSectionId): SettingsSection {
    return SECTION_BY_ID.get(id) ?? SETTINGS_GROUPS[0].sections[0];
  }

  function sectionGroup(id: SettingsSectionId): SettingsGroup {
    return SETTINGS_GROUPS.find((group) => group.sections.some((section) => section.id === id)) ?? SETTINGS_GROUPS[0];
  }

  function groupContainsSelected(group: SettingsGroup): boolean {
    return group.sections.some((section) => section.id === selectedSection);
  }

  function selectSection(id: SettingsSectionId): void {
    selectedSection = id;
    const group = sectionGroup(id);
    expandedGroups = { ...expandedGroups, [group.id]: true };
  }

  function toggleGroup(groupId: SettingsGroupId): void {
    expandedGroups = { ...expandedGroups, [groupId]: !expandedGroups[groupId] };
  }

  function textValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  function checkedValue(event: Event): boolean {
    return (event.currentTarget as HTMLInputElement).checked;
  }

  function numberValue(event: Event): number {
    return Number((event.currentTarget as HTMLInputElement | HTMLSelectElement).value);
  }

  function optionalNumberValue(event: Event): number | null {
    const value = textValue(event).trim();
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function providerUsesCustomExecutable(provider: 'codex' | 'claude' | 'antigravity'): boolean {
    if (provider === 'codex') return settings.value.ai.codexExecutableMode === 'custom';
    if (provider === 'claude') return settings.value.ai.claudeExecutableMode === 'custom';
    return settings.value.ai.antigravityExecutableMode === 'custom';
  }

  function setExecutableMode(provider: 'codex' | 'claude' | 'antigravity', mode: AiExecutableMode): void {
    if (provider === 'codex') settings.update({ ai: { codexExecutableMode: mode } });
    else if (provider === 'claude') settings.update({ ai: { claudeExecutableMode: mode } });
    else settings.update({ ai: { antigravityExecutableMode: mode } });
  }

  function newProfileId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `ai-profile-${Date.now()}`;
  }

  function providerLabel(provider: AiProvider): string {
    return provider === 'antigravity' ? 'Antigravity' : 'Codex';
  }

  function directorProviderLabel(provider: AiDirectorProvider): string {
    return provider === 'claude' ? 'Claude' : providerLabel(provider);
  }

  function profileSummary(options: AiRunOptions): string {
    const imageProvider = options.imageProvider ?? options.provider;
    if (options.directorMode === 'skip') return `Director: Off · Image: ${providerLabel(imageProvider)}`;
    return `Director: ${directorProviderLabel(options.directorProvider)} · Image: ${providerLabel(imageProvider)}`;
  }

  function profileDetail(options: AiRunOptions): string {
    const imageProvider = options.imageProvider ?? options.provider;
    const imageDetail =
      imageProvider === 'codex'
        ? `${imageQualities.find((option) => option.value === options.imageQuality)?.label ?? 'Auto'} quality`
        : `${ANTIGRAVITY_IMAGE_SIZE_OPTIONS.find((option) => option.id === options.antigravityImageSize)?.label ?? 'Auto'} size`;
    if (options.directorMode === 'skip') return `No Director. ${providerLabel(imageProvider)} image generator, ${imageDetail}.`;
    const mode = options.directorMode === 'force' ? 'Always direct' : 'Auto direct';
    return `${mode} with ${directorProviderLabel(options.directorProvider)}. ${providerLabel(imageProvider)} image generator, ${imageDetail}.`;
  }

  function savedProfileSummary(profileId: string): string {
    return profileSummary(aiProfileRunOptionsFromSettings(settings.value, profileId));
  }

  function startNewProfile(options = aiProviderDefaultsFromSettings(settings.value), name = ''): void {
    selectedProfileId = '';
    profileEditorMode = 'new';
    profileDraftName = name;
    profileDraftOptions = cloneAiRunOptions(options);
    profileAdvancedOpen = false;
  }

  function loadProfileEditor(id: string): void {
    const profile = settings.value.ai.profiles.find((item) => item.id === id);
    if (!profile) {
      profileEditorMode = settings.value.ai.profiles.length ? 'existing' : 'none';
      return;
    }
    selectedProfileId = id;
    profileEditorMode = 'existing';
    profileDraftName = profile.name;
    profileDraftOptions = cloneAiRunOptions(aiProfileRunOptionsFromSettings(settings.value, id));
    profileAdvancedOpen = false;
  }

  function cancelProfileDraft(): void {
    profileEditorMode = 'none';
    selectedProfileId = '';
    profileDraftName = '';
    profileDraftOptions = cloneAiRunOptions(aiProviderDefaultsFromSettings(settings.value));
    profileAdvancedOpen = false;
  }

  function resetProfileDraftToDefaults(): void {
    profileDraftOptions = cloneAiRunOptions(aiProviderDefaultsFromSettings(settings.value));
    profileAdvancedOpen = false;
  }

  function revertProfileDraft(): void {
    if (profileEditorMode === 'existing' && selectedProfileId) loadProfileEditor(selectedProfileId);
    else resetProfileDraftToDefaults();
  }

  function updateProfileDraftOptions(patch: Partial<AiRunOptions>): void {
    profileDraftOptions = { ...profileDraftOptions, ...patch };
  }

  function setCodexModel(model: CodexModelId): void {
    settings.update({
      ai: {
        model,
        reasoningEffort: codexEffortForModel(
          codexCapabilities,
          model,
          settings.value.ai.reasoningEffort,
        ),
      },
    });
  }

  function setProfileCodexModel(model: CodexModelId): void {
    updateProfileDraftOptions({
      model,
      reasoningEffort: codexEffortForModel(
        codexCapabilities,
        model,
        profileDraftOptions.reasoningEffort,
      ),
    });
  }

  function setClaudeModel(claudeModel: ClaudeModelId): void {
    settings.update({
      ai: {
        claudeModel,
        claudeEffort: claudeEffortForModel(
          claudeCapabilities,
          claudeModel,
          settings.value.ai.claudeEffort,
        ),
      },
    });
  }

  function setProfileClaudeModel(claudeModel: ClaudeModelId): void {
    updateProfileDraftOptions({
      claudeModel,
      claudeEffort: claudeEffortForModel(
        claudeCapabilities,
        claudeModel,
        profileDraftOptions.claudeEffort,
      ),
    });
  }

  function saveProfileDraft(): void {
    const name = profileDraftName.trim();
    if (!name) return;
    if (profileEditorMode === 'new') {
      const id = newProfileId();
      const profiles = [
        ...settings.value.ai.profiles,
        {
          id,
          name,
          options: aiProfileOptionsFromRunOptions(profileDraftOptions),
        },
      ];
      settings.update({
        ai: {
          profiles,
        },
      });
      selectedProfileId = id;
      profileDraftName = name;
      profileEditorMode = 'none';
      return;
    }
    if (!selectedProfileId) return;
    settings.update({
      ai: {
        profiles: settings.value.ai.profiles.map((profile) =>
          profile.id === selectedProfileId
            ? { ...profile, name, options: aiProfileOptionsFromRunOptions(profileDraftOptions) }
            : profile,
        ),
      },
    });
    profileEditorMode = 'none';
  }

  function duplicateSelectedProfile(): void {
    const baseName = profileDraftName.trim() || 'AI Profile';
    startNewProfile(profileDraftOptions, `Copy of ${baseName}`);
  }

  function setDefaultProfile(id: string | null): void {
    settings.update({ ai: { defaultProfileId: id } });
  }

  function deleteProfile(id: string): void {
    const profiles = settings.value.ai.profiles.filter((profile) => profile.id !== id);
    const defaultProfileId = settings.value.ai.defaultProfileId === id ? null : settings.value.ai.defaultProfileId;
    settings.update({ ai: { profiles, defaultProfileId } });
    if (selectedProfileId === id) {
      profileEditorMode = 'none';
      selectedProfileId = '';
      profileDraftName = '';
      profileDraftOptions = cloneAiRunOptions(aiProviderDefaultsFromSettings(settings.value));
    }
    profileDeleteTargetId = null;
  }

  function requestDeleteProfile(id: string): void {
    profileDeleteTargetId = id;
  }

  function deleteSelectedProfile(): void {
    if (selectedProfileId) requestDeleteProfile(selectedProfileId);
  }

  function profileAntigravitySafetyCategoryValue(setting: AntigravitySafetyCategorySetting): AntigravitySafetyThreshold {
    return profileDraftOptions[setting];
  }

  function updateProfileAntigravitySafetyCategory(
    setting: AntigravitySafetyCategorySetting,
    value: AntigravitySafetyThreshold,
  ): void {
    updateProfileDraftOptions({ [setting]: value } as Partial<AiRunOptions>);
  }

  function antigravitySafetyCategoryValue(setting: AntigravitySafetyCategorySetting): AntigravitySafetyThreshold {
    return settings.value.ai[setting];
  }

  function updateAntigravitySafetyCategory(
    setting: AntigravitySafetyCategorySetting,
    value: AntigravitySafetyThreshold,
  ): void {
    switch (setting) {
      case 'antigravitySafetyHarassment':
        settings.update({ ai: { antigravitySafetyHarassment: value } });
        break;
      case 'antigravitySafetyHateSpeech':
        settings.update({ ai: { antigravitySafetyHateSpeech: value } });
        break;
      case 'antigravitySafetySexuallyExplicit':
        settings.update({ ai: { antigravitySafetySexuallyExplicit: value } });
        break;
      case 'antigravitySafetyDangerousContent':
        settings.update({ ai: { antigravitySafetyDangerousContent: value } });
        break;
    }
  }

  async function runCodexDetection(): Promise<void> {
    codexDetection = null;
    if (!desktop) {
      codexDetection = {
        found: false,
        path: null,
        version: null,
        error: 'Codex detection is available only in the desktop app.',
      };
      return;
    }
    detectBusy = true;
    try {
      const result = await detectCodex(providerUsesCustomExecutable('codex') ? settings.value.ai.codexBin : '');
      codexDetection = result;
      if (providerUsesCustomExecutable('codex') && result.found && result.path) {
        settings.update({ ai: { codexBin: result.path } });
      }
      if (result.found) {
        codexCapabilities = await loadCodexCapabilities(
          providerUsesCustomExecutable('codex') ? (result.path ?? settings.value.ai.codexBin) : '',
          true,
        );
      }
    } catch (error) {
      codexDetection = {
        found: false,
        path: null,
        version: null,
        error: (error as Error)?.message ?? String(error),
      };
    } finally {
      detectBusy = false;
    }
  }

  async function runClaudeDetection(): Promise<void> {
    claudeDetection = null;
    if (!desktop) {
      claudeDetection = {
        found: false,
        path: null,
        version: null,
        error: 'Claude detection is available only in the desktop app.',
      };
      return;
    }
    claudeDetectBusy = true;
    try {
      const result = await detectClaude(providerUsesCustomExecutable('claude') ? settings.value.ai.claudeBin : '');
      claudeDetection = result;
      if (providerUsesCustomExecutable('claude') && result.found && result.path) {
        settings.update({ ai: { claudeBin: result.path } });
      }
      if (result.found) {
        claudeCapabilities = await loadClaudeCapabilities(
          providerUsesCustomExecutable('claude') ? (result.path ?? settings.value.ai.claudeBin) : '',
          true,
        );
      }
    } catch (error) {
      claudeDetection = {
        found: false,
        path: null,
        version: null,
        error: (error as Error)?.message ?? String(error),
      };
    } finally {
      claudeDetectBusy = false;
    }
  }

  async function runAntigravityDetection(): Promise<void> {
    antigravityDetection = null;
    if (!desktop) {
      antigravityDetection = {
        found: false,
        path: null,
        version: null,
        error: 'Antigravity detection is available only in the desktop app.',
      };
      return;
    }
    antigravityDetectBusy = true;
    try {
      const result = await detectAntigravity(
        providerUsesCustomExecutable('antigravity') ? settings.value.ai.antigravityBin : '',
      );
      antigravityDetection = result;
      if (providerUsesCustomExecutable('antigravity') && result.found && result.path) {
        settings.update({ ai: { antigravityBin: result.path } });
      }
      if (result.found) {
        antigravityCapabilities = await loadAntigravityCapabilities(
          providerUsesCustomExecutable('antigravity') ? (result.path ?? settings.value.ai.antigravityBin) : '',
          true,
        );
      }
    } catch (error) {
      antigravityDetection = {
        found: false,
        path: null,
        version: null,
        error: (error as Error)?.message ?? String(error),
      };
    } finally {
      antigravityDetectBusy = false;
    }
  }

  $effect(() => {
    if (profileEditorMode !== 'existing') return;
    if (settings.value.ai.profiles.some((profile) => profile.id === selectedProfileId)) return;
    const nextId = settings.value.ai.defaultProfileId ?? settings.value.ai.profiles[0]?.id ?? '';
    if (nextId) loadProfileEditor(nextId);
    else {
      selectedProfileId = '';
      profileEditorMode = 'none';
      profileDraftName = '';
      profileDraftOptions = cloneAiRunOptions(aiProviderDefaultsFromSettings(settings.value));
    }
  });
</script>

<Modal title="Settings" {onClose} width={960} height={700} minWidth={760} minHeight={520} resizable>
  <div class="settings-shell">
    <nav class="settings-tree" aria-label="Settings sections">
      {#each SETTINGS_GROUPS as group (group.id)}
        <div class="tree-group" class:selected={groupContainsSelected(group)}>
          <button
            type="button"
            class="tree-group-button"
            aria-expanded={expandedGroups[group.id]}
            onclick={() => toggleGroup(group.id)}
          >
            <Icon svg={expandedGroups[group.id] ? ChevronDown : ChevronRight} size={14} />
            <span>{group.label}</span>
          </button>
          {#if expandedGroups[group.id]}
            <div class="tree-children">
              {#each group.sections as section (section.id)}
                <button
                  type="button"
                  class="tree-section-button"
                  class:active={selectedSection === section.id}
                  aria-current={selectedSection === section.id ? 'page' : undefined}
                  onclick={() => selectSection(section.id)}
                >
                  {section.label}
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </nav>

    <section class="settings-body">
      <div class="settings-scroll">
        <div class="section-head">
          <div class="breadcrumb">{sectionGroup(selectedSection).label} &gt; {sectionMeta(selectedSection).label}</div>
          <h2>{sectionMeta(selectedSection).label}</h2>
          <p>{sectionMeta(selectedSection).description}</p>
        </div>

      {#if selectedSection === 'general-startup'}
        <label class="check-row">
          <input
            type="checkbox"
            checked={settings.value.general.autosaveEnabled}
            onchange={(event) => settings.update({ general: { autosaveEnabled: checkedValue(event) } })}
          />
          <span>
            <strong>Autosave recovery copies</strong>
            <small>Write project recovery copies when a project folder is open.</small>
          </span>
        </label>

        <label class="field">
          <span>Autosave interval</span>
          <select
            value={settings.value.general.autosaveIntervalMs}
            disabled={!settings.value.general.autosaveEnabled}
            onchange={(event) => settings.update({ general: { autosaveIntervalMs: numberValue(event) } })}
          >
            {#each AUTOSAVE_INTERVAL_OPTIONS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>

        <label class="check-row">
          <input
            type="checkbox"
            checked={settings.value.general.reopenLastProject}
            onchange={(event) => settings.update({ general: { reopenLastProject: checkedValue(event) } })}
          />
          <span>
            <strong>Reopen last project on launch</strong>
            <small>Restore the most recently selected project folder.</small>
          </span>
        </label>

        <label class="check-row">
          <input
            type="checkbox"
            checked={settings.value.general.showContextualTaskBarOnStartup}
            onchange={(event) =>
              settings.update({ general: { showContextualTaskBarOnStartup: checkedValue(event) } })}
          />
          <span>
            <strong>Show contextual task bar on startup</strong>
            <small>Start each app session with the floating contextual tools visible.</small>
          </span>
        </label>
      {:else if selectedSection === 'ai-general'}
        <div class="settings-row">
          <div>
            <strong>Setup assistant</strong>
            <small>Check local provider availability and choose first-run AI defaults.</small>
          </div>
          <button type="button" class="secondary" onclick={() => ui.open('aiSetup')}>
            Open setup assistant…
          </button>
        </div>

        <div class="grid-3">
          <label class="field">
            <span>AI Director mode</span>
            <select
              value={settings.value.ai.directorMode}
              onchange={(event) => settings.update({ ai: { directorMode: textValue(event) as AiDirectorMode } })}
            >
              <option value="auto">Auto by task</option>
              <option value="skip">Skip Director</option>
              <option value="force">Always direct</option>
            </select>
          </label>

          <label class="field">
            <span>AI Director provider</span>
            <select
              value={settings.value.ai.directorProvider}
              disabled={settings.value.ai.directorMode === 'skip'}
              onchange={(event) => settings.update({ ai: { directorProvider: textValue(event) as AiDirectorProvider } })}
            >
              <option value="codex">Codex</option>
              <option value="antigravity">Antigravity</option>
              <option value="claude">Claude</option>
            </select>
          </label>

          <label class="field">
            <span>AI Director involvement</span>
            <select
              value={settings.value.ai.directorInvolvement}
              disabled={settings.value.ai.directorMode === 'skip'}
              onchange={(event) => settings.update({ ai: { directorInvolvement: textValue(event) as AiDirectorInvolvement } })}
            >
              <option value="planOnly">Plan only</option>
              <option value="ensureCompletion">Ensure completion</option>
              <option value="fullReview">Full review</option>
            </select>
          </label>

          <label class="field">
            <span>Image generator</span>
            <select
              value={settings.value.ai.imageProvider}
              onchange={(event) => {
                const provider = textValue(event) as AiProvider;
                settings.update({ ai: { provider, imageProvider: provider } });
              }}
            >
              <option value="codex">Codex image generator</option>
              <option value="antigravity">Antigravity image generator</option>
            </select>
          </label>
        </div>

      {:else if selectedSection === 'ai-provider-codex'}
        <div class="subsection-title">
          <h3>Local Connection</h3>
        </div>
        <div class="choice-group" role="radiogroup" aria-label="Codex executable source">
          <label class="choice-row">
            <input
              type="radio"
              name="codex-executable-mode"
              value="builtin"
              checked={settings.value.ai.codexExecutableMode === 'builtin'}
              onchange={() => setExecutableMode('codex', 'builtin')}
            />
            <span>
              <strong>Use bundled Codex SDK</strong>
              <small>Default for PaintNode. Uses the app's bundled runner and your local Codex login.</small>
            </span>
          </label>
          <label class="choice-row">
            <input
              type="radio"
              name="codex-executable-mode"
              value="custom"
              checked={settings.value.ai.codexExecutableMode === 'custom'}
              onchange={() => setExecutableMode('codex', 'custom')}
            />
            <span>
              <strong>Use custom Codex executable</strong>
              <small>Choose this only when you need PaintNode to run a specific local Codex binary.</small>
            </span>
          </label>
        </div>

        {#if settings.value.ai.codexExecutableMode === 'custom'}
          <div class="detect-row">
            <label class="field">
              <span>Codex executable path</span>
              <input
                type="text"
                value={settings.value.ai.codexBin}
                placeholder="codex or full path"
                spellcheck="false"
                oninput={(event) => settings.update({ ai: { codexBin: textValue(event) } })}
              />
            </label>
            <button type="button" onclick={runCodexDetection} disabled={detectBusy}>
              {detectBusy ? 'Detecting...' : 'Detect'}
            </button>
          </div>
        {:else}
          <button type="button" class="secondary" onclick={runCodexDetection} disabled={detectBusy}>
            {detectBusy ? 'Checking...' : 'Check Codex'}
          </button>
        {/if}

        {#if codexDetection}
          <p class:ok={codexDetection.found} class:error={!codexDetection.found} class="status-line">
            {#if codexDetection.found}
              {providerDetectionSuccessMessage('codex', codexDetection, settings.value.ai.codexExecutableMode)}
            {:else}
              {codexDetection.error || 'Codex was not found.'}
            {/if}
          </p>
        {/if}

        <div class="subsection-title">
          <h3>AI Director</h3>
          <span>Used only when Codex is selected as the Director provider.</span>
        </div>

        <div class="grid-2">
          <label class="field">
            <span>Model</span>
            <select
              value={settings.value.ai.model}
              onchange={(event) => setCodexModel(textValue(event) as CodexModelId)}
            >
              {#each availableCodexModels as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>

          <label class="field">
            <span>Reasoning effort</span>
            <select
              value={settings.value.ai.reasoningEffort}
              onchange={(event) =>
                settings.update({ ai: { reasoningEffort: textValue(event) as ReasoningEffort } })}
            >
              {#each availableCodexReasoningEfforts as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
        </div>

        <div class="grid-2">
          <label class="field">
            <span>Codex speed</span>
            <select
              value={settings.value.ai.serviceTier}
              onchange={(event) => settings.update({ ai: { serviceTier: textValue(event) as ServiceTier } })}
            >
              {#each serviceTiers as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
            <small>{serviceTiers.find((option) => option.value === settings.value.ai.serviceTier)?.hint}</small>
          </label>
        </div>

        <div class="subsection-title">
          <h3>Image Generator</h3>
          <span>Used only when Codex is selected as the image generator.</span>
        </div>

        <div class="grid-2">
          <label class="field">
            <span>Image quality</span>
            <select
              value={settings.value.ai.imageQuality}
              onchange={(event) => settings.update({ ai: { imageQuality: textValue(event) as CodexImageQuality } })}
            >
              {#each imageQualities as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
            <small>{imageQualities.find((option) => option.value === settings.value.ai.imageQuality)?.hint}</small>
          </label>

          <label class="field">
            <span>Image moderation</span>
            <select
              value={settings.value.ai.imageModeration}
              onchange={(event) =>
                settings.update({ ai: { imageModeration: textValue(event) as CodexImageModeration } })}
            >
              {#each imageModerations as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
            <small>{imageModerations.find((option) => option.value === settings.value.ai.imageModeration)?.hint}</small>
          </label>
        </div>

      {:else if selectedSection === 'ai-provider-claude'}
        <div class="subsection-title">
          <h3>Local Connection</h3>
        </div>
        <div class="choice-group" role="radiogroup" aria-label="Claude executable source">
          <label class="choice-row">
            <input
              type="radio"
              name="claude-executable-mode"
              value="builtin"
              checked={settings.value.ai.claudeExecutableMode === 'builtin'}
              onchange={() => setExecutableMode('claude', 'builtin')}
            />
            <span>
              <strong>Use bundled Claude Agent SDK</strong>
              <small>Default for PaintNode. Uses the SDK runner and your local Claude Code login.</small>
            </span>
          </label>
          <label class="choice-row">
            <input
              type="radio"
              name="claude-executable-mode"
              value="custom"
              checked={settings.value.ai.claudeExecutableMode === 'custom'}
              onchange={() => setExecutableMode('claude', 'custom')}
            />
            <span>
              <strong>Use custom Claude Code executable</strong>
              <small>Choose this only when you need PaintNode to run a specific local Claude binary.</small>
            </span>
          </label>
        </div>

        {#if settings.value.ai.claudeExecutableMode === 'custom'}
          <div class="detect-row">
            <label class="field">
              <span>Claude Code executable path</span>
              <input
                type="text"
                value={settings.value.ai.claudeBin}
                placeholder="claude or full path"
                spellcheck="false"
                oninput={(event) => settings.update({ ai: { claudeBin: textValue(event) } })}
              />
            </label>
            <button type="button" onclick={runClaudeDetection} disabled={claudeDetectBusy}>
              {claudeDetectBusy ? 'Detecting...' : 'Detect'}
            </button>
          </div>
        {:else}
          <button type="button" class="secondary" onclick={runClaudeDetection} disabled={claudeDetectBusy}>
            {claudeDetectBusy ? 'Checking...' : 'Check Claude'}
          </button>
        {/if}

        {#if claudeDetection}
          <p class:ok={claudeDetection.found} class:error={!claudeDetection.found} class="status-line">
            {#if claudeDetection.found}
              {providerDetectionSuccessMessage('claude', claudeDetection, settings.value.ai.claudeExecutableMode)}
            {:else}
              {claudeDetection.error || 'Claude Code was not found.'}
            {/if}
          </p>
        {/if}

        <div class="subsection-title">
          <h3>AI Director</h3>
          <span>Used only when Claude is selected as the Director provider.</span>
        </div>

        <div class="grid-2">
          <label class="field">
            <span>Director model</span>
            <select value={settings.value.ai.claudeModel} onchange={(event) => setClaudeModel(textValue(event))}>
              {#each availableClaudeModels as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>
          <label class="field">
            <span>Effort</span>
            <select
              value={settings.value.ai.claudeEffort}
              onchange={(event) => settings.update({ ai: { claudeEffort: textValue(event) as ClaudeEffort } })}
            >
              {#each availableClaudeEfforts as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
        </div>

        <div class="subsection-title">
          <h3>Image Generator</h3>
          <span>Claude is not used for image generation.</span>
        </div>

        <p class="section-note">
          Choose Codex or Antigravity as the image generator in AI &gt; General. Claude can still direct the workflow.
        </p>

      {:else if selectedSection === 'ai-provider-antigravity'}
        <div class="subsection-title">
          <h3>Local Connection</h3>
        </div>
        <div class="choice-group" role="radiogroup" aria-label="Antigravity executable source">
          <label class="choice-row">
            <input
              type="radio"
              name="antigravity-executable-mode"
              value="builtin"
              checked={settings.value.ai.antigravityExecutableMode === 'builtin'}
              onchange={() => setExecutableMode('antigravity', 'builtin')}
            />
            <span>
              <strong>Use PaintNode Antigravity connector</strong>
              <small>Default for PaintNode. Uses the built-in image executor and Antigravity login session.</small>
            </span>
          </label>
          <label class="choice-row">
            <input
              type="radio"
              name="antigravity-executable-mode"
              value="custom"
              checked={settings.value.ai.antigravityExecutableMode === 'custom'}
              onchange={() => setExecutableMode('antigravity', 'custom')}
            />
            <span>
              <strong>Use custom Antigravity executable</strong>
              <small>Choose this only when you need PaintNode to run a specific local <code>agy</code> binary.</small>
            </span>
          </label>
        </div>

        {#if settings.value.ai.antigravityExecutableMode === 'custom'}
          <div class="detect-row">
            <label class="field">
              <span>Antigravity executable path</span>
              <input
                type="text"
                value={settings.value.ai.antigravityBin}
                placeholder="agy, ~/.local/bin/agy, /opt/homebrew/bin/agy, or /usr/local/bin/agy"
                spellcheck="false"
                oninput={(event) => settings.update({ ai: { antigravityBin: textValue(event) } })}
              />
            </label>
            <button type="button" onclick={runAntigravityDetection} disabled={antigravityDetectBusy}>
              {antigravityDetectBusy ? 'Detecting...' : 'Detect'}
            </button>
          </div>
        {:else}
          <button type="button" class="secondary" onclick={runAntigravityDetection} disabled={antigravityDetectBusy}>
            {antigravityDetectBusy ? 'Checking...' : 'Check Antigravity'}
          </button>
        {/if}

        {#if antigravityDetection}
          <p class:ok={antigravityDetection.found} class:error={!antigravityDetection.found} class="status-line">
            {#if antigravityDetection.found}
              {providerDetectionSuccessMessage(
                'antigravity',
                antigravityDetection,
                settings.value.ai.antigravityExecutableMode,
              )}
            {:else}
              {antigravityDetection.error || 'Antigravity CLI was not found.'}
            {/if}
          </p>
        {/if}

        <div class="subsection-title">
          <h3>AI Director</h3>
          <span>Used only when Antigravity is selected as the Director provider.</span>
        </div>

        <div class="grid-2">
          <label class="field">
            <span>Director model</span>
            <select
              value={settings.value.ai.antigravityModel}
              onchange={(event) =>
                settings.update({ ai: { antigravityModel: textValue(event) as AntigravityModelId } })}
            >
              {#each availableAntigravityModels as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>

          <label class="field">
            <span>Approval mode</span>
            <select
              value={settings.value.ai.antigravityApprovalMode}
              onchange={(event) =>
                settings.update({ ai: { antigravityApprovalMode: textValue(event) as AntigravityApprovalMode } })}
            >
              <option value="skipPermissions">Skip permission prompts</option>
              <option value="default">Ask when needed</option>
            </select>
          </label>
        </div>

        <div class="subsection-title">
          <h3>Image Generator</h3>
          <span>Used only when Antigravity is selected as the image generator.</span>
        </div>

        <div class="grid-2">
          <label class="field">
            <span>Image model</span>
            <select
              value={settings.value.ai.antigravityImageModel}
              onchange={(event) =>
                settings.update({ ai: { antigravityImageModel: textValue(event) as AntigravityImageModelId } })}
            >
              {#each ANTIGRAVITY_IMAGE_MODEL_OPTIONS as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>

          <label class="field">
            <span>Image size</span>
            <select
              value={settings.value.ai.antigravityImageSize}
              onchange={(event) =>
                settings.update({ ai: { antigravityImageSize: textValue(event) as AntigravityImageSize } })}
            >
              {#each ANTIGRAVITY_IMAGE_SIZE_OPTIONS as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>
        </div>

        <div class="grid-2">
          <label class="field">
            <span>Person generation</span>
            <select
              value={settings.value.ai.antigravityPersonGeneration}
              onchange={(event) =>
                settings.update({ ai: { antigravityPersonGeneration: textValue(event) as AntigravityPersonGeneration } })}
            >
              {#each ANTIGRAVITY_PERSON_GENERATION_OPTIONS as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>

          <label class="field">
            <span>Prominent people</span>
            <select
              value={settings.value.ai.antigravityProminentPeople}
              onchange={(event) =>
                settings.update({ ai: { antigravityProminentPeople: textValue(event) as AntigravityProminentPeople } })}
            >
              {#each ANTIGRAVITY_PROMINENT_PEOPLE_OPTIONS as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
          </label>
        </div>

        <label class="field">
          <span>Safety filtering</span>
          <select
            value={settings.value.ai.antigravitySafetyFiltering}
            onchange={(event) =>
              settings.update({ ai: { antigravitySafetyFiltering: textValue(event) as AntigravitySafetyFiltering } })}
          >
            {#each ANTIGRAVITY_SAFETY_FILTERING_OPTIONS as option (option.id)}
              <option value={option.id}>{option.label}</option>
            {/each}
          </select>
        </label>

        {#if settings.value.ai.antigravitySafetyFiltering === 'custom'}
          <div class="grid-2">
            {#each ANTIGRAVITY_SAFETY_CATEGORY_OPTIONS as category (category.id)}
              <label class="field">
                <span>{category.label}</span>
                <select
                  value={antigravitySafetyCategoryValue(category.id)}
                  onchange={(event) =>
                    updateAntigravitySafetyCategory(category.id, textValue(event) as AntigravitySafetyThreshold)}
                >
                  {#each ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS as option (option.id)}
                    <option value={option.id}>{option.label}</option>
                  {/each}
                </select>
              </label>
            {/each}
          </div>
        {/if}

        <label class="field">
          <span>Compression quality</span>
          <input
            type="number"
            min="0"
            max="100"
            value={settings.value.ai.antigravityCompressionQuality ?? ''}
            placeholder="Auto"
            oninput={(event) => settings.update({ ai: { antigravityCompressionQuality: optionalNumberValue(event) } })}
          />
        </label>

        <details class="advanced-section" bind:open={antigravityGlobalAdvancedOpen}>
          <summary>Advanced</summary>
          <label class="field">
            <span>Developer image options JSON</span>
            <textarea
              rows="3"
              spellcheck="false"
              value={settings.value.ai.antigravityAdvancedOptionsJson}
              oninput={(event) => settings.update({ ai: { antigravityAdvancedOptionsJson: textValue(event) } })}
            ></textarea>
            <small>
              Optional Antigravity image request overrides for confirmed fields such as aspect ratio, image size,
              person policy, compression quality, or JPEG output. Leave as <code>{'{}'}</code> unless testing a specific
              provider option.
            </small>
          </label>
        </details>

      {:else if selectedSection === 'ai-profiles'}
        <div class="profiles-page">
          <div class="profile-list-head">
            <div>
              <h3>Saved Profiles</h3>
              <span>{settings.value.ai.profiles.length} saved</span>
            </div>
            <button type="button" onclick={() => startNewProfile()}>Create Profile</button>
          </div>

          {#if settings.value.ai.profiles.length}
            <div class="profile-list" aria-label="Saved AI profiles">
              {#each settings.value.ai.profiles as profile (profile.id)}
                <div class="profile-list-item">
                  <div class="profile-list-main">
                    <span class="profile-list-title">
                      <strong>{profile.name}</strong>
                      {#if settings.value.ai.defaultProfileId === profile.id}<em>Default</em>{/if}
                    </span>
                    <small>{savedProfileSummary(profile.id)}</small>
                  </div>
                  <div class="profile-row-actions">
                    <button
                      type="button"
                      class="icon-button"
                      aria-label={`Edit ${profile.name}`}
                      use:tooltip={{ text: 'Edit profile', placement: 'top' }}
                      onclick={() => loadProfileEditor(profile.id)}
                    >
                      <Icon svg={Edit} size={14} />
                    </button>
                    <button
                      type="button"
                      class="icon-button"
                      aria-label={`Delete ${profile.name}`}
                      use:tooltip={{ text: 'Delete profile', placement: 'top' }}
                      onclick={() => requestDeleteProfile(profile.id)}
                    >
                      <Icon svg={Delete} size={14} />
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {:else}
            <p class="profile-empty-copy">No saved profiles.</p>
          {/if}
        </div>

        {#if profileEditorMode !== 'none'}
          <Modal
            title={profileEditorMode === 'new' ? 'Create Profile' : 'Edit Profile'}
            onClose={cancelProfileDraft}
            width={720}
            height={640}
            minWidth={560}
            minHeight={420}
            resizable
          >
            <div class="profile-editor-dialog">
              <div class="profile-editor-panel">
                <div class="profile-editor-head">
                  <label class="field">
                    <span>Profile name</span>
                    <input
                      type="text"
                      value={profileDraftName}
                      placeholder="High quality: Claude + Codex"
                      oninput={(event) => (profileDraftName = textValue(event))}
                    />
                  </label>
                  <div class="profile-summary-box">
                    <span>{profileSummary(profileDraftOptions)}</span>
                    <small>{profileDetail(profileDraftOptions)}</small>
                  </div>
                </div>

                <div class="profile-section">
                  <div class="subsection-title">
                    <h3>AI Director</h3>
                    <span>Saved into this profile and loaded from AI dialogs.</span>
                  </div>

                  <div class="segmented" role="radiogroup" aria-label="AI Director mode">
                    <label>
                      <input
                        type="radio"
                        name="profile-director-mode"
                        value="auto"
                        checked={profileDraftOptions.directorMode === 'auto'}
                        onchange={() => updateProfileDraftOptions({ directorMode: 'auto' })}
                      />
                      <span>Auto</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="profile-director-mode"
                        value="force"
                        checked={profileDraftOptions.directorMode === 'force'}
                        onchange={() => updateProfileDraftOptions({ directorMode: 'force' })}
                      />
                      <span>Always direct</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="profile-director-mode"
                        value="skip"
                        checked={profileDraftOptions.directorMode === 'skip'}
                        onchange={() => updateProfileDraftOptions({ directorMode: 'skip' })}
                      />
                      <span>Skip</span>
                    </label>
                  </div>

                  {#if profileDraftOptions.directorMode !== 'skip'}
                    <div class="segmented" role="radiogroup" aria-label="AI Director provider">
                      <label>
                        <input
                          type="radio"
                          name="profile-director-provider"
                          value="codex"
                          checked={profileDraftOptions.directorProvider === 'codex'}
                          onchange={() => updateProfileDraftOptions({ directorProvider: 'codex' })}
                        />
                        <span>Codex</span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="profile-director-provider"
                          value="antigravity"
                          checked={profileDraftOptions.directorProvider === 'antigravity'}
                          onchange={() => updateProfileDraftOptions({ directorProvider: 'antigravity' })}
                        />
                        <span>Antigravity</span>
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="profile-director-provider"
                          value="claude"
                          checked={profileDraftOptions.directorProvider === 'claude'}
                          onchange={() => updateProfileDraftOptions({ directorProvider: 'claude' })}
                        />
                        <span>Claude</span>
                      </label>
                    </div>

                    <label class="field">
                      <span>Involvement</span>
                      <select
                        value={profileDraftOptions.directorInvolvement}
                        onchange={(event) =>
                          updateProfileDraftOptions({ directorInvolvement: textValue(event) as AiDirectorInvolvement })}
                      >
                        <option value="planOnly">Plan only</option>
                        <option value="ensureCompletion">Ensure completion</option>
                        <option value="fullReview">Full review</option>
                      </select>
                    </label>

                    {#if profileDraftOptions.directorProvider === 'codex'}
                      <div class="grid-2">
                        <label class="field">
                          <span>Model</span>
                          <select
                            value={profileDraftOptions.model}
                            onchange={(event) => setProfileCodexModel(textValue(event) as CodexModelId)}
                          >
                            {#each profileCodexModels as option (option.id)}
                              <option value={option.id}>{option.label}</option>
                            {/each}
                          </select>
                        </label>

                        <label class="field">
                          <span>Reasoning effort</span>
                          <select
                            value={profileDraftOptions.reasoningEffort}
                            onchange={(event) =>
                              updateProfileDraftOptions({ reasoningEffort: textValue(event) as ReasoningEffort })}
                          >
                            {#each profileCodexReasoningEfforts as option (option.value)}
                              <option value={option.value}>{option.label}</option>
                            {/each}
                          </select>
                        </label>
                      </div>

                      <div class="grid-2">
                        <label class="field">
                          <span>Autonomy</span>
                          <select
                            value={profileDraftOptions.autonomyLevel}
                            onchange={(event) =>
                              updateProfileDraftOptions({ autonomyLevel: textValue(event) as AiAutonomyLevel })}
                          >
                            {#each autonomyLevels as option (option.value)}
                              <option value={option.value}>{option.label}</option>
                            {/each}
                          </select>
                          <small>{autonomyLevels.find((option) => option.value === profileDraftOptions.autonomyLevel)?.hint}</small>
                        </label>

                        <label class="field">
                          <span>Codex speed</span>
                          <select
                            value={profileDraftOptions.serviceTier}
                            onchange={(event) =>
                              updateProfileDraftOptions({ serviceTier: textValue(event) as ServiceTier })}
                          >
                            {#each serviceTiers as option (option.value)}
                              <option value={option.value}>{option.label}</option>
                            {/each}
                          </select>
                          <small>{serviceTiers.find((option) => option.value === profileDraftOptions.serviceTier)?.hint}</small>
                        </label>
                      </div>
                    {:else if profileDraftOptions.directorProvider === 'antigravity'}
                      <div class="grid-2">
                        <label class="field">
                          <span>Director model</span>
                          <select
                            value={profileDraftOptions.antigravityModel}
                            onchange={(event) =>
                              updateProfileDraftOptions({ antigravityModel: textValue(event) as AntigravityModelId })}
                          >
                            {#each profileAntigravityModels as option (option.id)}
                              <option value={option.id}>{option.label}</option>
                            {/each}
                          </select>
                        </label>

                        <label class="field">
                          <span>Approval mode</span>
                          <select
                            value={profileDraftOptions.antigravityApprovalMode}
                            onchange={(event) =>
                              updateProfileDraftOptions({
                                antigravityApprovalMode: textValue(event) as AntigravityApprovalMode,
                              })}
                          >
                            <option value="skipPermissions">Skip permission prompts</option>
                            <option value="default">Ask when needed</option>
                          </select>
                        </label>
                      </div>

                      <label class="field">
                        <span>Autonomy</span>
                        <select
                          value={profileDraftOptions.autonomyLevel}
                          onchange={(event) =>
                            updateProfileDraftOptions({ autonomyLevel: textValue(event) as AiAutonomyLevel })}
                        >
                          {#each autonomyLevels as option (option.value)}
                            <option value={option.value}>{option.label}</option>
                          {/each}
                        </select>
                        <small>{autonomyLevels.find((option) => option.value === profileDraftOptions.autonomyLevel)?.hint}</small>
                      </label>
                    {:else}
                      <div class="grid-2">
                        <label class="field">
                          <span>Director model</span>
                          <select
                            value={profileDraftOptions.claudeModel}
                            onchange={(event) => setProfileClaudeModel(textValue(event))}
                          >
                            {#each profileClaudeModels as option (option.id)}
                              <option value={option.id}>{option.label}</option>
                            {/each}
                          </select>
                        </label>
                        <label class="field">
                          <span>Effort</span>
                          <select
                            value={profileDraftOptions.claudeEffort}
                            onchange={(event) =>
                              updateProfileDraftOptions({ claudeEffort: textValue(event) as ClaudeEffort })}
                          >
                            {#each profileClaudeEfforts as option (option.value)}
                              <option value={option.value}>{option.label}</option>
                            {/each}
                          </select>
                        </label>
                      </div>
                    {/if}
                  {/if}
                </div>

                <div class="profile-section">
                  <div class="subsection-title">
                    <h3>Image Generator</h3>
                    <span>Claude is not available for image generation.</span>
                  </div>

                  <div class="segmented" role="radiogroup" aria-label="Image generator">
                    <label>
                      <input
                        type="radio"
                        name="profile-image-provider"
                        value="codex"
                        checked={profileDraftOptions.imageProvider === 'codex'}
                        onchange={() => updateProfileDraftOptions({ provider: 'codex', imageProvider: 'codex' })}
                      />
                      <span>Codex</span>
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="profile-image-provider"
                        value="antigravity"
                        checked={profileDraftOptions.imageProvider === 'antigravity'}
                        onchange={() =>
                          updateProfileDraftOptions({ provider: 'antigravity', imageProvider: 'antigravity' })}
                      />
                      <span>Antigravity</span>
                    </label>
                  </div>

                  {#if profileDraftOptions.imageProvider === 'codex'}
                    <div class="grid-2">
                      <label class="field">
                        <span>Image quality</span>
                        <select
                          value={profileDraftOptions.imageQuality}
                          onchange={(event) =>
                            updateProfileDraftOptions({ imageQuality: textValue(event) as CodexImageQuality })}
                        >
                          {#each imageQualities as option (option.value)}
                            <option value={option.value}>{option.label}</option>
                          {/each}
                        </select>
                        <small>{imageQualities.find((option) => option.value === profileDraftOptions.imageQuality)?.hint}</small>
                      </label>

                      <label class="field">
                        <span>Image moderation</span>
                        <select
                          value={profileDraftOptions.imageModeration}
                          onchange={(event) =>
                            updateProfileDraftOptions({
                              imageModeration: textValue(event) as CodexImageModeration,
                            })}
                        >
                          {#each imageModerations as option (option.value)}
                            <option value={option.value}>{option.label}</option>
                          {/each}
                        </select>
                        <small>{imageModerations.find((option) => option.value === profileDraftOptions.imageModeration)?.hint}</small>
                      </label>
                    </div>
                  {:else}
                    <div class="grid-2">
                      <label class="field">
                        <span>Image model</span>
                        <select
                          value={profileDraftOptions.antigravityImageModel}
                          onchange={(event) =>
                            updateProfileDraftOptions({
                              antigravityImageModel: textValue(event) as AntigravityImageModelId,
                            })}
                        >
                          {#each ANTIGRAVITY_IMAGE_MODEL_OPTIONS as option (option.id)}
                            <option value={option.id}>{option.label}</option>
                          {/each}
                        </select>
                      </label>

                      <label class="field">
                        <span>Image size</span>
                        <select
                          value={profileDraftOptions.antigravityImageSize}
                          onchange={(event) =>
                            updateProfileDraftOptions({ antigravityImageSize: textValue(event) as AntigravityImageSize })}
                        >
                          {#each ANTIGRAVITY_IMAGE_SIZE_OPTIONS as option (option.id)}
                            <option value={option.id}>{option.label}</option>
                          {/each}
                        </select>
                      </label>
                    </div>

                    <div class="grid-2">
                      <label class="field">
                        <span>Person generation</span>
                        <select
                          value={profileDraftOptions.antigravityPersonGeneration}
                          onchange={(event) =>
                            updateProfileDraftOptions({
                              antigravityPersonGeneration: textValue(event) as AntigravityPersonGeneration,
                            })}
                        >
                          {#each ANTIGRAVITY_PERSON_GENERATION_OPTIONS as option (option.id)}
                            <option value={option.id}>{option.label}</option>
                          {/each}
                        </select>
                      </label>

                      <label class="field">
                        <span>Prominent people</span>
                        <select
                          value={profileDraftOptions.antigravityProminentPeople}
                          onchange={(event) =>
                            updateProfileDraftOptions({
                              antigravityProminentPeople: textValue(event) as AntigravityProminentPeople,
                            })}
                        >
                          {#each ANTIGRAVITY_PROMINENT_PEOPLE_OPTIONS as option (option.id)}
                            <option value={option.id}>{option.label}</option>
                          {/each}
                        </select>
                      </label>
                    </div>

                    <label class="field">
                      <span>Safety filtering</span>
                      <select
                        value={profileDraftOptions.antigravitySafetyFiltering}
                        onchange={(event) =>
                          updateProfileDraftOptions({
                            antigravitySafetyFiltering: textValue(event) as AntigravitySafetyFiltering,
                          })}
                      >
                        {#each ANTIGRAVITY_SAFETY_FILTERING_OPTIONS as option (option.id)}
                          <option value={option.id}>{option.label}</option>
                        {/each}
                      </select>
                    </label>

                    {#if profileDraftOptions.antigravitySafetyFiltering === 'custom'}
                      <div class="grid-2">
                        {#each ANTIGRAVITY_SAFETY_CATEGORY_OPTIONS as category (category.id)}
                          <label class="field">
                            <span>{category.label}</span>
                            <select
                              value={profileAntigravitySafetyCategoryValue(category.id)}
                              onchange={(event) =>
                                updateProfileAntigravitySafetyCategory(
                                  category.id,
                                  textValue(event) as AntigravitySafetyThreshold,
                                )}
                            >
                              {#each ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS as option (option.id)}
                                <option value={option.id}>{option.label}</option>
                              {/each}
                            </select>
                          </label>
                        {/each}
                      </div>
                    {/if}

                    <label class="field">
                      <span>Compression quality</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={profileDraftOptions.antigravityCompressionQuality ?? ''}
                        placeholder="Auto"
                        oninput={(event) =>
                          updateProfileDraftOptions({ antigravityCompressionQuality: optionalNumberValue(event) })}
                      />
                    </label>

                    <details class="advanced-section" bind:open={profileAdvancedOpen}>
                      <summary>Advanced</summary>
                      <label class="field">
                        <span>Developer image options JSON</span>
                        <textarea
                          rows="3"
                          spellcheck="false"
                          value={profileDraftOptions.antigravityAdvancedOptionsJson}
                          oninput={(event) =>
                            updateProfileDraftOptions({ antigravityAdvancedOptionsJson: textValue(event) })}
                        ></textarea>
                        <small>Optional confirmed Antigravity image request overrides. Leave as <code>{'{}'}</code> unless testing a provider option.</small>
                      </label>
                    </details>
                  {/if}
                </div>

                <div class="profile-editor-actions">
                  {#if profileEditorMode === 'existing'}
                    <button
                      type="button"
                      class="secondary"
                      onclick={() => setDefaultProfile(selectedProfileId)}
                      disabled={settings.value.ai.defaultProfileId === selectedProfileId}
                    >
                      {settings.value.ai.defaultProfileId === selectedProfileId ? 'Default Profile' : 'Use by Default'}
                    </button>
                    <button
                      type="button"
                      class="secondary"
                      onclick={() => setDefaultProfile(null)}
                      disabled={settings.value.ai.defaultProfileId !== selectedProfileId}
                    >
                      Clear Default
                    </button>
                    <button type="button" class="secondary" onclick={duplicateSelectedProfile}>Duplicate</button>
                    <button type="button" class="secondary" onclick={deleteSelectedProfile}>Delete</button>
                  {/if}
                  <button type="button" class="secondary" onclick={revertProfileDraft}>Revert</button>
                  <button type="button" class="secondary" onclick={resetProfileDraftToDefaults}>Reset to Current Defaults</button>
                  <span class="profile-action-spacer"></span>
                  {#if profileEditorMode === 'new'}
                    <button type="button" class="secondary" onclick={cancelProfileDraft}>Cancel</button>
                  {/if}
                  <button type="button" class="primary" onclick={saveProfileDraft} disabled={!profileDraftName.trim()}>
                    Save Profile
                  </button>
                </div>
              </div>
            </div>
          </Modal>
        {/if}

        {#if profileDeleteTarget}
          <Modal title="Delete Profile" onClose={() => (profileDeleteTargetId = null)} width={420}>
            <div class="confirm-profile-delete">
              <div class="confirm-icon" aria-hidden="true">
                <Icon svg={Delete} size={26} />
              </div>
              <div>
                <p class="confirm-text">Delete "{profileDeleteTarget.name}"?</p>
                <p class="confirm-note">This removes the saved AI profile. Current provider defaults are not changed.</p>
              </div>
            </div>
            <div class="dlg-actions">
              <button type="button" onclick={() => (profileDeleteTargetId = null)}>Cancel</button>
              <button type="button" class="dlg-danger" onclick={() => deleteProfile(profileDeleteTarget.id)}>
                Delete Profile
              </button>
            </div>
          </Modal>
        {/if}

      {:else if selectedSection === 'workspace-canvas'}
        <div class="grid-2">
          <label class="field">
            <span>Default width</span>
            <input
              type="number"
              min="1"
              max="8192"
              value={settings.value.workspace.defaultCanvasWidth}
              onchange={(event) => settings.update({ workspace: { defaultCanvasWidth: numberValue(event) } })}
            />
          </label>

          <label class="field">
            <span>Default height</span>
            <input
              type="number"
              min="1"
              max="8192"
              value={settings.value.workspace.defaultCanvasHeight}
              onchange={(event) => settings.update({ workspace: { defaultCanvasHeight: numberValue(event) } })}
            />
          </label>
        </div>

        <label class="field">
          <span>Default background</span>
          <select
            value={settings.value.workspace.defaultBackground}
            onchange={(event) =>
              settings.update({ workspace: { defaultBackground: textValue(event) as CanvasBackground } })}
          >
            <option value="transparent">Transparent</option>
            <option value="white">White</option>
          </select>
        </label>

      {:else if selectedSection === 'workspace-view'}
        <label class="check-row">
          <input
            type="checkbox"
            checked={settings.value.workspace.showTransparencyChecker}
            onchange={(event) => settings.update({ workspace: { showTransparencyChecker: checkedValue(event) } })}
          />
          <span>
            <strong>Show transparency checkerboard</strong>
            <small>Display the checker pattern behind transparent document pixels.</small>
          </span>
        </label>

      {:else if selectedSection === 'ai-artifacts'}
        <label class="check-row">
          <input
            type="checkbox"
            checked={settings.value.workspace.keepAiRunInputs}
            onchange={(event) => settings.update({ workspace: { keepAiRunInputs: checkedValue(event) } })}
          />
          <span>
            <strong>Keep AI run input files</strong>
            <small>Save source, mask, and prompt files for fill and retouch troubleshooting.</small>
          </span>
        </label>

        <label class="check-row">
          <input
            type="checkbox"
            checked={settings.value.workspace.keepAiUpscaleComposedResult}
            onchange={(event) =>
              settings.update({ workspace: { keepAiUpscaleComposedResult: checkedValue(event) } })}
          />
          <span>
            <strong>Keep composed AI upscale result</strong>
            <small>Also save the merged upscale PNG in the run folder and project assets.</small>
          </span>
        </label>

        <label class="check-row">
          <input
            type="checkbox"
            checked={settings.value.workspace.keepAiDebugArtifacts}
            onchange={(event) =>
              settings.update({ workspace: { keepAiDebugArtifacts: checkedValue(event) } })}
          />
          <span>
            <strong>Keep AI debug artifacts</strong>
            <small>Preserve raw auth logs and image request/response JSON for troubleshooting.</small>
          </span>
        </label>
      {/if}
      </div>

      <div class="actions">
        <button type="button" onclick={() => settings.reset()}>Reset Defaults</button>
        <button type="button" class="primary" onclick={onClose}>Done</button>
      </div>
    </section>
  </div>
</Modal>

<style>
  .settings-shell {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }
  .settings-tree {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
    overflow: auto;
    padding: 12px 8px;
    border-right: 1px solid var(--border);
    background: var(--bg-panel-2);
  }
  .tree-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tree-group-button,
  .tree-section-button {
    justify-content: flex-start;
    width: 100%;
    min-width: 0;
    height: 26px;
    border-color: transparent;
    background: transparent;
    color: var(--text);
    text-align: left;
  }
  .tree-group-button {
    gap: 4px;
    padding: 5px 6px;
    font-weight: 600;
  }
  .tree-section-button {
    padding: 5px 8px 5px 28px;
  }
  .tree-group.selected .tree-group-button {
    color: var(--text-bright);
  }
  .tree-section-button.active {
    background: var(--selection);
    border-color: rgba(255, 255, 255, 0.08);
    color: var(--text-bright);
  }
  .tree-children {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .breadcrumb {
    margin-bottom: 4px;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .settings-tree button:hover {
    background: var(--bg-elevated);
    border-color: var(--border-soft);
  }
  .settings-tree button.active:hover {
    background: var(--selection);
  }
  .settings-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    container-type: inline-size;
    overflow: hidden;
  }
  .settings-scroll {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 12px;
    min-height: 0;
    overflow: auto;
    padding: 14px;
  }
  .section-head h2,
  .subsection-title h3 {
    margin: 0 0 4px;
    color: var(--text-bright);
    font-size: 12px;
  }
  .section-head p,
  .field small,
  .check-row small {
    margin: 0;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .section-head,
  .field,
  .check-row,
  .settings-row,
  .choice-row,
  .subsection-title,
  .section-note,
  .status-line {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--text-dim);
  }
  .field input,
  .field select,
  .field textarea {
    width: 100%;
  }
  .field textarea {
    resize: none;
    min-height: 70px;
    color: var(--text);
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 3px;
    padding: 5px;
    font: inherit;
  }
  .check-row {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    padding: 8px 10px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-input);
  }
  .check-row strong {
    display: block;
    margin-bottom: 2px;
    color: var(--text);
    font-weight: 600;
  }
  .settings-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(min(100%, 220px), 360px);
    gap: 16px;
    align-items: center;
    min-height: 42px;
  }
  .settings-row > div {
    min-width: 0;
  }
  .settings-row strong {
    display: block;
    margin-bottom: 2px;
    color: var(--text);
    font-weight: 600;
  }
  .settings-row small,
  .section-note {
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .settings-row button {
    width: 100%;
  }
  .choice-group {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .choice-row {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    min-height: 0;
    height: auto;
    padding: 8px 10px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-dim);
    line-height: 1.35;
  }
  .choice-row > span {
    display: block;
    min-width: 0;
  }
  .choice-row:has(input:checked) {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-input));
  }
  .choice-row strong {
    display: block;
    margin-bottom: 2px;
    color: var(--text);
    font-weight: 600;
  }
  .choice-row small {
    display: block;
  }
  .choice-row code {
    color: var(--text);
  }
  .grid-2,
  .detect-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr));
    gap: 12px;
    align-items: end;
  }
  .detect-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .subsection-title {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
  .subsection-title h3 {
    margin: 0;
  }
  .subsection-title span {
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .section-note {
    margin: 0;
  }
  .advanced-section {
    min-width: 0;
    color: var(--text-dim);
  }
  .advanced-section summary {
    cursor: default;
    color: var(--text);
    font-weight: 600;
  }
  .advanced-section .field {
    margin-top: 8px;
  }
  .profiles-page,
  .profile-editor-dialog,
  .profile-editor-panel,
  .profile-section {
    min-width: 0;
  }
  .profiles-page {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .profile-list-head {
    display: flex;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
  }
  .profile-list-head h3 {
    margin: 0 0 2px;
    color: var(--text-bright);
    font-size: 12px;
  }
  .profile-list-head span,
  .profile-empty-copy,
  .profile-summary-box small,
  .profile-list-item small {
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .profile-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
  }
  .profile-list-item {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: center;
    width: 100%;
    height: auto;
    min-height: 50px;
    padding: 8px 9px;
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 4px;
  }
  .profile-list-main {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .profile-row-actions {
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    min-width: 26px;
    height: 26px;
    padding: 0;
    color: var(--text-dim);
    background: transparent;
    border-color: var(--border-soft);
  }
  .icon-button:hover {
    color: var(--text-bright);
    background: var(--bg-elevated);
  }
  .profile-list-title {
    display: flex;
    gap: 6px;
    align-items: center;
    min-width: 0;
  }
  .profile-list-title strong {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .profile-list-title em {
    flex: 0 0 auto;
    padding: 1px 5px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    color: var(--text-dim);
    font-size: 10px;
    font-style: normal;
  }
  .profile-empty-copy {
    margin: 0;
    padding: 8px 0;
  }
  .profile-editor-dialog {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: auto;
  }
  .profile-editor-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .profile-editor-head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(180px, 280px);
    gap: 12px;
    align-items: end;
  }
  .profile-summary-box {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 7px 9px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-input);
  }
  .profile-summary-box span {
    overflow: hidden;
    color: var(--text);
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .profile-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .segmented {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    min-width: 0;
  }
  .segmented label {
    display: inline-flex;
    flex: 1 1 120px;
    min-width: 0;
  }
  .segmented input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .segmented span {
    display: flex;
    justify-content: center;
    width: 100%;
    min-width: 0;
    padding: 5px 9px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    color: var(--text);
    background: var(--bg-input);
    font-size: 11px;
    line-height: 1.35;
    text-align: center;
  }
  .segmented input:checked + span {
    color: var(--text-bright);
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-input));
  }
  .segmented input:focus-visible + span {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .profile-editor-actions {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
    padding-top: 2px;
  }
  .profile-editor-actions button {
    min-width: 0;
  }
  .profile-action-spacer {
    flex: 1 1 auto;
  }
  .confirm-profile-delete {
    display: grid;
    grid-template-columns: 36px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
  }
  .confirm-icon {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    color: #ffb2a6;
  }
  .confirm-text {
    margin: 0;
    color: var(--text-bright);
    font-size: 13px;
    line-height: 1.45;
  }
  .confirm-note {
    margin: 6px 0 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.45;
  }
  .dlg-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 18px;
  }
  .dlg-actions button {
    min-width: 96px;
  }
  .dlg-danger {
    color: #fff;
    border-color: #9b3b32;
    background: #9b3b32;
  }
  .dlg-danger:hover {
    border-color: #b4483e;
    background: #b4483e;
  }
  .status-line {
    margin: 0;
    padding: 7px 9px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    font-size: 11px;
    line-height: 1.35;
  }
  .status-line.ok {
    color: #9fdf9f;
    background: rgba(58, 142, 58, 0.12);
  }
  .status-line.error {
    color: #ffb2a6;
    background: rgba(224, 83, 61, 0.1);
  }
  .actions {
    display: flex;
    flex: 0 0 auto;
    justify-content: flex-end;
    gap: 8px;
    padding: 10px 14px 14px;
    border-top: 1px solid var(--border);
    background: var(--bg-panel);
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .secondary {
    align-self: flex-start;
  }
  @container (max-width: 680px) {
    .choice-group,
    .settings-row,
    .detect-row,
    .profile-editor-head {
      grid-template-columns: minmax(0, 1fr);
      align-items: stretch;
    }
    .settings-row button,
    .detect-row button,
    .profile-list-head button,
    .profile-list-item,
    .profile-editor-actions button {
      width: 100%;
      min-width: 0;
    }
    .profile-list-head,
    .profile-editor-actions {
      align-items: stretch;
    }
    .profile-list-head {
      flex-direction: column;
    }
    .profile-list-item {
      grid-template-columns: minmax(0, 1fr);
      align-items: stretch;
    }
    .profile-row-actions {
      justify-content: flex-start;
    }
    .profile-row-actions .icon-button {
      width: 30px;
      min-width: 30px;
    }
    .profile-action-spacer {
      display: none;
    }
    .secondary {
      align-self: stretch;
    }
  }
</style>
