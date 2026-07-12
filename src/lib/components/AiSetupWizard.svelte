<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import ManagedRuntimeCard from './ManagedRuntimeCard.svelte';
  import { detectAntigravity, detectCodex, detectGrok, isDesktop, type CodexDetectionResult } from '../integrations/desktop';
  import { markAiSetupSeen } from '../state/aiSetup';
  import {
    ANTIGRAVITY_IMAGE_MODEL_OPTIONS,
    ANTIGRAVITY_IMAGE_SIZE_OPTIONS,
    GROK_IMAGE_MODEL_OPTIONS,
    GROK_IMAGE_RESOLUTION_OPTIONS,
    type AiAutonomyLevel,
    type AntigravityImageModelId,
    type AntigravityImageSize,
    type CodexModelId,
    type GrokImageModelId,
    type GrokImageResolution,
    type ReasoningEffort,
  } from '../state/settings';
  import { settings } from '../state/settings.svelte';
  import {
    FALLBACK_CODEX_CAPABILITIES,
    codexEffortForModel,
    codexModelOptions,
    codexReasoningOptions,
    loadCodexCapabilities,
  } from '../ai/providerCapabilities';
  import { editor } from '../state/editor.svelte';
  import type { ManagedRuntimeStatus } from '../ai/managedRuntime';
  import { project } from '../state/project.svelte';
  import { ui } from '../state/ui.svelte';
  import { Checkmark, CheckmarkCircle, ChevronLeft, Code, ErrorCircle, FolderAdd, Rocket, Sparkle } from '../icons';

  let { onClose }: { onClose: () => void } = $props();

  type WizardProvider = 'codex' | 'antigravity' | 'grok';
  type Step = 1 | 2 | 3 | 4;
  type DetectState = { status: 'checking' | 'found' | 'missing'; result: CodexDetectionResult | null };

  const desktop = isDesktop();
  const steps = [
    { number: 1, label: 'Pick your AI' },
    { number: 2, label: 'Configure' },
    { number: 3, label: 'Project' },
    { number: 4, label: 'Create!' },
  ] as const;
  const providerCards: { id: WizardProvider; icon: string; title: string; command: string; description: string }[] = [
    {
      id: 'codex',
      icon: Code,
      title: 'OpenAI Codex',
      command: 'codex',
      description: 'Uses your local Codex sign-in to generate images with GPT models.',
    },
    {
      id: 'antigravity',
      icon: Rocket,
      title: 'Antigravity',
      command: 'agy',
      description: 'Uses your Antigravity sign-in for PaintNode-owned image generation.',
    },
    {
      id: 'grok',
      icon: Sparkle,
      title: 'Grok',
      command: 'grok',
      description: 'Uses your local Grok sign-in for Grok Imagine generation and AI Director work.',
    },
  ];
  const autonomyLevels: { value: AiAutonomyLevel; label: string }[] = [
    { value: 'low', label: 'Low autonomy' },
    { value: 'guided', label: 'Guided tools' },
    { value: 'open', label: 'Open-ended' },
    { value: 'unmanaged', label: 'Unmanaged' },
  ];
  const starterPrompts = [
    {
      label: 'Seaside studio',
      prompt: "A cozy artist's studio on a cliff above the sea, golden-hour light, gouache style",
    },
    {
      label: 'Red panda astronaut',
      prompt: "A tiny red panda astronaut floating among pastel planets, children's book illustration",
    },
    {
      label: 'Neon city rain',
      prompt: 'A neon-lit rainy street in a futuristic city, reflections on wet asphalt, cinematic wide shot',
    },
  ];

  let step = $state<Step>(1);
  let provider = $state<WizardProvider>(settings.value.ai.imageProvider);
  let userPicked = false;
  let codexDetect = $state<DetectState>({ status: desktop ? 'checking' : 'missing', result: null });
  let agyDetect = $state<DetectState>({ status: desktop ? 'checking' : 'missing', result: null });
  let grokDetect = $state<DetectState>({ status: desktop ? 'checking' : 'missing', result: null });
  let manualBin = $state('');
  let firstPrompt = $state(starterPrompts[0].prompt);
  let codexCapabilities = $state(FALLBACK_CODEX_CAPABILITIES);

  const providerName = $derived(provider === 'codex' ? 'Codex' : provider === 'antigravity' ? 'Antigravity' : 'Grok');
  const providerCommand = $derived(provider === 'codex' ? 'codex' : provider === 'antigravity' ? 'agy' : 'grok');
  const selectedDetect = $derived(provider === 'codex' ? codexDetect : provider === 'antigravity' ? agyDetect : grokDetect);
  const availableCodexModels = $derived(codexModelOptions(codexCapabilities, settings.value.ai.model));
  const availableReasoningEfforts = $derived(
    codexReasoningOptions(codexCapabilities, settings.value.ai.model, settings.value.ai.reasoningEffort),
  );

  if (desktop) {
    void loadCodexCapabilities(
      settings.value.ai.codexExecutableMode === 'custom' ? settings.value.ai.codexBin : '',
    ).then((capabilities) => {
      codexCapabilities = capabilities;
    });
    void runDetection('codex', settings.value.ai.codexExecutableMode === 'custom' ? settings.value.ai.codexBin : '');
    void runDetection(
      'antigravity',
      settings.value.ai.antigravityExecutableMode === 'custom' ? settings.value.ai.antigravityBin : '',
    );
    void runDetection(
      'grok',
      settings.value.ai.grokExecutableMode === 'custom' ? settings.value.ai.grokBin : '',
    );
  }

  function textValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
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

  function dismiss(): void {
    // Reaching the project step means a CLI was connected — count that as done.
    markAiSetupSeen(step >= 3 ? 'completed' : 'dismissed');
    onClose();
  }

  async function runDetection(target: WizardProvider, bin: string, saveCustomPath = false): Promise<void> {
    const setState = (value: DetectState) => {
      if (target === 'antigravity') agyDetect = value;
      else if (target === 'grok') grokDetect = value;
      else codexDetect = value;
    };
    if (!desktop) {
      setState({ status: 'missing', result: null });
      return;
    }
    setState({ status: 'checking', result: null });
    try {
      const result = target === 'antigravity'
        ? await detectAntigravity(bin)
        : target === 'grok'
          ? await detectGrok(bin)
          : await detectCodex(bin);
      if (saveCustomPath && result.found && result.path) {
        settings.update({
          ai: target === 'antigravity'
            ? { antigravityExecutableMode: 'custom', antigravityBin: result.path }
            : target === 'grok'
              ? { grokExecutableMode: 'custom', grokBin: result.path }
              : { codexExecutableMode: 'custom', codexBin: result.path },
        });
      }
      setState({ status: result.found ? 'found' : 'missing', result });
    } catch (error) {
      setState({
        status: 'missing',
        result: { found: false, path: null, version: null, error: (error as Error)?.message ?? String(error) },
      });
    }
    maybeAutoSelect();
  }

  // Until the user picks a card themselves, steer the selection toward the
  // provider that is actually installed.
  function maybeAutoSelect(): void {
    if (userPicked) return;
    if (selectedDetect.status !== 'missing') return;
    const detected = providerCards.find((card) => {
      const state = card.id === 'codex' ? codexDetect : card.id === 'antigravity' ? agyDetect : grokDetect;
      return state.status === 'found';
    });
    if (detected) provider = detected.id;
  }

  function pickProvider(id: WizardProvider): void {
    userPicked = true;
    provider = id;
  }

  function managedRuntimeChanged(status: ManagedRuntimeStatus | null): void {
    if (status?.state === 'ready' && status.authenticated !== false) {
      void runDetection('codex', '');
    }
  }

  function confirmProvider(): void {
    settings.update({
      ai: {
        provider,
        imageProvider: provider,
        directorProvider: provider === 'antigravity' ? settings.value.ai.directorProvider : provider,
        directorMode: provider === 'antigravity'
          ? 'skip'
          : settings.value.ai.directorMode === 'skip' ? 'auto' : settings.value.ai.directorMode,
      },
    });
    manualBin = provider === 'codex'
      ? settings.value.ai.codexBin
      : provider === 'antigravity'
        ? settings.value.ai.antigravityBin
        : settings.value.ai.grokBin;
    step = 2;
  }

  function chooseProjectFolder(): void {
    void project.openFolder();
  }

  function createFirstImage(): void {
    markAiSetupSeen('completed');
    if (!editor.doc) {
      const workspace = settings.value.workspace;
      editor.newDocument(
        workspace.defaultCanvasWidth,
        workspace.defaultCanvasHeight,
        'My First Image',
        workspace.defaultBackground === 'white',
      );
    }
    // Opening the Generate dialog replaces this one; the prompt rides along.
    ui.openAiGenerate(firstPrompt.trim() || starterPrompts[0].prompt);
  }
