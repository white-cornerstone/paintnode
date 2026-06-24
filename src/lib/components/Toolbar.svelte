<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import {
    ArrowMove,
    MarqueeRect,
    MarqueeEllipse,
    LineH,
    Lasso,
    PaintBrush,
    Eraser,
    PaintBucket,
    Gradient,
    Eyedropper,
    Shapes,
    TextT,
    Hand,
    Search,
    Sparkle,
    ArrowSwap,
  } from '../icons';

  interface ToolDef {
    id: string;
    key: string;
    icon: string;
  }

  const tools: ToolDef[] = [
    { id: 'move', key: 'V', icon: ArrowMove },
    { id: 'marquee', key: 'M', icon: MarqueeRect }, // rendered as a group (see below)
    { id: 'lasso', key: 'L', icon: Lasso },
    { id: 'brush', key: 'B', icon: PaintBrush },
    { id: 'eraser', key: 'E', icon: Eraser },
    { id: 'fill', key: 'G', icon: PaintBucket },
    { id: 'gradient', key: 'R', icon: Gradient },
    { id: 'shape', key: 'U', icon: Shapes },
    { id: 'text', key: 'T', icon: TextT },
    { id: 'eyedropper', key: 'I', icon: Eyedropper },
    { id: 'hand', key: 'H', icon: Hand },
    { id: 'zoom', key: 'Z', icon: Search }, // always a plain magnifier; mode shows on the cursor
  ];

  type MarqueeShape = 'rect' | 'ellipse' | 'row' | 'column';
  interface MarqueeItem {
    shape: MarqueeShape;
    label: string;
    icon: string;
    rotate?: number;
  }
  const marqueeItems: MarqueeItem[] = [
    { shape: 'rect', label: 'Rectangular Marquee', icon: MarqueeRect },
    { shape: 'ellipse', label: 'Elliptical Marquee', icon: MarqueeEllipse },
    { shape: 'row', label: 'Single Row Marquee', icon: LineH },
    { shape: 'column', label: 'Single Column Marquee', icon: LineH, rotate: 90 },
  ];
  const currentMarquee = $derived(
    marqueeItems.find((m) => m.shape === editor.marqueeShape) ?? marqueeItems[0],
  );

  const nameOf = (id: string) => editor.tools[id]?.name ?? id;

  // Long-press flyout for the marquee tool group.
  let flyoutOpen = $state(false);
  let pressTimer = 0;
  let longFired = false;

  function marqueeDown(e: PointerEvent) {
    if (e.button !== 0) return;
    longFired = false;
    pressTimer = window.setTimeout(() => {
      longFired = true;
      flyoutOpen = true;
    }, 350);
  }
  function marqueeUp() {
    clearTimeout(pressTimer);
  }
  function marqueeLeave() {
    clearTimeout(pressTimer);
  }
  function marqueeClick() {
    if (longFired) {
      longFired = false;
      return; // long-press already opened the flyout
    }
    flyoutOpen = false;
    editor.setTool('marquee');
  }
  function chooseShape(shape: MarqueeShape) {
    editor.marqueeShape = shape;
    editor.setTool('marquee');
    flyoutOpen = false;
  }
</script>

<svelte:window
  onpointerdown={() => (flyoutOpen = false)}
  onkeydown={(e) => (e.key === 'Escape' ? (flyoutOpen = false) : null)}
/>

