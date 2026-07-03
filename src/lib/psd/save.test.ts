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
    expect(text.paragraphStyleRuns).toHaveLength(2);
    expect(text.paragraphStyleRuns?.[0].length).toBe(6);
    expect(text.paragraphStyleRuns?.[0].style).toMatchObject({ justification: 'left', leadingType: 0 });
    expect(text.paragraphStyleRuns?.[1].length).toBe(5);
    expect(text.paragraphStyleRuns?.[1].style).toMatchObject({ justification: 'center' });
  });

  it('exports the v2 character and paragraph attributes', () => {
    const model = plainTextModel(
      'Hi',
      0,
      0,
      defaultStyle({
        size: 20,
        leading: 26,
        horizontalScale: 80,
        verticalScale: 120,
        baselineShift: 2,
        caps: 'small',
        script: 'sub',
        strikethrough: true,
      }),
    );
    model.paragraphs[0].align = 'justify-all';
    model.paragraphs[0].indentLeft = 12;
    model.paragraphs[0].spaceAfter = 6;
    model.paragraphs[0].hyphenate = true;

    const text = textModelToPsdText(model, { x: 0, y: 0 } as Layer);

    expect(text.styleRuns?.[0].style).toMatchObject({
      leading: 26,
      autoLeading: false,
      horizontalScale: 0.8,
      verticalScale: 1.2,
      baselineShift: 2,
      fontCaps: 1,
      fontBaseline: 2,
      strikethrough: true,
    });
    expect(text.paragraphStyle).toMatchObject({
      justification: 'justify-all',
      startIndent: 12,
      spaceAfter: 6,
      autoHyphenate: true,
    });
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
