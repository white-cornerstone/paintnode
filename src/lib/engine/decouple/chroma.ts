import { clamp, type RGB } from '../types';

export interface ChromaKeyOptions {
  key: RGB;
  /** Distance from the key color that becomes fully transparent. */
  tolerance?: number;
  /** Distance over which alpha ramps from transparent to opaque. */
  softness?: number;
  /** Desaturate key-colored fringes on semi-transparent edge pixels. */
  despill?: number;
}

export interface ChromaKeyStats {
  keyedPixels: number;
  softenedPixels: number;
}

export interface ConnectedMatteOptions extends ChromaKeyOptions {
  width: number;
  height: number;
  /** Extra distance allowed while walking inward from the image border. */
  floodTolerance?: number;
}

export function parseHexColor(value: string): RGB | null {
  const trimmed = value.trim();
  const match = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (!match) return null;
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
}

function colorDistance(data: Uint8ClampedArray, i: number, key: RGB): number {
  const dr = data[i] - key.r;
  const dg = data[i + 1] - key.g;
  const db = data[i + 2] - key.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

function applyAlpha(
  data: Uint8ClampedArray,
  i: number,
  key: RGB,
  alpha: number,
  despill: number,
  t: number,
): void {
  const existingAlpha = data[i + 3];
  data[i + 3] = Math.min(existingAlpha, alpha);

  if (despill > 0 && alpha < existingAlpha) {
    data[i] = clamp(Math.round(data[i] + (data[i] - key.r) * despill * (1 - t)), 0, 255);
    data[i + 1] = clamp(Math.round(data[i + 1] + (data[i + 1] - key.g) * despill * (1 - t)), 0, 255);
    data[i + 2] = clamp(Math.round(data[i + 2] + (data[i + 2] - key.b) * despill * (1 - t)), 0, 255);
  }
}

/**
 * Convert a solid-color keyed image into alpha pixels in-place.
 *
 * This intentionally uses Euclidean RGB distance rather than hue math so it works
 * for any matte color Codex/Image Gen chooses, not just green-screen output.
 */
export function chromaKeyToAlpha(data: Uint8ClampedArray, options: ChromaKeyOptions): ChromaKeyStats {
  const tolerance = clamp(options.tolerance ?? 28, 0, 441);
  const softness = clamp(options.softness ?? 18, 0, 441);
  const despill = clamp(options.despill ?? 0.35, 0, 1);
  const fadeEnd = tolerance + softness;
  let keyedPixels = 0;
  let softenedPixels = 0;

  for (let i = 0; i < data.length; i += 4) {
    const existingAlpha = data[i + 3];
    if (existingAlpha === 0) continue;

    const distance = colorDistance(data, i, options.key);
    if (distance <= tolerance) {
      data[i + 3] = 0;
      keyedPixels++;
      continue;
    }

    if (softness > 0 && distance < fadeEnd) {
      const t = (distance - tolerance) / softness;
      const alpha = Math.round(existingAlpha * clamp(t, 0, 1));
      applyAlpha(data, i, options.key, alpha, despill, t);
      softenedPixels++;
    }
  }

  return { keyedPixels, softenedPixels };
}

/**
 * Remove matte-like pixels connected to the image border.
 *
 * AI extraction often returns an object over a tinted source image rather than a truly flat
 * matte. A global chroma key either misses that background or damages the object. Flooding
 * from the border is a better default for extracted assets because only the outside connected
 * region is removed.
 */
export function connectedMatteToAlpha(
  data: Uint8ClampedArray,
  options: ConnectedMatteOptions,
): ChromaKeyStats {
  const width = Math.max(1, Math.floor(options.width));
  const height = Math.max(1, Math.floor(options.height));
  if (data.length < width * height * 4) return { keyedPixels: 0, softenedPixels: 0 };

  const tolerance = clamp(options.tolerance ?? 46, 0, 441);
  const softness = clamp(options.softness ?? 36, 0, 441);
  const floodTolerance = clamp(options.floodTolerance ?? tolerance + softness * 2.4, tolerance, 441);
  const despill = clamp(options.despill ?? 0.35, 0, 1);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;
  let keyedPixels = 0;
  let softenedPixels = 0;

  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    const i = p * 4;
    if (data[i + 3] === 0 || colorDistance(data, i, options.key) > floodTolerance) return;
    visited[p] = 1;
    queue[tail++] = p;
  };

  for (let x = 0; x < width; x++) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    push(0, y);
    push(width - 1, y);
  }

  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = Math.floor(p / width);
    const i = p * 4;
    const existingAlpha = data[i + 3];
    const distance = colorDistance(data, i, options.key);

    if (distance <= tolerance) {
      data[i + 3] = 0;
      keyedPixels++;
    } else {
      const t = softness > 0 ? clamp((distance - tolerance) / Math.max(1, floodTolerance - tolerance), 0, 1) : 1;
      const alpha = Math.round(existingAlpha * t);
      applyAlpha(data, i, options.key, alpha, despill, t);
      softenedPixels++;
    }

    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  return { keyedPixels, softenedPixels };
}
