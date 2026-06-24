import type { Layer } from './Layer.svelte';
import type { Rect } from './types';
import { clampRect } from './types';

export interface Command {
  label: string;
  undo(): void;
  redo(): void;
}

export interface RegionSnapshot {
  x: number;
  y: number;
  data: ImageData;
}

/** Capture the pixels of `rect` (clamped to the layer) for later restore. */
export function snapshotRegion(layer: Layer, rect: Rect): RegionSnapshot | null {
  const r = clampRect(rect, layer.width, layer.height);
  if (!r) return null;
  return { x: r.x, y: r.y, data: layer.ctx.getImageData(r.x, r.y, r.w, r.h) };
}

export function snapshotLayer(layer: Layer): RegionSnapshot {
  return { x: 0, y: 0, data: layer.ctx.getImageData(0, 0, layer.width, layer.height) };
}

/** A reversible pixel edit on a single layer, stored as before/after region snapshots. */
export function pixelCommand(
  layer: Layer,
  before: RegionSnapshot,
  after: RegionSnapshot,
  label: string,
): Command {
  return {
    label,
    undo() {
      layer.ctx.putImageData(before.data, before.x, before.y);
      layer.touch();
    },
    redo() {
      layer.ctx.putImageData(after.data, after.x, after.y);
      layer.touch();
    },
  };
}

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  limit: number;
  onChange?: () => void;

  constructor(limit = 40) {
    this.limit = limit;
  }

  push(cmd: Command): void {
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
    this.onChange?.();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get undoLabel(): string {
    return this.undoStack.at(-1)?.label ?? '';
  }
  get redoLabel(): string {
    return this.redoStack.at(-1)?.label ?? '';
  }

  undo(): void {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.onChange?.();
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.redo();
    this.undoStack.push(cmd);
    this.onChange?.();
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.onChange?.();
  }
}
