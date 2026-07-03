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
    canvas,
    psd,
    psdMask: init.psdMask ?? null,
    text: null,
  } as unknown as Layer;
}

function fakeDoc(layers: Layer[], psdSource: PaintDocument['psdSource'] = null): PaintDocument {
  return {
    width: 100,
    height: 80,
    layers,
    linkedMaskFor: () => null,
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
