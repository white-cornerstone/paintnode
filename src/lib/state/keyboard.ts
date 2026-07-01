import { editor } from './editor.svelte';
import { openCommand, saveActiveCopyCommand, saveActiveCommand, exportPngCommand } from './commands';
import { isTypingTarget } from './editing';
import { ui } from './ui.svelte';

const TOOL_KEYS: Record<string, string> = {
  v: 'move',
  m: 'marquee',
  l: 'lasso',
  w: 'magicwand',
  c: 'crop',
  b: 'brush',
  e: 'eraser',
  s: 'clone',
  g: 'fill',
  r: 'gradient',
  o: 'dodge',
  u: 'shape',
  t: 'text',
  i: 'eyedropper',
  h: 'hand',
  z: 'zoom',
};

/** Install global keyboard shortcuts. Returns a cleanup function. */
export function installKeyboard(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (isTypingTarget(e.target)) return;
    const k = e.key.toLowerCase();
    const vp = editor.viewport;

    if (e.ctrlKey || e.metaKey) {
      switch (k) {
        case 'n':
          e.preventDefault();
          ui.open('new');
          return;
        case 'z':
          e.preventDefault();
          if (e.shiftKey) editor.redo();
          else editor.undo();
          return;
        case 'y':
          e.preventDefault();
          editor.redo();
          return;
        case 'a':
          e.preventDefault();
          editor.selectAll();
          return;
        case 'd':
          e.preventDefault();
          editor.deselect();
          return;
        case 'c':
          e.preventDefault();
          editor.copy();
          return;
        case 'x':
          e.preventDefault();
          editor.cut();
          return;
        case 'v':
          e.preventDefault();
          editor.paste();
          return;
        case 'i':
          e.preventDefault();
          if (e.shiftKey) editor.invertSelection();
          else editor.adjustInvert();
          return;
        case 's':
          e.preventDefault();
          if (e.shiftKey) void saveActiveCopyCommand();
          else void saveActiveCommand();
          return;
        case 'o':
          e.preventDefault();
          void openCommand();
          return;
        case 'e':
          e.preventDefault();
          void exportPngCommand();
          return;
        case 't':
          e.preventDefault();
          editor.beginFreeTransform();
          return;
        case '0':
          e.preventDefault();
          vp?.fitToView();
          return;
        case '1':
          e.preventDefault();
          vp?.setZoom(1);
          return;
        case '=':
        case '+':
          e.preventDefault();
          vp?.zoomBy(1.25);
          return;
        case '-':
          e.preventDefault();
          vp?.zoomBy(1 / 1.25);
          return;
      }
      return;
    }

    const hasDocumentSurface = ui.activeSurface === 'document' && !!editor.doc;

    if (hasDocumentSurface && k in TOOL_KEYS) {
      editor.setTool(TOOL_KEYS[k]);
      return;
    }

    if (!hasDocumentSurface) return;

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        editor.clearActive();
        return;
      case 'Enter':
        if (editor.freeTransform) {
          e.preventDefault();
          editor.commitFreeTransform();
          return;
        }
        if (editor.activeToolId === 'crop' && editor.selection) {
          e.preventDefault();
          editor.cropToSelection();
        }
        return;
      case 'Escape':
        if (editor.freeTransform) {
          e.preventDefault();
          editor.cancelFreeTransform();
          return;
        }
        if (editor.selection) editor.deselect();
        return;
      case '[':
        editor.brushSize = Math.max(1, Math.round(editor.brushSize - Math.max(1, editor.brushSize * 0.1)));
        return;
      case ']':
        editor.brushSize = Math.min(2000, Math.round(editor.brushSize + Math.max(1, editor.brushSize * 0.1)));
        return;
      case 'x':
      case 'X':
        editor.swapColors();
        return;
      case 'd':
      case 'D':
        editor.resetColors();
        return;
    }
  };

  // Track Alt/Option for the live zoom-mode preview (icon + In/Out toggle).
  const onAltDown = (e: KeyboardEvent) => {
    if (e.key === 'Alt') editor.altDown = true;
  };
  const onAltUp = (e: KeyboardEvent) => {
    if (e.key === 'Alt') editor.altDown = false;
  };
  const onBlur = () => {
    editor.altDown = false; // don't get stuck "held" if focus leaves mid-press
  };

  window.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onAltDown);
  window.addEventListener('keyup', onAltUp);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onAltDown);
    window.removeEventListener('keyup', onAltUp);
    window.removeEventListener('blur', onBlur);
  };
}
