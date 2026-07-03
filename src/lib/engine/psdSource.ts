// Photoshop (.psd) passthrough state attached to imported documents/layers.
// Plain TS + type-only ag-psd imports, so the engine stays framework-agnostic.

import type { Layer as AgPsdLayer, Psd } from 'ag-psd';
import type { BlendMode } from './types';

/** Why an imported PSD layer is locked (not editable) in PaintNode. */
export type PsdLockReason =
  | 'adjustment'
  | 'smart-object'
  | 'text'
  | 'vector'
  | 'effects'
  | 'artboard';

export const PSD_LOCK_LABELS: Record<PsdLockReason, string> = {
  adjustment: 'Adjustment or fill layer',
  'smart-object': 'Smart object',
  text: 'Photoshop text layer',
  vector: 'Vector or shape layer',
  effects: 'Layer with effects',
  artboard: 'Artboard',
};

/**
 * Per-layer Photoshop passthrough attached to layers imported from a PSD.
 * `layer` is the original parsed ag-psd layer, holding the original compressed
 * channel data (`rawData`) — treat it as immutable. When the PaintNode layer is
 * untouched at save time, this object is written back so Photoshop-only data
 * (smart objects, adjustments, text, vectors, effects) survives the round trip.
 */
export interface PsdLayerSource {
  layer: AgPsdLayer;
  /** Original group chain, outermost first (original ag-psd group objects). */
  groupPath: AgPsdLayer[];
  /** Why the layer is locked in PaintNode, or null when it is editable. */
  lockReason: PsdLockReason | null;
  /** Layer is clipped to the layer below it in Photoshop. */
  clipping: boolean;
  /** True when the PSD blend mode has no canvas equivalent (preview approximated). */
  blendApproximated: boolean;
  /** Import-time snapshot used to detect edits at save time. */
  imported: { x: number; y: number; pixelRev: number; blendMode: BlendMode };
}

/**
 * A PSD layer mask imported for compositing. The mask itself is not editable in
 * PaintNode; it is preserved and written back on PSD export.
 */
export interface PsdLayerMaskState {
  /** Alpha-coverage canvas (white pixels, alpha = mask value) for compositing. */
  canvas: HTMLCanvasElement;
  /** Document-space position of the mask bitmap. */
  x: number;
  y: number;
  /** Mask value (0-255) outside the mask bitmap bounds (255 = reveal). */
  defaultColor: number;
  disabled: boolean;
}

/** Document-level passthrough: the original parsed Psd plus import notices. */
export interface PsdDocumentSource {
  psd: Psd;
  notices: string[];
}
