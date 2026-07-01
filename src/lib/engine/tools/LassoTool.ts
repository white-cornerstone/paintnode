import type { Tool, ToolHost, PointerInfo } from './Tool';
import { clamp } from '../types';
import {
  combineSelection,
  lassoSelection,
  selectionModeFromModifiers,
  type Point,
  type Selection,
  type SelectionMode,
} from '../selection';

/** Freeform lasso — drag to trace a selection outline; released to close the shape. */
export class LassoTool implements Tool {
  readonly id = 'lasso';
  readonly name = 'Lasso';
  readonly cursor = 'crosshair';

  private points: Point[] = [];
  private drawing = false;
  private baseSelection: Selection | null = null;
  private mode: SelectionMode = 'new';

  constructor(private host: ToolHost) {}

  private add(e: PointerInfo): void {
    const doc = this.host.doc!;
    this.points.push({ x: clamp(e.x, 0, doc.width), y: clamp(e.y, 0, doc.height) });
  }

  pointerDown(e: PointerInfo): void {
    if (!this.host.doc) return;
    this.drawing = true;
    this.baseSelection = this.host.selection;
    this.mode = selectionModeFromModifiers(this.host.selectionMode, e);
    this.points = [];
    this.add(e);
  }

  pointerMove(e: PointerInfo): void {
    if (!this.drawing || !this.host.doc) return;
    this.add(e);
    // Throttle live preview rebuilds (each rebuilds a doc-size mask).
    if (this.points.length >= 3 && this.points.length % 3 === 0) {
      const hit = lassoSelection(this.points, this.host.doc.width, this.host.doc.height);
      this.host.setSelection(combineSelection(this.baseSelection, hit, this.mode, this.host.doc.width, this.host.doc.height));
    }
  }

  pointerUp(): void {
    if (!this.drawing) return;
    this.drawing = false;
    const doc = this.host.doc;
    if (!doc) return;
    const hit = this.points.length >= 3 ? lassoSelection(this.points, doc.width, doc.height) : null;
    this.host.setSelection(combineSelection(this.baseSelection, hit, this.mode, doc.width, doc.height));
    this.points = [];
    this.baseSelection = null;
  }
}
