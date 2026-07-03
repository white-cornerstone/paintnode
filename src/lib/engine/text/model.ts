// Rich text model for editable text layers — framework-agnostic plain TS.
//
// A TextModel is the editable source of truth for a text layer. It is rendered to the
// layer's canvas by ./render.ts and round-trips through .ora as a sidecar JSON file.
// The model is intentionally rich (per-run styling + per-paragraph properties) so the
// editor UI can grow without changing the storage format. The character/paragraph
// attributes deliberately mirror Photoshop's Character and Paragraph panels so text
// survives PSD round trips.

import type { RGB } from '../types';

export type TextCaps = 'none' | 'small' | 'all';
export type TextScript = 'none' | 'super' | 'sub';

/** Character-level styling. A run is the largest span of text sharing one style. */
export interface TextStyle {
  /** CSS font-family (may be a stack, e.g. "Georgia, serif"). */
  family: string;
  /** Font size in px. */
  size: number;
  color: RGB;
  /** Faux bold (synthesized weight). */
  bold: boolean;
  /** Faux italic (synthesized slant). */
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  /** Extra letter spacing in px (tracking); 0 = normal. */
  tracking: number;
  /** Baseline-to-baseline leading in px; null = auto ({@link AUTO_LEADING} × size). */
  leading: number | null;
  /** Glyph scale percentages (100 = normal). */
  horizontalScale: number;
  verticalScale: number;
  /** Baseline shift in px; positive shifts up. */
  baselineShift: number;
  caps: TextCaps;
  script: TextScript;
}

export interface TextRun {
  text: string;
  style: TextStyle;
}

export type TextAlign =
  | 'left'
  | 'center'
  | 'right'
  | 'justify-left'
  | 'justify-center'
  | 'justify-right'
  | 'justify-all';

/** A paragraph is one logical line of point text (no wrapping); Enter starts a new one. */
export interface TextParagraph {
  align: TextAlign;
  runs: TextRun[];
  /** Indents and paragraph spacing in px (Photoshop Paragraph panel). */
  indentLeft: number;
  indentRight: number;
  firstLineIndent: number;
  spaceBefore: number;
  spaceAfter: number;
  /** Stored for PSD round-trip; point text never wraps so it has no visual effect. */
  hyphenate: boolean;
}

export type TextAntiAlias = 'none' | 'sharp' | 'crisp' | 'strong' | 'smooth';

export type TextOrientation = 'horizontal' | 'vertical';

export interface TextModel {
  version: 1;
  /** Top-left anchor of the text block, in document pixels. */
  x: number;
  y: number;
  paragraphs: TextParagraph[];
  /**
   * Vertical text stacks characters top-to-bottom with paragraphs as columns
   * advancing right-to-left (absent = horizontal).
   */
  orientation?: TextOrientation;
  /** Photoshop anti-alias mode (round-tripped; PaintNode always renders anti-aliased). */
  antiAlias?: TextAntiAlias;
}

/** Auto leading factor (Photoshop default: 120% of the font size). */
export const AUTO_LEADING = 1.2;
/** @deprecated Pre-v2 paragraphs stored a lineHeight multiplier; kept for migration. */
export const DEFAULT_LINE_HEIGHT = 1.3;

export function defaultStyle(overrides: Partial<TextStyle> = {}): TextStyle {
  return {
    family: 'sans-serif',
    size: 72,
    color: { r: 0, g: 0, b: 0 },
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    tracking: 0,
    leading: null,
    horizontalScale: 100,
    verticalScale: 100,
    baselineShift: 0,
    caps: 'none',
    script: 'none',
    ...overrides,
  };
}

export function defaultParagraph(overrides: Partial<TextParagraph> = {}): TextParagraph {
  return {
    align: 'left',
    runs: [],
    indentLeft: 0,
    indentRight: 0,
    firstLineIndent: 0,
    spaceBefore: 0,
    spaceAfter: 0,
    hyphenate: false,
    ...overrides,
  };
}

export function cloneStyle(s: TextStyle): TextStyle {
  return { ...s, color: { ...s.color } };
}

export function cloneParagraph(p: TextParagraph): TextParagraph {
  return { ...p, runs: p.runs.map((r) => ({ text: r.text, style: cloneStyle(r.style) })) };
}

export function cloneModel(m: TextModel): TextModel {
  return {
    version: 1,
    x: m.x,
    y: m.y,
    paragraphs: m.paragraphs.map(cloneParagraph),
    ...(m.orientation === 'vertical' ? { orientation: m.orientation } : {}),
    ...(m.antiAlias ? { antiAlias: m.antiAlias } : {}),
  };
}

