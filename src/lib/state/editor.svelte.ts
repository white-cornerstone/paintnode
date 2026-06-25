import { PaintDocument } from '../engine/Document.svelte';
import { Layer } from '../engine/Layer.svelte';
import type { Viewport } from '../engine/Viewport';
import { History, pixelCommand, snapshotLayer, snapshotRegion, type Command } from '../engine/history';
import type { ActiveStroke } from '../engine/compositor';
import { compositeToCanvas } from '../engine/compositor';
import type { RGB, Rect } from '../engine/types';
import { clampRect, createCanvas, ctx2d } from '../engine/types';
import type { Selection } from '../engine/selection';
import {
  selectAllSelection,
  invertSelection as invertSelectionMask,
  intersectMask,
} from '../engine/selection';
import { rgbToCss } from '../engine/color';
import {
  invertPixel,
  desaturatePixel,
  makeBrightnessContrast,
  makeHueSaturation,
  type PixelOp,
} from '../engine/adjustments';
import { gaussianBlur, sharpen } from '../engine/filters';
import {
  DEFAULT_LINE_HEIGHT,
  cloneModel,
  defaultStyle,
  isBlankModel,
  textLayerName,
  type TextModel,
  type TextStyle,
} from '../engine/text/model';
import { renderTextToCanvas, textBounds } from '../engine/text/render';
import type { Tool, ToolHost } from '../engine/tools/Tool';
import { PaintTool } from '../engine/tools/PaintTool';
import { FillTool } from '../engine/tools/FillTool';
import { EyedropperTool } from '../engine/tools/EyedropperTool';
import { MoveTool } from '../engine/tools/MoveTool';
import { MarqueeTool } from '../engine/tools/MarqueeTool';
import { LassoTool } from '../engine/tools/LassoTool';
import { MagicWandTool } from '../engine/tools/MagicWandTool';
import { CropTool } from '../engine/tools/CropTool';
import { ShapeTool } from '../engine/tools/ShapeTool';
import { GradientTool } from '../engine/tools/GradientTool';
import { TextTool } from '../engine/tools/TextTool';
import { CloneStampTool } from '../engine/tools/CloneStampTool';
import { SmudgeTool } from '../engine/tools/SmudgeTool';
import { FocusTool } from '../engine/tools/FocusTool';
import { ToningTool } from '../engine/tools/ToningTool';
import { HandTool, ZoomTool } from '../engine/tools/NavTools';

export interface PlacedImageResult {
  oversized: boolean;
  layerId: string | null;
}

export interface LayerSourceMeta {
  assetId?: string | null;
  path?: string | null;
}

export interface DecoupledLayerImport {
  name: string;
  source: CanvasImageSource;
  width: number;
  height: number;
  x?: number | null;
  y?: number | null;
  opacity?: number | null;
  visible?: boolean | null;
  sourceMeta?: LayerSourceMeta;
}

/** An in-progress text edit driven by the on-canvas TextEditorOverlay. */
export interface TextEditSession {
  /** Layer being edited, or null when creating a new text layer. */
  layerId: string | null;
  isNew: boolean;
  /** Working model; its x/y are the document-space top-left of the text box. */
  model: TextModel;
  /** Style used for new/empty text and as the toolbar's starting values. */
  baseStyle: TextStyle;
}

export interface DocumentSession {
  id: string;
  doc: PaintDocument;
  history: History;
  selection: Selection | null;
  revision: number;
  savedRevision: number;
  autosavedRevision: number;
  savedPath: string | null;
  autosavePath: string | null;
  /** Remembered "embed fonts?" choice for this document (null = ask on next save). */
  embedFonts: boolean | null;
}

export class EditorStore implements ToolHost {
  doc = $state<PaintDocument | null>(null);
  documents = $state<DocumentSession[]>([]);
  activeDocumentId = $state<string | null>(null);
  viewport: Viewport | null = null;
  history = new History(60);

  foreground = $state<RGB>({ r: 0, g: 0, b: 0 });
  background = $state<RGB>({ r: 255, g: 255, b: 255 });

  brushSize = $state(24);
  brushHardness = $state(0.85);
  brushOpacity = $state(1);
  tolerance = $state(24);
  selection = $state<Selection | null>(null);
  marqueeShape = $state<'rect' | 'ellipse' | 'row' | 'column'>('rect');
  clipboard = $state<{ canvas: HTMLCanvasElement; x: number; y: number } | null>(null);

