import { describe, expect, it } from 'vitest';
import { makeLevels, makeThreshold } from './adjustments';

function pixel(r: number, g: number, b: number, a = 255): Uint8ClampedArray {
  return new Uint8ClampedArray([r, g, b, a]);
}

describe('adjustments', () => {
  it('maps input and output levels per RGB channel without changing alpha', () => {
    const data = pixel(64, 128, 255, 120);
    makeLevels({ inputBlack: 64, inputWhite: 192, gamma: 1, outputBlack: 10, outputWhite: 210 })(data, 0);

    expect(Array.from(data)).toEqual([10, 110, 210, 120]);
  });

  it('applies gamma midtone levels', () => {
    const darker = pixel(128, 128, 128);
    const lighter = pixel(128, 128, 128);

    makeLevels({ inputBlack: 0, inputWhite: 255, gamma: 2, outputBlack: 0, outputWhite: 255 })(darker, 0);
    makeLevels({ inputBlack: 0, inputWhite: 255, gamma: 0.5, outputBlack: 0, outputWhite: 255 })(lighter, 0);

    expect(darker[0]).toBeLessThan(128);
    expect(lighter[0]).toBeGreaterThan(128);
  });

  it('thresholds by luminance and keeps alpha', () => {
    const dark = pixel(50, 50, 50, 90);
    const bright = pixel(200, 200, 200, 90);
    const op = makeThreshold(128);

    op(dark, 0);
    op(bright, 0);

    expect(Array.from(dark)).toEqual([0, 0, 0, 90]);
    expect(Array.from(bright)).toEqual([255, 255, 255, 90]);
  });
});
