<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { BLEND_MODES } from '../engine/types';
  import type { Layer } from '../engine/Layer.svelte';
  import LayerThumb from './LayerThumb.svelte';
  import Icon from './Icon.svelte';
  import Panel from './Panel.svelte';
  import { tooltip } from '../actions/tooltip';
  import { Eye, EyeOff, Add, SquareMultiple, Merge, ArrowUp, ArrowDown, Delete, Link, TextT, CommentNote, ChevronDown, ChevronRight, ArrowTrending, Note, Tag, Textbox } from '../icons';
  import type { AnnotationItem } from '../engine/annotations';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  let editingId = $state<string | null>(null);
  let dragFrom = $state<number | null>(null);
  let dragOver = $state<number | null>(null);
  let annotationsExpanded = $state(true);

  // Display order: top of stack first.
  const rows = $derived(editor.doc ? [...editor.doc.layers].reverse() : []);
  const active = $derived(editor.activeLayer);
  const activeRasterLayer = $derived(editor.activeToolId !== 'annotation' && !editor.selectedAnnotationId ? active : null);
  const count = $derived(editor.doc?.layers.length ?? 0);
  const annotationCount = $derived(editor.doc?.annotations.length ?? 0);
  const activeSourceAsset = $derived(
    activeRasterLayer?.sourceAssetId
      ? (project.current?.assets.find((asset) => asset.id === activeRasterLayer.sourceAssetId) ?? null)
      : null,
  );

  function arrayIndex(displayIndex: number): number {
    return count - 1 - displayIndex;
  }

  function select(l: Layer) {
    editor.doc?.setActive(l.id);
    editor.selectAnnotation(null);
    editor.bump();
  }
  function selectAnnotationLayer() {
    editor.selectAnnotation(null);
    editor.setTool('annotation');
  }
  function selectAnnotationObject(item: AnnotationItem) {
    editor.selectAnnotation(item.id);
  }
  function annotationIcon(item: AnnotationItem): string {
    if (item.kind === 'arrow') return ArrowTrending;
    if (item.kind === 'note') return Note;
    if (item.kind === 'badge') return Tag;
    if (item.kind === 'divider') return Textbox;
    return CommentNote;
  }
  function annotationName(item: AnnotationItem): string {
    const text = item.text.trim();
    const type = item.kind === 'note' ? 'Memo' : item.kind[0].toUpperCase() + item.kind.slice(1);
    return text ? `${type}: ${text}` : type;
  }
  function toggleVisible(l: Layer) {
    l.visible = !l.visible;
    editor.invalidate();
  }
  function setOpacity(p: number) {
    if (activeRasterLayer) {
      activeRasterLayer.opacity = p / 100;
      editor.invalidate();
    }
  }
  function setBlend(e: Event) {
    if (activeRasterLayer) {
      activeRasterLayer.blendMode = (e.target as HTMLSelectElement).value as Layer['blendMode'];
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
      value={activeRasterLayer?.blendMode ?? 'source-over'}
      onchange={setBlend}
      disabled={!activeRasterLayer}
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
        value={Math.round((activeRasterLayer?.opacity ?? 1) * 100)}
        oninput={(e) => setOpacity(+(e.currentTarget as HTMLInputElement).value)}
        disabled={!activeRasterLayer}
      />
      <span class="pct">{Math.round((activeRasterLayer?.opacity ?? 1) * 100)}%</span>
    </div>
  </div>

  <div class="list">
    {#if editor.doc && annotationCount > 0}
      <div
        class="layer annotation-layer-row"
        class:active={editor.activeToolId === 'annotation' && !editor.selectedAnnotationId}
        role="button"
        tabindex="0"
        onclick={selectAnnotationLayer}
        onkeydown={(e) => (e.key === 'Enter' ? selectAnnotationLayer() : null)}
      >
        <button
          class="twisty"
          aria-label={annotationsExpanded ? 'Collapse annotations' : 'Expand annotations'}
          use:tooltip={{ text: annotationsExpanded ? 'Collapse annotations' : 'Expand annotations', placement: 'right' }}
          onclick={(e) => {
            e.stopPropagation();
            annotationsExpanded = !annotationsExpanded;
          }}
        >
          <Icon svg={annotationsExpanded ? ChevronDown : ChevronRight} size={15} />
        </button>
        <button
          class="eye"
          class:off={!editor.doc.annotationsVisible}
          use:tooltip={{ text: editor.doc.annotationsVisible ? 'Hide annotation layer' : 'Show annotation layer', placement: 'right' }}
          aria-label="Toggle annotation layer visibility"
          onclick={(e) => {
            e.stopPropagation();
            editor.setAnnotationsVisible(!editor.doc!.annotationsVisible);
          }}
        >
          <Icon svg={editor.doc.annotationsVisible ? Eye : EyeOff} size={17} />
        </button>

        <div class="annotation-thumb" aria-hidden="true">
          <Icon svg={CommentNote} size={18} />
        </div>

        <div class="name">
          <span>Annotations</span>
          <small>{annotationCount} object{annotationCount === 1 ? '' : 's'}</small>
        </div>
      </div>
      {#if annotationsExpanded}
        {#each [...editor.doc.annotations].reverse() as item (item.id)}
          <div
            class="layer annotation-child-row"
            class:active={editor.selectedAnnotationId === item.id}
            role="button"
            tabindex="0"
            onclick={() => selectAnnotationObject(item)}
            onkeydown={(e) => (e.key === 'Enter' ? selectAnnotationObject(item) : null)}
          >
            <span class="child-indent"></span>
            <button
              class="eye"
              class:off={!item.visible}
              use:tooltip={{ text: item.visible ? 'Hide annotation' : 'Show annotation', placement: 'right' }}
              aria-label="Toggle annotation visibility"
              onclick={(e) => {
                e.stopPropagation();
                editor.updateAnnotation(item.id, { visible: !item.visible });
              }}
            >
              <Icon svg={item.visible ? Eye : EyeOff} size={15} />
            </button>
            <div class="annotation-object-icon" aria-hidden="true">
              <Icon svg={annotationIcon(item)} size={16} />
            </div>
            <div class="name">
              <span>{annotationName(item)}</span>
            </div>
          </div>
        {/each}
      {/if}
    {/if}
    {#each rows as l, i (l.id)}
      <div
        class="layer"
        class:active={editor.doc?.activeLayerId === l.id && editor.activeToolId !== 'annotation' && !editor.selectedAnnotationId}
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
      onclick={() => activeRasterLayer && editor.duplicateLayer(activeRasterLayer.id)}
      disabled={!activeRasterLayer}><Icon svg={SquareMultiple} size={17} /></button
    >
    <button
      use:tooltip={{ text: 'Merge down', placement: 'top' }}
      aria-label="Merge down"
      onclick={() => activeRasterLayer && editor.mergeDown(activeRasterLayer.id)}
      disabled={!activeRasterLayer}><Icon svg={Merge} size={17} /></button
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
      onclick={() => activeRasterLayer && editor.moveLayer(activeRasterLayer.id, 1)}
      disabled={!activeRasterLayer}><Icon svg={ArrowUp} size={16} /></button
    >
    <button
      use:tooltip={{ text: 'Move layer down', placement: 'top' }}
      aria-label="Move layer down"
      onclick={() => activeRasterLayer && editor.moveLayer(activeRasterLayer.id, -1)}
      disabled={!activeRasterLayer}><Icon svg={ArrowDown} size={16} /></button
    >
    <button
      class="del"
      use:tooltip={{ text: 'Delete layer', placement: 'top' }}
      aria-label="Delete layer"
      onclick={() => activeRasterLayer && editor.deleteLayer(activeRasterLayer.id)}
      disabled={!activeRasterLayer}><Icon svg={Delete} size={16} /></button
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
  .twisty {
    flex: none;
    width: 18px;
    height: 24px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-dim);
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
  .annotation-layer-row {
    background: color-mix(in srgb, var(--bg-panel-2) 78%, var(--accent) 7%);
  }
  .annotation-child-row {
    min-height: 34px;
    padding-left: 10px;
    background: color-mix(in srgb, var(--bg-panel) 88%, #000 12%);
  }
  .annotation-child-row.active {
    background: var(--accent-dim);
  }
  .child-indent {
    flex: none;
    width: 14px;
    align-self: stretch;
    border-left: 1px solid var(--border-soft);
    border-bottom: 1px solid var(--border-soft);
  }
  .annotation-layer-row .name {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .annotation-layer-row small {
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1;
  }
  .annotation-thumb {
    flex: none;
    display: grid;
    place-items: center;
    width: 44px;
    height: 34px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background:
      linear-gradient(90deg, rgba(255, 255, 255, 0.06) 1px, transparent 1px),
      linear-gradient(rgba(255, 255, 255, 0.06) 1px, transparent 1px),
      var(--bg-panel);
    background-size: 8px 8px;
    color: var(--accent);
  }
  .annotation-object-icon {
    flex: none;
    display: grid;
    place-items: center;
    width: 30px;
    height: 24px;
    color: var(--text-dim);
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