  // Shape tool
  shapeType = $state<'rect' | 'ellipse' | 'line'>('rect');
  shapeFill = $state(true);
  shapeStrokeWidth = $state(4);
  // Gradient tool
  gradientType = $state<'fg-bg' | 'fg-transparent'>('fg-bg');
  // Zoom tool mode (click zooms in or out); Alt inverts momentarily.
  zoomMode = $state<'in' | 'out'>('in');
  // Selection / retouch options shared with tool implementations.
  magicContiguous = $state(true);
  cloneAligned = $state(true);
  toneRange = $state<'shadows' | 'midtones' | 'highlights'>('midtones');
  spongeMode = $state<'saturate' | 'desaturate'>('saturate');
  /** Whether Alt/Option is currently held — drives the live zoom-mode preview. */
  altDown = $state(false);
  // Type tool: the active on-canvas text edit session (null = not editing).
  textEdit = $state<TextEditSession | null>(null);
  // Set when a pixel tool is used on a text layer — drives the "rasterize first?" prompt.
  rasterizePrompt = $state<{ layerId: string; name: string } | null>(null);
  // Remembered Type-tool defaults for the next new text layer.
  lastFontFamily = $state('sans-serif');
  lastFontSize = $state(72);
  /** Set by the text overlay so other UI (e.g. canvas clicks) can commit the edit. */
  private textCommitFn: (() => void) | null = null;

  activeToolId = $state('brush');
  flashMessage = $state('');
  /** Bumped on any change that reactive UI (thumbnails, history buttons) should observe. */
  rev = $state(0);

  private activeStroke: ActiveStroke | null = null;
  private flashTimer = 0;
  readonly tools: Record<string, Tool> = {};

  constructor() {
    this.attachHistory(this.history);
    for (const t of [
      new MoveTool(this),
      new MarqueeTool(this),
      new LassoTool(this),
      new MagicWandTool(this),
      new CropTool(this),
      new PaintTool(this, 'brush'),
      new PaintTool(this, 'eraser'),
      new CloneStampTool(this),
      new FillTool(this),
      new GradientTool(this),
      new SmudgeTool(this),
      new FocusTool(this, 'blur'),
      new FocusTool(this, 'sharpen'),
      new ToningTool(this, 'dodge'),
      new ToningTool(this, 'burn'),
      new ToningTool(this, 'sponge'),
      new ShapeTool(this),
      new TextTool(this),
      new EyedropperTool(this),
      new HandTool(this),
      new ZoomTool(this),
    ]) {
      this.tools[t.id] = t;
    }
    this.openDocument(PaintDocument.blank(1280, 800, 'Untitled'), false);
  }

  // --- Derived state ---
  get activeLayer(): Layer | null {
    return this.doc?.activeLayer ?? null;
  }
  get activeTool(): Tool {
    return this.tools[this.activeToolId] ?? this.tools.brush;
  }
  get foregroundCss(): string {
    return rgbToCss(this.foreground);
  }
  get backgroundCss(): string {
    return rgbToCss(this.background);
  }
  /** Zoom direction the cursor will apply right now (Alt momentarily inverts zoomMode). */
  get effectiveZoomMode(): 'in' | 'out' {
    return this.altDown ? (this.zoomMode === 'in' ? 'out' : 'in') : this.zoomMode;
  }
  get canUndo(): boolean {
    this.rev; // reactive dependency
    return this.history.canUndo;
  }
  get canRedo(): boolean {
    this.rev;
    return this.history.canRedo;
  }
  get undoLabel(): string {
    this.rev;
    return this.history.undoLabel;
  }
  get redoLabel(): string {
    this.rev;
    return this.history.redoLabel;
  }

  get activeDocument(): DocumentSession | null {
    return this.documents.find((d) => d.id === this.activeDocumentId) ?? null;
  }

  get documentTabs(): DocumentSession[] {
    this.rev;
    return this.documents;
  }

  private attachHistory(history: History): void {
    this.history = history;
    this.history.onChange = () => {
      this.bump();
      this.viewport?.invalidate();
    };
  }

  private makeSession(doc: PaintDocument): DocumentSession {
    return {
      id: doc.id,
      doc,
      history: new History(60),
      selection: null,
      revision: 0,
      savedRevision: 0,
      autosavedRevision: 0,
      savedPath: null,
      autosavePath: null,
      embedFonts: null,
    };
  }

  private notify(markDocumentChanged = false): void {
    this.rev++;
    if (markDocumentChanged) {
      const session = this.activeDocument;
      if (session) session.revision++;
    }
  }

