const LINE_DELTA_PX = 16;
const EDGE_EPSILON_PX = 0.5;

export interface ScrollMetrics {
  scrollLeft: number;
  scrollTop: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
}

export function wheelDeltaPixels(delta: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === 1) return delta * LINE_DELTA_PX;
  if (deltaMode === 2) return delta * pageSize;
  return delta;
}

export function canConsumeWheel(
  metrics: ScrollMetrics,
  deltaX: number,
  deltaY: number,
): boolean {
  return canScrollAxis(metrics.scrollLeft, metrics.scrollWidth - metrics.clientWidth, deltaX)
    || canScrollAxis(metrics.scrollTop, metrics.scrollHeight - metrics.clientHeight, deltaY);
}

function canScrollAxis(position: number, maximum: number, delta: number): boolean {
  if (maximum <= EDGE_EPSILON_PX || delta === 0) return false;
  if (delta < 0) return position > EDGE_EPSILON_PX;
  return position < maximum - EDGE_EPSILON_PX;
}
