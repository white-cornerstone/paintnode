import type { PaintDocument } from './Document.svelte';
import type { Layer } from './Layer.svelte';
import type { Selection } from './selection';
import { intersectMask } from './selection';
import { createCanvas, ctx2d } from './types';

/**
 * A brush/eraser stroke in progress. `buffer` is a full-document-size canvas holding
 * the stroke's coverage painted at full alpha (in the brush color for paint). The whole
 * thing is composited at `opacity` so opacity applies per-stroke, not per-stamp.
 */
export interface ActiveStroke {
  layerId: string;
  buffer: HTMLCanvasElement;
  op: 'source-over' | 'destination-out';
  opacity: number;
}

function drawLayer(target: CanvasRenderingContext2D, layer: Layer, src: CanvasImageSource): void {
  target.globalCompositeOperation = layer.blendMode;
  target.globalAlpha = layer.opacity;
  target.drawImage(src, layer.x, layer.y);
}

function layerMaskFor(doc: PaintDocument, layer: Layer): Layer | null {
  if (!layer.maskLayerId) return null;
  const mask = doc.layers.find((item) => item.id === layer.maskLayerId);
  return mask?.kind === 'ai-retouch-mask' ? mask : null;
}

function applyLayerMask(layer: Layer, src: CanvasImageSource, mask: Layer, scratch?: HTMLCanvasElement): HTMLCanvasElement {
  const out = scratch ?? createCanvas(layer.width, layer.height);
  if (out.width !== layer.width || out.height !== layer.height) {
    out.width = layer.width;
    out.height = layer.height;
  }
  const c = ctx2d(out);
  c.globalCompositeOperation = 'source-over';
  c.globalAlpha = 1;
  c.clearRect(0, 0, out.width, out.height);
  c.drawImage(src, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(mask.canvas, mask.x - layer.x, mask.y - layer.y);
  c.globalCompositeOperation = 'source-over';
  return out;
}

/**
 * Composite every visible layer of `doc` onto `target`, bottom-to-top. If `stroke` is
 * supplied, the matching layer is rendered with the in-progress stroke merged in (via the
 * provided `scratch` canvas to avoid per-frame allocation).
 */
export function compositeLayers(
  target: CanvasRenderingContext2D,
  doc: PaintDocument,
  stroke?: ActiveStroke | null,
  scratch?: HTMLCanvasElement,
  selection?: Selection | null,
): void {
  target.save();
  for (const layer of doc.layers) {
    if (layer.kind === 'ai-retouch-mask') continue;
    if (!layer.visible || layer.opacity <= 0 || layer.suppressed) continue;

    const mask = layerMaskFor(doc, layer);

    if (stroke && stroke.layerId === layer.id) {
      const sc = scratch ?? createCanvas(layer.width, layer.height);
      if (sc.width !== layer.width || sc.height !== layer.height) {
        sc.width = layer.width;
        sc.height = layer.height;
      }
      const sctx = ctx2d(sc);
      sctx.globalCompositeOperation = 'source-over';
      sctx.globalAlpha = 1;
      sctx.clearRect(0, 0, sc.width, sc.height);
      sctx.drawImage(layer.canvas, 0, 0);
      const buf = selection ? intersectMask(stroke.buffer, selection.mask) : stroke.buffer;
      sctx.globalCompositeOperation = stroke.op;
      sctx.globalAlpha = stroke.opacity;
      sctx.drawImage(buf, -layer.x, -layer.y);
      sctx.globalCompositeOperation = 'source-over';
      sctx.globalAlpha = 1;
      drawLayer(target, layer, mask ? applyLayerMask(layer, sc, mask) : sc);
    } else {
      drawLayer(target, layer, mask ? applyLayerMask(layer, layer.canvas, mask, scratch) : layer.canvas);
    }
  }
  target.restore();
}

/** Flatten the whole document into a fresh document-size canvas. */
export function compositeToCanvas(doc: PaintDocument): HTMLCanvasElement {
  const out = createCanvas(doc.width, doc.height);
  compositeLayers(ctx2d(out), doc);
  return out;
}

/** Downscale `source` to fit within max dimensions, preserving aspect ratio. */
export function makeThumbnail(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  maxW: number,
  maxH: number,
): HTMLCanvasElement {
  const scale = Math.min(maxW / srcW, maxH / srcH, 1);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const out = createCanvas(w, h);
  const c = ctx2d(out);
  c.imageSmoothingEnabled = true;
  c.imageSmoothingQuality = 'high';
  c.drawImage(source, 0, 0, w, h);
  return out;
}
