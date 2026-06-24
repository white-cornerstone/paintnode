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

/** Return a new canvas equal to `buffer` keeping only pixels inside the selection mask. */
export function intersectMask(buffer: HTMLCanvasElement, mask: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(buffer.width, buffer.height);
  const c = ctx2d(out);
  c.drawImage(buffer, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(mask, 0, 0);
  return out;
}
