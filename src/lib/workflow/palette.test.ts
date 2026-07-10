import { describe, expect, it } from 'vitest';
import { filterCreatorNodeDefinitions, findOpenCreatorNodePlacement, paletteIndexAfterKey } from './palette';

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

  it('places repeated keyboard additions deterministically without stacking or overlap', () => {
    const size = { width: 240, height: 190 };
    const occupied: Array<{ x: number; y: number; width: number; height: number }> = [];
    const placements = Array.from({ length: 8 }, () => {
      const position = findOpenCreatorNodePlacement({ x: 160, y: 120 }, size, occupied);
      occupied.push({ ...position, ...size });
      return position;
    });
    expect(new Set(placements.map(({ x, y }) => `${x}:${y}`))).toHaveLength(placements.length);
    for (const [index, left] of occupied.entries()) {
      for (const right of occupied.slice(index + 1)) {
        expect(
          left.x < right.x + right.width
          && left.x + left.width > right.x
          && left.y < right.y + right.height
          && left.y + left.height > right.y,
        ).toBe(false);
      }
    }
    expect(findOpenCreatorNodePlacement({ x: 160, y: 120 }, size, [])).toEqual(placements[0]);
  });

  it('keeps a six-node keyboard-add sequence usable inside an 800x560 viewport', () => {
    const size = { width: 240, height: 190 };
    const bounds = { x: 0, y: 0, width: 800, height: 560, padding: 10 };
    const occupied: Array<{ x: number; y: number; width: number; height: number }> = [];
    for (let index = 0; index < 6; index += 1) {
      const position = findOpenCreatorNodePlacement({ x: 280, y: 170 }, size, occupied, 20, bounds);
      occupied.push({ ...position, ...size });
    }
    expect(occupied).toHaveLength(6);
    expect(occupied.every((rect) => (
      rect.x >= bounds.x + bounds.padding
      && rect.y >= bounds.y + bounds.padding
      && rect.x + rect.width <= bounds.x + bounds.width - bounds.padding
      && rect.y + rect.height <= bounds.y + bounds.height - bounds.padding
    ))).toBe(true);
  });
});
