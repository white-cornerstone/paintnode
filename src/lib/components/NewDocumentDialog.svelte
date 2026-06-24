<script lang="ts">
  import Modal from './Modal.svelte';
  import { editor } from '../state/editor.svelte';
  import { clamp } from '../engine/types';

  let { onClose }: { onClose: () => void } = $props();

  let width = $state(1280);
  let height = $state(800);
  let name = $state('Untitled');
  let bg = $state<'white' | 'transparent'>('white');

  const presets = [
    { label: 'HD 1920×1080', w: 1920, h: 1080 },
    { label: 'Desktop 1280×800', w: 1280, h: 800 },
    { label: 'Square 1024', w: 1024, h: 1024 },
    { label: 'Icon 512', w: 512, h: 512 },
  ];

  function applyPreset(w: number, h: number) {
    width = w;
    height = h;
  }
  function create() {
    editor.newDocument(
      clamp(Math.round(width), 1, 8192),
      clamp(Math.round(height), 1, 8192),
      name.trim() || 'Untitled',
      bg === 'white',
    );
    onClose();
  }
</script>

<Modal title="New Document" {onClose} width={400}>
  <div class="form">
    <label class="field">
      <span>Name</span>
      <input type="text" bind:value={name} spellcheck="false" />
    </label>

    <div class="dims">
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

    <div class="presets">
      {#each presets as p (p.label)}
        <button class="preset" onclick={() => applyPreset(p.w, p.h)}>{p.label}</button>
      {/each}
    </div>

    <div class="actions">
      <button onclick={onClose}>Cancel</button>
      <button class="primary" onclick={create}>Create</button>
    </div>
  </div>
</Modal>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: var(--text-dim);
  }
  .field input,
  .field select {
    width: 100%;
  }
  .dims {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  .presets {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
  }
  .preset {
    font-size: 11px;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }
  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .primary:hover {
    background: var(--accent-dim);
  }
</style>
