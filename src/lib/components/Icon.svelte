<script lang="ts">
  /**
   * Renders a Fluent System Icon. Pass a raw SVG string imported from `$lib/icons`
   * (e.g. `import { PaintBrush } from '../icons'`). The icon inherits the current text
   * color via `currentColor` and is sized by the `size` prop.
   *
   * Do NOT hand-write inline <svg> markup elsewhere — see AGENTS.md.example (Icons guideline).
   */
  interface Props {
    svg: string;
    size?: number;
    /** Accessible label. Omit for purely decorative icons (they become aria-hidden). */
    label?: string;
    class?: string;
    /** Rotation in degrees (e.g. 90 to turn a horizontal line into a vertical one). */
    rotate?: number;
  }
  let { svg, size = 20, label, class: klass = '', rotate = 0 }: Props = $props();
</script>

<span
  class="paintnode-icon {klass}"
  style="--paintnode-icon-size:{size}px{rotate ? `;transform:rotate(${rotate}deg)` : ''}"
  role={label ? 'img' : 'presentation'}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
>{@html svg}</span>

<style>
  .paintnode-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--paintnode-icon-size);
    height: var(--paintnode-icon-size);
    line-height: 0;
    color: inherit;
    flex: none;
  }
  .paintnode-icon :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
  /* Fluent SVGs hardcode fill="#212121"; CSS overrides the presentation attribute. */
  .paintnode-icon :global(svg path) {
    fill: currentColor;
  }
</style>
