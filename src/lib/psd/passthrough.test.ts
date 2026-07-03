import { describe, expect, it } from 'vitest';
import type { Layer as AgPsdLayer } from 'ag-psd';
import type { PaintDocument } from '../engine/Document.svelte';
import type { Layer } from '../engine/Layer.svelte';
import type { PsdLayerSource } from '../engine/psdSource';
import { buildPsdChildren, buildPsdDocument, isCleanPsdLayer, passthroughPsdLayer } from './save';

const canvas = {} as HTMLCanvasElement;

interface FakeLayerInit {
  name?: string;
  x?: number;
  y?: number;
  opacity?: number;
  visible?: boolean;
  blendMode?: string;
  pixelRev?: number;
  maskEnabled?: boolean;
  psd?: Partial<PsdLayerSource> & { layer: AgPsdLayer };
  psdMask?: Layer['psdMask'];
}

function fakeLayer(init: FakeLayerInit): Layer {
  const psd = init.psd
    ? {
        groupPath: [],
        lockReason: null,
        clipping: false,
        blendApproximated: false,
        imported: { x: init.x ?? 0, y: init.y ?? 0, pixelRev: init.pixelRev ?? 1, blendMode: init.blendMode ?? 'source-over' },
        ...init.psd,
      }
    : null;
  return {
    name: init.name ?? 'Layer',
    x: init.x ?? 0,
    y: init.y ?? 0,
    opacity: init.opacity ?? 1,
    visible: init.visible ?? true,
    blendMode: init.blendMode ?? 'source-over',
    kind: 'raster',
    pixelRev: init.pixelRev ?? 1,
    maskEnabled: init.maskEnabled ?? true,
    canvas,
    psd,
    psdMask: init.psdMask ?? null,
    text: null,
  } as unknown as Layer;
}

function fakeDoc(
  layers: Layer[],
  psdSource: PaintDocument['psdSource'] = null,
  linkedMaskFor: (layer: Layer) => Layer | null = () => null,
): PaintDocument {
  return {
    width: 100,
    height: 80,
    layers,
    linkedMaskFor,
    psdSource,
  } as unknown as PaintDocument;
}

describe('passthroughPsdLayer', () => {
  it('re-emits the original layer with rawData and patches safe fields', () => {
    const rawData = { colorMode: 3, bitsPerChannel: 8, channels: [], large: false } as unknown as AgPsdLayer['rawData'];
    const placedLayer = { id: 'smart' } as unknown as NonNullable<AgPsdLayer['placedLayer']>;
    const src: AgPsdLayer = {
      name: 'Smart',
      top: 5,
      left: 6,
      bottom: 10,
      right: 11,
      blendMode: 'linear light',
      rawData,
      placedLayer,
    };
    const layer = fakeLayer({
      name: 'Renamed',
      x: 6,
      y: 5,
      opacity: 0.5,
      visible: false,
      blendMode: 'hard-light',
      psd: {
        layer: src,
        lockReason: 'smart-object',
        blendApproximated: true,
        imported: { x: 6, y: 5, pixelRev: 1, blendMode: 'hard-light' },
      },
    });

    const out = passthroughPsdLayer(layer);

    expect(out.rawData).toBe(rawData);
    expect(out.placedLayer).toBe(placedLayer);
    expect(out.name).toBe('Renamed');
    expect(out.hidden).toBe(true);
    expect(out.opacity).toBe(0.5);
    // Blend unchanged in PaintNode → original Photoshop-only mode is kept.
    expect(out.blendMode).toBe('linear light');
    // Locked layers never get a position patch.
    expect(out.top).toBe(5);
    expect(out.left).toBe(6);
  });

  it('writes the new blend mode only when the user changed it', () => {
    const src: AgPsdLayer = { name: 'A', blendMode: 'linear light' };
    const layer = fakeLayer({
      blendMode: 'multiply',
      psd: { layer: src, imported: { x: 0, y: 0, pixelRev: 1, blendMode: 'hard-light' } },
    });

    expect(passthroughPsdLayer(layer).blendMode).toBe('multiply');
  });

  it('patches position (and mask position) for moved editable raster layers', () => {
    const src: AgPsdLayer = {
      name: 'A',
      top: 10,
      left: 20,
      bottom: 30,
      right: 40,
      mask: { top: 12, left: 22, bottom: 28, right: 38 },
    };
    const layer = fakeLayer({
      x: 25,
      y: 13,
      psd: { layer: src, imported: { x: 20, y: 10, pixelRev: 1, blendMode: 'source-over' } },
    });

    const out = passthroughPsdLayer(layer);

    expect([out.top, out.left, out.bottom, out.right]).toEqual([13, 25, 33, 45]);
    expect([out.mask?.top, out.mask?.left, out.mask?.bottom, out.mask?.right]).toEqual([15, 27, 31, 43]);
    // The original parsed object is never mutated.
    expect([src.top, src.left, src.mask?.top]).toEqual([10, 20, 12]);
  });

  it('patches the mask disabled flag when the linked mask is toggled off', () => {
    const src: AgPsdLayer = { name: 'A', mask: { top: 0, left: 0, bottom: 4, right: 4 } };
    const layer = fakeLayer({
      maskEnabled: false,
      psd: {
        layer: src,
        imported: { x: 0, y: 0, pixelRev: 1, blendMode: 'source-over', mask: { layerId: 'm', pixelRev: 1, x: 0, y: 0 } },
      },
    });

    const out = passthroughPsdLayer(layer);

    expect(out.mask?.disabled).toBe(true);
    expect(src.mask?.disabled).toBeUndefined();
  });

  it('keeps the own hidden flag of visible children inside hidden groups', () => {
    // Effective visibility at import was false (hidden ancestor group), the layer's
    // own flag is not hidden — untouched round trip must not patch it.
    const src: AgPsdLayer = { name: 'A' };
    const layer = fakeLayer({
      visible: false,
      psd: { layer: src, imported: { x: 0, y: 0, pixelRev: 1, blendMode: 'source-over', visible: false } },
    });

    expect(passthroughPsdLayer(layer).hidden).toBeUndefined();
  });

  it('patches hidden only when the user changed visibility', () => {
    const src: AgPsdLayer = { name: 'A' };
    const layer = fakeLayer({
      visible: false,
      psd: { layer: src, imported: { x: 0, y: 0, pixelRev: 1, blendMode: 'source-over', visible: true } },
    });

    expect(passthroughPsdLayer(layer).hidden).toBe(true);
  });

  it('moves the text transform along with a moved clean text layer', () => {
    const src: AgPsdLayer = {
      name: 'T',
      top: 10,
      left: 20,
      bottom: 30,
      right: 40,
      text: { text: 'Hi', transform: [1, 0, 0, 1, 22, 28], left: 20, top: 10, right: 40, bottom: 30 },
    };
    const layer = fakeLayer({
      x: 30,
      y: 15,
      psd: { layer: src, imported: { x: 20, y: 10, pixelRev: 1, blendMode: 'source-over' } },
    });

    const out = passthroughPsdLayer(layer);

    expect(out.text?.transform).toEqual([1, 0, 0, 1, 32, 33]);
    expect([out.text?.left, out.text?.top]).toEqual([30, 15]);
    // The original parsed text record is never mutated.
    expect(src.text?.transform).toEqual([1, 0, 0, 1, 22, 28]);
  });
});

