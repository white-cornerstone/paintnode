import { editor, type DocumentSession } from './editor.svelte';
import { loadOra } from '../ora/load';
import { saveOra, type EmbeddedFont } from '../ora/save';
import { loadPsd } from '../psd/load';
import { savePsd, savePsdBytes } from '../psd/save';
import { PaintDocument } from '../engine/Document.svelte';
import { Layer } from '../engine/Layer.svelte';
import { compositeToCanvas } from '../engine/compositor';
import { fontFamiliesUsed } from '../engine/text/model';
import { canvasToPngBlob, downloadBlob, openFile, openFiles } from '../io';
import { project } from './project.svelte';
import { fonts } from './fonts.svelte';
import { ui } from './ui.svelte';
import { workflow } from './workflow.svelte';
import { isDesktop, readNativeDroppedFile } from '../integrations/desktop';
import { fileDocumentSourceKey, nativePathDocumentSourceKey, type DocumentSourceKey } from './documentSource';

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

const isOra = (file: { name: string; type?: string | null }): boolean =>
  /\.ora$/i.test(file.name) || file.type === 'image/openraster';

const isPsd = (file: { name: string; type?: string | null }): boolean =>
  /\.psd$/i.test(file.name) || file.type === 'image/vnd.adobe.photoshop';

const isRasterImage = (file: { name: string; type?: string | null }): boolean =>
  file.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name);

interface OpenableDocumentFile {
  name: string;
  type?: string | null;
  size: number;
  lastModified: number;
  sourceKey: DocumentSourceKey;
  savedPath?: string | null;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

type OpenFileResult = 'opened' | 'focused';

function exportFileName(name: string, ext: 'png' | 'psd'): string {
  const stem = (name || 'untitled').replace(/\.(ora|psd|png|jpe?g|webp)$/i, '') || 'untitled';
  return `${stem}.${ext}`;
}

function fileToOpenable(file: File): OpenableDocumentFile {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
    sourceKey: fileDocumentSourceKey(file),
    arrayBuffer: () => file.arrayBuffer(),
  };
}

async function openImageAsDocument(file: OpenableDocumentFile): Promise<void> {
  const blob = new Blob([await file.arrayBuffer()], { type: file.type ?? 'image/png' });
  const bmp = await createImageBitmap(blob);
  const doc = new PaintDocument(bmp.width, bmp.height, file.name.replace(/\.[^.]+$/, ''));
  const layer = new Layer(bmp.width, bmp.height, 'Layer 1');
  layer.ctx.drawImage(bmp, 0, 0);
  layer.touch();
  bmp.close();
  doc.layers = [layer];
  doc.activeLayerId = layer.id;
  editor.openDocument(doc, true, file.sourceKey);
}

interface OpenedFileInfo {
  result: OpenFileResult;
  notices: string[];
}

async function openDocumentFile(file: OpenableDocumentFile): Promise<OpenedFileInfo> {
  if (editor.focusDocumentBySource(file.sourceKey)) return { result: 'focused', notices: [] };

  if (isOra(file)) {
    const doc = await loadOra(await file.arrayBuffer());
    doc.name = file.name.replace(/\.ora$/i, '');
    const session = editor.openDocument(doc, true, file.sourceKey);
    if (file.savedPath) session.savedPath = file.savedPath;
  } else if (isPsd(file)) {
    const { doc, notices } = await loadPsd(await file.arrayBuffer());
    doc.name = file.name.replace(/\.psd$/i, '');
    // Never adopt the .psd path as the save target: File ▸ Save writes .ora.
    // Round-tripping back to Photoshop goes through File ▸ Export PSD.
    editor.openDocument(doc, true, file.sourceKey);
    return { result: 'opened', notices };
  } else {
    await openImageAsDocument(file);
  }
  return { result: 'opened', notices: [] };
}

export async function openDocumentFiles(files: Iterable<File>): Promise<void> {
  await openDocumentFileInputs(Array.from(files).map(fileToOpenable));
}

async function openDocumentFileInputs(files: OpenableDocumentFile[]): Promise<void> {
  const supported = files.filter((file) => isOra(file) || isPsd(file) || isRasterImage(file));
  if (!supported.length) {
    editor.flash('No supported image, .ora, or .psd files');
    return;
  }
  try {
    let opened = 0;
    let focused = 0;
    const notices: string[] = [];
    for (const file of supported) {
      const info = await openDocumentFile(file);
      if (info.result === 'opened') opened++;
      else focused++;
      notices.push(...info.notices);
    }
    if (notices.length) {
      editor.flash(`Opened ${supported[0].name} — ${notices.join('; ')}`);
    } else if (opened && focused) {
      editor.flash(`Opened ${opened} file${opened === 1 ? '' : 's'}; focused ${focused} already open`);
    } else if (focused) {
      editor.flash(
        supported.length === 1 ? `${supported[0].name} is already open` : `Focused ${focused} already-open files`,
      );
    } else {
      editor.flash(supported.length === 1 ? `Opened ${supported[0].name}` : `Opened ${opened} files`);
    }
  } catch (e) {
    editor.flash('Open failed: ' + (e as Error).message);
  }
}

