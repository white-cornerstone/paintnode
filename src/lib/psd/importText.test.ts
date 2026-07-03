import { describe, expect, it } from 'vitest';
import type { LayerTextData } from 'ag-psd';
import { familyFromPsdFont, psdTextBlockers, psdTextToModel } from './import';

describe('psdTextBlockers', () => {
  it('accepts plain horizontal point text', () => {
    expect(psdTextBlockers({ text: 'Hi', shapeType: 'point' })).toEqual([]);
    expect(psdTextBlockers({ text: 'Hi', transform: [1, 0, 0, 1, 20, 40] })).toEqual([]);
  });

  it('flags vertical, box, warped, path, transformed, and stroked text', () => {
    expect(psdTextBlockers({ text: 'x', orientation: 'vertical' })).toContain('vertical orientation');
    expect(psdTextBlockers({ text: 'x', shapeType: 'box' })).toContain('area (box) text');
    expect(psdTextBlockers({ text: 'x', warp: { style: 'arc' } } as unknown as LayerTextData)).toContain('warped text');
    expect(psdTextBlockers({ text: 'x', textPath: {} } as unknown as LayerTextData)).toContain('text on a path');
    expect(psdTextBlockers({ text: 'x', transform: [0.7, 0.7, -0.7, 0.7, 0, 0] })).toContain('rotated or scaled text');
    expect(psdTextBlockers({ text: 'x', styleRuns: [{ length: 1, style: { strokeFlag: true } }] })).toContain('stroked text');
  });
});

describe('familyFromPsdFont', () => {
  it('maps known PostScript names', () => {
    expect(familyFromPsdFont('ArialMT')).toEqual({ family: 'Arial', bold: false, italic: false });
    expect(familyFromPsdFont('Arial-BoldMT')).toEqual({ family: 'Arial', bold: true, italic: false });
    expect(familyFromPsdFont('TimesNewRomanPS-BoldItalicMT')).toEqual({
      family: 'Times New Roman',
      bold: true,
      italic: true,
    });
  });

  it('derives family and faux flags from unknown names', () => {
    expect(familyFromPsdFont('Futura-CondensedBoldOblique')).toMatchObject({ bold: true, italic: true });
    expect(familyFromPsdFont('MyriadPro-Regular').family).toBe('Myriad Pro');
    expect(familyFromPsdFont(undefined)).toEqual({ family: 'sans-serif', bold: false, italic: false });
  });
});

describe('psdTextToModel', () => {
  it('splits Photoshop \\r paragraphs and expands style runs', () => {
    const model = psdTextToModel({
      text: 'Hi\rWorld',
      style: { font: { name: 'ArialMT' }, fontSize: 24, fillColor: { r: 10, g: 20, b: 30 } },
      styleRuns: [
        { length: 3, style: { fauxBold: true } },
        { length: 5, style: { fontSize: 12, underline: true } },
      ],
      paragraphStyleRuns: [
        { length: 3, style: { justification: 'center' } },
        { length: 5, style: { justification: 'right', startIndent: 8 } },
      ],
    });

    expect(model).not.toBeNull();
    expect(model!.paragraphs).toHaveLength(2);
    expect(model!.paragraphs[0].align).toBe('center');
    expect(model!.paragraphs[0].runs[0]).toMatchObject({ text: 'Hi' });
    expect(model!.paragraphs[0].runs[0].style).toMatchObject({ family: 'Arial', size: 24, bold: true });
    expect(model!.paragraphs[1].align).toBe('right');
    expect(model!.paragraphs[1].indentLeft).toBe(8);
    expect(model!.paragraphs[1].runs[0].style).toMatchObject({ size: 12, underline: true });
    expect(model!.paragraphs[1].runs[0].text).toBe('World');
  });

  it('converts units: tracking ‰em→px, scales ×100, leading auto/explicit', () => {
    const model = psdTextToModel({
      text: 'ab',
      styleRuns: [
        {
          length: 2,
          style: {
            fontSize: 20,
            tracking: 100,
            horizontalScale: 0.8,
            verticalScale: 1.2,
            autoLeading: false,
            leading: 26,
            baselineShift: 3,
            fontCaps: 2,
            fontBaseline: 1,
            strikethrough: true,
          },
        },
      ],
    });

    const style = model!.paragraphs[0].runs[0].style;
    expect(style.tracking).toBeCloseTo(2, 5); // 100/1000 × 20
    expect(style.horizontalScale).toBe(80);
    expect(style.verticalScale).toBe(120);
    expect(style.leading).toBe(26);
    expect(style.baselineShift).toBe(3);
    expect(style.caps).toBe('all');
    expect(style.script).toBe('super');
    expect(style.strikethrough).toBe(true);
  });

  it('treats auto leading as null and keeps the anti-alias mode', () => {
    const model = psdTextToModel({ text: 'x', antiAlias: 'crisp', style: { autoLeading: true, leading: 22 } });
    expect(model!.paragraphs[0].runs[0].style.leading).toBeNull();
    expect(model!.antiAlias).toBe('crisp');
  });

  it('returns null for blocked text', () => {
    expect(psdTextToModel({ text: 'x', orientation: 'vertical' })).toBeNull();
  });

  it('handles text without style runs and trailing newline paragraphs', () => {
    const model = psdTextToModel({ text: 'One\r', style: { fontSize: 30 } });
    expect(model!.paragraphs).toHaveLength(2);
    expect(model!.paragraphs[0].runs[0].text).toBe('One');
    expect(model!.paragraphs[1].runs[0].text).toBe('');
  });
});
