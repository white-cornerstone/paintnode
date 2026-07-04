// Parse a Photoshop (.psd) file into a PaintDocument.
//
// The file is read with `useRawData` so every layer keeps its original compressed
// channel data (`rawData`). Layers PaintNode supports become normal editable layers;
// Photoshop-only layers (adjustments, smart objects, text, vectors, effects) become
// locked raster previews. Either way the parsed ag-psd objects are kept on
// `layer.psd` / `doc.psdSource` so PSD export can write untouched layers back
// byte-identically (see `save.ts`).

import type { Layer as AgPsdLayer, PixelData } from 'ag-psd';
import { PaintDocument } from '../engine/Document.svelte';
import { Layer } from '../engine/Layer.svelte';
import { clamp, createCanvas, ctx2d } from '../engine/types';
import type { PsdLayerMaskState, PsdLayerSource, PsdLockReason } from '../engine/psdSource';
import { textBounds } from '../engine/text/render';
import { flattenPsdTree, importNotices, psdLockReason, psdTextToModel, psdToBlend } from './import';

export interface PsdImportResult {
  doc: PaintDocument;
  notices: string[];
}

/** '8BPS' magic with version 2 marks a PSB (Large Document Format) file. */
function isPsb(buffer: ArrayBuffer): boolean {
  const view = new DataView(buffer);
  return view.byteLength >= 6 && view.getUint32(0) === 0x38425053 && view.getUint16(4) === 2;
}

/** Convert a decoded grayscale mask (r=g=b=value) into an alpha-coverage canvas. */
function maskAlphaCanvas(data: PixelData): HTMLCanvasElement {
  const out = createCanvas(data.width, data.height);
  const c = ctx2d(out);
  const image = c.createImageData(data.width, data.height);
  for (let i = 0; i < data.data.length; i += 4) {
    image.data[i] = 255;
    image.data[i + 1] = 255;
    image.data[i + 2] = 255;
    image.data[i + 3] = data.data[i];
  }
  c.putImageData(image, 0, 0);
  return out;
}

function maskStateFor(
  src: AgPsdLayer,
  layer: Layer,
  decodeMask: (layer: AgPsdLayer) => PixelData | undefined,
): PsdLayerMaskState | null {
  const mask = src.mask;
  if (!mask) return null;
  const data = decodeMask(src);
  if (!data || !data.width || !data.height) return null;
  const relative = mask.positionRelativeToLayer === true;
  const maskCanvas = maskAlphaCanvas(data);
  // Offset relative to the layer's top-left, so the mask follows layer moves.
  const x = (mask.left ?? 0) - (relative ? 0 : (src.left ?? 0));
  const y = (mask.top ?? 0) - (relative ? 0 : (src.top ?? 0));
  const defaultColor = mask.defaultColor ?? 0;

  const coverage = createCanvas(layer.width, layer.height);
  const c = ctx2d(coverage);
  if (defaultColor > 0) {
    c.fillStyle = `rgba(255, 255, 255, ${defaultColor / 255})`;
    c.fillRect(0, 0, coverage.width, coverage.height);
    c.clearRect(x, y, maskCanvas.width, maskCanvas.height);
  }
  c.drawImage(maskCanvas, x, y);

  return {
    canvas: maskCanvas,
    x,
    y,
    defaultColor,
    disabled: mask.disabled === true,
    coverage,
  };
}

/**
 * Rebuild a PSD layer mask as a PaintNode linked mask layer (doc-sized, white
 * pixels whose alpha is the mask coverage), so it shows up and edits as a
 * parent–child mask row exactly like masks created in PaintNode.
 */
function linkedMaskLayerFor(
  src: AgPsdLayer,
  parent: Layer,
  docWidth: number,
  docHeight: number,
  decodeMask: (layer: AgPsdLayer) => PixelData | undefined,
): Layer | null {
  const mask = src.mask;
  if (!mask) return null;
  const data = decodeMask(src);
  if (!data || !data.width || !data.height) return null;
  const relative = mask.positionRelativeToLayer === true;
  const x = (mask.left ?? 0) + (relative ? (src.left ?? 0) : 0);
  const y = (mask.top ?? 0) + (relative ? (src.top ?? 0) : 0);
  const out = new Layer(docWidth, docHeight, `${parent.name} mask`);
  out.kind = 'ai-retouch-mask';
  // Hidden by convention: linked masks apply during compositing either way, the
  // eye only shows the mask overlay (matches masks created by the AI flow).
  out.visible = false;
  const c = out.ctx;
  const defaultColor = mask.defaultColor ?? 0;
  if (defaultColor > 0) {
    c.fillStyle = `rgba(255, 255, 255, ${defaultColor / 255})`;
    c.fillRect(0, 0, out.width, out.height);
    c.clearRect(x, y, data.width, data.height);
  }
  c.drawImage(maskAlphaCanvas(data), x, y);
  out.touch();
  return out;
}

