<script lang="ts">
  import { onMount } from 'svelte';
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { Viewport } from '../engine/Viewport';
  import type { PointerInfo } from '../engine/tools/Tool';
  import TextEditorOverlay from './TextEditorOverlay.svelte';

  let canvasEl: HTMLCanvasElement;
  let containerEl: HTMLDivElement;
  let vp: Viewport | undefined;

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
    viewTick++;
  });

  let spaceDown = $state(false);
  let scrollW = $state(1);
  let scrollH = $state(1);
  let panning = false;
  let interacting = false;
  let syncingScroll = false;
  let last = { x: 0, y: 0 };
  const SCROLL_PAD = 80;

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
    requestAnimationFrame(() => (syncingScroll = false));
  }

  function syncViewportToScroll() {
    if (!vp || !containerEl || syncingScroll) return;
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
      vp!.resize();
      syncScrollToViewport();
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

  const cursorStyle = $derived(
    panning
      ? 'grabbing'
      : spaceDown
        ? 'grab'
        : editor.activeToolId === 'zoom'
          ? editor.effectiveZoomMode === 'out'
            ? 'zoom-out'
            : 'zoom-in'
          : editor.activeTool.cursor,
  );
</script>

<div class="viewport" bind:this={containerEl} onscroll={syncViewportToScroll}>
  <canvas
    bind:this={canvasEl}
    style="cursor:{cursorStyle}"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointerleave={onPointerLeave}
    oncontextmenu={(e) => e.preventDefault()}
  ></canvas>
  <div class="scroll-space" style:width={`${scrollW}px`} style:height={`${scrollH}px`}></div>
  {#if editor.textEdit && overlayBox}
    <TextEditorOverlay box={overlayBox} />
  {/if}
</div>

<style>
  .viewport {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow: auto;
    background: var(--bg-canvas);
  }
  canvas {
    position: sticky;
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
  }
</style>
