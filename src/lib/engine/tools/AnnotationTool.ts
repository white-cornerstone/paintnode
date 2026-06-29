import type { Tool, ToolHost, PointerInfo } from './Tool';

/**
 * Annotation placement is handled by the HTML overlay in CanvasView/WorkflowBoard.
 * Keep this registered tool pixel-safe so annotations never silently become bitmap marks.
 */
export class AnnotationTool implements Tool {
  readonly id = 'annotation';
  readonly name = 'Annotation';
  readonly cursor = 'crosshair';
  readonly editsPixels = false;

  constructor(_host: ToolHost) {}

  pointerDown(_e: PointerInfo): void {}
  pointerMove(_e: PointerInfo): void {}
  pointerUp(_e: PointerInfo): void {}
}
