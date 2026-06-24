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
import type { Tool, ToolHost } from '../engine/tools/Tool';
import { PaintTool } from '../engine/tools/PaintTool';
import { FillTool } from '../engine/tools/FillTool';
import { EyedropperTool } from '../engine/tools/EyedropperTool';
import { MoveTool } from '../engine/tools/MoveTool';
import { MarqueeTool } from '../engine/tools/MarqueeTool';
import { LassoTool } from '../engine/tools/LassoTool';
import { ShapeTool } from '../engine/tools/ShapeTool';
import { GradientTool } from '../engine/tools/GradientTool';
import { TextTool } from '../engine/tools/TextTool';
import { HandTool, ZoomTool } from '../engine/tools/NavTools';

export class EditorStore implements ToolHost {
  doc = $state<PaintDocument | null>(null);
  viewport: Viewport | null = null;
  readonly history = new History(60);

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
  /** Whether Alt/Option is currently held — drives the live zoom-mode preview. */
  altDown = $state(false);
  // Text tool: pending insertion point (drives the text dialog)
  pendingText = $state<{ x: number; y: number } | null>(null);

  activeToolId = $state('brush');
  flashMessage = $state('');
  /** Bumped on any change that reactive UI (thumbnails, history buttons) should observe. */
  rev = $state(0);

  private activeStroke: ActiveStroke | null = null;
  private flashTimer = 0;
  readonly tools: Record<string, Tool> = {};

