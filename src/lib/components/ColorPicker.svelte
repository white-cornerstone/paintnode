<script lang="ts">
  import { untrack } from 'svelte';
  import { editor } from '../state/editor.svelte';
  import { hsvToRgb, rgbToHsv, rgbToHex, hexToRgb } from '../engine/color';
  import { clamp } from '../engine/types';

  let h = $state(0);
  let s = $state(100);
  let v = $state(0);

  // Keep local HSV in sync when the foreground changes from elsewhere (eyedropper, swap…).
  $effect(() => {
    const fg = editor.foreground;
    untrack(() => {
      const cur = hsvToRgb({ h, s, v });
      if (cur.r !== fg.r || cur.g !== fg.g || cur.b !== fg.b) {
        const hsv = rgbToHsv(fg);
        if (hsv.s > 0.001) h = hsv.h; // preserve hue for grays
        s = hsv.s;
        v = hsv.v;
      }
    });
  });

  function commit() {
    editor.setForeground(hsvToRgb({ h, s, v }));
  }

  function dragSV(node: HTMLElement) {
    const onMove = (e: PointerEvent) => {
      const r = node.getBoundingClientRect();
      s = clamp((e.clientX - r.left) / r.width, 0, 1) * 100;
      v = (1 - clamp((e.clientY - r.top) / r.height, 0, 1)) * 100;
      commit();
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
      h = clamp((e.clientX - r.left) / r.width, 0, 1) * 360;
      commit();
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

  const hex = $derived(rgbToHex(editor.foreground));
  function onHex(e: Event) {
    const rgb = hexToRgb((e.target as HTMLInputElement).value);
    if (rgb) editor.setForeground(rgb);
  }
  function onChannel(ch: 'r' | 'g' | 'b', e: Event) {
    const n = clamp(parseInt((e.target as HTMLInputElement).value || '0', 10), 0, 255);
    editor.setForeground({ ...editor.foreground, [ch]: n });
  }
</script>

<div class="picker">
  <div
    class="sv"
    use:dragSV
    style="background:
      linear-gradient(to top, #000, rgba(0,0,0,0)),
      linear-gradient(to right, #fff, hsl({h}, 100%, 50%));"
  >
    <div class="sv-marker" style="left:{s}%; top:{100 - v}%"></div>
  </div>

  <div class="hue" use:dragHue>
    <div class="hue-marker" style="left:{(h / 360) * 100}%"></div>
  </div>

  <div class="fields">
    <label class="hexfield">
      <span>#</span>
      <input type="text" value={hex.slice(1)} onchange={onHex} maxlength="6" spellcheck="false" />
    </label>
    <label>R<input type="number" min="0" max="255" value={editor.foreground.r} onchange={(e) => onChannel('r', e)} /></label>
    <label>G<input type="number" min="0" max="255" value={editor.foreground.g} onchange={(e) => onChannel('g', e)} /></label>
    <label>B<input type="number" min="0" max="255" value={editor.foreground.b} onchange={(e) => onChannel('b', e)} /></label>
  </div>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sv {
    position: relative;
    width: 100%;
    height: 130px;
    border-radius: 3px;
    cursor: crosshair;
    touch-action: none;
  }
  .sv-marker {
    position: absolute;
    width: 12px;
    height: 12px;
    border: 2px solid #fff;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }
  .hue {
    position: relative;
    width: 100%;
    height: 14px;
    border-radius: 3px;
    cursor: ew-resize;
    touch-action: none;
    background: linear-gradient(
      to right,
      #f00 0%,
      #ff0 17%,
      #0f0 33%,
      #0ff 50%,
      #00f 67%,
      #f0f 83%,
      #f00 100%
    );
  }
  .hue-marker {
    position: absolute;
    top: -2px;
    width: 4px;
    height: 18px;
    background: #fff;
    border: 1px solid rgba(0, 0, 0, 0.6);
    border-radius: 2px;
    transform: translateX(-50%);
    pointer-events: none;
  }
  .fields {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 6px;
  }
  .fields label {
    display: flex;
    align-items: center;
    gap: 3px;
    color: var(--text-dim);
    font-size: 11px;
  }
  .fields input {
    width: 100%;
    min-width: 0;
  }
  .hexfield {
    grid-column: 1 / -1;
  }
  .hexfield span {
    color: var(--text-dim);
  }
</style>
