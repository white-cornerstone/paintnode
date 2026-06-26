<script lang="ts">
  import { onMount } from 'svelte';
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { openCommand } from '../state/commands';
  import { isDesktop } from '../integrations/desktop';
  import { Viewport } from '../engine/Viewport';
  import type { PointerInfo } from '../engine/tools/Tool';
  import Icon from './Icon.svelte';
  import TextEditorOverlay from './TextEditorOverlay.svelte';
  import {
    Add,
    AddFilled,
    ArrowMove,
    Eyedropper,
    EyedropperFilled,
    Hand,
    HandFilled,
    PaintBucket,
    PaintBucketFilled,
    TextT,
    ZoomIn,
    ZoomOut,
  } from '../icons';
  import { getCurrentWindow, type CursorIcon } from '@tauri-apps/api/window';

  let canvasEl: HTMLCanvasElement;
  let containerEl: HTMLDivElement;
  let vp: Viewport | undefined;
  const desktop = isDesktop();
  const appWindow = desktop ? getCurrentWindow() : null;

  // Bumped each render while editing text so the overlay tracks pan/zoom.
  let viewTick = $state(0);
  const overlayBox = $derived.by(() => {
    viewTick;
    const s = editor.textEdit;
    if (!s || !vp || !canvasEl) return null;
    const rect = canvasEl.getBoundingClientRect();
    const p = vp.docToScreen(s.model.x, s.model.y);
    return { left: rect.left + p.x, top: rect.top + p.y, scale: vp.scale };
  });
  // Recompute the overlay box immediately when an edit session starts/ends.
  $effect(() => {
    editor.textEdit;
    viewTick = performance.now();
  });

  let spaceDown = $state(false);
  let scrollW = $state(1);
  let scrollH = $state(1);
  let scrollLeftCss = $state(0);
  let scrollTopCss = $state(0);
  let pointerClientX = $state(0);
  let pointerClientY = $state(0);
  let panning = $state(false);
  let interacting = $state(false);
  let pointerInViewport = $state(false);
  let syncingScroll = false;
  let last = { x: 0, y: 0 };
  const SCROLL_PAD = 80;
  let resizeFrame = 0;
  let nativeCursor: { icon: CursorIcon; visible: boolean } | null = null;
  type ToolCursor =
    | 'move'
    | 'marquee'
    | 'lasso'
    | 'crop'
    | 'eyedropper'
    | 'fill'
    | 'gradient'
    | 'shape'
    | 'text'
    | 'hand-open'
    | 'hand-closed'
    | 'zoom-in'
    | 'zoom-out';

  function cursorIconFor(cssCursor: string): CursorIcon {
    switch (cssCursor) {
      case 'crosshair':
        return 'crosshair';
      case 'move':
        return 'move';
      case 'text':
        return 'text';
      case 'grab':
        return 'grab';
      case 'grabbing':
        return 'grabbing';
      case 'zoom-in':
        return 'zoomIn';
      case 'zoom-out':
        return 'zoomOut';
      default:
        return 'default';
    }
  }

  function setNativeCursor(cssCursor: string, active: boolean): void {
    if (!appWindow) return;
    if (cssCursor.startsWith('url(')) {
      if (nativeCursor?.visible === false) {
        nativeCursor = { icon: 'default', visible: true };
        void appWindow.setCursorVisible(true).catch(() => {
          nativeCursor = null;
        });
      }
      return;
    }
    const visible = active && cssCursor === 'none' ? false : true;
    const icon = active && visible ? cursorIconFor(cssCursor) : 'default';
    if (nativeCursor?.icon === icon && nativeCursor.visible === visible) return;
    nativeCursor = { icon, visible };
    void appWindow
      .setCursorVisible(visible)
      .then(() => appWindow.setCursorIcon(icon))
      .catch(() => {
        nativeCursor = null;
      });
  }

  function pos(e: PointerEvent) {
    const r = canvasEl.getBoundingClientRect();
    return { cssX: e.clientX - r.left, cssY: e.clientY - r.top };
  }

  function toInfo(
    e: PointerEvent,
    cssX: number,
    cssY: number,
    dxCss: number,
    dyCss: number,
  ): PointerInfo {
    const d = vp!.screenToDoc(cssX, cssY);
    const scale = vp!.scale;
    return {
      x: d.x,
      y: d.y,
      cssX,
      cssY,
      dxDoc: dxCss / scale,
      dyDoc: dyCss / scale,
      dxCss,
      dyCss,
      pressure: e.pressure || 0.5,
      buttons: e.buttons,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      event: e,
    };
  }

  function onPointerDown(e: PointerEvent) {
    if (!vp) return;
    pointerClientX = e.clientX;
    pointerClientY = e.clientY;
    // A click anywhere on the canvas commits the active text edit.
    if (editor.textEdit) {
      editor.commitActiveText();
      return;
    }
    // A pixel tool can't paint on a text layer — offer to rasterize it first.
    if (e.button === 0 && !spaceDown && editor.activeTool.editsPixels && editor.activeLayer?.kind === 'text') {
      editor.promptRasterize(editor.activeLayer);
      return;
    }
    try {
      canvasEl.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already-released pointer */
    }
    const { cssX, cssY } = pos(e);
    last = { x: cssX, y: cssY };
    if (spaceDown || e.button === 1) {
      panning = true;
      return;
    }
    if (e.button !== 0) return;
    interacting = true;
    editor.activeTool.pointerDown(toInfo(e, cssX, cssY, 0, 0));
  }

  function onPointerMove(e: PointerEvent) {
    if (!vp) return;
    pointerClientX = e.clientX;
    pointerClientY = e.clientY;
    const { cssX, cssY } = pos(e);
    const dxCss = cssX - last.x;
    const dyCss = cssY - last.y;
    const d = vp.screenToDoc(cssX, cssY);
    vp.cursor = { x: d.x, y: d.y };
    ui.cursor = { x: Math.floor(d.x), y: Math.floor(d.y) };

    if (panning) {
      vp.panBy(dxCss, dyCss);
      ui.zoom = vp.scale;
    } else if (interacting) {
      editor.activeTool.pointerMove(toInfo(e, cssX, cssY, dxCss, dyCss));
    } else if (vp.brushRadius > 0) {
      vp.invalidate();
    }
    last = { x: cssX, y: cssY };
  }

  function onPointerUp(e: PointerEvent) {
    if (!vp) return;
    pointerClientX = e.clientX;
    pointerClientY = e.clientY;
    try {
      canvasEl.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer may not be captured */
    }
    const { cssX, cssY } = pos(e);
    if (panning) {
      panning = false;
      return;
    }
    if (interacting) {
      editor.activeTool.pointerUp(toInfo(e, cssX, cssY, cssX - last.x, cssY - last.y));
      interacting = false;
    }
  }

  function onPointerLeave() {
    pointerInViewport = false;
    if (!vp) return;
    if (!interacting && !panning) {
      vp.cursor = null;
      ui.cursor = null;
      if (vp.brushRadius > 0) vp.invalidate();
    }
  }

  function isTyping(t: EventTarget | null) {
    const el = t as HTMLElement | null;
    return (
      !!el &&
      (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    );
  }

  function updateScrollSpace() {
    if (!vp || !containerEl) return;
    const doc = editor.doc;
    const docW = doc ? doc.width * vp.scale : 1;
    const docH = doc ? doc.height * vp.scale : 1;
    scrollW = Math.max(containerEl.clientWidth, Math.ceil(docW + SCROLL_PAD * 2));
    scrollH = Math.max(containerEl.clientHeight, Math.ceil(docH + SCROLL_PAD * 2));
  }

  function syncScrollToViewport() {
    if (!vp || !containerEl) return;
    updateScrollSpace();
    const maxLeft = Math.max(0, scrollW - containerEl.clientWidth);
    const maxTop = Math.max(0, scrollH - containerEl.clientHeight);
    const nextLeft = Math.max(0, Math.min(maxLeft, SCROLL_PAD - vp.offsetX));
    const nextTop = Math.max(0, Math.min(maxTop, SCROLL_PAD - vp.offsetY));
    syncingScroll = true;
    containerEl.scrollLeft = nextLeft;
    containerEl.scrollTop = nextTop;
    scrollLeftCss = nextLeft;
    scrollTopCss = nextTop;
    requestAnimationFrame(() => (syncingScroll = false));
  }

  function syncViewportToScroll() {
    if (!vp || !containerEl) return;
    scrollLeftCss = containerEl.scrollLeft;
    scrollTopCss = containerEl.scrollTop;
    if (syncingScroll) return;
    const doc = editor.doc;
    if (!doc) return;
    const docW = doc.width * vp.scale;
    const docH = doc.height * vp.scale;
    vp.offsetX = scrollW > containerEl.clientWidth ? SCROLL_PAD - containerEl.scrollLeft : (containerEl.clientWidth - docW) / 2;
    vp.offsetY = scrollH > containerEl.clientHeight ? SCROLL_PAD - containerEl.scrollTop : (containerEl.clientHeight - docH) / 2;
    vp.invalidate();
  }

  onMount(() => {
    vp = new Viewport(
      canvasEl,
      () => editor.doc,
      () => editor.getActiveStroke(),
      () => editor.getSelection(),
    );
    vp.onAfterRender = () => {
      ui.zoom = vp!.scale;
      syncScrollToViewport();
      if (editor.textEdit) viewTick++;
    };
    editor.viewport = vp;
    vp.resize();
    requestAnimationFrame(() => vp!.fitToView());

    const ro = new ResizeObserver(() => {
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        vp!.resize();
        syncScrollToViewport();
      });
    });
    ro.observe(containerEl);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = canvasEl.getBoundingClientRect();
        const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
        vp!.zoomBy(factor, e.clientX - r.left, e.clientY - r.top);
        ui.zoom = vp!.scale;
      } else {
        vp!.panBy(-e.deltaX, -e.deltaY);
      }
    };
    containerEl.addEventListener('wheel', onWheel, { passive: false });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e.target) && !spaceDown) {
        spaceDown = true;
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceDown = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      ro.disconnect();
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      containerEl.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      vp!.destroy();
      editor.viewport = null;
    };
  });

  // Recomposite when document structure / layer props / pixels change.
  $effect(() => {
    const doc = editor.doc;
    editor.rev;
    if (doc) {
      doc.layers;
      doc.activeLayerId;
      for (const l of doc.layers) {
        l.visible;
        l.opacity;
        l.blendMode;
        l.pixelRev;
      }
    }
    vp?.invalidateComposite();
    requestAnimationFrame(syncScrollToViewport);
  });

  // Animate the selection marching ants while a selection exists.
  $effect(() => {
    const sel = editor.selection;
    if (!sel || !vp) return;
    const id = setInterval(() => vp?.invalidate(), 120);
    return () => clearInterval(id);
  });

  // Update brush-cursor ring radius for paint tools.
  $effect(() => {
    const t = editor.activeTool;
    const size = editor.brushSize;
    if (!vp) return;
    vp.brushRadius = t.usesBrushCursor ? size / 2 : 0;
    vp.invalidate();
  });

  const overlayCursor = $derived.by(() => {
    if (!pointerInViewport) return null;
    if (panning || (editor.activeToolId === 'hand' && interacting)) return 'hand-closed';
    if (spaceDown || editor.activeToolId === 'hand') return 'hand-open';
    if (editor.activeToolId === 'zoom') return editor.effectiveZoomMode === 'out' ? 'zoom-out' : 'zoom-in';
    if (editor.activeToolId === 'move') return 'move';
    if (editor.activeToolId === 'marquee') return 'marquee';
    if (editor.activeToolId === 'lasso') return 'lasso';
    if (editor.activeToolId === 'crop') return 'crop';
    if (editor.activeToolId === 'eyedropper') return 'eyedropper';
    if (editor.activeToolId === 'fill') return 'fill';
    if (editor.activeToolId === 'gradient') return 'gradient';
    if (editor.activeToolId === 'shape') return 'shape';
    if (editor.activeToolId === 'text') return 'text';
    return null;
  });
  const cursorStyle = $derived(overlayCursor ? 'none' : editor.activeTool.cursor);
  const cursorPressed = $derived(!!overlayCursor && (interacting || panning));
  const cursorIcon = $derived.by(() => {
    switch (overlayCursor) {
      case 'move':
        return ArrowMove;
      case 'marquee':
      case 'lasso':
      case 'crop':
      case 'gradient':
      case 'shape':
        return cursorPressed ? AddFilled : Add;
      case 'eyedropper':
        return cursorPressed ? EyedropperFilled : Eyedropper;
      case 'fill':
        return cursorPressed ? PaintBucketFilled : PaintBucket;
      case 'text':
        return TextT;
      case 'hand-open':
      case 'hand-closed':
        return cursorPressed ? HandFilled : Hand;
      case 'zoom-in':
        return ZoomIn;
      case 'zoom-out':
        return ZoomOut;
      default:
        return null;
    }
  });
  const cursorIconSize = $derived(
    overlayCursor === 'marquee' ||
      overlayCursor === 'lasso' ||
      overlayCursor === 'crop' ||
      overlayCursor === 'gradient' ||
      overlayCursor === 'shape'
      ? 16
      : 19,
  );

  $effect(() => {
    setNativeCursor(cursorStyle, pointerInViewport);
  });
