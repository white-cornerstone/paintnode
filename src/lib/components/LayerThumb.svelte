<script lang="ts">
  import type { Layer } from '../engine/Layer.svelte';

  let { layer, compact = false }: { layer: Layer; compact?: boolean } = $props();
  let canvas: HTMLCanvasElement | undefined = $state();

  const boxW = $derived(compact ? 30 : 42);
  const boxH = $derived(compact ? 22 : 34);

  $effect(() => {
    layer.pixelRev; // redraw when pixels change
    const c = canvas;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = boxW * dpr;
    c.height = boxH * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // transparency checker
    const cs = 6;
    for (let y = 0; y < boxH; y += cs) {
      for (let x = 0; x < boxW; x += cs) {
        ctx.fillStyle = ((x / cs + y / cs) & 1) === 0 ? '#e6e6e6' : '#b9b9b9';
        ctx.fillRect(x, y, cs, cs);
      }
    }

    const scale = Math.min(boxW / layer.width, boxH / layer.height);
    const w = layer.width * scale;
    const h = layer.height * scale;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(layer.canvas, (boxW - w) / 2, (boxH - h) / 2, w, h);
  });
</script>

<canvas bind:this={canvas} class="thumb" style="width:{boxW}px;height:{boxH}px"></canvas>

<style>
  .thumb {
    display: block;
    border: 1px solid var(--border);
    border-radius: 2px;
    flex: none;
  }
</style>
