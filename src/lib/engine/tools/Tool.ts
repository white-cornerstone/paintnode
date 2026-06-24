import type { PaintDocument } from '../Document.svelte';
import type { Layer } from '../Layer.svelte';
import type { Viewport } from '../Viewport';
import type { History } from '../history';
import type { ActiveStroke } from '../compositor';
import type { RGB } from '../types';
import type { Selection } from '../selection';

/** Everything a tool needs from the editor, kept as a narrow interface to avoid coupling. */
export interface ToolHost {
  readonly doc: PaintDocument | null;
  readonly activeLayer: Layer | null;
  readonly viewport: Viewport | null;
  readonly history: History;
  foreground: RGB;
  background: RGB;
  brushSize: number;
  brushHardness: number;
  brushOpacity: number;
  tolerance: number;
  selection: Selection | null;
  marqueeShape: 'rect' | 'ellipse' | 'row' | 'column';
  shapeType: 'rect' | 'ellipse' | 'line';
  shapeFill: boolean;
  shapeStrokeWidth: number;
  gradientType: 'fg-bg' | 'fg-transparent';
  zoomMode: 'in' | 'out';
  /** Magic Wand: flood only the connected region (vs. every matching pixel). */
  magicContiguous: boolean;
  /** Clone Stamp: keep the source→destination offset fixed across separate strokes. */
  cloneAligned: boolean;
  /** Dodge/Burn: which tonal range the exposure targets. */
  toneRange: 'shadows' | 'midtones' | 'highlights';
  /** Sponge: increase or decrease saturation. */
  spongeMode: 'saturate' | 'desaturate';
  setActiveStroke(stroke: ActiveStroke | null): void;
  setSelection(sel: Selection | null): void;
  setForeground(rgb: RGB): void;
  /** Text tool: ask the UI to open the text dialog at a document position. */
  requestText(x: number, y: number): void;
  /** Notify reactive UI that pixels/layers changed (refresh thumbnails, history buttons). */
  bump(): void;
  invalidate(): void;
  flash(message: string): void;
}

/** Normalized pointer event passed to tools (coords in both document and CSS space). */
export interface PointerInfo {
  x: number; // document coords
  y: number;
  cssX: number; // viewport CSS coords
  cssY: number;
  dxDoc: number; // delta since last move, document space
  dyDoc: number;
  dxCss: number; // delta since last move, CSS space
  dyCss: number;
  pressure: number;
  buttons: number;
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  event: PointerEvent;
}

export interface Tool {
  readonly id: string;
  readonly name: string;
  /** CSS cursor used over the canvas. */
  readonly cursor: string;
  /** Whether the viewport should draw the brush-size ring for this tool. */
  readonly usesBrushCursor?: boolean;
  pointerDown(e: PointerInfo): void;
  pointerMove(e: PointerInfo): void;
  pointerUp(e: PointerInfo): void;
}
