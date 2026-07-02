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
  retouchMap: Map<string, string>,
): string {
  const lines: string[] = [];
  // OpenRaster lists layers top-to-bottom; our array is bottom-to-top.
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const l = doc.layers[i];
    const src = srcMap.get(l.id)!;
    const textPath = textMap.get(l.id);
    const retouchPath = retouchMap.get(l.id);
    // Custom PaintNode attributes; other ORA readers ignore them and use the rasterized PNG.
    const extraAttrs = [
      `paintnode-layer-id="${escapeXml(l.id)}"`,
      l.sourceAssetId ? `paintnode-source-asset-id="${escapeXml(l.sourceAssetId)}"` : '',
      l.sourcePath ? `paintnode-source-path="${escapeXml(l.sourcePath)}"` : '',
      l.maskLayerId ? `paintnode-mask-layer-id="${escapeXml(l.maskLayerId)}"` : '',
      l.kind !== 'raster' ? `paintnode-layer-kind="${escapeXml(l.kind)}"` : '',
      textPath ? `paintnode-text-data="${textPath}"` : '',
      retouchPath ? `paintnode-ai-retouch-data="${retouchPath}"` : '',
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

/** A font to embed in the .ora so its text layers stay editable with the right font. */
export interface EmbeddedFont {
  family: string;
  bytes: Uint8Array;
  ext: string;
}

function safeFileName(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 48) || 'font';
}

/** Serialize a document to an OpenRaster (.ora) Blob, optionally embedding fonts. */
export async function saveOra(doc: PaintDocument, embedFonts: EmbeddedFont[] = []): Promise<Blob> {
  const enc = new TextEncoder();
  const files: Zippable = {};

  // mimetype MUST be first and stored uncompressed (level 0).
  files['mimetype'] = [enc.encode('image/openraster'), { level: 0 }];

  const srcMap = new Map<string, string>();
  const textMap = new Map<string, string>();
  const retouchMap = new Map<string, string>();
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
    if (layer.kind === 'ai-retouch-mask' && layer.aiRetouch) {
      const retouchPath = `data/layer${i}.ai-retouch.json`;
      retouchMap.set(layer.id, retouchPath);
      files[retouchPath] = enc.encode(JSON.stringify({ version: 1, ...layer.aiRetouch }));
    }
  }

  const merged = compositeToCanvas(doc);
  files['mergedimage.png'] = await canvasToPngBytes(merged);

  const thumb = makeThumbnail(merged, doc.width, doc.height, 256, 256);
  files['Thumbnails/thumbnail.png'] = await canvasToPngBytes(thumb);

  files['stack.xml'] = enc.encode(buildStackXml(doc, srcMap, textMap, retouchMap));

  // Optional embedded fonts: extra files other ORA readers ignore.
  if (embedFonts.length) {
    const manifest = embedFonts.map((f, i) => {
      const file = `fonts/${safeFileName(f.family)}-${i}.${f.ext}`;
      files[file] = f.bytes;
      return { family: f.family, file };
    });
    files['fonts/manifest.json'] = enc.encode(JSON.stringify(manifest));
  }

  files['paintnode/annotations.json'] = enc.encode(JSON.stringify({
    version: 1,
    visible: doc.annotationsVisible,
    annotations: doc.annotations,
  }));

  const zipped = zipSync(files, { level: 6 });
  return new Blob([zipped], { type: 'image/openraster' });
}
