import type { Tool, ToolHost, PointerInfo } from './Tool';
import { pixelCommand, snapshotLayer } from '../history';
import { createCanvas, ctx2d } from '../types';

/** Move tool — translate the active layer's pixels. */
export class MoveTool implements Tool {
  readonly id = 'move';
  readonly name = 'Move';
  readonly cursor = 'move';

  private snap: HTMLCanvasElement | null = null;
  private startX = 0;
  private startY = 0;
  private dx = 0;
  private dy = 0;
  private layerId: string | null = null;
  private moving = false;

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    const layer = this.host.activeLayer;
    if (!layer) {
      this.host.flash('No active layer');
      return;
    }
    this.snap = createCanvas(layer.width, layer.height);
    ctx2d(this.snap).drawImage(layer.canvas, 0, 0);
    this.startX = e.x;
    this.startY = e.y;
    this.dx = 0;
    this.dy = 0;
    this.layerId = layer.id;
    this.moving = true;
  }

  pointerMove(e: PointerInfo): void {
    if (!this.moving || !this.snap) return;
    const layer = this.host.activeLayer;
    if (!layer) return;
    this.dx = Math.round(e.x - this.startX);
    this.dy = Math.round(e.y - this.startY);
    layer.ctx.clearRect(0, 0, layer.width, layer.height);
    layer.ctx.drawImage(this.snap, this.dx, this.dy);
    layer.touch();
    this.host.invalidate();
  }

  pointerUp(): void {
    if (!this.moving) return;
    this.moving = false;
    const layer = this.host.doc?.layers.find((l) => l.id === this.layerId) ?? null;
    if (layer && this.snap && (this.dx !== 0 || this.dy !== 0)) {
      const before = { x: 0, y: 0, data: ctx2d(this.snap).getImageData(0, 0, layer.width, layer.height) };
      const after = snapshotLayer(layer);
      this.host.history.push(pixelCommand(layer, before, after, 'Move'));
    }
    this.snap = null;
    this.host.bump();
    this.host.invalidate();
  }
}
