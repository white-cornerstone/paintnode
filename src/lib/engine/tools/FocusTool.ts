import type { ToolHost } from './Tool';
import { createCanvas, ctx2d } from '../types';
import { gaussianBlur, sharpen } from '../filters';
import { RetouchBrush } from './RetouchBrush';

/**
 * Focus tools — Blur softens, Sharpen adds local contrast. Each dab processes the region under
 * the brush (reusing the document filters) and blends the result toward the original by the soft
 * dab weight, so the effect builds up gradually with overlapping strokes.
 */
export class FocusTool extends RetouchBrush {
  readonly id: string;
  readonly name: string;

  constructor(host: ToolHost, private mode: 'blur' | 'sharpen') {
    super(host);
    this.id = mode;
    this.name = mode === 'blur' ? 'Blur' : 'Sharpen';
  }

  protected applyDab(lx: number, ly: number): void {
    const region = this.dabRegion(lx, ly);
    if (!region) return;
    const { rect, weights } = region;
    const layer = this.layer!;

    const src = createCanvas(rect.w, rect.h);
    ctx2d(src).putImageData(layer.ctx.getImageData(rect.x, rect.y, rect.w, rect.h), 0, 0);
    const processed =
      this.mode === 'blur'
        ? gaussianBlur(src, Math.max(1, this.radius * 0.35))
        : sharpen(src, 0.8);
    const pd = ctx2d(processed).getImageData(0, 0, rect.w, rect.h).data;

    const img = layer.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    const o = img.data;
    const temper = this.mode === 'sharpen' ? 0.6 : 1; // keep sharpen from amplifying noise
    for (let p = 0; p < weights.length; p++) {
      const w = Math.min(1, weights[p] * temper);
      if (w <= 0) continue;
      const i = p * 4;
      o[i] += (pd[i] - o[i]) * w;
      o[i + 1] += (pd[i + 1] - o[i + 1]) * w;
      o[i + 2] += (pd[i + 2] - o[i + 2]) * w;
    }
    layer.ctx.putImageData(img, rect.x, rect.y);
    layer.touch();
  }
}
