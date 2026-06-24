import { editor } from './editor.svelte';
import { loadOra } from '../ora/load';
import { saveOra } from '../ora/save';
import { PaintDocument } from '../engine/Document.svelte';
import { Layer } from '../engine/Layer.svelte';
import { compositeToCanvas } from '../engine/compositor';
import { canvasToPngBlob, downloadBlob, openFile } from '../io';

const isOra = (file: File): boolean =>
  /\.ora$/i.test(file.name) || file.type === 'image/openraster';

async function openImageAsDocument(file: File): Promise<void> {
  const bmp = await createImageBitmap(file);
  const doc = new PaintDocument(bmp.width, bmp.height, file.name.replace(/\.[^.]+$/, ''));
  const layer = new Layer(bmp.width, bmp.height, 'Layer 1');
  layer.ctx.drawImage(bmp, 0, 0);
  layer.touch();
  bmp.close();
  doc.layers = [layer];
  doc.activeLayerId = layer.id;
  editor.setDocument(doc);
}

/** File ▸ Open — accepts .ora and common raster formats. */
export async function openCommand(): Promise<void> {
  const file = await openFile('.ora,image/openraster,image/png,image/jpeg,image/webp,image/gif');
  if (!file) return;
  try {
    if (isOra(file)) {
      const doc = await loadOra(await file.arrayBuffer());
      doc.name = file.name.replace(/\.ora$/i, '');
      editor.setDocument(doc);
      editor.flash(`Opened ${file.name}`);
    } else {
      await openImageAsDocument(file);
      editor.flash(`Opened ${file.name}`);
    }
  } catch (e) {
    editor.flash('Open failed: ' + (e as Error).message);
  }
}

/** File ▸ Place — import an image as a new layer in the current document. */
export async function importImageCommand(): Promise<void> {
  if (!editor.doc) return;
  const file = await openFile('image/png,image/jpeg,image/webp,image/gif');
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    editor.placeImage(bmp, bmp.width, bmp.height, file.name.replace(/\.[^.]+$/, ''));
    bmp.close();
    editor.flash(`Placed ${file.name}`);
  } catch (e) {
    editor.flash('Import failed: ' + (e as Error).message);
  }
}

/** File ▸ Save as .ora */
export async function saveOraCommand(): Promise<void> {
  const doc = editor.doc;
  if (!doc) return;
  try {
    editor.flash('Saving .ora…');
    const blob = await saveOra(doc);
    downloadBlob(blob, `${doc.name || 'untitled'}.ora`);
    editor.flash('Saved .ora');
  } catch (e) {
    editor.flash('Save failed: ' + (e as Error).message);
  }
}

/** File ▸ Export PNG (flattened) */
export async function exportPngCommand(): Promise<void> {
  const doc = editor.doc;
  if (!doc) return;
  try {
    const blob = await canvasToPngBlob(compositeToCanvas(doc));
    downloadBlob(blob, `${doc.name || 'untitled'}.png`);
    editor.flash('Exported PNG');
  } catch (e) {
    editor.flash('Export failed: ' + (e as Error).message);
  }
}