<div class="toolbar">
  <div class="tools">
    {#each tools as t (t.id)}
      {#if t.id === 'marquee'}
        <div class="tool-wrap" role="presentation" onpointerdown={(e) => e.stopPropagation()}>
          <button
            class="tool"
            class:active={editor.activeToolId === 'marquee'}
            use:tooltip={{ text: 'Marquee (M) — hold for shapes', placement: 'right' }}
            onclick={marqueeClick}
            onpointerdown={marqueeDown}
            onpointerup={marqueeUp}
            onpointerleave={marqueeLeave}
            oncontextmenu={(e) => {
              e.preventDefault();
              flyoutOpen = true;
            }}
            aria-label="Marquee"
            aria-haspopup="menu"
          >
            <Icon svg={currentMarquee.icon} rotate={currentMarquee.rotate ?? 0} size={20} />
            <span class="tri"></span>
          </button>
          {#if flyoutOpen}
            <div class="flyout" role="menu">
              {#each marqueeItems as m (m.shape)}
                <button class="flyout-item" role="menuitem" onclick={() => chooseShape(m.shape)}>
                  <span class="mark">{editor.marqueeShape === m.shape ? '■' : ''}</span>
                  <Icon svg={m.icon} rotate={m.rotate ?? 0} size={18} />
                  <span class="lbl">{m.label}</span>
                  <span class="sc">M</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <button
          class="tool"
          class:active={editor.activeToolId === t.id}
          use:tooltip={{ text: `${nameOf(t.id)} (${t.key})`, placement: 'right' }}
          onclick={() => editor.setTool(t.id)}
          aria-label={nameOf(t.id)}
        >
          <Icon svg={t.icon} size={20} />
        </button>
      {/if}
    {/each}

    <div class="tool-divider"></div>

    <button
      class="tool ai"
      use:tooltip={{ text: 'Generate Image (AI)', placement: 'right' }}
      onclick={() => ui.open('aiGenerate')}
      aria-label="Generate Image (AI)"
    >
      <Icon svg={Sparkle} size={20} />
    </button>
  </div>

  <div class="colors">
    <button
      class="swatch bg"
      style="background:{editor.backgroundCss}"
      use:tooltip={{ text: 'Background color', placement: 'right' }}
      aria-label="Background color"
      onclick={() => editor.swapColors()}
    ></button>
    <button
      class="swatch fg"
      style="background:{editor.foregroundCss}"
      use:tooltip={{ text: 'Foreground color', placement: 'right' }}
      aria-label="Foreground color"
      onclick={() => editor.swapColors()}
    ></button>
    <button
      class="swap"
      use:tooltip={{ text: 'Swap colors (X)', placement: 'right' }}
      onclick={() => editor.swapColors()}
      aria-label="Swap colors"><Icon svg={ArrowSwap} size={13} /></button
    >
    <button
      class="defaults"
      use:tooltip={{ text: 'Default colors (D)', placement: 'right' }}
      onclick={() => editor.resetColors()}
      aria-label="Default colors"
    ><span class="d-bg"></span><span class="d-fg"></span></button>
  </div>
</div>

<style>
  .toolbar {
    width: var(--toolbar-w);
    background: var(--bg-panel);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 6px 0;
  }
  .tools {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tool-wrap {
    position: relative;
    display: flex;
  }
  .tool {
    position: relative;
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: var(--text);
  }
  .tool:hover {
    background: var(--bg-elevated);
  }
  .tool.active {
    background: var(--accent);
    color: #fff;
    border-color: var(--accent);
  }
  .tool-divider {
    width: 24px;
    height: 1px;
    background: var(--border-soft);
    margin: 5px 0;
  }
  .tool.ai {
    color: var(--accent);
  }
  /* Flyout indicator triangle, bottom-right corner */
  .tri {
    position: absolute;
    right: 3px;
    bottom: 3px;
    width: 0;
    height: 0;
    border-left: 5px solid transparent;
    border-bottom: 5px solid currentColor;
    opacity: 0.65;
    pointer-events: none;
  }
  .flyout {
    position: absolute;
    left: calc(100% + 5px);
    top: 0;
    min-width: 220px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    border-radius: 5px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.55);
    padding: 4px;
    z-index: 60;
  }
  .flyout-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: transparent;
    border: none;
    border-radius: 3px;
    padding: 6px 8px;
    text-align: left;
    color: var(--text);
  }
  .flyout-item:hover {
    background: var(--accent);
    color: #fff;
  }
  .flyout-item .mark {
    width: 10px;
    color: var(--text-dim);
    font-size: 9px;
  }
  .flyout-item .lbl {
    flex: 1;
    white-space: nowrap;
  }
  .flyout-item .sc {
    color: var(--text-dim);
  }
  .flyout-item:hover .sc,
  .flyout-item:hover .mark {
    color: #e8f0ff;
  }

  .colors {
    position: relative;
    width: 42px;
    height: 52px;
    margin-bottom: 4px;
  }
  .swatch {
    position: absolute;
    width: 24px;
    height: 24px;
    border: 1px solid #000;
    border-radius: 2px;
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.2);
    padding: 0;
    cursor: pointer;
  }
  .swatch.fg {
    top: 13px;
    left: 1px;
    z-index: 2;
  }
  .swatch.bg {
    bottom: 2px;
    right: 1px;
    z-index: 1;
  }
  .swap {
    position: absolute;
    top: 0;
    right: 0;
    width: 15px;
    height: 15px;
    display: grid;
    place-items: center;
    padding: 0;
    background: transparent;
    border: none;
    color: var(--text-dim);
    z-index: 3;
  }
  .swap:hover {
    color: var(--text-bright);
  }
  .defaults {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 15px;
    height: 15px;
    padding: 0;
    background: transparent;
    border: none;
    z-index: 3;
  }
  .defaults .d-fg,
  .defaults .d-bg {
    position: absolute;
    width: 9px;
    height: 9px;
    border: 1px solid #6c6c6c;
    border-radius: 1px;
  }
  .defaults .d-fg {
    top: 1px;
    left: 1px;
    background: #000;
    z-index: 2;
  }
  .defaults .d-bg {
    bottom: 1px;
    right: 1px;
    background: #fff;
    z-index: 1;
  }
  .defaults:hover .d-fg,
  .defaults:hover .d-bg {
    border-color: var(--text);
  }
</style>
