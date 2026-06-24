import type { Tool, ToolHost, PointerInfo } from './Tool';
import { clamp } from '../types';
import { rectSelection, ellipseSelection, rowSelection, colSelection } from '../selection';

/** Marquee — rectangular / elliptical / single-row / single-column (shape from options bar). */
export class MarqueeTool implements Tool {
  readonly id = 'marquee';
  readonly name = 'Marquee';
  readonly cursor = 'crosshair';

  private startX = 0;
  private startY = 0;
  private dragging = false;

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    const doc = this.host.doc;
    if (!doc) return;
    const shape = this.host.marqueeShape;
    if (shape === 'row') {
      this.host.setSelection(rowSelection(e.y, doc.width, doc.height));
      return;
    }
    if (shape === 'column') {
      this.host.setSelection(colSelection(e.x, doc.width, doc.height));
      return;
    }
    this.startX = clamp(e.x, 0, doc.width);
    this.startY = clamp(e.y, 0, doc.height);
    this.dragging = true;
  }

  pointerMove(e: PointerInfo): void {
    if (!this.dragging) return;
    const doc = this.host.doc;
    if (!doc) return;
    const x = clamp(e.x, 0, doc.width);
    const y = clamp(e.y, 0, doc.height);
    let rx = Math.min(this.startX, x);
    let ry = Math.min(this.startY, y);
    let rw = Math.abs(x - this.startX);
    let rh = Math.abs(y - this.startY);
    if (e.shiftKey) {
      const s = Math.max(rw, rh);
      rx = x < this.startX ? this.startX - s : this.startX;
      ry = y < this.startY ? this.startY - s : this.startY;
      rw = s;
      rh = s;
    }
    if (rw < 1 || rh < 1) {
      this.host.setSelection(null);
      return;
    }
    const rect = { x: rx, y: ry, w: rw, h: rh };
    const sel =
      this.host.marqueeShape === 'ellipse'
        ? ellipseSelection(rect, doc.width, doc.height)
        : rectSelection(rect, doc.width, doc.height);
    this.host.setSelection(sel);
  }

  pointerUp(): void {
    this.dragging = false;
  }
}
