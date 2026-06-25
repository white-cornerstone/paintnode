import type { Tool, ToolHost, PointerInfo } from './Tool';
import type { Layer } from '../Layer.svelte';
import type { Rect } from '../types';
import { clampRect, createCanvas, ctx2d } from '../types';
import { pixelCommand, snapshotRegion } from '../history';

/**
 * Shared base for brush-style retouch tools (clone, smudge, blur, sharpen, dodge, burn, sponge).
 * It owns the stroke lifecycle — soft round dabs stamped along the pointer path with spacing,
 * selection clipping, and a single coalesced undo entry per stroke — and delegates the actual
 * per-dab pixel work to {@link applyDab}. Subclasses read brush size/hardness/opacity through the
 * `radius` / `hardness` / `strength` getters.
 */
export abstract class RetouchBrush implements Tool {
  abstract readonly id: string;
  abstract readonly name: string;
  readonly cursor = 'crosshair';
  readonly usesBrushCursor = true;
  readonly editsPixels = true;

  /** The layer being edited, available to subclasses during a stroke. */
  protected layer: Layer | null = null;
  /** A frozen copy of the layer's pixels at stroke start (clone source + undo "before"). */
  protected frozen: HTMLCanvasElement | null = null;
  protected frozenCtx: CanvasRenderingContext2D | null = null;
  /** Selection alpha in layer space (RGBA bytes), or null when nothing is selected. */
  private selData: Uint8ClampedArray | null = null;

  private painting = false;
  private last: { x: number; y: number } | null = null;
  private carry = 0;
  private dirty: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
  private stampCache: HTMLCanvasElement | null = null;

  constructor(protected host: ToolHost) {}

  protected get radius(): number {
    return Math.max(0.5, this.host.brushSize / 2);
  }
  protected get hardness(): number {
    return this.host.brushHardness;
  }
  protected get strength(): number {
    return this.host.brushOpacity;
  }

  /** Prepare per-stroke state (e.g. clone source). Return false to cancel the stroke. */
  protected onStart(_e: PointerInfo): boolean {
    return true;
  }
  /** Apply one soft dab centered at layer-space (lx, ly), mutating {@link layer}'s pixels. */
  protected abstract applyDab(lx: number, ly: number): void;

  pointerDown(e: PointerInfo): void {
    const layer = this.host.activeLayer;
    if (!layer) {
      this.host.flash('No active layer');
      return;
    }
    if (!layer.visible) {
      this.host.flash('Active layer is hidden');
      return;
    }
    this.layer = layer;
    this.frozen = createCanvas(layer.width, layer.height);
    this.frozenCtx = ctx2d(this.frozen);
    this.frozenCtx.drawImage(layer.canvas, 0, 0);
    this.selData = this.buildSelData(layer);
    this.stampCache = null;
    this.last = null;
    this.carry = 0;
    this.dirty = null;
    if (!this.onStart(e)) {
      this.reset();
      return;
    }
    this.painting = true;
    this.dab(e.x - layer.x, e.y - layer.y);
    this.last = { x: e.x - layer.x, y: e.y - layer.y };
    this.host.invalidate();
  }

  pointerMove(e: PointerInfo): void {
    if (!this.painting || !this.layer) return;
    const lx = e.x - this.layer.x;
    const ly = e.y - this.layer.y;
    if (!this.last) {
      this.dab(lx, ly);
      this.last = { x: lx, y: ly };
      this.host.invalidate();
      return;
    }
    const dx = lx - this.last.x;
    const dy = ly - this.last.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const spacing = Math.max(1, this.radius * 0.25);
    const ux = dx / dist;
    const uy = dy / dist;
    let d = this.carry;
    while (d <= dist) {
      this.dab(this.last.x + ux * d, this.last.y + uy * d);
      d += spacing;
    }
    this.carry = d - dist;
    this.last = { x: lx, y: ly };
    this.host.invalidate();
  }

