import { describe, expect, it } from 'vitest';
import { filterCreatorNodeDefinitions, paletteIndexAfterKey } from './palette';

describe('creator node palette model', () => {
  it('searches creator language and never exposes providers as node types', () => {
    expect(filterCreatorNodeDefinitions('visual reference').map((item) => item.type)).toEqual(['input']);
    expect(filterCreatorNodeDefinitions('campaign direction').map((item) => item.type)).toEqual(['brief', 'art-direction']);
    expect(filterCreatorNodeDefinitions('compare candidates').map((item) => item.type)).toEqual(['review']);
    expect(filterCreatorNodeDefinitions('codex antigravity claude')).toEqual([]);
    expect(filterCreatorNodeDefinitions('').map((item) => item.type)).toEqual([
      'input', 'brief', 'art-direction', 'transform', 'review', 'output',
    ]);
  });

  it('supports wrapping arrows plus Home and End for aria-activedescendant navigation', () => {
    expect(paletteIndexAfterKey(-1, 'ArrowDown', 6)).toBe(0);
    expect(paletteIndexAfterKey(5, 'ArrowDown', 6)).toBe(0);
    expect(paletteIndexAfterKey(0, 'ArrowUp', 6)).toBe(5);
    expect(paletteIndexAfterKey(3, 'Home', 6)).toBe(0);
    expect(paletteIndexAfterKey(2, 'End', 6)).toBe(5);
    expect(paletteIndexAfterKey(2, 'Enter', 6)).toBe(2);
    expect(paletteIndexAfterKey(2, 'ArrowDown', 0)).toBe(-1);
  });
});
