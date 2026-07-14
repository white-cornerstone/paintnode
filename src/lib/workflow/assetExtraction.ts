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
  'Deconstruct the scene into useful constituent assets and reconstruct each one as a clean standalone reference. Use the source for identity and material evidence, not as pixels to cut out. Split useful components of composite subjects, complete hidden geometry, avoid duplicate ownership, and remove all original environment context.';
export const WORKFLOW_ASSET_OPERATION_PROMPT_MAX_CHARS = 3200;
const WORKFLOW_ASSET_GUIDANCE_MAX_CHARS = 1200;
const WORKFLOW_ASSET_SHEET_GUIDANCE_MAX_CHARS = 480;
const WORKFLOW_ASSET_SHEET_ITEM_NAME_MAX_CHARS = 96;
const WORKFLOW_ASSET_SHEET_ITEM_INSTRUCTION_MAX_CHARS = 320;

export type AssetSheetCount = 1 | 2 | 4 | 8;

export interface AssetExtractionSource {
  name: string;
  dataUrl: string;
  role: 'source' | 'support';
  synthetic?: boolean;
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

export interface PlannedAssetSheetItem {
  name: string;
  instruction: string;
}

export type AssetExtractionExecution =
  | 'provider-asset-pack'
  | 'planned-individual-assets'
  | 'single-index-sheet';

export function compactAssetPromptText(value: string, maximumChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maximumChars) return normalized;
  const prefix = normalized.slice(0, Math.max(1, maximumChars - 1));
  const wordBoundary = prefix.lastIndexOf(' ');
  const compacted = wordBoundary >= Math.floor(maximumChars * 0.6)
    ? prefix.slice(0, wordBoundary)
    : prefix;
  return `${compacted.trimEnd()}…`;
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

export function workflowAssetExtractionExecution(
  mode: 'quality' | 'fast',
  directorEnabled: boolean,
): AssetExtractionExecution {
  if (mode === 'fast') return 'single-index-sheet';
  return directorEnabled ? 'planned-individual-assets' : 'provider-asset-pack';
}

export function workflowAssetExtractionPrompt(
  prompt: string,
  mode: 'quality' | 'fast',
  assetsPerSheet: AssetSheetCount,
): string {
  const guidance = compactAssetPromptText(
    prompt.trim() || DEFAULT_WORKFLOW_ASSET_EXTRACTION_PROMPT,
    WORKFLOW_ASSET_GUIDANCE_MAX_CHARS,
  );
  if (mode === 'quality') {
    return `${guidance}\n\nThis is semantic asset reconstruction, not segmentation or background removal. Generate a new clean, complete representation of each asset; do not paste, crop, clone, or retain pixels from the source environment. Return every reconstructed component as its own clearly named transparent PNG asset. Source images are labelled SOURCE; annotated references are labelled SUPPORT and provide evidence for identity, materials, and constituent parts.`;
  }
  const cells = assetSheetCells(assetsPerSheet);
  const layout = `${Math.max(...cells.map((cell) => cell.column)) + 1} columns by ${Math.max(...cells.map((cell) => cell.row)) + 1} rows`;
  return `${guidance}\n\nFAST INDEX-SHEET MODE: perform exactly one image-generation operation and return exactly one transparent PNG named asset-index-sheet.png. This is semantic component reconstruction, not segmentation or background removal: render each component again as a clean, complete standalone catalog-style asset using the source only as visual evidence. Never paste, crop, clone, or preserve source-photo pixels, background patches, original occlusion boundaries, environmental lighting spill, or adjacent scenery. Use a uniform ${layout} grid with up to ${assetsPerSheet} reconstructed assets, one centered asset per equal-size cell, ordered left-to-right then top-to-bottom; no asset may span cells and no extra rows or columns are allowed. Do not add borders, captions, shadows, a background, checkerboard transparency previews, or separate object files. Source images are labelled SOURCE; annotated references are labelled SUPPORT.`;
}

export function workflowPlannedAssetSheetPrompt(
  prompt: string,
  items: readonly PlannedAssetSheetItem[],
  assetsPerSheet: AssetSheetCount,
): string {
  if (items.length === 0 || items.length > assetsPerSheet) {
    throw new Error('The AI Director asset inventory does not fit the configured index sheet.');
  }
  const cells = assetSheetCells(assetsPerSheet);
  const columns = Math.max(...cells.map((cell) => cell.column)) + 1;
  const rows = Math.max(...cells.map((cell) => cell.row)) + 1;
  const guidance = compactAssetPromptText(
    prompt.trim() || DEFAULT_WORKFLOW_ASSET_EXTRACTION_PROMPT,
    WORKFLOW_ASSET_SHEET_GUIDANCE_MAX_CHARS,
  );
  const names = items.map((item) => compactAssetPromptText(
    item.name,
    WORKFLOW_ASSET_SHEET_ITEM_NAME_MAX_CHARS,
  ));
  const prefix = `User goal: ${guidance}\n\nAI DIRECTOR INVENTORY (final; one image operation only):\n`;
  const suffix = `\n\nReconstruct these ${items.length} fresh, complete canonical assets in order in the first ${items.length} cells of the fixed ${columns}x${rows} equal-cell grid. “Isolate” or “extract” means reconstruct, never cut out source pixels. No asset may span cells; leave unused cells transparent. The single index sheet is the only image deliverable.`;
  const inventoryWithoutInstructions = names
    .map((name, index) => `${index + 1}. ${name}\n   `)
    .join('\n');
  const availableForInstructions = Math.max(
    items.length * 40,
    WORKFLOW_ASSET_OPERATION_PROMPT_MAX_CHARS
      - prefix.length
      - suffix.length
      - inventoryWithoutInstructions.length,
  );
  const instructionMaximum = Math.max(40, Math.min(
    WORKFLOW_ASSET_SHEET_ITEM_INSTRUCTION_MAX_CHARS,
    Math.floor(availableForInstructions / items.length),
  ));
  const inventory = items.map((item, index) => [
    `${index + 1}. ${names[index]}`,
    `   ${compactAssetPromptText(item.instruction, instructionMaximum)}`,
  ].join('\n')).join('\n');
  const result = `${prefix}${inventory}${suffix}`;
  if (result.length > WORKFLOW_ASSET_OPERATION_PROMPT_MAX_CHARS) {
    throw new Error('The compact asset index-sheet prompt exceeded PaintNode’s provider-safe limit.');
  }
  return result;
}

/** Planning composites may include synthetic layout aids; image models must not. */
export function assetExtractionImageModelSources(
  sources: readonly AssetExtractionSource[],
): AssetExtractionSource[] {
  return sources.filter((source) => !source.synthetic);
}

export interface UniformBorderMatte {
  key: { r: number; g: number; b: number };
  borderCoverage: number;
}

/**
 * Detect a nearly flat border matte without accepting checkerboards or scene backgrounds.
 * This is only used for index-sheet recovery when an image provider shifts the requested
 * chroma colour during its JPEG round-trip.
 */
export function detectUniformBorderMatte(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
): UniformBorderMatte | null {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  if (rgba.length < w * h * 4 || w < 2 || h < 2) return null;

  type BorderColor = { r: number; g: number; b: number };
  const colorAt = (x: number, y: number): BorderColor => {
    const offset = (y * w + x) * 4;
    return { r: rgba[offset] ?? 0, g: rgba[offset + 1] ?? 0, b: rgba[offset + 2] ?? 0 };
  };
  const edges = [
    Array.from({ length: w }, (_, x) => colorAt(x, 0)),
    Array.from({ length: w }, (_, x) => colorAt(x, h - 1)),
    Array.from({ length: h }, (_, y) => colorAt(0, y)),
    Array.from({ length: h }, (_, y) => colorAt(w - 1, y)),
  ];
  const samples = edges.flat();

  const candidateFor = (colors: BorderColor[]): UniformBorderMatte | null => {
    const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
    for (const color of colors) {
      const bin = ((color.r >> 5) << 6) | ((color.g >> 5) << 3) | (color.b >> 5);
      const current = bins.get(bin) ?? { count: 0, r: 0, g: 0, b: 0 };
      current.count += 1;
      current.r += color.r;
      current.g += color.g;
      current.b += color.b;
      bins.set(bin, current);
    }
    const dominant = [...bins.values()].sort((a, b) => b.count - a.count)[0];
    if (!dominant || dominant.count / colors.length < 0.68) return null;
    const key = {
      r: Math.round(dominant.r / dominant.count),
      g: Math.round(dominant.g / dominant.count),
      b: Math.round(dominant.b / dominant.count),
    };
    const matching = colors.filter((color) => Math.hypot(
      color.r - key.r,
      color.g - key.g,
      color.b - key.b,
    ) <= 48).length;
    const borderCoverage = matching / colors.length;
    return borderCoverage >= 0.8 ? { key, borderCoverage } : null;
  };

  const wholeBorder = candidateFor(samples);
  if (wholeBorder) return wholeBorder;

  const edgeCandidates = edges.map(candidateFor).filter((candidate): candidate is UniformBorderMatte => candidate !== null);
  const agreeing = edgeCandidates
    .map((candidate) => edgeCandidates.filter((other) => Math.hypot(
      candidate.key.r - other.key.r,
      candidate.key.g - other.key.g,
      candidate.key.b - other.key.b,
    ) <= 48))
    .sort((a, b) => b.length - a.length)[0] ?? [];
  if (agreeing.length < 3) return null;
  return {
    key: {
      r: Math.round(agreeing.reduce((sum, candidate) => sum + candidate.key.r, 0) / agreeing.length),
      g: Math.round(agreeing.reduce((sum, candidate) => sum + candidate.key.g, 0) / agreeing.length),
      b: Math.round(agreeing.reduce((sum, candidate) => sum + candidate.key.b, 0) / agreeing.length),
    },
    borderCoverage: agreeing.reduce((sum, candidate) => sum + candidate.borderCoverage, 0) / agreeing.length,
  };
}

async function bitmapFromDataUrl(dataUrl: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(dataUrl)).blob());
}

