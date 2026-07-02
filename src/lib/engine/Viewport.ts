import type { PaintDocument } from './Document.svelte';
import type { ActiveStroke } from './compositor';
import type { AiRetouchPreview } from './aiRetouch';
import type { Selection } from './selection';
import { compositeLayers } from './compositor';
import { clamp, createCanvas, ctx2d } from './types';
import { clampViewportOffset } from './viewportBounds';

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;

const CANVAS_BG = '#4a4a4a';

function buildChecker(): HTMLCanvasElement {
  const size = 16;
  const c = createCanvas(size, size);
  const ctx = ctx2d(c);
  ctx.fillStyle = '#ededed';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#c4c4c4';
  ctx.fillRect(0, 0, size / 2, size / 2);
  ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
  return c;
}

/**
 * Owns the visible viewport canvas and the doc->screen transform (pan + zoom).
 * Rendering is coalesced through requestAnimationFrame via `invalidate()`.
 */
export class Viewport {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  dpr = 1;

  scale = 1;
  offsetX = 0; // doc origin x, in CSS px from canvas top-left
  offsetY = 0;

  /** Brush cursor preview, in document coordinates (null = hidden). */
  cursor: { x: number; y: number } | null = null;
  brushRadius = 0; // doc px; 0 hides the preview ring

