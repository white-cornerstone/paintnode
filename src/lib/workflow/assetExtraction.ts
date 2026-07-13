import type { DecoupledLayerResult } from '../integrations/desktop';
import {
  PAINTNODE_CHROMA_KEY_HEX,
  PAINTNODE_CHROMA_KEY_RGB,
  applyAlphaMask,
  chromaKeyToAlpha,
  connectedMatteToAlpha,
  parseHexColor,
} from '../engine/decouple/chroma';

export const DEFAULT_WORKFLOW_ASSET_EXTRACTION_PROMPT =
  'Extract clean standalone reusable assets. Reconstruct useful occluded parts, avoid duplicate props, and preserve each object’s visual identity.';

export type AssetSheetCount = 1 | 2 | 4 | 8;

export interface AssetExtractionSource {
  name: string;
  dataUrl: string;
  role: 'source' | 'support';
}

export interface AssetSheetCell {
  index: number;
  row: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export function assetSheetCells(count: AssetSheetCount): AssetSheetCell[] {
  const columns = count === 1 ? 1 : count === 2 ? 2 : count === 4 ? 2 : 4;
  const rows = Math.ceil(count / columns);
  return Array.from({ length: count }, (_, index) => ({
    index,
    row: Math.floor(index / columns),
    column: index % columns,
    x: (index % columns) / columns,
    y: Math.floor(index / columns) / rows,
    width: 1 / columns,
    height: 1 / rows,
  }));
}

export function assetSheetGuidelineDataUrl(count: AssetSheetCount): string {
  const cells = assetSheetCells(count);
  const canvas = document.createElement('canvas');
  canvas.width = 1200;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to prepare the fast extraction grid guideline.');
  ctx.fillStyle = '#1f2023';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '700 42px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const cell of cells) {
    const gap = 14;
    const x = cell.x * canvas.width + gap;
    const y = cell.y * canvas.height + gap;
    const width = cell.width * canvas.width - gap * 2;
    const height = cell.height * canvas.height - gap * 2;
    ctx.fillStyle = '#f4f4f4';
    ctx.fillRect(x, y, width, height);
    ctx.strokeStyle = '#6f737a';
    ctx.lineWidth = 4;
    ctx.strokeRect(x, y, width, height);
    ctx.fillStyle = '#777b82';
    ctx.fillText(String(cell.index + 1), x + width / 2, y + height / 2);
  }
  return canvas.toDataURL('image/png');
}

export function workflowAssetExtractionPrompt(
  prompt: string,
  mode: 'quality' | 'fast',
  assetsPerSheet: AssetSheetCount,
): string {
  const guidance = prompt.trim() || DEFAULT_WORKFLOW_ASSET_EXTRACTION_PROMPT;
  if (mode === 'quality') {
    return `${guidance}\n\nReturn every extracted object as its own clearly named transparent PNG asset. Source images are labelled SOURCE; annotated references are labelled SUPPORT and should guide boundaries, identity, and reconstruction.`;
  }
  const cells = assetSheetCells(assetsPerSheet);
  const layout = `${Math.max(...cells.map((cell) => cell.column)) + 1} columns by ${Math.max(...cells.map((cell) => cell.row)) + 1} rows`;
  return `${guidance}\n\nFAST INDEX-SHEET MODE: return exactly one transparent PNG named asset-index-sheet.png. Follow the attached SUPPORT image named INDEX SHEET GUIDELINE for a uniform ${layout} grid. Arrange up to ${assetsPerSheet} distinct extracted objects, one centered object per cell, ordered left-to-right then top-to-bottom. The guideline numbers indicate crop order only; do not reproduce them. Do not add borders, captions, shadows, or a background. Do not return separate object files. Source images are labelled SOURCE; annotated references are labelled SUPPORT.`;
}

