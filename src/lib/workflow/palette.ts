import { CREATOR_NODE_DEFINITIONS, type CreatorNodeDefinition } from './registry';
import type { WorkflowPoint, WorkflowSize } from './schema';

export type CreatorPaletteNavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | string;

export interface CreatorPaletteOccupiedRect extends WorkflowPoint, WorkflowSize {}
export interface CreatorPalettePlacementBounds extends CreatorPaletteOccupiedRect {
  padding?: number;
}

function rectsOverlap(left: CreatorPaletteOccupiedRect, right: CreatorPaletteOccupiedRect, gap: number): boolean {
  return left.x < right.x + right.width + gap
    && left.x + left.width + gap > right.x
    && left.y < right.y + right.height + gap
    && left.y + left.height + gap > right.y;
}

export function findOpenCreatorNodePlacement(
  preferred: WorkflowPoint,
  size: WorkflowSize,
  occupied: readonly CreatorPaletteOccupiedRect[],
  gap = 20,
  bounds?: CreatorPalettePlacementBounds,
): WorkflowPoint {
  const origin = { x: Math.round(preferred.x), y: Math.round(preferred.y) };
  const isOpen = (position: WorkflowPoint) => !occupied.some((rect) => rectsOverlap({ ...position, ...size }, rect, gap));
  if (bounds) {
    const padding = bounds.padding ?? 12;
    const candidates: WorkflowPoint[] = [];
    const maxX = bounds.x + bounds.width - padding - size.width;
    const maxY = bounds.y + bounds.height - padding - size.height;
    for (let y = bounds.y + padding; y <= maxY; y += size.height + gap) {
      for (let x = bounds.x + padding; x <= maxX; x += size.width + gap) {
        candidates.push({ x: Math.round(x), y: Math.round(y) });
      }
    }
    candidates.sort((left, right) => (
      Math.hypot(left.x - origin.x, left.y - origin.y) - Math.hypot(right.x - origin.x, right.y - origin.y)
      || left.y - right.y
      || left.x - right.x
    ));
    const visible = candidates.find(isOpen);
    if (visible) return visible;
  }
  if (isOpen(origin)) return origin;

  const stepX = size.width + gap;
  const stepY = size.height + gap;
  for (let ring = 1; ring <= 100; ring += 1) {
    for (let row = -ring; row <= ring; row += 1) {
      for (let column = -ring; column <= ring; column += 1) {
        if (Math.abs(row) !== ring && Math.abs(column) !== ring) continue;
        const candidate = { x: origin.x + column * stepX, y: origin.y + row * stepY };
        if (isOpen(candidate)) return candidate;
      }
    }
  }
  return { x: origin.x, y: origin.y + (occupied.length + 1) * stepY };
}

export function filterCreatorNodeDefinitions(query: string): CreatorNodeDefinition[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...CREATOR_NODE_DEFINITIONS];
  return CREATOR_NODE_DEFINITIONS.filter((definition) => {
    const material = [
      definition.label,
      definition.description,
      definition.category,
      ...definition.keywords,
    ].join(' ').toLocaleLowerCase();
    return tokens.every((token) => material.includes(token));
  });
}

export function paletteIndexAfterKey(
  currentIndex: number,
  key: CreatorPaletteNavigationKey,
  itemCount: number,
): number {
  if (itemCount <= 0) return -1;
  if (key === 'Home') return 0;
  if (key === 'End') return itemCount - 1;
  if (key === 'ArrowDown') return currentIndex < 0 || currentIndex >= itemCount - 1 ? 0 : currentIndex + 1;
  if (key === 'ArrowUp') return currentIndex <= 0 ? itemCount - 1 : currentIndex - 1;
  return Math.min(Math.max(currentIndex, 0), itemCount - 1);
}
