import type { Tool, ToolHost, PointerInfo } from './Tool';

/** Hand tool — pan the viewport by dragging. */
export class HandTool implements Tool {
  readonly id = 'hand';
  readonly name = 'Hand';
  readonly cursor = 'grab';
  private panning = false;

  constructor(private host: ToolHost) {}

  pointerDown(): void {
    this.panning = true;
  }
  pointerMove(e: PointerInfo): void {
    if (!this.panning) return;
    this.host.viewport?.panBy(e.dxCss, e.dyCss);
  }
  pointerUp(): void {
    this.panning = false;
  }
}

/** Zoom tool — click to zoom in, Alt-click to zoom out, toward the cursor. */
export class ZoomTool implements Tool {
  readonly id = 'zoom';
  readonly name = 'Zoom';
  readonly cursor = 'zoom-in';

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    // Alt momentarily inverts the current zoom mode.
    const out = e.altKey ? this.host.zoomMode === 'in' : this.host.zoomMode === 'out';
    const factor = out ? 1 / 1.6 : 1.6;
    this.host.viewport?.zoomBy(factor, e.cssX, e.cssY);
  }
  pointerMove(): void {}
  pointerUp(): void {}
}
