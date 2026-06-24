import type { ToolHost, PointerInfo } from './Tool';
import { createCanvas, ctx2d } from '../types';
import { RetouchBrush } from './RetouchBrush';

/**
 * Clone Stamp — Alt-click to set a source point, then paint to copy pixels from that source
 * (offset by source→destination distance) onto the active layer. Source pixels are sampled from
 * a frozen snapshot taken at stroke start, so painting never smears into itself. "Aligned" keeps
 * the offset across separate strokes; unaligned re-anchors the source at each new stroke.
 */
export class CloneStampTool extends RetouchBrush {
  readonly id = 'clone';
  readonly name = 'Clone Stamp';

  /** Source anchor in document space (set with Alt-click). */
  private source: { x: number; y: number } | null = null;
  /** source − destination, in document space; established on the first painted dab. */
  private offset: { x: number; y: number } | null = null;

  constructor(host: ToolHost) {
    super(host);
  }

  protected onStart(e: PointerInfo): boolean {
    if (e.altKey) {
      this.source = { x: e.x, y: e.y };
      this.offset = null;
      this.host.flash('Clone source set');
      return false; // setting the source does not paint
    }
    if (!this.source) {
      this.host.flash('Alt-click to set a clone source first');
      return false;
    }
    if (!this.host.cloneAligned) this.offset = null; // re-anchor each stroke
    return true;
  }

  protected applyDab(lx: number, ly: number): void {
    const layer = this.layer!;
    const destX = lx + layer.x;
    const destY = ly + layer.y;
    if (!this.offset) this.offset = { x: this.source!.x - destX, y: this.source!.y - destY };

    const r = this.radius;
    const d = this.diameter;
    const srcCx = destX + this.offset.x;
    const srcCy = destY + this.offset.y;

    const stamp = createCanvas(d, d);
    const sctx = ctx2d(stamp);
    // Sample the frozen layer pixels around the source, into the stamp.
    sctx.drawImage(this.frozen!, -(srcCx - layer.x - r), -(srcCy - layer.y - r));
    // Shape it with the soft round mask.
    sctx.globalCompositeOperation = 'destination-in';
    sctx.drawImage(this.getStamp(), 0, 0);
    sctx.globalCompositeOperation = 'source-over';
    this.clipSelection(stamp, lx - r, ly - r);

    const ctx = layer.ctx;
    ctx.save();
    ctx.globalAlpha = this.strength;
    ctx.drawImage(stamp, lx - r, ly - r);
    ctx.restore();
    layer.touch();
  }
}