  private getDoc: () => PaintDocument | null;
  private getStroke: () => ActiveStroke | null;
  private getSelection: () => Selection | null;
  private getRetouchPreview: () => AiRetouchPreview | null;
  private getShowTransparencyChecker: () => boolean;
  private dashOffset = 0;
  private scratch: HTMLCanvasElement;
  private retouchScratch: HTMLCanvasElement;
  private composited: HTMLCanvasElement;
  private compositeDirty = true;
  private checker: CanvasPattern | null = null;
  private checkerSrc: HTMLCanvasElement;
  private rafId = 0;
  onAfterRender?: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    getDoc: () => PaintDocument | null,
    getStroke: () => ActiveStroke | null,
    getSelection: () => Selection | null,
    getRetouchPreview: () => AiRetouchPreview | null = () => null,
    getShowTransparencyChecker: () => boolean = () => true,
  ) {
    this.canvas = canvas;
    this.ctx = ctx2d(canvas, { alpha: false });
    this.getDoc = getDoc;
    this.getStroke = getStroke;
    this.getSelection = getSelection;
    this.getRetouchPreview = getRetouchPreview;
    this.getShowTransparencyChecker = getShowTransparencyChecker;
    this.scratch = createCanvas(1, 1);
    this.retouchScratch = createCanvas(1, 1);
    this.composited = createCanvas(1, 1);
    this.checkerSrc = buildChecker();
  }

  resize(options: { cssWidth?: number; cssHeight?: number; renderNow?: boolean } = {}): void {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = options.cssWidth ?? this.canvas.clientWidth;
    const cssHeight = options.cssHeight ?? this.canvas.clientHeight;
    const w = Math.max(1, Math.floor(cssWidth * dpr));
    const h = Math.max(1, Math.floor(cssHeight * dpr));
    this.dpr = dpr;
    let changed = false;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      changed = true;
    }
    this.clampPan();
    if (options.renderNow && changed) {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = 0;
      this.render();
      return;
    }
    this.invalidate();
  }

  invalidate(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.render();
    });
  }

  /** Mark the cached composite stale (call when layer pixels/props change). */
  invalidateComposite(): void {
    this.compositeDirty = true;
    this.invalidate();
  }

  destroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  // --- Coordinate transforms (CSS px <-> document px) ---

  screenToDoc(cssX: number, cssY: number): { x: number; y: number } {
    return {
      x: (cssX - this.offsetX) / this.scale,
      y: (cssY - this.offsetY) / this.scale,
    };
  }

  docToScreen(x: number, y: number): { x: number; y: number } {
    return { x: x * this.scale + this.offsetX, y: y * this.scale + this.offsetY };
  }

  get viewWidthCss(): number {
    return this.canvas.clientWidth;
  }
  get viewHeightCss(): number {
    return this.canvas.clientHeight;
  }

  setZoom(scale: number, centerCssX?: number, centerCssY?: number): void {
    const next = clamp(scale, MIN_ZOOM, MAX_ZOOM);
    const cx = centerCssX ?? this.viewWidthCss / 2;
    const cy = centerCssY ?? this.viewHeightCss / 2;
    const before = this.screenToDoc(cx, cy);
    this.scale = next;
    this.offsetX = cx - before.x * next;
    this.offsetY = cy - before.y * next;
    this.clampPan();
    this.invalidate();
  }

  zoomBy(factor: number, centerCssX?: number, centerCssY?: number): void {
    this.setZoom(this.scale * factor, centerCssX, centerCssY);
  }

  panBy(dxCss: number, dyCss: number): void {
    this.setPan(this.offsetX + dxCss, this.offsetY + dyCss);
  }

  setPan(offsetX: number, offsetY: number): void {
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.clampPan();
    this.invalidate();
  }

  fitToView(padding = 40): void {
    const doc = this.getDoc();
    if (!doc) return;
    const vw = this.viewWidthCss - padding * 2;
    const vh = this.viewHeightCss - padding * 2;
    const scale = clamp(Math.min(vw / doc.width, vh / doc.height), MIN_ZOOM, MAX_ZOOM);
    this.scale = scale;
    this.offsetX = (this.viewWidthCss - doc.width * scale) / 2;
    this.offsetY = (this.viewHeightCss - doc.height * scale) / 2;
    this.clampPan();
    this.invalidate();
  }

  center(): void {
    const doc = this.getDoc();
    if (!doc) return;
    this.offsetX = (this.viewWidthCss - doc.width * this.scale) / 2;
    this.offsetY = (this.viewHeightCss - doc.height * this.scale) / 2;
    this.clampPan();
    this.invalidate();
  }

  private clampPan(): void {
    const doc = this.getDoc();
    if (!doc) return;
    this.offsetX = clampViewportOffset(this.offsetX, this.viewWidthCss, doc.width * this.scale);
    this.offsetY = clampViewportOffset(this.offsetY, this.viewHeightCss, doc.height * this.scale);
  }

  render(): void {
    const { ctx, canvas, dpr } = this;
    const W = canvas.width;
    const H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = CANVAS_BG;
    ctx.fillRect(0, 0, W, H);

    const doc = this.getDoc();
    if (!doc) return;

    const sx = this.offsetX * dpr;
    const sy = this.offsetY * dpr;
    const sw = doc.width * this.scale * dpr;
    const sh = doc.height * this.scale * dpr;

    // Drop shadow behind the artboard.
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = 16 * dpr;
    ctx.shadowOffsetY = 3 * dpr;
    ctx.fillStyle = '#000';
    ctx.fillRect(sx, sy, sw, sh);
    ctx.restore();

    // Transparency checkerboard (fixed size in screen space).
    if (this.getShowTransparencyChecker() && !this.checker) this.checker = ctx.createPattern(this.checkerSrc, 'repeat');
    if (this.getShowTransparencyChecker() && this.checker) {
      ctx.save();
      ctx.translate(sx, sy);
      ctx.fillStyle = this.checker;
      ctx.fillRect(0, 0, sw, sh);
      ctx.restore();
    }

    // Rebuild the cached flattened composite only when dirty or mid-stroke; pan/zoom/hover
    // reuse the cache so they never re-flatten the layer stack.
    const stroke = this.getStroke();
    if (this.composited.width !== doc.width || this.composited.height !== doc.height) {
      this.composited.width = doc.width;
      this.composited.height = doc.height;
      this.compositeDirty = true;
    }
    if (this.scratch.width !== doc.width || this.scratch.height !== doc.height) {
      this.scratch.width = doc.width;
      this.scratch.height = doc.height;
    }
    if (this.compositeDirty || stroke) {
      const cctx = ctx2d(this.composited);
      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.clearRect(0, 0, doc.width, doc.height);
      compositeLayers(cctx, doc, stroke, this.scratch, this.getSelection());
      if (!stroke) this.compositeDirty = false;
    }
    ctx.save();
    ctx.setTransform(this.scale * dpr, 0, 0, this.scale * dpr, sx, sy);
    ctx.imageSmoothingEnabled = this.scale < 1;
    ctx.drawImage(this.composited, 0, 0);
    ctx.restore();

    const drawRetouchOverlay = (mask: HTMLCanvasElement, alpha = 0.48) => {
      if (this.retouchScratch.width !== doc.width || this.retouchScratch.height !== doc.height) {
        this.retouchScratch.width = doc.width;
        this.retouchScratch.height = doc.height;
      }
      const rctx = ctx2d(this.retouchScratch);
      rctx.setTransform(1, 0, 0, 1, 0, 0);
      rctx.globalCompositeOperation = 'source-over';
      rctx.globalAlpha = 1;
      rctx.clearRect(0, 0, doc.width, doc.height);
      rctx.fillStyle = `rgba(60, 255, 145, ${alpha})`;
      rctx.fillRect(0, 0, doc.width, doc.height);
      rctx.globalCompositeOperation = 'destination-in';
      rctx.drawImage(mask, 0, 0, doc.width, doc.height);
      rctx.globalCompositeOperation = 'source-over';
      ctx.save();
      ctx.setTransform(this.scale * dpr, 0, 0, this.scale * dpr, sx, sy);
      ctx.drawImage(this.retouchScratch, 0, 0);
      ctx.restore();
    };

    for (const layer of doc.layers) {
      if (layer.kind !== 'ai-retouch-mask' || !layer.visible || layer.opacity <= 0) continue;
      const linkedParent = doc.linkedParentFor(layer);
      if (linkedParent && !linkedParent.visible) continue;
      if (linkedParent && !linkedParent.maskEnabled) continue;
      drawRetouchOverlay(layer.canvas, 0.42 * layer.opacity);
    }

    const retouch = this.getRetouchPreview();
    if (retouch) {
      drawRetouchOverlay(retouch.mask, 0.5);
    }

    // Artboard border.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
    ctx.restore();

    // Selection marching ants — stroke the outline path (any shape) in screen space.
    const sel = this.getSelection();
    if (sel) {
      this.dashOffset = (this.dashOffset + 1) % 10000;
      const S = this.scale * dpr;
      const dash = 5 / S;
      ctx.save();
      ctx.setTransform(S, 0, 0, S, sx, sy);
      ctx.lineWidth = 1.4 / S;
      ctx.setLineDash([dash, dash]);
      ctx.lineDashOffset = this.dashOffset / S;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.stroke(sel.outline);
      ctx.lineDashOffset = this.dashOffset / S + dash;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.stroke(sel.outline);
      ctx.setLineDash([]);
      ctx.restore();
    }

    // Brush cursor preview ring.
    if (this.cursor && this.brushRadius > 0) {
      const r = this.brushRadius * this.scale * dpr;
      const c = this.docToScreen(this.cursor.x, this.cursor.y);
      const px = c.x * dpr;
      const py = c.y * dpr;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.beginPath();
      ctx.arc(px, py, r + 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    this.onAfterRender?.();
  }
}
