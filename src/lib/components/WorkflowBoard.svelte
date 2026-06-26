<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { composeCodexWorkflow, isDesktop, type ProjectAsset, type ProjectFile } from '../integrations/desktop';
  import { bytesToBitmap, canvasToPngBytes } from '../io';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { workflow, type WorkflowAssetNode } from '../state/workflow.svelte';
  import { Add, ArrowSync, Delete, Dismiss, Document, Image, Link, Open, PaintBrush, Sparkle } from '../icons';

  type CodexProgressPayload = { runId: string; message: string };

  const desktop = isDesktop();
  let codexBin = $state('');
  let busy = $state(false);
  let progress = $state('');
  let error = $state('');
  let dragging: { type: 'asset' | 'prompt' | 'output'; id?: string; dx: number; dy: number } | null = null;
  let panning: { x: number; y: number } | null = null;
  let drawing = $state<{ type: 'asset' | 'composition' | 'output'; x: number; y: number; width: number; height: number } | null>(null);
  let sketching = false;
  let boardEl = $state<HTMLDivElement>();
  let storyboardCanvas = $state<HTMLCanvasElement>();
  let stopProgress: UnlistenFn | null = null;

  const ASSET_NODE_W = 205;
  const NODE_HEAD_H = 32;
  const STORYBOARD_W = 312;
  const STORYBOARD_H = 132;

  const assets = $derived(project.current?.assets.filter((asset) => asset.exists) ?? []);
  const assetByPath = $derived(new Map(assets.map((asset) => [asset.relativePath, asset])));
  const outputAsset = $derived(
    assets.find((asset) => asset.id === workflow.outputAssetId || asset.relativePath === workflow.outputRelativePath) ?? null,
  );

  onDestroy(() => stopProgress?.());

  $effect(() => {
    if (storyboardCanvas) {
      void restoreStoryboard(workflow.storyboardDataUrl);
    }
  });

  function assetFor(node: WorkflowAssetNode): ProjectAsset | null {
    return assets.find((asset) => asset.id === node.assetId || asset.relativePath === node.relativePath) ?? null;
  }

  function workflowFiles(): ProjectFile[] {
    return project.current?.files.filter((file) => file.kind === 'workflow') ?? [];
  }

  function createRunId(): string {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function save(): Promise<void> {
    try {
      const relativePath = await workflow.save();
      editor.flash(relativePath ? `Saved ${relativePath}` : 'Open a project folder to save workflow');
    } catch (e) {
      editor.flash('Workflow save failed: ' + ((e as Error)?.message ?? String(e)));
    }
  }

  async function saveAs(): Promise<void> {
    const name = window.prompt('Workflow name', workflow.name);
    if (!name) return;
    try {
      const relativePath = await workflow.saveAs(name);
      editor.flash(relativePath ? `Saved ${relativePath}` : 'Open a project folder to save workflow');
    } catch (e) {
      editor.flash('Workflow save failed: ' + ((e as Error)?.message ?? String(e)));
    }
  }

  async function openWorkflow(file: ProjectFile): Promise<void> {
    try {
      workflow.openFromBytes(await project.readFile(file), file.relativePath, file.name.replace(/\.cxflow\.json$/i, ''));
      editor.flash(`Opened ${file.name}`);
    } catch (e) {
      editor.flash('Open workflow failed: ' + ((e as Error)?.message ?? String(e)));
    }
  }

  async function placeOutput(): Promise<void> {
    if (!outputAsset) return;
    try {
      const result = await project.readAsset(outputAsset);
      const bytes = await (await fetch(result.dataUrl)).arrayBuffer();
      const bmp = await bytesToBitmap(new Uint8Array(bytes), outputAsset.mime ?? 'image/png');
      editor.placeImage(bmp, bmp.width, bmp.height, outputAsset.name.replace(/\.[^.]+$/, ''), {
        assetId: outputAsset.id,
        path: outputAsset.relativePath,
      });
      bmp.close();
      editor.flash(`Placed ${outputAsset.name}`);
    } catch (e) {
      editor.flash('Place output failed: ' + ((e as Error)?.message ?? String(e)));
    }
  }

  function dragPointerDown(
    event: PointerEvent,
    type: 'asset' | 'prompt' | 'output',
    node: WorkflowAssetNode | undefined = undefined,
  ): void {
    if (!(event.currentTarget instanceof HTMLElement) || !boardEl) return;
    const x = type === 'asset' ? (node?.x ?? 0) : type === 'prompt' ? workflow.promptX : workflow.outputX;
    const y = type === 'asset' ? (node?.y ?? 0) : type === 'prompt' ? workflow.promptY : workflow.outputY;
    if (type === 'asset' && node) workflow.select({ kind: 'asset', id: node.id });
    else workflow.select(type === 'prompt' ? { kind: 'composition' } : { kind: 'output' });
    dragging = {
      type,
      id: node?.id,
      dx: boardPoint(event).x - x,
      dy: boardPoint(event).y - y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }

  function dragHandle(
    element: HTMLElement,
    params: { type: 'asset' | 'prompt' | 'output'; node?: WorkflowAssetNode },
  ): { update: (next: { type: 'asset' | 'prompt' | 'output'; node?: WorkflowAssetNode }) => void; destroy: () => void } {
    let current = params;
    const onDown = (event: PointerEvent) => dragPointerDown(event, current.type, current.node);
    element.addEventListener('pointerdown', onDown);
    return {
      update(next) {
        current = next;
      },
      destroy() {
        element.removeEventListener('pointerdown', onDown);
      },
    };
  }

  function onPointerMove(event: PointerEvent): void {
    if (panning) {
      workflow.panBy(event.clientX - panning.x, event.clientY - panning.y);
      panning = { x: event.clientX, y: event.clientY };
      return;
    }
    if (drawing) {
      const point = boardPoint(event);
      drawing = {
        ...drawing,
        width: point.x - drawing.x,
        height: point.y - drawing.y,
      };
      return;
    }
    if (dragging) {
      const point = boardPoint(event);
      const x = point.x - dragging.dx;
      const y = point.y - dragging.dy;
      if (dragging.type === 'asset' && dragging.id) workflow.moveNode(dragging.id, x, y);
      else if (dragging.type === 'prompt') workflow.movePrompt(x, y);
      else workflow.moveOutput(x, y);
    }
  }

  function stopDrag(): void {
    if (drawing) {
      commitDrawing();
    }
    dragging = null;
    panning = null;
  }

  function boardPoint(event: PointerEvent): { x: number; y: number } {
    if (!boardEl) return { x: 0, y: 0 };
    const rect = boardEl.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - workflow.panX) / workflow.zoom,
      y: (event.clientY - rect.top - workflow.panY) / workflow.zoom,
    };
  }

  function normalizeRect(rect: { x: number; y: number; width: number; height: number }): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const x = rect.width < 0 ? rect.x + rect.width : rect.x;
    const y = rect.height < 0 ? rect.y + rect.height : rect.y;
    return {
      x,
      y,
      width: Math.abs(rect.width),
      height: Math.abs(rect.height),
    };
  }

  function onBoardPointerDown(event: PointerEvent): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    if (event.button !== 0) return;
    if (workflow.tool === 'zoom') {
      if (!boardEl) return;
      const rect = boardEl.getBoundingClientRect();
      const direction = event.altKey
        ? workflow.zoomMode === 'in' ? 'out' : 'in'
        : workflow.zoomMode;
      workflow.zoomAt(event.clientX - rect.left, event.clientY - rect.top, direction);
      return;
    }
    if (workflow.tool === 'move') {
      panning = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const point = boardPoint(event);
    drawing = { type: workflow.tool, x: point.x, y: point.y, width: 0, height: 0 };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function commitDrawing(): void {
    if (!drawing) return;
    const rect = normalizeRect(drawing);
    const width = rect.width < 12 ? (drawing.type === 'composition' ? workflow.compositionWidth : drawing.type === 'output' ? workflow.outputWidth : ASSET_NODE_W) : rect.width;
    const height = rect.height < 12 ? (drawing.type === 'composition' ? workflow.compositionHeight : drawing.type === 'output' ? workflow.outputHeight : 190) : rect.height;
    if (drawing.type === 'asset') workflow.addBlankAsset(rect.x, rect.y, width, height);
    else if (drawing.type === 'composition') {
      workflow.movePrompt(rect.x, rect.y);
      workflow.resizePrompt(width, height);
      workflow.select({ kind: 'composition' });
      workflow.setTool('move');
    } else {
      workflow.moveOutput(rect.x, rect.y);
      workflow.resizeOutput(width, height);
      workflow.select({ kind: 'output' });
      workflow.setTool('move');
    }
    drawing = null;
  }

  function assetTitle(node: WorkflowAssetNode): string {
    return `Asset - ${node.name || 'Untitled'}`;
  }

  function compositionTitle(): string {
    return workflow.compositionName ? `Composition - ${workflow.compositionName}` : 'Composition';
  }

  function outputTitle(): string {
    return workflow.outputName ? `Output - ${workflow.outputName}` : 'Output';
  }

  function storyboardCtx(): CanvasRenderingContext2D | null {
    if (!storyboardCanvas) return null;
    const ctx = storyboardCanvas.getContext('2d');
    if (!ctx) return null;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#5bb7ff';
    return ctx;
  }

  function isStoryboardBlank(): boolean {
    if (!storyboardCanvas) return true;
    const ctx = storyboardCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return true;
    const data = ctx.getImageData(0, 0, storyboardCanvas.width, storyboardCanvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 0) return false;
    }
    return true;
  }

  async function restoreStoryboard(dataUrl: string | null): Promise<void> {
    if (!storyboardCanvas) return;
    const ctx = storyboardCtx();
    if (!ctx) return;
    ctx.clearRect(0, 0, storyboardCanvas.width, storyboardCanvas.height);
    if (!dataUrl) return;
    const img = new globalThis.Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not load storyboard sketch.'));
      img.src = dataUrl;
    });
    ctx.drawImage(img, 0, 0, storyboardCanvas.width, storyboardCanvas.height);
  }

  function persistStoryboard(): void {
    if (!storyboardCanvas || isStoryboardBlank()) {
      workflow.setStoryboardDataUrl(null);
      return;
    }
    workflow.setStoryboardDataUrl(storyboardCanvas.toDataURL('image/png'));
  }

  function sketchPoint(event: PointerEvent): { x: number; y: number } | null {
    if (!storyboardCanvas) return null;
    const rect = storyboardCanvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * storyboardCanvas.width,
      y: ((event.clientY - rect.top) / rect.height) * storyboardCanvas.height,
    };
  }

  function startSketch(event: PointerEvent): void {
    const ctx = storyboardCtx();
    const point = sketchPoint(event);
    if (!ctx || !point || !(event.currentTarget instanceof HTMLElement)) return;
    sketching = true;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    event.currentTarget.setPointerCapture(event.pointerId);
    event.stopPropagation();
  }

  function moveSketch(event: PointerEvent): void {
    if (!sketching) return;
    const ctx = storyboardCtx();
    const point = sketchPoint(event);
    if (!ctx || !point) return;
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    event.stopPropagation();
  }

  function stopSketch(event: PointerEvent | undefined = undefined): void {
    if (!sketching) return;
    sketching = false;
    persistStoryboard();
    event?.stopPropagation();
  }

  function clearStoryboard(event: MouseEvent): void {
    event.stopPropagation();
    const ctx = storyboardCtx();
    if (!ctx || !storyboardCanvas) return;
    ctx.clearRect(0, 0, storyboardCanvas.width, storyboardCanvas.height);
    workflow.setStoryboardDataUrl(null);
  }

  async function generate(): Promise<void> {
    error = '';
    if (!desktop) {
      error = 'Workflow generation is available only in the desktop app.';
      return;
    }
    if (!project.path) {
      error = 'Open a project folder before generating.';
      return;
    }
    const includedNodes = workflow.nodes.filter((node) => node.included);
    if (!includedNodes.length) {
      error = 'Connect at least one asset to the composition prompt.';
      return;
    }
    if (!workflow.prompt.trim()) {
      error = 'Enter a composition prompt.';
      return;
    }

    busy = true;
    progress = 'Preparing workflow assets...';
    const runId = createRunId();
    stopProgress?.();
    stopProgress = null;
    try {
      stopProgress = await listen<CodexProgressPayload>('codex-generation-progress', (event) => {
        if (event.payload.runId === runId && event.payload.message.trim()) {
          progress = event.payload.message.trim();
        }
      });
    } catch {
      progress = 'Local Codex is running...';
    }

    try {
      const sources = [];
      for (const node of includedNodes) {
        const asset = assetFor(node);
        if (!asset) continue;
        sources.push({
          name: node.note ? `${node.name}: ${node.note}` : node.name,
          bytes: await project.readFile({ ...asset, kind: 'generated', modifiedAt: asset.createdAt, size: 0, exists: true }),
        });
      }
      if (storyboardCanvas && !isStoryboardBlank()) {
        sources.push({
          name: 'Storyboard sketch: composition layout and handwritten placement annotations',
          bytes: await canvasToPngBytes(storyboardCanvas),
        });
        persistStoryboard();
      }
      if (!sources.length) throw new Error('Workflow asset files are missing.');
      const result = await composeCodexWorkflow({ bin: codexBin, projectPath: project.path, runId }, workflow.prompt, sources);
      if (result.asset) {
        await project.refresh();
        workflow.setOutput(result.asset);
      }
      editor.flash('Workflow composition generated');
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
      editor.flash('Workflow generation failed');
    } finally {
      busy = false;
      progress = '';
      stopProgress?.();
      stopProgress = null;
    }
  }
