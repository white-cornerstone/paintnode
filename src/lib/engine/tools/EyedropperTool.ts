import type { Tool, ToolHost, PointerInfo } from './Tool';
import { compositeToCanvas } from '../compositor';
import { clamp, ctx2d } from '../types';

/** Eyedropper — sample the merged image color into the foreground swatch. */
export class EyedropperTool implements Tool {
  readonly id = 'eyedropper';
  readonly name = 'Eyedropper';
  readonly cursor = 'crosshair';

  private sampleCtx: CanvasRenderingContext2D | null = null;
  private w = 0;
  private h = 0;

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    const doc = this.host.doc;
    if (!doc) return;
    // Cache a flattened snapshot for the duration of the drag.
    const flat = compositeToCanvas(doc);
    this.sampleCtx = ctx2d(flat);
    this.w = flat.width;
    this.h = flat.height;
    this.pick(e);
  }

  pointerMove(e: PointerInfo): void {
    if (e.buttons) this.pick(e);
  }

  pointerUp(): void {
    this.sampleCtx = null;
  }

  private pick(e: PointerInfo): void {
    if (!this.sampleCtx) return;
    const x = clamp(Math.floor(e.x), 0, this.w - 1);
    const y = clamp(Math.floor(e.y), 0, this.h - 1);
    const d = this.sampleCtx.getImageData(x, y, 1, 1).data;
    this.host.setForeground({ r: d[0], g: d[1], b: d[2] });
    this.host.bump();
  }
}
