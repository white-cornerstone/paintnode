<script lang="ts">
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { editor } from '../state/editor.svelte';
  import { workflow } from '../state/workflow.svelte';
  import { project } from '../state/project.svelte';
  import { clamp } from '../engine/types';
  import { isDesktop } from '../integrations/desktop';
  import { Board, FolderAdd, ImageAdd } from '../icons';

  let { onClose }: { onClose: () => void } = $props();

  type Tab = 'image' | 'workflow' | 'project';
  type Background = 'white' | 'transparent';
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

  const imagePresets: ImagePreset[] = [
    { id: 'desktop', name: 'Desktop Canvas', meta: '1280 x 800 px', width: 1280, height: 800, bg: 'transparent' },
    { id: 'hd', name: 'HD Screen', meta: '1920 x 1080 px', width: 1920, height: 1080, bg: 'transparent' },
    { id: 'square', name: 'Square Image', meta: '1024 x 1024 px', width: 1024, height: 1024, bg: 'transparent' },
    { id: 'social', name: 'Social Post', meta: '1080 x 1350 px', width: 1080, height: 1350, bg: 'white' },
    { id: 'icon', name: 'Icon Asset', meta: '512 x 512 px', width: 512, height: 512, bg: 'transparent' },
    { id: 'banner', name: 'Web Banner', meta: '1600 x 600 px', width: 1600, height: 600, bg: 'white' },
  ];
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
  const selectedWorkflow = $derived(
    workflowPresets.find((preset) => preset.id === selectedWorkflowId) ?? workflowPresets[0],
  );

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
          <div class="section-title">Image Presets</div>
          <div class="preset-grid">
            {#each imagePresets as preset (preset.id)}
              <button
                class="preset-tile"
                class:selected={selectedImageId === preset.id}
                onclick={() => chooseImagePreset(preset)}
              >
                <Icon svg={ImageAdd} size={44} />
                <span>{preset.name}</span>
                <small>{preset.meta}</small>
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
    min-height: 560px;
    display: flex;
    flex-direction: column;
    margin: -14px;
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
    overflow: auto;
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
  .preset-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(130px, 1fr));
    gap: 14px;
  }
  .workflow-grid {
    grid-template-columns: repeat(2, minmax(180px, 1fr));
  }
  .preset-tile {
    min-height: 142px;
    display: grid;
    place-items: center;
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
