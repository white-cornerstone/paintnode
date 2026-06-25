// Text layout + rasterization for editable text layers — framework-agnostic plain TS.
//
// Layout maps a TextModel to positioned lines; drawing rasterizes those lines onto a 2D
// canvas. A text layer's canvas is document-sized; text is drawn at (model.x, model.y).

import type { Rect } from '../types';
import { createCanvas, ctx2d } from '../types';
import { rgbToCss } from '../color';
import { DEFAULT_LINE_HEIGHT, defaultStyle, type TextModel, type TextRun, type TextStyle, type TextAlign } from './model';

/** Build the CSS `font` shorthand for a style. */
export function fontString(s: TextStyle): string {
  const style = s.italic ? 'italic ' : '';
  const weight = s.bold ? '700 ' : '';
  return `${style}${weight}${s.size}px ${s.family}`;
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
  fillText(text: string, x: number, y: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
}

// A shared offscreen context used for text measurement (lazy; browser only).
let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = ctx2d(createCanvas(8, 8));
  return measureCtx;
}

function fontMetrics(m: TextMeasurer, style: TextStyle): { ascent: number; descent: number } {
  m.font = fontString(style);
  const tm = m.measureText('Mg');
  return {
    ascent: tm.fontBoundingBoxAscent || style.size * 0.8,
    descent: tm.fontBoundingBoxDescent || style.size * 0.2,
  };
}

/** Advance width of a run, including tracking. */
function runWidth(m: TextMeasurer, run: TextRun): number {
  m.font = fontString(run.style);
  const base = m.measureText(run.text).width;
  return run.style.tracking ? base + run.style.tracking * run.text.length : base;
}

export interface LaidLine {
  runs: TextRun[];
  width: number;
  /** Line box height (line-height * largest font size). */
  height: number;
  /** Baseline offset from the top of the line box. */
  ascent: number;
  align: TextAlign;
}

export interface TextLayout {
  lines: LaidLine[];
  /** Width of the widest line (the text block width). */
  width: number;
  /** Sum of line heights. */
  height: number;
}

/** Lay out a model into positioned lines (one paragraph = one line in point text). */
export function layoutModel(model: TextModel, measurer: TextMeasurer = getMeasureCtx()): TextLayout {
  const lines: LaidLine[] = [];
  for (const p of model.paragraphs) {
    const runs = p.runs.length ? p.runs : [{ text: '', style: defaultLineStyle(p) }];
    let width = 0;
    let ascent = 0;
    let descent = 0;
    let maxSize = 0;
    for (const r of runs) {
      width += runWidth(measurer, r);
      const fm = fontMetrics(measurer, r.style);
      ascent = Math.max(ascent, fm.ascent);
      descent = Math.max(descent, fm.descent);
      maxSize = Math.max(maxSize, r.style.size);
    }
    const lh = (p.lineHeight || DEFAULT_LINE_HEIGHT) * (maxSize || 1);
    // Ensure the line box is at least tall enough to contain ascent + descent.
    const height = Math.max(lh, ascent + descent);
    lines.push({ runs, width, height, ascent, align: p.align });
  }
  const width = lines.reduce((mx, l) => Math.max(mx, l.width), 0);
  const height = lines.reduce((s, l) => s + l.height, 0);
  return { lines, width, height };
}

function defaultLineStyle(p: { runs: TextRun[] }): TextStyle {
  // Empty paragraph: borrow a style so blank lines still occupy vertical space.
  return p.runs[0]?.style ?? defaultStyle();
}

function drawRun(ctx: TextDrawTarget, run: TextRun, x: number, baseline: number): number {
  if (!run.style.tracking) {
    ctx.fillText(run.text, x, baseline);
    return ctx.measureText(run.text).width;
  }
  let cx = x;
  for (const ch of run.text) {
    ctx.fillText(ch, cx, baseline);
    cx += ctx.measureText(ch).width + run.style.tracking;
  }
  return cx - x;
}

/** Draw a text model into a 2D context (caller clears first if needed). */
export function drawTextModel(ctx: TextDrawTarget, model: TextModel): void {
  const layout = layoutModel(model, ctx);
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  let y = model.y;
  for (const line of layout.lines) {
    let x = model.x;
    if (line.align === 'center') x += (layout.width - line.width) / 2;
    else if (line.align === 'right') x += layout.width - line.width;
    const baseline = y + line.ascent;
    for (const run of line.runs) {
      ctx.font = fontString(run.style);
      ctx.fillStyle = rgbToCss(run.style.color);
      const advance = drawRun(ctx, run, x, baseline);
      if (run.style.underline && run.text.length) {
        const uy = baseline + Math.max(1, run.style.size * 0.12);
        ctx.fillRect(x, uy, advance, Math.max(1, run.style.size * 0.06));
      }
      x += advance;
    }
    y += line.height;
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
  const { width, height } = layoutModel(model, measurer);
  return { x: model.x, y: model.y, w: width, h: height };
}
