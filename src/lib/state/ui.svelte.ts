// Lightweight reactive UI state (status bar readouts + which modal dialog is open).
import { LoadingTracker, type LoadingOptions } from './loading';

export type DialogId =
  | 'new'
  | 'about'
  | 'imageSize'
  | 'canvasSize'
  | 'trim'
  | 'duplicateDocument'
  | 'brightnessContrast'
  | 'hueSaturation'
  | 'levels'
  | 'threshold'
  | 'aiAutoAdjust'
  | 'gaussianBlur'
  | 'aiGenerate'
  | 'aiRetouch'
  | 'aiUpscale'
  | 'aiDecouple'
  | 'aiSetup'
  | 'stockImages'
  | 'settings'
  | 'update';

export type AiTaskDialogKind = 'generate' | 'retouch' | 'upscale' | 'decouple' | 'autoAdjust';
export type AiAutoAdjustKind = 'tone' | 'contrast' | 'color';
export type ColorPickerTarget = 'foreground' | 'background';
export type NewDialogTab = 'image' | 'workflow' | 'project';

export type FontEmbedChoice = 'embed' | 'system' | null;
export type SaveChangesChoice = 'save' | 'discard' | 'cancel';

export interface FontEmbedPrompt {
  embeddable: string[];
  missing: string[];
}

export interface SaveChangesPrompt {
  name: string;
  kind: 'document' | 'workflow' | 'workflow-return';
  index: number;
  total: number;
}

class UiState {
  cursor = $state<{ x: number; y: number } | null>(null);
  zoom = $state(1);
  dialog = $state<DialogId | null>(null);
  newDialogTab = $state<NewDialogTab>('image');
  colorPickerTarget = $state<ColorPickerTarget | null>(null);
  aiTaskDialog = $state<{ kind: AiTaskDialogKind; id: string } | null>(null);
  aiAutoAdjustKind = $state<AiAutoAdjustKind>('tone');
  activeSurface = $state<'document' | 'workflow'>('document');
  workspaceFocusMode = $state(false);
  workspaceFocusHintVisible = $state(false);
  contextualTaskBarVisible = $state(true);
  contextualTaskBarResetToken = $state(0);
  workflowFocusRequest = $state(0);
  workflowPasteRequest = $state(0);

  // Background waits (project scan, document decode) surfaced in the status bar.
  // Null until a wait outlives the tracker's anti-flash delay, so short waits
  // never mount the indicator (or its screen-reader live region) at all.
  loadingLabel = $state<string | null>(null);
  private loadingTracker = new LoadingTracker((label) => {
    this.loadingLabel = label;
  });

  // Font-embed prompt shown on save when text uses imported (embeddable) fonts.
  fontEmbed = $state<FontEmbedPrompt | null>(null);
  private fontEmbedResolver: ((v: FontEmbedChoice) => void) | null = null;
  saveChanges = $state<SaveChangesPrompt | null>(null);
  private saveChangesResolver: ((v: SaveChangesChoice) => void) | null = null;

  // One-shot prompt handoff into the next AI Generate dialog (e.g. from the
  // setup wizard). Consumed on dialog mount, so it is plain non-reactive state.
  private aiGeneratePrefill: string | null = null;

  open(id: DialogId): void {
    this.aiTaskDialog = null;
    if (id === 'new') this.newDialogTab = 'image';
    this.dialog = id;
  }
  openNew(tab: NewDialogTab = 'image'): void {
    this.aiTaskDialog = null;
    this.newDialogTab = tab;
    this.dialog = 'new';
  }
  requestWorkflowFocus(): void {
    this.workflowFocusRequest += 1;
  }
  requestWorkflowPaste(): void {
    this.workflowPasteRequest += 1;
  }
  openAiGenerate(prefillPrompt: string | null = null): void {
    this.aiGeneratePrefill = prefillPrompt;
    this.open('aiGenerate');
  }
  openAiAutoAdjust(kind: AiAutoAdjustKind): void {
    this.aiAutoAdjustKind = kind;
    this.open('aiAutoAdjust');
  }
  openColorPicker(target: ColorPickerTarget): void {
    this.colorPickerTarget = target;
  }
  closeColorPicker(): void {
    this.colorPickerTarget = null;
  }
  consumeAiGeneratePrefill(): string | null {
    const value = this.aiGeneratePrefill;
    this.aiGeneratePrefill = null;
    return value;
  }
  openAiTask(kind: AiTaskDialogKind, id: string): void {
    this.aiTaskDialog = { kind, id };
    this.dialog =
      kind === 'generate'
        ? 'aiGenerate'
        : kind === 'retouch'
          ? 'aiRetouch'
          : kind === 'upscale'
            ? 'aiUpscale'
            : kind === 'autoAdjust'
              ? 'aiAutoAdjust'
              : 'aiDecouple';
  }
  close(): void {
    this.dialog = null;
    this.aiTaskDialog = null;
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
   * Returns a disposer to call when the work finishes; prefer withLoading,
   * which pairs the two for you.
   */
  beginLoading(label: string, options?: LoadingOptions): () => void {
    return this.loadingTracker.begin(label, options);
  }

  /** Run fn with a loading indicator registered for its duration. */
  async withLoading<T>(label: string, fn: () => Promise<T>, options?: LoadingOptions): Promise<T> {
    const done = this.beginLoading(label, options);
    try {
      return await fn();
    } finally {
      done();
    }
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
