import { describe, it, expect } from 'vitest';
import {
  cloneModel,
  defaultStyle,
  deserializeModel,
  fontFamiliesUsed,
  isBlankModel,
  modelToPlainText,
  plainTextModel,
  serializeModel,
  textLayerName,
} from './model';

describe('plainTextModel', () => {
  it('splits newlines into separate paragraphs and keeps position', () => {
    const m = plainTextModel('a\nb\n', 10, 20, defaultStyle());
    expect(m.paragraphs).toHaveLength(3);
    expect(m.x).toBe(10);
    expect(m.y).toBe(20);
    expect(m.paragraphs[0].runs[0].text).toBe('a');
    expect(m.paragraphs[2].runs[0].text).toBe('');
  });
});

describe('modelToPlainText / isBlankModel', () => {
  it('round-trips to plain text', () => {
    expect(modelToPlainText(plainTextModel('hi\nthere', 0, 0, defaultStyle()))).toBe('hi\nthere');
  });
  it('detects blank vs non-blank', () => {
    expect(isBlankModel(plainTextModel('   ', 0, 0, defaultStyle()))).toBe(true);
    expect(isBlankModel(plainTextModel('\n\n', 0, 0, defaultStyle()))).toBe(true);
    expect(isBlankModel(plainTextModel('x', 0, 0, defaultStyle()))).toBe(false);
  });
});

describe('textLayerName', () => {
  it('uses the first non-empty line, trimmed and capped at 24 chars', () => {
    expect(textLayerName(plainTextModel('\n  Hello world  \n', 0, 0, defaultStyle()))).toBe('Hello world');
    expect(textLayerName(plainTextModel('x'.repeat(40), 0, 0, defaultStyle()))).toHaveLength(24);
    expect(textLayerName(plainTextModel('   ', 0, 0, defaultStyle()))).toBe('Text');
  });
});

describe('fontFamiliesUsed', () => {
  it('collects distinct families across runs', () => {
    const m = plainTextModel('a', 0, 0, defaultStyle({ family: 'Georgia' }));
    m.paragraphs[0].runs.push({ text: 'b', style: defaultStyle({ family: 'Arial' }) });
    m.paragraphs[0].runs.push({ text: 'c', style: defaultStyle({ family: 'Georgia' }) });
    expect(fontFamiliesUsed(m).sort()).toEqual(['Arial', 'Georgia']);
  });
});

describe('cloneModel', () => {
  it('deep-copies so mutations do not leak back', () => {
    const m = plainTextModel('a', 1, 2, defaultStyle());
    const c = cloneModel(m);
    c.x = 99;
    c.paragraphs[0].runs[0].text = 'z';
    c.paragraphs[0].runs[0].style.size = 5;
    c.paragraphs[0].runs[0].style.color.r = 200;
    expect(m.x).toBe(1);
    expect(m.paragraphs[0].runs[0].text).toBe('a');
    expect(m.paragraphs[0].runs[0].style.size).toBe(72);
    expect(m.paragraphs[0].runs[0].style.color.r).toBe(0);
  });
});

describe('serialize / deserialize', () => {
  it('round-trips a rich, multi-run, multi-paragraph model exactly', () => {
    const m = plainTextModel(
      'Hello\nWorld',
      12,
      34,
      defaultStyle({ family: 'Georgia', size: 40, bold: true, color: { r: 10, g: 20, b: 30 } }),
    );
    m.paragraphs[0].align = 'center';
    m.paragraphs[0].runs.push({
      text: '!',
      style: defaultStyle({ italic: true, underline: true, tracking: 3 }),
    });
    expect(deserializeModel(serializeModel(m))).toEqual(m);
  });

  it('rejects corrupt, empty, or non-object input', () => {
    expect(deserializeModel('{not json')).toBeNull();
    expect(deserializeModel('null')).toBeNull();
    expect(deserializeModel('"a string"')).toBeNull();
    expect(deserializeModel('{"paragraphs":[]}')).toBeNull();
  });

  it('coerces foreign/partial JSON, filling defaults', () => {
    const m = deserializeModel('{"x":5,"paragraphs":[{"runs":[{"text":"hi"}]}]}');
    expect(m).not.toBeNull();
    expect(m!.x).toBe(5);
    expect(m!.y).toBe(0);
    expect(m!.paragraphs[0].align).toBe('left');
    expect(m!.paragraphs[0].indentLeft).toBe(0);
    expect(m!.paragraphs[0].spaceAfter).toBe(0);
    const style = m!.paragraphs[0].runs[0].style;
    expect(style.family).toBe('sans-serif');
    expect(style.size).toBe(72);
    expect(style.color).toEqual({ r: 0, g: 0, b: 0 });
    expect(style.leading).toBeNull();
    expect(style.horizontalScale).toBe(100);
    expect(style.verticalScale).toBe(100);
    expect(style.caps).toBe('none');
    expect(style.script).toBe('none');
    expect(style.strikethrough).toBe(false);
  });

  it('fills an empty run for a paragraph that has none', () => {
    const m = deserializeModel('{"paragraphs":[{"align":"right","runs":[]}]}');
    expect(m!.paragraphs[0].runs).toHaveLength(1);
    expect(m!.paragraphs[0].runs[0].text).toBe('');
    expect(m!.paragraphs[0].align).toBe('right');
  });

  it('migrates pre-v2 lineHeight multipliers to explicit per-run leading', () => {
    const m = deserializeModel(
      '{"paragraphs":[{"lineHeight":1.5,"runs":[{"text":"a","style":{"size":40}},{"text":"b","style":{"size":20}}]}]}',
    );
    // Old semantics: line advance = lineHeight × largest run size.
    expect(m!.paragraphs[0].runs[0].style.leading).toBe(60);
    expect(m!.paragraphs[0].runs[1].style.leading).toBe(60);
  });

  it('migrates mixed-size paragraphs with the old previous-line advance', () => {
    // Old renderer: baseline gap = prev line box height − prev ascent + own ascent
    // (fallback metrics: ascent 0.8 × size). 72px headline → 12px caption:
    // 93.6 − 57.6 + 9.6 = 45.6, NOT the caption's own 1.3 × 12 = 15.6.
    const m = deserializeModel(
      '{"paragraphs":[' +
        '{"lineHeight":1.3,"runs":[{"text":"Headline","style":{"size":72}}]},' +
        '{"lineHeight":1.3,"runs":[{"text":"caption","style":{"size":12}}]}]}',
    );
    expect(m!.paragraphs[0].runs[0].style.leading).toBeCloseTo(93.6, 5);
    expect(m!.paragraphs[1].runs[0].style.leading).toBeCloseTo(45.6, 5);
  });

  it('accepts justify alignments and the v2 character fields', () => {
    const m = deserializeModel(
      '{"paragraphs":[{"align":"justify-all","spaceBefore":4,"runs":[{"text":"a","style":{"caps":"small","script":"super","horizontalScale":80,"baselineShift":3,"strikethrough":true,"leading":30}}]}]}',
    );
    expect(m!.paragraphs[0].align).toBe('justify-all');
    expect(m!.paragraphs[0].spaceBefore).toBe(4);
    const style = m!.paragraphs[0].runs[0].style;
    expect(style.caps).toBe('small');
    expect(style.script).toBe('super');
    expect(style.horizontalScale).toBe(80);
    expect(style.baselineShift).toBe(3);
    expect(style.strikethrough).toBe(true);
    expect(style.leading).toBe(30);
  });
});
