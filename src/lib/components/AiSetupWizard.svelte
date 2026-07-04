<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { detectAntigravity, detectCodex, isDesktop, type CodexDetectionResult } from '../integrations/desktop';
  import { markAiSetupSeen } from '../state/aiSetup';
  import {
    ANTIGRAVITY_MODEL_OPTIONS,
    CODEX_MODEL_OPTIONS,
    type AntigravityModelId,
    type CodexModelId,
  } from '../state/settings';
  import { settings } from '../state/settings.svelte';
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { CheckmarkCircle, ChevronLeft, Code, ErrorCircle, Rocket, Sparkle } from '../icons';

  let { onClose }: { onClose: () => void } = $props();

  type WizardProvider = 'codex' | 'antigravity';
  type Step = 1 | 2 | 3;

  const desktop = isDesktop();
  const steps = [
    { number: 1, label: 'Pick your AI' },
    { number: 2, label: 'Connect' },
    { number: 3, label: 'Create!' },
  ] as const;
  const providerCards: { id: WizardProvider; icon: string; title: string; command: string; description: string }[] = [
    {
      id: 'codex',
      icon: Code,
      title: 'OpenAI Codex CLI',
      command: 'codex',
      description: 'Uses your local Codex sign-in to generate images with GPT models.',
    },
    {
      id: 'antigravity',
      icon: Rocket,
      title: 'Google Antigravity CLI',
      command: 'agy',
      description: 'Uses your local Antigravity sign-in to generate images with Gemini models.',
    },
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
  let provider = $state<WizardProvider>(settings.value.ai.provider === 'antigravity' ? 'antigravity' : 'codex');
  let manualBin = $state('');
  let detectBusy = $state(false);
  let detection = $state<CodexDetectionResult | null>(null);
  let firstPrompt = $state(starterPrompts[0].prompt);

  const providerName = $derived(provider === 'antigravity' ? 'Antigravity' : 'Codex');
  const providerCommand = $derived(provider === 'antigravity' ? 'agy' : 'codex');

  function textValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value;
  }

  function dismiss(): void {
    // Reaching the last step means a CLI was connected — count that as done.
    markAiSetupSeen(step === 3 ? 'completed' : 'dismissed');
    onClose();
  }

  function beginDetection(): void {
    manualBin = provider === 'antigravity' ? settings.value.ai.antigravityBin : settings.value.ai.codexBin;
    step = 2;
    void runDetection();
  }

  async function runDetection(): Promise<void> {
    detection = null;
    if (!desktop) return;
    detectBusy = true;
    try {
      const result = provider === 'antigravity' ? await detectAntigravity(manualBin) : await detectCodex(manualBin);
      detection = result;
      if (result.found && result.path) {
        manualBin = result.path;
        settings.update({
          ai: provider === 'antigravity' ? { provider, antigravityBin: result.path } : { provider, codexBin: result.path },
        });
      }
    } catch (error) {
      detection = {
        found: false,
        path: null,
        version: null,
        error: (error as Error)?.message ?? String(error),
      };
    } finally {
      detectBusy = false;
    }
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

<Modal title="AI Setup Assistant" onClose={dismiss} width={540}>
  <div class="wizard">
    <ol class="steps" aria-label="Setup progress">
      {#each steps as item (item.number)}
        <li class:active={step === item.number} class:done={step > item.number} aria-current={step === item.number ? 'step' : undefined}>
          <span class="step-dot">
            {#if step > item.number}
              <Icon svg={CheckmarkCircle} size={16} />
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
            PaintNode teams up with an AI CLI that runs right on your computer — your own sign-in, your own machine.
            Pick the one you use and we'll have you painting with AI in under a minute.
          </p>
        </div>
      </div>

      <div class="provider-cards" role="radiogroup" aria-label="AI provider">
        {#each providerCards as card (card.id)}
          <button
            type="button"
            class="provider-card"
            class:selected={provider === card.id}
            role="radio"
            aria-checked={provider === card.id}
            onclick={() => (provider = card.id)}
          >
            <span class="card-icon"><Icon svg={card.icon} size={22} /></span>
            <span class="card-body">
              <strong>{card.title}</strong>
              <small>{card.description}</small>
              <code>{card.command}</code>
            </span>
          </button>
        {/each}
      </div>

      <div class="actions">
        <button type="button" class="quiet" onclick={dismiss}>Maybe later</button>
        <span class="spacer"></span>
        <button type="button" class="primary" onclick={beginDetection}>Let's go</button>
      </div>
    {:else if step === 2}
      <div class="hero">
        <span class="hero-icon"><Icon svg={Sparkle} size={26} /></span>
        <div>
          <h2>Let's find {providerName} on your computer</h2>
          <p>PaintNode checks the usual install spots and saves the result to your settings automatically.</p>
        </div>
      </div>

      {#if !desktop}
        <p class="notice">
          The setup assistant can only detect CLIs in the desktop app. Launch PaintNode desktop
          (<code>npm run tauri:dev</code>) to finish this step.
        </p>
      {:else if detectBusy}
        <div class="progress-line" role="status" aria-live="polite">
          <span class="progress-dot" aria-hidden="true"></span>
          <span>Searching the usual places for <code>{providerCommand}</code>…</span>
        </div>
      {:else if detection?.found}
        <div class="result ok">
          <span class="result-icon"><Icon svg={CheckmarkCircle} size={20} /></span>
          <div>
            <strong>Found {detection.version || providerName}!</strong>
            <small>Saved <code>{detection.path}</code> to your settings — one step to go.</small>
          </div>
        </div>

        {#if provider === 'codex'}
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
            <small>You can change this anytime in Settings → AI.</small>
          </label>
        {:else}
          <label class="field">
            <span>Model</span>
            <select
              value={settings.value.ai.antigravityModel}
              onchange={(event) => settings.update({ ai: { antigravityModel: textValue(event) as AntigravityModelId } })}
            >
              {#each ANTIGRAVITY_MODEL_OPTIONS as option (option.id)}
                <option value={option.id}>{option.label}</option>
              {/each}
            </select>
            <small>Auto lets Antigravity choose. You can change this anytime in Settings → AI.</small>
          </label>
        {/if}
      {:else if detection}
        <div class="result miss">
          <span class="result-icon"><Icon svg={ErrorCircle} size={20} /></span>
          <div>
            <strong>Not found yet — no worries!</strong>
            {#if provider === 'codex'}
              <small>
                Install the Codex CLI, then run <code>codex login</code> once in Terminal to sign in.
                If it lives somewhere unusual, enter the full path below and try again.
              </small>
            {:else}
              <small>
                Install Antigravity with Google's install script, then run <code>agy</code> once in Terminal to sign in.
                If it lives somewhere unusual, enter the full path below and try again.
              </small>
            {/if}
          </div>
        </div>

        {#if detection.error}
          <p class="detail">{detection.error}</p>
        {/if}

        <div class="detect-row">
          <label class="field">
            <span>{providerName} command</span>
            <input
              type="text"
              bind:value={manualBin}
              placeholder={provider === 'codex'
                ? 'codex, /opt/homebrew/bin/codex, or /usr/local/bin/codex'
                : 'agy, ~/.local/bin/agy, /opt/homebrew/bin/agy, or /usr/local/bin/agy'}
              spellcheck="false"
            />
          </label>
          <button type="button" onclick={() => void runDetection()}>Try again</button>
        </div>
      {/if}

      <div class="actions">
        <button type="button" class="quiet back" onclick={() => (step = 1)}>
          <Icon svg={ChevronLeft} size={14} />
          <span>Back</span>
        </button>
        <span class="spacer"></span>
        <button type="button" class="primary" disabled={!detection?.found} onclick={() => (step = 3)}>Continue</button>
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
        <button type="button" class="quiet back" onclick={() => (step = 2)}>
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
  .steps {
    display: flex;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .steps li {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 8px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 600;
  }
  .steps li.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 14%, var(--bg-input));
    color: var(--text-bright);
  }
  .steps li.done {
    color: #9fdf9f;
  }
  .step-dot {
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border: 1px solid currentColor;
    border-radius: 999px;
    font-size: 10px;
    line-height: 1;
  }
  .steps li.done .step-dot {
    border: none;
    width: auto;
    height: auto;
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
  .card-body code {
    align-self: flex-start;
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
    resize: vertical;
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
  .detect-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 10px;
    align-items: end;
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
