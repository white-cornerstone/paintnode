<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { workflow, type WorkflowTool } from '../state/workflow.svelte';

  const tool = $derived(editor.activeToolId);
  const hasDocument = $derived(ui.activeSurface === 'document' && !!editor.doc);
  const hasWorkflow = $derived(ui.activeSurface === 'workflow' && workflow.active);
  // Tools that share the round-brush controls (size / hardness / strength).
  const brushTools = ['brush', 'eraser', 'clone', 'smudge', 'blur', 'sharpen', 'dodge', 'burn', 'sponge'];
  const usesBrush = $derived(brushTools.includes(tool));
  const strengthLabel = $derived(
    tool === 'brush' || tool === 'eraser' || tool === 'clone'
      ? 'Opacity'
      : tool === 'dodge' || tool === 'burn'
        ? 'Exposure'
        : tool === 'sponge'
          ? 'Flow'
          : 'Strength',
  );
  const workflowToolNames: Record<WorkflowTool, string> = {
    move: 'Move',
    zoom: 'Zoom',
    asset: 'Asset Node',
    composition: 'Composition Node',
    output: 'Output Node',
  };
  const nodePalettes = ['#3a3c42', '#3e4f7a', '#3e6b57', '#74583c', '#70435f', '#5b4f7a'];
  const selectedKindLabel = $derived(
    workflow.selection?.kind === 'asset'
      ? 'Asset'
      : workflow.selection?.kind === 'composition'
        ? 'Composition'
        : workflow.selection?.kind === 'output'
          ? 'Output'
          : 'None',
  );
</script>

<div class="options">
  {#if hasWorkflow}
    <span class="tool-name">{workflowToolNames[workflow.tool]}</span>
    <span class="divider"></span>
    {#if workflow.tool === 'move'}
      <span class="hint">Drag empty workflow canvas to pan. Drag node headers to move nodes.</span>
    {:else if workflow.tool === 'zoom'}
      <div class="seg">
        <button class:on={workflow.zoomMode === 'in'} onclick={() => workflow.setZoomMode('in')}>Zoom In</button>
        <button class:on={workflow.zoomMode === 'out'} onclick={() => workflow.setZoomMode('out')}>Zoom Out</button>
      </div>
      <button onclick={() => workflow.resetZoom()}>100%</button>
      <span class="val">{Math.round(workflow.zoom * 100)}%</span>
      <span class="hint">Click the workflow canvas to zoom {workflow.zoomMode}. Hold Alt to invert.</span>
    {:else}
      <span class="hint">Drag on the workflow canvas to place or resize a {workflowToolNames[workflow.tool].toLowerCase()}.</span>
    {/if}

    <span class="divider"></span>
    <div class="opt">
      Type
      <span class="pill">{selectedKindLabel}</span>
    </div>
    <label class="opt">
      Name
      <input
        class="node-name"
        value={workflow.selectedLabel()}
        placeholder="node name"
        disabled={!workflow.selection}
        oninput={(event) => workflow.setSelectedLabel(event.currentTarget.value)}
      />
    </label>
    <div class="palette" aria-label="Node color palette">
      {#each nodePalettes as color (color)}
        <button
          class:active={workflow.selectedColor() === color}
          style={`background:${color}`}
          aria-label={`Set node color ${color}`}
          disabled={!workflow.selection}
          onclick={() => workflow.setSelectedColor(color)}
        ></button>
      {/each}
    </div>
  {:else if hasDocument}
    <span class="tool-name">{editor.activeTool.name}</span>
    <span class="divider"></span>

    {#if usesBrush}
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
        {strengthLabel}
        <input type="range" min="0" max="1" step="0.01" bind:value={editor.brushOpacity} />
        <span class="val">{Math.round(editor.brushOpacity * 100)}%</span>
      </label>
      {#if tool === 'clone'}
        <label class="opt"><input type="checkbox" bind:checked={editor.cloneAligned} /> Aligned</label>
        <span class="hint">Alt-click to set the source, then paint.</span>
      {:else if tool === 'dodge' || tool === 'burn'}
        <label class="opt">
          Range
          <select bind:value={editor.toneRange}>
            <option value="shadows">Shadows</option>
            <option value="midtones">Midtones</option>
            <option value="highlights">Highlights</option>
          </select>
        </label>
        <span class="hint">Drag to {tool === 'dodge' ? 'lighten' : 'darken'} the {editor.toneRange}.</span>
      {:else if tool === 'sponge'}
        <label class="opt">
          Mode
          <select bind:value={editor.spongeMode}>
            <option value="saturate">Saturate</option>
            <option value="desaturate">Desaturate</option>
          </select>
        </label>
        <span class="hint">Drag to {editor.spongeMode === 'saturate' ? 'boost' : 'reduce'} saturation.</span>
      {:else if tool === 'smudge'}
        <span class="hint">Drag to push pixels along the stroke.</span>
      {:else if tool === 'blur' || tool === 'sharpen'}
        <span class="hint">Drag to {tool} pixels under the brush.</span>
      {/if}
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
    {:else if tool === 'magicwand'}
      <label class="opt">
        Tolerance
        <input type="range" min="0" max="255" bind:value={editor.tolerance} />
        <input type="number" min="0" max="255" bind:value={editor.tolerance} class="num" />
      </label>
      <label class="opt"><input type="checkbox" bind:checked={editor.magicContiguous} /> Contiguous</label>
      <button onclick={() => editor.deselect()} disabled={!editor.selection}>Deselect</button>
      <button onclick={() => editor.invertSelection()} disabled={!editor.selection}>Invert</button>
      <span class="hint">Click to select by color · Shift adds · Alt subtracts</span>
    {:else if tool === 'crop'}
      <button onclick={() => editor.cropToSelection()} disabled={!editor.selection}>Apply (↵)</button>
      <button onclick={() => editor.deselect()} disabled={!editor.selection}>Reset</button>
      <span class="hint">Drag to set the crop box, then Apply or press Enter.</span>
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
      <span class="hint">Click to add text, or click existing text to edit · Esc to commit</span>
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
  .pill {
    min-width: 86px;
    padding: 3px 8px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text);
  }
  .node-name {
    width: 180px;
  }
  .palette {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .palette button {
    width: 22px;
    height: 22px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    padding: 0;
  }
  .palette button.active {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .seg {
    display: inline-flex;
    flex: none;
    width: max-content;
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
