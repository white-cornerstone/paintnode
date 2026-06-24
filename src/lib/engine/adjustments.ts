// Per-pixel image adjustments. Each returns/​is a function (data, i) that mutates the
// RGB of one pixel in place (alpha untouched). Uint8ClampedArray clamps on assignment.

export type PixelOp = (data: Uint8ClampedArray, i: number) => void;

export const invertPixel: PixelOp = (d, i) => {
  d[i] = 255 - d[i];
  d[i + 1] = 255 - d[i + 1];
  d[i + 2] = 255 - d[i + 2];
};

export const desaturatePixel: PixelOp = (d, i) => {
  const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  d[i] = g;
  d[i + 1] = g;
  d[i + 2] = g;
};

/** brightness/contrast both in [-100, 100]. */
export function makeBrightnessContrast(brightness: number, contrast: number): PixelOp {
  const b = (brightness / 100) * 255;
  const C = (contrast / 100) * 255;
  const cf = (259 * (C + 255)) / (255 * (259 - C));
  return (d, i) => {
    d[i] = cf * (d[i] + b - 128) + 128;
    d[i + 1] = cf * (d[i + 1] + b - 128) + 128;
    d[i + 2] = cf * (d[i + 2] + b - 128) + 128;
  };
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** hue [-180,180] degrees, saturation/lightness [-100,100]. */
export function makeHueSaturation(hue: number, saturation: number, lightness: number): PixelOp {
  const hShift = hue / 360;
  const sMul = 1 + saturation / 100;
  const lAdd = lightness / 100;
  return (d, i) => {
    const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    let nh = (h + hShift) % 1;
    if (nh < 0) nh += 1;
    const [r, g, b] = hslToRgb(nh, clamp01(s * sMul), clamp01(l + lAdd));
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  };
}
