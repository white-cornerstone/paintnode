import capabilities from './imageModelCapabilities.json';

type Capabilities = typeof capabilities;

export const imageModelCapabilities: Capabilities = capabilities;

type AiImageProvider = 'codex' | 'antigravity' | 'grok';

export interface FillFrameRatioOption {
  label: string;
  width: number;
  height: number;
}

export interface FillFrameSummary {
  provider: AiImageProvider;
  selectionLabel: string;
  ratioLabel: string;
  frameLabel: string;
  scalePercent: number;
  needsRestoration: boolean;
  needsRatioChoice: boolean;
  choices: FillFrameRatioOption[];
}

const ANTIGRAVITY_RATIO_CHOICE_LOG_ERROR = 0.10;
const ANTIGRAVITY_OUTPUT_TIERS = [1, 2, 4] as const;
// The xAI Images API offers 1k and 2k resolution tiers, so Grok frames can
// reach at most twice the base ratio grid.
const GROK_OUTPUT_TIERS = [1, 2] as const;

export function ratioLabel(width: number, height: number): string {
  const safeWidth = normalizedDimension(width);
  const safeHeight = normalizedDimension(height);
  const divisor = gcd(safeWidth, safeHeight);
  return `${Math.round(safeWidth / divisor)}:${Math.round(safeHeight / divisor)}`;
}

export function isCodexImageSize(width: number, height: number): boolean {
  const codex = imageModelCapabilities.providers.codex;
  const safeWidth = normalizedDimension(width);
  const safeHeight = normalizedDimension(height);
  const longSide = Math.max(safeWidth, safeHeight);
  const shortSide = Math.min(safeWidth, safeHeight);
  return (
    safeWidth % codex.dimensionMultiple === 0 &&
    safeHeight % codex.dimensionMultiple === 0 &&
    longSide <= codex.maxLongSide &&
    shortSide <= codex.maxShortSide &&
    longSide / shortSide <= codex.maxAspectRatio
  );
}

export function isAntigravityImageRatio(width: number, height: number): boolean {
  const safeWidth = normalizedDimension(width);
  const safeHeight = normalizedDimension(height);
  // The capability table records the model's actual output grids (e.g.
  // "21:9" outputs 1584x672 = 33:14, not 7:3); a document is AI-friendly
  // only when it matches a real grid ratio exactly.
  return imageModelCapabilities.providers.antigravity.aspectRatios.some(
    (ratio) => safeWidth * ratio.height === safeHeight * ratio.width,
  );
}

export function fillFrameSummary(
  provider: AiImageProvider,
  documentWidth: number,
  documentHeight: number,
  selectionWidth: number,
  selectionHeight: number,
  antigravityRatioOverride: string | null = null,
): FillFrameSummary {
  const safeDocumentWidth = normalizedDimension(documentWidth);
  const safeDocumentHeight = normalizedDimension(documentHeight);
  const safeSelectionWidth = normalizedDimension(selectionWidth);
  const safeSelectionHeight = normalizedDimension(selectionHeight);
  if (provider === 'antigravity' || provider === 'grok') {
    return ratioGridFillFrameSummary(
      provider,
      imageModelCapabilities.providers[provider].aspectRatios,
      safeDocumentWidth,
      safeDocumentHeight,
      safeSelectionWidth,
      safeSelectionHeight,
      antigravityRatioOverride,
    );
  }
  return codexFillFrameSummary(safeDocumentWidth, safeDocumentHeight, safeSelectionWidth, safeSelectionHeight);
}

function codexFillFrameSummary(
  documentWidth: number,
  documentHeight: number,
  selectionWidth: number,
  selectionHeight: number,
): FillFrameSummary {
  const codex = imageModelCapabilities.providers.codex;
  const longSide = Math.max(selectionWidth, selectionHeight);
  const shortSide = Math.min(selectionWidth, selectionHeight);
  const aspectScale = Math.min(1, codex.maxAspectRatio / Math.max(longSide / Math.max(1, shortSide), 1));
  const scale = Math.min(
    1,
    codex.maxLongSide / Math.max(documentWidth, documentHeight),
    codex.maxShortSide / Math.min(documentWidth, documentHeight),
    aspectScale,
  );
  const frame = codexFrameDimensions(documentWidth, documentHeight, scale);
  return {
    provider: 'codex',
    selectionLabel: `${selectionWidth} x ${selectionHeight}`,
    ratioLabel: ratioLabel(frame.width, frame.height),
    frameLabel: `${frame.width} x ${frame.height}`,
    scalePercent: Math.round(scale * 100),
    needsRestoration: scale < 1,
    needsRatioChoice: false,
    choices: [],
  };
}