async function bitmapFromDataUrl(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

export async function composeAssetExtractionSources(sources: readonly AssetExtractionSource[]): Promise<Uint8Array> {
  if (sources.length === 0) throw new Error('Choose at least one source image.');
  const bitmaps = await Promise.all(sources.map(async (source) => ({ source, bitmap: await bitmapFromDataUrl(source.dataUrl) })));
  try {
    const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(bitmaps.length))));
    const rows = Math.ceil(bitmaps.length / columns);
    const cellWidth = 720;
    const cellHeight = 520;
    const labelHeight = 44;
    const canvas = document.createElement('canvas');
    canvas.width = columns * cellWidth;
    canvas.height = rows * (cellHeight + labelHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to prepare extraction sources.');
    ctx.fillStyle = '#202124';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = '600 22px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    bitmaps.forEach(({ source, bitmap }, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const x = column * cellWidth;
      const y = row * (cellHeight + labelHeight);
      const scale = Math.min(cellWidth / bitmap.width, cellHeight / bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      ctx.fillStyle = '#ececec';
      ctx.fillRect(x, y, cellWidth, cellHeight);
      ctx.drawImage(bitmap, x + (cellWidth - width) / 2, y + (cellHeight - height) / 2, width, height);
      ctx.fillStyle = source.role === 'support' ? '#5b3d78' : '#244d70';
      ctx.fillRect(x, y + cellHeight, cellWidth, labelHeight);
      ctx.fillStyle = '#fff';
      ctx.fillText(`${source.role.toUpperCase()} ${index + 1} · ${source.name}`, x + 14, y + cellHeight + labelHeight / 2, cellWidth - 28);
    });
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      (value) => value ? resolve(value) : reject(new Error('Unable to encode extraction sources.')),
      'image/png',
    ));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmaps.forEach(({ bitmap }) => bitmap.close());
  }
}

export async function decoupledLayerCanvas(layer: DecoupledLayerResult, tolerance = 30): Promise<HTMLCanvasElement> {
  const bitmap = await bitmapFromDataUrl(layer.dataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    throw new Error('Unable to prepare extracted asset.');
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  if (layer.alphaMaskDataUrl) {
    const maskBitmap = await bitmapFromDataUrl(layer.alphaMaskDataUrl);
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = canvas.width;
    maskCanvas.height = canvas.height;
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    if (!maskCtx) {
      maskBitmap.close();
      throw new Error(`Unable to prepare alpha mask for "${layer.name}".`);
    }
    maskCtx.drawImage(maskBitmap, 0, 0, canvas.width, canvas.height);
    maskBitmap.close();
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const mask = maskCtx.getImageData(0, 0, canvas.width, canvas.height);
    applyAlphaMask(image.data, mask.data);
    ctx.putImageData(image, 0, 0);
  }

  const key = layer.keyColor ? parseHexColor(layer.keyColor) : null;
  if (layer.keyColor && !key) throw new Error(`Asset "${layer.name}" returned an invalid key colour.`);
  if (key) {
    if (key.r !== PAINTNODE_CHROMA_KEY_RGB.r || key.g !== PAINTNODE_CHROMA_KEY_RGB.g || key.b !== PAINTNODE_CHROMA_KEY_RGB.b) {
      throw new Error(`Asset "${layer.name}" returned unsupported key colour "${layer.keyColor}"; expected ${PAINTNODE_CHROMA_KEY_HEX}.`);
    }
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    connectedMatteToAlpha(image.data, {
      key, width: canvas.width, height: canvas.height, tolerance,
      softness: Math.max(12, tolerance * 1.2),
      floodTolerance: Math.min(260, tolerance + Math.max(24, tolerance * 3.2)),
      despill: 0.35,
    });
    chromaKeyToAlpha(image.data, {
      key, tolerance: Math.max(8, tolerance * 0.55), softness: Math.max(4, tolerance * 0.25), despill: 0.35,
    });
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

export function cropAssetIndexSheet(sheet: HTMLCanvasElement, count: AssetSheetCount): HTMLCanvasElement[] {
  return assetSheetCells(count).map((cell) => {
    const x = Math.round(cell.x * sheet.width);
    const y = Math.round(cell.y * sheet.height);
    const right = Math.round((cell.x + cell.width) * sheet.width);
    const bottom = Math.round((cell.y + cell.height) * sheet.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, right - x);
    canvas.height = Math.max(1, bottom - y);
    canvas.getContext('2d')?.drawImage(sheet, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    return canvas;
  });
}

export async function canvasPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error('Unable to encode extracted asset.')),
    'image/png',
  ));
}
