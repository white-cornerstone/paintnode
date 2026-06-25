import type { Tool, ToolHost, PointerInfo } from './Tool';

/**
 * Horizontal Type tool — click an empty spot to start new text, or click an existing text
 * layer to edit it. The actual editing happens in the on-canvas TextEditorOverlay.
 */
export class TextTool implements Tool {
  readonly id = 'text';
  readonly name = 'Type';
  readonly cursor = 'text';

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    this.host.beginText(Math.round(e.x), Math.round(e.y));
  }
  pointerMove(): void {}
  pointerUp(): void {}
}
