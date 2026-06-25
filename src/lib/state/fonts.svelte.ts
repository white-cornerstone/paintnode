// Font registry: the families offered in the Type controls, plus user-imported fonts.
//
// The browser cannot read the bytes of an arbitrary OS-installed font, so only fonts we
// hold the bytes for (imported here, or embedded in an opened .ora) can be embedded back
// into a saved .ora. Curated families are rendered via the system/browser and cannot be
// embedded.

import { openFile } from '../io';

export interface ImportedFont {
  family: string;
  bytes: Uint8Array;
  /** Original file extension (woff2/ttf/…); only used to name the embedded file. */
  ext: string;
}

/** Common families assumed available on most systems (no embeddable bytes). */
export const CURATED_FONTS = [
  'sans-serif',
  'serif',
  'monospace',
  'Arial',
  'Helvetica',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Trebuchet MS',
  'Verdana',
  'Impact',
  'Comic Sans MS',
];

class FontRegistry {
  /** Fonts we have the bytes for (imported by the user or embedded in an opened file). */
  imported = $state<ImportedFont[]>([]);

  /** Families for the font dropdown: imported (with bytes) first, then curated. */
  get all(): string[] {
    const extra = this.imported.map((f) => f.family).filter((f) => !CURATED_FONTS.includes(f));
    return [...extra, ...CURATED_FONTS];
  }

  /** True when this family's bytes are available to embed. */
  embeddable(family: string): boolean {
    return this.imported.some((f) => f.family === family);
  }
  bytesFor(family: string): Uint8Array | null {
    return this.imported.find((f) => f.family === family)?.bytes ?? null;
  }
  extFor(family: string): string {
    return this.imported.find((f) => f.family === family)?.ext ?? 'font';
  }

  private async register(family: string, bytes: Uint8Array): Promise<boolean> {
    if (typeof FontFace === 'undefined') return false;
    try {
      const face = new FontFace(family, bytes as BufferSource);
      await face.load();
      document.fonts.add(face);
      return true;
    } catch {
      return false;
    }
  }

  private remember(font: ImportedFont): void {
    if (!this.imported.some((f) => f.family === font.family)) {
      this.imported = [...this.imported, font];
    }
  }

  /** Load + register a font from a File; returns the family name (or null on failure). */
  async importFromFile(file: File): Promise<string | null> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const family = file.name.replace(/\.[^.]+$/, '').trim() || 'Imported Font';
    const ext = (file.name.match(/\.([^.]+)$/)?.[1] ?? 'font').toLowerCase();
    if (!(await this.register(family, bytes))) return null;
    this.remember({ family, bytes, ext });
    return family;
  }

  /** Open a file picker and import the chosen font. */
  async importViaPicker(): Promise<string | null> {
    const file = await openFile('.ttf,.otf,.woff,.woff2,font/*');
    if (!file) return null;
    return this.importFromFile(file);
  }

  /** Register a font embedded in an opened .ora so it's available for editing/re-embedding. */
  async registerEmbedded(family: string, bytes: Uint8Array, ext = 'font'): Promise<void> {
    if (await this.register(family, bytes)) this.remember({ family, bytes, ext });
  }
}

export const fonts = new FontRegistry();
