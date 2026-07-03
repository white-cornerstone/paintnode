// Pure PSD-import logic (no DOM/canvas): structure walk, classification, and
// blend-mode mapping. The DOM-dependent decode lives in `load.ts`.

import type { BlendMode as PsdBlendMode, Layer as AgPsdLayer, Psd } from 'ag-psd';
import type { BlendMode } from '../engine/types';
import type { PsdLockReason } from '../engine/psdSource';

/** A leaf PSD layer with its group chain and effective visibility. */
export interface FlattenedPsdLayer {
  layer: AgPsdLayer;
  /** Original group chain, outermost first. */
  groupPath: AgPsdLayer[];
  /** Visibility including hidden ancestor groups. */
  visible: boolean;
}

/**
 * Flatten the PSD layer tree (bottom-first, matching PaintNode stack order)
 * into leaf layers. Group nodes are skipped but remembered per layer so the
 * tree can be rebuilt on save.
 */
export function flattenPsdTree(psd: Psd): FlattenedPsdLayer[] {
  const out: FlattenedPsdLayer[] = [];
  const walk = (children: AgPsdLayer[], path: AgPsdLayer[], parentVisible: boolean) => {
    for (const child of children) {
      if (child.children) {
        walk(child.children, [...path, child], parentVisible && !child.hidden);
      } else {
        out.push({ layer: child, groupPath: path, visible: parentVisible && !child.hidden });
      }
    }
  };
  walk(psd.children ?? [], [], true);
  return out;
}

/**
 * Classify a PSD layer: null means PaintNode can edit it (plain raster);
 * otherwise the reason it must stay locked so its Photoshop data survives.
 */
export function psdLockReason(layer: AgPsdLayer): PsdLockReason | null {
  if (layer.adjustment) return 'adjustment';
  if (layer.placedLayer) return 'smart-object';
  if (layer.text || layer.engineData) return 'text';
  if (layer.vectorFill || layer.vectorStroke || layer.vectorMask || layer.pathList?.length) {
    return 'vector';
  }
  if (layer.effects) return 'effects';
  if (layer.artboard) return 'artboard';
  return null;
}

const PSD_TO_BLEND: Record<string, BlendMode> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'hard light': 'hard-light',
  'soft light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
};

/** Closest canvas blend mode for Photoshop-only modes (preview approximation). */
const PSD_BLEND_APPROX: Record<string, BlendMode> = {
  dissolve: 'source-over',
  'pass through': 'source-over',
  'linear burn': 'multiply',
  'darker color': 'darken',
  'linear dodge': 'screen',
  'lighter color': 'lighten',
  'vivid light': 'hard-light',
  'linear light': 'hard-light',
  'pin light': 'hard-light',
  'hard mix': 'hard-light',
  subtract: 'difference',
  divide: 'source-over',
};

export interface MappedBlend {
  mode: BlendMode;
  /** True when PaintNode can only approximate the Photoshop blend result. */
  approximated: boolean;
}

/** Map a PSD blend mode onto a canvas blend mode, flagging approximations. */
export function psdToBlend(mode: PsdBlendMode | undefined): MappedBlend {
  const direct = PSD_TO_BLEND[mode ?? 'normal'];
  if (direct) return { mode: direct, approximated: false };
  return { mode: PSD_BLEND_APPROX[mode ?? ''] ?? 'source-over', approximated: true };
}

/** Human-readable summary of what the import had to lock or approximate. */
export function importNotices(flat: FlattenedPsdLayer[]): string[] {
  const notices: string[] = [];
  const locked = flat.filter((item) => psdLockReason(item.layer) !== null).length;
  if (locked > 0) {
    notices.push(
      `${locked} Photoshop-only layer${locked === 1 ? ' is' : 's are'} locked to protect them; they are preserved when exporting PSD`,
    );
  }
  const adjustments = flat.filter((item) => psdLockReason(item.layer) === 'adjustment').length;
  if (adjustments > 0) {
    notices.push(
      `${adjustments} adjustment/fill layer${adjustments === 1 ? '' : 's'} won't preview their effect in PaintNode`,
    );
  }
  const approximated = flat.filter((item) => psdToBlend(item.layer.blendMode).approximated).length;
  if (approximated > 0) {
    notices.push(`${approximated} layer${approximated === 1 ? ' uses' : 's use'} a blend mode PaintNode can only approximate`);
  }
  const clipped = flat.filter((item) => item.layer.clipping).length;
  if (clipped > 0) {
    notices.push(`${clipped} clipping-mask layer${clipped === 1 ? ' is' : 's are'} shown unclipped (clipping is preserved on export)`);
  }
  return notices;
}
