import type { BlendMode, Rect } from './types';
import { createCanvas, ctx2d, uid } from './types';

/**
 * A single raster layer. Metadata fields are reactive ($state) so the UI updates
 * automatically; pixel data lives in `canvas` and is mutated imperatively by tools.
 */
export class Layer {
  readonly id: string;
  name = $state('Layer');
  opacity = $state(1); // 0..1
  visible = $state(true);
  blendMode = $state<BlendMode>('source-over');
  /** Bumped whenever pixels change, so reactive thumbnails can refresh. */
  pixelRev = $state(0);

  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  constructor(width: number, height: number, name = 'Layer', id?: string) {
    this.id = id ?? uid('layer');
    this.name = name;
    this.canvas = createCanvas(width, height);
    this.ctx = ctx2d(this.canvas);
  }

  get width(): number {
    return this.canvas.width;
  }
  get height(): number {
    return this.canvas.height;
  }

  /** Mark pixels dirty (call after drawing into `ctx`). */
  touch(): void {
    this.pixelRev++;
  }

  clear(rect?: Rect): void {
    if (rect) this.ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    else this.ctx.clearRect(0, 0, this.width, this.height);
    this.touch();
  }

  fill(style: string): void {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = style;
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.restore();
    this.touch();
  }

  /** Deep copy (new id), used by "Duplicate Layer". */
  clone(newName?: string): Layer {
    const copy = new Layer(this.width, this.height, newName ?? `${this.name} copy`);
    copy.opacity = this.opacity;
    copy.visible = this.visible;
    copy.blendMode = this.blendMode;
    copy.ctx.drawImage(this.canvas, 0, 0);
    copy.touch();
    return copy;
  }
}
