import { describe, it, expect } from 'vitest';
import { rgbToHex, hexToRgb, rgbToCss, rgbToHsv, hsvToRgb } from './color';

describe('rgbToHex', () => {
  it('formats, pads, and clamps channels', () => {
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('#000000');
    expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe('#ffffff');
    expect(rgbToHex({ r: 1, g: 2, b: 3 })).toBe('#010203');
    expect(rgbToHex({ r: 300, g: -5, b: 128 })).toBe('#ff0080');
  });
});

describe('hexToRgb', () => {
  it('parses 6- and 3-digit hex (with or without #)', () => {
    expect(hexToRgb('#010203')).toEqual({ r: 1, g: 2, b: 3 });
    expect(hexToRgb('fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hexToRgb('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });
  it('rejects invalid input', () => {
    expect(hexToRgb('nope')).toBeNull();
    expect(hexToRgb('#12')).toBeNull();
    expect(hexToRgb('#1234567')).toBeNull();
  });
});

describe('rgbToCss', () => {
  it('formats rgba with optional alpha', () => {
    expect(rgbToCss({ r: 1, g: 2, b: 3 })).toBe('rgba(1, 2, 3, 1)');
    expect(rgbToCss({ r: 1, g: 2, b: 3 }, 0.5)).toBe('rgba(1, 2, 3, 0.5)');
  });
});

describe('rgb <-> hsv', () => {
  it('round-trips colors within rounding tolerance', () => {
    const colors = [
      { r: 255, g: 0, b: 0 },
      { r: 0, g: 255, b: 0 },
      { r: 0, g: 0, b: 255 },
      { r: 128, g: 64, b: 32 },
      { r: 200, g: 200, b: 10 },
    ];
    for (const rgb of colors) {
      const back = hsvToRgb(rgbToHsv(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });
});
