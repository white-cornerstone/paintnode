import {
  AI_RETOUCH_TOOL_NAMES,
  combineRetouchMask,
  maskBounds,
  maskContainsPoint,
  makeRectMask,
  makeStrokeMask,
  type AiRetouchPoint,
  type AiRetouchToolId,
  offsetRect,
  referenceRect,
} from '../aiRetouch';
import { lassoSelection, selectionModeFromModifiers, type SelectionMode } from '../selection';
import { clamp, clampRect, type Rect } from '../types';
import type { PointerInfo, Tool, ToolHost } from './Tool';

const MIN_LASSO_POINTS = 3;

function rectFromPoints(a: AiRetouchPoint, b: AiRetouchPoint, minSize = 1): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(minSize, Math.abs(a.x - b.x)),
    h: Math.max(minSize, Math.abs(a.y - b.y)),
  };
}

function closeEnoughToLoop(points: AiRetouchPoint[], brushSize: number): boolean {
  if (points.length < MIN_LASSO_POINTS) return false;
  const first = points[0];
  const last = points[points.length - 1];
  return Math.hypot(first.x - last.x, first.y - last.y) <= Math.max(8, brushSize);
}

export class AiRetouchTool implements Tool {
  readonly name: string;
  readonly cursor = 'crosshair';
  readonly editsPixels = false;

  private points: AiRetouchPoint[] = [];
  private start: AiRetouchPoint | null = null;
  private draggingExistingMask: { bounds: Rect } | null = null;
  private mode: SelectionMode = 'new';

  constructor(
    private host: ToolHost,
    readonly id: AiRetouchToolId,
  ) {
    this.name = AI_RETOUCH_TOOL_NAMES[id];
  }

  get usesBrushCursor(): boolean {
    return this.id === 'spot-healing' || this.id === 'remove' || this.id === 'healing-brush';
  }

  pointerDown(e: PointerInfo): void {
    const doc = this.host.doc;
    if (!doc) return;
    const p = { x: clamp(e.x, 0, doc.width), y: clamp(e.y, 0, doc.height) };

    if (this.id === 'healing-brush' && e.altKey) {
      this.host.setAiRetouchHealingSource(p);
      this.host.flash('Healing source set');
      return;
    }

    this.start = p;
    this.points = [p];
    this.draggingExistingMask = null;
    this.mode = selectionModeFromModifiers(this.host.selectionMode, e);

    const active = this.host.activeLayer;
    if (
      (this.id === 'patch' || this.id === 'content-aware-move') &&
      active?.kind === 'ai-retouch-mask' &&
      active.aiRetouch?.toolId === this.id &&
      maskContainsPoint(active.canvas, p.x, p.y)
    ) {
      const bounds = maskBounds(active.canvas);
      if (bounds) {
        this.draggingExistingMask = { bounds };
      }
    }
    this.updatePreview(p);
  }

  pointerMove(e: PointerInfo): void {
    if (!this.start || !this.host.doc) return;
    const doc = this.host.doc;
    const p = { x: clamp(e.x, 0, doc.width), y: clamp(e.y, 0, doc.height) };
    this.points.push(p);
    this.updatePreview(p);
  }

  pointerUp(e: PointerInfo): void {
    const doc = this.host.doc;
    const start = this.start;
    if (!doc || !start) {
      this.reset();
      return;
    }
    const end = { x: clamp(e.x, 0, doc.width), y: clamp(e.y, 0, doc.height) };
    if (this.points.length === 1 || Math.hypot(end.x - this.points.at(-1)!.x, end.y - this.points.at(-1)!.y) > 0.01) {
      this.points.push(end);
    }

    if (this.id === 'patch') this.finishPatch(start, end, doc.width, doc.height);
    else if (this.id === 'content-aware-move') this.finishMove(start, end, doc.width, doc.height);
    else if (this.id === 'red-eye') this.finishRedEye(start, end, doc.width, doc.height);
    else this.finishBrush(doc.width, doc.height);

    this.reset();
  }

  private updatePreview(current: AiRetouchPoint): void {
    const doc = this.host.doc;
    const start = this.start;
    if (!doc || !start) return;

    let mask: HTMLCanvasElement | null = null;
    if (this.id === 'spot-healing' || this.id === 'remove' || this.id === 'healing-brush') {
      mask = this.buildBrushMask(doc.width, doc.height);
    } else if (this.id === 'red-eye') {
      mask = this.buildRedEyeMask(start, current, doc.width, doc.height);
    } else if (this.draggingExistingMask && (this.id === 'patch' || this.id === 'content-aware-move')) {
      const source = clampRect(this.draggingExistingMask.bounds, doc.width, doc.height);
      if (source) {
        const destination = offsetRect(source, current.x - start.x, current.y - start.y, doc.width, doc.height);
        const destinationMask = makeRectMask(doc.width, doc.height, destination);
        if (this.id === 'content-aware-move' && destinationMask) {
          mask = combineRetouchMask(this.host.activeLayer?.canvas ?? null, destinationMask, 'add', doc.width, doc.height);
        } else {
          mask = destinationMask;
        }
      }
    } else if (this.id === 'patch' || this.id === 'content-aware-move') {
      const selection = this.points.length >= MIN_LASSO_POINTS ? lassoSelection(this.points, doc.width, doc.height) : null;
      mask = selection?.mask ?? null;
    }

    const active = this.host.activeLayer;
    const combined =
      mask && active?.kind === 'ai-retouch-mask' && !this.draggingExistingMask
        ? combineRetouchMask(active.canvas, mask, this.mode, doc.width, doc.height)
        : mask;
    this.host.setAiRetouchPreview(combined ? { mask: combined } : null);
  }

