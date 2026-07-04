import { cloneAiRetouchMetadata, type AiRetouchMaskMetadata } from './aiRetouch';
import type { BlendMode, Rect } from './types';
import { createCanvas, ctx2d, uid } from './types';
import { cloneModel, type TextModel } from './text/model';
import type { PsdLayerMaskState, PsdLayerSource } from './psdSource';

export type LayerKind = 'raster' | 'text' | 'ai-retouch-mask';

/**
 * A single layer. Metadata fields are reactive ($state) so the UI updates automatically;
 * pixel data lives in `canvas` and is mutated imperatively by tools. A text layer
 * (`kind === 'text'`) additionally carries an editable `text` model; its canvas holds the
 * rasterized rendering of that model and is re-rendered whenever the model changes.
 */
export class Layer {
  readonly id: string;
  name = $state('Layer');
  x = $state(0);
  y = $state(0);
  opacity = $state(1); // 0..1
  visible = $state(true);
  blendMode = $state<BlendMode>('source-over');
  sourceAssetId = $state<string | null>(null);
  sourcePath = $state<string | null>(null);
  maskLayerId = $state<string | null>(null);
  maskEnabled = $state(true);
  /** User-toggleable full layer lock. Photoshop-only import locks live in `psd`. */
  userLocked = $state(false);
  /** 'text' = editable text layer (see `text`); 'raster' = plain pixels. */
  kind = $state<LayerKind>('raster');
  /** Editable text model when `kind === 'text'`, else null. */
  text = $state<TextModel | null>(null);
  /** AI retouch mask metadata when `kind === 'ai-retouch-mask'`, else null. */
  aiRetouch = $state<AiRetouchMaskMetadata | null>(null);
  /**
   * Photoshop passthrough when imported from a PSD, else null. Holds the original
   * parsed layer so untouched layers are written back losslessly on PSD export.
   * Set once at import; never mutated afterwards.
   */
  psd: PsdLayerSource | null = null;
  /** Imported PSD layer mask (composited and preserved on export; not editable). */
  psdMask: PsdLayerMaskState | null = null;
  /** Bumped whenever pixels change, so reactive thumbnails can refresh. */
  pixelRev = $state(0);
  /**
   * Transient: when true the compositor skips this layer. Used while a text layer is being
   * edited (the live HTML overlay stands in for its pixels). Not cloned or persisted.
   */
  suppressed = false;

  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  constructor(width: number, height: number, name = 'Layer', id?: string, x = 0, y = 0) {
    this.id = id ?? uid('layer');
    this.name = name;
    this.x = Math.round(x);
    this.y = Math.round(y);
    this.canvas = createCanvas(width, height);
    this.ctx = ctx2d(this.canvas);
  }

  get width(): number {
    return this.canvas.width;
  }
  get height(): number {
    return this.canvas.height;
  }

  /** True for Photoshop-only layers PaintNode preserves but cannot edit. */
  get psdLocked(): boolean {
    return this.psd?.lockReason != null;
  }

  /** True when the layer should reject edits in PaintNode. */
  get locked(): boolean {
    return this.userLocked || this.psdLocked;
  }

  /** Mark pixels dirty (call after drawing into `ctx`). */
  touch(): void {
    this.pixelRev++;
  }

  clear(rect?: Rect): void {
    if (rect) this.ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    else this.ctx.clearRect(0, 0, this.width, this.height);
    this.touch();
  }

  fill(style: string): void {
    this.ctx.save();
    this.ctx.globalCompositeOperation = 'source-over';
    this.ctx.fillStyle = style;
    this.ctx.fillRect(0, 0, this.width, this.height);
    this.ctx.restore();
    this.touch();
  }

  /** Deep copy (new id), used by "Duplicate Layer". */
  clone(newName?: string): Layer {
    const copy = new Layer(this.width, this.height, newName ?? `${this.name} copy`);
    copy.x = this.x;
    copy.y = this.y;
    copy.opacity = this.opacity;
    copy.visible = this.visible;
    copy.blendMode = this.blendMode;
    copy.sourceAssetId = this.sourceAssetId;
    copy.sourcePath = this.sourcePath;
    copy.maskLayerId = this.maskLayerId;
    copy.maskEnabled = this.maskEnabled;
    copy.userLocked = this.userLocked;
    copy.kind = this.kind;
    copy.text = this.text ? cloneModel(this.text) : null;
    copy.aiRetouch = cloneAiRetouchMetadata(this.aiRetouch);
    // A duplicate has no Photoshop packet of its own (psd stays null), but keeps
    // the imported mask so it composites the same way.
    copy.psdMask = this.psdMask;
    copy.ctx.drawImage(this.canvas, 0, 0);
    copy.touch();
    return copy;
  }
}
