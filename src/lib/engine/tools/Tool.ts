import type { PaintDocument } from '../Document.svelte';
import type { Layer } from '../Layer.svelte';
import type { Viewport } from '../Viewport';
import type { History } from '../history';
import type { ActiveStroke } from '../compositor';
import type { RGB } from '../types';
import type { Selection, SelectionMode } from '../selection';
import type { AiRetouchGesture, AiRetouchPreview, AiRetouchToolId } from '../aiRetouch';

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
  aiRetouchBrushFeather: number;
  tolerance: number;
  selection: Selection | null;
  selectionMode: SelectionMode;
  marqueeShape: 'rect' | 'ellipse' | 'row' | 'column';
  shapeType: 'rect' | 'ellipse' | 'line';
  shapeFill: boolean;
  shapeStrokeWidth: number;
  annotationType: 'arrow' | 'note' | 'callout' | 'badge' | 'divider';
  annotationText: string;
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
  /** AI Patch: whether the drawn area is repaired from, or copied to, the drag target. */
  aiRetouchPatchMode: 'source' | 'destination';
  /** AI Content-Aware Move: move a subject or extend/contract it. */
  aiRetouchMoveMode: 'move' | 'extend';
  /** AI Healing Brush: sampled source point in document space. */
  aiRetouchHealingSource: { x: number; y: number } | null;
  setActiveStroke(stroke: ActiveStroke | null): void;
  setSelection(sel: Selection | null): void;
  setForeground(rgb: RGB): void;
  commitAiRetouchMaskGesture(toolId: AiRetouchToolId, gesture: AiRetouchGesture, mask: HTMLCanvasElement, mode: SelectionMode): void;
  setAiRetouchMaskReference(toolId: AiRetouchToolId, updates: Partial<NonNullable<Layer['aiRetouch']>>): void;
  setAiRetouchHealingSource(source: { x: number; y: number }): void;
  setAiRetouchPreview(preview: AiRetouchPreview | null): void;
  /** Type tool: begin editing at a document position (new text, or the text layer there). */
  beginText(x: number, y: number, options?: { orientation?: 'horizontal' | 'vertical'; mask?: boolean }): void;
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
  /** True if the tool mutates the active layer's pixels (used to guard text layers). */
  readonly editsPixels?: boolean;
  pointerDown(e: PointerInfo): void;
  pointerMove(e: PointerInfo): void;
  pointerUp(e: PointerInfo): void;
}
