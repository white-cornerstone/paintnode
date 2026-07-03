import type { Tool, ToolHost, PointerInfo } from './Tool';

/** Move tool — translate the active layer without discarding off-canvas pixels. */
export class MoveTool implements Tool {
  readonly id = 'move';
  readonly name = 'Move';
  readonly cursor = 'move';

  private startX = 0;
  private startY = 0;
  private startLayerX = 0;
  private startLayerY = 0;
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
    if (layer.locked) {
      this.host.flash('Photoshop-only layer is locked; PaintNode preserves it for PSD export');
      return;
    }
    this.startX = e.x;
    this.startY = e.y;
    this.startLayerX = layer.x;
    this.startLayerY = layer.y;
    this.dx = 0;
    this.dy = 0;
    this.layerId = layer.id;
    this.moving = true;
  }

  pointerMove(e: PointerInfo): void {
    if (!this.moving) return;
    const layer = this.host.activeLayer;
    if (!layer) return;
    this.dx = Math.round(e.x - this.startX);
    this.dy = Math.round(e.y - this.startY);
    layer.x = this.startLayerX + this.dx;
    layer.y = this.startLayerY + this.dy;
    layer.touch();
    this.host.invalidate();
  }

  pointerUp(): void {
    if (!this.moving) return;
    this.moving = false;
    const layer = this.host.doc?.layers.find((l) => l.id === this.layerId) ?? null;
    if (layer && (this.dx !== 0 || this.dy !== 0)) {
      const before = { x: this.startLayerX, y: this.startLayerY };
      const after = { x: layer.x, y: layer.y };
      this.host.history.push({
        label: 'Move',
        undo: () => {
          layer.x = before.x;
          layer.y = before.y;
          layer.touch();
        },
        redo: () => {
          layer.x = after.x;
          layer.y = after.y;
          layer.touch();
        },
      });
    }
    this.host.bump();
    this.host.invalidate();
  }
}
