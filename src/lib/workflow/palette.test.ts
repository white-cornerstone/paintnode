import { describe, expect, it } from 'vitest';
import { creatorNodeDefinition } from './registry';
import {
  creatorNodeFitsPlacementBounds,
  filterCreatorNodeDefinitions,
  findOpenCreatorNodePlacement,
  paletteIndexAfterKey,
} from './palette';

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

  it('keeps six mixed-size keyboard additions collision-free and navigable on the real constrained board', () => {
    const definitions = ['input', 'brief', 'art-direction', 'transform', 'review', 'output']
      .map((type) => creatorNodeDefinition(type as Parameters<typeof creatorNodeDefinition>[0]));
    let viewport = { x: 0, y: 0, width: 552, height: 500, padding: 12 };
    const occupied: Array<{ x: number; y: number; width: number; height: number }> = [
      { x: 480, y: 70, width: 340, height: 408 },
      { x: 895, y: 96, width: 210, height: 232 },
    ];
    const added: typeof occupied = [];

    for (const definition of definitions) {
      const preferred = {
        x: viewport.x + viewport.width / 2 - definition.defaultSize.width / 2,
        y: viewport.y + viewport.height / 2 - definition.defaultSize.height / 2,
      };
      const position = findOpenCreatorNodePlacement(preferred, definition.defaultSize, occupied, 20, viewport);
      const rect = { ...position, ...definition.defaultSize };
      expect(occupied.some((other) => (
        rect.x < other.x + other.width
        && rect.x + rect.width > other.x
        && rect.y < other.y + other.height
        && rect.y + rect.height > other.y
      ))).toBe(false);
      occupied.push(rect);
      added.push(rect);

      if (!creatorNodeFitsPlacementBounds(position, definition.defaultSize, viewport)) {
        viewport = {
          ...viewport,
          x: position.x + definition.defaultSize.width / 2 - viewport.width / 2,
          y: position.y + definition.defaultSize.height / 2 - viewport.height / 2,
        };
      }
      expect(creatorNodeFitsPlacementBounds(position, definition.defaultSize, viewport)).toBe(true);
    }

    expect(new Set(added.map(({ x, y }) => `${x}:${y}`))).toHaveLength(6);
  });
});
