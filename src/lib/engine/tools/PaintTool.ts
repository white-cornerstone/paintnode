import type { Tool, ToolHost, PointerInfo } from './Tool';
import { StrokeBuffer } from './stroke';
import { pixelCommand, snapshotRegion } from '../history';
import { rgbToCss } from '../color';
import { intersectMask } from '../selection';

/** Brush and Eraser. They differ only in composite op and stamp color. */
export class PaintTool implements Tool {
  readonly id: string;
  readonly name: string;
  readonly cursor = 'none';
  readonly usesBrushCursor = true;

  private host: ToolHost;
  private mode: 'brush' | 'eraser';
  private buffer: StrokeBuffer | null = null;
  private painting = false;
  private layerId: string | null = null;

  constructor(host: ToolHost, mode: 'brush' | 'eraser') {
    this.host = host;
    this.mode = mode;
    this.id = mode;
    this.name = mode === 'brush' ? 'Brush' : 'Eraser';
  }

  private get op(): 'source-over' | 'destination-out' {
    return this.mode === 'brush' ? 'source-over' : 'destination-out';
  }

  pointerDown(e: PointerInfo): void {
    const doc = this.host.doc;
    const layer = this.host.activeLayer;
    if (!doc || !layer) {
      this.host.flash('No active layer');
      return;
    }
    if (!layer.visible) {
      this.host.flash('Active layer is hidden');
      return;
    }
    if (!this.buffer) this.buffer = new StrokeBuffer(doc.width, doc.height);
    this.buffer.ensureSize(doc.width, doc.height);

    let solid = 'rgb(0,0,0)';
    let clear = 'rgba(0,0,0,0)';
    if (this.mode === 'brush') {
      const c = this.host.foreground;
      solid = rgbToCss(c, 1);
      clear = rgbToCss(c, 0);
    }
    this.buffer.begin(e.x, e.y, this.host.brushSize, this.host.brushHardness, solid, clear);
    this.painting = true;
    this.layerId = layer.id;
    this.host.setActiveStroke({
      layerId: layer.id,
      buffer: this.buffer.canvas,
      op: this.op,
      opacity: this.host.brushOpacity,
    });
    this.host.invalidate();
  }

  pointerMove(e: PointerInfo): void {
    if (!this.painting || !this.buffer) return;
    this.buffer.lineTo(e.x, e.y);
    this.host.invalidate();
  }

  pointerUp(): void {
    if (!this.painting || !this.buffer) {
      this.painting = false;
      return;
    }
    this.painting = false;
    const doc = this.host.doc;
    const layer = doc?.layers.find((l) => l.id === this.layerId) ?? null;
    const bbox = this.buffer.bbox();

    if (layer && bbox) {
      const localBox = { x: bbox.x - layer.x, y: bbox.y - layer.y, w: bbox.w, h: bbox.h };
      const before = snapshotRegion(layer, localBox);
      const sel = this.host.selection;
      const buf = sel ? intersectMask(this.buffer.canvas, sel.mask) : this.buffer.canvas;
      layer.ctx.save();
      layer.ctx.globalCompositeOperation = this.op;
      layer.ctx.globalAlpha = this.host.brushOpacity;
      layer.ctx.drawImage(buf, -layer.x, -layer.y);
      layer.ctx.restore();
      layer.touch();
      const after = snapshotRegion(layer, localBox);
      if (before && after) {
        this.host.history.push(pixelCommand(layer, before, after, this.name));
      }
    }

    this.host.setActiveStroke(null);
    this.host.bump();
    this.host.invalidate();
  }
}
