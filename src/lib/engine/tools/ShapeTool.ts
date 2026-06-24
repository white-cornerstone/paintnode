import type { Tool, ToolHost, PointerInfo } from './Tool';
import type { Rect } from '../types';
import { createCanvas, ctx2d } from '../types';
import { rgbToCss } from '../color';
import { bakeBuffer } from './bake';

/** Rectangle / ellipse / line shapes (drag to size; Shift constrains). Uses foreground color. */
export class ShapeTool implements Tool {
  readonly id = 'shape';
  readonly name = 'Shape';
  readonly cursor = 'crosshair';

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
    bakeBuffer(this.host, this.layerId, this.buffer, 'Shape', 'source-over', 1, this.bbox());
    this.host.setActiveStroke(null);
    this.host.invalidate();
  }

  private bbox(): Rect {
    const pad = this.host.shapeStrokeWidth + 2;
    return {
      x: Math.min(this.sx, this.cx) - pad,
      y: Math.min(this.sy, this.cy) - pad,
      w: Math.abs(this.cx - this.sx) + pad * 2,
      h: Math.abs(this.cy - this.sy) + pad * 2,
    };
  }

  private render(shift: boolean): void {
    const ctx = this.bctx!;
    const b = this.buffer!;
    ctx.clearRect(0, 0, b.width, b.height);
    const color = rgbToCss(this.host.foreground, 1);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = this.host.shapeStrokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    let x0 = this.sx;
    let y0 = this.sy;
    let x1 = this.cx;
    let y1 = this.cy;

    if (this.host.shapeType === 'line') {
      if (shift) {
        const ang = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x1 - x0, y1 - y0);
        x1 = x0 + Math.cos(ang) * len;
        y1 = y0 + Math.sin(ang) * len;
      }
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    } else {
      let w = x1 - x0;
      let h = y1 - y0;
      if (shift) {
        const s = Math.max(Math.abs(w), Math.abs(h));
        w = Math.sign(w || 1) * s;
        h = Math.sign(h || 1) * s;
      }
      const rx = Math.min(x0, x0 + w);
      const ry = Math.min(y0, y0 + h);
      const rw = Math.abs(w);
      const rh = Math.abs(h);
      if (this.host.shapeType === 'rect') {
        if (this.host.shapeFill) ctx.fillRect(rx, ry, rw, rh);
        else ctx.strokeRect(rx, ry, rw, rh);
      } else {
        ctx.beginPath();
        ctx.ellipse(rx + rw / 2, ry + rh / 2, rw / 2, rh / 2, 0, 0, Math.PI * 2);
        if (this.host.shapeFill) ctx.fill();
        else ctx.stroke();
      }
    }
    ctx.restore();
  }
}
