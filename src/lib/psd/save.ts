import type { BlendMode as PsdBlendMode, Layer as PsdLayer, LayerTextData, Psd, PixelData } from 'ag-psd';
import type { PaintDocument } from '../engine/Document.svelte';
import type { Layer } from '../engine/Layer.svelte';
import type { BlendMode, RGB } from '../engine/types';
import { compositeToCanvas } from '../engine/compositor';
import { modelToPlainText, type TextModel, type TextParagraph, type TextRun, type TextStyle } from '../engine/text/model';

const BLEND_TO_PSD: Record<BlendMode, PsdBlendMode> = {
  'source-over': 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color dodge',
  'color-burn': 'color burn',
  'hard-light': 'hard light',
  'soft-light': 'soft light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

export interface BuildPsdOptions {
  compositeCanvas?: HTMLCanvasElement;
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function firstCssFamily(family: string): string {
  return (family.split(',')[0] ?? family).trim().replace(/^["']|["']$/g, '') || 'sans-serif';
}

function psdFontName(style: TextStyle): string {
  const family = firstCssFamily(style.family);
  if (family === 'sans-serif' || family === 'system-ui') return 'ArialMT';
  if (family === 'serif') return 'TimesNewRomanPSMT';
  if (family === 'monospace') return 'Courier';
  return family;
}

function psdColor(color: RGB): RGB {
  return { r: clamp255(color.r), g: clamp255(color.g), b: clamp255(color.b) };
}

function psdStyle(style: TextStyle) {
  return {
    font: { name: psdFontName(style) },
    fontSize: Math.max(1, style.size),
    fauxBold: style.bold,
    fauxItalic: style.italic,
    underline: style.underline,
    tracking: style.tracking ? Math.round((style.tracking / Math.max(1, style.size)) * 1000) : 0,
    fillColor: psdColor(style.color),
  };
}

function lineLeading(paragraph: TextParagraph): number | undefined {
  const maxSize = paragraph.runs.reduce((size, run) => Math.max(size, run.style.size), 0);
  return maxSize > 0 ? maxSize * paragraph.lineHeight : undefined;
}

function psdJustification(paragraph: TextParagraph): 'left' | 'center' | 'right' {
  if (paragraph.align === 'center') return 'center';
  if (paragraph.align === 'right') return 'right';
  return 'left';
}

function pushStyleRun(styleRuns: NonNullable<LayerTextData['styleRuns']>, text: string, run: TextRun, leading?: number): void {
  if (!text.length) return;
  styleRuns.push({
    length: text.length,
    style: {
      ...psdStyle(run.style),
      leading,
    },
  });
}

function firstTextRun(model: TextModel): TextRun | null {
  for (const paragraph of model.paragraphs) {
    for (const run of paragraph.runs) {
      if (run.text.length) return run;
    }
  }
  return model.paragraphs[0]?.runs[0] ?? null;
}

export function textModelToPsdText(model: TextModel, layer: Layer): LayerTextData {
  const text = modelToPlainText(model);
  const firstRun = firstTextRun(model);
  const styleRuns: NonNullable<LayerTextData['styleRuns']> = [];
  const paragraphStyleRuns: NonNullable<LayerTextData['paragraphStyleRuns']> = [];

  for (let i = 0; i < model.paragraphs.length; i++) {
    const paragraph = model.paragraphs[i];
    const hasNewline = i < model.paragraphs.length - 1;
    const leading = lineLeading(paragraph);
    let paragraphLength = 0;

    for (const run of paragraph.runs) {
      pushStyleRun(styleRuns, run.text, run, leading);
      paragraphLength += run.text.length;
    }

    if (hasNewline) {
      const newlineStyle = paragraph.runs.at(-1) ?? firstRun;
      if (newlineStyle) pushStyleRun(styleRuns, '\n', newlineStyle, leading);
      paragraphLength += 1;
    }

    if (paragraphLength > 0) {
      paragraphStyleRuns.push({
        length: paragraphLength,
        style: { justification: psdJustification(paragraph), leadingType: 0 },
      });
    }
  }

  const fallbackStyle = firstRun ? psdStyle(firstRun.style) : undefined;
  const fallbackParagraph = model.paragraphs[0];

  return {
    text,
    transform: [1, 0, 0, 1, layer.x + model.x, layer.y + model.y],
    antiAlias: 'smooth',
    orientation: 'horizontal',
    style: fallbackStyle,
    styleRuns: styleRuns.length ? styleRuns : undefined,
    paragraphStyle: fallbackParagraph ? { justification: psdJustification(fallbackParagraph), leadingType: 0 } : undefined,
    paragraphStyleRuns: paragraphStyleRuns.length ? paragraphStyleRuns : undefined,
    shapeType: 'point',
  };
}

function maskCoverage(data: Uint8ClampedArray, index: number): number {
  const luminance = Math.round((data[index] * 54 + data[index + 1] * 183 + data[index + 2] * 19) / 256);
  return clamp255((luminance * data[index + 3]) / 255);
}

export function maskImageDataForPsd(mask: HTMLCanvasElement): PixelData {
  const ctx = mask.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not read layer mask pixels');
  const source = ctx.getImageData(0, 0, mask.width, mask.height);
  const out = new Uint8ClampedArray(source.data.length);
  for (let i = 0; i < source.data.length; i += 4) {
    const coverage = maskCoverage(source.data, i);
    out[i] = coverage;
    out[i + 1] = coverage;
    out[i + 2] = coverage;
    out[i + 3] = 255;
  }
  return { width: mask.width, height: mask.height, data: out };
}

function linkedPsdMask(doc: PaintDocument, layer: Layer): PsdLayer['mask'] {
  const mask = doc.linkedMaskFor(layer);
  if (!mask) return undefined;
  return {
    top: mask.y,
    left: mask.x,
    disabled: !layer.maskEnabled,
    positionRelativeToLayer: false,
    fromVectorData: false,
    imageData: maskImageDataForPsd(mask.canvas),
  };
}

function layerToPsd(doc: PaintDocument, layer: Layer): PsdLayer | null {
  if (layer.kind === 'ai-retouch-mask') return null;

  const psdLayer: PsdLayer = {
    name: layer.name,
    left: layer.x,
    top: layer.y,
    opacity: Math.max(0, Math.min(1, layer.opacity)),
    hidden: !layer.visible,
    blendMode: BLEND_TO_PSD[layer.blendMode] ?? 'normal',
    canvas: layer.canvas,
    mask: linkedPsdMask(doc, layer),
  };

  if (layer.kind === 'text' && layer.text) {
    psdLayer.text = textModelToPsdText(layer.text, layer);
  }

  return psdLayer;
}

/**
 * Blend mode to write for an imported layer: keep the original PSD mode (which may be
 * one PaintNode only approximates, e.g. 'linear light') unless the user changed it.
 */
function psdBlendFor(layer: Layer): PsdLayer['blendMode'] {
  const meta = layer.psd!;
  if (layer.blendMode !== meta.imported.blendMode) return BLEND_TO_PSD[layer.blendMode] ?? 'normal';
  return meta.layer.blendMode;
}

/** True when an imported layer's pixels are untouched since import. */
export function isCleanPsdLayer(doc: PaintDocument, layer: Layer): boolean {
  const meta = layer.psd;
  if (!meta) return false;
  if (layer.pixelRev !== meta.imported.pixelRev) return false;
  // A PaintNode mask was attached after import — the layer record must be rebuilt.
  if (doc.linkedMaskFor(layer)) return false;
  return true;
}

function movedBy(layer: Layer): { dx: number; dy: number } {
  const meta = layer.psd!;
  return { dx: layer.x - meta.imported.x, dy: layer.y - meta.imported.y };
}

/**
 * Re-emit the original parsed layer (with its `rawData` channels, so pixels and
 * Photoshop-only blocks round-trip byte-identically), patching only the safe
 * single-field edits PaintNode allows on imported layers.
 */
export function passthroughPsdLayer(layer: Layer): PsdLayer {
  const meta = layer.psd!;
  const src = meta.layer;
  const out: PsdLayer = { ...src };
  out.name = layer.name;
  out.hidden = !layer.visible;
  out.opacity = Math.max(0, Math.min(1, layer.opacity));
  out.blendMode = psdBlendFor(layer);
  const { dx, dy } = movedBy(layer);
  // Locked layers cannot be moved in PaintNode (their internal transforms would
  // desync), so a position patch only ever applies to editable raster layers.
  if ((dx !== 0 || dy !== 0) && !meta.lockReason) {
    out.top = (src.top ?? 0) + dy;
    out.left = (src.left ?? 0) + dx;
    out.bottom = (src.bottom ?? 0) + dy;
    out.right = (src.right ?? 0) + dx;
    if (src.mask && src.mask.positionRelativeToLayer !== true) {
      out.mask = {
        ...src.mask,
        top: (src.mask.top ?? 0) + dy,
        left: (src.mask.left ?? 0) + dx,
        bottom: (src.mask.bottom ?? 0) + dy,
        right: (src.mask.right ?? 0) + dx,
      };
    }
  }
  return out;
}

/** Rebuild an edited imported layer from its PaintNode canvas, keeping parsed metadata. */
function rebuildImportedLayer(doc: PaintDocument, layer: Layer): PsdLayer {
  const meta = layer.psd!;
  const { rawData, imageData, canvas, children, top, left, bottom, right, mask, ...rest } = meta.layer;
  const out: PsdLayer = {
    ...rest,
    name: layer.name,
    left: layer.x,
    top: layer.y,
    opacity: Math.max(0, Math.min(1, layer.opacity)),
    hidden: !layer.visible,
    blendMode: psdBlendFor(layer),
    canvas: layer.canvas,
  };
  const linked = linkedPsdMask(doc, layer);
  if (linked) {
    out.mask = linked;
  } else if (mask && layer.psdMask) {
    // The imported mask is linked to the layer (offsets are layer-relative).
    const maskCanvas = layer.psdMask.canvas;
    out.mask = {
      ...mask,
      left: layer.x + layer.psdMask.x,
      top: layer.y + layer.psdMask.y,
      right: layer.x + layer.psdMask.x + maskCanvas.width,
      bottom: layer.y + layer.psdMask.y + maskCanvas.height,
      positionRelativeToLayer: false,
      disabled: layer.psdMask.disabled,
      imageData: maskImageDataForPsd(maskCanvas),
    };
  } else if (mask) {
    out.mask = { ...mask };
  }
  return out;
}

function strippedGroupNode(group: PsdLayer): PsdLayer {
  const { imageData, canvas, children, ...rest } = group;
  return { ...rest, children: [] };
}

/**
 * Build the PSD layer tree from the PaintNode stack. Imported layers re-emit their
 * original data when untouched and are rebuilt from canvas when edited; the original
 * group tree is reconstructed from each layer's recorded group chain. Layers created
 * in PaintNode join the group of the layer directly below them in the stack.
 */
export function buildPsdChildren(doc: PaintDocument): PsdLayer[] {
  const root: PsdLayer[] = [];
  const groupNodes = new Map<PsdLayer, PsdLayer>();
  let previousChain: PsdLayer[] = [];

  const listFor = (chain: PsdLayer[]): PsdLayer[] => {
    let list = root;
    for (const group of chain) {
      let node = groupNodes.get(group);
      if (!node) {
        node = strippedGroupNode(group);
        groupNodes.set(group, node);
        list.push(node);
      }
      list = node.children!;
    }
    return list;
  };

  for (const layer of doc.layers) {
    const meta = layer.psd;
    // Locked layers can never be edited in PaintNode, so they always pass through —
    // rebuilding one from its raster preview would destroy its Photoshop data.
    const node = meta
      ? meta.lockReason !== null || isCleanPsdLayer(doc, layer)
        ? passthroughPsdLayer(layer)
        : rebuildImportedLayer(doc, layer)
      : layerToPsd(doc, layer);
    if (!node) continue;
    const chain = meta ? meta.groupPath : previousChain;
    listFor(chain).push(node);
    previousChain = chain;
  }
  return root;
}

export function buildPsdDocument(doc: PaintDocument, options: BuildPsdOptions = {}): Psd {
  const children = buildPsdChildren(doc);
  const composite = options.compositeCanvas ?? compositeToCanvas(doc);
  const versionInfo = {
    hasRealMergedData: true,
    writerName: 'PaintNode',
    readerName: 'PaintNode',
    fileVersion: 1,
  };

  if (doc.psdSource) {
    // Pass document-level Photoshop resources through (linked smart-object files,
    // guides, resolution, global light, …); regenerate the composite and thumbnail.
    const {
      children: sourceChildren,
      canvas: sourceCanvas,
      imageData: sourceImageData,
      rawCompositeData,
      width,
      height,
      ...rest
    } = doc.psdSource.psd;
    return {
      ...rest,
      width: doc.width,
      height: doc.height,
      children,
      canvas: composite,
      imageResources: {
        ...(rest.imageResources ?? {}),
        thumbnail: undefined,
        thumbnailRaw: undefined,
        versionInfo,
      },
    };
  }

  return {
    width: doc.width,
    height: doc.height,
    children,
    canvas: composite,
    imageResources: { versionInfo },
  };
}

export async function savePsdBytes(doc: PaintDocument): Promise<Uint8Array> {
  const { writePsdUint8Array } = await import('ag-psd');
  const psd = buildPsdDocument(doc);
  return writePsdUint8Array(psd, {
    generateThumbnail: true,
    noBackground: true,
  });
}

export async function savePsd(doc: PaintDocument): Promise<Blob> {
  const bytes = await savePsdBytes(doc);
  const part = bytes.buffer instanceof ArrayBuffer
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : new Uint8Array(bytes);
  return new Blob([part], { type: 'image/vnd.adobe.photoshop' });
}
