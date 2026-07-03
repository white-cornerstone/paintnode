// End-to-end preservation check through the real ag-psd encoder/decoder (Node,
// no canvas): a PSD is written, read back with `useRawData`, wrapped in a fake
// PaintNode document as an untouched imported layer, then written again. The
// re-written layer's channel data must be byte-identical.

import { describe, expect, it } from 'vitest';
import { readPsd, writePsdUint8Array, type Layer as AgPsdLayer, type Psd } from 'ag-psd';
import type { PaintDocument } from '../engine/Document.svelte';
import type { Layer } from '../engine/Layer.svelte';
import { buildPsdDocument } from './save';

/** Minimal composite stand-in the writer can read (all-transparent pixels). */
function fakeComposite(width: number, height: number): HTMLCanvasElement {
  return {
    width,
    height,
    getContext: () => ({
      getImageData: (x: number, y: number, w: number, h: number) => ({
        width: w,
        height: h,
        data: new Uint8ClampedArray(w * h * 4),
      }),
    }),
  } as unknown as HTMLCanvasElement;
}

function importedLayerFor(src: AgPsdLayer): Layer {
  return {
    name: src.name,
    x: src.left ?? 0,
    y: src.top ?? 0,
    opacity: src.opacity ?? 1,
    visible: !src.hidden,
    blendMode: 'source-over',
    kind: 'raster',
    pixelRev: 1,
    canvas: null,
    psdMask: null,
    text: null,
    psd: {
      layer: src,
      groupPath: [],
      lockReason: null,
      clipping: false,
      blendApproximated: false,
      imported: { x: src.left ?? 0, y: src.top ?? 0, pixelRev: 1, blendMode: 'source-over' },
    },
  } as unknown as Layer;
}

function channelBytes(layer: AgPsdLayer | undefined): string[] {
  return (layer?.rawData?.channels ?? []).map(
    (channel) => `${channel.id}:${channel.compression}:${Array.from(channel.data ?? []).join(',')}`,
  );
}

describe('PSD passthrough round trip', () => {
  it('re-writes an untouched imported layer with byte-identical channels', () => {
    const width = 4;
    const height = 3;
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 200; // r
      pixels[i + 1] = (i / 4) % 256; // g varies per pixel
      pixels[i + 2] = 40; // b
      pixels[i + 3] = i % 2 === 0 ? 255 : 128; // some transparency
    }
    const original: Psd = {
      width,
      height,
      children: [
        {
          name: 'Artwork',
          top: 1,
          left: 1,
          bottom: 1 + height,
          right: 1 + width,
          imageData: { width, height, data: pixels },
        },
      ],
    };
    const originalBytes = writePsdUint8Array(original, { noBackground: true });

    const parsed = readPsd(originalBytes, {
      useRawData: true,
      skipThumbnail: true,
      skipCompositeImageData: true,
    });
    const parsedLayer = parsed.children?.[0];
    expect(parsedLayer?.rawData?.channels.length).toBeGreaterThan(0);

    const doc = {
      width,
      height,
      layers: [importedLayerFor(parsedLayer!)],
      linkedMaskFor: () => null,
      psdSource: { psd: parsed, notices: [] },
    } as unknown as PaintDocument;

    const rewrittenBytes = writePsdUint8Array(
      buildPsdDocument(doc, { compositeCanvas: fakeComposite(width, height) }),
      { noBackground: true },
    );

    const reparsed = readPsd(rewrittenBytes, {
      useRawData: true,
      skipThumbnail: true,
      skipCompositeImageData: true,
    });

    expect(reparsed.children?.[0].name).toBe('Artwork');
    expect(channelBytes(reparsed.children?.[0])).toEqual(channelBytes(parsedLayer));
    expect([reparsed.children?.[0].top, reparsed.children?.[0].left]).toEqual([1, 1]);
  });
});
