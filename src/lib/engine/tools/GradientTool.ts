import type { Tool, ToolHost, PointerInfo } from './Tool';
import { createCanvas, ctx2d } from '../types';
import { rgbToCss } from '../color';
import { bakeBuffer } from './bake';

/** Linear gradient — drag to set direction. Foreground→Background or Foreground→Transparent. */
export class GradientTool implements Tool {
  readonly id = 'gradient';
  readonly name = 'Gradient';
  readonly cursor = 'crosshair';
  readonly editsPixels = true;

  private buffer: HTMLCanvasElement | null = null;
  private bctx: CanvasRenderingContext2D | null = null;
  private drawing = false;
  private layerId: string | null = null;
  private sx = 0;
  private sy = 0;
  private cx = 0;
  private cy = 0;

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    const doc = this.host.doc;
    const layer = this.host.activeLayer;
    if (!doc || !layer || !layer.visible) {
      this.host.flash('No active layer');
      return;
    }
    if (!this.buffer) {
      this.buffer = createCanvas(doc.width, doc.height);
      this.bctx = ctx2d(this.buffer);
    }
    if (this.buffer.width !== doc.width || this.buffer.height !== doc.height) {
      this.buffer.width = doc.width;
      this.buffer.height = doc.height;
    }
    this.drawing = true;
    this.layerId = layer.id;
    this.sx = this.cx = e.x;
    this.sy = this.cy = e.y;
    this.render(e.shiftKey);
    this.host.setActiveStroke({ layerId: layer.id, buffer: this.buffer, op: 'source-over', opacity: 1 });
  }

  pointerMove(e: PointerInfo): void {
    if (!this.drawing) return;
    this.cx = e.x;
    this.cy = e.y;
    this.render(e.shiftKey);
    this.host.invalidate();
  }

  pointerUp(): void {
    if (!this.drawing || !this.buffer || !this.layerId) {
      this.drawing = false;
      return;
    }
    this.drawing = false;
    bakeBuffer(this.host, this.layerId, this.buffer, 'Gradient', 'source-over', 1, null);
    this.host.setActiveStroke(null);
    this.host.invalidate();
  }

  private render(shift: boolean): void {
    const ctx = this.bctx!;
    const b = this.buffer!;
    ctx.clearRect(0, 0, b.width, b.height);
    let x1 = this.cx;
    let y1 = this.cy;
    if (shift) {
      const ang = Math.round(Math.atan2(y1 - this.sy, x1 - this.sx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(x1 - this.sx, y1 - this.sy);
      x1 = this.sx + Math.cos(ang) * len;
      y1 = this.sy + Math.sin(ang) * len;
    }
    const g = ctx.createLinearGradient(this.sx, this.sy, x1, y1);
    g.addColorStop(0, rgbToCss(this.host.foreground, 1));
    if (this.host.gradientType === 'fg-transparent') {
      g.addColorStop(1, rgbToCss(this.host.foreground, 0));
    } else {
      g.addColorStop(1, rgbToCss(this.host.background, 1));
    }
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, b.width, b.height);
  }
}
