const LINE_DELTA_PX = 16;
const PAGE_DELTA_PX = 800;
const MAX_DELTA_PX = 80;
const PINCH_ZOOM_SENSITIVITY = 0.0012;

export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const pixelDelta = deltaY * deltaModeMultiplier(deltaMode);
  const clamped = Math.min(MAX_DELTA_PX, Math.max(-MAX_DELTA_PX, pixelDelta));
  return Math.exp(-clamped * PINCH_ZOOM_SENSITIVITY);
}

function deltaModeMultiplier(deltaMode: number): number {
  if (deltaMode === 1) return LINE_DELTA_PX;
  if (deltaMode === 2) return PAGE_DELTA_PX;
  return 1;
}
