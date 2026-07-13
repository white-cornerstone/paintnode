import { describe, expect, it } from 'vitest';
import modalSource from './Modal.svelte?raw';
import newDocumentDialogSource from './NewDocumentDialog.svelte?raw';
import keyboardSource from '../state/keyboard.ts?raw';

describe('modal keyboard UX contract', () => {
  it('gives shared modals keyboard priority over workspace shortcuts', () => {
    expect(modalSource).toContain('e.stopPropagation()');
    expect(modalSource).toContain('focusable[nextIndex]?.focus()');
    expect(keyboardSource).toContain('modalKeyboardScopeActive()');
    expect(keyboardSource).toContain("document.querySelector('[aria-modal=\"true\"]')");
  });

  it('autofocuses the selected New-dialog preset instead of its tab label', () => {
    expect(newDocumentDialogSource).toContain("data-autofocus={selectedImageId === preset.id ? '' : undefined}");
    expect(newDocumentDialogSource).toContain("data-autofocus={selectedWorkflowId === preset.id ? '' : undefined}");
    expect(newDocumentDialogSource).toContain('onImagePresetKeydown(event, preset)');
    expect(newDocumentDialogSource).toContain('onWorkflowPresetKeydown(event, preset)');
    expect(newDocumentDialogSource).not.toMatch(/id="new-tab-(?:image|workflow)"[^>]*data-autofocus/);
  });
});
