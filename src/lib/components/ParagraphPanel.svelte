<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import Panel from './Panel.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import {
    TextAlignLeft,
    TextAlignCenter,
    TextAlignRight,
    TextAlignJustify,
    TextAlignJustifyLow,
  } from '../icons';
  import type { TextAlign, TextParagraph } from '../engine/text/model';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  type ParagraphAttrs = Omit<TextParagraph, 'runs'>;

  const layerParagraph = $derived(editor.panelTextLayer?.text?.paragraphs[0] ?? null);
  const paragraph = $derived<ParagraphAttrs | null>(
    editor.textEdit ? editor.liveTextParagraph : layerParagraph,
  );

  function apply(patch: Partial<ParagraphAttrs>): void {
    editor.applyParagraphStyle(patch);
  }

  function numberOr(value: string, fallback: number): number {
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  const ALIGNMENTS: { value: TextAlign; label: string; icon: string }[] = [
    { value: 'left', label: 'Align left', icon: TextAlignLeft },
    { value: 'center', label: 'Align center', icon: TextAlignCenter },
    { value: 'right', label: 'Align right', icon: TextAlignRight },
    { value: 'justify-left', label: 'Justify (last line left) — aligns left in point text', icon: TextAlignJustifyLow },
    { value: 'justify-all', label: 'Justify all — aligns left in point text', icon: TextAlignJustify },
  ];
</script>

<Panel title="Paragraph" bind:collapsed {onToggle}>
  <div class="paragraph">
    {#if paragraph}
      <div class="aligns" role="group" aria-label="Paragraph alignment">
        {#each ALIGNMENTS as item (item.value)}
          <button
            class:on={paragraph.align === item.value}
            use:tooltip={{ text: item.label, placement: 'top' }}
            aria-label={item.label}
            onclick={() => apply({ align: item.value })}><Icon svg={item.icon} size={16} /></button
          >
        {/each}
      </div>

      <div class="grid">
        <label use:tooltip={{ text: 'Indent left margin (px)', placement: 'left' }}>
          <span>Left</span>
          <input
            type="number"
            value={paragraph.indentLeft}
            onchange={(e) => apply({ indentLeft: numberOr(e.currentTarget.value, 0) })}
            aria-label="Indent left"
          />
        </label>
        <label use:tooltip={{ text: 'Indent right margin (px)', placement: 'right' }}>
          <span>Right</span>
          <input
            type="number"
            value={paragraph.indentRight}
            onchange={(e) => apply({ indentRight: numberOr(e.currentTarget.value, 0) })}
            aria-label="Indent right"
          />
        </label>
      </div>
      <label class="field" use:tooltip={{ text: 'First-line indent (px; may be negative)', placement: 'top' }}>
        <span>First line</span>
        <input
          type="number"
          value={paragraph.firstLineIndent}
          onchange={(e) => apply({ firstLineIndent: numberOr(e.currentTarget.value, 0) })}
          aria-label="First-line indent"
        />
      </label>
      <div class="grid">
        <label use:tooltip={{ text: 'Space before paragraph (px)', placement: 'left' }}>
          <span>Before</span>
          <input
            type="number"
            value={paragraph.spaceBefore}
            onchange={(e) => apply({ spaceBefore: numberOr(e.currentTarget.value, 0) })}
            aria-label="Space before paragraph"
          />
        </label>
        <label use:tooltip={{ text: 'Space after paragraph (px)', placement: 'right' }}>
          <span>After</span>
          <input
            type="number"
            value={paragraph.spaceAfter}
            onchange={(e) => apply({ spaceAfter: numberOr(e.currentTarget.value, 0) })}
            aria-label="Space after paragraph"
          />
        </label>
      </div>

      <label
        class="check"
        use:tooltip={{ text: 'Kept for PSD round trips; point text never wraps, so it has no visual effect here', placement: 'top' }}
      >
        <input
          type="checkbox"
          checked={paragraph.hyphenate}
          onchange={(e) => apply({ hyphenate: e.currentTarget.checked })}
          aria-label="Hyphenate"
        />
        Hyphenate
      </label>
    {:else}
      <p class="hint">Select a text layer or start a text edit to set paragraph styles.</p>
    {/if}
  </div>
</Panel>

<style>
  .paragraph {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 10px;
  }
  .aligns {
    display: flex;
    gap: 2px;
  }
  .aligns button {
    flex: 1;
    display: grid;
    place-items: center;
    height: 24px;
    border: 1px solid transparent;
    border-radius: 3px;
    background: transparent;
    color: var(--text);
  }
  .aligns button:hover {
    background: var(--bg-elevated);
  }
  .aligns button.on {
    border-color: var(--border);
    background: var(--bg-elevated);
    color: var(--accent);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 6px;
  }
  .grid label,
  .field {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    font-size: 11px;
    color: var(--text);
  }
  .grid label span,
  .field span {
    flex: none;
    width: 44px;
    color: var(--text-dim);
  }
  .field span {
    width: 56px;
  }
  input {
    min-width: 0;
    width: 100%;
    height: 24px;
    padding: 0 6px;
    border: 1px solid var(--border-soft);
    border-radius: 3px;
    background: var(--bg-elevated);
    color: var(--text-bright);
    font-size: 11px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--text);
    font-size: 11px;
  }
  .check input {
    width: auto;
    height: auto;
  }
  .hint {
    margin: 0;
    color: var(--text-dim);
    font-size: 11px;
  }
</style>
