import type { SelectionMode } from './selection';
import type { Rect } from './types';
import { clamp, clampRect, createCanvas, ctx2d } from './types';

export const AI_RETOUCH_TOOL_ORDER = [
  'spot-healing',
  'remove',
  'healing-brush',
  'patch',
  'content-aware-move',
  'red-eye',
] as const;

export type AiRetouchToolId = (typeof AI_RETOUCH_TOOL_ORDER)[number];
export type AiRetouchPatchMode = 'source' | 'destination';
export type AiRetouchMoveMode = 'move' | 'extend';

export interface AiRetouchPoint {
  x: number;
  y: number;
}

export interface AiRetouchBrushStroke {
  kind: 'brush';
  points: AiRetouchPoint[];
  size: number;
  hardness: number;
  closedLoop?: boolean;
  reference?: Rect | null;
}

export interface AiRetouchPatchRequest {
  kind: 'patch';
  mode: AiRetouchPatchMode;
  target: Rect;
  reference: Rect;
}

export interface AiRetouchMoveRequest {
  kind: 'move';
  mode: AiRetouchMoveMode;
  source: Rect;
  destination: Rect;
}

export interface AiRetouchRedEyeRequest {
  kind: 'red-eye';
  bounds: Rect;
  pupilSize: number;
  darkenAmount: number;
}

export type AiRetouchGesture =
  | AiRetouchBrushStroke
  | AiRetouchPatchRequest
  | AiRetouchMoveRequest
  | AiRetouchRedEyeRequest;

export interface AiRetouchRequest {
  id: string;
  maskLayerId: string;
  toolId: AiRetouchToolId;
  toolName: string;
  prompt: string;
  source: HTMLCanvasElement;
  editTarget: HTMLCanvasElement;
  mask: HTMLCanvasElement;
  reference: HTMLCanvasElement | null;
  gesture: AiRetouchGesture;
}

export interface AiRetouchInputBytes {
  sourcePng: Uint8Array;
  editTargetPng: Uint8Array;
  maskPng: Uint8Array;
  referencePng?: Uint8Array | null;
}

export interface AiRetouchPreview {
  mask: HTMLCanvasElement;
}

export interface AiRetouchMaskMetadata {
  toolId: AiRetouchToolId;
  promptSeed: string;
  patchMode?: AiRetouchPatchMode;
  moveMode?: AiRetouchMoveMode;
  pupilSize?: number;
  darkenAmount?: number;
  healingSource?: AiRetouchPoint | null;
  referenceRect?: Rect | null;
  destinationRect?: Rect | null;
}

export const AI_RETOUCH_TOOL_NAMES: Record<AiRetouchToolId, string> = {
  'spot-healing': 'Spot Healing Brush',
  remove: 'Remove',
  'healing-brush': 'Healing Brush',
  patch: 'Patch',
  'content-aware-move': 'Content-Aware Move',
  'red-eye': 'Red Eye',
};

export function nextAiRetouchTool(current: AiRetouchToolId, backwards = false): AiRetouchToolId {
  const idx = Math.max(0, AI_RETOUCH_TOOL_ORDER.indexOf(current));
  const delta = backwards ? -1 : 1;
  return AI_RETOUCH_TOOL_ORDER[(idx + delta + AI_RETOUCH_TOOL_ORDER.length) % AI_RETOUCH_TOOL_ORDER.length];
}

