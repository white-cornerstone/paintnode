import type { ToolHost } from './Tool';
import { RetouchBrush } from './RetouchBrush';

const LUMA_R = 0.299;
const LUMA_G = 0.587;
const LUMA_B = 0.114;

/**
 * Toning tools — Dodge lightens, Burn darkens, Sponge shifts saturation. Dodge/Burn weight the
 * effect by tonal range (shadows / midtones / highlights) so you can target, say, only the
 * highlights. All three accumulate gently with each soft dab; exposure/flow is the Opacity slider.
 */
export class ToningTool extends RetouchBrush {
  readonly id: string;
  readonly name: string;

  constructor(host: ToolHost, private mode: 'dodge' | 'burn' | 'sponge') {
    super(host);
    this.id = mode;
    this.name = mode === 'dodge' ? 'Dodge' : mode === 'burn' ? 'Burn' : 'Sponge';
  }

  /** Tonal-range weight for dodge/burn, from luminance L (0..1). */
  private rangeWeight(l: number): number {
    switch (this.host.toneRange) {
      case 'shadows':
        return 1 - l;
      case 'highlights':
        return l;
      default:
        return 1 - Math.abs(2 * l - 1); // midtones
    }
  }

  protected applyDab(lx: number, ly: number): void {
    const region = this.dabRegion(lx, ly);
    if (!region) return;
    const { rect, weights } = region;
    const layer = this.layer!;
    const img = layer.ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
    const d = img.data;
    const sponge = this.mode === 'sponge';
    const desaturate = this.host.spongeMode === 'desaturate';
    const sign = this.mode === 'burn' ? -1 : 1;

    for (let p = 0; p < weights.length; p++) {
      const w = weights[p];
      if (w <= 0) continue;
      const i = p * 4;
      if (d[i + 3] === 0) continue;
      const r = d[i];
      const g = d[i + 1];
      const b = d[i + 2];

      if (sponge) {
        const gray = LUMA_R * r + LUMA_G * g + LUMA_B * b;
        const k = (desaturate ? -1 : 1) * w * 0.5;
        d[i] = r + (r - gray) * k;
        d[i + 1] = g + (g - gray) * k;
        d[i + 2] = b + (b - gray) * k;
      } else {
        const l = (LUMA_R * r + LUMA_G * g + LUMA_B * b) / 255;
        const a = w * this.rangeWeight(l) * 0.5 * sign;
        if (a >= 0) {
          // dodge — push toward white
          d[i] = r + (255 - r) * a;
          d[i + 1] = g + (255 - g) * a;
          d[i + 2] = b + (255 - b) * a;
        } else {
          // burn — push toward black
          d[i] = r + r * a;
          d[i + 1] = g + g * a;
          d[i + 2] = b + b * a;
        }
      }
    }
    layer.ctx.putImageData(img, rect.x, rect.y);
    layer.touch();
  }
}
