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
  let dragFromId = $state<string | null>(null);
  let dragInsertSlot = $state<number | null>(null);
  let pointerDrag = $state<{
    pointerId: number;
    layerId: string;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    offsetX: number;
    offsetY: number;
    width: number;
    height: number;
    dragging: boolean;
  } | null>(null);
  let suppressClick = $state(false);
  let annotationsExpanded = $state(true);
  let opacityOpen = $state(false);
  let opacityDraft = $state<string | null>(null);
  let opacityControl: HTMLDivElement | null = null;

  // Display order: top of stack first.
  const rows = $derived(editor.doc ? [...editor.doc.layers].reverse() : []);
  const active = $derived(editor.activeLayer);
  const activeRasterLayer = $derived(editor.activeToolId !== 'annotation' && !editor.selectedAnnotationId ? active : null);
  const activeOpacityPercent = $derived(Math.round((activeRasterLayer?.opacity ?? 1) * 100));
  const annotationCount = $derived(editor.doc?.annotations.length ?? 0);
  const draggedLayer = $derived(dragFromId ? rows.find((layer) => layer.id === dragFromId) ?? null : null);
  const activeSourceAsset = $derived(
    activeRasterLayer?.sourceAssetId
      ? (project.current?.assets.find((asset) => asset.id === activeRasterLayer.sourceAssetId) ?? null)
      : null,
  );

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
  function clampPercent(p: number): number {
    if (!Number.isFinite(p)) return activeOpacityPercent;
    return Math.max(0, Math.min(100, Math.round(p)));
  }
  function setOpacity(p: number) {
    if (activeRasterLayer) {
      activeRasterLayer.opacity = clampPercent(p) / 100;
      editor.invalidate();
    }
  }
  function setOpacityFromInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    opacityDraft = input.value;
    if (Number.isFinite(input.valueAsNumber)) setOpacity(input.valueAsNumber);
  }
  function finishOpacityInput(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    if (Number.isFinite(input.valueAsNumber)) setOpacity(input.valueAsNumber);
    opacityDraft = null;
  }
  function startOpacityInput(e: Event) {
    opacityDraft = String(activeOpacityPercent);
    (e.currentTarget as HTMLInputElement).select();
  }
  function closeOpacityOnOutside(e: PointerEvent) {
    if (!opacityOpen) return;
    if (opacityControl?.contains(e.target as Node)) return;
    opacityOpen = false;
  }
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') opacityOpen = false;
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

  function reorderDraggedLayer(displaySlot: number | null) {
    const layers = editor.doc?.layers ?? [];
    if (!dragFromId || displaySlot === null || layers.length === 0) return;

    const from = layers.findIndex((layer) => layer.id === dragFromId);
    const fromDisplay = rows.findIndex((layer) => layer.id === dragFromId);
    if (from < 0 || fromDisplay < 0) return;

    const displayAfterRemoval = Math.max(0, Math.min(displaySlot - (displaySlot > fromDisplay ? 1 : 0), rows.length - 1));
    const to = layers.length - 1 - displayAfterRemoval;
    if (from >= 0 && to >= 0) editor.reorderLayer(from, to);
  }

  function clearDrag() {
    pointerDrag = null;
    dragFromId = null;
    dragInsertSlot = null;
  }

  function interactiveTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && !!target.closest('button,input,select,textarea,[contenteditable="true"]');
  }

  function onLayerClick(e: MouseEvent, layer: Layer) {
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
      return;
    }
    select(layer);
  }

  function onLayerPointerDown(e: PointerEvent, layer: Layer, displayIndex: number) {
    if (e.button !== 0 || interactiveTarget(e.target)) return;
    const row = e.currentTarget as HTMLElement;
    const rect = row.getBoundingClientRect();
    row.setPointerCapture(e.pointerId);
    pointerDrag = {
      pointerId: e.pointerId,
      layerId: layer.id,
      startX: e.clientX,
      startY: e.clientY,
      currentX: e.clientX,
      currentY: e.clientY,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
      dragging: false,
    };
    dragFromId = layer.id;
    dragInsertSlot = displayIndex;
  }

  function onLayerPointerMove(e: PointerEvent) {
    if (!pointerDrag || pointerDrag.pointerId !== e.pointerId) return;

    const distance = Math.hypot(e.clientX - pointerDrag.startX, e.clientY - pointerDrag.startY);
    if (!pointerDrag.dragging && distance < 4) return;

    pointerDrag = { ...pointerDrag, currentX: e.clientX, currentY: e.clientY, dragging: true };
    e.preventDefault();
    dragInsertSlot = hitTestInsertSlot(e);
  }

  function previewStyle(drag: NonNullable<typeof pointerDrag>): string {
    const x = drag.currentX - drag.offsetX;
    const y = drag.currentY - drag.offsetY;
    return `left: ${x}px; top: ${y}px; width: ${drag.width}px; height: ${drag.height}px;`;
  }

  function onLayerPointerUp(e: PointerEvent) {
    if (!pointerDrag || pointerDrag.pointerId !== e.pointerId) return;

    const row = e.currentTarget as HTMLElement;
    if (row.hasPointerCapture(e.pointerId)) row.releasePointerCapture(e.pointerId);

    if (pointerDrag.dragging) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = true;
      reorderDraggedLayer(dragInsertSlot);
      setTimeout(() => {
        suppressClick = false;
      });
    }

    clearDrag();
  }

  function hitTestInsertSlot(e: PointerEvent): number | null {
    if (!editor.doc || rows.length === 0) return null;
    const list = (e.currentTarget as HTMLElement).closest('.list');
    if (!list) return null;

    const layerRows = Array.from(list.querySelectorAll<HTMLElement>('.layer[data-layer-id]'));
    if (layerRows.length === 0) return null;

    for (let i = 0; i < layerRows.length; i++) {
      const rect = layerRows[i].getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) return i;
    }
    return layerRows.length;
  }
