<script lang="ts">
  import { tick } from 'svelte';
  import Modal from './Modal.svelte';
  import Icon from './Icon.svelte';
  import { editor } from '../state/editor.svelte';
  import { workflow } from '../state/workflow.svelte';
  import { project } from '../state/project.svelte';
  import { ui, type NewDialogTab } from '../state/ui.svelte';
  import { settings } from '../state/settings.svelte';
  import { clamp } from '../engine/types';
  import { isDesktop } from '../integrations/desktop';
  import { tooltip } from '../actions/tooltip';
  import { Board, FolderAdd, ImageAdd } from '../icons';
  import { isAntigravityImageRatio, isCodexImageSize } from '../ai/imageModelCapabilities';
  import { WORKFLOW_TEMPLATES, type WorkflowTemplateDefinition } from '../workflow';
  import { restoreExternalDialogTrigger } from '../state/workflowFocus';

  let { onClose }: { onClose: () => void } = $props();

  type Tab = NewDialogTab;
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
  const desktop = isDesktop();
  let tab = $state<Tab>(ui.newDialogTab);
  let presetFilter = $state<PresetFilter>('all');

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
      label: 'Antigravity',
      tooltip: 'Show aspect ratios that best fit Antigravity image generation.',
    },
  ];

  function isAgyFriendly(width: number, height: number): boolean {
    return isAntigravityImageRatio(width, height);
  }

  function isCodexFriendly(width: number, height: number): boolean {
    return isCodexImageSize(width, height);
  }

  function normalizedDimension(value: number): number {
    return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
  }

  function presetMeta(width: number, height: number): string {
    return `${width} x ${height} px`;
  }

  function previewFrameStyle(width: number, height: number, maxWidth = 112, maxHeight = 72): string {
    const safeWidth = normalizedDimension(width);
    const safeHeight = normalizedDimension(height);
    const scale = Math.min(maxWidth / safeWidth, maxHeight / safeHeight);
    const previewWidth = Math.max(34, Math.round(safeWidth * scale));
    const previewHeight = Math.max(34, Math.round(safeHeight * scale));
    return `--preview-width: ${previewWidth}px; --preview-height: ${previewHeight}px;`;
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
    // AI presets use the image model's real 1K output grids (e.g. "2:3"
    // outputs 848x1264, not a nominal 2:3), so one generation covers the
    // whole document without cropping or resampling.
    { id: 'ai-2-3', name: 'AI Portrait', meta: presetMeta(848, 1264), width: 848, height: 1264, bg: 'transparent' },
    { id: 'ai-3-2', name: 'AI Landscape', meta: presetMeta(1264, 848), width: 1264, height: 848, bg: 'transparent' },
    { id: 'ai-3-4', name: 'AI Tall Frame', meta: presetMeta(896, 1200), width: 896, height: 1200, bg: 'transparent' },
    { id: 'ai-4-3', name: 'AI Classic', meta: presetMeta(1200, 896), width: 1200, height: 896, bg: 'transparent' },
    { id: 'ai-4-5', name: 'AI Social', meta: presetMeta(928, 1152), width: 928, height: 1152, bg: 'white' },
    { id: 'ai-5-4', name: 'AI Wide Card', meta: presetMeta(1152, 928), width: 1152, height: 928, bg: 'white' },
    { id: 'ai-9-16', name: 'AI Story', meta: presetMeta(768, 1376), width: 768, height: 1376, bg: 'transparent' },
    { id: 'ai-16-9', name: 'AI Wide Screen', meta: presetMeta(1376, 768), width: 1376, height: 768, bg: 'transparent' },
    { id: 'ai-21-9', name: 'AI Cinema', meta: presetMeta(1584, 672), width: 1584, height: 672, bg: 'transparent' },
    { id: 'social', name: 'Social Post', meta: presetMeta(1080, 1350), width: 1080, height: 1350, bg: 'white' },
    { id: 'icon', name: 'Icon Asset', meta: presetMeta(512, 512), width: 512, height: 512, bg: 'transparent' },
    { id: 'banner', name: 'Web Banner', meta: presetMeta(1600, 600), width: 1600, height: 600, bg: 'white' },
  ]);
  const workflowPresets = WORKFLOW_TEMPLATES;

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
    if (isAgyFriendly(preset.width, preset.height)) badges.push('Antigravity');
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

  function pickWorkflowPreset(preset: WorkflowTemplateDefinition): void {
    selectedWorkflowId = preset.id;
    workflowName = preset.name === 'Blank Workflow' ? 'Untitled Workflow' : preset.name;
  }

  function chooseWorkflowPreset(preset: WorkflowTemplateDefinition): void {
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
    projectError = '';
    try {
      workflow.newFromTemplate(selectedWorkflow.id, workflowName.trim() || selectedWorkflow.name);
      ui.requestWorkflowFocus();
      onClose();
    } catch (error) {
      projectError = (error as Error)?.message ?? String(error);
    }
  }

  async function chooseWorkflowProject(trigger: HTMLElement): Promise<void> {
    projectError = '';
    if (!desktop) {
      projectError = 'Project folders are available in the desktop app.';
      return;
    }
    projectBusy = true;
    try {
      await project.openFolder();
      projectError = project.error;
    } catch (e) {
      projectError = (e as Error)?.message ?? String(e);
    } finally {
      projectBusy = false;
      await tick();
      restoreExternalDialogTrigger(trigger);
    }
  }

  async function createProject(trigger?: HTMLElement): Promise<void> {
    projectError = '';
    if (!desktop) {
      projectError = 'Project folders are available in the desktop app.';
      return;
    }
    projectBusy = true;
    try {
      const opened = await project.openFolder();
      if (opened) onClose();
      else projectError = project.error;
    } catch (e) {
      projectError = (e as Error)?.message ?? String(e);
    } finally {
      projectBusy = false;
      if (trigger) {
        await tick();
        restoreExternalDialogTrigger(trigger);
      }
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
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    if (event.target instanceof HTMLButtonElement) return;
    event.preventDefault();
    createCurrent();
  }

  const tabs: readonly Tab[] = ['image', 'workflow', 'project'];
  function selectTab(next: Tab, focus = false): void {
    tab = next;
    if (focus) requestAnimationFrame(() => document.getElementById(`new-tab-${next}`)?.focus());
  }

  function onTabKeydown(event: KeyboardEvent, current: Tab): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = tabs.indexOf(current);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectTab(tabs[nextIndex], true);
  }
