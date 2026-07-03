import type { Tool, ToolHost, PointerInfo } from './Tool';

export interface TextToolOptions {
  orientation: 'horizontal' | 'vertical';
  /** Type mask tools commit a text-shaped selection instead of a text layer. */
  mask: boolean;
}

/**
 * Type tools — click an empty spot to start new text, or click an existing text
 * layer to edit it (mask variants always start fresh). The actual editing happens
 * in the on-canvas TextEditorOverlay.
 */
export class TextTool implements Tool {
  readonly cursor = 'text';

  constructor(
    private host: ToolHost,
    readonly id: string = 'text',
    readonly name: string = 'Type',
    private options: TextToolOptions = { orientation: 'horizontal', mask: false },
  ) {}

  pointerDown(e: PointerInfo): void {
    this.host.beginText(Math.round(e.x), Math.round(e.y), this.options);
  }
  pointerMove(): void {}
  pointerUp(): void {}
}
