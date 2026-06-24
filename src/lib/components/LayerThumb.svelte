<script lang="ts">
  import type { Layer } from '../engine/Layer.svelte';

  let { layer }: { layer: Layer } = $props();
  let canvas: HTMLCanvasElement | undefined = $state();

  const BOX_W = 42;
  const BOX_H = 34;

  $effect(() => {
    layer.pixelRev; // redraw when pixels change
    const c = canvas;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = BOX_W * dpr;
    c.height = BOX_H * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // transparency checker
    const cs = 6;
    for (let y = 0; y < BOX_H; y += cs) {
      for (let x = 0; x < BOX_W; x += cs) {
        ctx.fillStyle = ((x / cs + y / cs) & 1) === 0 ? '#e6e6e6' : '#b9b9b9';
        ctx.fillRect(x, y, cs, cs);
      }
    }

    const scale = Math.min(BOX_W / layer.width, BOX_H / layer.height);
    const w = layer.width * scale;
    const h = layer.height * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer.canvas, (BOX_W - w) / 2, (BOX_H - h) / 2, w, h);
  });
</script>

<canvas bind:this={canvas} class="thumb" style="width:{BOX_W}px;height:{BOX_H}px"></canvas>

<style>
  .thumb {
    display: block;
    border: 1px solid var(--border);
    border-radius: 2px;
    flex: none;
  }
</style>
