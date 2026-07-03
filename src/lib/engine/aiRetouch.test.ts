import { beforeAll, describe, expect, it } from 'vitest';
import {
  aiRetouchPrompt,
  cloneAiRetouchMetadata,
  combineRetouchMask,
  effectiveAiRetouchMaskMode,
  featherRetouchMask,
  makeRectMask,
  makeStrokeMask,
  maskBounds,
  maskHasPixels,
  nextAiRetouchTool,
  offsetRect,
  pointsBounds,
  referenceRect,
  type AiRetouchGesture,
} from './aiRetouch';

class FakeCanvas {
  private pixels = new Uint8ClampedArray(1 * 1 * 4);
  private w = 1;
  private h = 1;

  get width(): number {
    return this.w;
  }
  set width(value: number) {
    this.w = Math.max(1, Math.floor(value));
    this.pixels = new Uint8ClampedArray(this.w * this.h * 4);
  }
  get height(): number {
    return this.h;
  }
  set height(value: number) {
    this.h = Math.max(1, Math.floor(value));
    this.pixels = new Uint8ClampedArray(this.w * this.h * 4);
  }
  getContext(): FakeContext {
    return new FakeContext(this);
  }
  data(): Uint8ClampedArray {
    return this.pixels;
  }
}

class FakeContext {
  fillStyle = '#ffffff';
  strokeStyle = '#ffffff';
  lineWidth = 1;
  lineCap = 'round';
  lineJoin = 'round';
  filter = 'none';
  globalCompositeOperation = 'source-over';
  private arcPath: { x: number; y: number; radius: number } | null = null;

  constructor(private canvas: FakeCanvas) {}

  beginPath(): void {
    this.arcPath = null;
  }

  moveTo(): void {}

  lineTo(): void {}

  closePath(): void {}

  arc(x: number, y: number, radius: number): void {
    this.arcPath = { x, y, radius };
  }

  fill(): void {
    if (!this.arcPath) return;
    const { x, y, radius } = this.arcPath;
    for (let yy = Math.floor(y - radius); yy <= Math.ceil(y + radius); yy++) {
      for (let xx = Math.floor(x - radius); xx <= Math.ceil(x + radius); xx++) {
        if (xx < 0 || yy < 0 || xx >= this.canvas.width || yy >= this.canvas.height) continue;
        const centerX = xx + 0.5;
        const centerY = yy + 0.5;
        if (Math.hypot(centerX - x, centerY - y) <= radius + 0.51) this.writePixel(xx, yy, 255);
      }
    }
  }

  stroke(): void {}

  fillRect(x: number, y: number, w: number, h: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.canvas.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.canvas.width, x + w); xx++) {
        this.writePixel(xx, yy, 255);
      }
    }
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.canvas.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.canvas.width, x + w); xx++) {
        this.canvas.data().fill(0, (yy * this.canvas.width + xx) * 4, (yy * this.canvas.width + xx) * 4 + 4);
      }
    }
  }

  drawImage(source: FakeCanvas, dx = 0, dy = 0): void {
    for (let y = 0; y < source.height; y++) {
      for (let x = 0; x < source.width; x++) {
        const tx = x + Math.round(dx);
        const ty = y + Math.round(dy);
        if (tx < 0 || ty < 0 || tx >= this.canvas.width || ty >= this.canvas.height) continue;
        const srcAlpha = source.data()[(y * source.width + x) * 4 + 3];
        this.writePixel(tx, ty, srcAlpha);
      }
    }
  }

  getImageData(x: number, y: number, w: number, h: number): ImageData {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const src = ((y + yy) * this.canvas.width + (x + xx)) * 4;
        const dst = (yy * w + xx) * 4;
        data.set(this.canvas.data().slice(src, src + 4), dst);
      }
    }
    return { data, width: w, height: h, colorSpace: 'srgb' } as ImageData;
  }

  putImageData(image: ImageData, x: number, y: number): void {
    for (let yy = 0; yy < image.height; yy++) {
      for (let xx = 0; xx < image.width; xx++) {
        const src = (yy * image.width + xx) * 4;
        const dst = ((y + yy) * this.canvas.width + (x + xx)) * 4;
        this.canvas.data().set(image.data.slice(src, src + 4), dst);
      }
    }
  }

  createImageData(w: number, h: number): ImageData {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, colorSpace: 'srgb' } as ImageData;
  }

  private writePixel(x: number, y: number, srcAlpha: number): void {
    const i = (y * this.canvas.width + x) * 4;
    const data = this.canvas.data();
    if (this.globalCompositeOperation === 'destination-out') {
      data[i + 3] = Math.round(data[i + 3] * (1 - srcAlpha / 255));
    } else if (this.globalCompositeOperation === 'destination-in') {
      data[i + 3] = Math.round(data[i + 3] * (srcAlpha / 255));
    } else {
      if (srcAlpha === 0) return;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = srcAlpha;
    }
  }
}

