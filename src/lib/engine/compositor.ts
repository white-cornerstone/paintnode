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
    if (!layer.visible || layer.opacity <= 0 || layer.suppressed) continue;

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
      drawLayer(target, layer, sc);
    } else {
      drawLayer(target, layer, layer.canvas);
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
