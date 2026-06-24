import type { Tool, ToolHost, PointerInfo } from './Tool';
import {
  magicWandSelection,
  addToSelection,
  subtractFromSelection,
  type Selection,
} from '../selection';

/**
 * Magic Wand — click to select pixels matching the clicked color (active layer).
 * Shift adds to the current selection, Alt subtracts. Tolerance and contiguous mode
 * come from the options bar (tolerance is shared with the Bucket Fill tool).
 */
export class MagicWandTool implements Tool {
  readonly id = 'magicwand';
  readonly name = 'Magic Wand';
  readonly cursor = 'crosshair';

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    const doc = this.host.doc;
    const layer = this.host.activeLayer;
    if (!doc || !layer) {
      this.host.flash('No active layer');
      return;
    }
    const lx = Math.round(e.x - layer.x);
    const ly = Math.round(e.y - layer.y);
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) return;

    const img = layer.ctx.getImageData(0, 0, layer.width, layer.height);
    const hit = magicWandSelection(
      img,
      lx,
      ly,
      this.host.tolerance,
      this.host.magicContiguous,
      layer.x,
      layer.y,
      doc.width,
      doc.height,
    );
    if (!hit) return;

    let next: Selection | null = hit;
    if (e.shiftKey) next = addToSelection(this.host.selection, hit, doc.width, doc.height);
    else if (e.altKey) next = subtractFromSelection(this.host.selection, hit, doc.width, doc.height);
    this.host.setSelection(next);
  }

  pointerMove(): void {}
  pointerUp(): void {}
}