export function pointsBounds(points: AiRetouchPoint[], padding = 0): Rect | null {
  if (!points.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return {
    x: Math.floor(minX - padding),
    y: Math.floor(minY - padding),
    w: Math.ceil(maxX - minX + padding * 2),
    h: Math.ceil(maxY - minY + padding * 2),
  };
}

export function offsetRect(rect: Rect, dx: number, dy: number, docW: number, docH: number): Rect {
  return clampRect({ x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h }, docW, docH) ?? {
    x: clamp(rect.x + dx, 0, docW - 1),
    y: clamp(rect.y + dy, 0, docH - 1),
    w: 1,
    h: 1,
  };
}

export function referenceRect(center: AiRetouchPoint, size: number, docW: number, docH: number): Rect {
  const side = Math.max(16, Math.round(size));
  return clampRect({ x: center.x - side / 2, y: center.y - side / 2, w: side, h: side }, docW, docH) ?? {
    x: 0,
    y: 0,
    w: Math.min(side, docW),
    h: Math.min(side, docH),
  };
}

export function aiRetouchPrompt(toolId: AiRetouchToolId, gesture: AiRetouchGesture): string {
  switch (toolId) {
    case 'spot-healing':
      return 'Repair the masked small blemish, dust, spot, scratch, or minor flaw. Preserve the surrounding texture, lighting, grain, edges, and natural detail.';
    case 'remove':
      return 'Remove the masked distraction, text, logo, mark, or object completely. Reconstruct the underlying surface from the surrounding scene with matching perspective, lighting, focus, color, texture, grain, and motion blur. Do not paint a flat patch or introduce a new color block.';
    case 'healing-brush':
      return 'Heal the masked target area using the attached reference image as the source texture and visual character. Blend the result into the target naturally without obvious cloning or repeated patterns.';
    case 'patch': {
      const mode = gesture.kind === 'patch' ? gesture.mode : 'source';
      return mode === 'source'
        ? 'Repair the masked target area using the attached reference patch as the sampled source. Match texture and structure while blending color and lighting into the target area.'
        : 'Use the masked area as the sampled source and synthesize it into the referenced destination area. Blend naturally with the destination surroundings.';
    }
    case 'content-aware-move': {
      const mode = gesture.kind === 'move' ? gesture.mode : 'move';
      return mode === 'extend'
        ? 'Extend or contract the selected subject into the destination area, preserving the original subject identity and filling any exposed source area with matching background.'
        : 'Move the selected subject from the masked source area to the referenced destination area. Recompose the image by filling the original hole and blending the moved subject naturally at its new location.';
    }
    case 'red-eye': {
      const opts = gesture.kind === 'red-eye' ? gesture : { pupilSize: 50, darkenAmount: 50 };
      return `Correct red or white flash reflection inside the masked eye area. Preserve the iris shape, eyelids, natural catchlights, and face texture. Pupil size strength ${Math.round(opts.pupilSize)}%, darken amount ${Math.round(opts.darkenAmount)}%.`;
    }
  }
}

export function makeStrokeMask(
  width: number,
  height: number,
  stroke: AiRetouchBrushStroke,
): HTMLCanvasElement | null {
  if (!stroke.points.length) return null;
  const mask = createCanvas(width, height);
  const ctx = ctx2d(mask);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1, stroke.size);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (stroke.closedLoop && stroke.points.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
    ctx.closePath();
    ctx.fill();
  }

  ctx.beginPath();
  ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
  for (const point of stroke.points.slice(1)) ctx.lineTo(point.x, point.y);
  if (stroke.points.length === 1) {
    const r = Math.max(0.5, stroke.size / 2);
    ctx.arc(stroke.points[0].x, stroke.points[0].y, r, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.stroke();
  }

  if (stroke.hardness < 0.98) {
    const feather = Math.max(1, Math.round(stroke.size * (1 - stroke.hardness) * 0.5));
    const blur = `blur(${feather}px)`;
    const soft = createCanvas(width, height);
    const softCtx = ctx2d(soft);
    softCtx.filter = blur;
    softCtx.drawImage(mask, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(soft, 0, 0);
  }
  return mask;
}

export function makeRectMask(width: number, height: number, rect: Rect, shape: 'rect' | 'ellipse' = 'rect'): HTMLCanvasElement | null {
  const r = clampRect(rect, width, height);
  if (!r) return null;
  const mask = createCanvas(width, height);
  const ctx = ctx2d(mask);
  ctx.fillStyle = '#fff';
  if (shape === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
  return mask;
}

export function makeUnionRectMask(width: number, height: number, rects: Rect[]): HTMLCanvasElement | null {
  const mask = createCanvas(width, height);
  const ctx = ctx2d(mask);
  ctx.fillStyle = '#fff';
  let any = false;
  for (const rect of rects) {
    const r = clampRect(rect, width, height);
    if (!r) continue;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    any = true;
  }
  return any ? mask : null;
}

export function maskHasPixels(mask: HTMLCanvasElement): boolean {
  const data = ctx2d(mask, { willReadFrequently: true }).getImageData(0, 0, mask.width, mask.height).data;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
  return false;
}

export function maskBounds(mask: HTMLCanvasElement): Rect | null {
  const data = ctx2d(mask, { willReadFrequently: true }).getImageData(0, 0, mask.width, mask.height).data;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (data[(y * mask.width + x) * 4 + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

export function maskContainsPoint(mask: HTMLCanvasElement, x: number, y: number): boolean {
  const px = Math.floor(x);
  const py = Math.floor(y);
  if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return false;
  return ctx2d(mask, { willReadFrequently: true }).getImageData(px, py, 1, 1).data[3] > 0;
}

export function cloneMask(mask: HTMLCanvasElement): HTMLCanvasElement {
  const out = createCanvas(mask.width, mask.height);
  ctx2d(out).drawImage(mask, 0, 0);
  return out;
}

export function combineRetouchMask(
  base: HTMLCanvasElement | null,
  add: HTMLCanvasElement,
  mode: SelectionMode,
  width: number,
  height: number,
): HTMLCanvasElement | null {
  if (mode === 'new') return cloneMask(add);
  if (!base) return mode === 'add' ? cloneMask(add) : null;
  const out = createCanvas(width, height);
  const ctx = ctx2d(out);
  ctx.drawImage(base, 0, 0, width, height);
  if (mode === 'add') {
    ctx.globalCompositeOperation = 'source-over';
  } else if (mode === 'subtract') {
    ctx.globalCompositeOperation = 'destination-out';
  } else {
    ctx.globalCompositeOperation = 'destination-in';
  }
  ctx.drawImage(add, 0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';
  return maskHasPixels(out) ? out : null;
}

export function makeEditTarget(source: HTMLCanvasElement, _mask: HTMLCanvasElement): HTMLCanvasElement {
  const target = createCanvas(source.width, source.height);
  const targetCtx = ctx2d(target);
  targetCtx.drawImage(source, 0, 0);
  return target;
}

export function cropReference(source: HTMLCanvasElement, rect: Rect): HTMLCanvasElement | null {
  const r = clampRect(rect, source.width, source.height);
  if (!r) return null;
  const out = createCanvas(r.w, r.h);
  ctx2d(out).drawImage(source, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return out;
}
