<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { BLEND_MODES } from '../engine/types';
  import type { Layer } from '../engine/Layer.svelte';
  import LayerThumb from './LayerThumb.svelte';
  import Icon from './Icon.svelte';
  import Panel from './Panel.svelte';
  import { tooltip } from '../actions/tooltip';
  import { Eye, EyeOff, Add, SquareMultiple, Merge, ArrowUp, ArrowDown, Delete, Link, TextT } from '../icons';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  let editingId = $state<string | null>(null);
  let dragFrom = $state<number | null>(null);
  let dragOver = $state<number | null>(null);

  // Display order: top of stack first.
  const rows = $derived(editor.doc ? [...editor.doc.layers].reverse() : []);
  const active = $derived(editor.activeLayer);
  const count = $derived(editor.doc?.layers.length ?? 0);
  const activeSourceAsset = $derived(
    active?.sourceAssetId
      ? (project.current?.assets.find((asset) => asset.id === active.sourceAssetId) ?? null)
      : null,
  );

  function arrayIndex(displayIndex: number): number {
    return count - 1 - displayIndex;
  }

  function select(l: Layer) {
    editor.doc?.setActive(l.id);
    editor.bump();
  }
  function toggleVisible(l: Layer) {
    l.visible = !l.visible;
    editor.invalidate();
  }
  function setOpacity(p: number) {
    if (active) {
      active.opacity = p / 100;
      editor.invalidate();
    }
  }
  function setBlend(e: Event) {
    if (active) {
      active.blendMode = (e.target as HTMLSelectElement).value as Layer['blendMode'];
      editor.invalidate();
    }
  }
  function startRename(l: Layer) {
    editingId = l.id;
  }
  function commitRename(l: Layer, e: Event) {
    const v = (e.target as HTMLInputElement).value.trim();
    if (v) l.name = v;
    editingId = null;
  }

  function onDrop(displayTo: number) {
    if (dragFrom === null) return;
    editor.reorderLayer(arrayIndex(dragFrom), arrayIndex(displayTo));
    dragFrom = null;
    dragOver = null;
  }
</script>

