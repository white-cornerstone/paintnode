import { beforeAll, describe, expect, it } from 'vitest';

class FakeCanvas {
  width = 1;
  height = 1;
  readonly context = new FakeContext();

  getContext(): FakeContext {
    return this.context;
  }
}

class FakeContext {
  fillStyle = '';
  imageSmoothingEnabled = false;
  imageSmoothingQuality: ImageSmoothingQuality = 'low';
  readonly drawImageCalls: unknown[][] = [];
  readonly fillRectCalls: unknown[][] = [];

  drawImage(...args: unknown[]): void {
    this.drawImageCalls.push(args);
  }

  fillRect(...args: unknown[]): void {
    this.fillRectCalls.push(args);
  }

  clearRect(): void {}
  save(): void {}
  restore(): void {}
  translate(): void {}
  rotate(): void {}
  scale(): void {}
}

beforeAll(() => {
  Object.defineProperty(globalThis, '$state', {
    value: <T>(value: T) => value,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => new FakeCanvas() },
    configurable: true,
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    configurable: true,
  });
});

describe('EditorStore canvas resize', () => {
  it('expands the active layer bitmap to the new canvas size', async () => {
    const { EditorStore } = await import('./editor.svelte');
    const store = new EditorStore();
    store.newDocument(1280, 800, 'Wide fill repro', false);
    const beforeLayer = store.activeLayer!;
    const beforeLayerId = beforeLayer.id;

    store.resizeCanvas(3000, 800, 'center', { kind: 'transparent' });

    const doc = store.doc!;
    const layer = store.activeLayer!;
    const context = layer.ctx as unknown as FakeContext;
    expect(doc.width).toBe(3000);
    expect(doc.height).toBe(800);
    expect(layer.id).toBe(beforeLayerId);
    expect(layer.width).toBe(3000);
    expect(layer.height).toBe(800);
    expect(layer.x).toBe(0);
    expect(layer.y).toBe(0);
    expect(context.drawImageCalls.at(-1)).toEqual([beforeLayer.canvas, 860, 0]);
  });
});
