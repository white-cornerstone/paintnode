import { describe, expect, it } from 'vitest';
import type { PaintDocument } from '../engine/Document.svelte';
import type { Layer } from '../engine/Layer.svelte';
import { defaultStyle, plainTextModel } from '../engine/text/model';
import { buildPsdDocument, maskImageDataForPsd, textModelToPsdText } from './save';

describe('textModelToPsdText', () => {
  it('exports editable text metadata with style and paragraph runs', () => {
    const model = plainTextModel(
      'Hello\nWorld',
      12,
      18,
      defaultStyle({ family: 'Georgia', size: 24, color: { r: 12, g: 34, b: 56 }, bold: true }),
    );
    model.paragraphs[1].align = 'center';
    model.paragraphs[1].runs[0].style = defaultStyle({
      family: 'Arial',
      size: 18,
      color: { r: 200, g: 10, b: 20 },
      italic: true,
      underline: true,
      tracking: 1.8,
    });

    const layer = { x: 5, y: 7 } as Layer;
    const text = textModelToPsdText(model, layer);

    expect(text.text).toBe('Hello\nWorld');
    expect(text.transform).toEqual([1, 0, 0, 1, 17, 25]);
    expect(text.styleRuns).toHaveLength(3);
    expect(text.styleRuns?.[0].style).toMatchObject({
      font: { name: 'Georgia' },
      fontSize: 24,
      fauxBold: true,
      fillColor: { r: 12, g: 34, b: 56 },
    });
    expect(text.styleRuns?.[2].style).toMatchObject({
      font: { name: 'Arial' },
      fontSize: 18,
      fauxItalic: true,
      underline: true,
      tracking: 100,
    });
    expect(text.paragraphStyleRuns).toEqual([
      { length: 6, style: { justification: 'left', leadingType: 0 } },
      { length: 5, style: { justification: 'center', leadingType: 0 } },
    ]);
  });
});

describe('maskImageDataForPsd', () => {
  it('turns PaintNode mask color and alpha into explicit grayscale coverage', () => {
    const canvas = {
      width: 3,
      height: 1,
      getContext: () => ({
        getImageData: () => ({
          data: new Uint8ClampedArray([
            255, 255, 255, 128,
            128, 128, 128, 128,
            0, 0, 0, 255,
          ]),
        }),
      }),
    } as unknown as HTMLCanvasElement;

    const image = maskImageDataForPsd(canvas);

    expect(image.width).toBe(3);
    expect(image.height).toBe(1);
    expect(Array.from(image.data)).toEqual([
      128, 128, 128, 255,
      64, 64, 64, 255,
      0, 0, 0, 255,
    ]);
  });
});

describe('buildPsdDocument', () => {
  it('keeps PaintNode bottom-to-top layer order for ag-psd', () => {
    const canvas = {} as HTMLCanvasElement;
    const layer = (name: string) => ({
      name,
      x: 0,
      y: 0,
      opacity: 1,
      visible: true,
      blendMode: 'source-over',
      kind: 'raster',
      canvas,
    }) as Layer;
    const doc = {
      width: 10,
      height: 10,
      layers: [layer('Bottom'), layer('Middle'), layer('Top')],
      linkedMaskFor: () => null,
    } as unknown as PaintDocument;

    const psd = buildPsdDocument(doc, { compositeCanvas: canvas });

    expect(psd.children?.map((child) => child.name)).toEqual(['Bottom', 'Middle', 'Top']);
  });
});
