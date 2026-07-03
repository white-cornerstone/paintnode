import type { Action } from 'svelte/action';

type Placement = 'top' | 'bottom' | 'left' | 'right';

export interface TooltipOptions {
  text: string;
  placement?: Placement;
  /** Hover delay in ms before the tooltip appears. */
  delay?: number;
}

export type TooltipParam = string | TooltipOptions;

// A single shared tooltip element — only one tooltip is ever visible at a time.
let tipEl: HTMLDivElement | null = null;
let showTimer = 0;
let current: HTMLElement | null = null;

function ensureEl(): HTMLDivElement {
  if (tipEl) return tipEl;
  const el = document.createElement('div');
  el.className = 'paintnode-tooltip';
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  tipEl = el;
  return el;
}

function place(anchor: HTMLElement, placement: Placement): void {
  const tip = ensureEl();
  const a = anchor.getBoundingClientRect();
  const t = tip.getBoundingClientRect();
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const compute = (p: Placement): { top: number; left: number } => {
    switch (p) {
      case 'bottom':
        return { top: a.bottom + gap, left: a.left + a.width / 2 - t.width / 2 };
      case 'left':
        return { top: a.top + a.height / 2 - t.height / 2, left: a.left - t.width - gap };
      case 'right':
        return { top: a.top + a.height / 2 - t.height / 2, left: a.right + gap };
      case 'top':
      default:
        return { top: a.top - t.height - gap, left: a.left + a.width / 2 - t.width / 2 };
    }
  };

  let { top, left } = compute(placement);
  // Flip to the opposite side if it would overflow the viewport.
  if (placement === 'top' && top < 4) ({ top, left } = compute('bottom'));
  else if (placement === 'bottom' && top + t.height > vh - 4) ({ top, left } = compute('top'));
  else if (placement === 'left' && left < 4) ({ top, left } = compute('right'));
  else if (placement === 'right' && left + t.width > vw - 4) ({ top, left } = compute('left'));

  // Clamp into the viewport.
  left = Math.max(4, Math.min(left, vw - t.width - 4));
  top = Math.max(4, Math.min(top, vh - t.height - 4));
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

function show(anchor: HTMLElement, opts: TooltipOptions): void {
  if (!opts.text) return;
  const tip = ensureEl();
  tip.textContent = opts.text;
  place(anchor, opts.placement ?? 'top'); // measures + positions while opacity:0
  tip.classList.add('visible');
  current = anchor;
}

function hide(anchor?: HTMLElement): void {
  if (anchor && current !== anchor) return;
  tipEl?.classList.remove('visible');
  current = null;
}

const normalize = (p: TooltipParam): TooltipOptions =>
  typeof p === 'string' ? { text: p } : p;

/**
 * `use:truncatedTooltip={{ text, placement }}` — like `tooltip`, but only shows
 * when the element's content is visually cropped (ellipsized), so labels that
 * fit stay quiet.
 */
export const truncatedTooltip: Action<HTMLElement, TooltipParam> = (node, param) => {
  let opts = normalize(param);
  const cropped = () =>
    node.scrollWidth - node.clientWidth > 1 || node.scrollHeight - node.clientHeight > 1;

  const open = () => {
    if (!cropped()) return;
    clearTimeout(showTimer);
    showTimer = window.setTimeout(() => show(node, opts), opts.delay ?? 300);
  };
  const close = () => {
    clearTimeout(showTimer);
    hide(node);
  };

  node.addEventListener('pointerenter', open);
  node.addEventListener('pointerleave', close);
  node.addEventListener('pointerdown', close);
  node.addEventListener('focus', open);
  node.addEventListener('blur', close);

  return {
    update(p: TooltipParam) {
      opts = normalize(p);
    },
    destroy() {
      node.removeEventListener('pointerenter', open);
      node.removeEventListener('pointerleave', close);
      node.removeEventListener('pointerdown', close);
      node.removeEventListener('focus', open);
      node.removeEventListener('blur', close);
      hide(node);
    },
  };
};

/**
 * `use:tooltip={'New Layer'}` or `use:tooltip={{ text, placement: 'right' }}`.
 * Shows a styled tooltip on hover/focus. Attach to the interactive control (e.g. the button).
 */
export const tooltip: Action<HTMLElement, TooltipParam> = (node, param) => {
  let opts = normalize(param);

  const open = () => {
    clearTimeout(showTimer);
    showTimer = window.setTimeout(() => show(node, opts), opts.delay ?? 300);
  };
  const close = () => {
    clearTimeout(showTimer);
    hide(node);
  };

  node.addEventListener('pointerenter', open);
  node.addEventListener('pointerleave', close);
  node.addEventListener('pointerdown', close);
  node.addEventListener('focus', open);
  node.addEventListener('blur', close);

  return {
    update(p: TooltipParam) {
      opts = normalize(p);
      if (current === node) show(node, opts); // live-refresh if currently shown
    },
    destroy() {
      node.removeEventListener('pointerenter', open);
      node.removeEventListener('pointerleave', close);
      node.removeEventListener('pointerdown', close);
      node.removeEventListener('focus', open);
      node.removeEventListener('blur', close);
      hide(node);
    },
  };
};