describe('isCleanPsdLayer', () => {
  it('is clean while pixels are untouched and dirty after edits', () => {
    const src: AgPsdLayer = { name: 'A' };
    const clean = fakeLayer({ pixelRev: 3, psd: { layer: src, imported: { x: 0, y: 0, pixelRev: 3, blendMode: 'source-over' } } });
    const dirty = fakeLayer({ pixelRev: 4, psd: { layer: src, imported: { x: 0, y: 0, pixelRev: 3, blendMode: 'source-over' } } });
    const doc = fakeDoc([clean, dirty]);

    expect(isCleanPsdLayer(doc, clean)).toBe(true);
    expect(isCleanPsdLayer(doc, dirty)).toBe(false);
  });

  function maskedLayer(overrides: Partial<{ layerX: number; maskRev: number; maskX: number }> = {}): {
    layer: Layer;
    mask: Layer;
  } {
    const src: AgPsdLayer = { name: 'A', mask: { top: 0, left: 0, bottom: 4, right: 4 } };
    const mask = {
      id: 'mask-1',
      kind: 'ai-retouch-mask',
      pixelRev: overrides.maskRev ?? 1,
      x: overrides.maskX ?? 0,
      y: 0,
    } as unknown as Layer;
    const layer = fakeLayer({
      x: overrides.layerX ?? 0,
      psd: {
        layer: src,
        imported: {
          x: 0,
          y: 0,
          pixelRev: 1,
          blendMode: 'source-over',
          mask: { layerId: 'mask-1', pixelRev: 1, x: 0, y: 0 },
        },
      },
    });
    return { layer, mask };
  }

  it('stays clean while the imported linked mask is untouched', () => {
    const { layer, mask } = maskedLayer();
    expect(isCleanPsdLayer(fakeDoc([layer], null, () => mask), layer)).toBe(true);
  });

  it('goes dirty when the imported linked mask is painted, moved, or deleted', () => {
    const painted = maskedLayer({ maskRev: 2 });
    expect(isCleanPsdLayer(fakeDoc([painted.layer], null, () => painted.mask), painted.layer)).toBe(false);

    const moved = maskedLayer({ maskX: 5 });
    expect(isCleanPsdLayer(fakeDoc([moved.layer], null, () => moved.mask), moved.layer)).toBe(false);

    const deleted = maskedLayer();
    expect(isCleanPsdLayer(fakeDoc([deleted.layer], null, () => null), deleted.layer)).toBe(false);
  });

  it('goes dirty when the parent moves under its document-anchored mask', () => {
    const { layer, mask } = maskedLayer({ layerX: 10 });
    expect(isCleanPsdLayer(fakeDoc([layer], null, () => mask), layer)).toBe(false);
  });
});

