import {
  MIN_VISIBLE_VIEWPORT_CONTENT,
  clampViewportOffset,
  viewportOffsetBounds,
} from '../engine/viewportBounds';

export type WorkflowViewportItem = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkflowMapBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
};

type WorkflowPan = { panX: number; panY: number };

function contentBounds(items: WorkflowViewportItem[]): WorkflowMapBounds | null {
  if (items.length === 0) return null;
  const minX = Math.min(...items.map((item) => item.x));
  const minY = Math.min(...items.map((item) => item.y));
  const maxX = Math.max(...items.map((item) => item.x + item.width));
  const maxY = Math.max(...items.map((item) => item.y + item.height));
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

/**
 * Clamp a workflow graph like the image editor clamps its document: the graph
 * may move mostly off-screen, but a small recoverable strip remains visible.
 */
export function clampWorkflowPan(
  pan: WorkflowPan,
  items: WorkflowViewportItem[],
  viewWidth: number,
  viewHeight: number,
  zoom: number,
  minVisibleSize = MIN_VISIBLE_VIEWPORT_CONTENT,
): WorkflowPan & { rejectedX: number; rejectedY: number } {
  const bounds = contentBounds(items);
  if (!bounds) return { ...pan, rejectedX: 0, rejectedY: 0 };

  const scale = Math.max(0.001, zoom);
  const contentWidth = bounds.width * scale;
  const contentHeight = bounds.height * scale;
  const nextContentX = clampViewportOffset(
    pan.panX + bounds.minX * scale,
    viewWidth,
    contentWidth,
    minVisibleSize,
  );
  const nextContentY = clampViewportOffset(
    pan.panY + bounds.minY * scale,
    viewHeight,
    contentHeight,
    minVisibleSize,
  );
  const panX = nextContentX - bounds.minX * scale;
  const panY = nextContentY - bounds.minY * scale;
  return {
    panX,
    panY,
    rejectedX: pan.panX - panX,
    rejectedY: pan.panY - panY,
  };
}

/**
 * Build a stable minimap domain from every permitted viewport position rather
 * than from the current pan. This keeps minimap dragging linear at the edges.
 */
export function workflowMapBounds(
  items: WorkflowViewportItem[],
  viewWidth: number,
  viewHeight: number,
  zoom: number,
  padding = 0,
): WorkflowMapBounds | null {
  const content = contentBounds(items);
  if (!content) return null;

  const scale = Math.max(0.001, zoom);
  const viewportWidth = Math.max(1, viewWidth) / scale;
  const viewportHeight = Math.max(1, viewHeight) / scale;
  const xOffsets = viewportOffsetBounds(viewWidth, content.width * scale);
  const yOffsets = viewportOffsetBounds(viewHeight, content.height * scale);
  const viewportLefts = [
    content.minX - xOffsets.min / scale,
    content.minX - xOffsets.max / scale,
  ];
  const viewportTops = [
    content.minY - yOffsets.min / scale,
    content.minY - yOffsets.max / scale,
  ];
  const minX = Math.min(content.minX, ...viewportLefts) - padding;
  const minY = Math.min(content.minY, ...viewportTops) - padding;
  const maxX = Math.max(content.maxX, ...viewportLefts.map((left) => left + viewportWidth)) + padding;
  const maxY = Math.max(content.maxY, ...viewportTops.map((top) => top + viewportHeight)) + padding;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}
