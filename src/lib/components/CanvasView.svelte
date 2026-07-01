<script lang="ts">
  import { onMount } from 'svelte';
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { openCommand, openDocumentFiles } from '../state/commands';
  import { filesFromDataTransfer, hasFileDrag } from '../io';
  import { workflow } from '../state/workflow.svelte';
  import { Viewport } from '../engine/Viewport';
  import { wheelZoomFactor } from '../engine/zoomGesture';
  import type { PointerInfo } from '../engine/tools/Tool';
  import TextEditorOverlay from './TextEditorOverlay.svelte';
  import AnnotationOverlay from './AnnotationOverlay.svelte';
  import { annotationFromDrag, type AnnotationItem } from '../engine/annotations';

  let canvasEl: HTMLCanvasElement;
  let containerEl: HTMLDivElement;
  let vp = $state<Viewport | undefined>();
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
  let canvasCssW = $state(1);
  let canvasCssH = $state(1);
  let viewportFrame = $state(0);
  let panning = $state(false);
  let interacting = $state(false);
  let dragOverEmpty = $state(false);
  let annotationDraft = $state<AnnotationItem | null>(null);
  let annotationDragStart: { x: number; y: number } | null = null;
  type TransformHandle = 'move' | 'rotate' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
  type TransformDrag = {
    handle: TransformHandle;
    startDocX: number;
    startDocY: number;
    startCenterX: number;
    startCenterY: number;
    startScaleX: number;
    startScaleY: number;
    startRotation: number;
    startAngle: number;
  };
  let transformDrag: TransformDrag | null = null;
  let syncingScroll = false;
  let last = { x: 0, y: 0 };
  const SCROLL_PAD = 80;
  const RESIZE_SETTLE_MS = 90;
  let resizeFrame = 0;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

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
    if (editor.freeTransform) return;
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
    if (editor.activeToolId === 'annotation') {
      const info = toInfo(e, cssX, cssY, 0, 0);
      annotationDragStart = { x: info.x, y: info.y };
      annotationDraft = annotationFromDrag({
        kind: editor.annotationType,
        text: editor.annotationText,
        start: annotationDragStart,
        end: { x: info.x, y: info.y },
        color: editor.foregroundCss,
      });
      interacting = true;
      return;
    }
    interacting = true;
    editor.activeTool.pointerDown(toInfo(e, cssX, cssY, 0, 0));
  }

  function onPointerMove(e: PointerEvent) {
    if (!vp) return;
    if (editor.freeTransform) return;
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
      if (annotationDraft) {
        const info = toInfo(e, cssX, cssY, dxCss, dyCss);
        annotationDraft = annotationFromDrag({
          kind: annotationDraft.kind,
          text: annotationDraft.text,
          start: annotationDragStart ?? { x: annotationDraft.x, y: annotationDraft.y },
          end: { x: info.x, y: info.y },
          color: annotationDraft.color,
          id: annotationDraft.id,
        });
      } else {
        editor.activeTool.pointerMove(toInfo(e, cssX, cssY, dxCss, dyCss));
      }
    } else if (vp.brushRadius > 0) {
      vp.invalidate();
    }
    last = { x: cssX, y: cssY };
  }

  function onPointerUp(e: PointerEvent) {
    if (!vp) return;
    if (editor.freeTransform) return;
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
      if (annotationDraft) {
        editor.addAnnotation(annotationDraft.kind, annotationDraft.x, annotationDraft.y, annotationDraft.width, annotationDraft.height, annotationDraft.text, {
          rotation: annotationDraft.rotation,
          flipX: annotationDraft.flipX,
          flipY: annotationDraft.flipY,
          color: annotationDraft.color,
        });
        annotationDraft = null;
        annotationDragStart = null;
      } else {
        editor.activeTool.pointerUp(toInfo(e, cssX, cssY, cssX - last.x, cssY - last.y));
      }
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

  function viewportSize(): { width: number; height: number } {
    return {
      width: Math.max(1, containerEl?.clientWidth ?? 1),
      height: Math.max(1, containerEl?.clientHeight ?? 1),
    };
  }

  function resizeViewport(renderNow = false): void {
    if (!vp) return;
    const size = viewportSize();
    canvasCssW = size.width;
    canvasCssH = size.height;
    vp.resize({ cssWidth: size.width, cssHeight: size.height, renderNow });
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

  function docFromClient(event: PointerEvent): { x: number; y: number } {
    const rect = canvasEl.getBoundingClientRect();
    return vp!.screenToDoc(event.clientX - rect.left, event.clientY - rect.top);
  }

  function screenPoint(x: number, y: number): { x: number; y: number } {
    viewportFrame;
    const p = vp!.docToScreen(x, y);
    return { x: scrollLeftCss + p.x, y: scrollTopCss + p.y };
  }

  function freeTransformCorner(dx: number, dy: number): { x: number; y: number } | null {
    const t = editor.freeTransform;
    if (!t || !vp) return null;
    const cos = Math.cos(t.rotation);
    const sin = Math.sin(t.rotation);
    const x = t.centerX + dx * t.scaleX * cos - dy * t.scaleY * sin;
    const y = t.centerY + dx * t.scaleX * sin + dy * t.scaleY * cos;
    return screenPoint(x, y);
  }

  function freeTransformPoints(): Record<Exclude<TransformHandle, 'move' | 'rotate'>, { x: number; y: number }> | null {
    const t = editor.freeTransform;
    if (!t || !vp) return null;
    const hw = t.sourceWidth / 2;
    const hh = t.sourceHeight / 2;
    const nw = freeTransformCorner(-hw, -hh);
    const n = freeTransformCorner(0, -hh);
    const ne = freeTransformCorner(hw, -hh);
    const e = freeTransformCorner(hw, 0);
    const se = freeTransformCorner(hw, hh);
    const s = freeTransformCorner(0, hh);
    const sw = freeTransformCorner(-hw, hh);
    const w = freeTransformCorner(-hw, 0);
    if (!nw || !n || !ne || !e || !se || !s || !sw || !w) return null;
    return { nw, n, ne, e, se, s, sw, w };
  }

  function freeTransformPreviewStyle(): string {
    const t = editor.freeTransform;
    if (!t || !vp) return '';
    const p = screenPoint(t.centerX, t.centerY);
    return [
      `left:${p.x}px`,
      `top:${p.y}px`,
      `width:${t.sourceWidth * t.scaleX * vp.scale}px`,
      `height:${t.sourceHeight * t.scaleY * vp.scale}px`,
      `opacity:${t.opacity}`,
      `transform:translate(-50%, -50%) rotate(${t.rotation}rad)`,
    ].join(';');
  }

  function rotateHandlePoint(): { x: number; y: number } | null {
    const pts = freeTransformPoints();
    const t = editor.freeTransform;
    if (!pts || !t || !vp) return null;
    const dx = Math.cos(t.rotation - Math.PI / 2) * 34;
    const dy = Math.sin(t.rotation - Math.PI / 2) * 34;
    return { x: pts.n.x + dx, y: pts.n.y + dy };
  }

  function canvasEdgeStyle(): string {
    const doc = editor.doc;
    if (!doc || !vp) return '';
    const topLeft = screenPoint(0, 0);
    const bottomRight = screenPoint(doc.width, doc.height);
    return [
      `left:${topLeft.x}px`,
      `top:${topLeft.y}px`,
      `width:${bottomRight.x - topLeft.x}px`,
      `height:${bottomRight.y - topLeft.y}px`,
    ].join(';');
  }

  function updateTransformDrag(event: PointerEvent): void {
    const t = editor.freeTransform;
    if (!t || !transformDrag || !vp) return;
    const point = docFromClient(event);
    const start = transformDrag;
    if (start.handle === 'move') {
      editor.updateFreeTransform({
        centerX: start.startCenterX + point.x - start.startDocX,
        centerY: start.startCenterY + point.y - start.startDocY,
      });
      return;
    }

    if (start.handle === 'rotate') {
      const angle = Math.atan2(point.y - start.startCenterY, point.x - start.startCenterX);
      let rotation = start.startRotation + angle - start.startAngle;
      if (event.shiftKey) rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
      editor.updateFreeTransform({ rotation });
      return;
    }

    const cos = Math.cos(-start.startRotation);
    const sin = Math.sin(-start.startRotation);
    const dx = point.x - start.startCenterX;
    const dy = point.y - start.startCenterY;
    const localX = dx * cos - dy * sin;
    const localY = dx * sin + dy * cos;
    const hw = Math.max(1, t.sourceWidth / 2);
    const hh = Math.max(1, t.sourceHeight / 2);
    const hasX = start.handle.includes('e') || start.handle.includes('w');
    const hasY = start.handle.includes('n') || start.handle.includes('s');
    let scaleX = start.startScaleX;
    let scaleY = start.startScaleY;
    if (hasX) scaleX = Math.max(0.02, Math.abs(localX) / hw);
    if (hasY) scaleY = Math.max(0.02, Math.abs(localY) / hh);
    if (hasX && hasY && !event.shiftKey) {
      const uniform = Math.max(scaleX, scaleY);
      scaleX = uniform;
      scaleY = uniform;
    }
    editor.updateFreeTransform({ scaleX, scaleY });
  }

  function startTransformDrag(event: PointerEvent, handle: TransformHandle): void {
    const t = editor.freeTransform;
    if (!t || !vp) return;
    event.preventDefault();
    event.stopPropagation();
    const point = docFromClient(event);
    transformDrag = {
      handle,
      startDocX: point.x,
      startDocY: point.y,
      startCenterX: t.centerX,
      startCenterY: t.centerY,
      startScaleX: t.scaleX,
      startScaleY: t.scaleY,
      startRotation: t.rotation,
      startAngle: Math.atan2(point.y - t.centerY, point.x - t.centerX),
    };
    const move = (next: PointerEvent) => updateTransformDrag(next);
    const up = () => {
      transformDrag = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onWorkspaceDragOver(e: DragEvent): void {
    if (editor.doc || !hasFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    dragOverEmpty = true;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  }

  function onWorkspaceDragLeave(e: DragEvent): void {
    if (e.currentTarget !== containerEl) return;
    const next = e.relatedTarget as Node | null;
    if (next && containerEl.contains(next)) return;
    dragOverEmpty = false;
  }

  async function onWorkspaceDrop(e: DragEvent): Promise<void> {
    if (editor.doc) return;
    e.preventDefault();
    dragOverEmpty = false;
    const files = filesFromDataTransfer(e.dataTransfer);
    if (files.length) await openDocumentFiles(files);
  }

  onMount(() => {
    vp = new Viewport(
      canvasEl,
      () => editor.doc,
      () => editor.getActiveStroke(),
      () => editor.getSelection(),
    );
    vp.onAfterRender = () => {
      viewportFrame += 1;
      ui.zoom = vp!.scale;
      syncScrollToViewport();
      if (editor.textEdit) viewTick++;
    };
    editor.viewport = vp;
    resizeViewport(true);
    requestAnimationFrame(() => vp!.fitToView());

    const commitResize = () => {
      resizeFrame = 0;
      resizeViewport(true);
      syncScrollToViewport();
    };
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = undefined;
        if (resizeFrame) cancelAnimationFrame(resizeFrame);
        resizeFrame = requestAnimationFrame(commitResize);
      }, RESIZE_SETTLE_MS);
    });
    ro.observe(containerEl);

    let lastDpr = window.devicePixelRatio || 1;
    const onWindowResize = () => {
      const nextDpr = window.devicePixelRatio || 1;
      if (nextDpr === lastDpr) return;
      lastDpr = nextDpr;
      if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = undefined;
      }
      if (resizeFrame) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        resizeViewport(true);
        syncScrollToViewport();
      });
    };
    window.addEventListener('resize', onWindowResize);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const r = canvasEl.getBoundingClientRect();
        const factor = wheelZoomFactor(e.deltaY, e.deltaMode);
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
      if (resizeTimer) clearTimeout(resizeTimer);
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      window.removeEventListener('resize', onWindowResize);
      containerEl.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      vp!.destroy();
      vp!.onAfterRender = undefined;
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
    const doc = editor.doc;
    const t = editor.activeTool;
    const size = editor.brushSize;
    if (!vp) return;
    vp.brushRadius = doc && t.usesBrushCursor ? size / 2 : 0;
    vp.invalidate();
  });

  const cursorStyle = $derived.by(() => {
    if (!editor.doc) return 'default';
    if (panning || (editor.activeToolId === 'hand' && interacting)) return 'grabbing';
    if (spaceDown || editor.activeToolId === 'hand') return 'grab';
    if (editor.activeToolId === 'zoom') return editor.effectiveZoomMode === 'out' ? 'zoom-out' : 'zoom-in';
    return editor.activeTool.cursor;
  });
