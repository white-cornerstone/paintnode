import { unzipSync, strFromU8 } from 'fflate';
import { PaintDocument } from '../engine/Document.svelte';
import { Layer } from '../engine/Layer.svelte';
import { clamp, oraToBlend } from '../engine/types';
import { AI_RETOUCH_TOOL_ORDER, type AiRetouchMaskMetadata } from '../engine/aiRetouch';
import { deserializeModel, type TextModel } from '../engine/text/model';
import { fonts } from '../state/fonts.svelte';
import { bytesToBitmap } from '../io';
import { coerceAnnotations } from '../engine/annotations';

function coerceAiRetouchMetadata(raw: unknown): AiRetouchMaskMetadata | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<AiRetouchMaskMetadata>;
  if (!value.toolId || !AI_RETOUCH_TOOL_ORDER.includes(value.toolId)) return null;
  return {
    toolId: value.toolId,
    promptSeed: typeof value.promptSeed === 'string' ? value.promptSeed : '',
    patchMode: value.patchMode === 'destination' ? 'destination' : value.patchMode === 'source' ? 'source' : undefined,
    moveMode: value.moveMode === 'extend' ? 'extend' : value.moveMode === 'move' ? 'move' : undefined,
    pupilSize: typeof value.pupilSize === 'number' ? value.pupilSize : undefined,
    darkenAmount: typeof value.darkenAmount === 'number' ? value.darkenAmount : undefined,
    healingSource: value.healingSource ?? null,
    referenceRect: value.referenceRect ?? null,
    destinationRect: value.destinationRect ?? null,
  };
}

/** Parse an OpenRaster (.ora) file into a PaintDocument. Nested group stacks are flattened. */
export async function loadOra(buffer: ArrayBuffer): Promise<PaintDocument> {
  const files = unzipSync(new Uint8Array(buffer));

  const stackBytes = files['stack.xml'];
  if (!stackBytes) throw new Error('Not a valid ORA file (missing stack.xml)');

  const dom = new DOMParser().parseFromString(strFromU8(stackBytes), 'application/xml');
  if (dom.querySelector('parsererror')) throw new Error('Corrupt ORA: stack.xml is not valid XML');

  const imageEl = dom.querySelector('image');
  if (!imageEl) throw new Error('Corrupt ORA: missing <image> element');

  const w = parseInt(imageEl.getAttribute('w') || '0', 10);
  const h = parseInt(imageEl.getAttribute('h') || '0', 10);
  if (!w || !h) throw new Error('Corrupt ORA: invalid image dimensions');

  const doc = new PaintDocument(w, h, 'Untitled');

  // Collect layers in document order (top-first), recursing into group stacks.
  const layerEls: Element[] = [];
  const walk = (stack: Element) => {
    for (const child of Array.from(stack.children)) {
      if (child.tagName === 'layer') layerEls.push(child);
      else if (child.tagName === 'stack') walk(child);
    }
  };
  const rootStack = imageEl.querySelector('stack');
  if (rootStack) walk(rootStack);

  // Our stack is bottom-to-top, so reverse the top-first list.
  const ordered = layerEls.reverse();
  const layers: Layer[] = [];
  for (const el of ordered) {
    const name = el.getAttribute('name') || 'Layer';
    const src = el.getAttribute('src');
    const x = parseFloat(el.getAttribute('x') || '0') || 0;
    const y = parseFloat(el.getAttribute('y') || '0') || 0;
    const opacityRaw = parseFloat(el.getAttribute('opacity') || '1');
    const sourceAssetId = el.getAttribute('paintnode-source-asset-id');
    const sourcePath = el.getAttribute('paintnode-source-path');
    const layerKind = el.getAttribute('paintnode-layer-kind');
    // Editable text layer: parse the sidecar model. The PNG is still used for pixels
    // (it renders identically even when the original fonts are missing on this machine).
    let textModel: TextModel | null = null;
    if (layerKind === 'text') {
      const textPath = el.getAttribute('paintnode-text-data');
      if (textPath && files[textPath]) textModel = deserializeModel(strFromU8(files[textPath]));
    }
    let aiRetouch: AiRetouchMaskMetadata | null = null;
    if (layerKind === 'ai-retouch-mask') {
      const retouchPath = el.getAttribute('paintnode-ai-retouch-data');
      if (retouchPath && files[retouchPath]) {
        try {
          aiRetouch = coerceAiRetouchMetadata(JSON.parse(strFromU8(files[retouchPath])));
        } catch {
          aiRetouch = null;
        }
      }
    }
    const layer = new Layer(w, h, name);
    layer.x = x;
    layer.y = y;
    layer.sourceAssetId = sourceAssetId;
    layer.sourcePath = sourcePath;
    layer.opacity = clamp(Number.isNaN(opacityRaw) ? 1 : opacityRaw, 0, 1);
    layer.visible = (el.getAttribute('visibility') || 'visible') !== 'hidden';
    layer.blendMode = oraToBlend(el.getAttribute('composite-op'));
    if (textModel) {
      layer.kind = 'text';
      layer.text = textModel;
    } else if (aiRetouch) {
      layer.kind = 'ai-retouch-mask';
      layer.aiRetouch = aiRetouch;
    }

    if (src && files[src]) {
      const bmp = await bytesToBitmap(files[src]);
      const loaded = new Layer(bmp.width, bmp.height, name, undefined, x, y);
      loaded.sourceAssetId = sourceAssetId;
      loaded.sourcePath = sourcePath;
      loaded.opacity = layer.opacity;
      loaded.visible = layer.visible;
      loaded.blendMode = layer.blendMode;
      if (textModel) {
        loaded.kind = 'text';
        loaded.text = textModel;
      } else if (aiRetouch) {
        loaded.kind = 'ai-retouch-mask';
        loaded.aiRetouch = aiRetouch;
      }
      loaded.ctx.drawImage(bmp, 0, 0);
      bmp.close();
      loaded.touch();
      layers.push(loaded);
      continue;
    }
    layers.push(layer);
  }

  if (layers.length === 0) layers.push(new Layer(w, h, 'Layer 1'));
  doc.layers = layers;
  doc.activeLayerId = layers[layers.length - 1].id;

  // Register any embedded fonts so text layers stay editable with the right font.
  const manifestBytes = files['fonts/manifest.json'];
  if (manifestBytes) {
    try {
      const manifest = JSON.parse(strFromU8(manifestBytes)) as { family: string; file: string }[];
      for (const entry of manifest) {
        const data = files[entry.file];
        if (data && entry.family) {
          const ext = entry.file.match(/\.([^.]+)$/)?.[1] ?? 'font';
          await fonts.registerEmbedded(entry.family, data, ext);
        }
      }
    } catch {
      /* ignore a malformed font manifest */
    }
  }

  const annotationBytes = files['paintnode/annotations.json'];
  if (annotationBytes) {
    try {
      const raw = JSON.parse(strFromU8(annotationBytes)) as { visible?: boolean; annotations?: unknown };
      doc.annotationsVisible = raw.visible !== false;
      doc.annotations = coerceAnnotations(raw.annotations);
    } catch {
      /* ignore malformed PaintNode annotation metadata */
    }
  }

  return doc;
}