describe('buildPsdChildren', () => {
  it('rebuilds edited imported layers from canvas, keeping parsed metadata', () => {
    const rawData = { channels: [] } as unknown as AgPsdLayer['rawData'];
    const src: AgPsdLayer = { name: 'A', id: 42, top: 1, left: 2, bottom: 3, right: 4, rawData };
    const layer = fakeLayer({
      name: 'A',
      x: 7,
      y: 8,
      pixelRev: 9,
      psd: { layer: src, imported: { x: 2, y: 1, pixelRev: 1, blendMode: 'source-over' } },
    });

    const [out] = buildPsdChildren(fakeDoc([layer]));

    expect(out.rawData).toBeUndefined();
    expect(out.canvas).toBe(canvas);
    expect(out.id).toBe(42);
    expect([out.top, out.left]).toEqual([8, 7]);
    expect(out.bottom).toBeUndefined();
  });

  it('reconstructs the original group tree and adopts new layers into the group below', () => {
    const group: AgPsdLayer = { name: 'Group', opened: false, children: [] };
    const inGroupA = fakeLayer({ name: 'InA', psd: { layer: { name: 'InA' }, groupPath: [group] } });
    const inGroupB = fakeLayer({ name: 'InB', psd: { layer: { name: 'InB' }, groupPath: [group] } });
    const added = fakeLayer({ name: 'Added' }); // PaintNode layer inserted between group members
    const root = fakeLayer({ name: 'Root', psd: { layer: { name: 'Root' } } });

    const children = buildPsdChildren(fakeDoc([root, inGroupA, added, inGroupB]));

    expect(children.map((child) => child.name)).toEqual(['Root', 'Group']);
    expect(children[1].opened).toBe(false);
    expect(children[1].children?.map((child) => child.name)).toEqual(['InA', 'Added', 'InB']);
  });

  it('splits an imported group instead of reordering when layers interleave', () => {
    const group: AgPsdLayer = { name: 'G', children: [] };
    const inGroupA = fakeLayer({ name: 'A', psd: { layer: { name: 'A' }, groupPath: [group] } });
    const inGroupB = fakeLayer({ name: 'B', psd: { layer: { name: 'B' }, groupPath: [group] } });
    const rootC = fakeLayer({ name: 'C', psd: { layer: { name: 'C' } } }); // imported root layer

    // Stack (bottom→top): A, C, B — C must stay ABOVE A and BELOW B in the PSD.
    const children = buildPsdChildren(fakeDoc([inGroupA, rootC, inGroupB]));

    expect(children.map((child) => child.name)).toEqual(['G', 'C', 'G']);
    expect(children[0].children?.map((c) => c.name)).toEqual(['A']);
    expect(children[2].children?.map((c) => c.name)).toEqual(['B']);
  });

  it('drops the live text record when an imported text layer was rasterized', () => {
    const src: AgPsdLayer = { name: 'T', text: { text: 'old text' } };
    const layer = fakeLayer({
      name: 'T',
      pixelRev: 9, // painted over → dirty rebuild
      psd: { layer: src, imported: { x: 0, y: 0, pixelRev: 1, blendMode: 'source-over' } },
    });
    // kind stays 'raster' (fakeLayer default), text null — the user rasterized it.

    const [out] = buildPsdChildren(fakeDoc([layer]));

    expect(out.text).toBeUndefined();
    expect(out.canvas).toBe(canvas);
  });

  it('keeps a flat list for documents without PSD source', () => {
    const children = buildPsdChildren(fakeDoc([fakeLayer({ name: 'A' }), fakeLayer({ name: 'B' })]));
    expect(children.map((child) => child.name)).toEqual(['A', 'B']);
    expect(children[0].canvas).toBe(canvas);
  });
});

describe('buildPsdDocument with psdSource', () => {
  it('passes document-level resources through and regenerates the composite', () => {
    const layer = fakeLayer({ name: 'A', psd: { layer: { name: 'A' } } });
    const doc = fakeDoc([layer], {
      psd: {
        width: 999,
        height: 999,
        channels: 4,
        colorMode: 3,
        linkedFiles: [{ id: 'file1' }] as never,
        imageResources: { globalAngle: 30, alphaChannelNames: ['x'] },
        rawCompositeData: new Uint8Array([1, 2, 3]),
      },
      notices: [],
    });

    const psd = buildPsdDocument(doc, { compositeCanvas: canvas });

    expect(psd.width).toBe(100);
    expect(psd.height).toBe(80);
    expect(psd.linkedFiles).toEqual([{ id: 'file1' }]);
    expect(psd.imageResources?.globalAngle).toBe(30);
    expect(psd.imageResources?.versionInfo?.writerName).toBe('PaintNode');
    expect(psd.rawCompositeData).toBeUndefined();
    expect(psd.canvas).toBe(canvas);
    expect(psd.children?.[0].name).toBe('A');
  });
});
