import type { Rect } from './types';
import { clampRect, createCanvas, ctx2d } from './types';

export interface Point {
  x: number;
  y: number;
}

/**
 * A selection of arbitrary shape. `mask` is a document-size canvas whose alpha encodes
 * coverage (opaque = selected); `outline` is the doc-space path drawn as marching ants;
 * `bounds` is the selection's bounding box (for snapshots and copy/cut).
 */
export interface Selection {
  mask: HTMLCanvasElement;
  bounds: Rect;
  outline: Path2D;
}

function blankMask(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = createCanvas(w, h);
  return { canvas, ctx: ctx2d(canvas) };
}

export function rectSelection(rect: Rect, w: number, h: number): Selection | null {
  const r = clampRect(rect, w, h);
  if (!r) return null;
  const { canvas, ctx } = blankMask(w, h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const outline = new Path2D();
  outline.rect(r.x, r.y, r.w, r.h);
  return { mask: canvas, bounds: r, outline };
}

export function ellipseSelection(rect: Rect, w: number, h: number): Selection | null {
  const r = clampRect(rect, w, h);
  if (!r) return null;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rx = r.w / 2;
  const ry = r.h / 2;
  const { canvas, ctx } = blankMask(w, h);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  const outline = new Path2D();
  outline.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  return { mask: canvas, bounds: r, outline };
}

export function rowSelection(y: number, w: number, h: number): Selection | null {
  return rectSelection({ x: 0, y: Math.floor(y), w, h: 1 }, w, h);
}

export function colSelection(x: number, w: number, h: number): Selection | null {
  return rectSelection({ x: Math.floor(x), y: 0, w: 1, h }, w, h);
}

export function lassoSelection(points: Point[], w: number, h: number): Selection | null {
  if (points.length < 3) return null;
  const { canvas, ctx } = blankMask(w, h);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fill();

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bounds = clampRect({ x: minX, y: minY, w: maxX - minX, h: maxY - minY }, w, h);
  if (!bounds) return null;

  const outline = new Path2D();
  outline.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) outline.lineTo(points[i].x, points[i].y);
  outline.closePath();
  return { mask: canvas, bounds, outline };
}

export function selectAllSelection(w: number, h: number): Selection {
  return rectSelection({ x: 0, y: 0, w, h }, w, h)!;
}

export function invertSelection(sel: Selection, w: number, h: number): Selection {
  const { canvas, ctx } = blankMask(w, h);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(sel.mask, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  const outline = new Path2D();
  outline.rect(0, 0, w, h);
  outline.addPath(sel.outline);
  return { mask: canvas, bounds: { x: 0, y: 0, w, h }, outline };
}

const ALPHA_ON = 128;

/**
 * Derive a Selection (bounds + marching-ants outline) from a raster `mask` (opaque = selected).
 * The outline is the exact pixel boundary, built from the edges between selected and
 * unselected cells — so it works for any shape, including the magic wand's blobs.
 */
export function maskToSelection(mask: HTMLCanvasElement, w: number, h: number): Selection | null {
  const data = ctx2d(mask).getImageData(0, 0, w, h).data;
  const on = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] >= ALPHA_ON;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= ALPHA_ON) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX) return null; // nothing selected

  const outline = new Path2D();
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!on(x, y)) continue;
      if (!on(x - 1, y)) { outline.moveTo(x, y); outline.lineTo(x, y + 1); }
      if (!on(x + 1, y)) { outline.moveTo(x + 1, y); outline.lineTo(x + 1, y + 1); }
      if (!on(x, y - 1)) { outline.moveTo(x, y); outline.lineTo(x + 1, y); }
      if (!on(x, y + 1)) { outline.moveTo(x, y + 1); outline.lineTo(x + 1, y + 1); }
    }
  }
  return { mask, bounds: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, outline };
}

/**
 * Magic-wand selection: select pixels matching the seed color within `tolerance` (per channel).
 * Operates on one layer's pixels (`img`, layer space); `offsetX/offsetY` are the layer origin so
 * the resulting mask is placed in document space. `contiguous` floods only the connected region.
 */
export function magicWandSelection(
  img: ImageData,
  sx: number,
  sy: number,
  tolerance: number,
  contiguous: boolean,
  offsetX: number,
  offsetY: number,
  docW: number,
  docH: number,
): Selection | null {
  const { width: lw, height: lh, data } = img;
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= lw || sy >= lh) return null;

  const ti = (sy * lw + sx) * 4;
  const tr = data[ti];
  const tg = data[ti + 1];
  const tb = data[ti + 2];
  const ta = data[ti + 3];
  const matches = (p: number): boolean => {
    const i = p * 4;
    return (
      Math.abs(data[i] - tr) <= tolerance &&
      Math.abs(data[i + 1] - tg) <= tolerance &&
      Math.abs(data[i + 2] - tb) <= tolerance &&
      Math.abs(data[i + 3] - ta) <= tolerance
    );
  };

  const selected = new Uint8Array(lw * lh);
  if (contiguous) {
    const stackX = [sx];
    const stackY = [sy];
    while (stackX.length) {
      const x = stackX.pop()!;
      const y = stackY.pop()!;
      const row = y * lw;
      let lx = x;
      while (lx >= 0 && !selected[row + lx] && matches(row + lx)) lx--;
      lx++;
      let rx = x;
      while (rx < lw && !selected[row + rx] && matches(row + rx)) rx++;
      rx--;
      if (lx > rx) continue;
      for (let xx = lx; xx <= rx; xx++) {
        const p = row + xx;
        selected[p] = 1;
        if (y > 0 && !selected[p - lw] && matches(p - lw)) { stackX.push(xx); stackY.push(y - 1); }
        if (y < lh - 1 && !selected[p + lw] && matches(p + lw)) { stackX.push(xx); stackY.push(y + 1); }
      }
    }
  } else {
    for (let p = 0; p < lw * lh; p++) if (matches(p)) selected[p] = 1;
  }

  const layerMask = createCanvas(lw, lh);
  const lmCtx = ctx2d(layerMask);
  const out = lmCtx.createImageData(lw, lh);
  for (let p = 0; p < lw * lh; p++) {
    if (selected[p]) {
      out.data[p * 4] = 255;
      out.data[p * 4 + 1] = 255;
      out.data[p * 4 + 2] = 255;
      out.data[p * 4 + 3] = 255;
    }
  }
  lmCtx.putImageData(out, 0, 0);

  const docMask = createCanvas(docW, docH);
  ctx2d(docMask).drawImage(layerMask, offsetX, offsetY);
  return maskToSelection(docMask, docW, docH);
}

/** Union two selections (Shift-add). */
export function addToSelection(
  base: Selection | null,
  add: Selection,
  w: number,
  h: number,
): Selection | null {
  if (!base) return add;
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.drawImage(base.mask, 0, 0);
  ctx.drawImage(add.mask, 0, 0);
  return maskToSelection(c, w, h);
}

/** Remove one selection from another (Alt-subtract); null if nothing remains. */
export function subtractFromSelection(
  base: Selection | null,
  sub: Selection,
  w: number,
  h: number,
): Selection | null {
  if (!base) return null;
  const c = createCanvas(w, h);
  const ctx = ctx2d(c);
  ctx.drawImage(base.mask, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.drawImage(sub.mask, 0, 0);
  return maskToSelection(c, w, h);
}

/** Return a new canvas equal to `buffer` keeping only pixels inside the selection mask. */
export function intersectMask(buffer: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(buffer.width, buffer.height);
  const c = ctx2d(out);
  c.drawImage(buffer, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(mask, 0, 0);
  return out;
}
