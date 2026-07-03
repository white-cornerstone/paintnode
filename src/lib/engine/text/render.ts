// Text layout + rasterization for editable text layers — framework-agnostic plain TS.
//
// Layout maps a TextModel to positioned lines; drawing rasterizes those lines onto a 2D
// canvas. A text layer's canvas is document-sized; text is drawn at (model.x, model.y).
// Layout follows Photoshop's point-text rules: the baseline-to-baseline advance is the
// line's leading (max over its runs; auto = 1.2 × size), paragraphs add indents and
// space before/after, and runs can scale and shift glyphs per style.

import type { Rect } from '../types';
import { createCanvas, ctx2d } from '../types';
import { rgbToCss } from '../color';
import { AUTO_LEADING, defaultStyle, type TextAlign, type TextModel, type TextRun, type TextStyle } from './model';

/** Photoshop's default superscript/subscript glyph size and baseline offset. */
const SCRIPT_SIZE = 0.583;
const SCRIPT_SHIFT = 0.333;
/** Size of synthesized small-caps glyphs relative to the full caps size. */
const SMALL_CAPS_SIZE = 0.75;

/** Resolved per-run rendering attributes (script sizing/shift, scale factors). */
interface RunFace {
  /** Font size after superscript/subscript scaling. */
  size: number;
  /** Total baseline shift in px (positive = up). */
  shift: number;
  /** Horizontal / vertical glyph scale factors (1 = 100%). */
  h: number;
  v: number;
}

function runFace(s: TextStyle): RunFace {
  const size = s.size * (s.script === 'none' ? 1 : SCRIPT_SIZE);
  const shift =
    s.baselineShift +
    (s.script === 'super' ? s.size * SCRIPT_SHIFT : s.script === 'sub' ? -s.size * SCRIPT_SHIFT : 0);
  return { size, shift, h: s.horizontalScale / 100, v: s.verticalScale / 100 };
}

/** Build the CSS `font` shorthand for a style (at an optional size override). */
export function fontString(s: TextStyle, size = s.size): string {
  const style = s.italic ? 'italic ' : '';
  const weight = s.bold ? '700 ' : '';
  return `${style}${weight}${size}px ${s.family}`;
}

/** Minimal text-measurement surface — a 2D context satisfies it (keeps layout testable). */
export interface TextMeasurer {
  font: string;
  measureText(text: string): { width: number; fontBoundingBoxAscent?: number; fontBoundingBoxDescent?: number };
}

/** Draw surface used by {@link drawTextModel} — a 2D context satisfies it. */
export interface TextDrawTarget extends TextMeasurer {
  fillStyle: string | CanvasGradient | CanvasPattern;
  textBaseline: CanvasTextBaseline;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

// A shared offscreen context used for text measurement (lazy; browser only).
let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = ctx2d(createCanvas(8, 8));
  return measureCtx;
}

/** Segments of a run rendered with one font setting (small caps split lowercase text). */
interface RunSegment {
  text: string;
  fontSize: number;
}

function runSegments(run: TextRun, face: RunFace): RunSegment[] {
  const s = run.style;
  if (s.caps === 'all') return [{ text: run.text.toUpperCase(), fontSize: face.size }];
  if (s.caps !== 'small') return [{ text: run.text, fontSize: face.size }];
  // Synthesized small caps: lowercase letters become smaller uppercase glyphs.
  const out: RunSegment[] = [];
  let current = '';
  let currentLower = false;
  const flush = () => {
    if (!current) return;
    out.push({
      text: currentLower ? current.toUpperCase() : current,
      fontSize: currentLower ? face.size * SMALL_CAPS_SIZE : face.size,
    });
    current = '';
  };
  for (const ch of run.text) {
    const lower = ch !== ch.toUpperCase() && ch === ch.toLowerCase();
    if (current && lower !== currentLower) flush();
    currentLower = lower;
    current += ch;
  }
  flush();
  return out.length ? out : [{ text: '', fontSize: face.size }];
}

/** Baseline-to-baseline leading contributed by a run (auto = 1.2 × size, scaled). */
function effectiveLeading(s: TextStyle): number {
  return s.leading ?? AUTO_LEADING * s.size * (s.verticalScale / 100);
}

function fontMetrics(m: TextMeasurer, style: TextStyle): { ascent: number; descent: number } {
  const face = runFace(style);
  m.font = fontString(style, face.size);
  const tm = m.measureText('Mg');
  const ascent = (tm.fontBoundingBoxAscent || face.size * 0.8) * face.v;
  const descent = (tm.fontBoundingBoxDescent || face.size * 0.2) * face.v;
  // A shifted baseline extends the line box up (positive shift) or down (negative).
  return face.shift >= 0
    ? { ascent: ascent + face.shift, descent }
    : { ascent, descent: descent - face.shift };
}

/** Advance width of a run, including tracking and horizontal scale. */
function runWidth(m: TextMeasurer, run: TextRun): number {
  const face = runFace(run.style);
  let width = 0;
  for (const seg of runSegments(run, face)) {
    m.font = fontString(run.style, seg.fontSize);
    width += m.measureText(seg.text).width;
  }
  if (run.style.tracking) width += run.style.tracking * [...run.text].length;
  return width * face.h;
}

export interface LaidLine {
  runs: TextRun[];
  /** Advance width of the line's runs (excluding indents). */
  width: number;
  ascent: number;
  descent: number;
  /** Line start x relative to model.x (alignment + indents; may be negative). */
  x: number;
  /** Baseline y relative to model.y. */
  baseline: number;
  align: TextAlign;
}

