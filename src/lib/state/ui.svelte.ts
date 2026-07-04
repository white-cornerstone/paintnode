// Lightweight reactive UI state (status bar readouts + which modal dialog is open).
export type DialogId =
  | 'new'
  | 'about'
  | 'imageSize'
  | 'brightnessContrast'
  | 'hueSaturation'
  | 'gaussianBlur'
  | 'aiGenerate'
  | 'aiRetouch'
  | 'aiDecouple'
  | 'stockImages'
  | 'settings';

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

interface LoadingTask {
  id: number;
  label: string;
}

class UiState {
  cursor = $state<{ x: number; y: number } | null>(null);
  zoom = $state(1);
  dialog = $state<DialogId | null>(null);
  activeSurface = $state<'document' | 'workflow'>('document');
  workspaceFocusMode = $state(false);
  workspaceFocusHintVisible = $state(false);
  contextualTaskBarVisible = $state(true);
  contextualTaskBarResetToken = $state(0);

  // Background waits (project scan, document decode) surfaced in the status bar.
  private loadingTasks = $state<LoadingTask[]>([]);
  private loadingSeq = 0;

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
  toggleWorkspaceFocusMode(): void {
    this.setWorkspaceFocusMode(!this.workspaceFocusMode);
  }
  setWorkspaceFocusMode(value: boolean): void {
    this.workspaceFocusMode = value;
    this.workspaceFocusHintVisible = value;
  }
  dismissWorkspaceFocusHint(): void {
    this.workspaceFocusHintVisible = false;
  }
  showContextualTaskBar(): void {
    this.contextualTaskBarVisible = true;
  }
  hideContextualTaskBar(): void {
    this.contextualTaskBarVisible = false;
  }
  resetContextualTaskBarPosition(): void {
    this.contextualTaskBarVisible = true;
    this.contextualTaskBarResetToken += 1;
  }

  /**
   * Register a background wait so the status bar can show a loading indicator.
   * Returns a disposer to call when the work finishes (use try/finally).
   * Overlapping waits stack; the most recent label is the one displayed.
   */
  beginLoading(label: string): () => void {
    const id = ++this.loadingSeq;
    this.loadingTasks = [...this.loadingTasks, { id, label }];
    return () => {
      this.loadingTasks = this.loadingTasks.filter((task) => task.id !== id);
    };
  }

  /** Label of the most recent in-flight wait, or null when idle. */
  get loadingLabel(): string | null {
    return this.loadingTasks[this.loadingTasks.length - 1]?.label ?? null;
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