  private buildBrushMask(docW: number, docH: number): HTMLCanvasElement | null {
    return makeStrokeMask(docW, docH, {
      kind: 'brush',
      points: this.points,
      size: Math.max(1, this.host.brushSize),
      hardness: this.host.brushHardness,
      closedLoop: this.id === 'remove' && closeEnoughToLoop(this.points, Math.max(1, this.host.brushSize)),
    });
  }

  private buildRedEyeMask(start: AiRetouchPoint, end: AiRetouchPoint, docW: number, docH: number): HTMLCanvasElement | null {
    const minSize = Math.max(4, this.host.brushSize);
    const raw = rectFromPoints(start, end, minSize);
    if (raw.w <= minSize && raw.h <= minSize) {
      raw.x = start.x - minSize / 2;
      raw.y = start.y - minSize / 2;
      raw.w = minSize;
      raw.h = minSize;
    }
    const bounds = clampRect(raw, docW, docH);
    return bounds ? makeRectMask(docW, docH, bounds, 'ellipse') : null;
  }

  private finishBrush(docW: number, docH: number): void {
    const size = Math.max(1, this.host.brushSize);
    const gesture = {
      kind: 'brush',
      points: this.points.slice(),
      size,
      hardness: this.host.brushHardness,
      closedLoop: this.id === 'remove' && closeEnoughToLoop(this.points, size),
      reference: this.host.aiRetouchHealingSource ? referenceRect(this.host.aiRetouchHealingSource, size * 4, docW, docH) : null,
    } as const;
    const mask = this.buildBrushMask(docW, docH);
    if (mask) this.host.commitAiRetouchMaskGesture(this.id, gesture, mask, this.mode);
  }

  private finishPatch(start: AiRetouchPoint, end: AiRetouchPoint, docW: number, docH: number): void {
    const existing = this.draggingExistingMask;
    if (!existing) {
      this.finishMaskDraft(docW, docH, 'Patch mask selected; drag inside it to choose a sample area');
      return;
    }
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (Math.hypot(dx, dy) < 1) {
      this.host.flash('Drag the patch mask to a sample area');
      this.host.setAiRetouchPreview(null);
      return;
    }
    const target = clampRect(existing.bounds, docW, docH);
    if (!target) return;
    const reference = offsetRect(target, dx, dy, docW, docH);
    this.host.setAiRetouchMaskReference('patch', {
      patchMode: this.host.aiRetouchPatchMode,
      referenceRect: reference,
    });
    this.host.setAiRetouchPreview(null);
  }

  private finishMove(start: AiRetouchPoint, end: AiRetouchPoint, docW: number, docH: number): void {
    const existing = this.draggingExistingMask;
    if (!existing) {
      this.finishMaskDraft(docW, docH, 'Move mask selected; drag inside it to place the subject');
      return;
    }
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    if (Math.hypot(dx, dy) < 1) {
      this.host.flash('Drag the masked subject to a destination');
      this.host.setAiRetouchPreview(null);
      return;
    }
    const source = clampRect(existing.bounds, docW, docH);
    if (!source) return;
    this.host.setAiRetouchMaskReference('content-aware-move', {
      moveMode: this.host.aiRetouchMoveMode,
      destinationRect: offsetRect(source, dx, dy, docW, docH),
    });
    this.host.setAiRetouchPreview(null);
  }

  private finishMaskDraft(docW: number, docH: number, message: string): void {
    const selection = this.points.length >= MIN_LASSO_POINTS ? lassoSelection(this.points, docW, docH) : null;
    if (!selection) {
      this.host.flash('Draw a mask first');
      this.host.setAiRetouchPreview(null);
      return;
    }
    const bounds = selection.bounds;
    const gesture =
      this.id === 'patch'
        ? ({
            kind: 'patch',
            mode: this.host.aiRetouchPatchMode,
            target: bounds,
            reference: bounds,
          } as const)
        : ({
            kind: 'move',
            mode: this.host.aiRetouchMoveMode,
            source: bounds,
            destination: bounds,
          } as const);
    this.host.commitAiRetouchMaskGesture(this.id, gesture, selection.mask, this.mode);
    this.host.flash(message);
  }

  private finishRedEye(start: AiRetouchPoint, end: AiRetouchPoint, docW: number, docH: number): void {
    const minSize = Math.max(4, this.host.brushSize);
    const raw = rectFromPoints(start, end, minSize);
    if (raw.w <= minSize && raw.h <= minSize) {
      raw.x = start.x - minSize / 2;
      raw.y = start.y - minSize / 2;
      raw.w = minSize;
      raw.h = minSize;
    }
    const bounds = clampRect(raw, docW, docH);
    if (!bounds) return;
    const mask = makeRectMask(docW, docH, bounds, 'ellipse');
    if (!mask) return;
    this.host.commitAiRetouchMaskGesture('red-eye', {
      kind: 'red-eye',
      bounds,
      pupilSize: this.host.aiRetouchPupilSize,
      darkenAmount: this.host.aiRetouchDarkenAmount,
    }, mask, this.mode);
  }

  private reset(): void {
    this.points = [];
    this.start = null;
    this.draggingExistingMask = null;
  }
}