function ratioGridFillFrameSummary(
  provider: 'antigravity' | 'grok',
  aspectRatios: readonly FillFrameRatioOption[],
  documentWidth: number,
  documentHeight: number,
  selectionWidth: number,
  selectionHeight: number,
  ratioOverride: string | null,
): FillFrameSummary {
  const choices = aspectRatios.map((ratio) => ({
    label: ratio.label,
    width: ratio.width,
    height: ratio.height,
  }));
  const targetAspect = selectionWidth / Math.max(1, selectionHeight);
  const closest = choices.reduce((best, ratio) => {
    const ratioAspect = ratio.width / Math.max(1, ratio.height);
    return aspectLogError(targetAspect, ratioAspect) < aspectLogError(targetAspect, best.width / Math.max(1, best.height))
      ? ratio
      : best;
  }, choices[0]);
  const selected = choices.find((ratio) => ratio.label === ratioOverride) ?? closest;
  const tiers = provider === 'grok' ? GROK_OUTPUT_TIERS : ANTIGRAVITY_OUTPUT_TIERS;
  const frame = ratioGridFrameForRatio(selected, tiers, documentWidth, documentHeight);
  const scale = Math.min(1, frame.width / documentWidth, frame.height / documentHeight);
  const error = aspectLogError(targetAspect, closest.width / Math.max(1, closest.height));
  return {
    provider,
    selectionLabel: `${selectionWidth} x ${selectionHeight}`,
    ratioLabel: selected.label,
    frameLabel: `${frame.width} x ${frame.height}`,
    scalePercent: Math.round(scale * 100),
    needsRestoration: scale < 1,
    needsRatioChoice: !ratioOverride && error > ANTIGRAVITY_RATIO_CHOICE_LOG_ERROR,
    choices,
  };
}

function codexFrameDimensions(
  documentWidth: number,
  documentHeight: number,
  scale: number,
): { width: number; height: number } {
  const codex = imageModelCapabilities.providers.codex;
  const multiple = codex.dimensionMultiple;
  const landscape = documentWidth >= documentHeight;
  const scaledWidth = Math.max(multiple, roundUpToMultiple(documentWidth * scale, multiple));
  const scaledHeight = Math.max(multiple, roundUpToMultiple(documentHeight * scale, multiple));
  const maxLong = codex.maxLongSide;
  const maxShort = codex.maxShortSide;
  if (landscape) {
    const width = Math.min(maxLong, scaledWidth);
    const minHeightForAspect = roundUpToMultiple(width / codex.maxAspectRatio, multiple);
    const height = Math.min(maxShort, Math.max(scaledHeight, minHeightForAspect));
    return { width, height };
  }
  const height = Math.min(maxLong, scaledHeight);
  const minWidthForAspect = roundUpToMultiple(height / codex.maxAspectRatio, multiple);
  const width = Math.min(maxShort, Math.max(scaledWidth, minWidthForAspect));
  return { width, height };
}

function ratioGridFrameForRatio(
  ratio: FillFrameRatioOption,
  tiers: readonly number[],
  documentWidth: number,
  documentHeight: number,
): { width: number; height: number } {
  const tier =
    tiers.find((scale) => ratio.width * scale >= documentWidth && ratio.height * scale >= documentHeight) ??
    tiers[tiers.length - 1];
  return { width: ratio.width * tier, height: ratio.height * tier };
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function normalizedDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}

function aspectLogError(a: number, b: number): number {
  return Math.abs(Math.log(Math.max(a, 0.0001) / Math.max(b, 0.0001)));
}

function roundUpToMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple);
}
