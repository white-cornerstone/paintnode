import type { Tool, ToolHost, PointerInfo } from './Tool';
import { floodFill } from '../floodfill';
import { pixelCommand, snapshotRegion } from '../history';
import { clampRect, createCanvas, ctx2d } from '../types';

/** Bucket fill — flood the contiguous region under the cursor with the foreground color. */
export class FillTool implements Tool {
  readonly id = 'fill';
  readonly name = 'Bucket Fill';
  readonly cursor = 'crosshair';
  readonly editsPixels = true;

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    const layer = this.host.activeLayer;
    if (!layer) {
      this.host.flash('No active layer');
      return;
    }
    if (!layer.visible) {
      this.host.flash('Active layer is hidden');
      return;
    }
    const lx = Math.round(e.x - layer.x);
    const ly = Math.round(e.y - layer.y);
    if (lx < 0 || ly < 0 || lx >= layer.width || ly >= layer.height) return;

    const img = layer.ctx.getImageData(0, 0, layer.width, layer.height);
    const sel = this.host.selection;
    let inSel: ((x: number, y: number) => boolean) | undefined;
    if (sel) {
      const w = layer.width;
      const mask = createCanvas(layer.width, layer.height);
      ctx2d(mask).drawImage(sel.mask, -layer.x, -layer.y);
      const md = ctx2d(mask).getImageData(0, 0, w, layer.height).data;
      inSel = (x, y) => md[(y * w + x) * 4 + 3] > 127;
    }
    const rect = floodFill(img, lx, ly, this.host.foreground, this.host.tolerance, inSel);
    if (!rect) return;
    const cr = clampRect(rect, layer.width, layer.height);
    if (!cr) return;

    const before = snapshotRegion(layer, cr);
    layer.ctx.putImageData(img, 0, 0, cr.x, cr.y, cr.w, cr.h);
    layer.touch();
    const after = snapshotRegion(layer, cr);
    if (before && after) {
      this.host.history.push(pixelCommand(layer, before, after, 'Bucket Fill'));
    }
    this.host.bump();
    this.host.invalidate();
  }

  pointerMove(): void {}
  pointerUp(): void {}
}