export async function composeAssetExtractionSources(
  sources: readonly AssetExtractionSource[],
  includeLabels = true,
): Promise<Uint8Array> {
  if (sources.length === 0) throw new Error('Choose at least one source image.');
  if (!includeLabels && sources.length === 1) {
    return new Uint8Array(await (await fetch(sources[0].dataUrl)).arrayBuffer());
  }
  const bitmaps = await Promise.all(sources.map(async (source) => ({ source, bitmap: await bitmapFromDataUrl(source.dataUrl) })));
  try {
    const columns = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(bitmaps.length))));
    const rows = Math.ceil(bitmaps.length / columns);
    const cellWidth = 720;
    const cellHeight = 520;
    const labelHeight = includeLabels ? 44 : 0;
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
      if (includeLabels) {
        ctx.fillStyle = source.role === 'support' ? '#5b3d78' : '#244d70';
        ctx.fillRect(x, y + cellHeight, cellWidth, labelHeight);
        ctx.fillStyle = '#fff';
        ctx.fillText(`${source.role.toUpperCase()} ${index + 1} · ${source.name}`, x + 14, y + cellHeight + labelHeight / 2, cellWidth - 28);
      }
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

export async function decoupledLayerCanvas(
  layer: DecoupledLayerResult,
  tolerance = 30,
  recoverIndexSheetMatte = false,
): Promise<HTMLCanvasElement> {
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
    const original = recoverIndexSheetMatte ? new Uint8ClampedArray(image.data) : null;
    connectedMatteToAlpha(image.data, {
      key, width: canvas.width, height: canvas.height, tolerance,
      softness: Math.max(12, tolerance * 1.2),
      floodTolerance: Math.min(260, tolerance + Math.max(24, tolerance * 3.2)),
      despill: 0.35,
    });
    chromaKeyToAlpha(image.data, {
      key, tolerance: Math.max(8, tolerance * 0.55), softness: Math.max(4, tolerance * 0.25), despill: 0.35,
    });
    if (original && extractedAssetAlphaCoverage(image.data).transparentFraction < 0.01) {
      image.data.set(original);
      const detected = detectUniformBorderMatte(image.data, canvas.width, canvas.height);
      if (detected) {
        connectedMatteToAlpha(image.data, {
          key: detected.key,
          width: canvas.width,
          height: canvas.height,
          tolerance: 18,
          softness: 30,
          floodTolerance: 58,
          despill: 0.25,
        });
      }
    }
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

export interface ExtractedAssetAlphaCoverage {
  transparentFraction: number;
  visibleFraction: number;
}

export function extractedAssetAlphaCoverage(rgba: ArrayLike<number>): ExtractedAssetAlphaCoverage {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new Error('Extracted asset pixels are invalid.');
  }
  const pixels = rgba.length / 4;
  let transparent = 0;
  let visible = 0;
  for (let offset = 3; offset < rgba.length; offset += 4) {
    const alpha = rgba[offset] ?? 0;
    if (alpha < 16) transparent += 1;
    if (alpha > 5) visible += 1;
  }
  return {
    transparentFraction: transparent / pixels,
    visibleFraction: visible / pixels,
  };
}

export function assertExtractedAssetHasUsefulAlpha(
  rgba: ArrayLike<number>,
  assetName: string,
): ExtractedAssetAlphaCoverage {
  const coverage = extractedAssetAlphaCoverage(rgba);
  if (coverage.transparentFraction < 0.01) {
    throw new Error(`Asset "${assetName}" has no usable transparent background.`);
  }
  if (coverage.visibleFraction < 0.001) {
    throw new Error(`Asset "${assetName}" became empty while preparing transparency.`);
  }
  return coverage;
}

export function validateExtractedAssetCanvas(canvas: HTMLCanvasElement, assetName: string): void {
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error(`Unable to validate extracted asset "${assetName}".`);
  assertExtractedAssetHasUsefulAlpha(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
    assetName,
  );
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