</script>

<section class="workflow-shell">
  <div class="workflow-main">
    <aside class="asset-tray">
      <div class="tray-head">
        <span>Assets</span>
        <button
          aria-label="Refresh project"
          use:tooltip={{ text: 'Refresh project', placement: 'right' }}
          onclick={() => void project.refresh()}
        >
          <Icon svg={ArrowSync} size={14} />
        </button>
      </div>
      {#if !project.path}
        <p class="empty">Open a project folder to use generated and imported assets.</p>
      {:else}
        <div class="asset-list">
          {#each assets as asset (asset.id)}
            <button class="asset-item" onclick={() => workflow.addAsset(asset)}>
              {#if asset.previewDataUrl}<img src={asset.previewDataUrl} alt="" />{:else}<Icon svg={Image} size={20} />{/if}
              <span>{asset.name}</span>
              <Icon svg={Add} size={14} />
            </button>
          {/each}
        </div>
      {/if}

      <div class="tray-head workflows">
        <span>Workflows</span>
      </div>
      <div class="workflow-list">
        {#each workflowFiles() as file (file.relativePath)}
          <button onclick={() => void openWorkflow(file)}>
            <Icon svg={Document} size={14} />
            <span>{file.name}</span>
          </button>
        {/each}
      </div>
    </aside>

    <div
      class="board"
      class:adding={workflow.tool !== 'move' && workflow.tool !== 'zoom'}
      class:panning={workflow.tool === 'move'}
      class:zooming={workflow.tool === 'zoom'}
      role="application"
      aria-label="Workflow composition board"
      bind:this={boardEl}
      style={`background-position:${workflow.panX}px ${workflow.panY}px; background-size:${24 * workflow.zoom}px ${24 * workflow.zoom}px`}
      onpointerdown={onBoardPointerDown}
      onpointermove={onPointerMove}
      onpointerup={stopDrag}
      onpointercancel={stopDrag}
    >
      <div class="board-world" style={`transform:translate(${workflow.panX}px, ${workflow.panY}px) scale(${workflow.zoom})`}>
        <svg class="links" aria-hidden="true">
          {#each workflow.nodes.filter((node) => node.included) as node (node.id)}
            <line
              x1={node.x + node.width}
              y1={node.y + NODE_HEAD_H / 2}
              x2={workflow.promptX}
              y2={workflow.promptY + NODE_HEAD_H / 2}
            />
          {/each}
        </svg>

        {#if drawing}
          {@const rect = normalizeRect(drawing)}
          <div
            class="draw-preview"
            style={`transform:translate(${rect.x}px, ${rect.y}px); width:${Math.max(12, rect.width)}px; height:${Math.max(12, rect.height)}px`}
          ></div>
        {/if}

        {#each workflow.nodes as node (node.id)}
          {@const asset = assetFor(node)}
          <article
            class="asset-node"
            class:included={node.included}
            class:selected={workflow.selection?.kind === 'asset' && workflow.selection.id === node.id}
            style={`transform:translate(${node.x}px, ${node.y}px); width:${node.width}px; --node-color:${node.color}`}
            onpointerdown={(event) => {
              workflow.select({ kind: 'asset', id: node.id });
              event.stopPropagation();
            }}
          >
            <div class="node-head" use:dragHandle={{ type: 'asset', node }}>
              <span>{assetTitle(node)}</span>
              <div class="node-tools">
                <button
                  class:active={node.included}
                  aria-label={`${node.included ? 'Exclude' : 'Include'} ${node.name} in composition`}
                  use:tooltip={{ text: node.included ? 'Connected to composition' : 'Include in composition', placement: 'top' }}
                  onclick={(event) => {
                    event.stopPropagation();
                    workflow.setNodeIncluded(node.id, !node.included);
                  }}
                >
                  <Icon svg={Link} size={13} />
                </button>
                <button
                  aria-label={`Remove ${node.name}`}
                  use:tooltip={{ text: 'Remove node', placement: 'top' }}
                  onclick={(event) => {
                    event.stopPropagation();
                    workflow.removeNode(node.id);
                  }}
                >
                  <Icon svg={Delete} size={13} />
                </button>
              </div>
            </div>
            <div class="node-preview" style={`height:${Math.max(64, node.height - 84)}px`}>
              {#if asset?.previewDataUrl}<img src={asset.previewDataUrl} alt="" />{:else}<Icon svg={Image} size={28} />{/if}
            </div>
            <textarea
              aria-label={`Role for ${node.name}`}
              placeholder="role in composition"
              value={node.note}
              onpointerdown={(event) => event.stopPropagation()}
              oninput={(event) => workflow.setNodeNote(node.id, event.currentTarget.value)}
            ></textarea>
          </article>
        {/each}

        <article
          class="prompt-node"
          class:selected={workflow.selection?.kind === 'composition'}
          style={`transform:translate(${workflow.promptX}px, ${workflow.promptY}px); width:${workflow.compositionWidth}px; --node-color:${workflow.compositionColor}`}
          onpointerdown={(event) => {
            workflow.select({ kind: 'composition' });
            event.stopPropagation();
          }}
        >
          <div class="node-head" use:dragHandle={{ type: 'prompt' }}>
            <span>{compositionTitle()}</span>
            <div class="node-tools">
              <span class="connected-count">{workflow.nodes.filter((node) => node.included).length} linked</span>
            </div>
          </div>
          <div class="storyboard">
            <div class="storyboard-head">
              <span><Icon svg={PaintBrush} size={13} /> Storyboard</span>
              <button
                aria-label="Clear storyboard"
                use:tooltip={{ text: 'Clear storyboard', placement: 'top' }}
                onclick={clearStoryboard}
              >
                <Icon svg={Dismiss} size={13} />
              </button>
            </div>
            <canvas
              bind:this={storyboardCanvas}
              width={STORYBOARD_W}
              height={STORYBOARD_H}
              aria-label="Storyboard annotation canvas"
              onpointerdown={startSketch}
              onpointermove={moveSketch}
              onpointerup={stopSketch}
              onpointercancel={stopSketch}
            ></canvas>
          </div>
          <textarea
            class="composition-text"
            placeholder="A girl on the beach standing in front of an ice cream truck, holding an ice cream..."
            value={workflow.prompt}
            onpointerdown={(event) => event.stopPropagation()}
            oninput={(event) => workflow.setPrompt(event.currentTarget.value)}
          ></textarea>
          <label>
            <span>Codex command</span>
            <input bind:value={codexBin} placeholder="codex or full path" />
          </label>
          {#if busy}<p class="progress">{progress}</p>{/if}
          {#if error}<p class="err">{error}</p>{/if}
        </article>

        <article
          class="output-node"
          class:selected={workflow.selection?.kind === 'output'}
          style={`transform:translate(${workflow.outputX}px, ${workflow.outputY}px); width:${workflow.outputWidth}px; --node-color:${workflow.outputColor}`}
          onpointerdown={(event) => {
            workflow.select({ kind: 'output' });
            event.stopPropagation();
          }}
        >
          <div class="node-head" use:dragHandle={{ type: 'output' }}><span>{outputTitle()}</span></div>
          <div class="output-preview" style={`height:${Math.max(76, workflow.outputHeight - 74)}px`}>
            {#if outputAsset?.previewDataUrl}<img src={outputAsset.previewDataUrl} alt="" />{:else}<Icon svg={Image} size={32} />{/if}
          </div>
          <div class="output-actions">
            <button onclick={() => void placeOutput()} disabled={!outputAsset}>
              <Icon svg={Open} size={14} />
              Place
            </button>
          </div>
        </article>
      </div>
    </div>
  </div>
</section>

<style>
  .workflow-shell {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    background: #242526;
    color: var(--text);
  }
  .node-head,
  .output-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .workflow-main {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .asset-tray {
    width: 248px;
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-panel);
  }
  .tray-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .workflows {
    border-top: 1px solid var(--border);
  }
  .asset-list,
  .workflow-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: auto;
    padding: 0 8px 8px;
  }
  .asset-item,
  .workflow-list button {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) 16px;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 5px;
    text-align: left;
  }
  .workflow-list button {
    grid-template-columns: 18px minmax(0, 1fr);
  }
  .asset-item img {
    width: 34px;
    height: 34px;
    object-fit: cover;
    background: var(--bg-input);
  }
  .asset-item span,
  .workflow-list span,
  .node-head span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty,
  .err,
  .progress {
    margin: 8px;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.4;
  }
  .err {
    color: #ffb0b0;
  }
  .board {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    background-color: #202123;
    background-image:
      linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
    background-size: 24px 24px;
    touch-action: none;
  }
  .board.panning {
    cursor: grab;
  }
  .board.panning:active {
    cursor: grabbing;
  }
  .board.adding {
    cursor: copy;
  }
  .board.zooming {
    cursor: zoom-in;
  }
  .board-world {
    position: absolute;
    inset: 0;
    transform-origin: top left;
  }
  .links {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
  }
  .links line {
    stroke: var(--accent);
    stroke-width: 2;
    stroke-dasharray: 7 5;
    opacity: 0.75;
  }
  .asset-node,
  .prompt-node,
  .output-node {
    position: absolute;
    width: 205px;
    background: color-mix(in srgb, var(--node-color, #3a3c42) 22%, #2f3033);
    border: 1px solid #4b4d52;
    border-radius: 6px;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }
  .asset-node {
    opacity: 0.72;
  }
  .asset-node.included {
    border-color: color-mix(in srgb, var(--accent) 65%, #4b4d52);
    opacity: 1;
  }
  .prompt-node {
    width: 340px;
  }
  .output-node {
    width: 210px;
  }
  .asset-node.selected,
  .prompt-node.selected,
  .output-node.selected {
    border-color: var(--accent);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--accent) 72%, transparent),
      0 12px 30px rgba(0, 0, 0, 0.28);
  }
  .node-head {
    justify-content: space-between;
    height: 32px;
    padding: 0 8px;
    background: color-mix(in srgb, var(--node-color, #3a3c42) 55%, #383a3e);
    border-bottom: 1px solid #4b4d52;
    font-size: 12px;
    font-weight: 700;
    cursor: grab;
  }
  .node-head:active {
    cursor: grabbing;
  }
  .node-tools {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .node-head button,
  .storyboard-head button {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
  }
  .node-head button.active {
    color: var(--accent);
  }
  .connected-count {
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 500;
  }
  .node-preview,
  .output-preview {
    display: grid;
    place-items: center;
    height: 106px;
    background:
      linear-gradient(45deg, #3c3d40 25%, transparent 25%),
      linear-gradient(-45deg, #3c3d40 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #3c3d40 75%),
      linear-gradient(-45deg, transparent 75%, #3c3d40 75%);
    background-color: #323337;
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  }
  .node-preview img,
  .output-preview img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .asset-node textarea,
  .prompt-node textarea {
    width: 100%;
    min-height: 52px;
    border: none;
    border-top: 1px solid #4b4d52;
    border-radius: 0;
    resize: vertical;
    background: #242528;
  }
  .prompt-node textarea {
    min-height: 96px;
  }
  .storyboard {
    border-bottom: 1px solid #4b4d52;
    background: #242528;
  }
  .storyboard-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 28px;
    padding: 0 8px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .storyboard-head span {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .storyboard canvas {
    display: block;
    width: 100%;
    height: 132px;
    cursor: crosshair;
    background:
      linear-gradient(rgba(255, 255, 255, 0.06) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.06) 1px, transparent 1px);
    background-color: #1d1f22;
    background-size: 24px 24px;
    touch-action: none;
  }
  .composition-text {
    min-height: 86px;
  }
  .prompt-node label {
    display: grid;
    gap: 4px;
    padding: 8px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .output-actions {
    justify-content: flex-end;
    padding: 8px;
    border-top: 1px solid #4b4d52;
  }
  .draw-preview {
    position: absolute;
    border: 1px dashed var(--accent);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    pointer-events: none;
  }
</style>