function psdLayerFullLocked(src: AgPsdLayer): boolean {
  const protectedFlags = src.protected;
  if (protectedFlags?.composite === true && protectedFlags.position === true) return true;
  return src.transparencyProtected === true && protectedFlags?.transparency === false;
}

/** Parse a Photoshop (.psd) file into a PaintDocument with passthrough state. */
export async function loadPsd(buffer: ArrayBuffer): Promise<PsdImportResult> {
  if (isPsb(buffer)) {
    throw new Error('PSB (Large Document Format) files are not supported yet');
  }
  const { readPsd, getLayerCanvas, getLayerMaskImageData } = await import('ag-psd');
  const psd = readPsd(buffer, {
    useRawData: true,
    skipThumbnail: true,
    skipCompositeImageData: true,
  });
  if (psd.bitsPerChannel && psd.bitsPerChannel !== 8) {
    throw new Error(`${psd.bitsPerChannel}-bit PSD files are not supported yet`);
  }
  if (!psd.width || !psd.height) throw new Error('Corrupt PSD: invalid image dimensions');

  const doc = new PaintDocument(psd.width, psd.height, 'Untitled');
  const flat = flattenPsdTree(psd);
  const layers: Layer[] = [];

  for (const item of flat) {
    const src = item.layer;
    const blend = psdToBlend(src.blendMode);
    let lockReason: PsdLockReason | null = psdLockReason(src);
    // Representable text layers become editable PaintNode text instead of locked.
    const textModel = lockReason === 'text' && src.text ? psdTextToModel(src.text) : null;
    if (textModel) lockReason = null;
    const canvas = getLayerCanvas(src);
    // Text layers use a document-sized canvas at (0,0) like PaintNode-native text,
    // so the existing edit/commit pipeline re-renders them in place.
    const layer = textModel
      ? new Layer(psd.width, psd.height, src.name || 'Layer')
      : new Layer(
          Math.max(1, canvas?.width ?? 1),
          Math.max(1, canvas?.height ?? 1),
          src.name || 'Layer',
          undefined,
          src.left ?? 0,
          src.top ?? 0,
        );
    if (canvas) layer.ctx.drawImage(canvas, textModel ? (src.left ?? 0) : 0, textModel ? (src.top ?? 0) : 0);
    if (textModel) {
      // Anchor the model so PaintNode's own layout lands on the PSD pixel bounds.
      const bounds = textBounds(textModel);
      textModel.x = (src.left ?? 0) - bounds.x;
      textModel.y = (src.top ?? 0) - bounds.y;
      layer.kind = 'text';
      layer.text = textModel;
    }
    layer.opacity = clamp(src.opacity ?? 1, 0, 1);
    layer.visible = item.visible;
    layer.blendMode = blend.mode;
    layer.userLocked = psdLayerFullLocked(src);

    let importedMask: PsdLayerSource['imported']['mask'] = null;
    if (lockReason) {
      // Locked layers keep their mask internal: composited and passed through as-is.
      layer.psdMask = maskStateFor(src, layer, getLayerMaskImageData);
    } else {
      const maskLayer = linkedMaskLayerFor(src, layer, psd.width, psd.height, getLayerMaskImageData);
      if (maskLayer) {
        layers.push(maskLayer); // sits directly below its parent in the stack
        layer.maskLayerId = maskLayer.id;
        layer.maskEnabled = src.mask?.disabled !== true;
        importedMask = { layerId: maskLayer.id, pixelRev: maskLayer.pixelRev, x: maskLayer.x, y: maskLayer.y };
      }
    }
    layer.touch();
    layer.psd = {
      layer: src,
      groupPath: item.groupPath,
      lockReason,
      clipping: src.clipping === true,
      blendApproximated: blend.approximated,
      imported: {
        x: layer.x,
        y: layer.y,
        pixelRev: layer.pixelRev,
        blendMode: blend.mode,
        visible: layer.visible,
        mask: importedMask,
        locked: layer.userLocked,
      },
    };
    layers.push(layer);
  }

  if (layers.length === 0) layers.push(new Layer(psd.width, psd.height, 'Layer 1'));
  doc.layers = layers;
  doc.activeLayerId = layers[layers.length - 1].id;

  // Classify text layers by whether they actually converted, so counts are honest.
  const classify = (l: AgPsdLayer): PsdLockReason | null => {
    const reason = psdLockReason(l);
    if (reason === 'text' && l.text && psdTextToModel(l.text)) return null;
    return reason;
  };
  const notices = importNotices(flat, classify);
  const editableText = flat.filter(
    (item) => psdLockReason(item.layer) === 'text' && classify(item.layer) === null,
  ).length;
  if (editableText > 0) {
    notices.push(
      `${editableText} text layer${editableText === 1 ? ' is' : 's are'} editable; Photoshop re-renders edited text on next open`,
    );
  }
  doc.psdSource = { psd, notices };
  return { doc, notices };
}
