import { describe, it, expect } from 'vitest';
import { fontString, layoutModel, textBounds, drawTextModel, type TextDrawTarget } from './render';
import { defaultParagraph, defaultStyle, plainTextModel } from './model';

// Deterministic fake surface: every glyph is `size * 0.5` wide; ascent/descent are 0.8/0.2 of
// size. The font size is parsed from the `font` shorthand set by the renderer. Transforms are
// tracked so recorded draw calls are in absolute (document) coordinates, letting us assert
// scaled/shifted rendering without a real canvas.
interface Recorded {
  fillText: { text: string; x: number; y: number }[];
  fillRect: { x: number; y: number; w: number; h: number }[];
}

function fakeSurface(): { target: TextDrawTarget; calls: Recorded } {
  const calls: Recorded = { fillText: [], fillRect: [] };
  let size = 10;
  let state = { tx: 0, ty: 0, sx: 1, sy: 1 };
  const stack: (typeof state)[] = [];
  const target: TextDrawTarget = {
    fillStyle: '',
    textBaseline: 'alphabetic',
    set font(v: string) {
      const m = v.match(/([\d.]+)px/);
      size = m ? Number(m[1]) : 10;
    },
    get font() {
      return `${size}px`;
    },
    save() {
      stack.push({ ...state });
    },
    restore() {
      state = stack.pop() ?? state;
    },
    translate(x: number, y: number) {
      state = { ...state, tx: state.tx + x * state.sx, ty: state.ty + y * state.sy };
    },
    scale(x: number, y: number) {
      state = { ...state, sx: state.sx * x, sy: state.sy * y };
    },
    rotate() {
      /* rotation is not tracked; rotated-glyph positions assert the translate only */
    },
    measureText(text: string) {
      return { width: text.length * size * 0.5, fontBoundingBoxAscent: size * 0.8, fontBoundingBoxDescent: size * 0.2 };
    },
    fillText(text: string, x: number, y: number) {
      calls.fillText.push({ text, x: state.tx + x * state.sx, y: state.ty + y * state.sy });
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.fillRect.push({ x: state.tx + x * state.sx, y: state.ty + y * state.sy, w: w * state.sx, h: h * state.sy });
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
  it('lays out a single line as ascent + descent tall', () => {
    const layout = layoutModel(plainTextModel('AB', 0, 0, defaultStyle({ size: 10 })), fakeSurface().target);
    expect(layout.lines).toHaveLength(1);
    expect(layout.width).toBe(10); // 2 glyphs * 10 * 0.5
    expect(layout.lines[0].ascent).toBe(8);
    expect(layout.height).toBe(10); // ascent 8 + descent 2
  });

  it('advances baselines by auto leading (1.2 × size) between lines', () => {
    const layout = layoutModel(plainTextModel('AB\nABCD', 0, 0, defaultStyle({ size: 10 })), fakeSurface().target);
    expect(layout.lines).toHaveLength(2);
    expect(layout.width).toBe(20); // 'ABCD' = 4 * 5
    expect(layout.lines[0].baseline).toBe(8);
    expect(layout.lines[1].baseline).toBe(20); // 8 + 12 auto leading
    expect(layout.height).toBe(22); // last baseline + descent 2
  });

  it('advances baselines by explicit leading when set', () => {
    const layout = layoutModel(
      plainTextModel('A\nB', 0, 0, defaultStyle({ size: 10, leading: 30 })),
      fakeSurface().target,
    );
    expect(layout.lines[1].baseline).toBe(38); // 8 + 30
  });

  it('adds paragraph space before/after between lines', () => {
    const m = plainTextModel('A\nB', 0, 0, defaultStyle({ size: 10 }));
    m.paragraphs[0].spaceAfter = 5;
    m.paragraphs[1].spaceBefore = 7;
    const layout = layoutModel(m, fakeSurface().target);
    expect(layout.lines[1].baseline).toBe(32); // 8 + 5 + 7 + 12
  });

  it('applies indents to line starts and block width', () => {
    const m = plainTextModel('AB', 0, 0, defaultStyle({ size: 10 }));
    m.paragraphs[0].indentLeft = 4;
    m.paragraphs[0].firstLineIndent = 6;
    m.paragraphs[0].indentRight = 5;
    const layout = layoutModel(m, fakeSurface().target);
    expect(layout.lines[0].x).toBe(10); // 4 + 6
    expect(layout.width).toBe(25); // 10 + 10 + 5
  });

  it('scales run width by horizontal scale', () => {
    const layout = layoutModel(
      plainTextModel('AB', 0, 0, defaultStyle({ size: 10, horizontalScale: 50 })),
      fakeSurface().target,
    );
    expect(layout.width).toBe(5);
  });

  it('treats justify alignments as their base alignment for point text', () => {
    const m = plainTextModel('ABCD\nAB', 0, 0, defaultStyle({ size: 10 }));
    m.paragraphs[1].align = 'justify-center';
    const layout = layoutModel(m, fakeSurface().target);
    expect(layout.lines[1].x).toBe(5); // centered within block width 20
  });
});

describe('textBounds', () => {
  it('is the model position plus the measured size', () => {
    const b = textBounds(plainTextModel('AB', 7, 9, defaultStyle({ size: 10 })), fakeSurface().target);
    expect(b).toEqual({ x: 7, y: 9, w: 10, h: 10 });
  });

  it('extends left for negative first-line indents', () => {
    const m = plainTextModel('AB', 10, 0, defaultStyle({ size: 10 }));
    m.paragraphs[0].firstLineIndent = -4;
    const b = textBounds(m, fakeSurface().target);
    expect(b.x).toBe(6); // text starts 4px left of the anchor
    expect(b.w).toBe(10); // and still spans its own width
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
    expect(calls.fillText[1]).toMatchObject({ text: 'AB', x: 105, y: 70 }); // 58 + 12 leading
  });

  it('right-aligns to the block right edge', () => {
    const m = plainTextModel('ABCD\nAB', 0, 0, defaultStyle({ size: 10 }));
    m.paragraphs[1].align = 'right';
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    expect(calls.fillText[1]).toMatchObject({ text: 'AB', x: 10 }); // 0 + (20 - 10)
  });

  it('draws underline and strikethrough rects spanning the run width', () => {
    const m = plainTextModel('AB', 0, 0, defaultStyle({ size: 10, underline: true, strikethrough: true }));
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    expect(calls.fillRect).toHaveLength(2);
    expect(calls.fillRect[0].w).toBe(10);
    expect(calls.fillRect[1].w).toBe(10);
  });

  it('shifts the baseline up for positive baseline shift', () => {
    const m = plainTextModel('A', 0, 0, defaultStyle({ size: 10, baselineShift: 3 }));
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    // ascent grows to 8 + 3 = 11, and the glyph draws 3px above that baseline.
    expect(calls.fillText[0].y).toBe(8);
  });

  it('renders superscript smaller and raised', () => {
    const m = plainTextModel('A', 0, 0, defaultStyle({ size: 10, script: 'super' }));
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    const baseline = 10 * 0.583 * 0.8 + 10 * 0.333; // scaled ascent + script shift
    expect(calls.fillText[0].y).toBeCloseTo(baseline - 10 * 0.333, 5);
  });

  it('applies horizontal scale via a transform (absolute positions compressed)', () => {
    const m = plainTextModel('AB', 0, 0, defaultStyle({ size: 10, horizontalScale: 50, tracking: 2 }));
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    // Per-char path (tracking): second glyph at (5 + 2) * 0.5 = 3.5 absolute.
    expect(calls.fillText[0].x).toBe(0);
    expect(calls.fillText[1].x).toBeCloseTo(3.5, 5);
  });

  it('renders all caps as uppercase text', () => {
    const m = plainTextModel('ab', 0, 0, defaultStyle({ size: 10, caps: 'all' }));
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    expect(calls.fillText[0].text).toBe('AB');
  });

  it('splits small caps into full-size and reduced uppercase segments', () => {
    const m = plainTextModel('aB', 0, 0, defaultStyle({ size: 10, caps: 'small' }));
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    expect(calls.fillText.map((c) => c.text)).toEqual(['A', 'B']);
  });

  it('lays out vertical text as right-to-left columns with per-char advances', () => {
    const m = plainTextModel('AB\n漢字', 100, 50, defaultStyle({ size: 10 }));
    m.orientation = 'vertical';
    const b = textBounds(m, fakeSurface().target);
    // Two columns × auto leading (12) wide; tallest column: CJK 10+10 = 20.
    expect(b).toEqual({ x: 100, y: 50, w: 24, h: 20 });

    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    const a = calls.fillText.find((c) => c.text === 'A')!;
    const han = calls.fillText.find((c) => c.text === '漢')!;
    const zi = calls.fillText.find((c) => c.text === '字')!;
    // First paragraph is the rightmost column.
    expect(a.x).toBeGreaterThan(han.x);
    // Characters in a column stack downward.
    expect(zi.y).toBeGreaterThan(han.y);
  });

  it('keeps blank paragraphs occupying vertical space', () => {
    const m = {
      version: 1 as const,
      x: 0,
      y: 0,
      paragraphs: [
        defaultParagraph({ runs: [{ text: 'A', style: defaultStyle({ size: 10 }) }] }),
        defaultParagraph({ runs: [] }),
        defaultParagraph({ runs: [{ text: 'B', style: defaultStyle({ size: 10 }) }] }),
      ],
    };
    const { target, calls } = fakeSurface();
    drawTextModel(target, m);
    const a = calls.fillText.find((c) => c.text === 'A')!;
    const b = calls.fillText.find((c) => c.text === 'B')!;
    expect(b.y).toBeGreaterThan(a.y + 12); // an empty line advanced the baseline
  });
});
