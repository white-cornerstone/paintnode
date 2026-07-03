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
  moveSelection as moveSelectionMask,
  selectAllSelection,
  invertSelection as invertSelectionMask,
  intersectMask,
  selectionContainsPoint,
  type SelectionMode,
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
  defaultParagraph,
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
import { AnnotationTool } from '../engine/tools/AnnotationTool';
import { GradientTool } from '../engine/tools/GradientTool';
import { TextTool } from '../engine/tools/TextTool';
import { CloneStampTool } from '../engine/tools/CloneStampTool';
import { SmudgeTool } from '../engine/tools/SmudgeTool';
import { FocusTool } from '../engine/tools/FocusTool';
import { ToningTool } from '../engine/tools/ToningTool';
import { HandTool, ZoomTool } from '../engine/tools/NavTools';
import { AiRetouchTool } from '../engine/tools/AiRetouchTool';
import {
  AI_RETOUCH_TOOL_NAMES,
  aiRetouchPrompt,
  cloneAiRetouchMetadata,
  cloneMask,
  combineRetouchMask,
  cropReference,
  makeEditTarget,
  makeRectMask,
  makeUnionRectMask,
  maskBounds,
  maskHasPixels,
  referenceRect,
  type AiRetouchGesture,
  type AiRetouchInputBytes,
  type AiRetouchMaskMetadata,
  type AiRetouchMoveMode,
  type AiRetouchPatchMode,
  type AiRetouchPreview,
  type AiRetouchRequest,
  type AiRetouchToolId,
} from '../engine/aiRetouch';
import { ui } from './ui.svelte';
import {
  annotationInstructionNotes,
  newAnnotation,
  visibleAnnotations,
  type AnnotationItem,
  type AnnotationKind,
} from '../engine/annotations';
import { projectDocumentSourceKey, type DocumentSourceKey } from './documentSource';

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

export interface GenerativeFillInput {
  source: HTMLCanvasElement;
  sourcePng: Uint8Array;
  editTargetPng: Uint8Array;
  maskPng: Uint8Array;
  mask: HTMLCanvasElement;
  editablePixels: number;
  mode: 'transparent-selection' | 'selection';
}

const GENERATIVE_FILL_ALPHA_EMPTY = 8;
const GENERATIVE_FILL_BLEND_FEATHER = 24;

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value);
      else reject(new Error('Unable to encode canvas as PNG.'));
    }, 'image/png');
  });
  return new Uint8Array(await blob.arrayBuffer());
}

function softGenerativeFillMask(
  sourceData: ImageData,
  selectionData: ImageData,
  width: number,
  height: number,
  clipToTransparent: boolean,
): { mask: HTMLCanvasElement; editablePixels: number } {
  const pixels = width * height;
  const coverage = new Uint8ClampedArray(pixels);
  let frontier = new Uint8Array(pixels);
  let editablePixels = 0;

  for (let i = 0; i < pixels; i++) {
    const p = i * 4;
    const selected = selectionData.data[p + 3] >= 128;
    const transparent = sourceData.data[p + 3] <= GENERATIVE_FILL_ALPHA_EMPTY;
    if (selected && (!clipToTransparent || transparent)) {
      coverage[i] = 255;
      frontier[i] = 1;
      editablePixels++;
    }
  }

  for (let distance = 1; distance <= GENERATIVE_FILL_BLEND_FEATHER; distance++) {
    const next = new Uint8Array(pixels);
    const value = Math.round(255 * (1 - distance / (GENERATIVE_FILL_BLEND_FEATHER + 1)));
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (coverage[i] !== 0) continue;
        if (sourceData.data[i * 4 + 3] <= GENERATIVE_FILL_ALPHA_EMPTY) continue;

        let touchesFrontier = false;
        for (let dy = -1; dy <= 1 && !touchesFrontier; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            if (frontier[ny * width + nx]) {
              touchesFrontier = true;
              break;
            }
          }
        }

        if (touchesFrontier) {
          coverage[i] = value;
          next[i] = 1;
        }
      }
    }
    frontier = next;
  }

  const mask = createCanvas(width, height);
  const maskCtx = ctx2d(mask);
  const maskImage = maskCtx.createImageData(width, height);
  for (let i = 0; i < pixels; i++) {
    const p = i * 4;
    const value = coverage[i];
    maskImage.data[p] = value;
    maskImage.data[p + 1] = value;
    maskImage.data[p + 2] = value;
    maskImage.data[p + 3] = 255;
  }
  maskCtx.putImageData(maskImage, 0, 0);
  return { mask, editablePixels };
}

