<script lang="ts">
  import { onDestroy } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getSmoothStepPath, Position } from '@xyflow/system';
  import Icon from './Icon.svelte';
  import { tooltip } from '../actions/tooltip';
  import { composeCodexWorkflow, isDesktop, type ProjectAsset } from '../integrations/desktop';
  import { bytesToBitmap, canvasToPngBytes } from '../io';
  import { wheelZoomFactor } from '../engine/zoomGesture';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { workflow, type WorkflowAssetNode, type WorkflowConnection } from '../state/workflow.svelte';
  import { Add, ArrowSync, Delete, Dismiss, Image, Link, Open, PaintBrush } from '../icons';

  type CodexProgressPayload = { runId: string; message: string };
  type WorkflowMapKind = 'asset' | 'composition' | 'output' | 'viewport';
  type WorkflowNodeId = string;
  type WorkflowMapRect = {
    id: string;
    kind: WorkflowMapKind;
    x: number;
    y: number;
    width: number;
    height: number;
    color: string;
    included?: boolean;
  };
  type WorkflowMapBounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
  type WorkflowMapModel = {
    items: WorkflowMapRect[];
    viewport: WorkflowMapRect;
    bounds: WorkflowMapBounds;
  };

  const desktop = isDesktop();
  let codexBin = $state('');
  let busy = $state(false);
  let progress = $state('');
  let error = $state('');
  let dragging: { type: 'asset' | 'prompt' | 'output'; id?: string; dx: number; dy: number } | null = null;
  let panning: { x: number; y: number } | null = null;
  let mapDragging = $state<{ offsetX: number; offsetY: number } | null>(null);
  let connecting = $state<{ from: WorkflowNodeId; x: number; y: number } | null>(null);
  let overscrollX = $state(0);
  let overscrollY = $state(0);
  let overscrollReturning = $state(false);
  let drawing = $state<{ type: 'asset' | 'composition' | 'output'; x: number; y: number; width: number; height: number } | null>(null);
  let sketching = false;
  let altDown = $state(false);
  let boardEl = $state<HTMLDivElement>();
  let boardWidth = $state(1);
  let boardHeight = $state(1);
  let storyboardCanvas = $state<HTMLCanvasElement>();
  let stopProgress: UnlistenFn | null = null;
  let overscrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let overscrollEndTimer: ReturnType<typeof setTimeout> | null = null;

  const ASSET_NODE_W = 205;
  const STORYBOARD_W = 312;
  const STORYBOARD_H = 132;
  const MAP_EDGE_PADDING = 260;
  const MAX_OVERSCROLL = 32;
  const OVERSCROLL_DAMPING = 0.14;

  const assets = $derived(project.current?.assets.filter((asset) => asset.exists) ?? []);
  const assetByPath = $derived(new Map(assets.map((asset) => [asset.relativePath, asset])));
  const outputAsset = $derived(
    assets.find((asset) => asset.id === workflow.outputAssetId || asset.relativePath === workflow.outputRelativePath) ?? null,
  );
  const effectiveZoomMode = $derived(
    altDown
      ? workflow.zoomMode === 'in' ? 'out' : 'in'
      : workflow.zoomMode,
  );
  const workflowMapModel = $derived(workflowMap());
  const graphConnections = $derived(workflow.connections);

  onDestroy(() => {
    stopProgress?.();
    if (overscrollIdleTimer) clearTimeout(overscrollIdleTimer);
    if (overscrollEndTimer) clearTimeout(overscrollEndTimer);
  });

  $effect(() => {
    if (storyboardCanvas) {
      void restoreStoryboard(workflow.storyboardDataUrl);
    }
  });

  $effect(() => {
    const board = boardEl;
    if (!board) return;
    let resizeFrame: number | null = null;
    const resize = () => {
      resizeFrame = null;
      boardWidth = Math.max(1, board.clientWidth);
      boardHeight = Math.max(1, board.clientHeight);
      clampWorkflowPan();
    };
    const scheduleResize = () => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    };
    resize();
    const observer = new ResizeObserver(scheduleResize);
    observer.observe(board);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const rect = board.getBoundingClientRect();
        workflow.zoomBy(wheelZoomFactor(event.deltaY, event.deltaMode), event.clientX - rect.left, event.clientY - rect.top);
        clampWorkflowPan();
      } else {
        panBoardBy(-event.deltaX, -event.deltaY, true, 'idle');
      }
    };
    board.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      observer.disconnect();
      board.removeEventListener('wheel', onWheel);
    };
  });

  function assetFor(node: WorkflowAssetNode): ProjectAsset | null {
    return assets.find((asset) => asset.id === node.assetId || asset.relativePath === node.relativePath) ?? null;
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
    if (connecting) {
      const point = boardPoint(event);
      connecting = { ...connecting, x: point.x, y: point.y };
      return;
    }
    if (panning) {
      panBoardBy(event.clientX - panning.x, event.clientY - panning.y, true, 'manual');
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
    releaseOverscroll();
    connecting = null;
    dragging = null;
    panning = null;
  }

  function onPointerLeave(): void {
    stopDrag();
  }

  function boardPoint(event: PointerEvent): { x: number; y: number } {
    if (!boardEl) return { x: 0, y: 0 };
    const rect = boardEl.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - workflow.panX) / workflow.zoom,
      y: (event.clientY - rect.top - workflow.panY) / workflow.zoom,
    };
  }

  function workflowMapItems(): WorkflowMapRect[] {
    return [
      ...workflow.nodes.map((node) => ({
        id: node.id,
        kind: 'asset' as const,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        color: node.color,
        included: node.included,
      })),
      {
        id: 'composition',
        kind: 'composition',
        x: workflow.promptX,
        y: workflow.promptY,
        width: workflow.compositionWidth,
        height: workflow.compositionHeight,
        color: workflow.compositionColor,
      },
      {
        id: 'output',
        kind: 'output',
        x: workflow.outputX,
        y: workflow.outputY,
        width: workflow.outputWidth,
        height: workflow.outputHeight,
        color: workflow.outputColor,
      },
    ];
  }

  function mapBoundsFor(items: WorkflowMapRect[], padding: number): WorkflowMapBounds {
    const minX = Math.min(...items.map((rect) => rect.x)) - padding;
    const minY = Math.min(...items.map((rect) => rect.y)) - padding;
    const maxX = Math.max(...items.map((rect) => rect.x + rect.width)) + padding;
    const maxY = Math.max(...items.map((rect) => rect.y + rect.height)) + padding;
    return {
      minX,
      minY,
      maxX,
      maxY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }

  function workflowViewportRect(): WorkflowMapRect {
    const zoom = Math.max(0.001, workflow.zoom);
    return {
      id: 'viewport',
      kind: 'viewport',
      x: -workflow.panX / zoom,
      y: -workflow.panY / zoom,
      width: boardWidth / zoom,
      height: boardHeight / zoom,
      color: 'var(--accent)',
    };
  }

  function workflowMap(): WorkflowMapModel {
    const items = workflowMapItems();
    const viewport = workflowViewportRect();
    return {
      items,
      viewport,
      bounds: mapBoundsFor(items, MAP_EDGE_PADDING),
    };
  }

  function mapX(x: number, map: WorkflowMapModel): number {
    return ((x - map.bounds.minX) / map.bounds.width) * 100;
  }

  function mapY(y: number, map: WorkflowMapModel): number {
    return ((y - map.bounds.minY) / map.bounds.height) * 100;
  }

  function mapRectStyle(rect: WorkflowMapRect, map: WorkflowMapModel): string {
    const minSize = rect.kind === 'viewport' ? 8 : 5;
    return [
      `left:${mapX(rect.x, map)}%`,
      `top:${mapY(rect.y, map)}%`,
      `width:max(${minSize}px, ${(rect.width / map.bounds.width) * 100}%)`,
      `height:max(${minSize}px, ${(rect.height / map.bounds.height) * 100}%)`,
      `--mini-color:${rect.color}`,
    ].join(';');
  }

  function clampWorkflowPan(): { rejectedX: number; rejectedY: number } {
    const bounds = workflowMapModel.bounds;
    const zoom = Math.max(0.001, workflow.zoom);
    const viewportW = boardWidth / zoom;
    const viewportH = boardHeight / zoom;
    const attemptedPanX = workflow.panX;
    const attemptedPanY = workflow.panY;
    const worldLeft = -workflow.panX / zoom;
    const worldTop = -workflow.panY / zoom;
    const nextLeft = clampViewportOrigin(worldLeft, viewportW, bounds.minX, bounds.maxX);
    const nextTop = clampViewportOrigin(worldTop, viewportH, bounds.minY, bounds.maxY);
    const nextPanX = -nextLeft * zoom;
    const nextPanY = -nextTop * zoom;
    const dx = nextPanX - workflow.panX;
    const dy = nextPanY - workflow.panY;
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) workflow.panBy(dx, dy);
    return {
      rejectedX: attemptedPanX - workflow.panX,
      rejectedY: attemptedPanY - workflow.panY,
    };
  }

  function clampViewportOrigin(origin: number, viewportSize: number, min: number, max: number): number {
    const size = Math.max(1, max - min);
    if (viewportSize >= size) return min + (size - viewportSize) / 2;
    return Math.min(Math.max(origin, min), max - viewportSize);
  }

  function panBoardBy(dx: number, dy: number, bounce = true, releaseMode: 'idle' | 'manual' = 'idle'): void {
    workflow.panBy(dx, dy);
    const rejected = clampWorkflowPan();
    if (bounce) {
      if (Math.abs(rejected.rejectedX) >= 0.5 || Math.abs(rejected.rejectedY) >= 0.5) {
        applyOverscroll(rejected.rejectedX, rejected.rejectedY, releaseMode);
      } else if (overscrollX !== 0 || overscrollY !== 0 || overscrollReturning) {
        clearOverscroll();
      }
    }
  }

  function applyOverscroll(rejectedX: number, rejectedY: number, releaseMode: 'idle' | 'manual'): void {
    const nextX = dampOverscroll(rejectedX);
    const nextY = dampOverscroll(rejectedY);
    if (nextX === 0 && nextY === 0) return;
    if (overscrollIdleTimer) clearTimeout(overscrollIdleTimer);
    if (overscrollEndTimer) clearTimeout(overscrollEndTimer);
    overscrollReturning = false;
    overscrollX = nextX;
    overscrollY = nextY;
    overscrollEndTimer = null;
    if (releaseMode === 'idle') {
      overscrollIdleTimer = setTimeout(() => {
        overscrollIdleTimer = null;
        releaseOverscroll();
      }, 110);
    } else {
      overscrollIdleTimer = null;
    }
  }

  function dampOverscroll(value: number): number {
    if (Math.abs(value) < 0.5) return 0;
    const magnitude = Math.min(MAX_OVERSCROLL, Math.abs(value) * OVERSCROLL_DAMPING);
    return Math.sign(value) * magnitude;
  }

  function setViewportOrigin(left: number, top: number): void {
    const zoom = Math.max(0.001, workflow.zoom);
    const nextPanX = -left * zoom;
    const nextPanY = -top * zoom;
    workflow.panBy(nextPanX - workflow.panX, nextPanY - workflow.panY);
    clampWorkflowPan();
    clearOverscroll();
  }

  function centerBoardAt(worldX: number, worldY: number): void {
    const nextPanX = boardWidth / 2 - worldX * workflow.zoom;
    const nextPanY = boardHeight / 2 - worldY * workflow.zoom;
    workflow.panBy(nextPanX - workflow.panX, nextPanY - workflow.panY);
    clampWorkflowPan();
    clearOverscroll();
  }

  function clearOverscroll(): void {
    if (overscrollIdleTimer) {
      clearTimeout(overscrollIdleTimer);
      overscrollIdleTimer = null;
    }
    if (overscrollEndTimer) {
      clearTimeout(overscrollEndTimer);
      overscrollEndTimer = null;
    }
    overscrollX = 0;
    overscrollY = 0;
    overscrollReturning = false;
  }

  function releaseOverscroll(): void {
    if (overscrollIdleTimer) {
      clearTimeout(overscrollIdleTimer);
      overscrollIdleTimer = null;
    }
    if (overscrollX === 0 && overscrollY === 0) {
      overscrollReturning = false;
      return;
    }
    if (overscrollEndTimer) clearTimeout(overscrollEndTimer);
    overscrollReturning = true;
    overscrollX = 0;
    overscrollY = 0;
    overscrollEndTimer = setTimeout(() => {
      overscrollReturning = false;
      overscrollEndTimer = null;
    }, 210);
  }

  function mapLinkStyle(connection: WorkflowConnection, map: WorkflowMapModel): string {
    const source = outputPortPoint(connection.from);
    const target = inputPortPoint(connection.to);
    if (!source || !target) return 'display:none';
    const x1 = mapX(source.x, map);
    const y1 = mapY(source.y, map);
    const x2 = mapX(target.x, map);
    const y2 = mapY(target.y, map);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);
    return `left:${x1}%; top:${y1}%; width:${length}%; transform:rotate(${angle}deg)`;
  }

  function centerBoardFromMap(event: PointerEvent, map: WorkflowMapModel): void {
    const point = mapPoint(event, map);
    if (!point) return;
    centerBoardAt(point.x, point.y);
  }

  function mapPoint(event: PointerEvent, map: WorkflowMapModel): { x: number; y: number } | null {
    if (!(event.currentTarget instanceof HTMLElement)) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: map.bounds.minX + ((event.clientX - rect.left) / rect.width) * map.bounds.width,
      y: map.bounds.minY + ((event.clientY - rect.top) / rect.height) * map.bounds.height,
    };
  }

  function rectContainsPoint(rect: WorkflowMapRect, point: { x: number; y: number }): boolean {
    return point.x >= rect.x
      && point.x <= rect.x + rect.width
      && point.y >= rect.y
      && point.y <= rect.y + rect.height;
  }

  function startMapDrag(event: PointerEvent, map: WorkflowMapModel): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const point = mapPoint(event, map);
    if (!point) return;
    event.preventDefault();
    if (rectContainsPoint(map.viewport, point)) {
      mapDragging = {
        offsetX: point.x - map.viewport.x,
        offsetY: point.y - map.viewport.y,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    centerBoardFromMap(event, map);
  }

  function moveMapDrag(event: PointerEvent, map: WorkflowMapModel): void {
    if (!mapDragging) return;
    const point = mapPoint(event, map);
    if (!point) return;
    clearOverscroll();
    setViewportOrigin(point.x - mapDragging.offsetX, point.y - mapDragging.offsetY);
  }

  function stopMapDrag(): void {
    mapDragging = null;
  }

  function workflowNodeRect(nodeId: WorkflowNodeId): { x: number; y: number; width: number; height: number } | null {
    if (nodeId === 'composition') {
      return { x: workflow.promptX, y: workflow.promptY, width: workflow.compositionWidth, height: workflow.compositionHeight };
    }
    if (nodeId === 'output') {
      return { x: workflow.outputX, y: workflow.outputY, width: workflow.outputWidth, height: workflow.outputHeight };
    }
    const node = workflow.nodes.find((item) => item.id === nodeId);
    return node ? { x: node.x, y: node.y, width: node.width, height: node.height } : null;
  }

  function inputPortPoint(nodeId: WorkflowNodeId): { x: number; y: number } | null {
    const rect = workflowNodeRect(nodeId);
    if (!rect) return null;
    return { x: rect.x, y: rect.y + rect.height / 2 };
  }

  function outputPortPoint(nodeId: WorkflowNodeId): { x: number; y: number } | null {
    const rect = workflowNodeRect(nodeId);
    if (!rect) return null;
    return { x: rect.x + rect.width, y: rect.y + rect.height / 2 };
  }

  function connectionPath(connection: WorkflowConnection): string {
    const source = outputPortPoint(connection.from);
    const target = inputPortPoint(connection.to);
    if (!source || !target) return '';
    return routedPath(source, target);
  }

  function pendingConnectionPath(): string {
    if (!connecting) return '';
    const source = outputPortPoint(connecting.from);
    if (!source) return '';
    return routedPath(source, { x: connecting.x, y: connecting.y });
  }

  function routedPath(source: { x: number; y: number }, target: { x: number; y: number }): string {
    return getSmoothStepPath({
      sourceX: source.x,
      sourceY: source.y,
      sourcePosition: Position.Right,
      targetX: target.x,
      targetY: target.y,
      targetPosition: Position.Left,
      borderRadius: 18,
      offset: 28,
    })[0];
  }

  function startConnection(event: PointerEvent, from: WorkflowNodeId): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const point = boardPoint(event);
    connecting = { from, x: point.x, y: point.y };
    event.stopPropagation();
  }

  function finishConnection(event: PointerEvent, to: WorkflowNodeId): void {
    if (!connecting) return;
    workflow.connect(connecting.from, to);
    connecting = null;
    event.stopPropagation();
  }

  function portTitle(kind: 'input' | 'output', nodeName: string): string {
    return kind === 'input' ? `Input for ${nodeName}` : `Output from ${nodeName}`;
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
      clampWorkflowPan();
      return;
    }
    if (workflow.tool === 'hand') {
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
      workflow.setTool('hand');
    } else {
      workflow.moveOutput(rect.x, rect.y);
      workflow.resizeOutput(width, height);
      workflow.select({ kind: 'output' });
      workflow.setTool('hand');
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
    const sourceNodes = workflow.connectedAssetNodesTo('composition');
    if (!sourceNodes.length) {
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
      for (const node of sourceNodes) {
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

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Alt') altDown = true;
  }}
  onkeyup={(event) => {
    if (event.key === 'Alt') altDown = false;
  }}
  onblur={() => (altDown = false)}
/>

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
        <span>Map</span>
      </div>
      <div class="workflow-map">
        <button
          class="workflow-map-canvas"
          class:dragging={mapDragging}
          aria-label="Workflow map. Drag the viewport frame or click to center the workflow canvas."
          onpointerdown={(event) => startMapDrag(event, workflowMapModel)}
          onpointermove={(event) => moveMapDrag(event, workflowMapModel)}
          onpointerup={stopMapDrag}
          onpointercancel={stopMapDrag}
        >
          {#each graphConnections as connection (connection.id)}
            <span class="map-link" style={mapLinkStyle(connection, workflowMapModel)}></span>
          {/each}
          {#each workflowMapModel.items as item (item.id)}
            <span
              class="map-node"
              class:asset={item.kind === 'asset'}
              class:composition={item.kind === 'composition'}
              class:output={item.kind === 'output'}
              class:included={item.included}
              style={mapRectStyle(item, workflowMapModel)}
            ></span>
          {/each}
          <span class="map-viewport" style={mapRectStyle(workflowMapModel.viewport, workflowMapModel)}></span>
        </button>
        <div class="map-meta">
          <span>{workflow.nodes.length + 2} nodes</span>
          <span>{Math.round(workflow.zoom * 100)}%</span>
        </div>
      </div>
    </aside>

    <div
      class="board"
      class:adding={workflow.tool !== 'hand' && workflow.tool !== 'zoom'}
      class:panning={workflow.tool === 'hand'}
      class:zooming={workflow.tool === 'zoom'}
      class:zoom-in={workflow.tool === 'zoom' && effectiveZoomMode === 'in'}
      class:zoom-out={workflow.tool === 'zoom' && effectiveZoomMode === 'out'}
      class:overscrolling={overscrollReturning}
      role="application"
      aria-label="Workflow composition board"
      bind:this={boardEl}
      style={`background-position:${workflow.panX + overscrollX}px ${workflow.panY + overscrollY}px; background-size:${24 * workflow.zoom}px ${24 * workflow.zoom}px`}
      onpointerdown={onBoardPointerDown}
      onpointerleave={onPointerLeave}
      onpointermove={onPointerMove}
      onpointerup={stopDrag}
      onpointercancel={stopDrag}
    >
      <div class="board-world" style={`transform:translate(${workflow.panX + overscrollX}px, ${workflow.panY + overscrollY}px) scale(${workflow.zoom})`}>
        <svg class="links" aria-label="Workflow connections">
          {#each graphConnections as connection (connection.id)}
            {@const path = connectionPath(connection)}
            {#if path}
              <path
                d={path}
                role="button"
                tabindex="0"
                aria-label="Disconnect workflow connection"
                onpointerdown={(event) => {
                  workflow.disconnectConnection(connection.id);
                  event.stopPropagation();
                }}
                onkeydown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  workflow.disconnectConnection(connection.id);
                }}
              />
            {/if}
          {/each}
          {#if connecting}
            {@const path = pendingConnectionPath()}
            {#if path}<path class="pending" d={path} />{/if}
          {/if}
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
            style={`transform:translate(${node.x}px, ${node.y}px); width:${node.width}px; --node-color:${node.color}; --port-y:${node.height / 2}px`}
            onpointerdown={(event) => {
              workflow.select({ kind: 'asset', id: node.id });
              event.stopPropagation();
            }}
          >
            <button
              class="node-port input"
              aria-label={portTitle('input', node.name)}
              use:tooltip={{ text: 'Input', placement: 'left' }}
              onpointerdown={(event) => event.stopPropagation()}
              onpointerup={(event) => finishConnection(event, node.id)}
            ></button>
            <button
              class="node-port output"
              aria-label={portTitle('output', node.name)}
              use:tooltip={{ text: 'Output', placement: 'right' }}
              onpointerdown={(event) => startConnection(event, node.id)}
            ></button>
            <div class="node-head">
              <span class="node-drag-region" use:dragHandle={{ type: 'asset', node }}>{assetTitle(node)}</span>
              <div class="node-tools">
                <button
                  type="button"
                  class:active={workflow.isConnected(node.id, 'composition')}
                  aria-label={`${workflow.isConnected(node.id, 'composition') ? 'Disconnect' : 'Connect'} ${node.name} to composition`}
                  use:tooltip={{ text: workflow.isConnected(node.id, 'composition') ? 'Connected to composition' : 'Connect to composition', placement: 'top' }}
                  onpointerdown={(event) => event.stopPropagation()}
                  onclick={(event) => {
                    event.stopPropagation();
                    workflow.setNodeIncluded(node.id, !workflow.isConnected(node.id, 'composition'));
                  }}
                >
                  <Icon svg={Link} size={13} />
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${node.name}`}
                  use:tooltip={{ text: 'Remove node', placement: 'top' }}
                  onpointerdown={(event) => event.stopPropagation()}
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
              {#if asset?.previewDataUrl}<img class="preview-image" src={asset.previewDataUrl} alt="" />{:else}<Icon svg={Image} size={28} />{/if}
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
          style={`transform:translate(${workflow.promptX}px, ${workflow.promptY}px); width:${workflow.compositionWidth}px; --node-color:${workflow.compositionColor}; --port-y:${workflow.compositionHeight / 2}px`}
          onpointerdown={(event) => {
            workflow.select({ kind: 'composition' });
            event.stopPropagation();
          }}
        >
          <button
            class="node-port input"
            aria-label={portTitle('input', compositionTitle())}
            use:tooltip={{ text: 'Input', placement: 'left' }}
            onpointerdown={(event) => event.stopPropagation()}
            onpointerup={(event) => finishConnection(event, 'composition')}
          ></button>
          <button
            class="node-port output"
            aria-label={portTitle('output', compositionTitle())}
            use:tooltip={{ text: 'Output', placement: 'right' }}
            onpointerdown={(event) => startConnection(event, 'composition')}
          ></button>
          <div class="node-head">
            <span class="node-drag-region" use:dragHandle={{ type: 'prompt' }}>{compositionTitle()}</span>
            <div class="node-tools">
              <span class="connected-count">{workflow.incoming('composition').length} in / {workflow.outgoing('composition').length} out</span>
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
          style={`transform:translate(${workflow.outputX}px, ${workflow.outputY}px); width:${workflow.outputWidth}px; --node-color:${workflow.outputColor}; --port-y:${workflow.outputHeight / 2}px`}
          onpointerdown={(event) => {
            workflow.select({ kind: 'output' });
            event.stopPropagation();
          }}
        >
          <button
            class="node-port input"
            aria-label={portTitle('input', outputTitle())}
            use:tooltip={{ text: 'Input', placement: 'left' }}
            onpointerdown={(event) => event.stopPropagation()}
            onpointerup={(event) => finishConnection(event, 'output')}
          ></button>
          <button
            class="node-port output"
            aria-label={portTitle('output', outputTitle())}
            use:tooltip={{ text: 'Output', placement: 'right' }}
            onpointerdown={(event) => startConnection(event, 'output')}
          ></button>
          <div class="node-head">
            <span class="node-drag-region" use:dragHandle={{ type: 'output' }}>{outputTitle()}</span>
          </div>
          <div class="output-preview" style={`height:${Math.max(76, workflow.outputHeight - 74)}px`}>
            {#if outputAsset?.previewDataUrl}<img class="preview-image" src={outputAsset.previewDataUrl} alt="" />{:else}<Icon svg={Image} size={32} />{/if}
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
    flex: none;
    padding: 8px;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .workflows {
    border-top: 1px solid var(--border);
  }
  .asset-list {
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: auto;
    padding: 0 8px 8px;
  }
  .asset-item {
    display: grid;
    grid-template-columns: 34px minmax(0, 1fr) 16px;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 5px;
    text-align: left;
  }
  .asset-item img {
    width: 34px;
    height: 34px;
    object-fit: cover;
    background: var(--bg-input);
  }
  .asset-item span,
  .node-head span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .workflow-map {
    flex: none;
    display: grid;
    gap: 6px;
    padding: 0 8px 10px;
  }
  .workflow-map-canvas {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 1;
    min-height: 148px;
    padding: 0;
    overflow: hidden;
    border: 1px solid #3b3d41;
    border-radius: 6px;
    background:
      linear-gradient(rgba(255, 255, 255, 0.045) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.045) 1px, transparent 1px);
    background-color: #202225;
    background-size: 18px 18px;
    cursor: grab;
    touch-action: none;
  }
  .workflow-map-canvas:hover {
    border-color: color-mix(in srgb, var(--accent) 50%, #3b3d41);
  }
  .workflow-map-canvas.dragging {
    cursor: grabbing;
  }
  .map-node,
  .map-viewport,
  .map-link {
    position: absolute;
    display: block;
    pointer-events: none;
  }
  .map-node {
    border: 1px solid color-mix(in srgb, var(--mini-color) 58%, #65686f);
    border-radius: 3px;
    background: color-mix(in srgb, var(--mini-color) 40%, #4b4d52);
    opacity: 0.78;
  }
  .map-node.asset:not(.included) {
    opacity: 0.38;
  }
  .map-node.composition {
    background: color-mix(in srgb, var(--accent) 28%, #4b4d52);
    border-color: color-mix(in srgb, var(--accent) 65%, #65686f);
  }
  .map-node.output {
    background: color-mix(in srgb, #6b7cff 28%, #4b4d52);
  }
  .map-viewport {
    border: 2px solid var(--accent);
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent) 9%, transparent);
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.35),
      0 0 10px color-mix(in srgb, var(--accent) 32%, transparent);
  }
  .map-link {
    height: 1px;
    transform-origin: 0 50%;
    border-top: 1px solid color-mix(in srgb, var(--accent) 72%, transparent);
    opacity: 0.66;
  }
  .map-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--text-dim);
    font-size: 11px;
  }
  .empty,
  .err,
  .progress {
    margin: 8px;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.4;
  }
  .asset-tray > .empty {
    flex: 1 1 auto;
    min-height: 0;
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
    will-change: background-position;
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
  .board.zooming.zoom-in {
    cursor: zoom-in;
  }
  .board.zooming.zoom-out {
    cursor: zoom-out;
  }
  .board.overscrolling {
    transition: background-position 210ms cubic-bezier(0.2, 0.9, 0.28, 1);
  }
  .board-world {
    position: absolute;
    inset: 0;
    transform-origin: top left;
    will-change: transform;
  }
  .board.overscrolling .board-world {
    transition: transform 210ms cubic-bezier(0.2, 0.9, 0.28, 1);
  }
  .links {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;
    overflow: visible;
  }
  .links path {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2.25;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.88;
    pointer-events: stroke;
  }
  .links path.pending {
    opacity: 0.58;
  }
  .links path:focus-visible {
    outline: none;
    stroke-width: 4;
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
    overflow: visible;
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
  }
  .node-drag-region {
    display: flex;
    align-items: center;
    align-self: stretch;
    min-width: 0;
    flex: 1 1 auto;
    cursor: grab;
  }
  .node-drag-region:active {
    cursor: grabbing;
  }
  .node-port {
    position: absolute;
    top: var(--port-y, 50%);
    z-index: 8;
    display: grid;
    place-items: center;
    width: 13px;
    height: 13px;
    padding: 0;
    border: 2px solid #a6aab2;
    border-radius: 50%;
    background: #202123;
    box-shadow:
      0 0 0 2px rgba(0, 0, 0, 0.36),
      0 2px 8px rgba(0, 0, 0, 0.36);
    transform: translateY(-50%);
  }
  .node-port.input {
    left: -7px;
    cursor: default;
  }
  .node-port.output {
    right: -7px;
    cursor: crosshair;
  }
  .node-port:hover,
  .node-port:focus-visible {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 22%, #202123);
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
    position: relative;
    display: grid;
    place-items: center;
    height: 106px;
    overflow: hidden;
    background:
      linear-gradient(45deg, #3c3d40 25%, transparent 25%),
      linear-gradient(-45deg, #3c3d40 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, #3c3d40 75%),
      linear-gradient(-45deg, transparent 75%, #3c3d40 75%);
    background-color: #323337;
    background-size: 16px 16px;
    background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  }
  .node-preview .preview-image,
  .output-preview .preview-image {
    display: block;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    object-fit: contain;
    object-position: center;
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
