<script lang="ts">
  import { editor } from '../state/editor.svelte';
  import { ui } from '../state/ui.svelte';
  import { workflow, type WorkflowTool } from '../state/workflow.svelte';
  import type { SelectionMode } from '../engine/selection';
  import { effectiveAiRetouchMaskMode } from '../engine/aiRetouch';
  import { isDesktop } from '../integrations/desktop';
  import type { CreatorNodeType } from '../workflow';
  import Icon from './Icon.svelte';
  import WorkflowNodePalette from './workflow/WorkflowNodePalette.svelte';
  import { tooltip } from '../actions/tooltip';
  import {
    Add,
    ArrowSync,
    Board,
    Dismiss,
    Hand,
    ImageAdd,
    Info,
    MarqueeRect,
    Open,
    Search,
    Sparkle,
    SquareMultiple,
  } from '../icons';

  const desktop = isDesktop();
  const tool = $derived(editor.activeToolId);
  const hasDocument = $derived(ui.activeSurface === 'document' && !!editor.doc);
  const hasWorkflow = $derived(ui.activeSurface === 'workflow' && workflow.active);
  const hasStoryboardEdit = $derived(hasWorkflow && workflow.storyboardEditing);
  const hasDrawingSurface = $derived(hasDocument || hasStoryboardEdit);
  const aiRetouchTools = ['spot-healing', 'remove', 'healing-brush', 'patch', 'content-aware-move', 'red-eye'];
  const aiRetouchBrushTools = ['spot-healing', 'remove', 'healing-brush'];
  const AI_RETOUCH_FEATHER_MAX = 200;
  // Tools that share the round-brush controls (size / hardness / strength).
  const brushTools = ['brush', 'eraser', 'clone', 'smudge', 'blur', 'sharpen', 'dodge', 'burn', 'sponge', ...aiRetouchBrushTools, 'red-eye'];
  const usesBrush = $derived(brushTools.includes(tool));
  const isAiRetouch = $derived(aiRetouchTools.includes(tool));
  const isAiRetouchBrush = $derived(aiRetouchBrushTools.includes(tool));
  const usesAiRetouchSelectionMode = $derived(isAiRetouchBrush || tool === 'red-eye');
  const effectiveSelectionMode = $derived(
    isAiRetouch ? effectiveAiRetouchMaskMode(editor.selectionMode, !!editor.activeAiRetouchMaskLayer) : editor.selectionMode,
  );
  const strengthLabel = $derived(
    tool === 'brush' || tool === 'eraser' || tool === 'clone'
      ? 'Opacity'
      : tool === 'dodge' || tool === 'burn'
        ? 'Exposure'
        : tool === 'sponge'
          ? 'Flow'
          : 'Strength',
  );
  const workflowTools: Array<{ id: WorkflowTool; label: string; icon: string }> = [
    { id: 'hand', label: 'Hand tool', icon: Hand },
    { id: 'asset', label: 'Draw asset node', icon: ImageAdd },
    { id: 'composition', label: 'Place composition node', icon: Board },
    { id: 'output', label: 'Place output node', icon: Open },
    { id: 'zoom', label: 'Zoom workflow canvas', icon: Search },
  ];
  const nodePalettes = ['#3a3c42', '#3e4f7a', '#3e6b57', '#74583c', '#70435f', '#5b4f7a'];
  const selectedOutput = $derived(workflow.selectedOutputNode());
  const selectionModes: { id: SelectionMode; label: string; icon: string }[] = [
    { id: 'new', label: 'New', icon: MarqueeRect },
    { id: 'add', label: 'Add', icon: Add },
    { id: 'subtract', label: 'Subtract', icon: Dismiss },
    { id: 'intersect', label: 'Intersect', icon: SquareMultiple },
  ];
  let activeTip = $state<string | null>(null);
  let workflowPaletteOpen = $state(false);
  let workflowPaletteButton = $state<HTMLButtonElement>();

  function closeTipOnOutsidePointer(event: PointerEvent): void {
    if (!activeTip) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.tip-host')) return;
    activeTip = null;
  }

  $effect(() => {
    if (!activeTip) return;
    document.addEventListener('pointerdown', closeTipOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeTipOnOutsidePointer, true);
  });

  $effect(() => {
    if (!workflowPaletteOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.workflow-node-toolbar')) return;
      workflowPaletteOpen = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeWorkflowPalette();
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  });

  function requestWorkflowBoardAction(action: 'draft' | 'revise'): void {
    window.dispatchEvent(new CustomEvent('paintnode:workflow-board-action', { detail: { action } }));
  }

  function addWorkflowNode(type: CreatorNodeType): void {
    window.dispatchEvent(new CustomEvent('paintnode:workflow-add-node', { detail: { type } }));
    workflowPaletteOpen = false;
  }

  function closeWorkflowPalette(): void {
    workflowPaletteOpen = false;
    requestAnimationFrame(() => workflowPaletteButton?.focus());
  }

  function commitAiRetouchBrushFeather(): void {
    const value = Number.isFinite(editor.aiRetouchBrushFeather) ? editor.aiRetouchBrushFeather : 0;
    editor.aiRetouchBrushFeather = Math.max(0, Math.min(500, Math.round(value)));
  }

  // Free Transform: width/height are stored as scale factors and angle as radians,
  // so typed values are converted back before updating the live session. Each
  // handler reconciles the field back to the canonical value afterwards, so a
  // cleared/zero/negative entry (which is ignored) snaps back instead of sticking.
  function setFreeTransformWidth(input: HTMLInputElement): void {
    const t = editor.freeTransform;
    if (!t) return;
    const px = input.valueAsNumber;
    if (Number.isFinite(px) && px > 0) editor.updateFreeTransform({ scaleX: px / t.sourceWidth });
    const now = editor.freeTransform;
    if (now) input.value = String(Math.round(now.sourceWidth * now.scaleX));
  }
  function setFreeTransformHeight(input: HTMLInputElement): void {
    const t = editor.freeTransform;
    if (!t) return;
    const px = input.valueAsNumber;
    if (Number.isFinite(px) && px > 0) editor.updateFreeTransform({ scaleY: px / t.sourceHeight });
    const now = editor.freeTransform;
    if (now) input.value = String(Math.round(now.sourceHeight * now.scaleY));
  }
  function setFreeTransformAngle(input: HTMLInputElement): void {
    const t = editor.freeTransform;
    if (!t) return;
    const deg = input.valueAsNumber;
    if (Number.isFinite(deg)) editor.updateFreeTransform({ rotation: (deg * Math.PI) / 180 });
    const now = editor.freeTransform;
    if (now) input.value = String(Math.round((now.rotation * 180) / Math.PI));
  }
</script>

{#snippet selectionModeButtons()}
  <div class="seg mode-seg" role="group" aria-label="Selection mode">
    {#each selectionModes as mode (mode.id)}
      <button
        class:on={effectiveSelectionMode === mode.id}
        aria-label={`${mode.label} selection`}
        aria-pressed={effectiveSelectionMode === mode.id}
        use:tooltip={{ text: `${mode.label} selection`, placement: 'bottom' }}
        onclick={() => (editor.selectionMode = mode.id)}
      >
        <Icon svg={mode.icon} size={14} />
      </button>
    {/each}
  </div>
{/snippet}

{#snippet toolInfo(id: string, text: string)}
  <div class="tip-host">
    <button
      class="info-button"
      aria-label="Tool help"
      aria-expanded={activeTip === id}
      use:tooltip={{ text: 'Tool help', placement: 'bottom' }}
      onclick={() => (activeTip = activeTip === id ? null : id)}
    >
      <Icon svg={Info} size={15} />
    </button>
    {#if activeTip === id}
      <div class="tip-popover" role="status">{text}</div>
    {/if}
  </div>
{/snippet}

<div class="options">
  {#if hasWorkflow && !hasStoryboardEdit}
    <div class="workflow-tool-strip" role="toolbar" aria-label="Workflow board tools">
      {#each workflowTools as workflowTool (workflowTool.id)}
        <button
          type="button"
          class:active={workflow.tool === workflowTool.id}
          aria-label={workflowTool.label}
          aria-pressed={workflow.tool === workflowTool.id}
          use:tooltip={{ text: workflowTool.label, placement: 'bottom' }}
          onclick={() => workflow.setTool(workflowTool.id)}
        >
          <Icon svg={workflowTool.icon} size={14} />
        </button>
      {/each}
    </div>
    {#if workflow.tool === 'zoom'}
      <span class="divider"></span>
      <div class="seg">
        <button class:on={workflow.zoomMode === 'in'} onclick={() => workflow.setZoomMode('in')}>Zoom In</button>
        <button class:on={workflow.zoomMode === 'out'} onclick={() => workflow.setZoomMode('out')}>Zoom Out</button>
      </div>
      <button onclick={() => workflow.resetZoom()}>100%</button>
    {/if}

    <span class="divider"></span>
    <div class="workflow-node-toolbar" role="toolbar" aria-label="Workflow nodes">
      <span class="workflow-toolbar-label">Nodes</span>
      {#if desktop}
        <button
          type="button"
          aria-label="Revise current workflow"
          use:tooltip={{ text: 'Revise current workflow', placement: 'bottom' }}
          onclick={() => requestWorkflowBoardAction('revise')}
        >
          <Icon svg={ArrowSync} size={13} />
        </button>
      {/if}
      <button
        type="button"
        aria-label="Draft with AI Director"
        use:tooltip={{ text: 'Draft with AI Director', placement: 'bottom' }}
        onclick={() => requestWorkflowBoardAction('draft')}
      >
        <Icon svg={Sparkle} size={13} />
      </button>
      <button
        bind:this={workflowPaletteButton}
        type="button"
        class:active={workflowPaletteOpen}
        aria-label="Add workflow node"
        aria-haspopup="dialog"
        aria-expanded={workflowPaletteOpen}
        use:tooltip={{ text: 'Add workflow node', placement: 'bottom' }}
        onclick={() => (workflowPaletteOpen = !workflowPaletteOpen)}
      >
        <Icon svg={Add} size={13} />
      </button>
      {#if workflowPaletteOpen}
        <WorkflowNodePalette onAdd={addWorkflowNode} onClose={closeWorkflowPalette} />
      {/if}
    </div>

    <span class="divider"></span>
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
    {#if workflow.selection?.kind === 'composition'}
      <label class="opt">
        Storyboard
        <input type="number" min="64" class="num wide" value={workflow.storyboardWidth} oninput={(event) => workflow.setStoryboardSize(event.currentTarget.valueAsNumber, workflow.storyboardHeight)} />
        <span class="unit">x</span>
        <input type="number" min="64" class="num wide" value={workflow.storyboardHeight} oninput={(event) => workflow.setStoryboardSize(workflow.storyboardWidth, event.currentTarget.valueAsNumber)} />
      </label>
    {:else if workflow.selection?.kind === 'output' && selectedOutput}
      <label class="opt">
        Final
        <input type="number" min="64" class="num wide" value={selectedOutput.finalWidth} oninput={(event) => workflow.setOutputFinalSize(selectedOutput.id, event.currentTarget.valueAsNumber, selectedOutput.finalHeight)} />
        <span class="unit">x</span>
        <input type="number" min="64" class="num wide" value={selectedOutput.finalHeight} oninput={(event) => workflow.setOutputFinalSize(selectedOutput.id, selectedOutput.finalWidth, event.currentTarget.valueAsNumber)} />
      </label>
    {/if}
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
  {:else if hasDrawingSurface}
    {#if editor.freeTransform}
      <span class="tool-name">Free Transform</span>
      <span class="divider"></span>
      <label class="opt">
        W
        <input
          type="number"
          min="1"
          step="1"
          class="num"
          value={Math.round(editor.freeTransform.sourceWidth * editor.freeTransform.scaleX)}
          onchange={(event) => setFreeTransformWidth(event.currentTarget)}
        />
        <span class="unit">px</span>
      </label>
      <label class="opt">
        H
        <input
          type="number"
          min="1"
          step="1"
          class="num"
          value={Math.round(editor.freeTransform.sourceHeight * editor.freeTransform.scaleY)}
          onchange={(event) => setFreeTransformHeight(event.currentTarget)}
        />
        <span class="unit">px</span>
      </label>
      <label class="opt">
        Angle
        <input
          type="number"
          step="1"
          class="num"
          value={Math.round((editor.freeTransform.rotation * 180) / Math.PI)}
          onchange={(event) => setFreeTransformAngle(event.currentTarget)}
        />
        <span class="unit">°</span>
      </label>
      <button onclick={() => editor.cancelFreeTransform()}>Cancel</button>
      <button class="primary-option" onclick={() => editor.commitFreeTransform()}>Done</button>
      {@render toolInfo('transform', 'Drag handles to scale, drag the round handle to rotate, press Enter to apply.')}
    {:else}
      <span class="tool-name">{editor.activeTool.name}</span>
      <span class="divider"></span>

      {#if usesBrush}
        {#if usesAiRetouchSelectionMode}
          {@render selectionModeButtons()}
        {/if}
        <label class="opt">
          Size
          <input type="range" min="1" max="500" bind:value={editor.brushSize} />
          <input type="number" min="1" max="2000" bind:value={editor.brushSize} class="num" />
          <span class="unit">px</span>
        </label>
        {#if tool !== 'red-eye'}
          <label class="opt">
            Hardness
            <input type="range" min="0" max="1" step="0.01" bind:value={editor.brushHardness} />
            <span class="val">{Math.round(editor.brushHardness * 100)}%</span>
          </label>
        {/if}
        {#if isAiRetouchBrush}
          <label class="opt">
            Feather
            <input
              type="range"
              min="0"
              max={AI_RETOUCH_FEATHER_MAX}
              step="1"
              bind:value={editor.aiRetouchBrushFeather}
              oninput={commitAiRetouchBrushFeather}
            />
            <input
              type="number"
              min="0"
              max="500"
              step="1"
              bind:value={editor.aiRetouchBrushFeather}
              class="num"
              onchange={commitAiRetouchBrushFeather}
            />
            <span class="unit">px</span>
          </label>
        {/if}
        {#if !isAiRetouchBrush && tool !== 'red-eye'}
          <label class="opt">
            {strengthLabel}
            <input type="range" min="0" max="1" step="0.01" bind:value={editor.brushOpacity} />
            <span class="val">{Math.round(editor.brushOpacity * 100)}%</span>
          </label>
        {/if}
        {#if tool === 'healing-brush'}
          <span class="pill">{editor.aiRetouchHealingSource ? 'Source set' : 'No source'}</span>
          <button onclick={() => editor.clearAiRetouchHealingSource()} disabled={!editor.aiRetouchHealingSource}>Clear Source</button>
          {@render toolInfo('healing-brush', 'Paint to create or refine an AI mask. Alt-click sets the source reference. Use the Contextual Task Bar to run AI Retouch.')}
        {:else if tool === 'spot-healing'}
          {@render toolInfo('spot-healing', 'Paint over small flaws to create or refine an AI mask. Use the Contextual Task Bar to run AI Retouch.')}
        {:else if tool === 'remove'}
          {@render toolInfo('remove', 'Brush over or loop around the distraction to create or refine an AI mask. Use Add/Subtract modes to adjust it before running.')}
        {:else if tool === 'red-eye'}
          {@render toolInfo('red-eye', 'Click or drag around the pupil reflection to create or refine an AI mask. Run from the Contextual Task Bar.')}
        {:else if tool === 'clone'}
          <label class="opt"><input type="checkbox" bind:checked={editor.cloneAligned} /> Aligned</label>
          {@render toolInfo('clone', 'Alt-click to set the source, then paint.')}
        {:else if tool === 'dodge' || tool === 'burn'}
          <label class="opt">
            Range
            <select bind:value={editor.toneRange}>
              <option value="shadows">Shadows</option>
              <option value="midtones">Midtones</option>
              <option value="highlights">Highlights</option>
            </select>
          </label>
          {@render toolInfo(tool, `Drag to ${tool === 'dodge' ? 'lighten' : 'darken'} the ${editor.toneRange}.`)}
        {:else if tool === 'sponge'}
          <label class="opt">
            Mode
            <select bind:value={editor.spongeMode}>
              <option value="saturate">Saturate</option>
              <option value="desaturate">Desaturate</option>
            </select>
          </label>
          {@render toolInfo('sponge', `Drag to ${editor.spongeMode === 'saturate' ? 'boost' : 'reduce'} saturation.`)}
        {:else if tool === 'smudge'}
          {@render toolInfo('smudge', 'Drag to push pixels along the stroke.')}
        {:else if tool === 'blur' || tool === 'sharpen'}
          {@render toolInfo(tool, `Drag to ${tool} pixels under the brush.`)}
        {/if}
    {:else if isAiRetouch && tool === 'patch'}
      {@render selectionModeButtons()}
      <div class="seg">
        <button class:on={editor.aiRetouchPatchMode === 'source'} onclick={() => (editor.aiRetouchPatchMode = 'source')}>Source</button>
        <button class:on={editor.aiRetouchPatchMode === 'destination'} onclick={() => (editor.aiRetouchPatchMode = 'destination')}>Destination</button>
      </div>
      <button onclick={() => editor.clearActiveAiRetouchMask()} disabled={!editor.activeAiRetouchMaskLayer}>Clear Mask</button>
      {@render toolInfo('patch', 'Draw or refine an AI mask, then drag inside it to choose the patch reference. Run from the Contextual Task Bar.')}
    {:else if isAiRetouch && tool === 'content-aware-move'}
      {@render selectionModeButtons()}
      <div class="seg">
        <button class:on={editor.aiRetouchMoveMode === 'move'} onclick={() => (editor.aiRetouchMoveMode = 'move')}>Move</button>
        <button class:on={editor.aiRetouchMoveMode === 'extend'} onclick={() => (editor.aiRetouchMoveMode = 'extend')}>Extend</button>
      </div>
      <button onclick={() => editor.clearActiveAiRetouchMask()} disabled={!editor.activeAiRetouchMaskLayer}>Clear Mask</button>
      {@render toolInfo('content-aware-move', 'Draw or refine a subject mask, then drag inside it to place or extend it. Run from the Contextual Task Bar.')}
    {:else if tool === 'marquee'}
      {@render selectionModeButtons()}
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
      {@render toolInfo('marquee', 'Shift adds. Option subtracts. Shift+Option intersects. Command-drag moves selected pixels.')}
    {:else if tool === 'lasso'}
      {@render selectionModeButtons()}
      <button onclick={() => editor.selectAll()}>Select All</button>
      <button onclick={() => editor.deselect()} disabled={!editor.selection}>Deselect</button>
      <button onclick={() => editor.invertSelection()} disabled={!editor.selection}>Invert</button>
      {@render toolInfo('lasso', 'Drag to draw a freeform selection. Shift adds. Option subtracts. Shift+Option intersects.')}
    {:else if tool === 'magicwand'}
      {@render selectionModeButtons()}
      <label class="opt">
        Tolerance
        <input type="range" min="0" max="255" bind:value={editor.tolerance} />
        <input type="number" min="0" max="255" bind:value={editor.tolerance} class="num" />
      </label>
      <label class="opt"><input type="checkbox" bind:checked={editor.magicContiguous} /> Contiguous</label>
      <button onclick={() => editor.deselect()} disabled={!editor.selection}>Deselect</button>
      <button onclick={() => editor.invertSelection()} disabled={!editor.selection}>Invert</button>
      {@render toolInfo('magicwand', 'Click to select by color. Shift adds. Option subtracts. Shift+Option intersects.')}
    {:else if tool === 'crop'}
      <button onclick={() => editor.cropToSelection()} disabled={!editor.selection}>Apply (↵)</button>
      <button onclick={() => editor.deselect()} disabled={!editor.selection}>Reset</button>
      {@render toolInfo('crop', 'Drag to set the crop box, then Apply or press Enter.')}
    {:else if tool === 'fill'}
      <label class="opt">
        Tolerance
        <input type="range" min="0" max="255" bind:value={editor.tolerance} />
        <input type="number" min="0" max="255" bind:value={editor.tolerance} class="num" />
      </label>
      {@render toolInfo('fill', 'Click to flood-fill with the foreground color.')}
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
      {@render toolInfo('shape', 'Drag to draw. Shift constrains proportions or angle.')}
    {:else if tool === 'annotation'}
      <label class="opt">
        Type
        <select bind:value={editor.annotationType}>
          <option value="arrow">Arrow</option>
          <option value="note">Memo</option>
          <option value="callout">Callout</option>
          <option value="badge">Badge</option>
          <option value="divider">Divider</option>
        </select>
      </label>
      <label class="opt">
        Width
        <input type="range" min="1" max="40" bind:value={editor.shapeStrokeWidth} />
        <span class="val">{editor.shapeStrokeWidth}px</span>
      </label>
      {#if editor.annotationType !== 'arrow' && editor.annotationType !== 'divider'}
        <label class="opt">
          Text
          <input class="annotation-text" bind:value={editor.annotationText} placeholder="annotation text" />
        </label>
      {/if}
      {#if editor.doc}
        <button onclick={() => editor.setAnnotationsVisible(!editor.doc!.annotationsVisible)}>
          {editor.doc.annotationsVisible ? 'Hide' : 'Show'}
        </button>
        <button onclick={() => editor.rasterizeAnnotations()} disabled={!editor.doc.annotations.length}>Rasterize</button>
      {/if}
      {@render toolInfo('annotation', 'Drag to place an editable overlay annotation.')}
    {:else if tool === 'gradient'}
      <label class="opt">
        Type
        <select bind:value={editor.gradientType}>
          <option value="fg-bg">Foreground → Background</option>
          <option value="fg-transparent">Foreground → Transparent</option>
        </select>
      </label>
      {@render toolInfo('gradient', 'Drag to set direction. Shift constrains the angle.')}
    {:else if tool === 'text'}
      {@render toolInfo('text', 'Click to add text, or click existing text to edit. Esc commits the edit.')}
    {:else if tool === 'type-vertical'}
      {@render toolInfo('type-vertical', 'Click to add vertical text (columns flow right to left). Esc commits the edit.')}
    {:else if tool === 'type-mask-h'}
      {@render toolInfo('type-mask-h', 'Type, then Esc to turn the text shape into a selection instead of a layer.')}
    {:else if tool === 'type-mask-v'}
      {@render toolInfo('type-mask-v', 'Vertical type mask: type, then Esc to make a text-shaped selection.')}
    {:else if tool === 'eyedropper'}
      {@render toolInfo('eyedropper', 'Click or drag to sample a color into the foreground.')}
    {:else if tool === 'move'}
      {@render toolInfo('move', "Drag to move the active layer's pixels.")}
    {:else if tool === 'hand'}
      {@render toolInfo('hand', 'Drag to pan. Tip: hold Space with any tool to pan.')}
    {:else if tool === 'zoom'}
      <div class="seg">
        <button class:on={editor.effectiveZoomMode === 'in'} onclick={() => (editor.zoomMode = 'in')}>Zoom In</button>
        <button class:on={editor.effectiveZoomMode === 'out'} onclick={() => (editor.zoomMode = 'out')}>Zoom Out</button>
      </div>
      <button onclick={() => editor.viewport?.fitToView()}>Fit Screen</button>
      <button onclick={() => editor.viewport?.setZoom(1)}>100%</button>
      {@render toolInfo('zoom', `Click to zoom ${editor.effectiveZoomMode}. Hold Alt to invert. Use Command+Plus / Command+Minus for keyboard zoom.`)}
      {/if}
    {/if}
  {/if}
</div>

<style>
  .options {
    position: relative;
    z-index: 30;
    height: var(--options-h);
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 0 12px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
    overflow: visible;
    white-space: nowrap;
  }
  .workflow-tool-strip,
  .workflow-node-toolbar {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex: none;
  }
  .workflow-node-toolbar {
    position: relative;
  }
  .workflow-tool-strip > button,
  .workflow-node-toolbar > button {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--text);
  }
  .workflow-tool-strip > button:hover,
  .workflow-node-toolbar > button:hover,
  .workflow-tool-strip > button.active,
  .workflow-node-toolbar > button.active {
    background: var(--bg-elevated);
    color: var(--text-bright);
  }
  .workflow-tool-strip > button.active {
    background: color-mix(in srgb, var(--accent) 72%, var(--bg-elevated));
    color: #fff;
  }
  .workflow-toolbar-label {
    margin-right: 3px;
    color: var(--text-dim);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .workflow-node-toolbar :global(.node-palette) {
    top: 29px;
    left: -8px;
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
  .num.wide {
    width: 70px;
  }
  .val {
    width: 38px;
    color: var(--text);
    text-align: right;
  }
  .unit {
    color: var(--text-dim);
  }
  .pill {
    min-width: 86px;
    padding: 3px 8px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-input);
    color: var(--text);
  }
  .primary-option {
    color: #fff;
    background: var(--accent);
    border-color: var(--accent);
  }
  .node-name {
    width: 180px;
  }
  .annotation-text {
    width: 210px;
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
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    border: none;
    border-radius: 0;
    background: var(--bg-elevated);
    padding: 4px 10px;
  }
  .mode-seg button {
    width: 34px;
    padding: 4px 0;
  }
  .seg button:not(:last-child) {
    border-right: 1px solid var(--border-soft);
  }
  .seg button.on {
    background: var(--accent);
    color: #fff;
  }
  .tip-host {
    position: relative;
    display: inline-flex;
    align-items: center;
  }
  .info-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 24px;
    padding: 0;
  }
  .tip-popover {
    position: absolute;
    top: calc(100% + 7px);
    left: 50%;
    z-index: 40;
    width: max-content;
    max-width: min(360px, 70vw);
    padding: 8px 10px;
    border: 1px solid var(--border-soft);
    border-radius: 4px;
    background: var(--bg-elevated);
    box-shadow: 0 10px 22px rgb(0 0 0 / 35%);
    color: var(--text);
    font-size: 12px;
    line-height: 1.35;
    white-space: normal;
    transform: translateX(-50%);
  }
</style>