function generativeFillEditTarget(source: HTMLCanvasElement): HTMLCanvasElement {
  const target = createCanvas(source.width, source.height);
  const targetCtx = ctx2d(target);
  targetCtx.fillStyle = '#8b8f98';
  targetCtx.fillRect(0, 0, target.width, target.height);
  targetCtx.drawImage(source, 0, 0);
  return target;
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

export interface FreeTransformSession {
  layerId: string;
  layerName: string;
  previewUrl: string;
  source: HTMLCanvasElement;
  sourceWidth: number;
  sourceHeight: number;
  centerX: number;
  centerY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
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
  sourceKey: DocumentSourceKey | null;
  hasSavedBaseline: boolean;
  /** Remembered "embed fonts?" choice for this document (null = ask on next save). */
  embedFonts: boolean | null;
  /**
   * Format File ▸ Save writes for this document. Documents opened from a .psd
   * stay .psd; everything else saves .ora. While `savedPath` is null the first
   * save always prompts for a name, so overwriting the original file is an
   * explicit user choice rather than the default.
   */
  saveFormat: 'ora' | 'psd';
  /** Extension of the file this document was loaded from (e.g. 'psd', 'png'), if any. */
  sourceExtension: string | null;
}

interface LayerStackSnapshot {
  layers: Layer[];
  activeLayerId: string | null;
}

interface SelectionContentMoveSession {
  before: LayerStackSnapshot;
}

interface EmbeddedDocumentRestore {
  doc: PaintDocument | null;
  activeDocumentId: string | null;
  selection: Selection | null;
  history: History;
  viewport: Viewport | null;
  textEdit: TextEditSession | null;
  rasterizePrompt: { layerId: string; name: string } | null;
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
  aiRetouchBrushFeather = $state(24);
  tolerance = $state(24);
  selection = $state<Selection | null>(null);
  selectionMode = $state<SelectionMode>('new');
  marqueeShape = $state<'rect' | 'ellipse' | 'row' | 'column'>('rect');
  clipboard = $state<{ canvas: HTMLCanvasElement; x: number; y: number } | null>(null);

  // Shape tool
  shapeType = $state<'rect' | 'ellipse' | 'line'>('rect');
  shapeFill = $state(true);
  shapeStrokeWidth = $state(4);
  // Annotation tool
  annotationType = $state<'arrow' | 'note' | 'callout' | 'badge' | 'divider'>('callout');
  annotationText = $state('Note');
  selectedAnnotationId = $state<string | null>(null);
  // Gradient tool
  gradientType = $state<'fg-bg' | 'fg-transparent'>('fg-bg');
  // Zoom tool mode (click zooms in or out); Alt inverts momentarily.
  zoomMode = $state<'in' | 'out'>('in');
  // Selection / retouch options shared with tool implementations.
  magicContiguous = $state(true);
  cloneAligned = $state(true);
  toneRange = $state<'shadows' | 'midtones' | 'highlights'>('midtones');
  spongeMode = $state<'saturate' | 'desaturate'>('saturate');
  aiRetouchPatchMode = $state<AiRetouchPatchMode>('source');
  aiRetouchMoveMode = $state<AiRetouchMoveMode>('move');
  aiRetouchHealingSource = $state<{ x: number; y: number } | null>(null);
  lastAiRetouchTool = $state<AiRetouchToolId>('spot-healing');
  pendingAiRetouch = $state<AiRetouchRequest | null>(null);
  /** Whether Alt/Option is currently held — drives the live zoom-mode preview. */
  altDown = $state(false);
  // Type tool: the active on-canvas text edit session (null = not editing).
  textEdit = $state<TextEditSession | null>(null);
  // Interactive Free Transform session for the active layer.
  freeTransform = $state<FreeTransformSession | null>(null);
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
  private aiRetouchPreview: AiRetouchPreview | null = null;
  private embeddedRestore: EmbeddedDocumentRestore | null = null;
  private selectionContentMove: SelectionContentMoveSession | null = null;
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
      new AiRetouchTool(this, 'spot-healing'),
      new AiRetouchTool(this, 'remove'),
      new AiRetouchTool(this, 'healing-brush'),
      new AiRetouchTool(this, 'patch'),
      new AiRetouchTool(this, 'content-aware-move'),
      new AiRetouchTool(this, 'red-eye'),
      new ShapeTool(this),
      new AnnotationTool(this),
      new TextTool(this),
      new EyedropperTool(this),
      new HandTool(this),
      new ZoomTool(this),
    ]) {
      this.tools[t.id] = t;
    }
  }

  // --- Derived state ---
  get activeLayer(): Layer | null {
    return this.doc?.activeLayer ?? null;
  }
  /** Flash-and-block helper: true when `layer` is a locked Photoshop-only layer. */
  blockIfLocked(layer: Layer | null | undefined): boolean {
    if (!layer?.locked) return false;
    this.flash('Photoshop-only layer is locked; PaintNode preserves it for PSD export');
    return true;
  }
  /** Blocks document-wide ops that cannot preserve locked Photoshop layers. */
  private blockIfAnyLocked(operation: string): boolean {
    if (!this.doc?.layers.some((l) => l.locked)) return false;
    this.flash(`${operation} is disabled while the document has locked Photoshop layers`);
    return true;
  }
  /** Blocks transforms that would desync Photoshop-protected layers, masks, or clipping. */
  private blockIfPsdProtectedDoc(operation: string): boolean {
    const doc = this.doc;
    if (!doc) return false;
    if (!doc.layers.some((l) => l.locked || l.psdMask || l.psd?.clipping)) return false;
    this.flash(`${operation} is disabled while the document has Photoshop-protected layers`);
    return true;
  }
  get activeAiRetouchMaskLayer(): Layer | null {
    const layer = this.activeLayer;
    return layer?.kind === 'ai-retouch-mask' ? layer : null;
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

  private makeSession(
    doc: PaintDocument,
    sourceKey: DocumentSourceKey | null = null,
    hasSavedBaseline = sourceKey !== null,
  ): DocumentSession {
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
      sourceKey,
      hasSavedBaseline,
      embedFonts: null,
      saveFormat: 'ora',
      sourceExtension: null,
    };
  }

  /**
   * File name shown for a session (tabs, save prompts): the saved file's real
   * name once saved, else the loaded file's name with its extension, else the
   * plain document name for brand-new documents.
   */
  documentFileName(session: DocumentSession): string {
    const name = session.doc.name || 'Untitled';
    if (session.savedPath) {
      const base = session.savedPath.split('/').pop();
      if (base) return base;
    }
    return session.sourceExtension ? `${name}.${session.sourceExtension}` : name;
  }

  private documentMatchesSource(session: DocumentSession, sourceKey: DocumentSourceKey): boolean {
    return (
      session.sourceKey === sourceKey ||
      (session.savedPath ? projectDocumentSourceKey(session.savedPath) === sourceKey : false)
    );
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
  setAiRetouchPreview(preview: AiRetouchPreview | null): void {
    this.aiRetouchPreview = preview;
    this.viewport?.invalidate();
  }
  getAiRetouchPreview(): AiRetouchPreview | null {
    return this.aiRetouchPreview;
  }
  setSelection(sel: Selection | null): void {
    this.selection = sel;
    const session = this.activeDocument;
    if (session) session.selection = sel;
    this.viewport?.invalidate();
  }
  selectionContainsPoint(x: number, y: number): boolean {
    return !!this.selection && selectionContainsPoint(this.selection, x, y);
  }
  moveSelection(dx: number, dy: number): void {
    const doc = this.doc;
    const sel = this.selection;
    if (!doc || !sel) return;
    this.setSelection(moveSelectionMask(sel, dx, dy, doc.width, doc.height));
  }
  getSelection(): Selection | null {
    return this.selection;
  }
  setForeground(rgb: RGB): void {
    this.foreground = rgb;
  }
  setBackground(rgb: RGB): void {
    this.background = rgb;
  }
  sampleCompositeColorAtClient(clientX: number, clientY: number): RGB | null {
    const doc = this.doc;
    const viewport = this.viewport;
    if (!doc || !viewport) return null;
    const rect = viewport.canvas.getBoundingClientRect();
    const p = viewport.screenToDoc(clientX - rect.left, clientY - rect.top);
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return null;
    const flat = compositeToCanvas(doc);
    const data = ctx2d(flat).getImageData(x, y, 1, 1).data;
    return { r: data[0], g: data[1], b: data[2] };
  }
  setLayerVisible(layer: Layer, visible: boolean): void {
    if (layer.visible === visible) return;
    const before = layer.visible;
    layer.visible = visible;
    this.history.push({
      label: 'Layer Visibility',
      undo: () => {
        layer.visible = before;
        this.bump();
        this.invalidate();
      },
      redo: () => {
        layer.visible = visible;
        this.bump();
        this.invalidate();
      },
    });
    this.bump();
    this.invalidate();
  }
  setLayerMaskEnabled(layer: Layer, enabled: boolean): void {
    if (!layer.maskLayerId || layer.maskEnabled === enabled) return;
    const before = layer.maskEnabled;
    layer.maskEnabled = enabled;
    this.history.push({
      label: enabled ? 'Enable Layer Mask' : 'Disable Layer Mask',
      undo: () => {
        layer.maskEnabled = before;
        this.bump();
        this.invalidate();
      },
      redo: () => {
        layer.maskEnabled = enabled;
        this.bump();
        this.invalidate();
      },
    });
    this.bump();
    this.invalidate();
  }
  toggleLayerMaskEnabled(layer: Layer): void {
    this.setLayerMaskEnabled(layer, !layer.maskEnabled);
  }
  toggleLayerVisible(layer: Layer): void {
    this.setLayerVisible(layer, !layer.visible);
  }
  setLayerOpacity(layer: Layer, opacity: number): void {
    const next = Math.max(0, Math.min(1, opacity));
    if (layer.opacity === next) return;
    layer.opacity = next;
    this.bump();
    this.invalidate();
  }
  setLayerBlendMode(layer: Layer, blendMode: Layer['blendMode']): void {
    if (layer.blendMode === blendMode) return;
    layer.blendMode = blendMode;
    this.bump();
    this.invalidate();
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
      paragraphs: [defaultParagraph({ runs: [{ text: '', style }] })],
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
    if (!this.tools[id]) return;
    if (this.freeTransform) this.commitFreeTransform();
    this.setAiRetouchPreview(null);
    this.activeToolId = id;
    if (id in AI_RETOUCH_TOOL_NAMES) this.lastAiRetouchTool = id as AiRetouchToolId;
    if (id !== 'annotation') this.selectedAnnotationId = null;
  }

  beginEmbeddedDocument(doc: PaintDocument): void {
    this.cancelFreeTransform();
    if (!this.embeddedRestore) {
      this.embeddedRestore = {
        doc: this.doc,
        activeDocumentId: this.activeDocumentId,
        selection: this.selection,
        history: this.history,
        viewport: this.viewport,
        textEdit: this.textEdit,
        rasterizePrompt: this.rasterizePrompt,
      };
    }
    this.doc = doc;
    this.activeDocumentId = null;
    this.selection = null;
    this.activeStroke = null;
    this.aiRetouchPreview = null;
    this.textEdit = null;
    this.freeTransform = null;
    this.rasterizePrompt = null;
    this.attachHistory(new History(60));
    this.notify();
  }

  endEmbeddedDocument(): void {
    const restore = this.embeddedRestore;
    if (!restore) return;
    this.embeddedRestore = null;
    this.doc = restore.doc;
    this.activeDocumentId = restore.activeDocumentId;
    this.selection = restore.selection;
    this.activeStroke = null;
    this.aiRetouchPreview = null;
    this.textEdit = restore.textEdit;
    this.freeTransform = null;
    this.rasterizePrompt = restore.rasterizePrompt;
    this.viewport = restore.viewport;
    this.attachHistory(restore.history);
    this.notify();
    this.viewport?.invalidateComposite();
    this.viewport?.invalidate();
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

  async prepareGenerativeFillInput(): Promise<GenerativeFillInput | null> {
    const doc = this.doc;
    const sel = this.selection;
    if (!doc || !sel) return null;

    const source = compositeToCanvas(doc);
    const sourceData = ctx2d(source, { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
    const selectionData = ctx2d(sel.mask, { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);

    let selectedPixels = 0;
    let selectedTransparentPixels = 0;
    for (let i = 0; i < sourceData.data.length; i += 4) {
      if (selectionData.data[i + 3] < 128) continue;
      selectedPixels++;
      if (sourceData.data[i + 3] <= GENERATIVE_FILL_ALPHA_EMPTY) selectedTransparentPixels++;
    }
    if (selectedPixels === 0) return null;

    const clipToTransparent = selectedTransparentPixels > 0;
    const { mask, editablePixels } = softGenerativeFillMask(sourceData, selectionData, doc.width, doc.height, clipToTransparent);
    if (editablePixels === 0) return null;

    return {
      source,
      sourcePng: await canvasToPngBytes(source),
      editTargetPng: await canvasToPngBytes(generativeFillEditTarget(source)),
      maskPng: await canvasToPngBytes(mask),
      mask,
      editablePixels,
      mode: clipToTransparent ? 'transparent-selection' : 'selection',
    };
  }

  private generativeFillLayerCanvas(
    source: CanvasImageSource,
    sw: number,
    sh: number,
    mask: HTMLCanvasElement,
  ): HTMLCanvasElement | null {
    const doc = this.doc;
    if (!doc) return null;
    const fill = createCanvas(doc.width, doc.height);
    const fillCtx = ctx2d(fill);
    fillCtx.imageSmoothingEnabled = true;
    fillCtx.imageSmoothingQuality = 'high';
    fillCtx.drawImage(source, 0, 0, sw, sh, 0, 0, doc.width, doc.height);
    fillCtx.globalCompositeOperation = 'destination-in';
    const clip = createCanvas(doc.width, doc.height);
    const clipCtx = ctx2d(clip, { willReadFrequently: true });
    clipCtx.drawImage(mask, 0, 0, doc.width, doc.height);
    const clipImage = clipCtx.getImageData(0, 0, doc.width, doc.height);
    for (let i = 0; i < clipImage.data.length; i += 4) {
      const coverage =
        ((clipImage.data[i] * 0.2126 + clipImage.data[i + 1] * 0.7152 + clipImage.data[i + 2] * 0.0722) *
          clipImage.data[i + 3]) /
        255;
      clipImage.data[i] = 255;
      clipImage.data[i + 1] = 255;
      clipImage.data[i + 2] = 255;
      clipImage.data[i + 3] = coverage;
    }
    clipCtx.putImageData(clipImage, 0, 0);
    fillCtx.drawImage(clip, 0, 0);
    fillCtx.globalCompositeOperation = 'source-over';
    return fill;
  }

  renderGenerativeFillComposite(
    generated: CanvasImageSource,
    sw: number,
    sh: number,
    mask: HTMLCanvasElement,
    source: HTMLCanvasElement,
  ): HTMLCanvasElement | null {
    const doc = this.doc;
    if (!doc) return null;
    const fill = this.generativeFillLayerCanvas(generated, sw, sh, mask);
    if (!fill) return null;
    const out = createCanvas(doc.width, doc.height);
    const outCtx = ctx2d(out);
    outCtx.drawImage(source, 0, 0, doc.width, doc.height);
    outCtx.drawImage(fill, 0, 0);
    return out;
  }

  private aiRetouchMetadataForGesture(toolId: AiRetouchToolId, gesture: AiRetouchGesture): AiRetouchMaskMetadata {
    const metadata: AiRetouchMaskMetadata = {
      toolId,
      promptSeed: aiRetouchPrompt(toolId, gesture),
    };
    if (gesture.kind === 'brush') {
      metadata.healingSource = this.aiRetouchHealingSource;
      metadata.referenceRect = gesture.reference ?? null;
    } else if (gesture.kind === 'patch') {
      metadata.patchMode = gesture.mode;
      metadata.referenceRect = gesture.reference;
    } else if (gesture.kind === 'move') {
      metadata.moveMode = gesture.mode;
      metadata.destinationRect = gesture.destination;
    }
    return metadata;
  }

  private restoreAiRetouchMaskLayer(layer: Layer, pixels: ImageData, metadata: AiRetouchMaskMetadata | null): void {
    layer.ctx.putImageData(pixels, 0, 0);
    layer.aiRetouch = cloneAiRetouchMetadata(metadata);
    layer.touch();
    this.bump();
    this.invalidate();
  }

  commitAiRetouchMaskGesture(toolId: AiRetouchToolId, gesture: AiRetouchGesture, mask: HTMLCanvasElement, mode: SelectionMode): void {
    const doc = this.doc;
    if (!doc || !maskHasPixels(mask)) {
      this.flash('Draw an area to retouch');
      return;
    }
    const metadata = this.aiRetouchMetadataForGesture(toolId, gesture);
    const activeMask = this.activeAiRetouchMaskLayer;

    if (!activeMask) {
      if (mode === 'subtract' || mode === 'intersect') {
        this.flash('No AI retouch mask to refine');
        this.setAiRetouchPreview(null);
        return;
      }
      this.structural('AI Retouch Mask', () => {
        const layer = new Layer(doc.width, doc.height, `AI Mask: ${AI_RETOUCH_TOOL_NAMES[toolId]}`, undefined, 0, 0);
        layer.kind = 'ai-retouch-mask';
        layer.aiRetouch = metadata;
        layer.ctx.drawImage(mask, 0, 0, doc.width, doc.height);
        layer.touch();
        doc.insertAboveActive(layer);
      });
      this.setAiRetouchPreview(null);
      return;
    }

    const beforePixels = activeMask.ctx.getImageData(0, 0, activeMask.width, activeMask.height);
    const beforeMetadata = cloneAiRetouchMetadata(activeMask.aiRetouch);
    const nextMask = combineRetouchMask(activeMask.canvas, mask, mode, doc.width, doc.height);
    activeMask.ctx.clearRect(0, 0, activeMask.width, activeMask.height);
    if (nextMask) activeMask.ctx.drawImage(nextMask, 0, 0, doc.width, doc.height);
    activeMask.aiRetouch = metadata;
    activeMask.name = `AI Mask: ${AI_RETOUCH_TOOL_NAMES[toolId]}`;
    activeMask.touch();
    const afterPixels = activeMask.ctx.getImageData(0, 0, activeMask.width, activeMask.height);
    const afterMetadata = cloneAiRetouchMetadata(metadata);
    this.history.push({
      label: 'AI Retouch Mask',
      undo: () => this.restoreAiRetouchMaskLayer(activeMask, beforePixels, beforeMetadata),
      redo: () => this.restoreAiRetouchMaskLayer(activeMask, afterPixels, afterMetadata),
    });
    this.bump();
    this.invalidate();
    this.setAiRetouchPreview(null);
  }

  setAiRetouchMaskReference(toolId: AiRetouchToolId, updates: Partial<AiRetouchMaskMetadata>): void {
    const layer = this.activeAiRetouchMaskLayer;
    if (!layer?.aiRetouch) {
      this.flash('Select an AI retouch mask first');
      return;
    }
    const before = cloneAiRetouchMetadata(layer.aiRetouch)!;
    const after: AiRetouchMaskMetadata = {
      ...before,
      ...updates,
      toolId,
      promptSeed: before.promptSeed || AI_RETOUCH_TOOL_NAMES[toolId],
    };
    layer.aiRetouch = after;
    layer.name = `AI Mask: ${AI_RETOUCH_TOOL_NAMES[toolId]}`;
    this.history.push({
      label: 'AI Retouch Mask Reference',
      undo: () => {
        layer.aiRetouch = cloneAiRetouchMetadata(before);
        this.bump();
        this.invalidate();
      },
      redo: () => {
        layer.aiRetouch = cloneAiRetouchMetadata(after);
        this.bump();
        this.invalidate();
      },
    });
    this.bump();
    this.invalidate();
    this.flash('AI retouch reference set');
  }

  setAiRetouchHealingSource(source: { x: number; y: number }): void {
    this.aiRetouchHealingSource = source;
    const doc = this.doc;
    const layer = this.activeAiRetouchMaskLayer;
    if (doc && layer?.aiRetouch?.toolId === 'healing-brush') {
      this.setAiRetouchMaskReference('healing-brush', {
        healingSource: source,
        referenceRect: referenceRect(source, Math.max(1, this.brushSize) * 4, doc.width, doc.height),
      });
    }
  }

  clearAiRetouchHealingSource(): void {
    this.aiRetouchHealingSource = null;
    const layer = this.activeAiRetouchMaskLayer;
    if (layer?.aiRetouch?.toolId === 'healing-brush') {
      this.setAiRetouchMaskReference('healing-brush', {
        healingSource: null,
        referenceRect: null,
      });
    }
  }

  getAiRetouchMaskRunState(layer = this.activeAiRetouchMaskLayer): { canRun: boolean; reason: string } {
    if (!layer || layer.kind !== 'ai-retouch-mask' || !layer.aiRetouch) return { canRun: false, reason: 'Select an AI retouch mask' };
    if (!maskHasPixels(layer.canvas)) return { canRun: false, reason: 'Draw a retouch mask' };
    const metadata = layer.aiRetouch;
    if (metadata.toolId === 'healing-brush' && !metadata.referenceRect) return { canRun: false, reason: 'Alt-click a healing source' };
    if (metadata.toolId === 'patch' && !metadata.referenceRect) return { canRun: false, reason: 'Drag inside the mask to choose a patch source' };
    if (metadata.toolId === 'content-aware-move' && !metadata.destinationRect) return { canRun: false, reason: 'Drag inside the mask to place the subject' };
    return { canRun: true, reason: '' };
  }

  getActiveAiRetouchMaskBounds(): Rect | null {
    const layer = this.activeAiRetouchMaskLayer;
    return layer ? maskBounds(layer.canvas) : null;
  }

  buildAiRetouchRequestFromMaskLayer(layer = this.activeAiRetouchMaskLayer): AiRetouchRequest | null {
    const doc = this.doc;
    const metadata = layer?.aiRetouch;
    if (!doc || !layer || layer.kind !== 'ai-retouch-mask' || !metadata) return null;
    const source = compositeToCanvas(doc);
    const annotationItems = doc.annotationsVisible ? visibleAnnotations(doc.annotations) : [];
    const annotatedSource = annotationItems.length ? this.renderAnnotatedSource(source, annotationItems) : null;
    const annotationNotes = annotationInstructionNotes(annotationItems, doc.width, doc.height);
    const bounds = maskBounds(layer.canvas);
    if (!bounds) return null;
    let mask = cloneMask(layer.canvas);
    let referenceRectValue: Rect | null = null;
    let gesture: AiRetouchGesture;

    if (metadata.toolId === 'patch') {
      if (!metadata.referenceRect) return null;
      const mode = metadata.patchMode ?? this.aiRetouchPatchMode;
      gesture = { kind: 'patch', mode, target: bounds, reference: metadata.referenceRect };
      if (mode === 'destination') {
        const destinationMask = makeRectMask(doc.width, doc.height, metadata.referenceRect);
        if (!destinationMask) return null;
        mask = destinationMask;
        referenceRectValue = bounds;
      } else {
        referenceRectValue = metadata.referenceRect;
      }
    } else if (metadata.toolId === 'content-aware-move') {
      if (!metadata.destinationRect) return null;
      const mode = metadata.moveMode ?? this.aiRetouchMoveMode;
      gesture = { kind: 'move', mode, source: bounds, destination: metadata.destinationRect };
      mask = makeUnionRectMask(doc.width, doc.height, [bounds, metadata.destinationRect]) ?? mask;
      referenceRectValue = bounds;
    } else if (metadata.toolId === 'red-eye') {
      gesture = {
        kind: 'red-eye',
        bounds,
      };
    } else {
      gesture = {
        kind: 'brush',
        points: [],
        size: Math.max(1, this.brushSize),
        hardness: this.brushHardness,
        closedLoop: false,
        reference: metadata.referenceRect ?? null,
      };
      referenceRectValue = metadata.referenceRect ?? null;
    }

    const reference = referenceRectValue ? cropReference(source, referenceRectValue) : null;
    const editTarget = makeEditTarget(source, mask);
    return {
      id: globalThis.crypto?.randomUUID?.() ?? `ai-retouch-${Date.now()}`,
      toolId: metadata.toolId,
      toolName: AI_RETOUCH_TOOL_NAMES[metadata.toolId],
      prompt: aiRetouchPrompt(metadata.toolId, gesture),
      source,
      editTarget,
      mask,
      annotatedSource,
      annotationNotes,
      maskLayerId: layer.id,
      reference,
      gesture,
    };
  }

  openAiRetouchForActiveMask(): void {
    const state = this.getAiRetouchMaskRunState();
    if (!state.canRun) {
      this.flash(state.reason);
      return;
    }
    const request = this.buildAiRetouchRequestFromMaskLayer();
    if (!request) {
      this.flash('AI retouch mask is not ready');
      return;
    }
    this.pendingAiRetouch = request;
    this.setAiRetouchPreview({ mask: request.mask });
    ui.open('aiRetouch');
  }

  clearActiveAiRetouchMask(): void {
    const layer = this.activeAiRetouchMaskLayer;
    if (!layer) return;
    const before = snapshotLayer(layer);
    layer.clear();
    const after = snapshotLayer(layer);
    this.history.push(pixelCommand(layer, before, after, 'Clear AI Retouch Mask'));
    this.bump();
    this.invalidate();
  }

  async prepareAiRetouchInput(request = this.pendingAiRetouch): Promise<AiRetouchInputBytes | null> {
    if (!request) return null;
    return {
      sourcePng: await canvasToPngBytes(request.source),
      editTargetPng: await canvasToPngBytes(request.editTarget),
      maskPng: await canvasToPngBytes(request.mask),
      annotatedSourcePng: request.annotatedSource ? await canvasToPngBytes(request.annotatedSource) : null,
      annotationNotes: request.annotationNotes,
      referencePng: request.reference ? await canvasToPngBytes(request.reference) : null,
    };
  }

  dismissAiRetouch(): void {
    this.pendingAiRetouch = null;
    this.setAiRetouchPreview(null);
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
  openDocument(
    doc: PaintDocument,
    focus = true,
    sourceKey: DocumentSourceKey | null = null,
    hasSavedBaseline = sourceKey !== null,
  ): DocumentSession {
    if (sourceKey) {
      const existing = this.documents.find((d) => this.documentMatchesSource(d, sourceKey));
      if (existing) {
        if (focus) this.switchDocument(existing.id);
        return existing;
      }
    }

    const session = this.makeSession(doc, sourceKey, hasSavedBaseline);
    this.documents = [...this.documents, session];
    if (focus) {
      ui.showDocument();
      this.switchDocument(session.id);
    }
    else if (!this.activeDocumentId) this.switchDocument(session.id);
    return session;
  }

  focusDocumentBySource(sourceKey: DocumentSourceKey | null): DocumentSession | null {
    if (!sourceKey) return null;
    const session = this.documents.find((d) => this.documentMatchesSource(d, sourceKey));
    if (!session) return null;
    this.switchDocument(session.id);
    return session;
  }

  setDocument(doc: PaintDocument): void {
    this.cancelFreeTransform();
    ui.showDocument();
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
    this.aiRetouchPreview = null;
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
    if (!session) return;
    ui.showDocument();
    if (session.id === this.activeDocumentId) return;
    this.cancelFreeTransform();
    const current = this.activeDocument;
    if (current) current.selection = this.selection;
    this.activeDocumentId = session.id;
    this.doc = session.doc;
    this.selection = session.selection;
    this.activeStroke = null;
    this.aiRetouchPreview = null;
    this.attachHistory(session.history);
    this.notify();
    requestAnimationFrame(() => {
      this.viewport?.fitToView();
      this.viewport?.invalidate();
    });
  }

  closeDocument(id: string): void {
    const idx = this.documents.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const wasActive = this.activeDocumentId === id;
    if (wasActive) this.cancelFreeTransform();
    const next = this.documents.slice();
    next.splice(idx, 1);
    this.documents = next;
    if (next.length > 0 && ui.activeSurface === 'document') ui.showDocument();
    if (wasActive) {
      const fallback = next[Math.min(idx, next.length - 1)];
      this.activeDocumentId = null;
      if (fallback) this.switchDocument(fallback.id);
      else {
        this.doc = null;
        this.selection = null;
        this.activeStroke = null;
        this.aiRetouchPreview = null;
        this.textEdit = null;
        this.cancelFreeTransform();
        this.rasterizePrompt = null;
        this.attachHistory(new History(60));
        this.viewport?.invalidateComposite();
        this.viewport?.invalidate();
        this.notify();
      }
    } else {
      this.notify();
    }
  }

  markSaved(relativePath: string | null): void {
    const session = this.activeDocument;
    if (!session) return;
    session.savedPath = relativePath;
    session.hasSavedBaseline = true;
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
    return !session.hasSavedBaseline || session.revision !== session.savedRevision;
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
      annotations: doc.annotations.map((item) => ({ ...item })),
      annotationsVisible: doc.annotationsVisible,
    });
    const before = snap();
    mutate();
    const after = snap();
    const restore = (s: ReturnType<typeof snap>) => {
      doc.width = s.w;
      doc.height = s.h;
      doc.layers = s.layers.slice();
      doc.activeLayerId = s.active;
      doc.annotations = s.annotations.map((item) => ({ ...item }));
      doc.annotationsVisible = s.annotationsVisible;
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
      nl.sourceAssetId = l.sourceAssetId;
      nl.sourcePath = l.sourcePath;
      nl.maskLayerId = l.maskLayerId;
      nl.maskEnabled = l.maskEnabled;
      nl.kind = l.kind;
      nl.text = l.text ? cloneModel(l.text) : null;
      nl.aiRetouch = cloneAiRetouchMetadata(l.aiRetouch);
      // Keep PSD group/metadata but force a rebuild on export (pixels remapped).
      if (l.psd) nl.psd = { ...l.psd, imported: { ...l.psd.imported, pixelRev: -1 } };
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
  private cloneLayerExact(layer: Layer): Layer {
    const copy = new Layer(layer.width, layer.height, layer.name, layer.id, layer.x, layer.y);
    copy.opacity = layer.opacity;
    copy.visible = layer.visible;
    copy.blendMode = layer.blendMode;
    copy.sourceAssetId = layer.sourceAssetId;
    copy.sourcePath = layer.sourcePath;
    copy.maskLayerId = layer.maskLayerId;
    copy.maskEnabled = layer.maskEnabled;
    copy.kind = layer.kind;
    copy.text = layer.text ? cloneModel(layer.text) : null;
    copy.aiRetouch = cloneAiRetouchMetadata(layer.aiRetouch);
    // PSD passthrough state is immutable — sharing the reference is safe and
    // keeps history snapshots from silently unlocking imported layers.
    copy.psd = layer.psd;
    copy.psdMask = layer.psdMask;
    copy.ctx.drawImage(layer.canvas, 0, 0);
    copy.pixelRev = layer.pixelRev;
    return copy;
  }

  private layerStackSnapshot(): LayerStackSnapshot {
    const doc = this.doc!;
    return {
      layers: doc.layers.map((layer) => this.cloneLayerExact(layer)),
      activeLayerId: doc.activeLayerId,
    };
  }

  private restoreLayerStack(snapshot: LayerStackSnapshot): void {
    const doc = this.doc;
    if (!doc) return;
    doc.layers = snapshot.layers.map((layer) => this.cloneLayerExact(layer));
    doc.activeLayerId = snapshot.activeLayerId;
    this.bump();
    this.invalidate();
  }

  beginMoveSelectedContent(): boolean {
    const doc = this.doc;
    const layer = this.activeLayer;
    const sel = this.selection;
    if (!doc || !layer || !sel) return false;
    if (this.blockIfLocked(layer)) return false;
    if (layer.kind !== 'raster') {
      this.flash('Rasterize the active layer before moving selected pixels');
      return false;
    }

    const bounds = clampRect(sel.bounds, doc.width, doc.height);
    if (!bounds) return false;
    const before = this.layerStackSnapshot();
    const lifted = createCanvas(bounds.w, bounds.h);
    const liftedCtx = ctx2d(lifted);
    liftedCtx.drawImage(layer.canvas, layer.x - bounds.x, layer.y - bounds.y);
    liftedCtx.globalCompositeOperation = 'destination-in';
    liftedCtx.drawImage(sel.mask, -bounds.x, -bounds.y);
    liftedCtx.globalCompositeOperation = 'source-over';

    const mask = this.selectionMaskForLayer(layer);
    if (!mask) return false;
    layer.ctx.save();
    layer.ctx.globalCompositeOperation = 'destination-out';
    layer.ctx.drawImage(mask, 0, 0);
    layer.ctx.restore();
    layer.touch();

    const floating = new Layer(bounds.w, bounds.h, `${layer.name} selection`, undefined, bounds.x, bounds.y);
    floating.ctx.drawImage(lifted, 0, 0);
    floating.touch();
    doc.insertAboveActive(floating);
    this.selectionContentMove = { before };
    this.invalidate();
    return true;
  }

  moveActiveLayerBy(dx: number, dy: number): void {
    const layer = this.activeLayer;
    if (!layer) return;
    if (this.blockIfLocked(layer)) return;
    layer.x = Math.round(layer.x + dx);
    layer.y = Math.round(layer.y + dy);
    this.invalidate();
  }

  commitMoveSelectedContent(): void {
    const session = this.selectionContentMove;
    if (!session || !this.doc) return;
    this.selectionContentMove = null;
    const after = this.layerStackSnapshot();
    this.history.push({
      label: 'Move Selected Pixels',
      undo: () => this.restoreLayerStack(session.before),
      redo: () => this.restoreLayerStack(after),
    });
    this.bump();
    this.invalidate();
  }

  cancelMoveSelectedContent(): void {
    const session = this.selectionContentMove;
    if (!session) return;
    this.selectionContentMove = null;
    this.restoreLayerStack(session.before);
  }

  private replaceLayerSnapshot(snapshot: Layer, fallbackIndex: number): void {
    const doc = this.doc;
    if (!doc) return;
    const idx = doc.indexOf(snapshot.id);
    const at = idx >= 0 ? idx : Math.max(0, Math.min(fallbackIndex, doc.layers.length - 1));
    const next = doc.layers.slice();
    next[at] = this.cloneLayerExact(snapshot);
    doc.layers = next;
    doc.activeLayerId = snapshot.id;
    this.bump();
    this.invalidate();
  }

  private alphaBounds(layer: Layer): Rect | null {
    const { width, height } = layer;
    const data = layer.ctx.getImageData(0, 0, width, height).data;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] === 0) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return maxX < minX ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  }

  beginFreeTransform(): void {
    if (this.textEdit) this.commitActiveText();
    if (this.freeTransform) return;
    const layer = this.activeLayer;
    if (!layer) {
      this.flash('No active layer');
      return;
    }
    if (this.blockIfLocked(layer)) return;
    if (layer.psdMask) {
      this.flash('Layer has a Photoshop mask; transforming it is not supported yet');
      return;
    }
    const bounds = this.alphaBounds(layer);
    if (!bounds) {
      this.flash('Active layer is empty');
      return;
    }
    const source = createCanvas(bounds.w, bounds.h);
    ctx2d(source).drawImage(layer.canvas, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, bounds.w, bounds.h);
    layer.suppressed = true;
    this.freeTransform = {
      layerId: layer.id,
      layerName: layer.name,
      previewUrl: source.toDataURL('image/png'),
      source,
      sourceWidth: bounds.w,
      sourceHeight: bounds.h,
      centerX: layer.x + bounds.x + bounds.w / 2,
      centerY: layer.y + bounds.y + bounds.h / 2,
      scaleX: 1,
      scaleY: 1,
      rotation: 0,
      opacity: layer.opacity,
    };
    this.notify();
    this.invalidate();
  }

  updateFreeTransform(patch: Partial<Pick<FreeTransformSession, 'centerX' | 'centerY' | 'scaleX' | 'scaleY' | 'rotation'>>): void {
    const t = this.freeTransform;
    if (!t) return;
    this.freeTransform = {
      ...t,
      ...patch,
      scaleX: Math.max(0.02, patch.scaleX ?? t.scaleX),
      scaleY: Math.max(0.02, patch.scaleY ?? t.scaleY),
    };
  }

  private transformedLayerBounds(t: FreeTransformSession): Rect {
    const hw = (t.sourceWidth * t.scaleX) / 2;
    const hh = (t.sourceHeight * t.scaleY) / 2;
    const cos = Math.cos(t.rotation);
    const sin = Math.sin(t.rotation);
    const corners = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([x, y]) => ({ x: t.centerX + x * cos - y * sin, y: t.centerY + x * sin + y * cos }));
    const minX = Math.floor(Math.min(...corners.map((p) => p.x)));
    const minY = Math.floor(Math.min(...corners.map((p) => p.y)));
    const maxX = Math.ceil(Math.max(...corners.map((p) => p.x)));
    const maxY = Math.ceil(Math.max(...corners.map((p) => p.y)));
    return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
  }

  commitFreeTransform(): void {
    const t = this.freeTransform;
    const doc = this.doc;
    if (!t || !doc) return;
    const idx = doc.indexOf(t.layerId);
    const layer = idx >= 0 ? doc.layers[idx] : null;
    this.freeTransform = null;
    if (!layer) return;
    const before = this.cloneLayerExact(layer);
    const bounds = this.transformedLayerBounds(t);
    layer.suppressed = false;
    layer.x = bounds.x;
    layer.y = bounds.y;
    layer.canvas.width = bounds.w;
    layer.canvas.height = bounds.h;
    layer.ctx.clearRect(0, 0, bounds.w, bounds.h);
    layer.ctx.save();
    layer.ctx.imageSmoothingEnabled = true;
    layer.ctx.imageSmoothingQuality = 'high';
    layer.ctx.translate(t.centerX - bounds.x, t.centerY - bounds.y);
    layer.ctx.rotate(t.rotation);
    layer.ctx.scale(t.scaleX, t.scaleY);
    layer.ctx.drawImage(t.source, -t.sourceWidth / 2, -t.sourceHeight / 2);
    layer.ctx.restore();
    layer.kind = 'raster';
    layer.text = null;
    layer.touch();
    const after = this.cloneLayerExact(layer);
    this.history.push({
      label: 'Free Transform',
      undo: () => this.replaceLayerSnapshot(before, idx),
      redo: () => this.replaceLayerSnapshot(after, idx),
    });
    this.bump();
    this.invalidate();
  }

  cancelFreeTransform(): void {
    const t = this.freeTransform;
    this.freeTransform = null;
    if (!t) return;
    const layer = this.doc?.layers.find((l) => l.id === t.layerId);
    if (layer) layer.suppressed = false;
    this.notify();
    this.invalidate();
  }

  cropToSelection(): void {
    const doc = this.doc;
    const sel = this.selection;
    if (!doc) return;
    if (this.blockIfPsdProtectedDoc('Crop')) return;
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
    if (this.blockIfPsdProtectedDoc('Image Size')) return;
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
          if (l.psd) nl.psd = { ...l.psd, imported: { ...l.psd.imported, pixelRev: -1 } };
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
    if (this.blockIfAnyLocked('Reveal All')) return;
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
        // Exact clones keep layer ids (mask links) and PSD passthrough state.
        const layers = doc.layers.map((l) => {
          const nl = this.cloneLayerExact(l);
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
    if (this.blockIfPsdProtectedDoc('Rotate')) return;
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
    if (this.blockIfPsdProtectedDoc('Flip')) return;
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
    if (!doc) return;
    const deletionIds = doc.linkedLayerDeletionIds(id);
    if (deletionIds.length === 0) return;
    if (doc.layers.length - deletionIds.length <= 0) {
      this.flash('Cannot delete the only layer');
      return;
    }
    const before = this.layerStackSnapshot();
    doc.removeLinked(id);
    const after = this.layerStackSnapshot();
    this.history.push({
      label: 'Delete Layer',
      undo: () => this.restoreLayerStack(before),
      redo: () => this.restoreLayerStack(after),
    });
    this.bump();
    this.invalidate();
  }
  duplicateLayer(id: string): void {
    const doc = this.doc;
    if (!doc || doc.indexOf(id) < 0) return;
    if (this.blockIfLocked(doc.layers[doc.indexOf(id)])) return;
    const before = this.layerStackSnapshot();
    doc.duplicateLinked(id);
    const after = this.layerStackSnapshot();
    this.history.push({
      label: 'Duplicate Layer',
      undo: () => this.restoreLayerStack(before),
      redo: () => this.restoreLayerStack(after),
    });
    this.bump();
    this.invalidate();
  }
  moveLayer(id: string, delta: number): void {
    this.structural('Reorder Layer', () => this.doc!.move(id, delta));
  }
  reorderLayer(from: number, to: number): void {
    this.structural('Reorder Layer', () => this.doc!.reorder(from, to));
  }

  selectAnnotation(id: string | null): void {
    const doc = this.doc;
    if (id && !doc?.annotations.some((item) => item.id === id)) return;
    this.selectedAnnotationId = id;
    if (id) this.setTool('annotation');
    this.bump();
  }

  addAnnotation(
    kind: AnnotationKind,
    x: number,
    y: number,
    width: number,
    height: number,
    text = this.annotationText,
    options: Partial<Pick<AnnotationItem, 'rotation' | 'flipX' | 'flipY' | 'color'>> = {},
  ): AnnotationItem | null {
    const doc = this.doc;
    if (!doc) return null;
    let created: AnnotationItem | null = null;
    let createdId: string | null = null;
    this.structural('Add Annotation', () => {
      created = newAnnotation({
        kind,
        text,
        x,
        y,
        width,
        height,
        rotation: options.rotation,
        flipX: options.flipX,
        flipY: options.flipY,
        color: options.color ?? this.foregroundCss,
      });
      doc.annotations = [...doc.annotations, created];
      doc.annotationsVisible = true;
      createdId = created.id;
    });
    this.selectedAnnotationId = createdId;
    return created;
  }

  updateAnnotation(id: string, patch: Partial<Omit<AnnotationItem, 'id'>>): void {
    const doc = this.doc;
    if (!doc) return;
    this.structural('Edit Annotation', () => {
      doc.annotations = doc.annotations.map((item) => item.id === id ? { ...item, ...patch } : item);
    });
  }

  deleteAnnotation(id: string): void {
    const doc = this.doc;
    if (!doc) return;
    this.structural('Delete Annotation', () => {
      doc.annotations = doc.annotations.filter((item) => item.id !== id);
    });
    if (this.selectedAnnotationId === id) this.selectedAnnotationId = null;
  }

  setAnnotationsVisible(visible: boolean): void {
    const doc = this.doc;
    if (!doc) return;
    doc.annotationsVisible = visible;
    this.bump();
  }

  rasterizeAnnotations(): void {
    const doc = this.doc;
    if (!doc || !doc.annotations.some((item) => item.visible)) return;
    this.structural('Rasterize Annotations', () => {
      const layer = new Layer(doc.width, doc.height, 'Annotations');
      for (const item of doc.annotations) {
        if (item.visible) this.drawAnnotationToContext(layer.ctx, item);
      }
      layer.touch();
      doc.push(layer);
      doc.annotations = [];
    });
  }

  mergeDown(id: string): void {
    const doc = this.doc;
    if (!doc) return;
    const idx = doc.indexOf(id);
    if (idx <= 0) {
      this.flash('No layer below to merge into');
      return;
    }
    if (this.blockIfLocked(doc.layers[idx]) || this.blockIfLocked(doc.layers[idx - 1])) return;
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
    if (this.blockIfAnyLocked('Flatten')) return;
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
    if (this.blockIfLocked(layer)) return;
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
    if (this.blockIfLocked(layer)) return;
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
    if (this.blockIfLocked(layer)) return;
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
    if (this.blockIfLocked(layer)) return;
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
  fillActivePattern(kind: 'checker' | 'lines' | 'diagonal' | 'dots'): void {
    const layer = this.activeLayer;
    if (!layer) {
      this.flash('No active layer');
      return;
    }
    if (this.blockIfLocked(layer)) return;
    const tile = createCanvas(24, 24);
    const tc = ctx2d(tile);
    tc.fillStyle = '#303236';
    tc.fillRect(0, 0, tile.width, tile.height);
    tc.fillStyle = '#69707a';
    if (kind === 'checker') {
      for (let y = 0; y < tile.height; y += 12) {
        for (let x = 0; x < tile.width; x += 12) {
          tc.fillRect(x, y, 6, 6);
          tc.fillRect(x + 6, y + 6, 6, 6);
        }
      }
    } else if (kind === 'lines') {
      for (let x = 0; x < tile.width; x += 6) tc.fillRect(x, 0, 2, tile.height);
    } else if (kind === 'diagonal') {
      tc.lineWidth = 2;
      tc.strokeStyle = '#69707a';
      for (let x = -tile.width; x < tile.width * 2; x += 8) {
        tc.beginPath();
        tc.moveTo(x, tile.height);
        tc.lineTo(x + tile.width, 0);
        tc.stroke();
      }
    } else {
      tc.fillStyle = '#7e8790';
      for (let y = 4; y < tile.height; y += 8) {
        for (let x = 4; x < tile.width; x += 8) {
          tc.beginPath();
          tc.arc(x, y, 2, 0, Math.PI * 2);
          tc.fill();
        }
      }
    }
    const pattern = layer.ctx.createPattern(tile, 'repeat');
    if (!pattern) return;
    const region = this.editRegion(layer);
    const before = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    const mask = this.selectionMaskForLayer(layer);
    layer.ctx.save();
    layer.ctx.globalCompositeOperation = 'source-over';
    if (mask) {
      const tmp = createCanvas(layer.width, layer.height);
      const c = ctx2d(tmp);
      c.fillStyle = pattern;
      c.fillRect(0, 0, layer.width, layer.height);
      layer.ctx.drawImage(intersectMask(tmp, mask), 0, 0);
    } else {
      layer.ctx.fillStyle = pattern;
      layer.ctx.fillRect(0, 0, layer.width, layer.height);
    }
    layer.ctx.restore();
    layer.touch();
    const after = snapshotRegion(layer, region) ?? snapshotLayer(layer);
    this.history.push(pixelCommand(layer, before, after, 'Pattern Fill'));
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
      // All text deleted → remove the layer, unless it's the only one.
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

  private renderAnnotatedSource(source: HTMLCanvasElement, annotations: AnnotationItem[]): HTMLCanvasElement {
    const annotated = createCanvas(source.width, source.height);
    const ctx = ctx2d(annotated);
    ctx.drawImage(source, 0, 0);
    for (const item of annotations) this.drawAnnotationToContext(ctx, item);
    return annotated;
  }

  private drawAnnotationToContext(ctx: CanvasRenderingContext2D, item: AnnotationItem): void {
    ctx.save();
    ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
    ctx.rotate(item.rotation);
    ctx.scale(item.flipX ? -1 : 1, item.flipY ? -1 : 1);
    ctx.strokeStyle = item.color;
    ctx.fillStyle = item.color;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const x0 = -item.width / 2;
    const y0 = 0;
    const x1 = item.width / 2;
    const y1 = 0;
    if (item.kind === 'arrow' || item.kind === 'divider') {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      if (item.kind === 'arrow') {
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const size = 18;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - Math.cos(angle - Math.PI / 6) * size, y1 - Math.sin(angle - Math.PI / 6) * size);
        ctx.lineTo(x1 - Math.cos(angle + Math.PI / 6) * size, y1 - Math.sin(angle + Math.PI / 6) * size);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    const w = Math.max(34, item.width);
    const h = Math.max(26, item.height);
    const x = -w / 2;
    const y = -h / 2;
    if (item.kind === 'badge') {
      const r = Math.max(6, Math.min(16, h / 2));
      const radius = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      ctx.lineTo(x + radius, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#111111';
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x + 14, 0, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${Math.max(13, Math.min(22, h * 0.42))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.text, 8, 0, Math.max(10, w - 30));
      ctx.restore();
      return;
    }

    if (item.kind === 'note') {
      ctx.fillStyle = '#fff5a8';
      ctx.strokeStyle = '#111111';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, 5);
      ctx.fill();
      ctx.stroke();
      const fold = Math.min(28, w * 0.28, h * 0.42);
      ctx.fillStyle = '#eadc73';
      ctx.beginPath();
      ctx.moveTo(x + w - fold, y + h);
      ctx.lineTo(x + w, y + h - fold);
      ctx.lineTo(x + w, y + h);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.strokeStyle = '#111111';
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, item.kind === 'callout' ? 14 : 7);
      ctx.fill();
      ctx.stroke();
      if (item.kind === 'callout') {
        ctx.beginPath();
        ctx.moveTo(x + 18, y + h - 1);
        ctx.lineTo(x + 35, y + h + 18);
        ctx.lineTo(x + 45, y + h - 1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    ctx.fillStyle = '#111111';
    ctx.font = `${Math.max(13, Math.min(24, h * 0.38))}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(item.text, x + 10, y + h / 2, Math.max(10, w - 20));
    ctx.restore();
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

  insertGenerativeFill(
    source: CanvasImageSource,
    sw: number,
    sh: number,
    mask: HTMLCanvasElement,
    name = 'Generative fill',
    sourceMeta: LayerSourceMeta = {},
  ): string | null {
    const doc = this.doc;
    if (!doc) return null;
    const fill = this.generativeFillLayerCanvas(source, sw, sh, mask);
    if (!fill) return null;

    let layerId: string | null = null;
    this.structural('Generative Fill', () => {
      const layer = new Layer(doc.width, doc.height, name, undefined, 0, 0);
      layer.sourceAssetId = sourceMeta.assetId ?? null;
      layer.sourcePath = sourceMeta.path ?? null;
      layer.ctx.drawImage(fill, 0, 0);
      layer.touch();
      doc.insertAboveActive(layer);
      layerId = layer.id;
    });
    return layerId;
  }

  insertAiRetouchResult(
    request: AiRetouchRequest,
    source: CanvasImageSource,
    sw: number,
    sh: number,
    sourceMeta: LayerSourceMeta = {},
    maskSource: CanvasImageSource | null = null,
    maskSw = 0,
    maskSh = 0,
  ): string | null {
    const doc = this.doc;
    if (!doc) return null;
    if (sw !== doc.width || sh !== doc.height) return null;
    if (maskSource && (maskSw !== doc.width || maskSh !== doc.height)) return null;
    const maskLayer = doc.layers.find((layer) => layer.id === request.maskLayerId && layer.kind === 'ai-retouch-mask') ?? null;

    const before = this.layerStackSnapshot();
    if (maskLayer && maskSource) {
      maskLayer.ctx.clearRect(0, 0, maskLayer.width, maskLayer.height);
      maskLayer.ctx.drawImage(maskSource, 0, 0, maskSw, maskSh, 0, 0, doc.width, doc.height);
      maskLayer.visible = false;
      maskLayer.touch();
    } else if (maskLayer) {
      maskLayer.visible = false;
    }
    const layer = new Layer(doc.width, doc.height, `AI Retouch: ${request.toolName}`, undefined, 0, 0);
    layer.sourceAssetId = sourceMeta.assetId ?? null;
    layer.sourcePath = sourceMeta.path ?? null;
    layer.maskLayerId = maskLayer?.id ?? null;
    layer.ctx.drawImage(source, 0, 0);
    layer.touch();
    doc.insertAboveActive(layer);

    const layerId = layer.id;
    const after = this.layerStackSnapshot();
    this.history.push({
      label: 'AI Retouch',
      undo: () => this.restoreLayerStack(before),
      redo: () => this.restoreLayerStack(after),
    });
    this.bump();
    this.invalidate();
    this.pendingAiRetouch = null;
    this.setAiRetouchPreview(null);
    return layerId;
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
