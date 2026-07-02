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

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    return document.execCommand('copy');
  }
}

async function readClipboard(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText()) ?? null;
  } catch {
    return null;
  }
}

export function runEditableMenuAction(id: string, doc: Document = document): boolean {
  const el = editableElement(doc.activeElement);
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
      if (isTextControl(el)) {
        void readClipboard().then((text) => {
          if (text !== null) replaceSelection(el, text);
          else document.execCommand('paste');
        });
      } else {
        document.execCommand('paste');
      }
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
