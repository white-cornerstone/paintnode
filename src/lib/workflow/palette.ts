import { CREATOR_NODE_DEFINITIONS, type CreatorNodeDefinition } from './registry';

export type CreatorPaletteNavigationKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | string;

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