  // --- ToolHost impl ---
  setActiveStroke(stroke: ActiveStroke | null): void {
    this.activeStroke = stroke;
    this.viewport?.invalidate();
  }
  getActiveStroke(): ActiveStroke | null {
    return this.activeStroke;
  }
  setSelection(sel: Selection | null): void {
    this.selection = sel;
    const session = this.activeDocument;
    if (session) session.selection = sel;
    this.viewport?.invalidate();
  }
  getSelection(): Selection | null {
    return this.selection;
  }
  setForeground(rgb: RGB): void {
    this.foreground = rgb;
  }
  beginText(x: number, y: number): void {
    const doc = this.doc;
    if (!doc) return;
    const hit = this.textLayerAt(x, y);
    if (hit) {
      this.beginEditLayer(hit);
      return;
    }
    const style = defaultStyle({
      family: this.lastFontFamily,
      size: this.lastFontSize,
      color: { ...this.foreground },
    });
    const model: TextModel = {
      version: 1,
      x: Math.round(x),
      y: Math.round(y),
      paragraphs: [{ align: 'left', lineHeight: DEFAULT_LINE_HEIGHT, runs: [{ text: '', style }] }],
    };
    this.textEdit = { layerId: null, isNew: true, model, baseStyle: style };
  }
  bump(): void {
    this.notify(true);
  }
  invalidate(): void {
    this.viewport?.invalidateComposite();
  }
  flash(message: string): void {
    this.flashMessage = message;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => (this.flashMessage = ''), 1800);
  }

  // --- Tools / colors ---
  setTool(id: string): void {
    if (this.tools[id]) this.activeToolId = id;
  }
  swapColors(): void {
    const fg = this.foreground;
    this.foreground = this.background;
    this.background = fg;
  }
  resetColors(): void {
    this.foreground = { r: 0, g: 0, b: 0 };
    this.background = { r: 255, g: 255, b: 255 };
  }

  // --- Selection ---
  selectAll(): void {
    const doc = this.doc;
    if (!doc) return;
    this.setSelection(selectAllSelection(doc.width, doc.height));
  }
  deselect(): void {
    this.setSelection(null);
  }
  invertSelection(): void {
    const doc = this.doc;
    if (doc && this.selection) {
      this.setSelection(invertSelectionMask(this.selection, doc.width, doc.height));
    }
  }
  private docRectToLayerRect(rect: Rect, layer: Layer): Rect | null {
    return clampRect({ x: rect.x - layer.x, y: rect.y - layer.y, w: rect.w, h: rect.h }, layer.width, layer.height);
  }

  private selectionMaskForLayer(layer: Layer): HTMLCanvasElement | null {
    const sel = this.selection;
    if (!sel) return null;
    const mask = createCanvas(layer.width, layer.height);
    ctx2d(mask).drawImage(sel.mask, -layer.x, -layer.y);
    return mask;
  }

  private editRegion(layer: Layer): Rect {
    const sel = this.selection;
    if (sel) {
      return this.docRectToLayerRect(sel.bounds, layer) ?? { x: 0, y: 0, w: layer.width, h: layer.height };
    }
    return { x: 0, y: 0, w: layer.width, h: layer.height };
  }

  // --- Clipboard (cut / copy / paste) ---
  copy(): void {
    const layer = this.activeLayer;
    if (!layer) return;
    const sel = this.selection;
    if (!sel) {
      const buf = createCanvas(layer.width, layer.height);
      ctx2d(buf).drawImage(layer.canvas, 0, 0);
      this.clipboard = { canvas: buf, x: layer.x, y: layer.y };
      this.flash('Copied');
      return;
    }
    const bounds = clampRect(sel.bounds, this.doc!.width, this.doc!.height);
    if (!bounds) return;
    const buf = createCanvas(bounds.w, bounds.h);
    const c = ctx2d(buf);
    c.drawImage(layer.canvas, layer.x - bounds.x, layer.y - bounds.y);
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(sel.mask, -bounds.x, -bounds.y);
    c.globalCompositeOperation = 'source-over';
    this.clipboard = { canvas: buf, x: bounds.x, y: bounds.y };
    this.flash('Copied');
  }
  cut(): void {
    if (!this.activeLayer) return;
    this.copy();
    this.clearActive();
    this.flash('Cut');
  }
  paste(): void {
    const doc = this.doc;
    const clip = this.clipboard;
    if (!doc || !clip) return;
    this.structural('Paste', () => {
      const layer = new Layer(clip.canvas.width, clip.canvas.height, 'Pasted', undefined, clip.x, clip.y);
      layer.ctx.drawImage(clip.canvas, 0, 0);
      layer.touch();
      doc.insertAboveActive(layer);
    });
    this.flash('Pasted');
  }

  // --- History ---
  undo(): void {
    this.history.undo();
  }
  redo(): void {
    this.history.redo();
  }

  // --- Documents ---
  openDocument(doc: PaintDocument, focus = true): void {
    const session = this.makeSession(doc);
    this.documents = [...this.documents, session];
    if (focus) this.switchDocument(session.id);
    else if (!this.activeDocumentId) this.switchDocument(session.id);
  }

  setDocument(doc: PaintDocument): void {
    const session = this.makeSession(doc);
    const currentId = this.activeDocumentId;
    const idx = currentId ? this.documents.findIndex((d) => d.id === currentId) : -1;
    if (idx >= 0) {
      const next = this.documents.slice();
      next[idx] = session;
      this.documents = next;
    } else {
      this.documents = [...this.documents, session];
    }
    this.doc = doc;
    this.activeStroke = null;
    this.activeDocumentId = session.id;
    this.selection = session.selection;
    this.attachHistory(session.history);
    this.notify();
    requestAnimationFrame(() => {
      this.viewport?.fitToView();
      this.viewport?.invalidate();
    });
  }

  switchDocument(id: string): void {
    const session = this.documents.find((d) => d.id === id);
    if (!session || session.id === this.activeDocumentId) return;
    const current = this.activeDocument;
    if (current) current.selection = this.selection;
    this.activeDocumentId = session.id;
    this.doc = session.doc;
    this.selection = session.selection;
    this.activeStroke = null;
    this.attachHistory(session.history);
    this.notify();
    requestAnimationFrame(() => {
      this.viewport?.fitToView();
      this.viewport?.invalidate();
    });
  }

  closeDocument(id: string): void {
    if (this.documents.length <= 1) {
      this.flash('Keep at least one document open');
      return;
    }
    const idx = this.documents.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const wasActive = this.activeDocumentId === id;
    const next = this.documents.slice();
    next.splice(idx, 1);
    this.documents = next;
    if (wasActive) {
      const fallback = next[Math.min(idx, next.length - 1)];
      this.activeDocumentId = null;
      if (fallback) this.switchDocument(fallback.id);
    } else {
      this.notify();
    }
  }

  markSaved(relativePath: string | null): void {
    const session = this.activeDocument;
    if (!session) return;
    session.savedPath = relativePath;
    session.savedRevision = session.revision;
    this.notify();
  }

  renameActiveDocument(name: string): void {
    const session = this.activeDocument;
    const next = name.trim();
    if (!session || !next) return;
    session.doc.name = next;
    this.notify();
  }

  markAutosaved(docId: string, relativePath: string | null): void {
    const session = this.documents.find((d) => d.id === docId);
    if (!session) return;
    session.autosavePath = relativePath;
    session.autosavedRevision = session.revision;
    this.notify();
  }

  hasUnsavedChanges(session: DocumentSession): boolean {
    return session.revision !== session.savedRevision;
  }

  needsAutosave(session: DocumentSession): boolean {
    return session.revision !== session.autosavedRevision;
  }

  newDocument(width: number, height: number, name: string, fillWhite: boolean): void {
    const doc = PaintDocument.blank(width, height, name);
    if (fillWhite && doc.activeLayer) doc.activeLayer.fill('#ffffff');
    this.openDocument(doc);
  }

  // --- Layer structural ops (undoable) ---
  private structural(label: string, mutate: () => void, refit = false): void {
    const doc = this.doc;
    if (!doc) return;
    const snap = () => ({
      layers: doc.layers.slice(),
      active: doc.activeLayerId,
      w: doc.width,
      h: doc.height,
    });
    const before = snap();
    mutate();
    const after = snap();
    const restore = (s: ReturnType<typeof snap>) => {
      doc.width = s.w;
      doc.height = s.h;
      doc.layers = s.layers.slice();
      doc.activeLayerId = s.active;
      this.bump();
      this.invalidate();
      if (refit) this.viewport?.fitToView();
    };
    const cmd: Command = { label, undo: () => restore(before), redo: () => restore(after) };
    this.history.push(cmd);
    this.bump();
    this.invalidate();
    if (refit) requestAnimationFrame(() => this.viewport?.fitToView());
  }

  /** Build a new layer that maps the old one through `paint` (used by transforms). */
  private remapLayers(nw: number, nh: number, paint: (c: CanvasRenderingContext2D, l: Layer) => void): Layer[] {
    const doc = this.doc!;
    return doc.layers.map((l) => {
      const nl = new Layer(nw, nh, l.name);
      nl.opacity = l.opacity;
      nl.visible = l.visible;
      nl.blendMode = l.blendMode;
      paint(nl.ctx, l);
      nl.touch();
      return nl;
    });
  }

  private commitLayers(layers: Layer[], nw: number, nh: number): void {
    const doc = this.doc!;
    const idx = doc.activeLayerId ? doc.indexOf(doc.activeLayerId) : layers.length - 1;
    doc.width = nw;
    doc.height = nh;
    doc.layers = layers;
    doc.activeLayerId = layers[Math.max(0, idx)]?.id ?? null;
  }

  // --- Image transforms (undoable) ---
  cropToSelection(): void {
    const doc = this.doc;
    const sel = this.selection;
    if (!doc) return;
    const rect = sel ? clampRect(sel.bounds, doc.width, doc.height) : null;
    if (!rect) {
      this.flash('Make a selection to crop');
      return;
    }
    this.structural(
      'Crop',
      () => this.commitLayers(
        this.remapLayers(rect.w, rect.h, (c, l) => c.drawImage(l.canvas, l.x - rect.x, l.y - rect.y)),
        rect.w,
        rect.h,
      ),
      true,
    );
    this.setSelection(null);
  }

  resizeImage(w: number, h: number): void {
    const doc = this.doc;
    if (!doc) return;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === doc.width && h === doc.height) return;
    const sx = w / doc.width;
    const sy = h / doc.height;
    this.structural(
      'Image Size',
      () => {
        const layers = doc.layers.map((l) => {
          const nw = Math.max(1, Math.round(l.width * sx));
          const nh = Math.max(1, Math.round(l.height * sy));
          const nl = new Layer(nw, nh, l.name);
          nl.x = Math.round(l.x * sx);
          nl.y = Math.round(l.y * sy);
          nl.opacity = l.opacity;
          nl.visible = l.visible;
          nl.blendMode = l.blendMode;
          nl.ctx.imageSmoothingEnabled = true;
          nl.ctx.imageSmoothingQuality = 'high';
          nl.ctx.drawImage(l.canvas, 0, 0, l.width, l.height, 0, 0, nw, nh);
          nl.touch();
          return nl;
        });
        this.commitLayers(layers, w, h);
      },
      true,
    );
    this.setSelection(null);
  }

  revealAll(): void {
    const doc = this.doc;
    if (!doc) return;
    const visible = doc.layers.filter((l) => l.visible);
    if (!visible.length) return;
    const minX = Math.min(0, ...visible.map((l) => l.x));
    const minY = Math.min(0, ...visible.map((l) => l.y));
    const maxX = Math.max(doc.width, ...visible.map((l) => l.x + l.width));
    const maxY = Math.max(doc.height, ...visible.map((l) => l.y + l.height));
    const nw = Math.max(1, maxX - minX);
    const nh = Math.max(1, maxY - minY);
    if (nw === doc.width && nh === doc.height && minX === 0 && minY === 0) {
      this.flash('Nothing outside the canvas');
      return;
    }
    this.structural(
      'Reveal All',
      () => {
        const layers = doc.layers.map((l) => {
          const nl = l.clone(l.name);
          nl.x = l.x - minX;
          nl.y = l.y - minY;
          return nl;
        });
        this.commitLayers(layers, nw, nh);
      },
      true,
    );
    this.setSelection(null);
  }

  rotate(deg: 90 | 180 | 270): void {
    const doc = this.doc;
    if (!doc) return;
    const swap = deg === 90 || deg === 270;
    const nw = swap ? doc.height : doc.width;
    const nh = swap ? doc.width : doc.height;
    this.structural(
      `Rotate ${deg}°`,
      () => this.commitLayers(
        this.remapLayers(nw, nh, (c, l) => {
          if (deg === 90) {
            c.translate(nw, 0);
            c.rotate(Math.PI / 2);
          } else if (deg === 180) {
            c.translate(nw, nh);
            c.rotate(Math.PI);
          } else {
            c.translate(0, nh);
            c.rotate(-Math.PI / 2);
          }
          c.drawImage(l.canvas, l.x, l.y);
        }),
        nw,
        nh,
      ),
      true,
    );
    this.setSelection(null);
  }

  flip(axis: 'h' | 'v'): void {
    const doc = this.doc;
    if (!doc) return;
    this.structural(axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical', () =>
      this.commitLayers(
        this.remapLayers(doc.width, doc.height, (c, l) => {
          if (axis === 'h') {
            c.translate(doc.width, 0);
            c.scale(-1, 1);
          } else {
            c.translate(0, doc.height);
            c.scale(1, -1);
          }
          c.drawImage(l.canvas, l.x, l.y);
        }),
        doc.width,
        doc.height,
      ),
    );
    this.setSelection(null);
  }

  addLayer(): void {
    this.structural('New Layer', () => this.doc!.newLayer());
  }
  deleteLayer(id: string): void {
    const doc = this.doc;
    if (!doc || doc.layers.length <= 1) {
      this.flash('Cannot delete the only layer');
      return;
    }
    this.structural('Delete Layer', () => doc.remove(id));
  }
  duplicateLayer(id: string): void {
    this.structural('Duplicate Layer', () => this.doc!.duplicate(id));
  }
  moveLayer(id: string, delta: number): void {
    this.structural('Reorder Layer', () => this.doc!.move(id, delta));
  }
  reorderLayer(from: number, to: number): void {
    this.structural('Reorder Layer', () => this.doc!.reorder(from, to));
  }

  mergeDown(id: string): void {
    const doc = this.doc;
    if (!doc) return;
    const idx = doc.indexOf(id);
    if (idx <= 0) {
      this.flash('No layer below to merge into');
      return;
    }
    this.structural('Merge Down', () => {
      const above = doc.layers[idx];
      const below = doc.layers[idx - 1];
      const minX = Math.min(below.x, above.x);
      const minY = Math.min(below.y, above.y);
      const maxX = Math.max(below.x + below.width, above.x + above.width);
      const maxY = Math.max(below.y + below.height, above.y + above.height);
      const merged = new Layer(maxX - minX, maxY - minY, below.name, undefined, minX, minY);
      merged.blendMode = below.blendMode;
      merged.opacity = below.opacity;
      merged.visible = below.visible;
      const c = merged.ctx;
      c.drawImage(below.canvas, below.x - minX, below.y - minY);
      c.globalAlpha = above.opacity;
      c.globalCompositeOperation = above.blendMode;
      c.drawImage(above.canvas, above.x - minX, above.y - minY);
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      merged.touch();
      const next = doc.layers.slice();
      next.splice(idx - 1, 2, merged);
      doc.layers = next;
      doc.activeLayerId = merged.id;
    });
  }

  flatten(): void {
    const doc = this.doc;
    if (!doc || doc.layers.length <= 1) return;
    this.structural('Flatten Image', () => {
      const flat = new Layer(doc.width, doc.height, 'Background');
      flat.ctx.drawImage(compositeToCanvas(doc), 0, 0);
      flat.touch();
      doc.layers = [flat];
      doc.activeLayerId = flat.id;
    });
  }

  // --- Adjustments (active layer, selection-aware, undoable) ---
  private applyPixelOp(label: string, op: PixelOp): void {
    const layer = this.activeLayer;
    if (!layer) {
      this.flash('No active layer');
      return;
    }
    const region = this.editRegion(layer);
    const before = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    const img = layer.ctx.getImageData(0, 0, layer.width, layer.height);
    const d = img.data;
    const w = layer.width;
    const mask = this.selectionMaskForLayer(layer);
    const md = mask ? ctx2d(mask).getImageData(0, 0, w, layer.height).data : null;
    for (let y = 0; y < layer.height; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (md && md[i + 3] < 128) continue;
        if (d[i + 3] === 0) continue;
        op(d, i);
      }
    }
    layer.ctx.putImageData(img, 0, 0);
    layer.touch();
    const after = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    this.history.push(pixelCommand(layer, before, after, label));
    this.bump();
    this.invalidate();
  }
  adjustInvert(): void {
    this.applyPixelOp('Invert', invertPixel);
  }
  adjustDesaturate(): void {
    this.applyPixelOp('Desaturate', desaturatePixel);
  }
  adjustBrightnessContrast(brightness: number, contrast: number): void {
    this.applyPixelOp('Brightness/Contrast', makeBrightnessContrast(brightness, contrast));
  }
  adjustHueSaturation(hue: number, saturation: number, lightness: number): void {
    this.applyPixelOp('Hue/Saturation', makeHueSaturation(hue, saturation, lightness));
  }

  // --- Filters (active layer, selection-aware, undoable) ---
  private applyFilter(label: string, fn: (src: HTMLCanvasElement) => HTMLCanvasElement): void {
    const layer = this.activeLayer;
    if (!layer) {
      this.flash('No active layer');
      return;
    }
    const region = this.editRegion(layer);
    const before = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    const filtered = fn(layer.canvas);
    const mask = this.selectionMaskForLayer(layer);
    layer.ctx.save();
    if (mask) {
      const masked = intersectMask(filtered, mask);
      layer.ctx.globalCompositeOperation = 'destination-out';
      layer.ctx.drawImage(mask, 0, 0);
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.drawImage(masked, 0, 0);
    } else {
      layer.ctx.clearRect(0, 0, layer.width, layer.height);
      layer.ctx.drawImage(filtered, 0, 0);
    }
    layer.ctx.restore();
    layer.touch();
    const after = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    this.history.push(pixelCommand(layer, before, after, label));
    this.bump();
    this.invalidate();
  }
  filterGaussianBlur(radius: number): void {
    this.applyFilter('Gaussian Blur', (src) => gaussianBlur(src, radius));
  }
  filterSharpen(amount: number): void {
    this.applyFilter('Sharpen', (src) => sharpen(src, amount));
  }

  // --- Pixel ops (undoable) ---
  clearActive(): void {
    const layer = this.activeLayer;
    if (!layer) return;
    const region = this.editRegion(layer);
    const before = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    const mask = this.selectionMaskForLayer(layer);
    if (mask) {
      layer.ctx.save();
      layer.ctx.globalCompositeOperation = 'destination-out';
      layer.ctx.drawImage(mask, 0, 0);
      layer.ctx.restore();
    } else {
      layer.ctx.clearRect(0, 0, layer.width, layer.height);
    }
    layer.touch();
    const after = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    this.history.push(pixelCommand(layer, before, after, 'Clear'));
    this.bump();
    this.invalidate();
  }
  fillActive(rgb: RGB): void {
    const layer = this.activeLayer;
    if (!layer) {
      this.flash('No active layer');
      return;
    }
    const region = this.editRegion(layer);
    const before = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    const mask = this.selectionMaskForLayer(layer);
    layer.ctx.save();
    layer.ctx.globalCompositeOperation = 'source-over';
    if (mask) {
      const tmp = createCanvas(layer.width, layer.height);
      const tc = ctx2d(tmp);
      tc.fillStyle = rgbToCss(rgb);
      tc.fillRect(0, 0, layer.width, layer.height);
      layer.ctx.drawImage(intersectMask(tmp, mask), 0, 0);
    } else {
      layer.ctx.fillStyle = rgbToCss(rgb);
      layer.ctx.fillRect(0, 0, layer.width, layer.height);
    }
    layer.ctx.restore();
    layer.touch();
    const after = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    this.history.push(pixelCommand(layer, before, after, 'Fill'));
    this.bump();
    this.invalidate();
  }

  // --- Text editing (undoable) ---

  /** Topmost visible text layer whose rendered bounds contain (x, y), else null. */
  private textLayerAt(x: number, y: number): Layer | null {
    const doc = this.doc;
    if (!doc) return null;
    const pad = 4;
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const l = doc.layers[i];
      if (l.kind !== 'text' || !l.text || !l.visible) continue;
      const b = textBounds(l.text);
      const rx = b.x + l.x;
      const ry = b.y + l.y;
      if (x >= rx - pad && x <= rx + b.w + pad && y >= ry - pad && y <= ry + b.h + pad) return l;
    }
    return null;
  }

  private beginEditLayer(layer: Layer): void {
    if (!layer.text) return;
    this.doc?.setActive(layer.id);
    // Fold any layer offset (from the Move tool) into the working model's position.
    const model = cloneModel(layer.text);
    model.x += layer.x;
    model.y += layer.y;
    layer.suppressed = true; // hide pixels; the overlay shows live text
    const baseStyle = model.paragraphs[0]?.runs[0]?.style ?? defaultStyle();
    this.textEdit = { layerId: layer.id, isNew: false, model, baseStyle };
    this.bump();
    this.invalidate();
  }

  /** Overlay registers/clears a callback so a canvas click can commit the active edit. */
  registerTextCommit(fn: (() => void) | null): void {
    this.textCommitFn = fn;
  }
  commitActiveText(): void {
    this.textCommitFn?.();
  }

  /** Finish the active edit, applying `model` (undoable). */
  commitText(model: TextModel): void {
    const session = this.textEdit;
    const doc = this.doc;
    this.textEdit = null;
    this.textCommitFn = null;
    if (!doc || !session) return;
    const blank = isBlankModel(model);

    if (session.isNew) {
      if (blank) {
        this.bump();
        this.invalidate();
        return; // nothing typed → no layer
      }
      this.rememberTextDefaults(model);
      this.structural('Text', () => {
        const layer = new Layer(doc.width, doc.height, textLayerName(model));
        layer.kind = 'text';
        layer.text = cloneModel(model);
        renderTextToCanvas(layer.canvas, layer.text);
        layer.touch();
        doc.insertAboveActive(layer);
      });
      return;
    }

    const layer = doc.layers.find((l) => l.id === session.layerId);
    if (!layer) {
      this.bump();
      this.invalidate();
      return;
    }
    layer.suppressed = false;
    if (blank) {
      // All text deleted → remove the layer (Photoshop-style), unless it's the only one.
      if (doc.layers.length > 1) {
        this.structural('Delete Text', () => doc.remove(layer.id));
      } else {
        this.bump();
        this.invalidate();
      }
      return;
    }
    this.rememberTextDefaults(model);
    this.applyTextEdit(layer, model);
  }

  /** Cancel the active edit without changing pixels/model. */
  cancelText(): void {
    const session = this.textEdit;
    this.textEdit = null;
    this.textCommitFn = null;
    if (!session) return;
    if (!session.isNew && session.layerId) {
      const layer = this.doc?.layers.find((l) => l.id === session.layerId);
      if (layer) layer.suppressed = false;
    }
    this.bump();
    this.invalidate();
  }

  private rememberTextDefaults(model: TextModel): void {
    const style = model.paragraphs[0]?.runs[0]?.style;
    if (style) {
      this.lastFontFamily = style.family;
      this.lastFontSize = style.size;
    }
  }

  /** Apply an edit to an existing text layer with an undoable, region-snapshotted command. */
  private applyTextEdit(layer: Layer, newModel: TextModel): void {
    const doc = this.doc!;
    const beforeModel = layer.text ? cloneModel(layer.text) : null;
    const bx = layer.x;
    const by = layer.y;
    const region = this.unionTextRegion(beforeModel, bx, by, newModel, doc);
    const before = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    const applyNew = () => {
      layer.text = cloneModel(newModel);
      layer.x = 0;
      layer.y = 0;
      renderTextToCanvas(layer.canvas, layer.text);
      layer.touch();
    };
    applyNew();
    const after = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    this.history.push({
      label: 'Edit Text',
      undo: () => {
        layer.text = beforeModel;
        layer.x = bx;
        layer.y = by;
        layer.ctx.putImageData(before.data, before.x, before.y);
        layer.touch();
        this.bump();
        this.invalidate();
      },
      redo: () => {
        layer.x = 0;
        layer.y = 0;
        layer.text = cloneModel(newModel);
        layer.ctx.putImageData(after.data, after.x, after.y);
        layer.touch();
        this.bump();
        this.invalidate();
      },
    });
    this.bump();
    this.invalidate();
  }

  /** Document-clamped rect covering both the old and new text extents. */
  private unionTextRegion(
    beforeModel: TextModel | null,
    bx: number,
    by: number,
    newModel: TextModel,
    doc: PaintDocument,
  ): Rect {
    const rects: Rect[] = [];
    if (beforeModel) {
      const b = textBounds(beforeModel);
      rects.push({ x: b.x + bx, y: b.y + by, w: b.w, h: b.h });
    }
    const n = textBounds(newModel);
    rects.push({ x: n.x, y: n.y, w: n.w, h: n.h });
    const minX = Math.min(...rects.map((r) => r.x));
    const minY = Math.min(...rects.map((r) => r.y));
    const maxX = Math.max(...rects.map((r) => r.x + r.w));
    const maxY = Math.max(...rects.map((r) => r.y + r.h));
    const pad = 2;
    return (
      clampRect({ x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }, doc.width, doc.height) ?? {
        x: 0,
        y: 0,
        w: doc.width,
        h: doc.height,
      }
    );
  }

  /** A pixel tool was aimed at a text layer — ask whether to rasterize it first. */
  promptRasterize(layer: Layer): void {
    this.rasterizePrompt = { layerId: layer.id, name: layer.name };
  }
  confirmRasterize(): void {
    const p = this.rasterizePrompt;
    this.rasterizePrompt = null;
    if (p) this.rasterizeType(p.layerId);
  }
  dismissRasterize(): void {
    this.rasterizePrompt = null;
  }

  /** Rasterize the active text layer's model into a new raster layer (undoable). */
  rasterizeType(id: string): void {
    const doc = this.doc;
    if (!doc) return;
    const layer = doc.layers.find((l) => l.id === id);
    if (!layer || layer.kind !== 'text') return;
    const prevModel = layer.text;
    this.history.push({
      label: 'Rasterize Type',
      undo: () => {
        layer.kind = 'text';
        layer.text = prevModel;
        layer.touch();
        this.bump();
        this.invalidate();
      },
      redo: () => {
        layer.kind = 'raster';
        layer.text = null;
        layer.touch();
        this.bump();
        this.invalidate();
      },
    });
    layer.kind = 'raster';
    layer.text = null;
    layer.touch();
    this.bump();
    this.invalidate();
  }

  /** Insert an external image as a new, centered layer (undoable). */
  placeImage(
    source: CanvasImageSource,
    sw: number,
    sh: number,
    name: string,
    sourceMeta: LayerSourceMeta = {},
  ): PlacedImageResult {
    const doc = this.doc;
    if (!doc) return { oversized: false, layerId: null };
    const isOversized = sw > doc.width || sh > doc.height;
    let placedId: string | null = null;
    this.structural('Place Image', () => {
      const x = Math.round((doc.width - sw) / 2);
      const y = Math.round((doc.height - sh) / 2);
      const layer = new Layer(sw, sh, name, undefined, x, y);
      layer.sourceAssetId = sourceMeta.assetId ?? null;
      layer.sourcePath = sourceMeta.path ?? null;
      layer.ctx.drawImage(source, 0, 0);
      layer.touch();
      doc.insertAboveActive(layer);
      placedId = layer.id;
    });
    return { oversized: isOversized, layerId: placedId };
  }

  /** Insert a stack of AI-decoupled layers above the source layer as one undoable edit. */
  insertDecoupledLayers(
    sourceLayerId: string,
    layers: DecoupledLayerImport[],
    options: { hideSource?: boolean } = {},
  ): number {
    const doc = this.doc;
    if (!doc || layers.length === 0) return 0;
    const sourceIdx = doc.indexOf(sourceLayerId);
    if (sourceIdx < 0) return 0;
    const sourceLayer = doc.layers[sourceIdx];
    let inserted = 0;
    this.structural('Extract Assets', () => {
      const next = doc.layers.slice();
      const built = layers.map((item) => {
        const layer = new Layer(
          item.width,
          item.height,
          item.name || `Decoupled ${inserted + 1}`,
          undefined,
          sourceLayer.x + Math.round(item.x ?? 0),
          sourceLayer.y + Math.round(item.y ?? 0),
        );
        layer.opacity = Math.max(0, Math.min(1, item.opacity ?? 1));
        layer.visible = item.visible ?? true;
        layer.sourceAssetId = item.sourceMeta?.assetId ?? null;
        layer.sourcePath = item.sourceMeta?.path ?? null;
        layer.ctx.drawImage(item.source, 0, 0);
        layer.touch();
        inserted++;
        return layer;
      });
      if (options.hideSource) sourceLayer.visible = false;
      next.splice(sourceIdx + 1, 0, ...built);
      doc.layers = next;
      doc.activeLayerId = built.at(-1)?.id ?? sourceLayerId;
    });
    return inserted;
  }
}

export const editor = new EditorStore();

// Dev-only handle for debugging/verification (stripped from production builds).
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as unknown as { __cxEditor: EditorStore }).__cxEditor = editor;
}
