// Pure PSD-import logic (no DOM/canvas): structure walk, classification,
// blend-mode mapping, and text-layer conversion. The DOM-dependent decode
// lives in `load.ts`.

import type {
  BlendMode as PsdBlendMode,
  Layer as AgPsdLayer,
  LayerTextData,
  ParagraphStyle as PsdParagraphStyle,
  Psd,
  TextStyle as PsdTextStyle,
} from 'ag-psd';
import type { BlendMode, RGB } from '../engine/types';
import type { PsdLockReason } from '../engine/psdSource';
import {
  defaultParagraph,
  defaultStyle,
  type TextAlign,
  type TextAntiAlias,
  type TextModel,
  type TextParagraph,
  type TextStyle,
} from '../engine/text/model';

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

// --- PSD text → editable TextModel ---

/** Reasons a PSD text layer must stay locked instead of becoming editable. */
export function psdTextBlockers(text: LayerTextData): string[] {
  const blockers: string[] = [];
  if (text.orientation === 'vertical') blockers.push('vertical orientation');
  if (text.shapeType === 'box') blockers.push('area (box) text');
  if (text.warp && text.warp.style && text.warp.style !== 'none') blockers.push('warped text');
  if (text.textPath) blockers.push('text on a path');
  const t = text.transform;
  if (t && (Math.abs(t[0] - 1) > 0.001 || Math.abs(t[1]) > 0.001 || Math.abs(t[2]) > 0.001 || Math.abs(t[3] - 1) > 0.001)) {
    blockers.push('rotated or scaled text');
  }
  const styles = [text.style, ...(text.styleRuns ?? []).map((r) => r.style)];
  if (styles.some((s) => s?.strokeFlag)) blockers.push('stroked text');
  return blockers;
}

/** Known PostScript name → CSS family mappings (reverse of psdFontName in save.ts). */
const PSD_FONT_FAMILIES: Record<string, { family: string; bold?: boolean; italic?: boolean }> = {
  ArialMT: { family: 'Arial' },
  'Arial-BoldMT': { family: 'Arial', bold: true },
  'Arial-ItalicMT': { family: 'Arial', italic: true },
  'Arial-BoldItalicMT': { family: 'Arial', bold: true, italic: true },
  TimesNewRomanPSMT: { family: 'Times New Roman' },
  'TimesNewRomanPS-BoldMT': { family: 'Times New Roman', bold: true },
  'TimesNewRomanPS-ItalicMT': { family: 'Times New Roman', italic: true },
  'TimesNewRomanPS-BoldItalicMT': { family: 'Times New Roman', bold: true, italic: true },
  Courier: { family: 'Courier New' },
  CourierNewPSMT: { family: 'Courier New' },
  'Helvetica-Bold': { family: 'Helvetica', bold: true },
  'Helvetica-Oblique': { family: 'Helvetica', italic: true },
};

/** Best-effort CSS family + faux flags from a PostScript font name. */
export function familyFromPsdFont(name: string | undefined): { family: string; bold: boolean; italic: boolean } {
  if (!name) return { family: 'sans-serif', bold: false, italic: false };
  const known = PSD_FONT_FAMILIES[name];
  if (known) return { family: known.family, bold: !!known.bold, italic: !!known.italic };
  const [head, ...suffixParts] = name.split('-');
  const suffix = suffixParts.join('-');
  const bold = /bold|black|heavy|semibold/i.test(suffix);
  const italic = /italic|oblique/i.test(suffix);
  // 'TimesNewRoman' → 'Times New Roman'; keep single-word names as-is.
  const family = head
    .replace(/(PSMT|PS|MT)$/u, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return { family: family || name, bold, italic };
}

function psdColorToRgb(color: unknown): RGB {
  const o = (color ?? {}) as Record<string, unknown>;
  const channel = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0);
  return { r: channel(o.r), g: channel(o.g), b: channel(o.b) };
}

function styleFromPsd(psd: PsdTextStyle | undefined): TextStyle {
  const s = psd ?? {};
  const font = familyFromPsdFont(s.font?.name);
  const size = typeof s.fontSize === 'number' && s.fontSize > 0 ? s.fontSize : 12;
  const autoLeading = s.autoLeading !== false;
  return defaultStyle({
    family: font.family,
    size,
    color: s.fillColor ? psdColorToRgb(s.fillColor) : { r: 0, g: 0, b: 0 },
    bold: font.bold || s.fauxBold === true,
    italic: font.italic || s.fauxItalic === true,
    underline: s.underline === true,
    strikethrough: s.strikethrough === true,
    tracking: typeof s.tracking === 'number' && s.tracking ? (s.tracking / 1000) * size : 0,
    leading: !autoLeading && typeof s.leading === 'number' && s.leading > 0 ? s.leading : null,
    horizontalScale: typeof s.horizontalScale === 'number' && s.horizontalScale > 0 ? s.horizontalScale * 100 : 100,
    verticalScale: typeof s.verticalScale === 'number' && s.verticalScale > 0 ? s.verticalScale * 100 : 100,
    baselineShift: typeof s.baselineShift === 'number' ? s.baselineShift : 0,
    caps: s.fontCaps === 1 ? 'small' : s.fontCaps === 2 ? 'all' : 'none',
    script: s.fontBaseline === 1 ? 'super' : s.fontBaseline === 2 ? 'sub' : 'none',
  });
}

