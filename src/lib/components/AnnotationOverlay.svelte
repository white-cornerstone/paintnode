<script lang="ts">
  import type { AnnotationItem } from '../engine/annotations';
  import Icon from './Icon.svelte';
  import RoughAnnotationShape from './RoughAnnotationShape.svelte';
  import { tooltip } from '../actions/tooltip';
  import { Delete, FlipHorizontal, FlipVertical } from '../icons';

  type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

  type Interaction =
    | { kind: 'move'; id: string; pointerId: number; startClientX: number; startClientY: number; base: AnnotationItem }
    | {
      kind: 'resize';
      id: string;
      pointerId: number;
      handle: Handle;
      startClientX: number;
      startClientY: number;
      startPointerDoc: Point;
      base: AnnotationItem;
      center: Point;
    }
    | {
      kind: 'rotate';
      id: string;
      pointerId: number;
      startClientX: number;
      startClientY: number;
      startPointerDoc: Point;
      base: AnnotationItem;
      center: Point;
      startAngle: number;
    };

  interface Point {
    x: number;
    y: number;
  }

  let {
    annotations,
    visible,
    scale,
    revision = 0,
    selectedId,
    toScreen,
    onSelect,
    onUpdate,
    onDelete,
  }: {
    annotations: AnnotationItem[];
    visible: boolean;
    scale: number;
    revision?: number;
    selectedId: string | null;
    toScreen: (x: number, y: number) => { x: number; y: number };
    onSelect: (id: string | null) => void;
    onUpdate: (id: string, patch: Partial<Omit<AnnotationItem, 'id'>>) => void;
    onDelete: (id: string) => void;
  } = $props();

  let interaction = $state<Interaction | null>(null);

  const selectedItem = $derived(annotations.find((item) => item.id === selectedId && item.visible) ?? null);

  function centerOf(item: AnnotationItem): Point {
    return { x: item.x + item.width / 2, y: item.y + item.height / 2 };
  }

  function rotatePoint(point: Point, angle: number): Point {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { x: point.x * c - point.y * s, y: point.x * s + point.y * c };
  }

  function handleLocalPoint(item: AnnotationItem, handle: Handle): Point {
    const x = handle.includes('w') ? -item.width / 2 : handle.includes('e') ? item.width / 2 : 0;
    const y = handle.includes('n') ? -item.height / 2 : handle.includes('s') ? item.height / 2 : 0;
    return { x, y };
  }

  function localToDoc(center: Point, local: Point, rotation: number): Point {
    const rotated = rotatePoint(local, rotation);
    return { x: center.x + rotated.x, y: center.y + rotated.y };
  }

  function pointerDocFromInteraction(event: PointerEvent, active: Extract<Interaction, { startPointerDoc: Point }>): Point {
    return {
      x: active.startPointerDoc.x + (event.clientX - active.startClientX) / Math.max(0.001, scale),
      y: active.startPointerDoc.y + (event.clientY - active.startClientY) / Math.max(0.001, scale),
    };
  }

  function styleFor(item: AnnotationItem): string {
    revision;
    const p0 = toScreen(item.x, item.y);
    return [
      `--x:${p0.x}px`,
      `--y:${p0.y}px`,
      `--w:${Math.max(24, item.width * scale)}px`,
      `--h:${Math.max(20, item.height * scale)}px`,
      `--rot:${item.rotation}rad`,
      `--sx:${item.flipX ? -1 : 1}`,
      `--sy:${item.flipY ? -1 : 1}`,
      `--c:${item.color}`,
    ].join(';');
  }

  function startMove(event: PointerEvent, item: AnnotationItem): void {
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target?.closest('button')) return;
    event.stopPropagation();
    onSelect(item.id);
    interaction = {
      kind: 'move',
      id: item.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      base: { ...item },
    };
    (event.currentTarget as HTMLElement).focus();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function startResize(event: PointerEvent, item: AnnotationItem, handle: Handle): void {
    event.stopPropagation();
    event.preventDefault();
    onSelect(item.id);
    const center = centerOf(item);
    const handleDoc = localToDoc(center, handleLocalPoint(item, handle), item.rotation);
    interaction = {
      kind: 'resize',
      id: item.id,
      pointerId: event.pointerId,
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPointerDoc: handleDoc,
      base: { ...item },
      center,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function startRotate(event: PointerEvent, item: AnnotationItem): void {
    event.stopPropagation();
    event.preventDefault();
    onSelect(item.id);
    const center = centerOf(item);
    const handleDoc = localToDoc(center, { x: 0, y: -item.height / 2 - 34 / Math.max(0.001, scale) }, item.rotation);
    interaction = {
      kind: 'rotate',
      id: item.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPointerDoc: handleDoc,
      base: { ...item },
      center,
      startAngle: Math.atan2(handleDoc.y - center.y, handleDoc.x - center.x),
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function moveInteraction(event: PointerEvent): void {
    if (!interaction) return;
    event.stopPropagation();

    if (interaction.kind === 'move') {
      onUpdate(interaction.id, {
        x: Math.round(interaction.base.x + (event.clientX - interaction.startClientX) / Math.max(0.001, scale)),
        y: Math.round(interaction.base.y + (event.clientY - interaction.startClientY) / Math.max(0.001, scale)),
      });
      return;
    }

    if (interaction.kind === 'rotate') {
      const pointer = pointerDocFromInteraction(event, interaction);
      const angle = Math.atan2(pointer.y - interaction.center.y, pointer.x - interaction.center.x);
      let rotation = interaction.base.rotation + angle - interaction.startAngle;
      if (event.shiftKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
      onUpdate(interaction.id, { rotation });
      return;
    }

    const pointer = pointerDocFromInteraction(event, interaction);
    const rel = { x: pointer.x - interaction.center.x, y: pointer.y - interaction.center.y };
    const local = rotatePoint(rel, -interaction.base.rotation);
    let left = -interaction.base.width / 2;
    let right = interaction.base.width / 2;
    let top = -interaction.base.height / 2;
    let bottom = interaction.base.height / 2;

    if (interaction.handle.includes('w')) left = local.x;
    if (interaction.handle.includes('e')) right = local.x;
    if (interaction.handle.includes('n')) top = local.y;
    if (interaction.handle.includes('s')) bottom = local.y;

    const minW = interaction.base.kind === 'divider' ? 16 : 28;
    const minH = interaction.base.kind === 'arrow' || interaction.base.kind === 'divider' ? 18 : 24;
    if (right - left < minW) {
      if (interaction.handle.includes('w')) left = right - minW;
      else right = left + minW;
    }
    if (bottom - top < minH) {
      if (interaction.handle.includes('n')) top = bottom - minH;
      else bottom = top + minH;
    }

    const nextWidth = right - left;
    const nextHeight = bottom - top;
    const nextCenterLocal = { x: (left + right) / 2, y: (top + bottom) / 2 };
    const centerOffset = rotatePoint(nextCenterLocal, interaction.base.rotation);
    const nextCenter = {
      x: interaction.center.x + centerOffset.x,
      y: interaction.center.y + centerOffset.y,
    };
    onUpdate(interaction.id, {
      x: Math.round(nextCenter.x - nextWidth / 2),
      y: Math.round(nextCenter.y - nextHeight / 2),
      width: Math.round(nextWidth),
      height: Math.round(nextHeight),
    });
  }

  function endInteraction(event: PointerEvent): void {
    if (!interaction) return;
    event.stopPropagation();
    interaction = null;
  }

  function commitText(item: AnnotationItem, event: Event): void {
    const text = (event.currentTarget as HTMLElement).innerText.replace(/\s+/g, ' ').trim();
    onUpdate(item.id, { text });
  }

  function deleteSelected(item: AnnotationItem, event: Event): void {
    event.stopPropagation();
    interaction = null;
    onSelect(null);
    onDelete(item.id);
  }

  function keyObject(event: KeyboardEvent, item: AnnotationItem): void {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    if ((event.target as HTMLElement | null)?.isContentEditable) return;
    event.preventDefault();
    onSelect(null);
    onDelete(item.id);
  }
</script>

{#if visible}
  <div class="annotation-layer" aria-label="Annotation overlay">
    {#each annotations.filter((item) => item.visible) as item (item.id)}
      <div
        class="annotation-object"
        class:selected={selectedId === item.id}
        style={styleFor(item)}
        role="button"
        aria-label="Select annotation"
        tabindex="0"
        onpointerdown={(event) => startMove(event, item)}
        onpointermove={moveInteraction}
        onpointerup={endInteraction}
        onkeydown={(event) => keyObject(event, item)}
      >
        <div class="annotation-content {item.kind}">
          <RoughAnnotationShape {item} />
          {#if item.kind !== 'arrow' && item.kind !== 'divider'}
            <div class="annotation-text" contenteditable="true" role="textbox" onblur={(event) => commitText(item, event)}>{item.text}</div>
          {/if}
        </div>
        {#if selectedId === item.id}
          <div class="selection-frame" aria-hidden="true">
            {#each ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as handle}
              <button
                class="handle {handle}"
                aria-label="Resize annotation"
                onpointerdown={(event) => startResize(event, item, handle as Handle)}
              ></button>
            {/each}
            <button class="rotate-handle" aria-label="Rotate annotation" onpointerdown={(event) => startRotate(event, item)}></button>
          </div>
          <div class="object-actions">
            <button
              aria-label="Flip annotation horizontally"
              use:tooltip={{ text: 'Flip horizontal', placement: 'top' }}
              onclick={(event) => { event.stopPropagation(); onUpdate(item.id, { flipX: !item.flipX }); }}
            >
              <Icon svg={FlipHorizontal} size={10} />
            </button>
            <button
              aria-label="Flip annotation vertically"
              use:tooltip={{ text: 'Flip vertical', placement: 'top' }}
              onclick={(event) => { event.stopPropagation(); onUpdate(item.id, { flipY: !item.flipY }); }}
            >
              <Icon svg={FlipVertical} size={10} />
            </button>
            <button
              aria-label="Delete annotation"
              use:tooltip={{ text: 'Delete annotation', placement: 'top' }}
              onclick={(event) => deleteSelected(item, event)}
            >
              <Icon svg={Delete} size={10} />
            </button>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .annotation-layer {
    position: absolute;
    inset: 0;
    z-index: 5;
    pointer-events: none;
  }
  .annotation-object {
    position: absolute;
    left: var(--x);
    top: var(--y);
    width: var(--w);
    height: var(--h);
    pointer-events: auto;
    user-select: none;
    transform: rotate(var(--rot));
    transform-origin: 50% 50%;
    cursor: grab;
    outline: none;
  }
  .annotation-object:active {
    cursor: grabbing;
  }
  .annotation-content {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    transform: scale(var(--sx), var(--sy));
    transform-origin: 50% 50%;
  }
  .annotation-text {
    position: relative;
    z-index: 1;
    width: 100%;
    padding: 7px 12px;
    color: #111;
    text-align: center;
    font: 700 13px/1.25 system-ui, sans-serif;
    outline: none;
    cursor: text;
    white-space: pre-wrap;
  }
  .annotation-content.badge .annotation-text {
    padding-left: 26px;
    color: white;
  }
  .annotation-content.callout .annotation-text {
    align-self: start;
    height: calc(100% - 18px);
  }
  .selection-frame {
    position: absolute;
    inset: 0;
    border: 1px solid #60a5fa;
    pointer-events: none;
  }
  .handle,
  .rotate-handle,
  .object-actions button {
    display: grid;
    place-items: center;
    padding: 0;
    color: #111827;
  }
  .handle {
    position: absolute;
    width: 8px;
    height: 8px;
    border: 1px solid #111827;
    background: white;
    pointer-events: auto;
  }
  .handle.nw { left: -4px; top: -4px; cursor: nwse-resize; }
  .handle.n { left: calc(50% - 4px); top: -4px; cursor: ns-resize; }
  .handle.ne { right: -4px; top: -4px; cursor: nesw-resize; }
  .handle.e { right: -4px; top: calc(50% - 4px); cursor: ew-resize; }
  .handle.se { right: -4px; bottom: -4px; cursor: nwse-resize; }
  .handle.s { left: calc(50% - 4px); bottom: -4px; cursor: ns-resize; }
  .handle.sw { left: -4px; bottom: -4px; cursor: nesw-resize; }
  .handle.w { left: -4px; top: calc(50% - 4px); cursor: ew-resize; }
  .rotate-handle {
    position: absolute;
    left: calc(50% - 5px);
    top: -38px;
    width: 10px;
    height: 10px;
    border: 1px solid #166534;
    border-radius: 999px;
    background: #7ed957;
    pointer-events: auto;
    cursor: grab;
  }
  .rotate-handle::before {
    content: '';
    position: absolute;
    left: 4px;
    top: 9px;
    width: 1px;
    height: 28px;
    background: #60a5fa;
  }
  .object-actions {
    position: absolute;
    right: -8px;
    top: -28px;
    display: flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid rgba(0, 0, 0, 0.2);
    border-radius: 5px;
    background: rgba(245, 245, 245, 0.95);
    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.2);
    pointer-events: auto;
  }
  .object-actions button {
    width: 16px;
    height: 16px;
    border-radius: 4px;
    background: transparent;
  }
  .object-actions button:hover {
    background: rgba(0, 0, 0, 0.09);
  }
</style>
