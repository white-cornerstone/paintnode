import type { Tool, ToolHost, PointerInfo } from './Tool';
import { clamp } from '../types';
import { rectSelection } from '../selection';

/**
 * Crop — drag a rectangle to define the crop box (shown as marching ants), then commit it
 * from the options bar ("Apply") or by pressing Enter. The actual crop reuses the editor's
 * selection-aware crop so it shares one undo path. Esc clears the box.
 */
export class CropTool implements Tool {
  readonly id = 'crop';
  readonly name = 'Crop';
  readonly cursor = 'crosshair';

  private sx = 0;
  private sy = 0;
  private dragging = false;

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    const doc = this.host.doc;
    if (!doc) return;
    this.sx = clamp(e.x, 0, doc.width);
    this.sy = clamp(e.y, 0, doc.height);
    this.dragging = true;
  }

  pointerMove(e: PointerInfo): void {
    if (!this.dragging) return;
    const doc = this.host.doc;
    if (!doc) return;
    const x = clamp(e.x, 0, doc.width);
    const y = clamp(e.y, 0, doc.height);
    const rx = Math.min(this.sx, x);
    const ry = Math.min(this.sy, y);
    const rw = Math.abs(x - this.sx);
    const rh = Math.abs(y - this.sy);
    if (rw < 1 || rh < 1) {
      this.host.setSelection(null);
      return;
    }
    this.host.setSelection(rectSelection({ x: rx, y: ry, w: rw, h: rh }, doc.width, doc.height));
  }

  pointerUp(): void {
    this.dragging = false;
  }
}
