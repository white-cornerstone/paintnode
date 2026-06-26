import { editor, type DocumentSession } from './editor.svelte';
import { loadOra } from '../ora/load';
import { saveOra, type EmbeddedFont } from '../ora/save';
import { PaintDocument } from '../engine/Document.svelte';
import { Layer } from '../engine/Layer.svelte';
import { compositeToCanvas } from '../engine/compositor';
import { fontFamiliesUsed } from '../engine/text/model';
import { canvasToPngBlob, downloadBlob, openFile, openFiles } from '../io';
import { project } from './project.svelte';
import { fonts } from './fonts.svelte';
import { ui } from './ui.svelte';
import { isDesktop } from '../integrations/desktop';

/** Distinct font families used by the document's text layers. */
function textFamilies(doc: PaintDocument): string[] {
  const set = new Set<string>();
  for (const l of doc.layers) {
    if (l.kind === 'text' && l.text) for (const f of fontFamiliesUsed(l.text)) set.add(f);
  }
  return [...set];
}

/** Of the families used, the ones we hold bytes for and can embed. */
function embeddableFonts(doc: PaintDocument): EmbeddedFont[] {
  return textFamilies(doc)
    .map((f) => {
      const bytes = fonts.bytesFor(f);
      return bytes ? { family: f, bytes, ext: fonts.extFor(f) } : null;
    })
    .filter((x): x is EmbeddedFont => x !== null);
}

/**
 * Decide which fonts (if any) to embed. Prompts only when the document uses imported
 * (embeddable) fonts and the choice hasn't been made yet for this document. Returns the
 * fonts to embed, or 'cancel' if the user dismissed the prompt.
 */
async function resolveEmbed(
  doc: PaintDocument,
  session: DocumentSession | null,
): Promise<EmbeddedFont[] | 'cancel'> {
  const embeddable = embeddableFonts(doc);
  if (!embeddable.length) return []; // only system fonts → nothing to embed, save normally
  let pref = session?.embedFonts ?? null;
  if (pref === null) {
    const missing = textFamilies(doc).filter((f) => !fonts.bytesFor(f));
    const choice = await ui.askFontEmbed({ embeddable: embeddable.map((e) => e.family), missing });
    if (choice === null) return 'cancel';
    pref = choice === 'embed';
    if (session) session.embedFonts = pref;
  }
  return pref ? embeddable : [];
}

const isOra = (file: File): boolean =>
  /\.ora$/i.test(file.name) || file.type === 'image/openraster';

const isRasterImage = (file: File): boolean =>
  file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name);

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

export async function openDocumentFiles(files: Iterable<File>): Promise<void> {
  const supported = Array.from(files).filter((file) => isOra(file) || isRasterImage(file));
  if (!supported.length) {
    editor.flash('No supported image or .ora files');
    return;
  }
  try {
    for (const file of supported) await openDocumentFile(file);
    editor.flash(supported.length === 1 ? `Opened ${supported[0].name}` : `Opened ${supported.length} files`);
  } catch (e) {
    editor.flash('Open failed: ' + (e as Error).message);
  }
}

/** File ▸ Open — accepts .ora and common raster formats. */
export async function openCommand(): Promise<void> {
  const files = await openFiles('.ora,image/openraster,image/png,image/jpeg,image/webp,image/gif', true);
  if (!files.length) return;
  await openDocumentFiles(files);
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

async function documentBytes(doc: PaintDocument, embed: EmbeddedFont[] = []): Promise<Uint8Array> {
  const blob = await saveOra(doc, embed);
  return new Uint8Array(await blob.arrayBuffer());
}

/** File ▸ Save — prompts once, then overwrites the same file on later saves. */
export async function saveOraCommand(): Promise<void> {
  const doc = editor.doc;
  const session = editor.activeDocument;
  if (!doc) return;
  try {
    const embed = await resolveEmbed(doc, session);
    if (embed === 'cancel') {
      editor.flash('Save canceled');
      return;
    }
    editor.flash('Saving .ora…');
    const name = `${doc.name || 'untitled'}.ora`;
    const bytes = await documentBytes(doc, embed);
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
    const blob = await saveOra(doc, embed);
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
  const session = editor.activeDocument;
  if (!doc) return;
  try {
    const embed = await resolveEmbed(doc, session);
    if (embed === 'cancel') {
      editor.flash('Save canceled');
      return;
    }
    editor.flash('Saving copy…');
    const name = `${doc.name || 'untitled'}.ora`;
    const bytes = await documentBytes(doc, embed);
    if (isDesktop()) {
      const result = await project.saveDocumentAs(name, bytes, null, 'Save a Copy');
      editor.flash(result ? `Saved copy ${result.relativePath}` : 'Save copy canceled');
      return;
    }
    const blob = await saveOra(doc, embed);
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
      // Autosave never prompts; embed only if the user already opted in for this doc.
      const embed = session.embedFonts ? embeddableFonts(session.doc) : [];
      const blob = await saveOra(session.doc, embed);
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
