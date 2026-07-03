import { readDesktopClipboardText, writeDesktopClipboardText } from '../integrations/desktop';

type TextControl = HTMLInputElement | HTMLTextAreaElement;

const TEXT_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
]);

function isTextControl(el: Element | null): el is TextControl {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type);
}

export function editableElement(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const candidate = target.closest('input, textarea, select, [contenteditable]');
  if (!(candidate instanceof HTMLElement)) return null;
  if (candidate instanceof HTMLSelectElement) return candidate;
  if (isTextControl(candidate)) return candidate;
  return candidate.isContentEditable ? candidate : null;
}

export function isTypingTarget(target: EventTarget | null): boolean {
  return editableElement(target) !== null;
}

let lastEditable: HTMLElement | null = null;

function rememberEditable(target: EventTarget | null): void {
  const el = editableElement(target);
  if (el) lastEditable = el;
}

function forgetEditableIfOutside(target: EventTarget | null): void {
  if (!editableElement(target)) lastEditable = null;
}

function activeEditableElement(doc: Document): HTMLElement | null {
  const active = editableElement(doc.activeElement);
  if (active) return active;
  if (lastEditable?.ownerDocument === doc && lastEditable.isConnected) return lastEditable;
  return null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (event) => rememberEditable(event.target), true);
  document.addEventListener('pointerdown', (event) => forgetEditableIfOutside(event.target), true);
  document.addEventListener('keydown', (event) => {
    if (!event.metaKey && !event.ctrlKey) forgetEditableIfOutside(event.target);
  }, true);
}

function selectedText(el: TextControl): string {
  const start = el.selectionStart ?? 0;
  const end = el.selectionEnd ?? start;
  return el.value.slice(start, end);
}

function replaceSelection(el: TextControl, text: string): void {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  el.setRangeText(text, start, end, 'end');
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: text ? 'insertText' : 'deleteByCut', data: text || null }));
}

function insertEditableText(el: HTMLElement, text: string): void {
  el.focus();
  document.execCommand('insertText', false, text);
}

async function writeClipboard(text: string): Promise<boolean> {
  if (await writeDesktopClipboardText(text)) return true;
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    return document.execCommand('copy');
  }
}

async function readClipboard(): Promise<string | null> {
  const desktopText = await readDesktopClipboardText();
  if (desktopText !== null) return desktopText;
  try {
    return (await navigator.clipboard?.readText()) ?? null;
  } catch {
    return null;
  }
}

export function runEditableMenuAction(id: string, doc: Document = document): boolean {
  const el = activeEditableElement(doc);
  if (!el) return false;

  switch (id) {
    case 'app:cut':
      if (isTextControl(el)) {
        const text = selectedText(el);
        if (!text) return true;
        void writeClipboard(text).then((ok) => {
          if (ok) replaceSelection(el, '');
        });
      } else {
        document.execCommand('cut');
      }
      return true;
    case 'app:copy':
      if (isTextControl(el)) {
        const text = selectedText(el);
        if (text) void writeClipboard(text);
      } else {
        document.execCommand('copy');
      }
      return true;
    case 'app:paste':
      void readClipboard().then((text) => {
        if (text !== null) {
          if (isTextControl(el)) replaceSelection(el, text);
          else insertEditableText(el, text);
        }
      });
      return true;
    case 'app:undo':
      document.execCommand('undo');
      return true;
    case 'app:redo':
      document.execCommand('redo');
      return true;
    case 'app:select-all':
      if (isTextControl(el)) el.select();
      else document.execCommand('selectAll');
      return true;
    default:
      return false;
  }
}
