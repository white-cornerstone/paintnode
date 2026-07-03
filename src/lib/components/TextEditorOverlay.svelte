<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { editor } from '../state/editor.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { TextBold, TextItalic, TextUnderline, TextAlignLeft, TextAlignCenter, TextAlignRight, Add } from '../icons';
  import { fonts } from '../state/fonts.svelte';
  import { rgbToHex } from '../engine/color';
  import {
    AUTO_LEADING,
    defaultParagraph,
    defaultStyle,
    stylesEqual,
    type TextAlign,
    type TextCaps,
    type TextModel,
    type TextParagraph,
    type TextScript,
    type TextStyle,
  } from '../engine/text/model';
  import type { RGB } from '../engine/types';

  let { box }: { box: { left: number; top: number; scale: number } } = $props();

  const session = $derived(editor.textEdit);

  let editable = $state<HTMLDivElement>();
  let savedRange: Range | null = null;

  // Toolbar values (reflect the current selection).
  let curFamily = $state('sans-serif');
  let curSize = $state(72);
  let curColor = $state('#000000');
  let curTracking = $state(0);
  let curBold = $state(false);
  let curItalic = $state(false);
  let curUnderline = $state(false);
  let curAlign = $state<TextAlign>('left');

  const BLOCK_TAGS = new Set(['DIV', 'P']);

  async function importFont(): Promise<void> {
    const family = await fonts.importViaPicker();
    if (family) setFamily(family);
  }

  // --- model -> DOM ---

  function styleToCss(s: TextStyle): string {
    const deco =
      [s.underline ? 'underline' : '', s.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ') || 'none';
    const capsCss = s.caps === 'all' ? 'text-transform:uppercase;' : s.caps === 'small' ? 'font-variant-caps:small-caps;' : '';
    const scriptCss = s.script === 'super' ? 'vertical-align:super;' : s.script === 'sub' ? 'vertical-align:sub;' : '';
    return (
      `font-family:${s.family};font-size:${s.size}px;color:${rgbToHex(s.color)};` +
      `font-weight:${s.bold ? 700 : 400};font-style:${s.italic ? 'italic' : 'normal'};` +
      `text-decoration:${deco};` +
      `letter-spacing:${s.tracking ? `${s.tracking}px` : 'normal'};` +
      capsCss +
      scriptCss
    );
  }

  /**
   * Attributes CSS cannot round-trip (scales, baseline shift, exact leading, caps,
   * script) ride on data attributes; styleOfEl reads them back via `closest()`.
   */
  function applyStyleAttrs(el: HTMLElement, s: TextStyle): void {
    el.setAttribute('style', styleToCss(s));
    el.setAttribute('data-pn-leading', s.leading === null ? 'auto' : String(s.leading));
    el.setAttribute('data-pn-hscale', String(s.horizontalScale));
    el.setAttribute('data-pn-vscale', String(s.verticalScale));
    el.setAttribute('data-pn-bshift', String(s.baselineShift));
    el.setAttribute('data-pn-caps', s.caps);
    el.setAttribute('data-pn-script', s.script);
  }

  function applyParagraphAttrs(div: HTMLElement, p: TextParagraph): void {
    div.style.textAlign = p.align.startsWith('justify') ? 'left' : p.align;
    const leading = p.runs.reduce(
      (mx, r) => Math.max(mx, r.style.leading ?? AUTO_LEADING * r.style.size * (r.style.verticalScale / 100)),
      0,
    );
    if (leading > 0) div.style.lineHeight = `${leading}px`;
    if (p.firstLineIndent) div.style.textIndent = `${p.firstLineIndent}px`;
    if (p.indentLeft) div.style.paddingLeft = `${p.indentLeft}px`;
    if (p.indentRight) div.style.paddingRight = `${p.indentRight}px`;
    if (p.spaceBefore) div.style.marginTop = `${p.spaceBefore}px`;
    if (p.spaceAfter) div.style.marginBottom = `${p.spaceAfter}px`;
    div.setAttribute('data-pn-align', p.align);
    div.setAttribute('data-pn-indent-left', String(p.indentLeft));
    div.setAttribute('data-pn-indent-right', String(p.indentRight));
    div.setAttribute('data-pn-indent-first', String(p.firstLineIndent));
    div.setAttribute('data-pn-space-before', String(p.spaceBefore));
    div.setAttribute('data-pn-space-after', String(p.spaceAfter));
    div.setAttribute('data-pn-hyphenate', p.hyphenate ? '1' : '0');
  }

  function buildFromModel(model: TextModel): void {
    const root = editable;
    if (!root) return;
    const base = session?.baseStyle ?? defaultStyle();
    applyStyleAttrs(root, base);
    root.innerHTML = '';
    const paragraphs = model.paragraphs.length
      ? model.paragraphs
      : [defaultParagraph({ runs: [{ text: '', style: base }] })];
    for (const p of paragraphs) {
      const div = document.createElement('div');
      applyParagraphAttrs(div, p);
      const hasText = p.runs.some((r) => r.text.length > 0);
      if (!hasText) {
        div.appendChild(document.createElement('br'));
      } else {
        for (const r of p.runs) {
          if (!r.text) continue;
          const span = document.createElement('span');
          applyStyleAttrs(span, r.style);
          span.textContent = r.text;
          div.appendChild(span);
        }
      }
      root.appendChild(div);
    }
  }

  // --- DOM -> model ---

  function cleanFamily(ff: string): string {
    return ff
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean)
      .join(', ');
  }

  function parseCssColor(c: string): RGB | null {
    const m = c.match(/rgba?\(([^)]+)\)/i);
    if (!m) return null;
    const parts = m[1].split(',').map((s) => parseFloat(s));
    return { r: Math.round(parts[0] || 0), g: Math.round(parts[1] || 0), b: Math.round(parts[2] || 0) };
  }

  function alignFrom(a: string): TextAlign {
    return a === 'center' ? 'center' : a === 'right' || a === 'end' ? 'right' : 'left';
  }

  /** Read a data attribute from the element or its nearest annotated ancestor. */
  function dataAttr(el: HTMLElement, name: string): string | null {
    const holder = el.closest(`[data-${name}]`);
    return holder instanceof HTMLElement ? holder.getAttribute(`data-${name}`) : null;
  }

  function dataNum(el: HTMLElement, name: string, fallback: number): number {
    const raw = dataAttr(el, name);
    const value = raw === null ? NaN : parseFloat(raw);
    return Number.isFinite(value) ? value : fallback;
  }

  function styleOfEl(el: Element | null): TextStyle {
    const base = session?.baseStyle ?? defaultStyle();
    if (!el || !(el instanceof HTMLElement)) return base;
    const cs = getComputedStyle(el);
    const weight = parseInt(cs.fontWeight, 10);
    const deco = `${cs.textDecorationLine} ${cs.textDecoration}`;
    const leadingRaw = dataAttr(el, 'pn-leading');
    const leading = leadingRaw !== null && leadingRaw !== 'auto' && Number.isFinite(parseFloat(leadingRaw))
      ? parseFloat(leadingRaw)
      : null;
    const capsRaw = dataAttr(el, 'pn-caps');
    const caps: TextCaps =
      capsRaw === 'small' || capsRaw === 'all'
        ? capsRaw
        : cs.textTransform === 'uppercase'
          ? 'all'
          : cs.fontVariantCaps === 'small-caps'
            ? 'small'
            : 'none';
    const scriptRaw = dataAttr(el, 'pn-script');
    const script: TextScript =
      scriptRaw === 'super' || scriptRaw === 'sub'
        ? scriptRaw
        : cs.verticalAlign === 'super'
          ? 'super'
          : cs.verticalAlign === 'sub'
            ? 'sub'
            : 'none';
    return defaultStyle({
      family: cleanFamily(cs.fontFamily) || base.family,
      size: Math.round(parseFloat(cs.fontSize)) || base.size,
      color: parseCssColor(cs.color) ?? base.color,
      bold: (Number.isFinite(weight) && weight >= 600) || cs.fontWeight === 'bold',
      italic: cs.fontStyle === 'italic' || cs.fontStyle.startsWith('oblique'),
      underline: deco.includes('underline'),
      strikethrough: deco.includes('line-through'),
      tracking: cs.letterSpacing && cs.letterSpacing !== 'normal' ? Math.round(parseFloat(cs.letterSpacing)) || 0 : 0,
      leading,
      horizontalScale: dataNum(el, 'pn-hscale', 100),
      verticalScale: dataNum(el, 'pn-vscale', 100),
      baselineShift: dataNum(el, 'pn-bshift', 0),
      caps,
      script,
    });
  }

  /** Paragraph attributes for a block element (dataset first, CSS fallback). */
  function paragraphFromBlock(el: HTMLElement | null): Omit<TextParagraph, 'runs'> {
    if (!el) return defaultParagraph();
    const alignRaw = el.getAttribute('data-pn-align');
    const align: TextAlign =
      alignRaw === 'center' || alignRaw === 'right' || alignRaw === 'left' ||
      alignRaw === 'justify-left' || alignRaw === 'justify-center' || alignRaw === 'justify-right' ||
      alignRaw === 'justify-all'
        ? alignRaw
        : alignFrom(getComputedStyle(el).textAlign);
    const attr = (name: string) => {
      const v = el.getAttribute(`data-${name}`);
      const parsed = v === null ? NaN : parseFloat(v);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return defaultParagraph({
      align,
      indentLeft: attr('pn-indent-left'),
      indentRight: attr('pn-indent-right'),
      firstLineIndent: attr('pn-indent-first'),
      spaceBefore: attr('pn-space-before'),
      spaceAfter: attr('pn-space-after'),
      hyphenate: el.getAttribute('data-pn-hyphenate') === '1',
    });
  }

  function serialize(): TextModel {
    const root = editable;
    const lines: TextParagraph[] = [];
    let pending: Omit<TextParagraph, 'runs'> = defaultParagraph();
    let cur: TextParagraph | null = null;
    const ensure = () => {
      if (!cur) {
        cur = { ...pending, runs: [] };
        lines.push(cur);
      }
    };
    const addRun = (text: string, style: TextStyle) => {
      if (!text) return;
      ensure();
      const runs = cur!.runs;
      const last = runs[runs.length - 1];
      if (last && stylesEqual(last.style, style)) last.text += text;
      else runs.push({ text, style });
    };
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        addRun(node.textContent ?? '', styleOfEl(node.parentElement));
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      if (el.tagName === 'BR') {
        ensure();
        cur = null;
        return;
      }
      if (BLOCK_TAGS.has(el.tagName)) {
        cur = null;
        pending = paragraphFromBlock(el);
        for (const c of Array.from(el.childNodes)) walk(c);
        cur = null;
        return;
      }
      for (const c of Array.from(el.childNodes)) walk(c);
    };
    if (root) for (const c of Array.from(root.childNodes)) walk(c);
    if (!lines.length) {
      lines.push(defaultParagraph({ runs: [{ text: '', style: session?.baseStyle ?? defaultStyle() }] }));
    }
    return { version: 1, x: Math.round(session!.model.x), y: Math.round(session!.model.y), paragraphs: lines };
  }

  // --- commit / cancel ---

  function doCommit(): void {
    editor.commitText(serialize());
  }
  function doCancel(): void {
    editor.cancelText();
  }

  // --- selection plumbing ---

  function onSelectionChange(): void {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !editable) return;
    const r = sel.getRangeAt(0);
    if (editable.contains(r.commonAncestorContainer)) {
      savedRange = r.cloneRange();
      refreshToolbar();
    }
  }
  function restore(): void {
    if (!editable) return;
    editable.focus();
    if (savedRange) {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(savedRange);
      }
    }
  }
  function selectAllContent(): void {
    if (!editable) return;
    const sel = window.getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.selectNodeContents(editable);
    sel.removeAllRanges();
    sel.addRange(r);
    savedRange = r.cloneRange();
  }
  function ensureSelection(): void {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.getRangeAt(0).collapsed) selectAllContent();
  }
  function placeCaretEnd(): void {
    if (!editable) return;
    const sel = window.getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.selectNodeContents(editable);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
    savedRange = r.cloneRange();
  }

  // --- formatting ---

  function exec(cmd: string, value: string = ''): void {
    restore();
    ensureSelection();
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, value);
    refreshToolbar();
  }
  function toggleBold(): void {
    exec('bold');
  }
  function toggleItalic(): void {
    exec('italic');
  }
  function toggleUnderline(): void {
    exec('underline');
  }
  function setFamily(f: string): void {
    curFamily = f;
    exec('fontName', f);
  }
  function setColor(hex: string): void {
    curColor = hex;
    exec('foreColor', hex);
  }
  function setAlign(a: TextAlign): void {
    curAlign = a;
    restore();
    ensureSelection();
    document.execCommand(a === 'center' ? 'justifyCenter' : a === 'right' ? 'justifyRight' : 'justifyLeft');
    refreshToolbar();
  }
  function wrapStyle(prop: 'fontSize' | 'letterSpacing', value: string): void {
    restore();
    ensureSelection();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;
    const span = document.createElement('span');
    span.style[prop] = value;
    try {
      span.appendChild(range.extractContents());
      range.insertNode(span);
      const nr = document.createRange();
      nr.selectNodeContents(span);
      sel.removeAllRanges();
      sel.addRange(nr);
      savedRange = nr.cloneRange();
    } catch {
      /* range spanned an unsplittable boundary; ignore */
    }
    refreshToolbar();
  }
  function setSize(px: number): void {
    curSize = px;
    wrapStyle('fontSize', `${px}px`);
  }
  function setTracking(px: number): void {
    curTracking = px;
    wrapStyle('letterSpacing', `${px}px`);
  }

  function closestBlock(el: Element | null): Element | null {
    let n = el;
    while (n && n !== editable) {
      if (BLOCK_TAGS.has(n.tagName)) return n;
      n = n.parentElement;
    }
    return null;
  }

  function refreshToolbar(): void {
    const sel = window.getSelection();
    let el: Element | null = null;
    if (sel && sel.rangeCount) {
      const n = sel.getRangeAt(0).startContainer;
      el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
    }
    el = el ?? editable ?? null;
    const st = styleOfEl(el);
    curFamily = st.family;
    curSize = st.size;
    curColor = rgbToHex(st.color);
    curTracking = st.tracking;
    curBold = st.bold;
    curItalic = st.italic;
    curUnderline = st.underline;
    const block = closestBlock(el) ?? editable;
    if (block instanceof HTMLElement) {
      curAlign = paragraphFromBlock(block).align;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      doCommit();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      doCommit();
    }
  }

  onMount(() => {
    editor.registerTextCommit(doCommit);
    document.addEventListener('selectionchange', onSelectionChange);
    if (session) buildFromModel(session.model);
    void tick().then(() => {
      editable?.focus();
      if (session?.isNew) placeCaretEnd();
      else selectAllContent();
      refreshToolbar();
    });
  });
  onDestroy(() => {
    editor.registerTextCommit(null);
    document.removeEventListener('selectionchange', onSelectionChange);
  });

  // Keep the toolbar above the text box, never off the top of the screen.
  const toolbarTop = $derived(Math.max(6, box.top - 44));