beforeAll(() => {
  if (!globalThis.document) {
    Object.defineProperty(globalThis, 'document', {
      value: { createElement: () => new FakeCanvas() },
      configurable: true,
    });
  }
});

function alphaAt(mask: HTMLCanvasElement, x: number, y: number): number {
  return mask.getContext('2d')!.getImageData(x, y, 1, 1).data[3];
}

describe('AI retouch request helpers', () => {
  it('cycles through the J retouch tools', () => {
    expect(nextAiRetouchTool('spot-healing')).toBe('remove');
    expect(nextAiRetouchTool('red-eye')).toBe('spot-healing');
    expect(nextAiRetouchTool('spot-healing', true)).toBe('red-eye');
  });

  it('defaults additional AI retouch strokes to add when a mask is active', () => {
    expect(effectiveAiRetouchMaskMode('new', false)).toBe('new');
    expect(effectiveAiRetouchMaskMode('new', true)).toBe('add');
    expect(effectiveAiRetouchMaskMode('add', true)).toBe('add');
    expect(effectiveAiRetouchMaskMode('subtract', true)).toBe('subtract');
    expect(effectiveAiRetouchMaskMode('intersect', true)).toBe('intersect');
  });

  it('calculates stroke bounds with brush padding', () => {
    expect(pointsBounds([{ x: 10, y: 20 }, { x: 50, y: 35 }], 6)).toEqual({
      x: 4,
      y: 14,
      w: 52,
      h: 27,
    });
  });

  it('builds a clamped healing reference crop around the source point', () => {
    expect(referenceRect({ x: 5, y: 8 }, 40, 100, 80)).toEqual({ x: 0, y: 0, w: 25, h: 28 });
  });

  it('clamps a moved subject destination to document bounds', () => {
    expect(offsetRect({ x: 80, y: 70, w: 30, h: 30 }, 15, 10, 100, 90)).toEqual({
      x: 95,
      y: 80,
      w: 5,
      h: 10,
    });
  });

  it('encodes patch source versus destination intent in prompts', () => {
    const sourcePatch: AiRetouchGesture = {
      kind: 'patch',
      mode: 'source',
      target: { x: 10, y: 10, w: 20, h: 20 },
      reference: { x: 40, y: 10, w: 20, h: 20 },
    };
    const destinationPatch: AiRetouchGesture = { ...sourcePatch, mode: 'destination' };

    expect(aiRetouchPrompt('patch', sourcePatch)).toContain('Repair the masked target area');
    expect(aiRetouchPrompt('patch', destinationPatch)).toContain('sampled source');
  });

  it('keeps Remove focused on reconstructing the underlying surface', () => {
    const removeStroke: AiRetouchGesture = {
      kind: 'brush',
      points: [{ x: 10, y: 10 }],
      size: 12,
      hardness: 1,
      closedLoop: false,
      reference: null,
    };

    expect(aiRetouchPrompt('remove', removeStroke)).toContain('underlying surface');
    expect(aiRetouchPrompt('remove', removeStroke)).toContain('Do not paint a flat patch');
  });

  it('combines retouch masks with add, subtract, and intersect modes', () => {
    const base = makeRectMask(8, 6, { x: 1, y: 1, w: 4, h: 3 })!;
    const hit = makeRectMask(8, 6, { x: 3, y: 2, w: 4, h: 3 })!;

    expect(maskBounds(combineRetouchMask(base, hit, 'add', 8, 6)!)).toEqual({ x: 1, y: 1, w: 6, h: 4 });
    expect(maskBounds(combineRetouchMask(base, hit, 'intersect', 8, 6)!)).toEqual({ x: 3, y: 2, w: 2, h: 2 });
    const subtracted = combineRetouchMask(base, hit, 'subtract', 8, 6)!;
    expect(maskBounds(subtracted)).toEqual({ x: 1, y: 1, w: 4, h: 3 });
    expect(alphaAt(subtracted, 3, 2)).toBe(0);
    expect(alphaAt(subtracted, 2, 2)).toBe(255);
  });

  it('feathers retouch masks with a soft outer buffer', () => {
    const mask = makeRectMask(9, 1, { x: 4, y: 0, w: 1, h: 1 })!;
    const feathered = featherRetouchMask(mask, 2);

    expect(alphaAt(feathered, 4, 0)).toBe(255);
    expect(alphaAt(feathered, 3, 0)).toBeGreaterThan(alphaAt(feathered, 2, 0));
    expect(alphaAt(feathered, 5, 0)).toBeGreaterThan(alphaAt(feathered, 6, 0));
    expect(alphaAt(feathered, 2, 0)).toBeGreaterThan(0);
    expect(alphaAt(feathered, 6, 0)).toBeGreaterThan(0);
    expect(alphaAt(feathered, 0, 0)).toBe(0);
    expect(alphaAt(feathered, 8, 0)).toBe(0);
  });

  it('applies feather per AI retouch brush stroke', () => {
    const mask = makeStrokeMask(7, 1, {
      kind: 'brush',
      points: [{ x: 3.5, y: 0.5 }],
      size: 1,
      hardness: 1,
      feather: 1,
    })!;

    expect(alphaAt(mask, 3, 0)).toBe(255);
    expect(alphaAt(mask, 2, 0)).toBeGreaterThan(0);
    expect(alphaAt(mask, 4, 0)).toBeGreaterThan(0);
    expect(alphaAt(mask, 0, 0)).toBe(0);
    expect(alphaAt(mask, 6, 0)).toBe(0);
  });

  it('returns no mask when subtract or intersect starts without an existing mask', () => {
    const hit = makeRectMask(8, 6, { x: 3, y: 2, w: 4, h: 3 })!;

    expect(combineRetouchMask(null, hit, 'subtract', 8, 6)).toBeNull();
    expect(combineRetouchMask(null, hit, 'intersect', 8, 6)).toBeNull();
    expect(maskHasPixels(combineRetouchMask(null, hit, 'new', 8, 6)!)).toBe(true);
  });

  it('focuses the red-eye prompt on pupil reflection retouching', () => {
    const redEye: AiRetouchGesture = {
      kind: 'red-eye',
      bounds: { x: 12, y: 14, w: 8, h: 8 },
    };
    const prompt = aiRetouchPrompt('red-eye', redEye);
    expect(prompt).toContain('masked pupil reflection');
    expect(prompt).toContain('Keep all non-target content pixel-faithful to the source');
    expect(prompt).toContain('regardless of what that content depicts');
    expect(prompt).toContain('Do not perform general image enhancement');
  });

  it('deep-copies editable mask metadata without structured cloning', () => {
    const original = {
      toolId: 'healing-brush',
      promptSeed: 'heal',
      healingSource: { x: 4, y: 5 },
      referenceRect: { x: 1, y: 2, w: 3, h: 4 },
      destinationRect: null,
    } as const;

    const copy = cloneAiRetouchMetadata(original)!;
    expect(copy).toEqual(original);
    expect(copy.healingSource).not.toBe(original.healingSource);
    expect(copy.referenceRect).not.toBe(original.referenceRect);
  });
});
