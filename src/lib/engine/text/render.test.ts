import { describe, it, expect } from 'vitest';
import { fontString, layoutModel, textBounds, drawTextModel, type TextDrawTarget } from './render';
import { defaultStyle, plainTextModel } from './model';

// Deterministic fake surface: every glyph is `size * 0.5` wide; ascent/descent are 0.8/0.2 of
// size. The font size is parsed from the `font` shorthand set by the renderer. This lets us
// assert the layout/alignment math without a real canvas.
interface Recorded {
  fillText: { text: string; x: number; y: number }[];
  fillRect: { x: number; y: number; w: number; h: number }[];
}

function fakeSurface(): { target: TextDrawTarget; calls: Recorded } {
  const calls: Recorded = { fillText: [], fillRect: [] };
  let size = 10;
  const target: TextDrawTarget = {
    fillStyle: '',
    textBaseline: 'alphabetic',
    set font(v: string) {
      const m = v.match(/(\d+)px/);
      size = m ? Number(m[1]) : 10;
    },
    get font() {
      return `${size}px`;
    },
    save() {},
    restore() {},
    measureText(text: string) {
      return { width: text.length * size * 0.5, fontBoundingBoxAscent: size * 0.8, fontBoundingBoxDescent: size * 0.2 };
    },
    fillText(text: string, x: number, y: number) {
      calls.fillText.push({ text, x, y });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.fillRect.push({ x, y, w, h });
    },
  };
  return { target, calls };
}

describe('fontString', () => {
  it('includes italic/weight/size/family as needed', () => {
    expect(fontString(defaultStyle({ size: 20 }))).toBe('20px sans-serif');
    expect(fontString(defaultStyle({ size: 20, bold: true, italic: true, family: 'Georgia' }))).toBe(
      'italic 700 20px Georgia',
    );
  });
});

describe('layoutModel', () => {
  it('lays out a single line with baseline-derived height', () => {
    const layout = layoutModel(plainTextModel('AB', 0, 0, defaultStyle({ size: 10 })), fakeSurface().target);
    expect(layout.lines).toHaveLength(1);
    expect(layout.width).toBe(10); // 2 glyphs * 10 * 0.5
    expect(layout.lines[0].ascent).toBe(8);
    expect(layout.height).toBe(13); // 1.3 line-height * 10
  });

  it('uses the widest line for block width and sums line heights', () => {
    const layout = layoutModel(plainTextModel('AB\nABCD', 0, 0, defaultStyle({ size: 10 })), fakeSurface().target);
    expect(layout.lines).toHaveLength(2);
    expect(layout.width).toBe(20); // 'ABCD' = 4 * 5
    expect(layout.height).toBe(26); // 13 + 13
  });
});

describe('textBounds', () => {
  it('is the model position plus the measured size', () => {
    const b = textBounds(plainTextModel('AB', 7, 9, defaultStyle({ size: 10 })), fakeSurface().target);
    expect(b).toEqual({ x: 7, y: 9, w: 10, h: 13 });
  });
});

describe('drawTextModel', () => {
  it('center-aligns shorter lines within the block width and advances the baseline', () => {
    const m = plainTextModel('ABCD\nAB', 100, 50, defaultStyle({ size: 10 }));
    m.paragraphs[0].align = 'center';
    m.paragraphs[1].align = 'center';
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    // block width = 20; line0 'ABCD' (20) -> x=100; line1 'AB' (10) -> x=100+(20-10)/2=105
    expect(calls.fillText[0]).toMatchObject({ text: 'ABCD', x: 100, y: 58 });
    expect(calls.fillText[1]).toMatchObject({ text: 'AB', x: 105, y: 71 });
  });

  it('right-aligns to the block right edge', () => {
    const m = plainTextModel('ABCD\nAB', 0, 0, defaultStyle({ size: 10 }));
    m.paragraphs[1].align = 'right';
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    expect(calls.fillText[1]).toMatchObject({ text: 'AB', x: 10 }); // 0 + (20 - 10)
  });

  it('draws an underline rect spanning the run width', () => {
    const m = plainTextModel('AB', 0, 0, defaultStyle({ size: 10, underline: true }));
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    expect(calls.fillRect).toHaveLength(1);
    expect(calls.fillRect[0].w).toBe(10);
  });
});
