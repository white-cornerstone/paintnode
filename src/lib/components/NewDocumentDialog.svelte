<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { editor } from '../state/editor.svelte';
  import { workflow } from '../state/workflow.svelte';
  import { project } from '../state/project.svelte';
  import { settings } from '../state/settings.svelte';
  import { clamp } from '../engine/types';
  import { isDesktop } from '../integrations/desktop';
  import { tooltip } from '../actions/tooltip';
  import { Board, FolderAdd, ImageAdd } from '../icons';

  let { onClose }: { onClose: () => void } = $props();

  type Tab = 'image' | 'workflow' | 'project';
  type Background = 'white' | 'transparent';
  type PresetFilter = 'all' | 'codex' | 'agy' | 'shared';
  interface ImagePreset {
    id: string;
    name: string;
    meta: string;
    width: number;
    height: number;
    bg: Background;
  }
  interface WorkflowPreset {
    id: string;
    name: string;
    meta: string;
    prompt: string;
  }

  const desktop = isDesktop();
  let tab = $state<Tab>('image');
  let presetFilter = $state<PresetFilter>('all');

  const agyRatios = new Set(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']);
  const presetFilters: { id: PresetFilter; label: string; tooltip: string }[] = [
    { id: 'all', label: 'All', tooltip: 'Show every document preset, including custom ratios and model-friendly sizes.' },
    {
      id: 'shared',
      label: 'Shared',
      tooltip: 'Show ratios and dimensions that best fit both Codex and Antigravity image models.',
    },
    {
      id: 'codex',
      label: 'Codex',
      tooltip: 'Show dimensions that best fit Codex image generation.',
    },
    {
      id: 'agy',
      label: 'Agy',
      tooltip: 'Show aspect ratios that best fit Antigravity image generation.',
    },
  ];

  function gcd(a: number, b: number): number {
    let x = Math.abs(Math.round(a));
    let y = Math.abs(Math.round(b));
    while (y) [x, y] = [y, x % y];
    return x || 1;
  }

  function ratioLabel(width: number, height: number): string {
    const divisor = gcd(width, height);
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
  }

  function isAgyFriendly(width: number, height: number): boolean {
    return agyRatios.has(ratioLabel(width, height));
  }

  function isCodexFriendly(width: number, height: number): boolean {
    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    return width % 16 === 0 && height % 16 === 0 && longSide / shortSide <= 3;
  }

  function presetMeta(width: number, height: number): string {
    return `${width} x ${height} px`;
  }

  function uniqueImagePresets(presets: ImagePreset[]): ImagePreset[] {
    const seen = new Set<string>();
    return presets.filter((preset) => {
      const key = `${preset.width}x${preset.height}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const imagePresets: ImagePreset[] = uniqueImagePresets([
    {
      id: 'default',
      name: 'Default Canvas',
      meta: presetMeta(settings.value.workspace.defaultCanvasWidth, settings.value.workspace.defaultCanvasHeight),
      width: settings.value.workspace.defaultCanvasWidth,
      height: settings.value.workspace.defaultCanvasHeight,
      bg: settings.value.workspace.defaultBackground,
    },
    { id: 'desktop', name: 'Desktop Canvas', meta: presetMeta(1280, 800), width: 1280, height: 800, bg: 'transparent' },
    { id: 'hd', name: 'HD Screen', meta: presetMeta(1920, 1080), width: 1920, height: 1080, bg: 'transparent' },
    { id: 'square', name: 'Square Image', meta: presetMeta(1024, 1024), width: 1024, height: 1024, bg: 'transparent' },
    { id: 'ai-2-3', name: 'AI Portrait', meta: presetMeta(1024, 1536), width: 1024, height: 1536, bg: 'transparent' },
    { id: 'ai-3-2', name: 'AI Landscape', meta: presetMeta(1536, 1024), width: 1536, height: 1024, bg: 'transparent' },
    { id: 'ai-3-4', name: 'AI Tall Frame', meta: presetMeta(960, 1280), width: 960, height: 1280, bg: 'transparent' },
    { id: 'ai-4-3', name: 'AI Classic', meta: presetMeta(1280, 960), width: 1280, height: 960, bg: 'transparent' },
    { id: 'ai-4-5', name: 'AI Social', meta: presetMeta(1024, 1280), width: 1024, height: 1280, bg: 'white' },
    { id: 'ai-5-4', name: 'AI Wide Card', meta: presetMeta(1280, 1024), width: 1280, height: 1024, bg: 'white' },
    { id: 'ai-9-16', name: 'AI Story', meta: presetMeta(1152, 2048), width: 1152, height: 2048, bg: 'transparent' },
    { id: 'ai-16-9', name: 'AI Wide Screen', meta: presetMeta(2048, 1152), width: 2048, height: 1152, bg: 'transparent' },
    { id: 'ai-21-9', name: 'AI Cinema', meta: presetMeta(2016, 864), width: 2016, height: 864, bg: 'transparent' },
    { id: 'social', name: 'Social Post', meta: presetMeta(1080, 1350), width: 1080, height: 1350, bg: 'white' },
    { id: 'icon', name: 'Icon Asset', meta: presetMeta(512, 512), width: 512, height: 512, bg: 'transparent' },
    { id: 'banner', name: 'Web Banner', meta: presetMeta(1600, 600), width: 1600, height: 600, bg: 'white' },
  ]);
  const workflowPresets: WorkflowPreset[] = [
    {
      id: 'blank',
      name: 'Blank Workflow',
      meta: 'Start with an empty storyboard board',
      prompt: '',
    },
    {
      id: 'composition',
      name: 'Asset Composition',
      meta: 'Arrange extracted assets into a new image brief',
      prompt: 'Use these visual references to compose a new image.',
    },
    {
      id: 'storyboard',
      name: 'Storyboard Draft',
      meta: 'Plan scene beats before generation',
      prompt: 'Create a coherent storyboard from the connected visual assets.',
    },
  ];

  let selectedImageId = $state(imagePresets[0].id);
  let selectedWorkflowId = $state(workflowPresets[0].id);
  let imageName = $state('Untitled');
  let width = $state(imagePresets[0].width);
  let height = $state(imagePresets[0].height);
  let bg = $state<Background>(imagePresets[0].bg);
  let workflowName = $state('Untitled Workflow');
  let projectBusy = $state(false);
  let projectError = $state('');

  const selectedImage = $derived(imagePresets.find((preset) => preset.id === selectedImageId) ?? imagePresets[0]);
  const filteredImagePresets = $derived(imagePresets.filter((preset) => presetMatchesFilter(preset, presetFilter)));
  const selectedWorkflow = $derived(
    workflowPresets.find((preset) => preset.id === selectedWorkflowId) ?? workflowPresets[0],
  );

  function presetBadges(preset: ImagePreset): string[] {
    const badges: string[] = [];
    if (isCodexFriendly(preset.width, preset.height)) badges.push('Codex');
    if (isAgyFriendly(preset.width, preset.height)) badges.push('Agy');
    return badges;
  }

  function presetMatchesFilter(preset: ImagePreset, filter: PresetFilter): boolean {
    const codex = isCodexFriendly(preset.width, preset.height);
    const agy = isAgyFriendly(preset.width, preset.height);
    if (filter === 'codex') return codex;
    if (filter === 'agy') return agy;
    if (filter === 'shared') return codex && agy;
    return true;
  }

  function setPresetFilter(filter: PresetFilter): void {
    presetFilter = filter;
    if (!presetMatchesFilter(selectedImage, filter)) {
      const next = imagePresets.find((preset) => presetMatchesFilter(preset, filter));
      if (next) pickImagePreset(next);
    }
  }

  function pickImagePreset(preset: ImagePreset): void {
    selectedImageId = preset.id;
    width = preset.width;
    height = preset.height;
    bg = preset.bg;
  }

  function chooseImagePreset(preset: ImagePreset): void {
    if (selectedImageId === preset.id) {
      createImage();
      return;
    }
    pickImagePreset(preset);
  }

  function pickWorkflowPreset(preset: WorkflowPreset): void {
    selectedWorkflowId = preset.id;
    workflowName = preset.name === 'Blank Workflow' ? 'Untitled Workflow' : preset.name;
  }

  function chooseWorkflowPreset(preset: WorkflowPreset): void {
    if (selectedWorkflowId === preset.id) {
      createWorkflow();
      return;
    }
    pickWorkflowPreset(preset);
  }

  function createImage(): void {
    editor.newDocument(
      clamp(Math.round(width), 1, 8192),
      clamp(Math.round(height), 1, 8192),
      imageName.trim() || 'Untitled',
      bg === 'white',
    );
    onClose();
  }

  function createWorkflow(): void {
    workflow.newBoard(workflowName.trim() || 'Untitled Workflow');
    if (selectedWorkflow.prompt) workflow.setPrompt(selectedWorkflow.prompt);
    onClose();
  }

  async function createProject(): Promise<void> {
    projectError = '';
    if (!desktop) {
      projectError = 'Project folders are available in the desktop app.';
      return;
    }
    projectBusy = true;
    try {
      await project.openFolder();
      if (!project.error) onClose();
      else projectError = project.error;
    } catch (e) {
      projectError = (e as Error)?.message ?? String(e);
    } finally {
      projectBusy = false;
    }
  }

  function createCurrent(): void {
    if (tab === 'image') {
      createImage();
    } else if (tab === 'workflow') {
      createWorkflow();
    } else {
      void createProject();
    }
  }

  function onDialogKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    if (event.target instanceof HTMLTextAreaElement) return;
    if (event.target instanceof HTMLButtonElement && !event.target.classList.contains('preset-tile')) return;
    event.preventDefault();
    createCurrent();
  }
</script>

<svelte:window onkeydown={onDialogKeydown} />

<Modal title="New" {onClose} width={980}>
  <div class="new-dialog">
    <div class="tabs" role="tablist" aria-label="New item type">
      <button class:active={tab === 'image'} onclick={() => (tab = 'image')} role="tab">
        <Icon svg={ImageAdd} size={17} /><span>Image</span>
      </button>
      <button class:active={tab === 'workflow'} onclick={() => (tab = 'workflow')} role="tab">
        <Icon svg={Board} size={17} /><span>Workflow</span>
      </button>
      <button class:active={tab === 'project'} onclick={() => (tab = 'project')} role="tab">
        <Icon svg={FolderAdd} size={17} /><span>Project</span>
      </button>
    </div>

    <div class="dialog-grid">
      <section class="preset-browser">
        {#if tab === 'image'}
          <div class="preset-header">
            <div class="section-title">Image Presets</div>
            <div class="preset-filters" role="group" aria-label="Preset compatibility">
              {#each presetFilters as filter (filter.id)}
                <button
                  class:active={presetFilter === filter.id}
                  onclick={() => setPresetFilter(filter.id)}
                  aria-label={filter.tooltip}
                  use:tooltip={{ text: filter.tooltip, placement: 'bottom' }}
                >
                  {filter.label}
                </button>
              {/each}
            </div>
          </div>
          <div class="preset-grid">
            {#each filteredImagePresets as preset (preset.id)}
              <button
                class="preset-tile"
                class:selected={selectedImageId === preset.id}
                onclick={() => chooseImagePreset(preset)}
              >
                <Icon svg={ImageAdd} size={44} />
                <span>{preset.name}</span>
                <small>{preset.meta}</small>
                <span class="preset-badges" aria-label={`Compatibility: ${presetBadges(preset).join(', ') || 'Manual'}`}>
                  {#each presetBadges(preset) as badge (badge)}
                    <b>{badge}</b>
                  {/each}
                </span>
              </button>
            {/each}
          </div>
        {:else if tab === 'workflow'}
          <div class="section-title">Workflow Templates</div>
          <div class="preset-grid workflow-grid">
            {#each workflowPresets as preset (preset.id)}
              <button
                class="preset-tile"
                class:selected={selectedWorkflowId === preset.id}
                onclick={() => chooseWorkflowPreset(preset)}
              >
                <Icon svg={Board} size={44} />
                <span>{preset.name}</span>
                <small>{preset.meta}</small>
              </button>
            {/each}
          </div>
        {:else}
          <div class="project-intro">
            <Icon svg={FolderAdd} size={54} />
            <div>
              <div class="section-title">New Project Folder</div>
              <p>
                Pick or create a folder for PaintNode documents, generated assets, imported assets,
                autosaves, and workflow files.
              </p>
            </div>
          </div>
        {/if}
      </section>

      <aside class="details">
        {#if tab === 'image'}
          <div class="details-title">Preset Details</div>
          <label class="field">
            <span>Name</span>
            <input type="text" bind:value={imageName} spellcheck="false" />
          </label>
          <div class="dimensions">
            <label class="field">
              <span>Width</span>
              <input type="number" min="1" max="8192" bind:value={width} />
            </label>
            <label class="field">
              <span>Height</span>
              <input type="number" min="1" max="8192" bind:value={height} />
            </label>
          </div>
          <label class="field">
            <span>Background</span>
            <select bind:value={bg}>
              <option value="white">White</option>
              <option value="transparent">Transparent</option>
            </select>
          </label>
          <div class="summary">
            <span>{selectedImage.name}</span>
            <small>{Math.round(width)} x {Math.round(height)} px</small>
          </div>
          <div class="actions">
            <button onclick={onClose}>Close</button>
            <button class="primary" onclick={createImage}>Create</button>
          </div>
        {:else if tab === 'workflow'}
          <div class="details-title">Workflow Details</div>
          <label class="field">
            <span>Name</span>
            <input type="text" bind:value={workflowName} spellcheck="false" />
          </label>
          <div class="summary">
            <span>{selectedWorkflow.name}</span>
            <small>{selectedWorkflow.meta}</small>
          </div>
          <div class="actions">
            <button onclick={onClose}>Close</button>
            <button class="primary" onclick={createWorkflow}>Create</button>
          </div>
        {:else}
          <div class="details-title">Project Details</div>
          <div class="summary">
            <span>{project.current?.name ?? 'No project selected'}</span>
            <small>{project.path ?? 'Choose a folder to initialize a PaintNode project.'}</small>
          </div>
          {#if projectError}
            <div class="error">{projectError}</div>
          {/if}
          <div class="actions">
            <button onclick={onClose}>Close</button>
            <button class="primary" onclick={createProject} disabled={projectBusy || !desktop}>
              {projectBusy ? 'Opening...' : 'Choose Folder'}
            </button>
          </div>
        {/if}
      </aside>
    </div>
  </div>
</Modal>

<style>
  .new-dialog {
    height: min(640px, calc(100vh - 96px));
    min-height: min(520px, calc(100vh - 96px));
    display: flex;
    flex-direction: column;
    margin: -14px;
    overflow: hidden;
  }
  .tabs {
    height: 48px;
    display: flex;
    align-items: stretch;
    gap: 18px;
    padding: 0 22px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 0 0;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    color: var(--text-dim);
    font-size: 13px;
    font-weight: 700;
  }
  .tabs button.active {
    color: var(--text-bright);
    border-bottom-color: var(--accent);
  }
  .dialog-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 290px;
  }
  .preset-browser {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 22px;
    background: var(--bg-panel);
  }
  .section-title,
  .details-title {
    margin-bottom: 14px;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 800;
    text-transform: uppercase;
  }
  .preset-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }
  .preset-header .section-title {
    margin-bottom: 0;
  }
  .preset-filters {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .preset-filters button {
    height: 24px;
    padding: 0 9px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--bg);
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 700;
  }
  .preset-filters button:hover {
    background: var(--bg-elevated);
    color: var(--text);
  }
  .preset-filters button.active {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--text-bright);
  }
  .preset-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(130px, 1fr));
    gap: 14px;
  }
  .workflow-grid {
    grid-template-columns: repeat(2, minmax(180px, 1fr));
  }
  .preset-tile {
    min-height: 158px;
    display: grid;
    grid-template-rows: 46px auto auto 20px;
    justify-items: center;
    align-items: center;
    gap: 5px;
    padding: 14px 10px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: transparent;
    color: var(--text);
    text-align: center;
  }
  .preset-tile:hover {
    background: var(--bg-elevated);
  }
  .preset-tile.selected {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent) inset;
  }
  .preset-tile :global(svg) {
    color: var(--text-dim);
  }
  .preset-tile span {
    font-weight: 700;
  }
  .preset-tile small {
    color: var(--text-dim);
    font-size: 11px;
  }
  .preset-badges {
    min-height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
  }
  .preset-badges b {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 6px;
    border: 1px solid color-mix(in srgb, var(--accent) 48%, var(--border));
    border-radius: 999px;
    color: var(--accent);
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
  }
  .project-intro {
    max-width: 520px;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 18px;
    align-items: start;
    color: var(--text);
  }
  .project-intro :global(svg) {
    color: var(--text-dim);
  }
  .project-intro p {
    margin: 0;
    color: var(--text-dim);
    line-height: 1.5;
  }
  .details {
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 22px 18px;
    background: var(--bg-panel-2);
    border-left: 1px solid var(--border);
  }
  .field {
    display: grid;
    gap: 5px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .field input,
  .field select {
    width: 100%;
  }
  .dimensions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  .summary {
    display: grid;
    gap: 4px;
    padding-top: 4px;
    color: var(--text);
  }
  .summary small {
    color: var(--text-dim);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .error {
    padding: 8px 10px;
    border: 1px solid #8a3a3a;
    border-radius: 4px;
    background: #2a1515;
    color: #f2c1c1;
    font-size: 11px;
    line-height: 1.35;
  }
  .actions {
    margin-top: auto;
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .primary:hover:not(:disabled) {
    background: var(--accent-dim);
  }
</style>
