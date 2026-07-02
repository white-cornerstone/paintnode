import { beforeAll, describe, expect, it } from 'vitest';
import { PaintDocument } from './Document.svelte';
import { Layer } from './Layer.svelte';

class FakeCanvas {
  width = 1;
  height = 1;

  getContext(): FakeContext {
    return new FakeContext();
  }
}

class FakeContext {
  drawImage(): void {}
  clearRect(): void {}
  fillRect(): void {}
}

beforeAll(() => {
  Object.defineProperty(globalThis, '$state', {
    value: <T>(value: T) => value,
    configurable: true,
  });
  if (!globalThis.document) {
    Object.defineProperty(globalThis, 'document', {
      value: { createElement: () => new FakeCanvas() },
      configurable: true,
    });
  }
});

function linkedDocument(): { doc: PaintDocument; base: Layer; mask: Layer; result: Layer } {
  const doc = new PaintDocument(20, 20, 'Linked mask test');
  const base = new Layer(20, 20, 'Base');
  const mask = new Layer(20, 20, 'AI Mask: Remove');
  mask.kind = 'ai-retouch-mask';
  const result = new Layer(20, 20, 'AI Retouch: Remove');
  result.maskLayerId = mask.id;
  doc.layers = [base, mask, result];
  doc.activeLayerId = result.id;
  return { doc, base, mask, result };
}

describe('PaintDocument linked AI retouch masks', () => {
  it('finds linked mask and parent layers', () => {
    const { doc, mask, result } = linkedDocument();

    expect(doc.linkedMaskFor(result)).toBe(mask);
    expect(doc.linkedParentFor(mask)).toBe(result);
  });

  it('toggles parent and linked mask visibility together', () => {
    const { doc, mask, result } = linkedDocument();

    doc.setLayerVisibleWithLinkedMask(result, false);
    expect(result.visible).toBe(false);
    expect(mask.visible).toBe(false);

    doc.setLayerVisibleWithLinkedMask(result, true);
    expect(result.visible).toBe(true);
    expect(mask.visible).toBe(true);
  });

  it('lets child mask visibility remain independent', () => {
    const { doc, mask, result } = linkedDocument();

    doc.setLayerVisibleWithLinkedMask(mask, false);
    expect(mask.visible).toBe(false);
    expect(result.visible).toBe(true);
  });

  it('removes linked masks when deleting their parent result layer', () => {
    const { doc, base, mask, result } = linkedDocument();

    doc.removeLinked(result.id);

    expect(doc.layers).toEqual([base]);
    expect(doc.layers.some((layer) => layer.id === mask.id)).toBe(false);
  });

  it('unlinks a parent when deleting its child mask layer', () => {
    const { doc, base, mask, result } = linkedDocument();

    doc.removeLinked(mask.id);

    expect(doc.layers).toEqual([base, result]);
    expect(result.maskLayerId).toBeNull();
  });

  it('duplicates linked parent and mask as a new linked pair', () => {
    const { doc, mask, result } = linkedDocument();

    const copy = doc.duplicateLinked(result.id)!;
    const copiedMask = doc.linkedMaskFor(copy);

    expect(copy).not.toBe(result);
    expect(copiedMask).not.toBeNull();
    expect(copiedMask).not.toBe(mask);
    expect(copy.maskLayerId).toBe(copiedMask!.id);
    expect(doc.activeLayerId).toBe(copy.id);
  });
});