/** True when two styles are visually identical (used to merge adjacent runs). */
export function stylesEqual(a: TextStyle, b: TextStyle): boolean {
  return (
    a.family === b.family &&
    a.size === b.size &&
    a.color.r === b.color.r &&
    a.color.g === b.color.g &&
    a.color.b === b.color.b &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strikethrough === b.strikethrough &&
    a.tracking === b.tracking &&
    a.leading === b.leading &&
    a.horizontalScale === b.horizontalScale &&
    a.verticalScale === b.verticalScale &&
    a.baselineShift === b.baselineShift &&
    a.caps === b.caps &&
    a.script === b.script
  );
}

/** Build a single-style model from plain text (newlines become separate paragraphs). */
export function plainTextModel(text: string, x: number, y: number, style: TextStyle): TextModel {
  const lines = text.split('\n');
  return {
    version: 1,
    x,
    y,
    paragraphs: lines.map((line) =>
      defaultParagraph({ runs: [{ text: line, style: cloneStyle(style) }] }),
    ),
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
  migrateLineHeights(paragraphs, rawParagraphs);
  const antiAlias = coerceAntiAlias(obj.antiAlias);
  return {
    version: 1,
    x: num(obj.x, 0),
    y: num(obj.y, 0),
    paragraphs,
    ...(obj.orientation === 'vertical' ? { orientation: 'vertical' as const } : {}),
    ...(antiAlias ? { antiAlias } : {}),
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

const ALIGN_VALUES: readonly TextAlign[] = [
  'left',
  'center',
  'right',
  'justify-left',
  'justify-center',
  'justify-right',
  'justify-all',
];

function coerceAlign(v: unknown): TextAlign {
  return ALIGN_VALUES.includes(v as TextAlign) ? (v as TextAlign) : 'left';
}

function coerceAntiAlias(v: unknown): TextAntiAlias | null {
  return v === 'none' || v === 'sharp' || v === 'crisp' || v === 'strong' || v === 'smooth' ? v : null;
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
    strikethrough: !!o.strikethrough,
    tracking: num(o.tracking, 0),
    leading: typeof o.leading === 'number' && Number.isFinite(o.leading) ? o.leading : null,
    horizontalScale: num(o.horizontalScale, 100),
    verticalScale: num(o.verticalScale, 100),
    baselineShift: num(o.baselineShift, 0),
    caps: o.caps === 'small' || o.caps === 'all' ? o.caps : 'none',
    script: o.script === 'super' || o.script === 'sub' ? o.script : 'none',
  });
}

function coerceParagraph(v: unknown): TextParagraph {
  const o = (v ?? {}) as Record<string, unknown>;
  const rawRuns = Array.isArray(o.runs) ? o.runs : [];
  const runs = rawRuns.map((r) => {
    const ro = (r ?? {}) as Record<string, unknown>;
    return { text: typeof ro.text === 'string' ? ro.text : '', style: coerceStyle(ro.style) };
  });
  return defaultParagraph({
    align: coerceAlign(o.align),
    runs: runs.length ? runs : [{ text: '', style: defaultStyle() }],
    indentLeft: num(o.indentLeft, 0),
    indentRight: num(o.indentRight, 0),
    firstLineIndent: num(o.firstLineIndent, 0),
    spaceBefore: num(o.spaceBefore, 0),
    spaceAfter: num(o.spaceAfter, 0),
    hyphenate: !!o.hyphenate,
  });
}

/**
 * v1 migration: paragraphs stored a lineHeight multiplier and the old renderer
 * advanced each baseline by the PREVIOUS line's box height. Convert to explicit
 * per-run leading that reproduces that advance (with the old fallback metrics:
 * ascent = 0.8 × size, box height ≥ ascent + descent = size), so existing
 * documents — including mixed-font-size ones — keep their spacing.
 */
function migrateLineHeights(paragraphs: TextParagraph[], raw: unknown[]): void {
  const lineHeights = raw.map((v) => {
    const o = (v ?? {}) as Record<string, unknown>;
    return typeof o.lineHeight === 'number' && Number.isFinite(o.lineHeight) ? o.lineHeight : null;
  });
  if (!lineHeights.some((lh) => lh !== null)) return;
  const maxSize = (p: TextParagraph) => p.runs.reduce((s, r) => Math.max(s, r.style.size), 0);
  const boxHeight = (i: number) => {
    const size = maxSize(paragraphs[i]);
    const lh = lineHeights[i];
    return lh === null || size <= 0 ? null : Math.max(lh * size, size);
  };
  for (let i = 0; i < paragraphs.length; i++) {
    const prev = i > 0 ? i - 1 : i;
    const prevHeight = boxHeight(prev);
    if (prevHeight === null) continue;
    const leading = prevHeight - 0.8 * maxSize(paragraphs[prev]) + 0.8 * maxSize(paragraphs[i]);
    for (const run of paragraphs[i].runs) {
      if (run.style.leading === null) run.style.leading = Math.max(1, leading);
    }
  }
}
