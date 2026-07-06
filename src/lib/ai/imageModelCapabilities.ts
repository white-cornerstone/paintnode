import capabilities from './imageModelCapabilities.json';

type Capabilities = typeof capabilities;

export const imageModelCapabilities: Capabilities = capabilities;

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

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function normalizedDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}
