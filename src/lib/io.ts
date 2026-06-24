// Browser file I/O helpers — all client-side, no server.

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
      'image/png',
    );
  });
}

export async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await canvasToPngBlob(canvas);
  return new Uint8Array(await blob.arrayBuffer());
}

export async function bytesToBitmap(
  bytes: Uint8Array,
  type = 'image/png',
): Promise<ImageBitmap> {
  const blob = new Blob([bytes as BlobPart], { type });
  return createImageBitmap(blob);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open a native file picker and resolve with the chosen file (or null if cancelled). */
export function openFile(accept: string): Promise<File | null> {
  return openFiles(accept, false).then((files) => files[0] ?? null);
}

/** Open a native file picker and resolve with all selected files. */
export function openFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      resolve(files);
    };
    input.onchange = () => done(Array.from(input.files ?? []));
    // Resolve null if the dialog is dismissed (best-effort across browsers).
    window.addEventListener(
      'focus',
      () => setTimeout(() => done([]), 500),
      { once: true },
    );
    input.click();
  });
}
