export type OffsetBounds = {
  min: number;
  max: number;
};

export const MIN_VISIBLE_VIEWPORT_CONTENT = 96;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function viewportOffsetBounds(
  viewSize: number,
  contentSize: number,
  minVisibleSize = MIN_VISIBLE_VIEWPORT_CONTENT,
): OffsetBounds {
  const view = Math.max(1, viewSize);
  const content = Math.max(1, contentSize);
  const visible = Math.min(view, content, Math.max(1, minVisibleSize));
  return { min: visible - content, max: view - visible };
}

export function clampViewportOffset(
  offset: number,
  viewSize: number,
  contentSize: number,
  minVisibleSize = MIN_VISIBLE_VIEWPORT_CONTENT,
): number {
  const bounds = viewportOffsetBounds(viewSize, contentSize, minVisibleSize);
  return clamp(offset, bounds.min, bounds.max);
}
