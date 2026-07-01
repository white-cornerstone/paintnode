// Lightweight reactive UI state (status bar readouts + which modal dialog is open).
export type DialogId =
  | 'new'
  | 'about'
  | 'imageSize'
  | 'brightnessContrast'
  | 'hueSaturation'
  | 'gaussianBlur'
  | 'aiGenerate'
  | 'aiDecouple';

export type FontEmbedChoice = 'embed' | 'system' | null;
export type SaveChangesChoice = 'save' | 'discard' | 'cancel';

export interface FontEmbedPrompt {
  embeddable: string[];
  missing: string[];
}

export interface SaveChangesPrompt {
  name: string;
  kind: 'document' | 'workflow';
  index: number;
  total: number;
}

class UiState {
  cursor = $state<{ x: number; y: number } | null>(null);
  zoom = $state(1);
  dialog = $state<DialogId | null>(null);
  activeSurface = $state<'document' | 'workflow'>('document');

  // Font-embed prompt shown on save when text uses imported (embeddable) fonts.
  fontEmbed = $state<FontEmbedPrompt | null>(null);
  private fontEmbedResolver: ((v: FontEmbedChoice) => void) | null = null;
  saveChanges = $state<SaveChangesPrompt | null>(null);
  private saveChangesResolver: ((v: SaveChangesChoice) => void) | null = null;

  open(id: DialogId): void {
    this.dialog = id;
  }
  close(): void {
    this.dialog = null;
  }
  showDocument(): void {
    this.activeSurface = 'document';
  }
  showWorkflow(): void {
    this.activeSurface = 'workflow';
  }

  /** Show the embed prompt and resolve with the user's choice. */
  askFontEmbed(prompt: FontEmbedPrompt): Promise<FontEmbedChoice> {
    return new Promise((resolve) => {
      this.fontEmbedResolver = resolve;
      this.fontEmbed = prompt;
    });
  }
  resolveFontEmbed(choice: FontEmbedChoice): void {
    this.fontEmbed = null;
    const resolve = this.fontEmbedResolver;
    this.fontEmbedResolver = null;
    resolve?.(choice);
  }

  askSaveChanges(prompt: SaveChangesPrompt): Promise<SaveChangesChoice> {
    return new Promise((resolve) => {
      this.saveChangesResolver = resolve;
      this.saveChanges = prompt;
    });
  }
  resolveSaveChanges(choice: SaveChangesChoice): void {
    this.saveChanges = null;
    const resolve = this.saveChangesResolver;
    this.saveChangesResolver = null;
    resolve?.(choice);
  }
}

export const ui = new UiState();