</script>

<svelte:window onpointerdown={closeOpacityOnOutside} onkeydown={onWindowKeydown} />

<Panel title="Layers" grow bind:collapsed {onToggle}>
  <div class="props">
    <div class="layer-settings">
      <select
        class="blend"
        aria-label="Blend mode"
        value={activeRasterLayer?.blendMode ?? 'source-over'}
        onchange={setBlend}
        disabled={!activeRasterLayer}
      >
        {#each BLEND_MODES as m (m.value)}
          <option value={m.value}>{m.label}</option>
        {/each}
      </select>
      <label class="opacity-label" for="layer-opacity">Opacity:</label>
      <div class="opacity-control" bind:this={opacityControl}>
        <div class="opacity-value" class:disabled={!activeRasterLayer}>
          <input
            id="layer-opacity"
            type="number"
            min="0"
            max="100"
            step="1"
            value={opacityDraft ?? activeOpacityPercent}
            oninput={setOpacityFromInput}
            onblur={finishOpacityInput}
            onfocus={startOpacityInput}
            onkeydown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') {
                opacityDraft = null;
                e.currentTarget.blur();
              }
            }}
            disabled={!activeRasterLayer}
          />
          <span aria-hidden="true">%</span>
        </div>
        <button
          class="opacity-toggle"
          aria-label="Open opacity slider"
          aria-haspopup="dialog"
          aria-expanded={opacityOpen}
          use:tooltip={{ text: 'Opacity slider', placement: 'left' }}
          onclick={() => (opacityOpen = !opacityOpen)}
          disabled={!activeRasterLayer}
        >
          <Icon svg={ChevronDown} size={14} />
        </button>
        {#if opacityOpen && activeRasterLayer}
          <div class="opacity-popover" role="dialog" aria-label="Opacity slider">
            <input
              type="range"
              min="0"
              max="100"
              value={activeOpacityPercent}
              oninput={(e) => setOpacity(+(e.currentTarget as HTMLInputElement).value)}
              aria-label="Layer opacity"
            />
          </div>
        {/if}
      </div>
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
        class:dragging={dragFromId === l.id}
        class:insert-before={dragInsertSlot === i}
        class:insert-after={dragInsertSlot === rows.length && i === rows.length - 1}
        role="button"
        data-layer-id={l.id}
        tabindex="0"
        onclick={(e) => onLayerClick(e, l)}
        onkeydown={(e) => (e.key === 'Enter' ? select(l) : null)}
        onpointerdown={(e) => onLayerPointerDown(e, l, i)}
        onpointermove={onLayerPointerMove}
        onpointerup={onLayerPointerUp}
        onpointercancel={clearDrag}
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

{#if pointerDrag?.dragging && draggedLayer}
  <div class="layer-drag-preview" style={previewStyle(pointerDrag)} aria-hidden="true">
    <button class="eye" class:off={!draggedLayer.visible} tabindex="-1">
      <Icon svg={draggedLayer.visible ? Eye : EyeOff} size={17} />
    </button>

    <div class="thumb-wrap">
      <LayerThumb layer={draggedLayer} />
      {#if draggedLayer.kind === 'text'}
        <span class="type-badge">
          <Icon svg={TextT} size={11} />
        </span>
      {/if}
    </div>

    <div class="name">
      <span>{draggedLayer.name}</span>
    </div>
  </div>
{/if}

<style>
  .props {
    padding: 8px;
    border-bottom: 1px solid var(--border);
  }
  .layer-settings {
    position: relative;
    display: grid;
    grid-template-columns: minmax(90px, 1fr) auto auto;
    align-items: center;
    gap: 6px;
  }
  .blend {
    width: 100%;
    min-width: 0;
    height: 28px;
  }
  .opacity-label {
    color: var(--text-dim);
    white-space: nowrap;
  }
  .opacity-control {
    position: relative;
    display: flex;
    align-items: stretch;
    flex: none;
  }
  .opacity-value {
    display: flex;
    align-items: center;
    width: 58px;
    height: 28px;
    padding: 0 5px;
    background: var(--bg-input);
    border: 1px solid var(--border-soft);
    border-right: 0;
    border-radius: 3px 0 0 3px;
    color: var(--text);
  }
  .opacity-value.disabled {
    opacity: 0.4;
  }
  .opacity-value input {
    min-width: 0;
    width: 100%;
    height: 24px;
    padding: 0;
    color: inherit;
    text-align: right;
    background: transparent;
    border: 0;
    border-radius: 0;
  }
  .opacity-value input:focus {
    outline: none;
  }
  .opacity-value input::-webkit-outer-spin-button,
  .opacity-value input::-webkit-inner-spin-button {
    margin: 0;
    appearance: none;
  }
  .opacity-value span {
    flex: none;
    margin-left: 1px;
  }
  .opacity-toggle {
    display: grid;
    place-items: center;
    width: 26px;
    height: 28px;
    padding: 0;
    border-radius: 0 3px 3px 0;
  }
  .opacity-popover {
    position: absolute;
    z-index: 20;
    top: calc(100% + 6px);
    right: 0;
    width: 238px;
    padding: 14px 16px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    box-shadow: 0 10px 24px rgba(0, 0, 0, 0.45);
  }
  .opacity-popover input {
    display: block;
    width: 100%;
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
    touch-action: none;
  }
  .layer:hover {
    background: var(--bg-panel-2);
  }
  .layer.active {
    background: var(--accent-dim);
  }
  .layer.insert-before {
    box-shadow: inset 0 2px 0 var(--accent);
  }
  .layer.insert-after {
    box-shadow: inset 0 -2px 0 var(--accent);
  }
  .layer.dragging {
    cursor: grabbing;
    opacity: 0.38;
  }
  .layer-drag-preview {
    position: fixed;
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 8px;
    border: 1px solid var(--accent);
    border-radius: 6px;
    background: color-mix(in srgb, var(--bg-panel-2) 92%, var(--accent) 8%);
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
    color: var(--text);
    opacity: 0.62;
    pointer-events: none;
    transform: translate3d(0, 0, 0);
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
