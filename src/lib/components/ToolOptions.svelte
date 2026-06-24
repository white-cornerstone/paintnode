<script lang="ts">
  import { editor } from '../state/editor.svelte';

  const tool = $derived(editor.activeToolId);
  const isPaint = $derived(tool === 'brush' || tool === 'eraser');
</script>

<div class="options">
  <span class="tool-name">{editor.activeTool.name}</span>
  <span class="divider"></span>

  {#if isPaint}
    <label class="opt">
      Size
      <input type="range" min="1" max="500" bind:value={editor.brushSize} />
      <input type="number" min="1" max="2000" bind:value={editor.brushSize} class="num" />
      <span class="unit">px</span>
    </label>
    <label class="opt">
      Hardness
      <input type="range" min="0" max="1" step="0.01" bind:value={editor.brushHardness} />
      <span class="val">{Math.round(editor.brushHardness * 100)}%</span>
    </label>
    <label class="opt">
      Opacity
      <input type="range" min="0" max="1" step="0.01" bind:value={editor.brushOpacity} />
      <span class="val">{Math.round(editor.brushOpacity * 100)}%</span>
    </label>
  {:else if tool === 'marquee'}
    <label class="opt">
      Shape
      <select bind:value={editor.marqueeShape}>
        <option value="rect">Rectangular</option>
        <option value="ellipse">Elliptical</option>
        <option value="row">Single Row</option>
        <option value="column">Single Column</option>
      </select>
    </label>
    <button onclick={() => editor.selectAll()}>Select All</button>
    <button onclick={() => editor.deselect()} disabled={!editor.selection}>Deselect</button>
    <button onclick={() => editor.invertSelection()} disabled={!editor.selection}>Invert</button>
    <span class="hint">Drag to select · Shift = square/circle</span>
  {:else if tool === 'lasso'}
    <button onclick={() => editor.selectAll()}>Select All</button>
    <button onclick={() => editor.deselect()} disabled={!editor.selection}>Deselect</button>
    <button onclick={() => editor.invertSelection()} disabled={!editor.selection}>Invert</button>
    <span class="hint">Drag to draw a freeform selection</span>
  {:else if tool === 'fill'}
    <label class="opt">
      Tolerance
      <input type="range" min="0" max="255" bind:value={editor.tolerance} />
      <input type="number" min="0" max="255" bind:value={editor.tolerance} class="num" />
    </label>
    <span class="hint">Click to flood-fill with the foreground color.</span>
  {:else if tool === 'shape'}
    <label class="opt">
      Shape
      <select bind:value={editor.shapeType}>
        <option value="rect">Rectangle</option>
        <option value="ellipse">Ellipse</option>
        <option value="line">Line</option>
      </select>
    </label>
    {#if editor.shapeType !== 'line'}
      <label class="opt"><input type="checkbox" bind:checked={editor.shapeFill} /> Fill</label>
    {/if}
    {#if editor.shapeType === 'line' || !editor.shapeFill}
      <label class="opt">
        Width
        <input type="range" min="1" max="100" bind:value={editor.shapeStrokeWidth} />
        <span class="val">{editor.shapeStrokeWidth}px</span>
      </label>
    {/if}
    <span class="hint">Drag to draw · Shift constrains</span>
  {:else if tool === 'gradient'}
    <label class="opt">
      Type
      <select bind:value={editor.gradientType}>
        <option value="fg-bg">Foreground → Background</option>
        <option value="fg-transparent">Foreground → Transparent</option>
      </select>
    </label>
    <span class="hint">Drag to set direction · Shift constrains</span>
  {:else if tool === 'text'}
    <span class="hint">Click on the canvas to place text.</span>
  {:else if tool === 'eyedropper'}
    <span class="hint">Click or drag to sample a color into the foreground.</span>
  {:else if tool === 'move'}
    <span class="hint">Drag to move the active layer's pixels.</span>
  {:else if tool === 'hand'}
    <span class="hint">Drag to pan. Tip: hold Space with any tool to pan.</span>
  {:else if tool === 'zoom'}
    <div class="seg">
      <button class:on={editor.effectiveZoomMode === 'in'} onclick={() => (editor.zoomMode = 'in')}>Zoom In</button>
      <button class:on={editor.effectiveZoomMode === 'out'} onclick={() => (editor.zoomMode = 'out')}>Zoom Out</button>
    </div>
    <button onclick={() => editor.viewport?.fitToView()}>Fit Screen</button>
    <button onclick={() => editor.viewport?.setZoom(1)}>100%</button>
    <span class="hint">
      Click to zoom {editor.effectiveZoomMode} · hold Alt to invert · ⌘+ / ⌘−
    </span>
  {/if}
</div>

<style>
  .options {
    height: var(--options-h);
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    overflow: hidden;
    white-space: nowrap;
  }
  .tool-name {
    font-weight: 600;
    color: var(--text-bright);
    min-width: 76px;
  }
  .divider {
    width: 1px;
    height: 20px;
    background: var(--border-soft);
  }
  .opt {
    display: flex;
    align-items: center;
    gap: 7px;
    color: var(--text-dim);
  }
  .opt input[type='range'] {
    width: 110px;
  }
  .num {
    width: 54px;
  }
  .val {
    width: 38px;
    color: var(--text);
    text-align: right;
  }
  .unit {
    color: var(--text-dim);
  }
  .hint {
    color: var(--text-dim);
    font-style: italic;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    overflow: hidden;
  }
  .seg button {
    border: none;
    border-radius: 0;
    background: var(--bg-elevated);
    padding: 4px 10px;
  }
  .seg button:first-child {
    border-right: 1px solid var(--border-soft);
  }
  .seg button.on {
    background: var(--accent);
    color: #fff;
  }
</style>
