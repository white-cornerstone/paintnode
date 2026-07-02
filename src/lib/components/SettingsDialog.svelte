<script lang="ts">
  import Modal from './Modal.svelte';
  import { detectCodex, isDesktop, type CodexDetectionResult } from '../integrations/desktop';
  import {
    AUTOSAVE_INTERVAL_OPTIONS,
    CODEX_MODEL_OPTIONS,
    DEFAULT_CUSTOM_GENERATOR_ARGS,
    type AiProvider,
    type CanvasBackground,
    type CodexModelId,
    type ReasoningEffort,
    type ServiceTier,
  } from '../state/settings';
  import { settings } from '../state/settings.svelte';

  let { onClose }: { onClose: () => void } = $props();

  type Tab = 'general' | 'ai' | 'workspace';

  const desktop = isDesktop();
  const reasoningEfforts: { value: ReasoningEffort; label: string }[] = [
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'XHigh' },
  ];
  const serviceTiers: { value: ServiceTier; label: string; hint: string }[] = [
    { value: 'default', label: 'Default', hint: 'Use normal Codex speed.' },
    { value: 'fast', label: 'Fast', hint: 'Ask Codex to use fast mode for AI runs.' },
  ];

  let tab = $state<Tab>('general');
  let detectBusy = $state(false);
  let codexDetection = $state<CodexDetectionResult | null>(null);

  function textValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  function checkedValue(event: Event): boolean {
    return (event.currentTarget as HTMLInputElement).checked;
  }

  function numberValue(event: Event): number {
    return Number((event.currentTarget as HTMLInputElement | HTMLSelectElement).value);
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

  function resetCustomArgs(): void {
    settings.update({ ai: { customArgsText: DEFAULT_CUSTOM_GENERATOR_ARGS } });
  }
</script>

<Modal title="Settings" {onClose} width={760}>
  <div class="settings-shell">
    <nav class="settings-tabs" aria-label="Settings sections">
      <button class:active={tab === 'general'} onclick={() => (tab = 'general')}>General</button>
      <button class:active={tab === 'ai'} onclick={() => (tab = 'ai')}>AI</button>
      <button class:active={tab === 'workspace'} onclick={() => (tab = 'workspace')}>Workspace</button>
    </nav>

    <section class="settings-body">
      {#if tab === 'general'}
        <div class="section-head">
          <h2>General</h2>
          <p>Startup, recovery, and small editor behavior defaults.</p>
        </div>

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
      {:else if tab === 'ai'}
        <div class="section-head">
          <h2>AI</h2>
          <p>Defaults for local Codex image generation, retouching, extraction, and workflows.</p>
        </div>

        <div class="detect-row">
          <label class="field">
            <span>Codex command</span>
            <input
              type="text"
              value={settings.value.ai.codexBin}
              placeholder="codex, /opt/homebrew/bin/codex, or /usr/local/bin/codex"
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
            <span>Speed</span>
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

          <label class="field">
            <span>Default image provider</span>
            <select
              value={settings.value.ai.provider}
              onchange={(event) => settings.update({ ai: { provider: textValue(event) as AiProvider } })}
            >
              <option value="codex">Local Codex</option>
              <option value="custom">Custom CLI</option>
            </select>
          </label>
        </div>

        <div class="subsection">
          <h3>Custom CLI</h3>
          <label class="field">
            <span>Command</span>
            <input
              type="text"
              value={settings.value.ai.customBin}
              placeholder="Full path to your image-gen CLI"
              spellcheck="false"
              oninput={(event) => settings.update({ ai: { customBin: textValue(event) } })}
            />
          </label>
          <label class="field">
            <span>Arguments</span>
            <textarea
              rows="4"
              spellcheck="false"
              value={settings.value.ai.customArgsText}
              oninput={(event) => settings.update({ ai: { customArgsText: textValue(event) } })}
            ></textarea>
          </label>
          <button type="button" class="secondary" onclick={resetCustomArgs}>Reset arguments</button>
        </div>
      {:else}
        <div class="section-head">
          <h2>Workspace</h2>
          <p>Canvas defaults and project asset retention preferences.</p>
        </div>

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
      {/if}

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
    grid-template-columns: 148px minmax(0, 1fr);
    min-height: 500px;
    max-height: min(680px, calc(100vh - 96px));
  }
  .settings-tabs {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px;
    border-right: 1px solid var(--border);
    background: var(--bg-panel-2);
  }
  .settings-tabs button {
    justify-content: flex-start;
    text-align: left;
    background: transparent;
    border-color: transparent;
    padding: 7px 8px;
  }
  .settings-tabs button.active {
    background: var(--bg-elevated);
    border-color: var(--border-soft);
    color: var(--text-bright);
  }
  .settings-body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    overflow: auto;
    padding: 14px;
  }
  .section-head h2,
  .subsection h3 {
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
    resize: vertical;
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
  .detect-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 12px;
    align-items: end;
  }
  .detect-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .subsection {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-top: 4px;
    border-top: 1px solid var(--border);
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
    justify-content: flex-end;
    gap: 8px;
    margin-top: auto;
    padding-top: 10px;
    border-top: 1px solid var(--border);
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
