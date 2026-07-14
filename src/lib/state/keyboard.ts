import { editor } from './editor.svelte';
import { openCommand, saveActiveCopyCommand, saveActiveCommand } from './commands';
import { isTypingTarget } from './editing';
import { ui } from './ui.svelte';
import { workflow } from './workflow.svelte';
import { aiTasks } from './aiTasks.svelte';
import { nextAiRetouchTool } from '../engine/aiRetouch';

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

function modalKeyboardScopeActive(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

function workflowAuthoringLocked(): boolean {
  return workflow.active
    && aiTasks.runningForWorkflow(workflow.graphSnapshot().id).length > 0;
}

/** Install global keyboard shortcuts. Returns a cleanup function. */
export function installKeyboard(): () => void {
  const onCopy = (e: ClipboardEvent) => {
    if (modalKeyboardScopeActive() || isTypingTarget(e.target) || !editor.activeLayer) return;
    e.preventDefault();
    editor.copy();
  };
  const onCut = (e: ClipboardEvent) => {
    const layer = editor.activeLayer;
    if (modalKeyboardScopeActive() || isTypingTarget(e.target) || !layer || layer.locked) return;
    e.preventDefault();
    editor.cut();
  };
  const onPaste = (e: ClipboardEvent) => {
    if (modalKeyboardScopeActive() || isTypingTarget(e.target) || ui.activeSurface !== 'document' || !editor.doc || !editor.clipboard) return;
    e.preventDefault();
    editor.paste();
  };
  const onKey = (e: KeyboardEvent) => {
    if (modalKeyboardScopeActive() || isTypingTarget(e.target)) return;

    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      ui.toggleWorkspaceFocusMode();
      return;
    }

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
          if (ui.activeSurface === 'workflow' && workflow.active) {
            if (!workflowAuthoringLocked()) {
              if (e.shiftKey) workflow.redoAuthoring();
              else workflow.undoAuthoring();
            }
          } else if (e.shiftKey) editor.redo();
          else editor.undo();
          return;
        case 'y':
          e.preventDefault();
          if (ui.activeSurface === 'workflow' && workflow.active) {
            if (!workflowAuthoringLocked()) workflow.redoAuthoring();
          }
          else editor.redo();
          return;
        case 'a':
          e.preventDefault();
          editor.selectAll();
          return;
        case 'b':
          if (e.shiftKey && !e.altKey) {
            e.preventDefault();
            ui.openAiAutoAdjust('color');
            return;
          }
          break;
        case 'd':
          e.preventDefault();
          editor.deselect();
          return;
        case 'c':
          e.preventDefault();
          if (e.altKey && !e.shiftKey) ui.open('canvasSize');
          else editor.copy();
          return;
        case 'x':
          e.preventDefault();
          editor.cut();
          return;
        case 'v':
          if (ui.activeSurface === 'workflow') return;
          e.preventDefault();
          editor.paste();
          return;
        case 'i':
          e.preventDefault();
          if (e.altKey && !e.shiftKey) ui.open('imageSize');
          else if (e.shiftKey && !e.altKey) editor.invertSelection();
          else editor.adjustInvert();
          return;
        case 'l':
          e.preventDefault();
          if (e.altKey && e.shiftKey) ui.openAiAutoAdjust('contrast');
          else if (e.shiftKey && !e.altKey) ui.openAiAutoAdjust('tone');
          else if (!e.altKey) ui.open('levels');
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
          if (editor.activeLayer?.id) editor.mergeDown(editor.activeLayer.id);
          return;
        case 't':
          e.preventDefault();
          editor.beginFreeTransform();
          return;
        case 'u':
          e.preventDefault();
          if (e.altKey && e.shiftKey) ui.open('aiUpscale');
          else if (e.shiftKey && !e.altKey) editor.adjustDesaturate();
          else if (!e.altKey) ui.open('hueSaturation');
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

    if (hasDocumentSurface && k === 'j') {
      const next = e.shiftKey ? nextAiRetouchTool(editor.lastAiRetouchTool) : editor.lastAiRetouchTool;
      editor.setTool(next);
      return;
    }

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

  document.addEventListener('copy', onCopy);
  document.addEventListener('cut', onCut);
  document.addEventListener('paste', onPaste);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onAltDown);
  window.addEventListener('keyup', onAltUp);
  window.addEventListener('blur', onBlur);
  return () => {
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('cut', onCut);
    document.removeEventListener('paste', onPaste);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keydown', onAltDown);
    window.removeEventListener('keyup', onAltUp);
    window.removeEventListener('blur', onBlur);
  };
}