</script>

<Modal title="New" {onClose} width={980} height={680} minWidth={720} minHeight={460} resizable>
  <div class="new-dialog" role="presentation" onkeydown={onDialogKeydown}>
    <div class="tabs" role="tablist" aria-label="New item type">
      <button id="new-tab-image" class:active={tab === 'image'} onclick={() => selectTab('image')} onkeydown={(event) => onTabKeydown(event, 'image')} role="tab" aria-selected={tab === 'image'} aria-controls="new-panel-image" tabindex={tab === 'image' ? 0 : -1} data-autofocus={tab === 'image' ? '' : undefined}>
        <Icon svg={ImageAdd} size={17} /><span>Image</span>
      </button>
      <button id="new-tab-workflow" class:active={tab === 'workflow'} onclick={() => selectTab('workflow')} onkeydown={(event) => onTabKeydown(event, 'workflow')} role="tab" aria-selected={tab === 'workflow'} aria-controls="new-panel-workflow" tabindex={tab === 'workflow' ? 0 : -1} data-autofocus={tab === 'workflow' ? '' : undefined}>
        <Icon svg={Board} size={17} /><span>Workflow</span>
      </button>
      <button id="new-tab-project" class:active={tab === 'project'} onclick={() => selectTab('project')} onkeydown={(event) => onTabKeydown(event, 'project')} role="tab" aria-selected={tab === 'project'} aria-controls="new-panel-project" tabindex={tab === 'project' ? 0 : -1} data-autofocus={tab === 'project' ? '' : undefined}>
        <Icon svg={FolderAdd} size={17} /><span>Project</span>
      </button>
    </div>

    <div class="dialog-grid" id={`new-panel-${tab}`} role="tabpanel" aria-labelledby={`new-tab-${tab}`}>
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
                class="preset-tile image-preset-tile"
                class:selected={selectedImageId === preset.id}
                onclick={() => chooseImagePreset(preset)}
              >
                <span class="preset-preview" aria-hidden="true">
                  <span
                    class="document-shape"
                    style={previewFrameStyle(preset.width, preset.height)}
                  >
                    <span class="document-fold"></span>
                    <span class="document-tick document-tick-horizontal"></span>
                    <span class="document-tick document-tick-vertical"></span>
                  </span>
                </span>
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
                <small>{preset.description}</small>
                <span class="template-counts">{preset.slots.length} inputs · {preset.outputs.length} outputs</span>
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
            <small>{selectedWorkflow.description}</small>
          </div>
          <div class="workflow-plan" aria-label="Template contents">
            <strong>Inputs</strong>
            <span>{selectedWorkflow.slots.map((slot) => `${slot.name}${slot.required ? ' (required)' : ' (optional)'}`).join(', ')}</span>
            <strong>Outputs</strong>
            <span>{selectedWorkflow.outputs.map((output) => `${output.name} · ${output.width}×${output.height}`).join(', ')}</span>
          </div>
          <div class="project-requirement" class:ready={!!project.path}>
            <strong>{project.path ? 'Project folder ready' : 'Project folder required for Generate'}</strong>
            <span>{project.path ?? (desktop
              ? 'You can create the board now, but Generate and Save stay blocked until a project folder is open.'
              : 'Open this workflow in the PaintNode desktop app to choose a project folder, Save, and Generate.')}</span>
            <button type="button" onclick={(event) => void chooseWorkflowProject(event.currentTarget)} disabled={projectBusy || !desktop}>
              {projectBusy ? 'Opening…' : project.path ? 'Change folder…' : 'Choose or create folder…'}
            </button>
          </div>
          {#if projectError}<div class="error" role="alert">{projectError}</div>{/if}
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
            <button class="primary" onclick={(event) => void createProject(event.currentTarget)} disabled={projectBusy || !desktop}>
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
    height: 100%;
    min-height: 0;
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
  .template-counts {
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 700;
  }
  .workflow-plan,
  .project-requirement {
    display: grid;
    gap: 5px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: var(--bg);
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.35;
  }
  .workflow-plan strong,
  .project-requirement strong {
    color: var(--text-bright);
    font-size: 11px;
  }
  .project-requirement {
    margin-top: 10px;
    border-color: color-mix(in srgb, var(--warning, #d6a84b) 55%, var(--border));
  }
  .project-requirement.ready {
    border-color: color-mix(in srgb, var(--success, #65b884) 55%, var(--border));
  }
  .project-requirement button {
    justify-self: start;
    margin-top: 4px;
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
  .image-preset-tile {
    grid-template-rows: 88px auto auto 20px;
    min-height: 184px;
    padding-top: 15px;
  }
  .preset-tile :global(svg) {
    color: var(--text-dim);
  }
  .preset-preview {
    width: 146px;
    height: 88px;
    display: grid;
    place-items: center;
  }
  .document-shape {
    position: relative;
    width: var(--preview-width);
    height: var(--preview-height);
    border: 3px solid color-mix(in srgb, var(--text-dim) 72%, var(--text));
    border-radius: 4px;
    border-top-right-radius: 1px;
    background: transparent;
    color: color-mix(in srgb, var(--text-dim) 72%, var(--text));
  }
  .document-fold {
    position: absolute;
    top: -3px;
    right: -3px;
    width: clamp(12px, 22%, 24px);
    aspect-ratio: 1;
    background: var(--bg-panel);
    overflow: hidden;
    z-index: 1;
  }
  .image-preset-tile:hover .document-fold {
    background: var(--bg-elevated);
  }
  .document-fold::before {
    content: '';
    position: absolute;
    left: 1px;
    top: 1px;
    width: 142%;
    height: 3px;
    border-radius: 999px;
    background: currentColor;
    transform: rotate(45deg);
    transform-origin: left center;
  }
  .document-fold::after {
    content: '';
    position: absolute;
    left: 0;
    bottom: 0;
    width: calc(100% - 2px);
    height: calc(100% - 2px);
    border-left: 3px solid currentColor;
    border-bottom: 3px solid currentColor;
    border-bottom-left-radius: 2px;
  }
  .document-tick {
    position: absolute;
    display: block;
    border-radius: 999px;
    background: currentColor;
  }
  .document-tick-horizontal {
    top: 18%;
    left: -28px;
    width: 22px;
    height: 3px;
  }
  .document-tick-vertical {
    top: -28px;
    left: 18%;
    width: 3px;
    height: 22px;
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
