import { describe, expect, it } from 'vitest';
import type { Layer as AgPsdLayer, Psd } from 'ag-psd';
import { flattenPsdTree, importNotices, psdLockReason, psdToBlend } from './import';

function psdWith(children: AgPsdLayer[]): Psd {
  return { width: 100, height: 100, children };
}

describe('flattenPsdTree', () => {
  it('flattens nested groups bottom-first with group chains', () => {
    const inner: AgPsdLayer = { name: 'Inner', children: [{ name: 'C' }] };
    const group: AgPsdLayer = { name: 'Group', children: [{ name: 'B' }, inner] };
    const psd = psdWith([{ name: 'A' }, group, { name: 'D' }]);

    const flat = flattenPsdTree(psd);

    expect(flat.map((item) => item.layer.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(flat[0].groupPath).toEqual([]);
    expect(flat[1].groupPath.map((g) => g.name)).toEqual(['Group']);
    expect(flat[2].groupPath.map((g) => g.name)).toEqual(['Group', 'Inner']);
    expect(flat[3].groupPath).toEqual([]);
  });

  it('propagates hidden groups into effective layer visibility', () => {
    const psd = psdWith([
      { name: 'Hidden group', hidden: true, children: [{ name: 'A' }, { name: 'B', hidden: true }] },
      { name: 'Shown', children: [{ name: 'C' }] },
    ]);

    const flat = flattenPsdTree(psd);

    expect(flat.map((item) => [item.layer.name, item.visible])).toEqual([
      ['A', false],
      ['B', false],
      ['C', true],
    ]);
  });

  it('handles a psd without children', () => {
    expect(flattenPsdTree({ width: 1, height: 1 })).toEqual([]);
  });
});

describe('psdLockReason', () => {
  it('leaves plain raster layers editable', () => {
    expect(psdLockReason({ name: 'Paint', top: 0, left: 0 })).toBeNull();
    expect(psdLockReason({ name: 'Masked', mask: { top: 0, left: 0 } })).toBeNull();
  });

  it('locks Photoshop-only layer types with a reason', () => {
    expect(psdLockReason({ adjustment: { type: 'brightness/contrast' } } as AgPsdLayer)).toBe('adjustment');
    expect(psdLockReason({ adjustment: { type: 'solid color', color: { r: 0, g: 0, b: 0 } } } as unknown as AgPsdLayer)).toBe('adjustment');
    expect(psdLockReason({ placedLayer: { id: 'x' } } as unknown as AgPsdLayer)).toBe('smart-object');
    expect(psdLockReason({ text: { text: 'Hi' } })).toBe('text');
    expect(psdLockReason({ vectorMask: { paths: [] } })).toBe('vector');
    expect(psdLockReason({ vectorFill: { type: 'color', color: { r: 0, g: 0, b: 0 } } } as AgPsdLayer)).toBe('vector');
    expect(psdLockReason({ effects: { solidFill: [] } })).toBe('effects');
  });

  it('prefers the most specific reason when several apply', () => {
    expect(psdLockReason({ text: { text: 'Hi' }, effects: { solidFill: [] } })).toBe('text');
  });
});

describe('psdToBlend', () => {
  it('maps supported blend modes exactly', () => {
    expect(psdToBlend('normal')).toEqual({ mode: 'source-over', approximated: false });
    expect(psdToBlend('multiply')).toEqual({ mode: 'multiply', approximated: false });
    expect(psdToBlend('color dodge')).toEqual({ mode: 'color-dodge', approximated: false });
    expect(psdToBlend(undefined)).toEqual({ mode: 'source-over', approximated: false });
  });

  it('approximates Photoshop-only blend modes', () => {
    expect(psdToBlend('linear burn')).toEqual({ mode: 'multiply', approximated: true });
    expect(psdToBlend('vivid light')).toEqual({ mode: 'hard-light', approximated: true });
    expect(psdToBlend('divide')).toEqual({ mode: 'source-over', approximated: true });
  });
});

describe('importNotices', () => {
  it('summarizes locked, adjustment, approximated-blend, and clipped layers', () => {
    const flat = flattenPsdTree(
      psdWith([
        { name: 'Plain' },
        { name: 'Levels', adjustment: { type: 'levels' } } as unknown as AgPsdLayer,
        { name: 'Glow', effects: { solidFill: [] } },
        { name: 'Add', blendMode: 'linear dodge' },
        { name: 'Clip', clipping: true },
      ]),
    );

    const notices = importNotices(flat);

    expect(notices).toHaveLength(4);
    expect(notices[0]).toContain('2 Photoshop-only layers are locked');
    expect(notices[1]).toContain('1 adjustment/fill layer');
    expect(notices[2]).toContain('1 layer uses a blend mode');
    expect(notices[3]).toContain('1 clipping-mask layer');
  });

  it('is empty for a fully supported document', () => {
    expect(importNotices(flattenPsdTree(psdWith([{ name: 'A' }, { name: 'B' }])))).toEqual([]);
  });
});
