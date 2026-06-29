import { Layer } from './Layer.svelte';
import { uid } from './types';
import { coerceAnnotations, type AnnotationItem } from './annotations';

/**
 * A document: an ordered stack of layers (index 0 = bottom of the stack) plus the
 * active-layer selection. Reactive so panels re-render on structural changes.
 */
export class PaintDocument {
  readonly id: string;
  name = $state('Untitled');
  width = $state(1);
  height = $state(1);
  layers = $state<Layer[]>([]);
  activeLayerId = $state<string | null>(null);
  annotations = $state<AnnotationItem[]>([]);
  annotationsVisible = $state(true);

  constructor(width: number, height: number, name = 'Untitled', id?: string) {
    this.id = id ?? uid('doc');
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.name = name;
  }

  /** A blank document with one empty layer. */
  static blank(width: number, height: number, name = 'Untitled'): PaintDocument {
    const doc = new PaintDocument(width, height, name);
    const layer = new Layer(width, height, 'Layer 1');
    doc.layers = [layer];
    doc.activeLayerId = layer.id;
    return doc;
  }

  get activeLayer(): Layer | null {
    return this.layers.find((l) => l.id === this.activeLayerId) ?? null;
  }

  indexOf(id: string): number {
    return this.layers.findIndex((l) => l.id === id);
  }

  setActive(id: string): void {
    if (this.indexOf(id) >= 0) this.activeLayerId = id;
  }

  newLayer(name?: string): Layer {
    const n = name ?? `Layer ${this.layers.length + 1}`;
    const layer = new Layer(this.width, this.height, n);
    return this.insertAboveActive(layer);
  }

  insertAboveActive(layer: Layer): Layer {
    const idx = this.activeLayerId ? this.indexOf(this.activeLayerId) : this.layers.length - 1;
    const at = idx < 0 ? this.layers.length : idx + 1;
    const next = this.layers.slice();
    next.splice(at, 0, layer);
    this.layers = next;
    this.activeLayerId = layer.id;
    return layer;
  }

  /** Add an already-built layer on top of the stack. */
  push(layer: Layer): Layer {
    this.layers = [...this.layers, layer];
    this.activeLayerId = layer.id;
    return layer;
  }

  remove(id: string): void {
    const idx = this.indexOf(id);
    if (idx < 0) return;
    const next = this.layers.slice();
    next.splice(idx, 1);
    this.layers = next;
    if (this.activeLayerId === id) {
      const fallback = next[Math.min(idx, next.length - 1)];
      this.activeLayerId = fallback ? fallback.id : null;
    }
  }

  duplicate(id: string): Layer | null {
    const idx = this.indexOf(id);
    if (idx < 0) return null;
    const copy = this.layers[idx].clone();
    const next = this.layers.slice();
    next.splice(idx + 1, 0, copy);
    this.layers = next;
    this.activeLayerId = copy.id;
    return copy;
  }

  /** Move a layer by delta in stack order (+1 = up/toward top). */
  move(id: string, delta: number): void {
    const idx = this.indexOf(id);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= this.layers.length) return;
    const next = this.layers.slice();
    const [item] = next.splice(idx, 1);
    next.splice(target, 0, item);
    this.layers = next;
  }

  /** Reorder by absolute indices (used by drag-and-drop). */
  reorder(from: number, to: number): void {
    if (from === to || from < 0 || from >= this.layers.length) return;
    const next = this.layers.slice();
    const [item] = next.splice(from, 1);
    next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
    this.layers = next;
  }

  clone(): PaintDocument {
    const copy = new PaintDocument(this.width, this.height, this.name, uid('doc'));
    copy.layers = this.layers.map((l) => l.clone(l.name));
    copy.activeLayerId = copy.layers[copy.layers.length - 1]?.id ?? null;
    copy.annotations = coerceAnnotations(this.annotations);
    copy.annotationsVisible = this.annotationsVisible;
    return copy;
  }
}