  constructor() {
    this.history.onChange = () => {
      this.bump();
      this.viewport?.invalidate();
    };
    for (const t of [
      new MoveTool(this),
      new MarqueeTool(this),
      new LassoTool(this),
      new PaintTool(this, 'brush'),
      new PaintTool(this, 'eraser'),
      new FillTool(this),
      new GradientTool(this),
      new ShapeTool(this),
      new TextTool(this),
      new EyedropperTool(this),
      new HandTool(this),
      new ZoomTool(this),
    ]) {
      this.tools[t.id] = t;
    }
    this.doc = PaintDocument.blank(1280, 800, 'Untitled');
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
    this.viewport?.invalidate();
  }
  getSelection(): Selection | null {
    return this.selection;
  }
  setForeground(rgb: RGB): void {
    this.foreground = rgb;
  }
  requestText(x: number, y: number): void {
    this.pendingText = { x, y };
  }
  bump(): void {
    this.rev++;
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
  private editRegion(layer: Layer): Rect {
    const sel = this.selection;
    if (sel) {
      return clampRect(sel.bounds, layer.width, layer.height) ?? { x: 0, y: 0, w: layer.width, h: layer.height };
    }
    return { x: 0, y: 0, w: layer.width, h: layer.height };
  }

  // --- Clipboard (cut / copy / paste) ---
  copy(): void {
    const layer = this.activeLayer;
    if (!layer) return;
    const sel = this.selection;
    const bounds = sel
      ? clampRect(sel.bounds, layer.width, layer.height)
      : { x: 0, y: 0, w: layer.width, h: layer.height };
    if (!bounds) return;
    const buf = createCanvas(bounds.w, bounds.h);
    const c = ctx2d(buf);
    c.drawImage(layer.canvas, -bounds.x, -bounds.y);
    if (sel) {
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(sel.mask, -bounds.x, -bounds.y);
      c.globalCompositeOperation = 'source-over';
    }
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
      const layer = new Layer(doc.width, doc.height, 'Pasted');
      layer.ctx.drawImage(clip.canvas, clip.x, clip.y);
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
  setDocument(doc: PaintDocument): void {
    this.doc = doc;
    this.activeStroke = null;
    this.history.clear();
    this.bump();
    requestAnimationFrame(() => {
      this.viewport?.fitToView();
      this.viewport?.invalidate();
    });
  }
  newDocument(width: number, height: number, name: string, fillWhite: boolean): void {
    const doc = PaintDocument.blank(width, height, name);
    if (fillWhite && doc.activeLayer) doc.activeLayer.fill('#ffffff');
    this.setDocument(doc);
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
        this.remapLayers(rect.w, rect.h, (c, l) => c.drawImage(l.canvas, -rect.x, -rect.y)),
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
    this.structural(
      'Image Size',
      () => this.commitLayers(
        this.remapLayers(w, h, (c, l) => {
          c.imageSmoothingEnabled = true;
          c.imageSmoothingQuality = 'high';
          c.drawImage(l.canvas, 0, 0, l.width, l.height, 0, 0, w, h);
        }),
        w,
        h,
      ),
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
          c.drawImage(l.canvas, 0, 0);
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
            c.translate(l.width, 0);
            c.scale(-1, 1);
          } else {
            c.translate(0, l.height);
            c.scale(1, -1);
          }
          c.drawImage(l.canvas, 0, 0);
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
      const merged = new Layer(doc.width, doc.height, below.name);
      merged.blendMode = below.blendMode;
      merged.opacity = below.opacity;
      merged.visible = below.visible;
      const c = merged.ctx;
      c.drawImage(below.canvas, 0, 0);
      c.globalAlpha = above.opacity;
      c.globalCompositeOperation = above.blendMode;
      c.drawImage(above.canvas, 0, 0);
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
    const sel = this.selection;
    const md = sel ? ctx2d(sel.mask).getImageData(0, 0, w, layer.height).data : null;
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
    const sel = this.selection;
    layer.ctx.save();
    if (sel) {
      const masked = intersectMask(filtered, sel.mask);
      layer.ctx.globalCompositeOperation = 'destination-out';
      layer.ctx.drawImage(sel.mask, 0, 0);
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
    const sel = this.selection;
    if (sel) {
      layer.ctx.save();
      layer.ctx.globalCompositeOperation = 'destination-out';
      layer.ctx.drawImage(sel.mask, 0, 0);
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
    const sel = this.selection;
    layer.ctx.save();
    layer.ctx.globalCompositeOperation = 'source-over';
    if (sel) {
      const tmp = createCanvas(layer.width, layer.height);
      const tc = ctx2d(tmp);
      tc.fillStyle = rgbToCss(rgb);
      tc.fillRect(0, 0, layer.width, layer.height);
      layer.ctx.drawImage(intersectMask(tmp, sel.mask), 0, 0);
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

  /** Rasterize text onto a new layer at the pending insertion point (undoable). */
  addText(text: string, fontSize: number, fontFamily: string): void {
    const doc = this.doc;
    const pos = this.pendingText;
    this.pendingText = null;
    if (!doc || !pos || !text.trim()) return;
    this.structural('Text', () => {
      const name = text.split('\n')[0].slice(0, 24) || 'Text';
      const layer = new Layer(doc.width, doc.height, name);
      const c = layer.ctx;
      c.fillStyle = rgbToCss(this.foreground, 1);
      c.textBaseline = 'top';
      c.font = `${fontSize}px ${fontFamily}`;
      const lh = fontSize * 1.3;
      text.split('\n').forEach((line, i) => c.fillText(line, pos.x, pos.y + i * lh));
      layer.touch();
      doc.insertAboveActive(layer);
    });
  }

  /** Insert an external image as a new, centered layer (undoable). */
  placeImage(source: CanvasImageSource, sw: number, sh: number, name: string): void {
    const doc = this.doc;
    if (!doc) return;
    this.structural('Place Image', () => {
      const layer = new Layer(doc.width, doc.height, name);
      const x = Math.round((doc.width - sw) / 2);
      const y = Math.round((doc.height - sh) / 2);
      layer.ctx.drawImage(source, x, y);
      layer.touch();
      doc.insertAboveActive(layer);
    });
  }
}

export const editor = new EditorStore();

// Dev-only handle for debugging/verification (stripped from production builds).
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as unknown as { __cxEditor: EditorStore }).__cxEditor = editor;
}
