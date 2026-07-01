<script lang="ts">
  import { untrack } from 'svelte';
  import { editor } from '../state/editor.svelte';
  import { hsvToRgb, rgbToHsv } from '../engine/color';
  import { clamp } from '../engine/types';
  import Panel from './Panel.svelte';
  import { tooltip } from '../actions/tooltip';
  import ColorPickerDialog from './ColorPickerDialog.svelte';

  let {
    collapsed = $bindable(false),
    onToggle,
  }: { collapsed?: boolean; onToggle?: (collapsed: boolean) => void } = $props();

  let h = $state(0);
  let s = $state(100);
  let v = $state(0);
  let dialogTarget = $state<'foreground' | 'background' | null>(null);

  $effect(() => {
    const fg = editor.foreground;
    untrack(() => {
      const cur = hsvToRgb({ h, s, v });
      if (cur.r !== fg.r || cur.g !== fg.g || cur.b !== fg.b) {
        const hsv = rgbToHsv(fg);
        if (hsv.s > 0.001) h = hsv.h;
        s = hsv.s;
        v = hsv.v;
      }
    });
  });

  function commitForeground(): void {
    editor.setForeground(hsvToRgb({ h, s, v }));
  }

  function dragSV(node: HTMLElement) {
    const onMove = (e: PointerEvent) => {
      const r = node.getBoundingClientRect();
      s = clamp((e.clientX - r.left) / r.width, 0, 1) * 100;
      v = (1 - clamp((e.clientY - r.top) / r.height, 0, 1)) * 100;
      commitForeground();
    };
    const onUp = (e: PointerEvent) => {
      node.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    node.addEventListener('pointerdown', (e: PointerEvent) => {
      node.setPointerCapture(e.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      onMove(e);
    });
  }

  function dragHue(node: HTMLElement) {
    const onMove = (e: PointerEvent) => {
      const r = node.getBoundingClientRect();
      h = clamp((e.clientY - r.top) / r.height, 0, 1) * 360;
      commitForeground();
    };
    const onUp = (e: PointerEvent) => {
      node.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    node.addEventListener('pointerdown', (e: PointerEvent) => {
      node.setPointerCapture(e.pointerId);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      onMove(e);
    });
  }
</script>

<Panel title="Color" bind:collapsed {onToggle}>
  <div class="color-panel">
    <div class="swatch-stack" aria-label="Current colors">
      <button
        class="chip fg"
        style={`background:${editor.foregroundCss}`}
        use:tooltip={{ text: 'Foreground color', placement: 'left' }}
        aria-label="Foreground color"
        onclick={() => (dialogTarget = 'foreground')}
      ></button>
      <button
        class="chip bg"
        style={`background:${editor.backgroundCss}`}
        use:tooltip={{ text: 'Background color', placement: 'left' }}
        aria-label="Background color"
        onclick={() => (dialogTarget = 'background')}
      ></button>
    </div>

    <div
      class="sv-cube"
      use:dragSV
      style={`background:
        linear-gradient(to top, #000, rgba(0,0,0,0)),
        linear-gradient(to right, #fff, hsl(${h}, 100%, 50%));`}
      aria-label="Color saturation and brightness"
    >
      <span class="sv-ring" style={`left:${s}%; top:${100 - v}%`}></span>
    </div>

    <div class="hue-strip" use:dragHue aria-label="Hue">
      <span class="hue-marker" style={`top:${(h / 360) * 100}%`}></span>
    </div>
  </div>
</Panel>

{#if dialogTarget}
  <ColorPickerDialog
    target={dialogTarget}
    initialColor={dialogTarget === 'foreground' ? editor.foreground : editor.background}
    currentColor={dialogTarget === 'foreground' ? editor.foreground : editor.background}
    onApply={(rgb) => {
      if (dialogTarget === 'foreground') editor.setForeground(rgb);
      else editor.setBackground(rgb);
      dialogTarget = null;
    }}
    onClose={() => (dialogTarget = null)}
  />
{/if}

<style>
  .color-panel {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr) 30px;
    gap: 14px;
    padding: 14px;
    background: var(--bg-panel);
  }
  .swatch-stack {
    position: relative;
    width: 52px;
    height: 64px;
  }
  .chip {
    position: absolute;
    width: 34px;
    height: 34px;
    padding: 0;
    border: 2px solid #d9d9d9;
    border-radius: 0;
    box-shadow: 0 0 0 1px #202020;
  }
  .chip.fg {
    left: 0;
    top: 0;
    z-index: 2;
  }
  .chip.bg {
    right: 0;
    top: 20px;
    z-index: 1;
  }
  .chip:hover {
    outline: 1px solid var(--text-bright);
    outline-offset: 2px;
  }
  .sv-cube {
    position: relative;
    height: 132px;
    min-width: 0;
    cursor: crosshair;
    touch-action: none;
  }
  .sv-ring {
    position: absolute;
    width: 15px;
    height: 15px;
    border: 2px solid #fff;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.7);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
  .hue-strip {
    position: relative;
    width: 30px;
    height: 132px;
    cursor: ns-resize;
    touch-action: none;
    background: linear-gradient(to bottom, #f00 0%, #f0f 17%, #00f 33%, #0ff 50%, #0f0 67%, #ff0 83%, #f00 100%);
  }
  .hue-marker {
    position: absolute;
    left: -7px;
    width: 0;
    height: 0;
    border-top: 7px solid transparent;
    border-bottom: 7px solid transparent;
    border-left: 10px solid #f2f2f2;
    filter: drop-shadow(0 0 1px #111);
    transform: translateY(-50%);
    pointer-events: none;
  }
</style>