const PSD_JUSTIFICATIONS: readonly TextAlign[] = [
  'left',
  'center',
  'right',
  'justify-left',
  'justify-center',
  'justify-right',
  'justify-all',
];

function paragraphFromPsd(psd: PsdParagraphStyle | undefined): Omit<TextParagraph, 'runs'> {
  const p = psd ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return defaultParagraph({
    align: PSD_JUSTIFICATIONS.includes(p.justification as TextAlign) ? (p.justification as TextAlign) : 'left',
    indentLeft: num(p.startIndent),
    indentRight: num(p.endIndent),
    firstLineIndent: num(p.firstLineIndent),
    spaceBefore: num(p.spaceBefore),
    spaceAfter: num(p.spaceAfter),
    hyphenate: p.autoHyphenate === true,
  });
}

function antiAliasFromPsd(mode: LayerTextData['antiAlias']): TextAntiAlias {
  return mode === 'none' || mode === 'sharp' || mode === 'crisp' || mode === 'strong' ? mode : 'smooth';
}

/**
 * Convert a PSD text layer to an editable TextModel (anchored at 0,0 — the
 * loader positions it against the layer's pixel bounds). Returns null when the
 * text uses features PaintNode cannot represent; those layers stay locked.
 */
export function psdTextToModel(text: LayerTextData): TextModel | null {
  if (psdTextBlockers(text).length > 0) return null;
  const raw = text.text ?? '';

  // Expand style runs to per-character styles (Photoshop separates lines with \r).
  // Run lengths count UTF-16 code units, so index by code unit — splitting by code
  // point would shift every style/paragraph after an astral character (emoji etc.);
  // a surrogate pair's two units share one run style, so pairs reassemble intact.
  const chars = raw.split('');
  const styles: TextStyle[] = [];
  const runs = text.styleRuns?.length
    ? text.styleRuns
    : [{ length: chars.length, style: text.style ?? {} }];
  let cursor = 0;
  for (const run of runs) {
    const style = styleFromPsd({ ...(text.style ?? {}), ...run.style });
    for (let i = 0; i < run.length && cursor < chars.length; i++) styles.push(style), cursor++;
  }
  while (styles.length < chars.length) styles.push(styleFromPsd(text.style));

  // Paragraph styles run over the same character indices.
  const paragraphStyles: Omit<TextParagraph, 'runs'>[] = [];
  const paragraphRuns = text.paragraphStyleRuns?.length
    ? text.paragraphStyleRuns
    : [{ length: chars.length, style: text.paragraphStyle ?? {} }];
  for (const run of paragraphRuns) {
    const attrs = paragraphFromPsd({ ...(text.paragraphStyle ?? {}), ...run.style });
    for (let i = 0; i < run.length; i++) paragraphStyles.push(attrs);
  }

  const paragraphs: TextParagraph[] = [];
  let current: TextParagraph = { ...(paragraphStyles[0] ?? defaultParagraph()), runs: [] };
  const pushRunChar = (ch: string, style: TextStyle) => {
    const last = current.runs.at(-1);
    if (last && last.style === style) last.text += ch;
    else current.runs.push({ text: ch, style });
  };
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\r' || ch === '\n') {
      paragraphs.push(current);
      const next = paragraphStyles[Math.min(i + 1, paragraphStyles.length - 1)] ?? defaultParagraph();
      current = { ...next, runs: [] };
      // Swallow the second half of a \r\n pair.
      if (ch === '\r' && chars[i + 1] === '\n') i++;
      continue;
    }
    pushRunChar(ch, styles[i] ?? defaultStyle());
  }
  paragraphs.push(current);

  for (const p of paragraphs) {
    if (!p.runs.length) p.runs.push({ text: '', style: styles[0] ?? defaultStyle() });
  }

  return {
    version: 1,
    x: 0,
    y: 0,
    paragraphs,
    antiAlias: antiAliasFromPsd(text.antiAlias),
  };
}

/** Human-readable summary of what the import had to lock or approximate. */
export function importNotices(
  flat: FlattenedPsdLayer[],
  classify: (layer: AgPsdLayer) => PsdLockReason | null = psdLockReason,
): string[] {
  const notices: string[] = [];
  const locked = flat.filter((item) => classify(item.layer) !== null).length;
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
