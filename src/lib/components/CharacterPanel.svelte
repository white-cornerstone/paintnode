<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { fonts } from '../state/fonts.svelte';
  import Panel from './Panel.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import {
    TextBold,
    TextItalic,
    TextUnderline,
    TextStrikethrough,
    TextCaseUppercase,
    TextCaseTitle,
    TextSubscript,
    TextSuperscript,
  } from '../icons';
  import { hexToRgb, rgbToHex } from '../engine/color';
  import { AUTO_LEADING, type TextAntiAlias, type TextStyle } from '../engine/text/model';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  const layerModel = $derived(editor.panelTextLayer?.text ?? null);
  const style = $derived(editor.textEdit ? editor.liveTextStyle : (layerModel?.paragraphs[0]?.runs[0]?.style ?? null));
  const antiAlias = $derived(
    editor.textEdit ? (editor.textEdit.model.antiAlias ?? 'smooth') : (layerModel?.antiAlias ?? 'smooth'),
  );

  const fontStyleValue = $derived(
    !style ? 'regular' : style.bold ? (style.italic ? 'bold-italic' : 'bold') : style.italic ? 'italic' : 'regular',
  );

  function apply(patch: Partial<TextStyle>): void {
    editor.applyCharacterStyle(patch);
  }

  function setFontStyle(value: string): void {
    apply({ bold: value.includes('bold'), italic: value.includes('italic') });
  }

  function numberOr(value: string, fallback: number): number {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function setLeading(value: string): void {
    if (!style) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === 'auto') {
      apply({ leading: null });
      return;
    }
    const parsed = parseFloat(trimmed);
    if (Number.isFinite(parsed) && parsed > 0) apply({ leading: parsed });
  }

  function setColor(hex: string): void {
    const rgb = hexToRgb(hex);
    if (rgb) apply({ color: rgb });
  }
</script>