</script>

<div
  class="viewport"
  bind:this={containerEl}
  style="cursor:{cursorStyle}"
  role="presentation"
  onpointerenter={(e) => {
    pointerInViewport = true;
    pointerClientX = e.clientX;
    pointerClientY = e.clientY;
  }}
  onpointerleave={onPointerLeave}
  onscroll={syncViewportToScroll}
>
  <canvas
    bind:this={canvasEl}
    style="cursor:{cursorStyle}; transform:translate3d({scrollLeftCss}px, {scrollTopCss}px, 0)"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    oncontextmenu={(e) => e.preventDefault()}
  ></canvas>
  <div class="scroll-space" style:width={`${scrollW}px`} style:height={`${scrollH}px`}></div>
  {#if !editor.doc}
    <div class="empty-workspace">
      <div class="empty-title">No documents open</div>
      <div class="empty-actions">
        <button onclick={() => ui.open('new')}>New Document</button>
        <button onclick={() => void openCommand()}>Open</button>
      </div>
    </div>
  {/if}
  {#if editor.textEdit && overlayBox}
    <TextEditorOverlay box={overlayBox} />
  {/if}
</div>

{#if overlayCursor && cursorIcon}
  <div
    class={`tool-cursor ${overlayCursor}`}
    class:pressed={cursorPressed}
    style="left:{pointerClientX}px; top:{pointerClientY}px"
    aria-hidden="true"
  >
    <Icon svg={cursorIcon} size={cursorIconSize} />
  </div>
{/if}

<style>
  .viewport {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--bg-canvas);
  }
  canvas {
    position: absolute;
    top: 0;
    left: 0;
    z-index: 1;
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
  }
  .scroll-space {
    position: relative;
    z-index: 0;
    pointer-events: none;
    cursor: inherit;
  }
  .empty-workspace {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: grid;
    place-content: center;
    gap: 12px;
    color: var(--text-dim);
    pointer-events: none;
  }
  .empty-title {
    text-align: center;
    font-size: 13px;
    font-weight: 700;
  }
  .empty-actions {
    display: flex;
    justify-content: center;
    gap: 8px;
    pointer-events: auto;
  }
  .tool-cursor {
    position: fixed;
    z-index: 500;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    color: #050505;
    pointer-events: none;
    will-change: transform;
  }
  .tool-cursor :global(svg) {
    filter: drop-shadow(0 1px 0 #fff) drop-shadow(1px 0 0 #fff) drop-shadow(0 -1px 0 #fff)
      drop-shadow(-1px 0 0 #fff) drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
  }
  .tool-cursor.zoom-in,
  .tool-cursor.zoom-out,
  .tool-cursor.hand-open,
  .tool-cursor.hand-closed,
  .tool-cursor.move {
    transform: translate3d(-11px, -11px, 0);
  }
  .tool-cursor.marquee,
  .tool-cursor.shape,
  .tool-cursor.text {
    transform: translate3d(-3px, -3px, 0);
  }
  .tool-cursor.lasso,
  .tool-cursor.crop,
  .tool-cursor.eyedropper,
  .tool-cursor.gradient,
  .tool-cursor.fill {
    transform: translate3d(-5px, -5px, 0);
  }
</style>
