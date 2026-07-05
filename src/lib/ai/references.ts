import { canvasPreviewDataUrl } from './taskSupport';
import { compositeToCanvas } from '../engine/compositor';
import { createCanvas, ctx2d } from '../engine/types';
import { canvasToPngBytes, bytesToBitmap } from '../io';
import { pickAiReferenceFiles, readNativeDroppedFile, type WorkflowSourceImage } from '../integrations/desktop';
import { loadOra } from '../ora/load';
import { loadPsd } from '../psd/load';

export interface AiReferenceImage extends WorkflowSourceImage {
  id: string;
  previewDataUrl: string;
}

function bufferFrom(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function fileExtension(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function idForReference(name: string): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function imageCanvasFromBytes(bytes: Uint8Array, mime?: string | null): Promise<HTMLCanvasElement> {
  const bitmap = await bytesToBitmap(bytes, mime || 'image/png');
  try {
    const canvas = createCanvas(bitmap.width, bitmap.height);
    ctx2d(canvas).drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

async function referenceCanvasFromFile(name: string, bytes: Uint8Array, mime?: string | null): Promise<HTMLCanvasElement> {
  const ext = fileExtension(name);
  if (ext === 'ora') {
    const doc = await loadOra(bufferFrom(bytes));
    return compositeToCanvas(doc);
  }
  if (ext === 'psd') {
    const { doc } = await loadPsd(bufferFrom(bytes));
    return compositeToCanvas(doc);
  }
  return imageCanvasFromBytes(bytes, mime);
}

export async function loadAiReferenceImages(projectPath: string | null | undefined): Promise<AiReferenceImage[]> {
  const paths = await pickAiReferenceFiles(projectPath ?? null);
  const refs: AiReferenceImage[] = [];
  for (const path of paths) {
    const file = await readNativeDroppedFile(path);
    const canvas = await referenceCanvasFromFile(file.name, file.bytes, file.mime);
    refs.push({
      id: idForReference(file.name),
      name: file.name,
      bytes: await canvasToPngBytes(canvas),
      previewDataUrl: canvasPreviewDataUrl(canvas),
    });
  }
  return refs;
}
