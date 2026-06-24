import type { ToolHost } from './Tool';
import type { Rect } from '../types';
import { clampRect } from '../types';
import { intersectMask } from '../selection';
import { pixelCommand, snapshotLayer, snapshotRegion } from '../history';

/** Bake a full-document buffer onto a layer (selection-clipped) and push an undo entry. */
export function bakeBuffer(
  host: ToolHost,
  layerId: string,
  buffer: HTMLCanvasElement,
  label: string,
  op: GlobalCompositeOperation = 'source-over',
  opacity = 1,
  bbox: Rect | null = null,
): void {
  const layer = host.doc?.layers.find((l) => l.id === layerId);
  if (!layer) return;
  const region =
    (bbox && clampRect(bbox, layer.width, layer.height)) ||
    { x: 0, y: 0, w: layer.width, h: layer.height };
  const before = snapshotRegion(layer, region) ?? snapshotLayer(layer);
  const buf = host.selection ? intersectMask(buffer, host.selection.mask) : buffer;
  layer.ctx.save();
  layer.ctx.globalCompositeOperation = op;
  layer.ctx.globalAlpha = opacity;
  layer.ctx.drawImage(buf, 0, 0);
  layer.ctx.restore();
  layer.touch();
  const after = snapshotRegion(layer, region) ?? snapshotLayer(layer);
  host.history.push(pixelCommand(layer, before, after, label));
  host.bump();
}
