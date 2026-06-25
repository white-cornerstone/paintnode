import { zipSync, type Zippable } from 'fflate';
import type { PaintDocument } from '../engine/Document.svelte';
import { BLEND_TO_ORA } from '../engine/types';
import { compositeToCanvas, makeThumbnail } from '../engine/compositor';
import { serializeModel } from '../engine/text/model';
import { canvasToPngBytes } from '../io';

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

function buildStackXml(
  doc: PaintDocument,
  srcMap: Map<string, string>,
  textMap: Map<string, string>,
): string {
  const lines: string[] = [];
  // OpenRaster lists layers top-to-bottom; our array is bottom-to-top.
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    const src = srcMap.get(l.id)!;
    const textPath = textMap.get(l.id);
    // Custom cx-* attributes; other ORA readers ignore them and use the rasterized PNG.
    const extraAttrs = [
      l.sourceAssetId ? `cx-source-asset-id="${escapeXml(l.sourceAssetId)}"` : '',
      l.sourcePath ? `cx-source-path="${escapeXml(l.sourcePath)}"` : '',
      l.kind === 'text' ? `cx-layer-kind="text"` : '',
      textPath ? `cx-text-data="${textPath}"` : '',
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(
      `  <layer name="${escapeXml(l.name)}" src="${src}" x="${l.x}" y="${l.y}" ` +
        `opacity="${l.opacity}" visibility="${l.visible ? 'visible' : 'hidden'}" ` +
        `composite-op="${BLEND_TO_ORA[l.blendMode]}"${extraAttrs ? ` ${extraAttrs}` : ''}/>`,
    );
  }
  return (
    `<?xml version='1.0' encoding='UTF-8'?>\n` +
    `<image version="0.0.3" w="${doc.width}" h="${doc.height}">\n` +
    ` <stack>\n${lines.join('\n')}\n </stack>\n` +
    `</image>\n`
  );
}

/** Serialize a document to an OpenRaster (.ora) Blob. */
export async function saveOra(doc: PaintDocument): Promise<Blob> {
  const enc = new TextEncoder();
  const files: Zippable = {};

  // mimetype MUST be first and stored uncompressed (level 0).
  files['mimetype'] = [enc.encode('image/openraster'), { level: 0 }];

  const srcMap = new Map<string, string>();
  const textMap = new Map<string, string>();
  for (let i = 0; i < doc.layers.length; i++) {
    const layer = doc.layers[i];
    const src = `data/layer${i}.png`;
    srcMap.set(layer.id, src);
    files[src] = await canvasToPngBytes(layer.canvas);
    // Editable text layers also store their model as a sidecar JSON.
    if (layer.kind === 'text' && layer.text) {
      const textPath = `data/layer${i}.text.json`;
      textMap.set(layer.id, textPath);
      files[textPath] = enc.encode(serializeModel(layer.text));
    }
  }

  const merged = compositeToCanvas(doc);
  files['mergedimage.png'] = await canvasToPngBytes(merged);

  const thumb = makeThumbnail(merged, doc.width, doc.height, 256, 256);
  files['Thumbnails/thumbnail.png'] = await canvasToPngBytes(thumb);

  files['stack.xml'] = enc.encode(buildStackXml(doc, srcMap, textMap));

  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped], { type: 'image/openraster' });
}
