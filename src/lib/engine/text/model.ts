// Rich text model for editable text layers — framework-agnostic plain TS.
//
// A TextModel is the editable source of truth for a text layer. It is rendered to the
// layer's canvas by ./render.ts and round-trips through .ora as a sidecar JSON file.
// The model is intentionally rich (per-run styling + per-paragraph properties) so the
// editor UI can grow without changing the storage format.

import type { RGB } from '../types';

/** Character-level styling. A run is the largest span of text sharing one style. */
export interface TextStyle {
  /** CSS font-family (may be a stack, e.g. "Georgia, serif"). */
  family: string;
  /** Font size in px. */
  size: number;
  color: RGB;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** Extra letter spacing in px (tracking); 0 = normal. */
  tracking: number;
}

export interface TextRun {
  text: string;
  style: TextStyle;
}

export type TextAlign = 'left' | 'center' | 'right';

/** A paragraph is one logical line of point text (no wrapping); Enter starts a new one. */
export interface TextParagraph {
  align: TextAlign;
  /** Line height as a multiple of the paragraph's largest font size (e.g. 1.3). */
  lineHeight: number;
  runs: TextRun[];
}

export interface TextModel {
  version: 1;
  /** Top-left anchor of the text block, in document pixels. */
  x: number;
  y: number;
  paragraphs: TextParagraph[];
}

export const DEFAULT_LINE_HEIGHT = 1.3;

export function defaultStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    family: 'sans-serif',
    size: 72,
    color: { r: 0, g: 0, b: 0 },
    bold: false,
    italic: false,
    underline: false,
    tracking: 0,
    ...overrides,
  };
}

export function cloneStyle(s: TextStyle): TextStyle {
  return { ...s, color: { ...s.color } };
}

export function cloneModel(m: TextModel): TextModel {
  return {
    version: 1,
    x: m.x,
    y: m.y,
    paragraphs: m.paragraphs.map((p) => ({
      align: p.align,
      lineHeight: p.lineHeight,
      runs: p.runs.map((r) => ({ text: r.text, style: cloneStyle(r.style) })),
    })),
  };
}

/** Build a single-style model from plain text (newlines become separate paragraphs). */
export function plainTextModel(text: string, x: number, y: number, style: TextStyle): TextModel {
  const lines = text.split('\n');
  return {
    version: 1,
    x,
    y,
    paragraphs: lines.map((line) => ({
      align: 'left',
      lineHeight: DEFAULT_LINE_HEIGHT,
      runs: [{ text: line, style: cloneStyle(style) }],
    })),
  };
}

/** Flatten the model back to plain text (paragraphs joined with newlines). */
export function modelToPlainText(m: TextModel): string {
  return m.paragraphs.map((p) => p.runs.map((r) => r.text).join('')).join('\n');
}

export function isBlankModel(m: TextModel): boolean {
  return modelToPlainText(m).trim().length === 0;
}

/** A short layer name derived from the first non-empty line of text. */
export function textLayerName(m: TextModel): string {
  const firstLine = modelToPlainText(m)
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine ? firstLine.slice(0, 24) : 'Text';
}

/** Distinct font families used across the model (for embedding decisions). */
export function fontFamiliesUsed(m: TextModel): string[] {
  const set = new Set<string>();
  for (const p of m.paragraphs) for (const r of p.runs) set.add(r.style.family);
  return [...set];
}

// --- Serialization (sidecar JSON inside the .ora) ---

export function serializeModel(m: TextModel): string {
  return JSON.stringify(m);
}

/** Parse a model from its JSON sidecar, coercing/validating defensively. */
export function deserializeModel(raw: string): TextModel | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const obj = o as Record<string, unknown>;
  const rawParagraphs = Array.isArray(obj.paragraphs) ? obj.paragraphs : [];
  const paragraphs = rawParagraphs.map(coerceParagraph);
  if (!paragraphs.length) return null;
  return { version: 1, x: num(obj.x, 0), y: num(obj.y, 0), paragraphs };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function coerceAlign(v: unknown): TextAlign {
  return v === 'center' || v === 'right' ? v : 'left';
}

function coerceColor(v: unknown): RGB {
  const o = (v ?? {}) as Record<string, unknown>;
  return { r: num(o.r, 0), g: num(o.g, 0), b: num(o.b, 0) };
}

function coerceStyle(v: unknown): TextStyle {
  const o = (v ?? {}) as Record<string, unknown>;
  return defaultStyle({
    family: typeof o.family === 'string' ? o.family : 'sans-serif',
    size: num(o.size, 72),
    color: coerceColor(o.color),
    bold: !!o.bold,
    italic: !!o.italic,
    underline: !!o.underline,
    tracking: num(o.tracking, 0),
  });
}

function coerceParagraph(v: unknown): TextParagraph {
  const o = (v ?? {}) as Record<string, unknown>;
  const rawRuns = Array.isArray(o.runs) ? o.runs : [];
  const runs = rawRuns
    .map((r) => {
      const ro = (r ?? {}) as Record<string, unknown>;
      return { text: typeof ro.text === 'string' ? ro.text : '', style: coerceStyle(ro.style) };
    });
  return {
    align: coerceAlign(o.align),
    lineHeight: num(o.lineHeight, DEFAULT_LINE_HEIGHT),
    runs: runs.length ? runs : [{ text: '', style: defaultStyle() }],
  };
}
