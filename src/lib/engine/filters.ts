import { createCanvas, ctx2d } from './types';

/** Gaussian blur via the native canvas filter; returns a new full-size canvas. */
export function gaussianBlur(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const out = createCanvas(src.width, src.height);
  const c = ctx2d(out);
  c.filter = `blur(${Math.max(0, radius)}px)`;
  c.drawImage(src, 0, 0);
  c.filter = 'none';
  return out;
}

/** 3×3 sharpen convolution (`amount` ~0–3); returns a new full-size canvas. */
export function sharpen(src: HTMLCanvasElement, amount: number): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const input = ctx2d(src).getImageData(0, 0, w, h);
  const out = createCanvas(w, h);
  const octx = ctx2d(out);
  const output = octx.createImageData(w, h);
  const s = input.data;
  const o = output.data;
  const a = amount;
  const center = 1 + 4 * a;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const left = (y * w + Math.max(0, x - 1)) * 4;
      const right = (y * w + Math.min(w - 1, x + 1)) * 4;
      const up = (Math.max(0, y - 1) * w + x) * 4;
      const down = (Math.min(h - 1, y + 1) * w + x) * 4;
      for (let k = 0; k < 3; k++) {
        const v = s[i + k] * center - a * (s[left + k] + s[right + k] + s[up + k] + s[down + k]);
        o[i + k] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      o[i + 3] = s[i + 3];
    }
  }
  octx.putImageData(output, 0, 0);
  return out;
}
