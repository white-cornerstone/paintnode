// Lightweight reactive UI state (status bar readouts + which modal dialog is open).
export type DialogId =
  | 'new'
  | 'about'
  | 'imageSize'
  | 'brightnessContrast'
  | 'hueSaturation'
  | 'gaussianBlur'
  | 'aiGenerate';

export type FontEmbedChoice = 'embed' | 'system' | null;

export interface FontEmbedPrompt {
  embeddable: string[];
  missing: string[];
}

class UiState {
  cursor = $state<{ x: number; y: number } | null>(null);
  zoom = $state(1);
  dialog = $state<DialogId | null>(null);

  // Font-embed prompt shown on save when text uses imported (embeddable) fonts.
  fontEmbed = $state<FontEmbedPrompt | null>(null);
  private fontEmbedResolver: ((v: FontEmbedChoice) => void) | null = null;

  open(id: DialogId): void {
    this.dialog = id;
  }
  close(): void {
    this.dialog = null;
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
}

export const ui = new UiState();
