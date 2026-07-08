<script lang="ts">
  import Modal from './Modal.svelte';
  import AiRunOptionsControl from './AiRunOptionsControl.svelte';
  import Icon from './Icon.svelte';
  import { detectCodex, detectAntigravity, isDesktop, type CodexDetectionResult } from '../integrations/desktop';
  import { ChevronDown, ChevronRight } from '../icons';
  import {
    AUTOSAVE_INTERVAL_OPTIONS,
    CODEX_MODEL_OPTIONS,
    ANTIGRAVITY_IMAGE_MODEL_OPTIONS,
    ANTIGRAVITY_IMAGE_SIZE_OPTIONS,
    ANTIGRAVITY_PERSON_GENERATION_OPTIONS,
    ANTIGRAVITY_PROMINENT_PEOPLE_OPTIONS,
    ANTIGRAVITY_SAFETY_CATEGORY_OPTIONS,
    ANTIGRAVITY_SAFETY_FILTERING_OPTIONS,
    ANTIGRAVITY_SAFETY_THRESHOLD_OPTIONS,
    type AiPlannerMode,
    type AiProvider,
    type CanvasBackground,
    type CodexImageModeration,
    type CodexImageQuality,
    type CodexModelId,
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
  import { ui } from '../state/ui.svelte';

  let { onClose }: { onClose: () => void } = $props();

  type SettingsGroupId = 'general' | 'workspace' | 'ai';
  type SettingsSectionId =
    | 'general-startup'
    | 'workspace-canvas'
    | 'workspace-view'
    | 'ai-general'
    | 'ai-provider-codex'
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
          description: 'Codex provider defaults and advanced local CLI settings.',
        },
        {
          id: 'ai-provider-antigravity',
          label: 'Antigravity',
          description: 'Antigravity provider defaults, safety controls, and advanced image options.',
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
  const reasoningEfforts: { value: ReasoningEffort; label: string }[] = [
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra High' },
  ];
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
  let selectedSection = $state<SettingsSectionId>('general-startup');
  let expandedGroups = $state<Record<SettingsGroupId, boolean>>({
    general: true,
    workspace: true,
    ai: true,
  });
  let detectBusy = $state(false);
  let antigravityDetectBusy = $state(false);
  let codexDetection = $state<CodexDetectionResult | null>(null);
  let antigravityDetection = $state<CodexDetectionResult | null>(null);
  let profileSourceProvider = $state<AiProvider>(settings.value.ai.imageProvider);
  let profileName = $state('');
  let selectedProfileId = $state(settings.value.ai.defaultProfileId ?? settings.value.ai.profiles[0]?.id ?? '');
  let selectedProfileOptions = $state(cloneAiRunOptions(aiProviderDefaultsFromSettings(settings.value)));

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

  function newProfileId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `ai-profile-${Date.now()}`;
  }

  function profileLabel(provider: AiProvider): string {
    if (provider === 'codex') return 'Codex';
    return 'Antigravity';
  }

  function createProfileFromDefaults(): void {
    const id = newProfileId();
    const defaults = cloneAiRunOptions(aiProviderDefaultsFromSettings(settings.value));
    defaults.provider = profileSourceProvider;
    defaults.imageProvider = profileSourceProvider;
    const name = profileName.trim() || `${profileLabel(profileSourceProvider)} Profile`;
    const profiles = [
      ...settings.value.ai.profiles,
      {
        id,
        name,
        options: aiProfileOptionsFromRunOptions(defaults),
      },
    ];
    settings.update({
      ai: {
        profiles,
        defaultProfileId: settings.value.ai.defaultProfileId ?? id,
      },
    });
    selectedProfileId = id;
    selectedProfileOptions = cloneAiRunOptions(aiProfileRunOptionsFromSettings(settings.value, id));
    profileName = '';
  }

  function updateSelectedProfileName(name: string): void {
    if (!selectedProfileId) return;
    settings.update({
      ai: {
        profiles: settings.value.ai.profiles.map((profile) =>
          profile.id === selectedProfileId ? { ...profile, name: name.trim() || 'AI Profile' } : profile,
        ),
      },
    });
  }

  function updateSelectedProfileOptions(): void {
    if (!selectedProfileId) return;
    settings.update({
      ai: {
        profiles: settings.value.ai.profiles.map((profile) =>
          profile.id === selectedProfileId
            ? { ...profile, options: aiProfileOptionsFromRunOptions(selectedProfileOptions) }
            : profile,
        ),
      },
    });
  }

  function setDefaultProfile(id: string | null): void {
    settings.update({ ai: { defaultProfileId: id } });
  }

  function deleteSelectedProfile(): void {
    if (!selectedProfileId) return;
    const profiles = settings.value.ai.profiles.filter((profile) => profile.id !== selectedProfileId);
    const defaultProfileId =
      settings.value.ai.defaultProfileId === selectedProfileId ? (profiles[0]?.id ?? null) : settings.value.ai.defaultProfileId;
    settings.update({ ai: { profiles, defaultProfileId } });
    selectedProfileId = defaultProfileId ?? profiles[0]?.id ?? '';
    selectedProfileOptions = cloneAiRunOptions(aiProfileRunOptionsFromSettings(settings.value, selectedProfileId || null));
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
      const result = await detectCodex(settings.value.ai.codexBin);
      codexDetection = result;
      if (result.found && result.path) settings.update({ ai: { codexBin: result.path } });
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
      const result = await detectAntigravity(settings.value.ai.antigravityBin);
      antigravityDetection = result;
      if (result.found && result.path) settings.update({ ai: { antigravityBin: result.path } });
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
    if (settings.value.ai.profiles.some((profile) => profile.id === selectedProfileId)) return;
    selectedProfileId = settings.value.ai.defaultProfileId ?? settings.value.ai.profiles[0]?.id ?? '';
  });

  $effect(() => {
    selectedProfileOptions = cloneAiRunOptions(aiProfileRunOptionsFromSettings(settings.value, selectedProfileId || null));
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
        <button type="button" class="secondary" onclick={() => ui.open('aiSetup')}>
          Open setup assistant…
        </button>

        <div class="grid-3">
          <label class="field">
            <span>Planner mode</span>
            <select
              value={settings.value.ai.plannerMode}
              onchange={(event) => settings.update({ ai: { plannerMode: textValue(event) as AiPlannerMode } })}
            >
              <option value="auto">Auto by task</option>
              <option value="skip">Skip planner</option>
              <option value="force">Always plan</option>
            </select>
          </label>

          <label class="field">
            <span>Planner provider</span>
            <select
              value={settings.value.ai.plannerProvider}
              disabled={settings.value.ai.plannerMode === 'skip'}
              onchange={(event) => settings.update({ ai: { plannerProvider: textValue(event) as AiProvider } })}
            >
              <option value="codex">Codex</option>
              <option value="antigravity">Antigravity</option>
            </select>
          </label>

          <label class="field">
            <span>Image generator</span>
            <select
              value={settings.value.ai.imageProvider}
              onchange={(event) => {
                const provider = textValue(event) as AiProvider;
                settings.update({ ai: { provider, imageProvider: provider } });
                profileSourceProvider = provider;
              }}
            >
              <option value="codex">Codex image generator</option>
              <option value="antigravity">Antigravity image generator</option>
            </select>
          </label>
        </div>

      {:else if selectedSection === 'ai-provider-codex'}
        <div class="detect-row">
          <label class="field">
            <span>Advanced Codex binary override</span>
            <input
              type="text"
              value={settings.value.ai.codexBin}
              placeholder="Leave blank to use the bundled Codex SDK CLI"
              spellcheck="false"
              oninput={(event) => settings.update({ ai: { codexBin: textValue(event) } })}
            />
          </label>
          <button type="button" onclick={runCodexDetection} disabled={detectBusy}>
            {detectBusy ? 'Detecting...' : 'Detect'}
          </button>
        </div>

        {#if codexDetection}
          <p class:ok={codexDetection.found} class:error={!codexDetection.found} class="status-line">
            {#if codexDetection.found}
              Found {codexDetection.version || 'Codex'} at {codexDetection.path}
            {:else}
              {codexDetection.error || 'Codex was not found.'}
            {/if}
          </p>
        {/if}

        <div class="grid-2">
          <label class="field">
            <span>Model</span>
            <select
              value={settings.value.ai.model}
              onchange={(event) => settings.update({ ai: { model: textValue(event) as CodexModelId } })}
            >
              {#each CODEX_MODEL_OPTIONS as option (option.id)}
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
              {#each reasoningEfforts as option (option.value)}
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

      {:else if selectedSection === 'ai-provider-antigravity'}
        <div class="detect-row">
          <label class="field">
            <span>Advanced Antigravity CLI auth helper</span>
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
          <small class="detect-help">Used to refresh Antigravity authentication when needed.</small>
        </div>

        {#if antigravityDetection}
          <p class:ok={antigravityDetection.found} class:error={!antigravityDetection.found} class="status-line">
            {#if antigravityDetection.found}
              Found {antigravityDetection.version || 'Antigravity'} at {antigravityDetection.path}
            {:else}
              {antigravityDetection.error || 'Antigravity CLI was not found.'}
            {/if}
          </p>
        {/if}

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

        <label class="field">
          <span>Advanced image options JSON</span>
          <textarea
            rows="3"
            spellcheck="false"
            value={settings.value.ai.antigravityAdvancedOptionsJson}
            oninput={(event) => settings.update({ ai: { antigravityAdvancedOptionsJson: textValue(event) } })}
          ></textarea>
          <small>Only confirmed image options are accepted; auth and transport fields are ignored by the app.</small>
        </label>

      {:else if selectedSection === 'ai-profiles'}
        <div class="subsection-title">
          <h3>Saved Profiles</h3>
          <span>{settings.value.ai.profiles.length} saved</span>
        </div>
        <div class="profile-create">
          <label class="field">
            <span>New profile</span>
            <input
              type="text"
              value={profileName}
              placeholder={`${profileLabel(profileSourceProvider)} Profile`}
              oninput={(event) => (profileName = textValue(event))}
            />
          </label>

          <label class="field">
            <span>Source defaults</span>
            <select
              value={profileSourceProvider}
              onchange={(event) => (profileSourceProvider = textValue(event) as AiProvider)}
            >
              <option value="codex">Codex</option>
              <option value="antigravity">Antigravity</option>
            </select>
          </label>

          <button type="button" onclick={createProfileFromDefaults}>Save Current Defaults</button>
        </div>

        {#if settings.value.ai.profiles.length}
          <div class="profile-editor">
            <label class="field">
              <span>Saved profile</span>
              <select
                value={selectedProfileId}
                onchange={(event) => (selectedProfileId = textValue(event))}
              >
                {#each settings.value.ai.profiles as profile (profile.id)}
                  <option value={profile.id}>{profile.name}</option>
                {/each}
              </select>
            </label>

            <label class="field">
              <span>Profile name</span>
              <input
                type="text"
                value={settings.value.ai.profiles.find((profile) => profile.id === selectedProfileId)?.name ?? ''}
                onchange={(event) => updateSelectedProfileName(textValue(event))}
              />
            </label>

            <div class="profile-options">
              <AiRunOptionsControl bind:options={selectedProfileOptions} />
              <button type="button" class="secondary" onclick={updateSelectedProfileOptions}>
                Save Profile Settings
              </button>
            </div>

            <div class="profile-actions">
              <button type="button" onclick={() => setDefaultProfile(selectedProfileId)}>
                {settings.value.ai.defaultProfileId === selectedProfileId ? 'Default Profile' : 'Use by Default'}
              </button>
              <button
                type="button"
                onclick={() => setDefaultProfile(null)}
                disabled={!settings.value.ai.defaultProfileId}
              >
                Use Provider Defaults
              </button>
              <button type="button" onclick={deleteSelectedProfile}>Delete Profile</button>
            </div>
          </div>
        {:else}
          <p class="status-line">Save a profile from provider defaults, then pick it inside AI dialogs.</p>
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
    .grid-2,
    .grid-3,
    .detect-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
      align-items: end;
    }
    .grid-3 {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  .detect-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .detect-help {
    grid-column: 1 / -1;
    margin-top: -8px;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .subsection-title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
  }
  .subsection-title h3 {
    margin: 0;
  }
  .subsection-title span {
    color: var(--text-dim);
    font-size: 11px;
  }
  .profile-create,
  .profile-editor {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 160px auto;
    gap: 10px;
    align-items: end;
  }
  .profile-editor {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    align-items: start;
  }
  .profile-options,
  .profile-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .profile-options {
    grid-column: 1 / -1;
  }
  .profile-actions {
    grid-column: 1 / -1;
    justify-content: flex-start;
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
</style>