export async function openDocumentPaths(paths: Iterable<string>): Promise<void> {
  try {
    const files: OpenableDocumentFile[] = [];
    for (const path of paths) {
      const sourceKey = nativePathDocumentSourceKey(path);
      if (!sourceKey) continue;
      const dropped = await readNativeDroppedFile(path);
      const bytes = dropped.bytes;
      files.push({
        name: dropped.name,
        type: dropped.mime ?? '',
        size: dropped.size,
        lastModified: dropped.modifiedAt,
        sourceKey,
        savedPath: dropped.path,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      });
    }
    await openDocumentFileInputs(files);
  } catch (e) {
    editor.flash('Open failed: ' + (e as Error).message);
  }
}

/** File ▸ Open — accepts .ora, .psd, and common raster formats. */
export async function openCommand(): Promise<void> {
  const files = await openFiles('.ora,.psd,image/openraster,image/vnd.adobe.photoshop,image/png,image/jpeg,image/webp,image/gif', true);
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

export async function placeImageBlob(
  blob: Blob,
  name: string,
  source?: { path?: string | null; attribution?: string | null },
): Promise<void> {
  if (!editor.doc) return;
  try {
    const file = new File([blob], name, { type: blob.type || 'image/jpeg' });
    const bmp = await createImageBitmap(file);
    const asset = await project.storeImportedFile(file, bmp.width, bmp.height);
    const placed = editor.placeImage(bmp, bmp.width, bmp.height, name.replace(/\.[^.]+$/, ''), {
      assetId: asset?.id ?? null,
      path: asset?.relativePath ?? source?.path ?? null,
    });
    bmp.close();
    editor.flash(
      placed.oversized
        ? `Placed ${name} full-size; use Move or Image > Reveal All to show hidden edges`
        : source?.attribution
          ? `Placed ${name} from ${source.attribution}`
          : `Placed ${name}`,
    );
  } catch (e) {
    editor.flash('Import failed: ' + (e as Error).message);
  }
}

async function documentBytes(doc: PaintDocument, embed: EmbeddedFont[] = []): Promise<Uint8Array> {
  const blob = await saveOra(doc, embed);
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Honesty note appended to .ora save confirmations: Photoshop-only passthrough
 * data (locked layers) lives only in memory and in PSD exports, not in .ora.
 */
function oraSaveNote(doc: PaintDocument): string {
  return doc.layers.some((l) => l.locked)
    ? ' — Photoshop-only layers are kept in PSD exports, not in .ora'
    : '';
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
        editor.flash(`Saved ${relativePath}${oraSaveNote(doc)}`);
        return;
      }

      const previousName = doc.name;
      const result = await project.saveDocumentAs(name, bytes, previousName);
      if (result) {
        editor.renameActiveDocument(result.name);
        editor.markSaved(result.relativePath);
        editor.flash(`Saved ${result.relativePath}${oraSaveNote(doc)}`);
      } else {
        editor.flash('Save canceled');
      }
      return;
    }
    const blob = await saveOra(doc, embed);
    downloadBlob(blob, name);
    editor.markSaved(null);
    editor.flash(`Saved .ora${oraSaveNote(doc)}`);
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

export async function saveWorkflowCommand(): Promise<void> {
  try {
    window.dispatchEvent(new Event('paintnode:workflow-before-save'));
    await Promise.resolve();
    const relativePath = await workflow.save();
    editor.flash(relativePath ? `Saved ${relativePath}` : 'Open a project folder to save workflow');
  } catch (e) {
    editor.flash('Workflow save failed: ' + ((e as Error)?.message ?? String(e)));
  }
}

export async function saveWorkflowAsCommand(): Promise<void> {
  const name = window.prompt('Workflow name', workflow.name);
  if (!name) return;
  try {
    window.dispatchEvent(new Event('paintnode:workflow-before-save'));
    await Promise.resolve();
    const relativePath = await workflow.saveAs(name);
    editor.flash(relativePath ? `Saved ${relativePath}` : 'Open a project folder to save workflow');
  } catch (e) {
    editor.flash('Workflow save failed: ' + ((e as Error)?.message ?? String(e)));
  }
}

export async function saveActiveCommand(): Promise<void> {
  if (ui.activeSurface === 'workflow' && workflow.active) {
    await saveWorkflowCommand();
    return;
  }
  await saveOraCommand();
}

export async function saveActiveCopyCommand(): Promise<void> {
  if (ui.activeSurface === 'workflow' && workflow.active) {
    await saveWorkflowAsCommand();
    return;
  }
  await saveCopyOraCommand();
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
    downloadBlob(blob, exportFileName(doc.name, 'png'));
    editor.flash('Exported PNG');
  } catch (e) {
    editor.flash('Export failed: ' + (e as Error).message);
  }
}

/** File ▸ Export PSD (layered Photoshop handoff) */
export async function exportPsdCommand(): Promise<void> {
  const doc = editor.doc;
  if (!doc) return;
  try {
    editor.flash('Exporting PSD…');
    const name = exportFileName(doc.name, 'psd');
    if (isDesktop()) {
      const bytes = await savePsdBytes(doc);
      const result = await project.saveDocumentAs(name, bytes, null, 'Export Photoshop Document');
      editor.flash(result ? `Exported ${result.relativePath}` : 'Export canceled');
      return;
    }
    const blob = await savePsd(doc);
    downloadBlob(blob, name);
    editor.flash('Exported PSD');
  } catch (e) {
    editor.flash('PSD export failed: ' + (e as Error).message);
  }
}