</script>

<Modal title="AI Setup Assistant" onClose={dismiss} width={560} minWidth={520} minHeight={420} resizable>
  <div class="wizard">
    <ol class="steps" aria-label="Setup progress">
      {#each steps as item (item.number)}
        <li class:active={step === item.number} class:done={step > item.number} aria-current={step === item.number ? 'step' : undefined}>
          <span class="step-dot" aria-hidden="true">
            {#if step > item.number}
              <Icon svg={Checkmark} size={11} />
            {:else}
              {item.number}
            {/if}
          </span>
          <span class="step-label">{item.label}</span>
        </li>
      {/each}
    </ol>

    {#if step === 1}
      <div class="hero">
        <span class="hero-icon"><Icon svg={Sparkle} size={26} /></span>
        <div>
          <h2>Welcome to PaintNode!</h2>
          <p>
            Choose an AI provider. PaintNode can install and maintain Codex for you; Antigravity and Grok
            use your existing local installations and sign-ins.
          </p>
        </div>
      </div>

      <div class="provider-cards" role="radiogroup" aria-label="Default AI provider">
        {#each providerCards as card (card.id)}
          {@const detect = card.id === 'codex' ? codexDetect : card.id === 'antigravity' ? agyDetect : grokDetect}
          <button
            type="button"
            class="provider-card"
            class:selected={provider === card.id}
            role="radio"
            aria-checked={provider === card.id}
            onclick={() => pickProvider(card.id)}
          >
            <span class="card-icon"><Icon svg={card.icon} size={22} /></span>
            <span class="card-body">
              <strong>{card.title}</strong>
              <small>{card.description}</small>
              <code>{card.command}</code>
              {#if detect.status === 'checking'}
                <span class="card-status checking" role="status">
                  <span class="mini-dot" aria-hidden="true"></span>
                  <span>Checking…</span>
                </span>
              {:else if detect.status === 'found'}
                <span class="card-status ok">
                  <Icon svg={CheckmarkCircle} size={13} />
                  <span>Connected{detect.result?.version ? ` · ${detect.result.version}` : ''}</span>
                </span>
              {:else}
                <span class="card-status miss">
                  <Icon svg={ErrorCircle} size={13} />
                  <span>{desktop ? 'Not detected yet' : 'Desktop app only'}</span>
                </span>
              {/if}
            </span>
          </button>
        {/each}
      </div>

      <div class="actions">
        <button type="button" class="quiet" onclick={dismiss}>Maybe later</button>
        <span class="spacer"></span>
        <button type="button" class="primary" onclick={confirmProvider}>Let's go</button>
      </div>
    {:else if step === 2}
      <div class="hero">
        <span class="hero-icon"><Icon svg={Sparkle} size={26} /></span>
        <div>
          <h2>Set up {providerName}, your new default</h2>
          <p>
            Choose the model and how much freedom {providerName} gets. These defaults apply to every AI run —
            change them anytime in Settings → AI.
          </p>
        </div>
      </div>

      {#if !desktop}
        <p class="notice">
          The setup assistant can only detect CLIs in the desktop app. Launch PaintNode desktop
          (<code>npm run tauri:dev</code>) to finish this step.
        </p>
      {:else if selectedDetect.status === 'checking'}
        <div class="progress-line" role="status" aria-live="polite">
          <span class="progress-dot" aria-hidden="true"></span>
          <span>Searching the usual places for <code>{providerCommand}</code>…</span>
        </div>
      {:else if selectedDetect.status === 'found'}
        <div class="result ok">
          <span class="result-icon"><Icon svg={CheckmarkCircle} size={20} /></span>
          <div>
            <strong>{selectedDetect.result?.version || providerName} is available.</strong>
            <small>
              {selectedDetect.result?.path
                ? `PaintNode found ${selectedDetect.result.path}; custom paths stay optional.`
                : 'PaintNode will use the built-in connector for this provider.'}
            </small>
          </div>
        </div>

        {#if provider === 'codex'}
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
                onchange={(event) => settings.update({ ai: { reasoningEffort: textValue(event) as ReasoningEffort } })}
              >
                {#each availableReasoningEfforts as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
          </div>
        {:else if provider === 'antigravity'}
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
        {:else}
          <div class="grid-2">
            <label class="field">
              <span>Image model</span>
              <select
                value={settings.value.ai.grokImageModel}
                onchange={(event) => settings.update({ ai: { grokImageModel: textValue(event) as GrokImageModelId } })}
              >
                {#each GROK_IMAGE_MODEL_OPTIONS as option (option.id)}
                  <option value={option.id}>{option.label}</option>
                {/each}
              </select>
            </label>
            <label class="field">
              <span>Image resolution</span>
              <select
                value={settings.value.ai.grokImageResolution}
                onchange={(event) => settings.update({ ai: { grokImageResolution: textValue(event) as GrokImageResolution } })}
              >
                {#each GROK_IMAGE_RESOLUTION_OPTIONS as option (option.id)}
                  <option value={option.id}>{option.label}</option>
                {/each}
              </select>
            </label>
          </div>
        {/if}

        {#if provider === 'codex'}
          <label class="field">
            <span>Autonomy</span>
            <select
              value={settings.value.ai.autonomyLevel}
              onchange={(event) => settings.update({ ai: { autonomyLevel: textValue(event) as AiAutonomyLevel } })}
            >
              {#each autonomyLevels as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
            <small>How much room the local agent gets to build tools during a run. Low is the safest start.</small>
          </label>
        {/if}
      {:else}
        {#if provider === 'codex'}
          <ManagedRuntimeCard
            provider="codex"
            onStatusChange={managedRuntimeChanged}
          />

          {#if selectedDetect.result?.error}
            <p class="detail">{selectedDetect.result.error}</p>
          {/if}

          <details class="existing-runtime">
            <summary>Use an existing installation</summary>
            <div class="detect-row">
              <label class="field">
                <span>{providerName} executable</span>
                <input
                  type="text"
                  bind:value={manualBin}
                  placeholder="codex or full path"
                  spellcheck="false"
                />
              </label>
              <button type="button" onclick={() => void runDetection(provider, manualBin, true)}>Connect</button>
            </div>
          </details>
        {:else}
          <div class="result miss">
            <span class="result-icon"><Icon svg={ErrorCircle} size={20} /></span>
            <div>
              <strong>Not found yet — no worries!</strong>
              <small>
                Install {providerName}, then run <code>{providerCommand}</code> once in Terminal to sign in.
                If it lives somewhere unusual, enter the full path below and try again.
              </small>
            </div>
          </div>

          {#if selectedDetect.result?.error}
            <p class="detail">{selectedDetect.result.error}</p>
          {/if}

          <div class="detect-row">
            <label class="field">
              <span>{providerName} command</span>
              <input
                type="text"
                bind:value={manualBin}
                placeholder={provider === 'antigravity'
                  ? 'agy, ~/.local/bin/agy, /opt/homebrew/bin/agy, or /usr/local/bin/agy'
                  : 'grok, ~/.local/bin/grok, ~/.grok/bin/grok, or /opt/homebrew/bin/grok'}
                spellcheck="false"
              />
            </label>
            <button type="button" onclick={() => void runDetection(provider, manualBin, true)}>Try again</button>
          </div>
        {/if}
      {/if}

      <div class="actions">
        <button type="button" class="quiet back" onclick={() => (step = 1)}>
          <Icon svg={ChevronLeft} size={14} />
          <span>Back</span>
        </button>
        <span class="spacer"></span>
        <button type="button" class="primary" disabled={selectedDetect.status !== 'found'} onclick={() => (step = 3)}>
          Continue
        </button>
      </div>
    {:else if step === 3}
      <div class="hero">
        <span class="hero-icon"><Icon svg={FolderAdd} size={24} /></span>
        <div>
          <h2>Give your artwork a home</h2>
          <p>
            Choose (or create) a project folder. Generated images, autosave recovery copies, and AI run
            files all live there — tidy, local, and easy to find.
          </p>
        </div>
      </div>

      {#if !desktop}
        <p class="notice">Project folders are available in the desktop app.</p>
      {:else if project.path}
        <div class="result ok">
          <span class="result-icon"><Icon svg={CheckmarkCircle} size={20} /></span>
          <div>
            <strong>Project ready!</strong>
            <small><code>{project.path}</code></small>
          </div>
        </div>
        <button type="button" class="secondary" onclick={chooseProjectFolder} disabled={project.busy}>
          Choose a different folder…
        </button>
      {:else if project.busy}
        <div class="progress-line" role="status" aria-live="polite">
          <span class="progress-dot" aria-hidden="true"></span>
          <span>Opening project folder…</span>
        </div>
      {:else}
        <button type="button" class="choose-folder" onclick={chooseProjectFolder}>
          <Icon svg={FolderAdd} size={16} />
          <span>Choose or create a project folder…</span>
        </button>
        {#if project.error}
          <p class="detail">{project.error}</p>
        {/if}
      {/if}

      <div class="actions">
        <button type="button" class="quiet back" onclick={() => (step = 2)}>
          <Icon svg={ChevronLeft} size={14} />
          <span>Back</span>
        </button>
        <span class="spacer"></span>
        <button type="button" class="quiet" onclick={() => (step = 4)}>Skip for now</button>
        <button type="button" class="primary" disabled={desktop && !project.path} onclick={() => (step = 4)}>
          Continue
        </button>
      </div>
    {:else}
      <div class="hero">
        <span class="hero-icon celebrate"><Icon svg={CheckmarkCircle} size={26} /></span>
        <div>
          <h2>You're all set — time for some magic!</h2>
          <p>
            {providerName} is connected and ready. Describe anything you can dream up and it appears on your
            canvas as a new layer. Here's a starter idea — make it yours:
          </p>
        </div>
      </div>

      <label class="field">
        <span>Your first prompt</span>
        <textarea rows="3" bind:value={firstPrompt}></textarea>
      </label>

      <div class="chips" role="group" aria-label="Prompt ideas">
        {#each starterPrompts as idea (idea.label)}
          <button
            type="button"
            class="chip"
            class:selected={firstPrompt === idea.prompt}
            onclick={() => (firstPrompt = idea.prompt)}
          >
            {idea.label}
          </button>
        {/each}
      </div>

      <p class="detail">You can generate again anytime from the AI menu — AI → Generate Image.</p>

      <div class="actions">
        <button type="button" class="quiet back" onclick={() => (step = 3)}>
          <Icon svg={ChevronLeft} size={14} />
          <span>Back</span>
        </button>
        <span class="spacer"></span>
        <button type="button" class="quiet" onclick={dismiss}>I'll explore on my own</button>
        <button type="button" class="primary sparkle" onclick={createFirstImage}>
          <Icon svg={Sparkle} size={14} />
          <span>Create my first image</span>
        </button>
      </div>
    {/if}
  </div>
</Modal>

<style>
  .wizard {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  /* Progress stepper: dots joined by connector lines — deliberately not
     button-shaped, so it reads as feedback rather than navigation. */
  .steps {
    display: flex;
    align-items: center;
    margin: 0;
    padding: 2px 2px 6px;
    list-style: none;
  }
  .steps li {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text-dim);
    font-size: 11px;
  }
  .steps li:not(:first-child) {
    flex: 1;
  }
  .steps li:not(:first-child)::before {
    content: '';
    flex: 1;
    height: 1px;
    margin: 0 10px;
    background: var(--border-soft);
  }
  .steps li.active:not(:first-child)::before,
  .steps li.done:not(:first-child)::before {
    background: color-mix(in srgb, var(--accent) 65%, var(--border-soft));
  }
  .step-dot {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    background: var(--bg-input);
    color: var(--text-dim);
    font-size: 10px;
    line-height: 1;
  }
  .steps li.active .step-dot {
    border-color: var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 700;
  }
  .steps li.active .step-label {
    color: var(--text-bright);
    font-weight: 600;
  }
  .steps li.done .step-dot {
    border-color: color-mix(in srgb, var(--accent) 70%, var(--border-soft));
    background: color-mix(in srgb, var(--accent) 24%, var(--bg-input));
    color: var(--accent);
  }
  .hero {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr);
    gap: 10px;
    align-items: start;
  }
  .hero-icon {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--accent) 18%, var(--bg-input));
    color: var(--accent);
  }
  .hero-icon.celebrate {
    background: rgba(58, 142, 58, 0.16);
    color: #9fdf9f;
  }
  .hero h2 {
    margin: 0 0 4px;
    color: var(--text-bright);
    font-size: 12px;
  }
  .hero p {
    margin: 0;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.5;
  }
  .provider-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .provider-card {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    padding: 10px;
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text);
    text-align: left;
  }
  .provider-card:hover {
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border-soft));
  }
  .provider-card.selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-input));
  }
  .card-icon {
    color: var(--accent);
    padding-top: 1px;
  }
  .card-body {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .card-body strong {
    color: var(--text-bright);
    font-size: 12px;
  }
  .card-body small {
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.4;
  }
  .card-body code,
  .result code,
  .notice code {
    color: var(--text-bright);
    background: var(--bg-panel-2);
    padding: 0 3px;
    border-radius: 3px;
    font-size: 10px;
  }
  .result code {
    overflow-wrap: anywhere;
  }
  .card-body code {
    align-self: flex-start;
  }
  .card-status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 2px;
    font-size: 11px;
    font-weight: 600;
  }
  .card-status.checking {
    color: var(--text-dim);
  }
  .card-status.ok {
    color: #9fdf9f;
  }
  .card-status.miss {
    color: var(--text-dim);
  }
  .mini-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--accent);
    animation: setup-pulse 1s ease-in-out infinite;
  }
  .notice,
  .detail {
    margin: 0;
    padding: 8px 10px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.5;
  }
  .detail {
    max-height: 88px;
    overflow: auto;
    user-select: text;
    -webkit-user-select: text;
  }
  .progress-line {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    min-height: 24px;
    padding: 6px 9px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent) 12%, var(--bg-input));
    color: var(--text);
    font-size: 11px;
  }
  .progress-line code {
    color: var(--text-bright);
    background: var(--bg-panel-2);
    padding: 0 3px;
    border-radius: 3px;
    font-size: 10px;
  }
  .progress-dot {
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--accent);
    animation: setup-pulse 1s ease-in-out infinite;
  }
  @keyframes setup-pulse {
    0%,
    100% {
      opacity: 0.4;
      transform: scale(0.75);
    }
    50% {
      opacity: 1;
      transform: scale(1);
    }
  }
  .result {
    display: grid;
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    padding: 9px 10px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    font-size: 11px;
    line-height: 1.45;
  }
  .result strong {
    display: block;
    margin-bottom: 2px;
    font-size: 12px;
  }
  .result small {
    display: block;
    font-size: 11px;
  }
  .result.ok {
    border-color: color-mix(in srgb, #3a8e3a 45%, var(--border-soft));
    background: rgba(58, 142, 58, 0.12);
    color: #9fdf9f;
  }
  .result.ok small {
    color: color-mix(in srgb, #9fdf9f 72%, var(--text-dim) 28%);
  }
  .result.miss {
    border-color: color-mix(in srgb, var(--accent) 40%, var(--border-soft));
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-input));
    color: var(--text);
  }
  .result.miss small {
    color: var(--text-dim);
  }
  .result-icon {
    padding-top: 1px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--text-dim);
    font-size: 11px;
  }
  .field input,
  .field select {
    width: 100%;
  }
  .field textarea {
    resize: none;
    min-height: 56px;
    color: var(--text);
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-radius: 3px;
    padding: 5px;
    font: inherit;
  }
  .field small {
    color: var(--text-dim);
    font-size: 11px;
  }
  .grid-2 {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 10px;
  }
  .detect-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: end;
  }
  .choose-folder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 10px;
    border: 1px dashed color-mix(in srgb, var(--accent) 55%, var(--border-soft));
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text);
  }
  .choose-folder:hover {
    border-color: var(--accent);
    color: var(--text-bright);
  }
  .secondary {
    align-self: flex-start;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    padding: 4px 10px;
    border: 1px solid var(--border-soft);
    border-radius: 999px;
    background: var(--bg-input);
    color: var(--text-dim);
    font-size: 11px;
  }
  .chip:hover {
    color: var(--text-bright);
    border-color: color-mix(in srgb, var(--accent) 50%, var(--border-soft));
  }
  .chip.selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, var(--bg-input));
    color: var(--text-bright);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .spacer {
    flex: 1;
  }
  .quiet {
    background: transparent;
    border-color: transparent;
    color: var(--text-dim);
  }
  .quiet:hover {
    color: var(--text-bright);
  }
  .back,
  .sparkle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .primary:disabled {
    opacity: 0.55;
  }
</style>