<Panel title="Layers" grow bind:collapsed {onToggle}>
  <div class="props">
    <select
      class="blend"
      value={active?.blendMode ?? 'source-over'}
      onchange={setBlend}
      disabled={!active}
      title="Blend mode"
    >
      {#each BLEND_MODES as m (m.value)}
        <option value={m.value}>{m.label}</option>
      {/each}
    </select>
    <div class="opacity">
      <span>Opacity</span>
      <input
        type="range"
        min="0"
        max="100"
        value={Math.round((active?.opacity ?? 1) * 100)}
        oninput={(e) => setOpacity(+(e.currentTarget as HTMLInputElement).value)}
        disabled={!active}
      />
      <span class="pct">{Math.round((active?.opacity ?? 1) * 100)}%</span>
    </div>
  </div>

  <div class="list">
    {#each rows as l, i (l.id)}
      <div
        class="layer"
        class:active={editor.doc?.activeLayerId === l.id}
        class:dragover={dragOver === i}
        role="button"
        tabindex="0"
        draggable="true"
        onclick={() => select(l)}
        onkeydown={(e) => (e.key === 'Enter' ? select(l) : null)}
        ondragstart={() => (dragFrom = i)}
        ondragover={(e) => {
          e.preventDefault();
          dragOver = i;
        }}
        ondragleave={() => (dragOver === i ? (dragOver = null) : null)}
        ondrop={(e) => {
          e.preventDefault();
          onDrop(i);
        }}
      >
        <button
          class="eye"
          class:off={!l.visible}
          use:tooltip={{ text: l.visible ? 'Hide layer' : 'Show layer', placement: 'right' }}
          aria-label="Toggle visibility"
          onclick={(e) => {
            e.stopPropagation();
            toggleVisible(l);
          }}
        >
          <Icon svg={l.visible ? Eye : EyeOff} size={17} />
        </button>

        <div class="thumb-wrap">
          <LayerThumb layer={l} />
          {#if l.kind === 'text'}
            <span
              class="type-badge"
              use:tooltip={{ text: 'Editable type layer', placement: 'right' }}
            >
              <Icon svg={TextT} size={11} />
            </span>
          {/if}
        </div>

        <div class="name">
          {#if editingId === l.id}
            <!-- svelte-ignore a11y_autofocus -->
            <input
              type="text"
              value={l.name}
              autofocus
              onblur={(e) => commitRename(l, e)}
              onkeydown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') editingId = null;
              }}
            />
          {:else}
            <span ondblclick={() => startRename(l)} role="textbox" tabindex="-1">{l.name}</span>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <footer class="bar">
    <button
      use:tooltip={{ text: 'New layer', placement: 'top' }}
      aria-label="New layer"
      onclick={() => editor.addLayer()}
    >
      <Icon svg={Add} size={17} />
    </button>
    <button
      use:tooltip={{ text: 'Duplicate layer', placement: 'top' }}
      aria-label="Duplicate layer"
      onclick={() => active && editor.duplicateLayer(active.id)}
      disabled={!active}><Icon svg={SquareMultiple} size={17} /></button
    >
    <button
      use:tooltip={{ text: 'Merge down', placement: 'top' }}
      aria-label="Merge down"
      onclick={() => active && editor.mergeDown(active.id)}
      disabled={!active}><Icon svg={Merge} size={17} /></button
    >
    <button
      use:tooltip={{ text: 'Reveal source asset', placement: 'top' }}
      aria-label="Reveal source asset"
      onclick={() => activeSourceAsset && void project.reveal(activeSourceAsset)}
      disabled={!activeSourceAsset}><Icon svg={Link} size={15} /></button
    >
    <span class="spacer"></span>
    <button
      use:tooltip={{ text: 'Move layer up', placement: 'top' }}
      aria-label="Move layer up"
      onclick={() => active && editor.moveLayer(active.id, 1)}
      disabled={!active}><Icon svg={ArrowUp} size={16} /></button
    >
    <button
      use:tooltip={{ text: 'Move layer down', placement: 'top' }}
      aria-label="Move layer down"
      onclick={() => active && editor.moveLayer(active.id, -1)}
      disabled={!active}><Icon svg={ArrowDown} size={16} /></button
    >
    <button
      class="del"
      use:tooltip={{ text: 'Delete layer', placement: 'top' }}
      aria-label="Delete layer"
      onclick={() => active && editor.deleteLayer(active.id)}
      disabled={!active}><Icon svg={Delete} size={16} /></button
    >
  </footer>
</Panel>

<style>
  .props {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 7px;
    border-bottom: 1px solid var(--border);
  }
  .blend {
    width: 100%;
  }
  .opacity {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-dim);
  }
  .opacity input {
    flex: 1;
  }
  .pct {
    width: 38px;
    text-align: right;
    color: var(--text);
  }
  .list {
    flex: 1;
    overflow-y: auto;
    min-height: 60px;
  }
  .layer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  .layer:hover {
    background: var(--bg-panel-2);
  }
  .layer.active {
    background: var(--accent-dim);
  }
  .layer.dragover {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .eye {
    flex: none;
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--text);
  }
  .eye.off {
    color: var(--text-dim);
    opacity: 0.5;
  }
  .thumb-wrap {
    position: relative;
    flex: none;
    display: flex;
  }
  .type-badge {
    position: absolute;
    right: -3px;
    bottom: -3px;
    width: 15px;
    height: 15px;
    display: grid;
    place-items: center;
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--text-bright);
  }
  .name {
    flex: 1;
    min-width: 0;
  }
  .name span {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name input {
    width: 100%;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 5px 6px;
    border-top: 1px solid var(--border);
    background: var(--bg-panel-2);
  }
  .bar button {
    width: 26px;
    height: 24px;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    font-size: 13px;
  }
  .bar button:hover:not(:disabled) {
    background: var(--bg-elevated);
    border-color: var(--border-soft);
  }
  .spacer {
    flex: 1;
  }
  .bar .del:hover:not(:disabled) {
    color: var(--danger);
  }
</style>
