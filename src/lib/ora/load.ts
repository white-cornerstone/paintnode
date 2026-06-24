import { unzipSync, strFromU8 } from 'fflate';
import { PaintDocument } from '../engine/Document.svelte';
import { Layer } from '../engine/Layer.svelte';
import { clamp, oraToBlend } from '../engine/types';
import { bytesToBitmap } from '../io';

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
    const layer = new Layer(w, h, name);
    layer.opacity = clamp(Number.isNaN(opacityRaw) ? 1 : opacityRaw, 0, 1);
    layer.visible = (el.getAttribute('visibility') || 'visible') !== 'hidden';
    layer.blendMode = oraToBlend(el.getAttribute('composite-op'));

    if (src && files[src]) {
      const bmp = await bytesToBitmap(files[src]);
      layer.ctx.drawImage(bmp, x, y);
      bmp.close();
      layer.touch();
    }
    layers.push(layer);
  }

  if (layers.length === 0) layers.push(new Layer(w, h, 'Layer 1'));
  doc.layers = layers;
  doc.activeLayerId = layers[layers.length - 1].id;
  return doc;
}
