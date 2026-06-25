<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { composeCodexWorkflow, isDesktop, type ProjectAsset, type ProjectFile } from '../integrations/desktop';
  import { bytesToBitmap } from '../io';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { workflow, type WorkflowAssetNode } from '../state/workflow.svelte';
  import { Add, ArrowSync, Delete, Document, Image, Open, Sparkle } from '../icons';

  type CodexProgressPayload = { runId: string; message: string };

  const desktop = isDesktop();
  let codexBin = $state('');
  let busy = $state(false);
  let progress = $state('');
  let error = $state('');
  let dragging: { id: string; dx: number; dy: number } | null = null;
  let boardEl = $state<HTMLDivElement>();
  let stopProgress: UnlistenFn | null = null;

  const assets = $derived(project.current?.assets.filter((asset) => asset.exists) ?? []);
  const assetByPath = $derived(new Map(assets.map((asset) => [asset.relativePath, asset])));
  const outputAsset = $derived(
    assets.find((asset) => asset.id === workflow.outputAssetId || asset.relativePath === workflow.outputRelativePath) ?? null,
  );

  onDestroy(() => stopProgress?.());

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

  function nodePointerDown(event: PointerEvent, node: WorkflowAssetNode): void {
    if (!(event.currentTarget instanceof HTMLElement) || !boardEl) return;
    const rect = boardEl.getBoundingClientRect();
    dragging = {
      id: node.id,
      dx: event.clientX - rect.left - node.x,
      dy: event.clientY - rect.top - node.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging || !boardEl) return;
    const rect = boardEl.getBoundingClientRect();
    workflow.moveNode(dragging.id, event.clientX - rect.left - dragging.dx, event.clientY - rect.top - dragging.dy);
  }

  function stopDrag(): void {
    dragging = null;
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
    if (!workflow.nodes.length) {
      error = 'Add at least one asset node.';
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
      for (const node of workflow.nodes) {
        const asset = assetFor(node);
        if (!asset) continue;
        sources.push({
          name: node.note ? `${node.name}: ${node.note}` : node.name,
          bytes: await project.readFile({ ...asset, kind: 'generated', modifiedAt: asset.createdAt, size: 0, exists: true }),
        });
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
  <header class="workflow-top">
    <div class="title">
      <Icon svg={Sparkle} size={16} />
      <input
        aria-label="Workflow name"
        value={workflow.name}
        oninput={(event) => {
          workflow.name = event.currentTarget.value;
          workflow.rev++;
        }}
      />
      {#if workflow.dirty}<span class="dirty">Unsaved</span>{/if}
    </div>
    <div class="actions">
      <button onclick={() => workflow.newBoard()}>New</button>
      <button onclick={() => void save()} disabled={!project.path}>Save</button>
      <button onclick={() => void saveAs()} disabled={!project.path}>Save As</button>
      <button class="primary" onclick={() => void generate()} disabled={busy || !project.path}>
        <Icon svg={Sparkle} size={15} />
        {busy ? 'Generating' : 'Generate'}
      </button>
    </div>
  </header>

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
      role="application"
      aria-label="Workflow composition board"
      bind:this={boardEl}
      onpointermove={onPointerMove}
      onpointerup={stopDrag}
      onpointercancel={stopDrag}
    >
      {#each workflow.nodes as node (node.id)}
        {@const asset = assetFor(node)}
        <article
          class="asset-node"
          style={`transform:translate(${node.x}px, ${node.y}px)`}
          onpointerdown={(event) => nodePointerDown(event, node)}
        >
          <div class="node-head">
            <span>{node.name}</span>
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
          <div class="node-preview">
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

      <article class="prompt-node">
        <div class="node-head"><span>Composition Prompt</span></div>
        <textarea
          placeholder="A girl on the beach standing in front of an ice cream truck, holding an ice cream..."
          value={workflow.prompt}
          oninput={(event) => workflow.setPrompt(event.currentTarget.value)}
        ></textarea>
        <label>
          <span>Codex command</span>
          <input bind:value={codexBin} placeholder="codex or full path" />
        </label>
        {#if busy}<p class="progress">{progress}</p>{/if}
        {#if error}<p class="err">{error}</p>{/if}
      </article>

      <article class="output-node">
        <div class="node-head"><span>Output</span></div>
        <div class="output-preview">
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
  .workflow-top {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: 43px;
    padding: 0 10px;
    background: var(--bg-panel);
    border-bottom: 1px solid var(--border);
  }
  .title,
  .actions,
  .node-head,
  .output-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .title input {
    width: 230px;
    font-weight: 700;
  }
  .dirty {
    color: var(--text-dim);
    font-size: 12px;
  }
  .primary {
    background: var(--accent);
    color: #fff;
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
  }
  .asset-node,
  .prompt-node,
  .output-node {
    position: absolute;
    width: 205px;
    background: #2f3033;
    border: 1px solid #4b4d52;
    border-radius: 6px;
    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }
  .asset-node {
    cursor: grab;
  }
  .asset-node:active {
    cursor: grabbing;
  }
  .prompt-node {
    right: 280px;
    top: 70px;
    width: 310px;
  }
  .output-node {
    right: 34px;
    top: 96px;
    width: 210px;
  }
  .node-head {
    justify-content: space-between;
    height: 32px;
    padding: 0 8px;
    background: #383a3e;
    border-bottom: 1px solid #4b4d52;
    font-size: 12px;
    font-weight: 700;
  }
  .node-head button {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    padding: 0;
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
    min-height: 132px;
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
</style>
