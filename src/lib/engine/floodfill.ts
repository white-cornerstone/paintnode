import type { RGB, Rect } from './types';

/**
 * Scanline flood fill with per-channel tolerance. Fills the contiguous region matching the
 * color at (sx, sy) with `fill` (opaque). Returns the changed bounding box, or null if the
 * seed is out of bounds. Operates in place on `img.data`.
 */
export function floodFill(
  img: ImageData,
  sx: number,
  sy: number,
  fill: RGB,
  tolerance: number,
  inSelection?: (x: number, y: number) => boolean,
): Rect | null {
  const { width, height, data } = img;
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  if (inSelection && !inSelection(sx, sy)) return null;

  const ti = (sy * width + sx) * 4;
  const tr = data[ti];
  const tg = data[ti + 1];
  const tb = data[ti + 2];
  const ta = data[ti + 3];
  const fr = fill.r;
  const fg = fill.g;
  const fb = fill.b;

  const matches = (p: number): boolean => {
    const i = p * 4;
    return (
      Math.abs(data[i] - tr) <= tolerance &&
      Math.abs(data[i + 1] - tg) <= tolerance &&
      Math.abs(data[i + 2] - tb) <= tolerance &&
      Math.abs(data[i + 3] - ta) <= tolerance
    );
  };

  const visited = new Uint8Array(width * height);
  const fillable = (x: number, y: number, p: number): boolean =>
    !visited[p] && matches(p) && (!inSelection || inSelection(x, y));

  const stackX: number[] = [sx];
  const stackY: number[] = [sy];
  let minX = sx;
  let minY = sy;
  let maxX = sx;
  let maxY = sy;

  while (stackX.length) {
    const x = stackX.pop()!;
    const y = stackY.pop()!;
    const row = y * width;

    let lx = x;
    while (lx >= 0 && fillable(lx, y, row + lx)) lx--;
    lx++;
    let rx = x;
    while (rx < width && fillable(rx, y, row + rx)) rx++;
    rx--;
    if (lx > rx) continue;

    for (let xx = lx; xx <= rx; xx++) {
      const p = row + xx;
      visited[p] = 1;
      const i = p * 4;
      data[i] = fr;
      data[i + 1] = fg;
      data[i + 2] = fb;
      data[i + 3] = 255;
      if (y > 0 && fillable(xx, y - 1, p - width)) {
        stackX.push(xx);
        stackY.push(y - 1);
      }
      if (y < height - 1 && fillable(xx, y + 1, p + width)) {
        stackX.push(xx);
        stackY.push(y + 1);
      }
    }
    if (lx < minX) minX = lx;
    if (rx > maxX) maxX = rx;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
