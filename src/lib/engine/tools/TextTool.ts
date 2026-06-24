import type { Tool, ToolHost, PointerInfo } from './Tool';

/** Type tool — click to choose where text goes; the UI then opens the text dialog. */
export class TextTool implements Tool {
  readonly id = 'text';
  readonly name = 'Type';
  readonly cursor = 'text';

  constructor(private host: ToolHost) {}

  pointerDown(e: PointerInfo): void {
    this.host.requestText(Math.round(e.x), Math.round(e.y));
  }
  pointerMove(): void {}
  pointerUp(): void {}
}
