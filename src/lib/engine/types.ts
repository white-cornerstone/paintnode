// Core engine types and helpers — framework-agnostic plain TS.

/** Canvas-native blend modes (used directly as `globalCompositeOperation`). */
export type BlendMode =
  | 'source-over' // Normal
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'hard-light'
  | 'soft-light'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export interface BlendModeOption {
  value: BlendMode;
  label: string;
  /** Group separator before this item. */
  group?: boolean;
}

/** Ordered, grouped list for the blend-mode dropdown. */
export const BLEND_MODES: BlendModeOption[] = [
  { value: 'source-over', label: 'Normal' },
  { value: 'darken', label: 'Darken', group: true },
  { value: 'multiply', label: 'Multiply' },
  { value: 'color-burn', label: 'Color Burn' },
  { value: 'lighten', label: 'Lighten', group: true },
  { value: 'screen', label: 'Screen' },
  { value: 'color-dodge', label: 'Color Dodge' },
  { value: 'overlay', label: 'Overlay', group: true },
  { value: 'soft-light', label: 'Soft Light' },
  { value: 'hard-light', label: 'Hard Light' },
  { value: 'difference', label: 'Difference', group: true },
  { value: 'exclusion', label: 'Exclusion' },
  { value: 'hue', label: 'Hue', group: true },
  { value: 'saturation', label: 'Saturation' },
  { value: 'color', label: 'Color' },
  { value: 'luminosity', label: 'Luminosity' },
];

/** Map internal blend mode -> OpenRaster `composite-op` value. */
export const BLEND_TO_ORA: Record<BlendMode, string> = {
  'source-over': 'svg:src-over',
  multiply: 'svg:multiply',
  screen: 'svg:screen',
  overlay: 'svg:overlay',
  darken: 'svg:darken',
  lighten: 'svg:lighten',
  'color-dodge': 'svg:color-dodge',
  'color-burn': 'svg:color-burn',
  'hard-light': 'svg:hard-light',
  'soft-light': 'svg:soft-light',
  difference: 'svg:difference',
  exclusion: 'svg:exclusion',
  hue: 'svg:hue',
  saturation: 'svg:saturation',
  color: 'svg:color',
  luminosity: 'svg:luminosity',
};

const ORA_TO_BLEND: Record<string, BlendMode> = Object.fromEntries(
  Object.entries(BLEND_TO_ORA).map(([k, v]) => [v, k as BlendMode]),
);
// Common aliases produced by other ORA editors.
ORA_TO_BLEND['svg:plus'] = 'lighten';
ORA_TO_BLEND['svg:add'] = 'lighten';
ORA_TO_BLEND['svg:src-atop'] = 'source-over';

export function oraToBlend(op: string | null | undefined): BlendMode {
  if (!op) return 'source-over';
  return ORA_TO_BLEND[op] ?? 'source-over';
}

/** RGB color, 0-255 channels. */
export interface RGB {
  r: number;
  g: number;
  b: number;
}

let _idCounter = 0;
/** Stable, unique id for layers/documents. */
export function uid(prefix = 'id'): string {
  _idCounter += 1;
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${_idCounter}-${rand}`;
}

/** Create a fresh 2D canvas of the given size. */
export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.floor(width));
  c.height = Math.max(1, Math.floor(height));
  return c;
}

/** Get a non-null 2D context or throw (fail fast). */
export function ctx2d(
  canvas: HTMLCanvasElement,
  opts?: CanvasRenderingContext2DSettings,
): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', opts);
  if (!ctx) throw new Error('Unable to acquire 2D canvas context');
  return ctx;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Intersect a rect with the [0,0,w,h] document bounds; returns null if empty. */
export function clampRect(r: Rect, w: number, h: number): Rect | null {
  const x0 = clamp(Math.floor(r.x), 0, w);
  const y0 = clamp(Math.floor(r.y), 0, h);
  const x1 = clamp(Math.ceil(r.x + r.w), 0, w);
  const y1 = clamp(Math.ceil(r.y + r.h), 0, h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