export interface TextLayout {
  lines: LaidLine[];
  /** Width of the text block (widest line including its indents). */
  width: number;
  /** Total height from the block top to the last line's descent. */
  height: number;
  /** Leftmost line start relative to model.x (negative with negative indents). */
  minX: number;
}

/** Justify modes align like their base mode in point text (nothing to justify against). */
function baseAlign(align: TextAlign): 'left' | 'center' | 'right' {
  if (align === 'center' || align === 'justify-center') return 'center';
  if (align === 'right' || align === 'justify-right') return 'right';
  return 'left';
}

/** Lay out a model into positioned lines (one paragraph = one line in point text). */
export function layoutModel(model: TextModel, measurer: TextMeasurer = getMeasureCtx()): TextLayout {
  interface MeasuredLine {
    runs: TextRun[];
    width: number;
    ascent: number;
    descent: number;
    leading: number;
    left: number;
    right: number;
    spaceBefore: number;
    spaceAfter: number;
    align: TextAlign;
  }
  const measured: MeasuredLine[] = [];
  for (const p of model.paragraphs) {
    const runs = p.runs.length ? p.runs : [{ text: '', style: defaultLineStyle(p) }];
    let width = 0;
    let ascent = 0;
    let descent = 0;
    let leading = 0;
    for (const r of runs) {
      width += runWidth(measurer, r);
      const fm = fontMetrics(measurer, r.style);
      ascent = Math.max(ascent, fm.ascent);
      descent = Math.max(descent, fm.descent);
      leading = Math.max(leading, effectiveLeading(r.style));
    }
    measured.push({
      runs,
      width,
      ascent,
      descent,
      leading,
      left: p.indentLeft + p.firstLineIndent,
      right: p.indentRight,
      spaceBefore: p.spaceBefore,
      spaceAfter: p.spaceAfter,
      align: p.align,
    });
  }

  const blockWidth = measured.reduce((mx, l) => Math.max(mx, l.left + l.width + l.right), 0);

  const lines: LaidLine[] = [];
  let baseline = 0;
  let minX = 0;
  for (let i = 0; i < measured.length; i++) {
    const l = measured[i];
    baseline += i === 0 ? l.ascent : measured[i - 1].spaceAfter + l.spaceBefore + l.leading;
    const align = baseAlign(l.align);
    const x =
      align === 'center'
        ? l.left + (blockWidth - l.left - l.right - l.width) / 2
        : align === 'right'
          ? blockWidth - l.width - l.right
          : l.left;
    minX = Math.min(minX, x);
    lines.push({ runs: l.runs, width: l.width, ascent: l.ascent, descent: l.descent, x, baseline, align: l.align });
  }

  const height = lines.length ? baseline + (measured.at(-1)?.descent ?? 0) : 0;
  return { lines, width: blockWidth, height, minX };
}

function defaultLineStyle(p: { runs: TextRun[] }): TextStyle {
  // Empty paragraph: borrow a style so blank lines still occupy vertical space.
  return p.runs[0]?.style ?? defaultStyle();
}

/**
 * Draw one run at (x, baseline) in document space; returns the run's advance width.
 * Glyph scales are applied with a canvas transform so decorations scale with the text.
 */
function drawRun(ctx: TextDrawTarget, run: TextRun, x: number, baseline: number): number {
  const s = run.style;
  const face = runFace(s);
  const transformed = face.h !== 1 || face.v !== 1;
  ctx.save();
  if (transformed) {
    ctx.translate(x, baseline - face.shift);
    ctx.scale(face.h, face.v);
  }
  const ox = transformed ? 0 : x;
  const oy = transformed ? 0 : baseline - face.shift;
  let cx = ox;
  for (const seg of runSegments(run, face)) {
    ctx.font = fontString(s, seg.fontSize);
    if (s.tracking) {
      for (const ch of seg.text) {
        ctx.fillText(ch, cx, oy);
        cx += ctx.measureText(ch).width + s.tracking;
      }
    } else {
      ctx.fillText(seg.text, cx, oy);
      cx += ctx.measureText(seg.text).width;
    }
  }
  const natural = cx - ox;
  if (run.text.length && (s.underline || s.strikethrough)) {
    const thickness = Math.max(1, face.size * 0.06);
    if (s.underline) ctx.fillRect(ox, oy + Math.max(1, face.size * 0.12), natural, thickness);
    if (s.strikethrough) ctx.fillRect(ox, oy - face.size * 0.28, natural, thickness);
  }
  ctx.restore();
  return natural * face.h;
}

/** Draw a text model into a 2D context (caller clears first if needed). */
export function drawTextModel(ctx: TextDrawTarget, model: TextModel): void {
  const layout = layoutModel(model, ctx);
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  for (const line of layout.lines) {
    let x = model.x + line.x;
    const baseline = model.y + line.baseline;
    for (const run of line.runs) {
      ctx.fillStyle = rgbToCss(run.style.color);
      x += drawRun(ctx, run, x, baseline);
    }
  }
  ctx.restore();
}

/** Clear `canvas` and rasterize the model into it. */
export function renderTextToCanvas(canvas: HTMLCanvasElement, model: TextModel): void {
  const ctx = ctx2d(canvas);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawTextModel(ctx, model);
}

export function measureTextModel(
  model: TextModel,
  measurer: TextMeasurer = getMeasureCtx(),
): { width: number; height: number } {
  const { width, height } = layoutModel(model, measurer);
  return { width, height };
}

/** Document-space bounding box of the rendered text (for hit-testing). */
export function textBounds(model: TextModel, measurer: TextMeasurer = getMeasureCtx()): Rect {
  const { width, height, minX } = layoutModel(model, measurer);
  return { x: model.x + minX, y: model.y, w: width - minX, h: height };
}
