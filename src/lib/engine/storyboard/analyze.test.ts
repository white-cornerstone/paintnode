import { describe, expect, it } from 'vitest';
import { storyboardPlacementSummary } from './analyze';

function image(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const p = i * 4;
    data[p] = 255;
    data[p + 1] = 255;
    data[p + 2] = 255;
    data[p + 3] = 255;
  }
  return data;
}

function rect(data: Uint8ClampedArray, width: number, x: number, y: number, w: number, h: number, color: [number, number, number]): void {
  for (let yy = y; yy < y + h; yy += 1) {
    for (let xx = x; xx < x + w; xx += 1) {
      const p = (yy * width + xx) * 4;
      data[p] = color[0];
      data[p + 1] = color[1];
      data[p + 2] = color[2];
      data[p + 3] = 255;
    }
  }
}

describe('storyboardPlacementSummary', () => {
  it('reports major dark and red marks with coordinate regions', () => {
    const width = 100;
    const height = 80;
    const data = image(width, height);
    rect(data, width, 18, 25, 18, 36, [0, 0, 0]);
    rect(data, width, 16, 15, 10, 8, [230, 0, 0]);

    const summary = storyboardPlacementSummary({ width, height, data });

    expect(summary.join('\n')).toContain('dark ink / likely subject or note component 1');
    expect(summary.join('\n')).toContain('left third');
    expect(summary.join('\n')).toContain('red mark / likely prop emphasis component 1');
  });
});