<Panel title="Character" bind:collapsed {onToggle}>
  <div class="character">
    {#if style}
      <label class="field">
        <select
          class="family"
          value={style.family}
          onchange={(e) => apply({ family: e.currentTarget.value })}
          aria-label="Font family"
        >
          {#each fonts.all as f (f)}
            <option value={f} style="font-family:{f}">{f}</option>
          {/each}
          {#if !fonts.all.includes(style.family)}
            <option value={style.family}>{style.family}</option>
          {/if}
        </select>
        <select
          class="face"
          value={fontStyleValue}
          onchange={(e) => setFontStyle(e.currentTarget.value)}
          aria-label="Font style"
        >
          <option value="regular">Regular</option>
          <option value="italic">Italic</option>
          <option value="bold">Bold</option>
          <option value="bold-italic">Bold Italic</option>
        </select>
      </label>

      <div class="grid">
        <label use:tooltip={{ text: 'Font size (px)', placement: 'left' }}>
          <span>Size</span>
          <input
            type="number"
            min="1"
            value={Math.round(style.size)}
            onchange={(e) => apply({ size: Math.max(1, numberOr(e.currentTarget.value, style.size)) })}
            aria-label="Font size"
          />
        </label>
        <label use:tooltip={{ text: 'Leading — line spacing in px; empty = Auto (120%)', placement: 'right' }}>
          <span>Leading</span>
          <input
            type="text"
            inputmode="decimal"
            placeholder="Auto"
            value={style.leading === null ? '' : String(Math.round(style.leading * 10) / 10)}
            onchange={(e) => setLeading(e.currentTarget.value)}
            aria-label="Leading"
          />
        </label>
        <label use:tooltip={{ text: 'Tracking — extra letter spacing in px', placement: 'left' }}>
          <span>Track</span>
          <input
            type="number"
            value={style.tracking}
            onchange={(e) => apply({ tracking: numberOr(e.currentTarget.value, 0) })}
            aria-label="Tracking"
          />
        </label>
        <label use:tooltip={{ text: 'Baseline shift in px (positive = up)', placement: 'right' }}>
          <span>Shift</span>
          <input
            type="number"
            value={style.baselineShift}
            onchange={(e) => apply({ baselineShift: numberOr(e.currentTarget.value, 0) })}
            aria-label="Baseline shift"
          />
        </label>
        <label use:tooltip={{ text: 'Vertical scale (%)', placement: 'left' }}>
          <span>V %</span>
          <input
            type="number"
            min="1"
            value={style.verticalScale}
            onchange={(e) => apply({ verticalScale: Math.max(1, numberOr(e.currentTarget.value, 100)) })}
            aria-label="Vertical scale"
          />
        </label>
        <label use:tooltip={{ text: 'Horizontal scale (%)', placement: 'right' }}>
          <span>H %</span>
          <input
            type="number"
            min="1"
            value={style.horizontalScale}
            onchange={(e) => apply({ horizontalScale: Math.max(1, numberOr(e.currentTarget.value, 100)) })}
            aria-label="Horizontal scale"
          />
        </label>
      </div>

      <label class="field color-field">
        <span>Color</span>
        <input
          type="color"
          value={rgbToHex(style.color)}
          onchange={(e) => setColor(e.currentTarget.value)}
          aria-label="Text color"
        />
      </label>

      <div class="toggles" role="group" aria-label="Character styles">
        <button
          class:on={style.bold}
          use:tooltip={{ text: 'Faux Bold', placement: 'top' }}
          aria-label="Faux bold"
          onclick={() => apply({ bold: !style.bold })}><Icon svg={TextBold} size={15} /></button
        >
        <button
          class:on={style.italic}
          use:tooltip={{ text: 'Faux Italic', placement: 'top' }}
          aria-label="Faux italic"
          onclick={() => apply({ italic: !style.italic })}><Icon svg={TextItalic} size={15} /></button
        >
        <button
          class:on={style.caps === 'all'}
          use:tooltip={{ text: 'All Caps', placement: 'top' }}
          aria-label="All caps"
          onclick={() => apply({ caps: style.caps === 'all' ? 'none' : 'all' })}
          ><Icon svg={TextCaseUppercase} size={15} /></button
        >
        <button
          class:on={style.caps === 'small'}
          use:tooltip={{ text: 'Small Caps', placement: 'top' }}
          aria-label="Small caps"
          onclick={() => apply({ caps: style.caps === 'small' ? 'none' : 'small' })}
          ><Icon svg={TextCaseTitle} size={15} /></button
        >
        <button
          class:on={style.script === 'super'}
          use:tooltip={{ text: 'Superscript', placement: 'top' }}
          aria-label="Superscript"
          onclick={() => apply({ script: style.script === 'super' ? 'none' : 'super' })}
          ><Icon svg={TextSuperscript} size={15} /></button
        >
        <button
          class:on={style.script === 'sub'}
          use:tooltip={{ text: 'Subscript', placement: 'top' }}
          aria-label="Subscript"
          onclick={() => apply({ script: style.script === 'sub' ? 'none' : 'sub' })}
          ><Icon svg={TextSubscript} size={15} /></button
        >
        <button
          class:on={style.underline}
          use:tooltip={{ text: 'Underline', placement: 'top' }}
          aria-label="Underline"
          onclick={() => apply({ underline: !style.underline })}><Icon svg={TextUnderline} size={15} /></button
        >
        <button
          class:on={style.strikethrough}
          use:tooltip={{ text: 'Strikethrough', placement: 'top' }}
          aria-label="Strikethrough"
          onclick={() => apply({ strikethrough: !style.strikethrough })}
          ><Icon svg={TextStrikethrough} size={15} /></button
        >
      </div>

      <label class="field aa-field" use:tooltip={{ text: 'Photoshop anti-alias mode (kept for PSD export)', placement: 'top' }}>
        <span>Anti-alias</span>
        <select
          value={antiAlias}
          onchange={(e) => editor.applyTextAntiAlias(e.currentTarget.value as TextAntiAlias)}
          aria-label="Anti-alias mode"
        >
          <option value="none">None</option>
          <option value="sharp">Sharp</option>
          <option value="crisp">Crisp</option>
          <option value="strong">Strong</option>
          <option value="smooth">Smooth</option>
        </select>
      </label>

      {#if style.leading === null}
        <p class="hint">Auto leading: {Math.round(AUTO_LEADING * style.size)}px at the current size.</p>
      {/if}
    {:else}
      <p class="hint">Select a text layer or start a text edit to set character styles.</p>
    {/if}
  </div>
</Panel>

<style>
  .character {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 10px;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--text);
    font-size: 11px;
  }
  .field span {
    flex: none;
    width: 56px;
    color: var(--text-dim);
  }
  .family {
    flex: 1.4;
  }
  .face {
    flex: 1;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .grid label {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    font-size: 11px;
    color: var(--text);
  }
  .grid label span {
    flex: none;
    width: 34px;
    color: var(--text-dim);
  }
  input,
  select {
    min-width: 0;
    width: 100%;
    height: 24px;
    border: 1px solid var(--border-soft);
    border-radius: 3px;
    background: var(--bg-elevated);
    color: var(--text-bright);
    font-size: 11px;
  }
  input {
    padding: 0 6px;
  }
  input[type='color'] {
    width: 40px;
    padding: 1px 2px;
  }
  .toggles {
    display: flex;
    gap: 2px;
  }
  .toggles button {
    flex: 1;
    display: grid;
    place-items: center;
    height: 24px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: var(--text);
  }
  .toggles button:hover {
    background: var(--bg-elevated);
  }
  .toggles button.on {
    border-color: var(--border);
    background: var(--bg-elevated);
    color: var(--accent);
  }
  .hint {
    margin: 0;
    color: var(--text-dim);
    font-size: 11px;
  }
</style>
