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
  return imageModelCapabilities.providers.antigravity.aspectRatios.includes(ratioLabel(width, height));
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