  pointerUp(): void {
    if (!this.painting || !this.layer) {
      this.reset();
      return;
    }
    const layer = this.layer;
    const dirty = this.dirty;
    this.painting = false;
    if (dirty && this.frozenCtx) {
      const rect = clampRect(
        { x: dirty.minX, y: dirty.minY, w: dirty.maxX - dirty.minX, h: dirty.maxY - dirty.minY },
        layer.width,
        layer.height,
      );
      if (rect) {
        const before = {
          x: rect.x,
          y: rect.y,
          data: this.frozenCtx.getImageData(rect.x, rect.y, rect.w, rect.h),
        };
        const after = snapshotRegion(layer, rect);
        if (after) this.host.history.push(pixelCommand(layer, before, after, this.name));
      }
    }
    this.host.bump();
    this.host.invalidate();
    this.reset();
  }

  private reset(): void {
    this.layer = null;
    this.frozen = null;
    this.frozenCtx = null;
    this.selData = null;
    this.stampCache = null;
    this.last = null;
    this.carry = 0;
    this.dirty = null;
  }

  private dab(lx: number, ly: number): void {
    this.applyDab(lx, ly);
    const r = this.radius + 2;
    this.expand(lx - r, ly - r);
    this.expand(lx + r, ly + r);
  }
  private expand(x: number, y: number): void {
    if (!this.dirty) {
      this.dirty = { minX: x, minY: y, maxX: x, maxY: y };
      return;
    }
    if (x < this.dirty.minX) this.dirty.minX = x;
    if (y < this.dirty.minY) this.dirty.minY = y;
    if (x > this.dirty.maxX) this.dirty.maxX = x;
    if (y > this.dirty.maxY) this.dirty.maxY = y;
  }

  private buildSelData(layer: Layer): Uint8ClampedArray | null {
    const sel = this.host.selection;
    if (!sel) return null;
    const m = createCanvas(layer.width, layer.height);
    const c = ctx2d(m);
    c.drawImage(sel.mask, -layer.x, -layer.y);
    return c.getImageData(0, 0, layer.width, layer.height).data;
  }

  // --- Helpers for subclasses ---

  /** Diameter (px) of the current dab. */
  protected get diameter(): number {
    return Math.max(1, Math.round(this.radius * 2));
  }

  /**
   * Region + per-pixel weights for in-place tools (toning / focus). Each weight folds together
   * the soft radial falloff, the selection mask, and the brush strength. Returns null off-layer.
   */
  protected dabRegion(lx: number, ly: number): { rect: Rect; weights: Float32Array } | null {
    const layer = this.layer!;
    const r = this.radius;
    const rect = clampRect(
      { x: lx - r - 1, y: ly - r - 1, w: r * 2 + 2, h: r * 2 + 2 },
      layer.width,
      layer.height,
    );
    if (!rect) return null;
    const inner = r * this.hardness;
    const span = Math.max(0.001, r - inner);
    const weights = new Float32Array(rect.w * rect.h);
    const sel = this.selData;
    const lw = layer.width;
    for (let yy = 0; yy < rect.h; yy++) {
      for (let xx = 0; xx < rect.w; xx++) {
        const px = rect.x + xx;
        const py = rect.y + yy;
        const d = Math.hypot(px + 0.5 - lx, py + 0.5 - ly);
        let f = d <= inner ? 1 : d >= r ? 0 : 1 - (d - inner) / span;
        if (f <= 0) continue;
        if (sel) f *= sel[(py * lw + px) * 4 + 3] / 255;
        weights[yy * rect.w + xx] = f * this.strength;
      }
    }
    return { rect, weights };
  }

  /** Soft round stamp (white, alpha falloff), cached for the stroke. For composite tools. */
  protected getStamp(): HTMLCanvasElement {
    const d = this.diameter;
    if (this.stampCache && this.stampCache.width === d) return this.stampCache;
    const c = createCanvas(d, d);
    const ctx = ctx2d(c);
    const r = d / 2;
    const inner = r * this.hardness;
    if (this.hardness >= 0.99) {
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(r, r, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const g = ctx.createRadialGradient(r, r, Math.min(inner, r - 0.01), r, r, r);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(r, r, r, 0, Math.PI * 2);
      ctx.fill();
    }
    this.stampCache = c;
    return c;
  }

  /** Erase the parts of a layer-space stamp (top-left at sx,sy) that fall outside the selection. */
  protected clipSelection(stamp: HTMLCanvasElement, sx: number, sy: number): void {
    const sel = this.host.selection;
    if (!sel || !this.layer) return;
    const ctx = ctx2d(stamp);
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(sel.mask, -(sx + this.layer.x), -(sy + this.layer.y));
    ctx.restore();
  }
}
