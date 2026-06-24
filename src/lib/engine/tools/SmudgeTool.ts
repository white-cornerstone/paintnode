import { createCanvas, ctx2d } from '../types';
import { RetouchBrush } from './RetouchBrush';

/**
 * Smudge — push pixels along the drag, as if dragging a finger through wet paint. Works by
 * carrying the footprint under the brush forward: each dab stamps the previously sampled patch
 * at the new position (at `strength` opacity), then re-samples there. Strength comes from the
 * Opacity slider (higher = longer smears).
 */
export class SmudgeTool extends RetouchBrush {
  readonly id = 'smudge';
  readonly name = 'Smudge';

  /** The patch picked up under the brush, carried to the next dab. */
  private sample: HTMLCanvasElement | null = null;

  protected onStart(): boolean {
    this.sample = null;
    return true;
  }

  protected applyDab(lx: number, ly: number): void {
    const layer = this.layer!;
    const r = this.radius;
    const d = this.diameter;

    if (!this.sample) {
      // First dab just picks up the footprint — nothing to smear yet.
      this.sample = createCanvas(d, d);
      ctx2d(this.sample).drawImage(layer.canvas, -(lx - r), -(ly - r));
      return;
    }

    const stamp = createCanvas(d, d);
    const sctx = ctx2d(stamp);
    sctx.drawImage(this.sample, 0, 0);
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

    // Re-sample at the new position (now blended with what we just laid down).
    const next = createCanvas(d, d);
    ctx2d(next).drawImage(layer.canvas, -(lx - r), -(ly - r));
    this.sample = next;
  }
}
