import type { Rect } from '../types';
import { createCanvas, ctx2d } from '../types';

/**
 * Accumulates a brush stroke into a full-document-size buffer by stamping soft/hard
 * round dabs along the pointer path with fixed spacing. The buffer holds the stroke at
 * full alpha; the caller composites it at the desired opacity so opacity is per-stroke.
 */
export class StrokeBuffer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private size = 10;
  private radius = 5;
  private hardness = 0.8;
  private spacing = 1;
  private colorSolid = 'rgb(0,0,0)';
  private colorClear = 'rgba(0,0,0,0)';
  private last: { x: number; y: number } | null = null;
  private carry = 0;
  private dirty = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

  constructor(width: number, height: number) {
    this.canvas = createCanvas(width, height);
    this.ctx = ctx2d(this.canvas);
  }

  ensureSize(width: number, height: number): void {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /**
   * @param solidCss color at full alpha for the stamp center
   * @param clearCss same color at zero alpha for the stamp edge (avoids dark halos)
   */
  begin(
    x: number,
    y: number,
    size: number,
    hardness: number,
    solidCss: string,
    clearCss: string,
  ): void {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.size = Math.max(1, size);
    this.radius = this.size / 2;
    this.hardness = Math.max(0, Math.min(1, hardness));
    this.spacing = Math.max(0.5, this.size * 0.12);
    this.colorSolid = solidCss;
    this.colorClear = clearCss;
    this.last = null;
    this.carry = 0;
    this.dirty = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    this.lineTo(x, y); // initial dab so a single click paints
  }

  /** Extend the stroke to a new point, stamping dabs along the segment. */
  lineTo(x: number, y: number): void {
    if (!this.last) {
      this.stamp(x, y);
      this.last = { x, y };
      return;
    }
    const dx = x - this.last.x;
    const dy = y - this.last.y;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;
    const ux = dx / dist;
    const uy = dy / dist;
    let d = this.carry;
    while (d <= dist) {
      this.stamp(this.last.x + ux * d, this.last.y + uy * d);
      d += this.spacing;
    }
    this.carry = d - dist;
    this.last = { x, y };
  }

  private stamp(x: number, y: number): void {
    const r = this.radius;
    const ctx = this.ctx;
    if (this.hardness >= 0.99) {
      ctx.fillStyle = this.colorSolid;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    } else {
      const inner = r * this.hardness;
      const grad = ctx.createRadialGradient(x, y, Math.min(inner, r - 0.01), x, y, r);
      grad.addColorStop(0, this.colorSolid);
      grad.addColorStop(1, this.colorClear);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    this.expand(x - r, y - r);
    this.expand(x + r, y + r);
  }

  private expand(x: number, y: number): void {
    if (x < this.dirty.minX) this.dirty.minX = x;
    if (y < this.dirty.minY) this.dirty.minY = y;
    if (x > this.dirty.maxX) this.dirty.maxX = x;
    if (y > this.dirty.maxY) this.dirty.maxY = y;
  }

  /** Bounding box of stamped area (document space), or null if nothing drawn. */
  bbox(): Rect | null {
    if (this.dirty.maxX < this.dirty.minX) return null;
    const pad = 2;
    return {
      x: this.dirty.minX - pad,
      y: this.dirty.minY - pad,
      w: this.dirty.maxX - this.dirty.minX + pad * 2,
      h: this.dirty.maxY - this.dirty.minY + pad * 2,
    };
  }
}
