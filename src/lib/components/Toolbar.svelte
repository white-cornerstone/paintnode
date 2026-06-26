<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { workflow, type WorkflowTool } from '../state/workflow.svelte';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import {
    ArrowMove,
    Checkmark,
    MarqueeRect,
    MarqueeEllipse,
    LineH,
    Lasso,
    Wand,
    Crop,
    PaintBrush,
    Eraser,
    CloneStamp,
    PaintBucket,
    Gradient,
    Smudge,
    Blur,
    Sharpen,
    Dodge,
    Burn,
    Sponge,
    Eyedropper,
    Shapes,
    TextT,
    Hand,
    Search,
    ImageAdd,
    Board,
    Open,
    Sparkle,
    ArrowSwap,
  } from '../icons';

  // A dock slot is a single tool, the marquee shape-group, or a flyout group of tools.
  interface ToolSlot {
    kind: 'tool';
    id: string;
    key: string;
    icon: string;
  }
  interface GroupMember {
    id: string;
    icon: string;
    label: string;
    key?: string;
    /** Listed in the flyout but not yet implemented. */
    disabled?: boolean;
  }
  interface GroupSlot {
    kind: 'group';
    name: string;
    members: GroupMember[];
  }
  type MarqueeSlot = { kind: 'marquee' };
  type Slot = ToolSlot | GroupSlot | MarqueeSlot;
  interface WorkflowSlot {
    id: WorkflowTool;
    label: string;
    icon: string;
    tooltip: string;
  }

  const slots: Slot[] = [
    { kind: 'tool', id: 'move', key: 'V', icon: ArrowMove },
    { kind: 'marquee' },
    { kind: 'tool', id: 'lasso', key: 'L', icon: Lasso },
    { kind: 'tool', id: 'magicwand', key: 'W', icon: Wand },
    { kind: 'tool', id: 'crop', key: 'C', icon: Crop },
    { kind: 'tool', id: 'eyedropper', key: 'I', icon: Eyedropper },
    { kind: 'tool', id: 'brush', key: 'B', icon: PaintBrush },
    { kind: 'tool', id: 'clone', key: 'S', icon: CloneStamp },
    { kind: 'tool', id: 'eraser', key: 'E', icon: Eraser },
    { kind: 'tool', id: 'fill', key: 'G', icon: PaintBucket },
    { kind: 'tool', id: 'gradient', key: 'R', icon: Gradient },
    {
      kind: 'group',
      name: 'focus',
      members: [
        { id: 'blur', icon: Blur, label: 'Blur' },
        { id: 'sharpen', icon: Sharpen, label: 'Sharpen' },
        { id: 'smudge', icon: Smudge, label: 'Smudge' },
      ],
    },
    {
      kind: 'group',
      name: 'toning',
      members: [
        { id: 'dodge', icon: Dodge, label: 'Dodge', key: 'O' },
        { id: 'burn', icon: Burn, label: 'Burn' },
        { id: 'sponge', icon: Sponge, label: 'Sponge' },
      ],
    },
    { kind: 'tool', id: 'shape', key: 'U', icon: Shapes },
    {
      kind: 'group',
      name: 'type',
      members: [
        { id: 'text', icon: TextT, label: 'Horizontal Type Tool', key: 'T' },
        { id: 'type-vertical', icon: TextT, label: 'Vertical Type Tool', disabled: true },
        { id: 'type-mask-h', icon: TextT, label: 'Horizontal Type Mask Tool', disabled: true },
        { id: 'type-mask-v', icon: TextT, label: 'Vertical Type Mask Tool', disabled: true },
      ],
    },
    { kind: 'tool', id: 'hand', key: 'H', icon: Hand },
    { kind: 'tool', id: 'zoom', key: 'Z', icon: Search }, // mode shows on the cursor
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
  const hasDocument = $derived(ui.activeSurface === 'document' && !!editor.doc);
  const hasWorkflow = $derived(ui.activeSurface === 'workflow' && workflow.active);
  const enabled = $derived(hasDocument || hasWorkflow);
  const workflowSlots: WorkflowSlot[] = [
    { id: 'hand', label: 'Hand', icon: Hand, tooltip: 'Hand tool' },
    { id: 'asset', label: 'Asset node', icon: ImageAdd, tooltip: 'Draw asset node' },
    { id: 'composition', label: 'Composition node', icon: Board, tooltip: 'Place composition node' },
    { id: 'output', label: 'Output node', icon: Open, tooltip: 'Place output node' },
    { id: 'zoom', label: 'Zoom', icon: Search, tooltip: 'Zoom workflow canvas' },
  ];

  const nameOf = (id: string) => editor.tools[id]?.name ?? id;

  // Remembered active member per flyout group (Photoshop shows the last-used tool of a group).
  let lastMember = $state<Record<string, string>>({ focus: 'blur', toning: 'dodge', type: 'text' });
  const shownMember = (slot: GroupSlot): GroupMember => {
    const active = slot.members.find((m) => m.id === editor.activeToolId);
    return active ?? slot.members.find((m) => m.id === lastMember[slot.name]) ?? slot.members[0];
  };
  const groupActive = (slot: GroupSlot): boolean =>
    slot.members.some((m) => m.id === editor.activeToolId);

  // One shared long-press flyout, keyed by slot name ('marquee' | group name).
  let openGroup = $state<string | null>(null);
  let pressTimer = 0;
  let longFired = false;

  function groupDown(e: PointerEvent, name: string) {
    if (!hasDocument) return;
    if (e.button !== 0) return;
    longFired = false;
    pressTimer = window.setTimeout(() => {
      longFired = true;
      openGroup = name;
    }, 350);
  }
  function groupUp() {
    clearTimeout(pressTimer);
  }

  function marqueeClick() {
    if (!hasDocument) return;
    if (longFired) {
      longFired = false;
      return; // long-press already opened the flyout
    }
    openGroup = null;
    editor.setTool('marquee');
  }
  function chooseShape(shape: MarqueeShape) {
    if (!hasDocument) return;
    editor.marqueeShape = shape;
    editor.setTool('marquee');
    openGroup = null;
  }

  function groupClick(slot: GroupSlot) {
    if (!hasDocument) return;
    if (longFired) {
      longFired = false;
      return;
    }
    openGroup = null;
    editor.setTool(shownMember(slot).id);
  }
  function chooseMember(slot: GroupSlot, m: GroupMember) {
    if (!hasDocument) return;
    if (m.disabled) {
      editor.flash(`${m.label} is coming soon`);
      openGroup = null;
      return;
    }
    lastMember[slot.name] = m.id;
    editor.setTool(m.id);
    openGroup = null;
  }
</script>

<svelte:window
  onpointerdown={() => (openGroup = null)}
  onkeydown={(e) => (e.key === 'Escape' ? (openGroup = null) : null)}
/>

<div class="toolbar" class:disabled={!enabled}>
  <div class="tools">
    {#if hasWorkflow}
      {#each workflowSlots as slot (slot.id)}
        <button
          class="tool"
          class:active={workflow.tool === slot.id}
          use:tooltip={{ text: slot.tooltip, placement: 'right' }}
          onclick={() => workflow.setTool(slot.id)}
          aria-label={slot.label}
        >
          <Icon svg={slot.icon} size={20} />
        </button>
      {/each}
    {:else}
      {#each slots as slot, i (i)}
      {#if slot.kind === 'marquee'}
        <div class="tool-wrap" role="presentation" onpointerdown={(e) => e.stopPropagation()}>
          <button
            class="tool"
            class:active={hasDocument && editor.activeToolId === 'marquee'}
            use:tooltip={{ text: 'Marquee (M) — hold for shapes', placement: 'right' }}
            onclick={marqueeClick}
            onpointerdown={(e) => groupDown(e, 'marquee')}
            onpointerup={groupUp}
            onpointerleave={groupUp}
            oncontextmenu={(e) => {
              e.preventDefault();
              openGroup = 'marquee';
            }}
            aria-label="Marquee"
            aria-haspopup="menu"
            disabled={!hasDocument}
          >
            <Icon svg={currentMarquee.icon} rotate={currentMarquee.rotate ?? 0} size={20} />
            <span class="tri"></span>
          </button>
          {#if hasDocument && openGroup === 'marquee'}
            <div class="flyout" role="menu">
              {#each marqueeItems as m (m.shape)}
                <button class="flyout-item" role="menuitem" onclick={() => chooseShape(m.shape)}>
                  <span class="mark">
                    {#if hasDocument && editor.marqueeShape === m.shape}
                      <Icon svg={Checkmark} size={12} />
                    {/if}
                  </span>
                  <Icon svg={m.icon} rotate={m.rotate ?? 0} size={18} />
                  <span class="lbl">{m.label}</span>
                  <span class="sc">M</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else if slot.kind === 'group'}
        {@const shown = shownMember(slot)}
        <div class="tool-wrap" role="presentation" onpointerdown={(e) => e.stopPropagation()}>
          <button
            class="tool"
            class:active={hasDocument && groupActive(slot)}
            use:tooltip={{ text: `${shown.label} — hold for tools`, placement: 'right' }}
            onclick={() => groupClick(slot)}
            onpointerdown={(e) => groupDown(e, slot.name)}
            onpointerup={groupUp}
            onpointerleave={groupUp}
            oncontextmenu={(e) => {
              e.preventDefault();
              openGroup = slot.name;
            }}
            aria-label={shown.label}
            aria-haspopup="menu"
            disabled={!hasDocument}
          >
            <Icon svg={shown.icon} size={20} />
            <span class="tri"></span>
          </button>
          {#if hasDocument && openGroup === slot.name}
            <div class="flyout" role="menu">
              {#each slot.members as m (m.id)}
                <button
                  class="flyout-item"
                  class:disabled={m.disabled}
                  role="menuitem"
                  onclick={() => chooseMember(slot, m)}
                >
                  <span class="mark">
                    {#if hasDocument && editor.activeToolId === m.id}
                      <Icon svg={Checkmark} size={12} />
                    {/if}
                  </span>
                  <Icon svg={m.icon} size={18} />
                  <span class="lbl">{m.label}</span>
                  <span class="sc">{m.disabled ? 'Soon' : (m.key ?? '')}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <button
          class="tool"
          class:active={hasDocument && editor.activeToolId === slot.id}
          use:tooltip={{ text: `${nameOf(slot.id)} (${slot.key})`, placement: 'right' }}
          onclick={() => editor.setTool(slot.id)}
          aria-label={nameOf(slot.id)}
          disabled={!hasDocument}
        >
          <Icon svg={slot.icon} size={20} />
        </button>
      {/if}
      {/each}

      <div class="tool-divider"></div>

      <button
        class="tool ai"
        use:tooltip={{ text: 'Generate Image (AI)', placement: 'right' }}
        onclick={() => ui.open('aiGenerate')}
        aria-label="Generate Image (AI)"
        disabled={!hasDocument}
      >
        <Icon svg={Sparkle} size={20} />
      </button>
    {/if}
  </div>

  {#if !hasWorkflow}
    <div class="colors">
      <button
        class="swatch bg"
        style="background:{editor.backgroundCss}"
        use:tooltip={{ text: 'Background color', placement: 'right' }}
        aria-label="Background color"
        onclick={() => editor.swapColors()}
        disabled={!hasDocument}
      ></button>
      <button
        class="swatch fg"
        style="background:{editor.foregroundCss}"
        use:tooltip={{ text: 'Foreground color', placement: 'right' }}
        aria-label="Foreground color"
        onclick={() => editor.swapColors()}
        disabled={!hasDocument}
      ></button>
      <button
        class="swap"
        use:tooltip={{ text: 'Swap colors (X)', placement: 'right' }}
        onclick={() => editor.swapColors()}
        aria-label="Swap colors"
        disabled={!hasDocument}><Icon svg={ArrowSwap} size={13} /></button
      >
      <button
        class="defaults"
        use:tooltip={{ text: 'Default colors (D)', placement: 'right' }}
        onclick={() => editor.resetColors()}
        aria-label="Default colors"
        disabled={!hasDocument}
      ><span class="d-bg"></span><span class="d-fg"></span></button>
    </div>
  {/if}
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
  .toolbar.disabled .tools,
  .toolbar.disabled .colors {
    opacity: 0.38;
  }
  .toolbar.disabled .tool,
  .toolbar.disabled .swatch,
  .toolbar.disabled .swap,
  .toolbar.disabled .defaults {
    cursor: default;
  }
  .tool:hover {
    background: var(--bg-elevated);
  }
  .tool:disabled,
  .tool:disabled:hover {
    background: transparent;
    border-color: transparent;
    color: var(--text);
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
  .tool.ai:disabled {
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
  .flyout-item.disabled {
    opacity: 0.45;
  }
  .flyout-item.disabled:hover {
    background: var(--bg-panel-2);
    color: var(--text-dim);
  }
  .flyout-item .mark {
    width: 12px;
    height: 12px;
    display: grid;
    place-items: center;
    color: var(--text-dim);
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
    width: 38px;
    height: 50px;
    /* centered in the dock with breathing room above/below (Photoshop-style) */
    margin: 12px auto 12px;
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
  .swatch:disabled,
  .swap:disabled,
  .defaults:disabled {
    cursor: default;
  }
  .swatch.fg {
    top: 11px;
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