</script>

<!-- Formatting toolbar (chrome — not scaled with the canvas). -->
<div
  class="type-toolbar"
  style="left:{box.left}px; top:{toolbarTop}px"
  role="toolbar"
  tabindex="-1"
  onpointerdown={(e) => e.stopPropagation()}
>
  <select
    class="family"
    value={curFamily}
    onchange={(e) => setFamily((e.currentTarget as HTMLSelectElement).value)}
    use:tooltip={{ text: 'Font family', placement: 'top' }}
    aria-label="Font family"
  >
    {#each fonts.all as f (f)}
      <option value={f} style="font-family:{f}">{f}</option>
    {/each}
  </select>
  <button
    class="import"
    onmousedown={(e) => e.preventDefault()}
    onclick={importFont}
    use:tooltip={{ text: 'Import font…', placement: 'top' }}
    aria-label="Import font"><Icon svg={Add} size={15} /></button
  >

  <input
    class="size"
    type="number"
    min="4"
    max="800"
    value={curSize}
    onchange={(e) => setSize(Math.max(4, +(e.currentTarget as HTMLInputElement).value || 4))}
    use:tooltip={{ text: 'Font size (px)', placement: 'top' }}
    aria-label="Font size"
  />

  <input
    class="color"
    type="color"
    value={curColor}
    oninput={(e) => setColor((e.currentTarget as HTMLInputElement).value)}
    use:tooltip={{ text: 'Text color', placement: 'top' }}
    aria-label="Text color"
  />

  <span class="sep"></span>

  <button
    class:on={curBold}
    onmousedown={(e) => e.preventDefault()}
    onclick={toggleBold}
    use:tooltip={{ text: 'Bold', placement: 'top' }}
    aria-label="Bold"><Icon svg={TextBold} size={16} /></button
  >
  <button
    class:on={curItalic}
    onmousedown={(e) => e.preventDefault()}
    onclick={toggleItalic}
    use:tooltip={{ text: 'Italic', placement: 'top' }}
    aria-label="Italic"><Icon svg={TextItalic} size={16} /></button
  >
  <button
    class:on={curUnderline}
    onmousedown={(e) => e.preventDefault()}
    onclick={toggleUnderline}
    use:tooltip={{ text: 'Underline', placement: 'top' }}
    aria-label="Underline"><Icon svg={TextUnderline} size={16} /></button
  >

  <span class="sep"></span>

  <button
    class:on={curAlign === 'left'}
    onmousedown={(e) => e.preventDefault()}
    onclick={() => setAlign('left')}
    use:tooltip={{ text: 'Align left', placement: 'top' }}
    aria-label="Align left"><Icon svg={TextAlignLeft} size={16} /></button
  >
  <button
    class:on={curAlign === 'center'}
    onmousedown={(e) => e.preventDefault()}
    onclick={() => setAlign('center')}
    use:tooltip={{ text: 'Align center', placement: 'top' }}
    aria-label="Align center"><Icon svg={TextAlignCenter} size={16} /></button
  >
  <button
    class:on={curAlign === 'right'}
    onmousedown={(e) => e.preventDefault()}
    onclick={() => setAlign('right')}
    use:tooltip={{ text: 'Align right', placement: 'top' }}
    aria-label="Align right"><Icon svg={TextAlignRight} size={16} /></button
  >

  <span class="sep"></span>

  <input
    class="tracking"
    type="number"
    min="-20"
    max="200"
    value={curTracking}
    onchange={(e) => setTracking(+(e.currentTarget as HTMLInputElement).value || 0)}
    use:tooltip={{ text: 'Letter spacing (tracking)', placement: 'top' }}
    aria-label="Letter spacing"
  />

  <span class="sep"></span>

  <button class="done" onmousedown={(e) => e.preventDefault()} onclick={doCommit}>Done</button>
  <button class="cancel" onmousedown={(e) => e.preventDefault()} onclick={doCancel}>Cancel</button>
</div>

<!-- The scaled, editable text box positioned over the canvas. -->
<div class="type-box" style="left:{box.left}px; top:{box.top}px; transform:scale({box.scale})">
  <div
    class="editable"
    bind:this={editable}
    contenteditable="true"
    role="textbox"
    tabindex="0"
    aria-label="Text"
    spellcheck="false"
    onkeydown={onKeydown}
    onpointerdown={(e) => e.stopPropagation()}
  ></div>
</div>

<style>
  .type-toolbar {
    position: fixed;
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 3px;
    padding: 4px 6px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    max-width: 96vw;
    flex-wrap: nowrap;
  }
  .type-toolbar button {
    width: 26px;
    height: 24px;
    display: grid;
    place-items: center;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
  }
  .type-toolbar button:hover {
    background: var(--bg-panel-2);
  }
  .type-toolbar button.on {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .type-toolbar .family {
    width: 116px;
  }
  .type-toolbar .size,
  .type-toolbar .tracking {
    width: 50px;
  }
  .type-toolbar .color {
    width: 26px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: transparent;
  }
  .type-toolbar .sep {
    width: 1px;
    height: 18px;
    background: var(--border-soft);
    margin: 0 2px;
  }
  .type-toolbar .done,
  .type-toolbar .cancel {
    width: auto;
    padding: 0 8px;
    font-size: 12px;
  }
  .type-toolbar .done {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }

  .type-box {
    position: fixed;
    z-index: 79;
    transform-origin: 0 0;
  }
  .editable {
    display: inline-block;
    min-width: 4px;
    white-space: pre;
    outline: 1px dashed var(--accent);
    outline-offset: 1px;
    cursor: text;
    /* Selection highlight inside the editable should be visible over any color. */
  }
  .editable :global(div) {
    min-height: 1em;
  }
</style>
