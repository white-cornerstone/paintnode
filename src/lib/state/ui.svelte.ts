// Lightweight reactive UI state (status bar readouts + which modal dialog is open).
export type DialogId =
  | 'new'
  | 'about'
  | 'imageSize'
  | 'brightnessContrast'
  | 'hueSaturation'
  | 'gaussianBlur'
  | 'aiGenerate';

class UiState {
  cursor = $state<{ x: number; y: number } | null>(null);
  zoom = $state(1);
  dialog = $state<DialogId | null>(null);

  open(id: DialogId): void {
    this.dialog = id;
  }
  close(): void {
    this.dialog = null;
  }
}

export const ui = new UiState();
