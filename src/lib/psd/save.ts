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

export function buildPsdDocument(doc: PaintDocument, options: BuildPsdOptions = {}): Psd {
  const children = doc.layers
    .slice()
    .map((layer) => layerToPsd(doc, layer))
    .filter((layer): layer is PsdLayer => layer !== null);

  return {
    width: doc.width,
    height: doc.height,
    children,
    canvas: options.compositeCanvas ?? compositeToCanvas(doc),
    imageResources: {
      versionInfo: {
        hasRealMergedData: true,
        writerName: 'PaintNode',
        readerName: 'PaintNode',
        fileVersion: 1,
      },
    },
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
