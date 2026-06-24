import { editor } from './editor.svelte';
import { loadOra } from '../ora/load';
import { saveOra } from '../ora/save';
import { PaintDocument } from '../engine/Document.svelte';
import { Layer } from '../engine/Layer.svelte';
import { compositeToCanvas } from '../engine/compositor';
import { canvasToPngBlob, downloadBlob, openFile, openFiles } from '../io';
import { project } from './project.svelte';
import { isDesktop } from '../integrations/desktop';

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
  editor.openDocument(doc);
}

async function openDocumentFile(file: File): Promise<void> {
  if (isOra(file)) {
    const doc = await loadOra(await file.arrayBuffer());
    doc.name = file.name.replace(/\.ora$/i, '');
    editor.openDocument(doc);
  } else {
    await openImageAsDocument(file);
  }
}

/** File ▸ Open — accepts .ora and common raster formats. */
export async function openCommand(): Promise<void> {
  const files = await openFiles('.ora,image/openraster,image/png,image/jpeg,image/webp,image/gif', true);
  if (!files.length) return;
  try {
    for (const file of files) await openDocumentFile(file);
    editor.flash(files.length === 1 ? `Opened ${files[0].name}` : `Opened ${files.length} files`);
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
    const asset = await project.storeImportedFile(file, bmp.width, bmp.height);
    const placed = editor.placeImage(bmp, bmp.width, bmp.height, file.name.replace(/\.[^.]+$/, ''), {
      assetId: asset?.id ?? null,
      path: asset?.relativePath ?? null,
    });
    bmp.close();
    editor.flash(
      placed.oversized
        ? `Placed ${file.name} full-size; use Move or Image > Reveal All to show hidden edges`
        : asset
          ? `Placed ${file.name} and saved it to the project`
          : `Placed ${file.name}`,
    );
  } catch (e) {
    editor.flash('Import failed: ' + (e as Error).message);
  }
}

async function documentBytes(doc: PaintDocument): Promise<Uint8Array> {
  const blob = await saveOra(doc);
  return new Uint8Array(await blob.arrayBuffer());
}

/** File ▸ Save — prompts once, then overwrites the same file on later saves. */
export async function saveOraCommand(): Promise<void> {
  const doc = editor.doc;
  const session = editor.activeDocument;
  if (!doc) return;
  try {
    editor.flash('Saving .ora…');
    const name = `${doc.name || 'untitled'}.ora`;
    const bytes = await documentBytes(doc);
    if (isDesktop()) {
      if (session?.savedPath) {
        const relativePath = await project.saveDocumentToPath(session.savedPath, bytes);
        editor.markSaved(relativePath);
        editor.flash(`Saved ${relativePath}`);
        return;
      }

      const previousName = doc.name;
      const result = await project.saveDocumentAs(name, bytes, previousName);
      if (result) {
        editor.renameActiveDocument(result.name);
        editor.markSaved(result.relativePath);
        editor.flash(`Saved ${result.relativePath}`);
      } else {
        editor.flash('Save canceled');
      }
      return;
    }
    const blob = await saveOra(doc);
    downloadBlob(blob, name);
    editor.markSaved(null);
    editor.flash('Saved .ora');
  } catch (e) {
    editor.flash('Save failed: ' + (e as Error).message);
  }
}

/** File ▸ Save a Copy — writes a new file without changing this document's saved path/name. */
export async function saveCopyOraCommand(): Promise<void> {
  const doc = editor.doc;
  if (!doc) return;
  try {
    editor.flash('Saving copy…');
    const name = `${doc.name || 'untitled'}.ora`;
    const bytes = await documentBytes(doc);
    if (isDesktop()) {
      const result = await project.saveDocumentAs(name, bytes, null, 'Save a Copy');
      editor.flash(result ? `Saved copy ${result.relativePath}` : 'Save copy canceled');
      return;
    }
    const blob = await saveOra(doc);
    downloadBlob(blob, name);
    editor.flash('Saved copy');
  } catch (e) {
    editor.flash('Save copy failed: ' + (e as Error).message);
  }
}

export async function autosaveOpenDocuments(): Promise<void> {
  if (!project.path) return;
  let wrote = false;
  for (const session of editor.documents.slice()) {
    if (!editor.needsAutosave(session)) continue;
    try {
      const blob = await saveOra(session.doc);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const relativePath = await project.autosaveDocument(`${session.doc.name || 'untitled'}.ora`, bytes);
      editor.markAutosaved(session.id, relativePath);
      wrote = true;
    } catch (e) {
      console.warn('Autosave failed', e);
    }
  }
  if (wrote) await project.refresh();
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
