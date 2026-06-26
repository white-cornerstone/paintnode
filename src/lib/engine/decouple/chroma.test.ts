import { describe, expect, it } from 'vitest';
import { applyAlphaMask, chromaKeyToAlpha, connectedMatteToAlpha, parseHexColor } from './chroma';

describe('parseHexColor', () => {
  it('parses six digit hex colors with or without #', () => {
    expect(parseHexColor('#00ff7a')).toEqual({ r: 0, g: 255, b: 122 });
    expect(parseHexColor('112233')).toEqual({ r: 17, g: 34, b: 51 });
  });

  it('rejects unsupported color strings', () => {
    expect(parseHexColor('#abc')).toBeNull();
    expect(parseHexColor('green')).toBeNull();
  });
});

describe('chromaKeyToAlpha', () => {
  it('makes pixels near the matte color transparent', () => {
    const data = new Uint8ClampedArray([
      0, 255, 0, 255,
      4, 252, 5, 255,
      220, 30, 40, 255,
    ]);

    const stats = chromaKeyToAlpha(data, {
      key: { r: 0, g: 255, b: 0 },
      tolerance: 12,
      softness: 0,
    });

    expect(stats).toEqual({ keyedPixels: 2, softenedPixels: 0 });
    expect(Array.from(data)).toEqual([
      0, 255, 0, 0,
      4, 252, 5, 0,
      220, 30, 40, 255,
    ]);
  });

  it('softens pixels just outside tolerance', () => {
    const data = new Uint8ClampedArray([20, 240, 10, 200]);

    const stats = chromaKeyToAlpha(data, {
      key: { r: 0, g: 255, b: 0 },
      tolerance: 10,
      softness: 30,
      despill: 0,
    });

    expect(stats.keyedPixels).toBe(0);
    expect(stats.softenedPixels).toBe(1);
    expect(data[3]).toBeGreaterThan(0);
    expect(data[3]).toBeLessThan(200);
  });
});

describe('connectedMatteToAlpha', () => {
  it('removes matte-like border regions without keying the object interior', () => {
    const width = 4;
    const height = 4;
    const px = [
      [235, 70, 235, 255], [232, 80, 230, 255], [230, 75, 230, 255], [236, 68, 236, 255],
      [234, 72, 232, 255], [250, 245, 210, 255], [245, 220, 40, 255], [231, 77, 231, 255],
      [233, 74, 233, 255], [30, 180, 80, 255], [250, 250, 250, 255], [232, 78, 230, 255],
      [236, 69, 236, 255], [231, 76, 232, 255], [235, 71, 235, 255], [234, 72, 234, 255],
    ].flat();
    const data = new Uint8ClampedArray(px);

    const stats = connectedMatteToAlpha(data, {
      key: { r: 255, g: 0, b: 255 },
      width,
      height,
      tolerance: 80,
      softness: 40,
      floodTolerance: 210,
      despill: 0,
    });

    expect(stats.keyedPixels + stats.softenedPixels).toBeGreaterThan(8);
    expect(data[0 * 4 + 3]).toBeLessThan(255);
    expect(data[(1 * width + 1) * 4 + 3]).toBe(255);
    expect(data[(2 * width + 2) * 4 + 3]).toBe(255);
  });
});

describe('applyAlphaMask', () => {
  it('uses grayscale mask coverage as soft alpha', () => {
    const data = new Uint8ClampedArray([
      200, 10, 10, 255,
      200, 10, 10, 255,
      200, 10, 10, 128,
    ]);
    const mask = new Uint8ClampedArray([
      255, 255, 255, 255,
      128, 128, 128, 255,
      0, 0, 0, 255,
    ]);

    const stats = applyAlphaMask(data, mask);

    expect(stats).toEqual({ transparentPixels: 1, softenedPixels: 1 });
    expect(data[3]).toBe(255);
    expect(data[7]).toBe(128);
    expect(data[11]).toBe(0);
  });

  it('multiplies mask coverage by existing alpha', () => {
    const data = new Uint8ClampedArray([20, 40, 60, 128]);
    const mask = new Uint8ClampedArray([255, 255, 255, 128]);

    applyAlphaMask(data, mask);

    expect(data[3]).toBe(64);
  });
});