</script>

<div
  class="viewport"
  bind:this={containerEl}
  style="cursor:{cursorStyle}"
  role="presentation"
  onpointerleave={onPointerLeave}
  ondragenter={onWorkspaceDragOver}
  ondragover={onWorkspaceDragOver}
  ondragleave={onWorkspaceDragLeave}
  ondrop={onWorkspaceDrop}
  onscroll={syncViewportToScroll}
>
  <canvas
    bind:this={canvasEl}
    style="width:{canvasCssW}px; height:{canvasCssH}px; cursor:{cursorStyle}; transform:translate3d({scrollLeftCss}px, {scrollTopCss}px, 0)"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    oncontextmenu={(e) => e.preventDefault()}
  ></canvas>
  {#if editor.doc && vp}
    <AnnotationOverlay
      annotations={[...editor.doc.annotations, ...(annotationDraft ? [annotationDraft] : [])]}
      visible={editor.doc.annotationsVisible}
      scale={vp.scale}
      revision={viewportFrame}
      selectedId={editor.selectedAnnotationId}
      toScreen={(x, y) => {
        const p = vp!.docToScreen(x, y);
        return { x: scrollLeftCss + p.x, y: scrollTopCss + p.y };
      }}
      onSelect={(id) => editor.selectAnnotation(id)}
      onUpdate={(id, patch) => editor.updateAnnotation(id, patch)}
      onDelete={(id) => editor.deleteAnnotation(id)}
    />
  {/if}
  {#if editor.freeTransform && vp}
    {@const transformPoints = freeTransformPoints()}
    {@const rotatePoint = rotateHandlePoint()}
    {#if transformPoints && rotatePoint}
      <img class="transform-preview" src={editor.freeTransform.previewUrl} alt="" style={freeTransformPreviewStyle()} />
      <svg class="transform-lines" aria-hidden="true">
        <polygon
          class="transform-hit"
          role="button"
          tabindex="-1"
          aria-label="Move transformed layer"
          points={`${transformPoints.nw.x},${transformPoints.nw.y} ${transformPoints.ne.x},${transformPoints.ne.y} ${transformPoints.se.x},${transformPoints.se.y} ${transformPoints.sw.x},${transformPoints.sw.y}`}
          onpointerdown={(event) => startTransformDrag(event, 'move')}
        />
        <polyline
          points={`${transformPoints.nw.x},${transformPoints.nw.y} ${transformPoints.ne.x},${transformPoints.ne.y} ${transformPoints.se.x},${transformPoints.se.y} ${transformPoints.sw.x},${transformPoints.sw.y} ${transformPoints.nw.x},${transformPoints.nw.y}`}
        />
        <line x1={transformPoints.n.x} y1={transformPoints.n.y} x2={rotatePoint.x} y2={rotatePoint.y} />
      </svg>
      {#each Object.entries(transformPoints) as [handle, point] (handle)}
        <button
          class={`transform-handle ${handle}`}
          style={`left:${point.x}px; top:${point.y}px`}
          aria-label={`Scale ${handle}`}
          onpointerdown={(event) => startTransformDrag(event, handle as TransformHandle)}
        ></button>
      {/each}
      <button
        class="transform-handle rotate"
        style={`left:${rotatePoint.x}px; top:${rotatePoint.y}px`}
        aria-label="Rotate layer"
        onpointerdown={(event) => startTransformDrag(event, 'rotate')}
      ></button>
      <div class="canvas-edge-overlay" style={canvasEdgeStyle()} aria-hidden="true"></div>
    {/if}
  {/if}
  <div class="scroll-space" style:width={`${scrollW}px`} style:height={`${scrollH}px`}></div>
  {#if !editor.doc}
    <div class="empty-workspace" class:dragover={dragOverEmpty}>
      <div class="empty-list" aria-label="No documents open">
        <button type="button" class="empty-action" onclick={() => ui.open('new')}>
          <span>New Document</span>
          <kbd>⌘N</kbd>
        </button>
        <button type="button" class="empty-action" onclick={() => void openCommand()}>
          <span>Open File</span>
          <kbd>⌘O</kbd>
        </button>
        <button type="button" class="empty-action" onclick={() => workflow.newBoard()}>
          <span>New Workflow Board</span>
        </button>
        <div class="empty-drop">Drop image or .ora files here to open them</div>
      </div>
    </div>
  {/if}
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
    position: absolute;
    top: 0;
    left: 0;
    z-index: 1;
    display: block;
    touch-action: none;
  }
  .scroll-space {
    position: relative;
    z-index: 0;
    pointer-events: none;
    cursor: inherit;
  }
  .transform-preview {
    position: absolute;
    z-index: 3;
    display: block;
    transform-origin: center;
    image-rendering: auto;
    pointer-events: none;
  }
  .transform-lines {
    position: absolute;
    inset: 0;
    z-index: 4;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .transform-lines polyline,
  .transform-lines line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.25;
    vector-effect: non-scaling-stroke;
  }
  .transform-hit {
    fill: transparent;
    pointer-events: fill;
    cursor: move;
  }
  .transform-handle {
    position: absolute;
    z-index: 5;
    width: 10px;
    height: 10px;
    padding: 0;
    background: var(--bg-panel);
    border: 1.5px solid var(--accent);
    border-radius: 1px;
    transform: translate(-50%, -50%);
  }
  .transform-handle:hover,
  .transform-handle:focus-visible {
    background: var(--accent);
    border-color: var(--text-bright);
  }
  .transform-handle.n,
  .transform-handle.s {
    cursor: ns-resize;
  }
  .transform-handle.e,
  .transform-handle.w {
    cursor: ew-resize;
  }
  .transform-handle.nw,
  .transform-handle.se {
    cursor: nwse-resize;
  }
  .transform-handle.ne,
  .transform-handle.sw {
    cursor: nesw-resize;
  }
  .transform-handle.rotate {
    width: 12px;
    height: 12px;
    border-radius: 999px;
    cursor: grab;
  }
  .canvas-edge-overlay {
    position: absolute;
    z-index: 6;
    box-sizing: border-box;
    border: 1px solid #000;
    pointer-events: none;
  }
  .empty-workspace {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: grid;
    place-content: center;
    color: var(--text-dim);
    pointer-events: auto;
  }
  .empty-list {
    width: min(320px, calc(100vw - 72px));
  }
  .empty-action {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 24px;
    align-items: baseline;
    width: 100%;
    min-height: 28px;
    padding: 2px 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text);
    text-align: left;
    font-size: 13px;
    line-height: 1.35;
  }
  .empty-action:hover,
  .empty-action:focus-visible {
    background: transparent;
    color: #fff;
  }
  .empty-action:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 3px;
  }
  .empty-action kbd {
    font: inherit;
    color: var(--text-dim);
  }
  .empty-drop {
    margin-top: 8px;
    padding-top: 6px;
    font-size: 13px;
    line-height: 1.35;
    color: var(--text-dim);
  }
  .empty-workspace.dragover .empty-drop {
    color: var(--accent);
  }
</style>
