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
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    let settled = false;
    const done = (f: File | null) => {
      if (settled) return;
      settled = true;
      resolve(f);
    };
    input.onchange = () => done(input.files?.[0] ?? null);
    // Resolve null if the dialog is dismissed (best-effort across browsers).
    window.addEventListener(
      'focus',
      () => setTimeout(() => done(null), 500),
      { once: true },
    );
    input.click();
  });
}
