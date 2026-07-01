import type { Tool, ToolHost, PointerInfo } from './Tool';
import { clamp } from '../types';
import {
  combineSelection,
  rectSelection,
  ellipseSelection,
  rowSelection,
  colSelection,
  selectionModeFromModifiers,
  type Selection,
  type SelectionMode,
} from '../selection';

/** Marquee — rectangular / elliptical / single-row / single-column (shape from options bar). */
export class MarqueeTool implements Tool {
  readonly id = 'marquee';
  readonly name = 'Marquee';
  readonly cursor = 'crosshair';

  private startX = 0;
  private startY = 0;
  private dragging = false;
  private baseSelection: Selection | null = null;
  private mode: SelectionMode = 'new';

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    const doc = this.host.doc;
    if (!doc) return;
    this.baseSelection = this.host.selection;
    this.mode = selectionModeFromModifiers(this.host.selectionMode, e);
    const shape = this.host.marqueeShape;
    if (shape === 'row') {
      this.host.setSelection(combineSelection(this.baseSelection, rowSelection(e.y, doc.width, doc.height), this.mode, doc.width, doc.height));
      return;
    }
    if (shape === 'column') {
      this.host.setSelection(combineSelection(this.baseSelection, colSelection(e.x, doc.width, doc.height), this.mode, doc.width, doc.height));
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
    if (e.shiftKey && this.mode === 'new' && !this.baseSelection) {
      const s = Math.max(rw, rh);
      rx = x < this.startX ? this.startX - s : this.startX;
      ry = y < this.startY ? this.startY - s : this.startY;
      rw = s;
      rh = s;
    }
    if (rw < 1 || rh < 1) {
      this.host.setSelection(this.mode === 'new' ? null : this.baseSelection);
      return;
    }
    const rect = { x: rx, y: ry, w: rw, h: rh };
    const sel =
      this.host.marqueeShape === 'ellipse'
        ? ellipseSelection(rect, doc.width, doc.height)
        : rectSelection(rect, doc.width, doc.height);
    this.host.setSelection(combineSelection(this.baseSelection, sel, this.mode, doc.width, doc.height));
  }

  pointerUp(): void {
    this.dragging = false;
    this.baseSelection = null;
  }
}
