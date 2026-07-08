<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getSmoothStepPath, Position } from '@xyflow/system';
  import Icon from './Icon.svelte';
  import AiRunOptionsControl from './AiRunOptionsControl.svelte';
  import { tooltip } from '../actions/tooltip';
  import {
    codexConfigFromRunOptions,
    composeCodexWorkflow,
    composeAntigravityWorkflow,
    antigravityConfigFromRunOptions,
    isDesktop,
    type ProjectAsset,
  } from '../integrations/desktop';
  import { ratioLabel } from '../ai/imageModelCapabilities';
  import { bytesToBitmap, canvasToPngBytes } from '../io';
  import { PaintDocument } from '../engine/Document.svelte';
  import { Layer } from '../engine/Layer.svelte';
  import { modelToPlainText } from '../engine/text/model';
  import { storyboardPlacementSummary } from '../engine/storyboard/analyze';
  import { Viewport } from '../engine/Viewport';
  import type { PointerInfo } from '../engine/tools/Tool';
  import { wheelZoomFactor } from '../engine/zoomGesture';
  import { compositeToCanvas } from '../engine/compositor';
  import { saveOra } from '../ora/save';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { settings } from '../state/settings.svelte';
  import { aiRunOptionsFromSettings } from '../state/settings';
  import { ui } from '../state/ui.svelte';
  import { workflow, type WorkflowAssetNode, type WorkflowConnection, type WorkflowOutputNode } from '../state/workflow.svelte';
  import { Add, ArrowSync, CommentNote, Delete, Dismiss, DocumentSave, Edit, Image, Link, Open, PaintBrush, SlideSize } from '../icons';
  import TextEditorOverlay from './TextEditorOverlay.svelte';
  import AnnotationOverlay from './AnnotationOverlay.svelte';
  import { annotationFromDrag, type AnnotationItem } from '../engine/annotations';

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
  let runOptions = $state(aiRunOptionsFromSettings(settings.value));
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
  let storyboardViewport: Viewport | null = null;

  $effect(() => {
    settings.value.workspace.showTransparencyChecker;
    storyboardViewport?.invalidate();
  });
  let storyboardDoc: PaintDocument | null = null;
  let storyboardResizeObserver: ResizeObserver | null = null;
  let storyboardInteracting = false;
  let storyboardPanning = false;
  let storyboardPointerInViewport = $state(false);
  let storyboardPointerClientX = $state(0);
  let storyboardPointerClientY = $state(0);
  let storyboardViewTick = $state(0);
  let storyboardLast = { x: 0, y: 0 };
  let storyboardAnnotationDraft = $state<AnnotationItem | null>(null);
  let storyboardAnnotationDragStart: { x: number; y: number } | null = null;
  let stopProgress: UnlistenFn | null = null;
  let overscrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let overscrollEndTimer: ReturnType<typeof setTimeout> | null = null;

  const ASSET_NODE_W = 205;
  const MAP_EDGE_PADDING = 260;
  const MAX_OVERSCROLL = 32;
  const OVERSCROLL_DAMPING = 0.14;

  const assets = $derived(project.current?.assets.filter((asset) => asset.exists) ?? []);
  const assetByPath = $derived(new Map(assets.map((asset) => [asset.relativePath, asset])));
  const effectiveZoomMode = $derived(
    altDown
      ? workflow.zoomMode === 'in' ? 'out' : 'in'
      : workflow.zoomMode,
  );
  const workflowMapModel = $derived(workflowMap());
  const graphConnections = $derived(workflow.connections);
  const storyboardOverlayBox = $derived.by(() => {
    storyboardViewTick;
    const session = editor.textEdit;
    const viewport = storyboardViewport;
    const canvas = storyboardCanvas;
    if (!workflow.storyboardEditing || !session || !viewport || !canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const point = viewport.docToScreen(session.model.x, session.model.y);
    return { left: rect.left + point.x, top: rect.top + point.y, scale: viewport.scale };
  });

  onDestroy(() => {
    endStoryboardEditSession();
    stopProgress?.();
    if (overscrollIdleTimer) clearTimeout(overscrollIdleTimer);
    if (overscrollEndTimer) clearTimeout(overscrollEndTimer);
  });

  onMount(() => {
    const flushBeforeSave = () => {
      if (editor.textEdit) editor.commitActiveText();
      if (workflow.storyboardEditing && storyboardDoc) persistStoryboardFromDoc();
      else persistStoryboard();
    };
    const recordAnnotation = (event: Event) => {
      if (!workflow.storyboardEditing || !storyboardDoc) return;
      const detail = (event as CustomEvent<{ type?: string; text?: string; xPercent?: number; yPercent?: number }>).detail;
      const text = detail?.text?.trim();
      if (!text) return;
      const type = detail.type?.trim() || 'annotation';
      const x = Number.isFinite(detail.xPercent) ? Math.round(detail.xPercent!) : 50;
      const y = Number.isFinite(detail.yPercent) ? Math.round(detail.yPercent!) : 50;
      const next = [
        ...workflow.storyboardAnnotations,
        `at ${x}% x, ${y}% y (${type}): ${text}`,
      ].slice(-24);
      workflow.setStoryboardAnnotations(next);
    };
    window.addEventListener('paintnode:workflow-before-save', flushBeforeSave);
    window.addEventListener('paintnode:annotation-created', recordAnnotation);
    return () => {
      window.removeEventListener('paintnode:workflow-before-save', flushBeforeSave);
      window.removeEventListener('paintnode:annotation-created', recordAnnotation);
    };
  });

  $effect(() => {
    workflow.storyboardWidth;
    workflow.storyboardHeight;
    if (storyboardCanvas && !workflow.storyboardEditing) {
      void restoreStoryboard(workflow.storyboardDataUrl);
    }
  });

  $effect(() => {
    if (workflow.storyboardEditing && storyboardCanvas && !storyboardViewport) {
      void beginStoryboardEditSession();
    } else if (!workflow.storyboardEditing && storyboardViewport) {
      endStoryboardEditSession();
    }
  });

  $effect(() => {
    const doc = storyboardDoc;
    if (!workflow.storyboardEditing || !doc) return;
    const width = workflow.storyboardWidth;
    const height = workflow.storyboardHeight;
    if (doc.width !== width || doc.height !== height) {
      editor.resizeImage(width, height);
      requestAnimationFrame(() => storyboardViewport?.fitToView(12));
      persistStoryboardFromDoc();
    }
  });

  $effect(() => {
    if (!workflow.storyboardEditing || !storyboardViewport) return;
    const doc = editor.doc;
    editor.rev;
    if (doc) {
      doc.layers;
      doc.activeLayerId;
      for (const layer of doc.layers) {
        layer.visible;
        layer.opacity;
        layer.blendMode;
        layer.pixelRev;
      }
    }
    storyboardViewport.invalidateComposite();
  });

  $effect(() => {
    const viewport = storyboardViewport;
    const doc = editor.doc;
    const tool = editor.activeTool;
    const size = editor.brushSize;
    if (!workflow.storyboardEditing || !viewport) return;
    viewport.brushRadius = doc && tool.usesBrushCursor ? size / 2 : 0;
    viewport.invalidate();
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

  function outputAssetFor(node: WorkflowOutputNode): ProjectAsset | null {
    return assets.find((asset) => asset.id === node.outputAssetId || asset.relativePath === node.outputRelativePath) ?? null;
  }

  async function placeOutput(node: WorkflowOutputNode): Promise<void> {
    const outputAsset = outputAssetFor(node);
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
    node: WorkflowAssetNode | WorkflowOutputNode | undefined = undefined,
  ): void {
    if (!(event.currentTarget instanceof HTMLElement) || !boardEl) return;
    const output = type === 'output' && node ? workflow.outputNode(node.id) : null;
    const x = type === 'asset' ? (node?.x ?? 0) : type === 'prompt' ? workflow.promptX : (output?.x ?? workflow.outputX);
    const y = type === 'asset' ? (node?.y ?? 0) : type === 'prompt' ? workflow.promptY : (output?.y ?? workflow.outputY);
    if (type === 'asset' && node) workflow.select({ kind: 'asset', id: node.id });
    else workflow.select(type === 'prompt' ? { kind: 'composition' } : { kind: 'output', id: output?.id ?? 'output' });
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
    params: { type: 'asset' | 'prompt' | 'output'; node?: WorkflowAssetNode | WorkflowOutputNode },
  ): { update: (next: { type: 'asset' | 'prompt' | 'output'; node?: WorkflowAssetNode | WorkflowOutputNode }) => void; destroy: () => void } {
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
      else if (dragging.id) workflow.moveOutputNode(dragging.id, x, y);
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
      ...workflow.outputNodes.filter((node) => node.id !== 'output').map((node) => ({
        id: node.id,
        kind: 'output' as const,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        color: node.color,
      })),
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
      const node = workflow.outputNode('output');
      return node
        ? { x: node.x, y: node.y, width: node.width, height: node.height }
        : { x: workflow.outputX, y: workflow.outputY, width: workflow.outputWidth, height: workflow.outputHeight };
    }
    const outputNode = workflow.outputNode(nodeId);
    if (outputNode) return { x: outputNode.x, y: outputNode.y, width: outputNode.width, height: outputNode.height };
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
      const node = workflow.addOutputNode(rect.x, rect.y, width, height);
      workflow.select({ kind: 'output', id: node.id });
    }
    drawing = null;
  }

  function assetTitle(node: WorkflowAssetNode): string {
    return `Asset - ${node.name || 'Untitled'}`;
  }

  function compositionTitle(): string {
    return workflow.compositionName ? `Composition - ${workflow.compositionName}` : 'Composition';
  }

  function outputTitle(node: WorkflowOutputNode): string {
    return node.name ? `Output - ${node.name}` : 'Output';
  }

  async function imageFromDataUrl(dataUrl: string): Promise<HTMLImageElement> {
    const img = new globalThis.Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Could not load storyboard sketch.'));
      img.src = dataUrl;
    });
    return img;
  }

  async function createStoryboardDocument(): Promise<PaintDocument> {
    const doc = PaintDocument.blank(workflow.storyboardWidth, workflow.storyboardHeight, workflow.compositionName || 'Storyboard');
    doc.annotations = workflow.storyboardAnnotationItems.map((item) => ({ ...item }));
    doc.annotationsVisible = workflow.storyboardAnnotationsVisible;
    const layer = doc.activeLayer;
    if (layer) layer.name = 'Storyboard sketch';
    if (workflow.storyboardDataUrl && layer) {
      const img = await imageFromDataUrl(workflow.storyboardDataUrl);
      layer.ctx.clearRect(0, 0, layer.width, layer.height);
      layer.ctx.drawImage(img, 0, 0, layer.width, layer.height);
      layer.touch();
    }
    return doc;
  }

  async function beginStoryboardEditSession(): Promise<void> {
    if (!storyboardCanvas || storyboardViewport) return;
    const doc = await createStoryboardDocument();
    if (!workflow.storyboardEditing || !storyboardCanvas || storyboardViewport) return;
    storyboardDoc = doc;
    editor.beginEmbeddedDocument(doc);
    storyboardViewport = new Viewport(
      storyboardCanvas,
      () => editor.doc,
      () => editor.getActiveStroke(),
      () => editor.getSelection(),
      undefined,
      () => settings.value.workspace.showTransparencyChecker,
    );
    editor.viewport = storyboardViewport;
    storyboardViewport.onAfterRender = () => {
      storyboardViewTick++;
      ui.zoom = storyboardViewport?.scale ?? ui.zoom;
    };
    storyboardViewport.resize();
    requestAnimationFrame(() => storyboardViewport?.fitToView(12));
    storyboardResizeObserver = new ResizeObserver(() => {
      storyboardViewport?.resize();
      requestAnimationFrame(() => storyboardViewport?.center());
    });
    storyboardResizeObserver.observe(storyboardCanvas);
  }

  function persistStoryboardFromDoc(): void {
    const doc = storyboardDoc;
    if (!doc) return;
    const flattened = compositeToCanvas(doc);
    workflow.setStoryboardDataUrl(flattened.toDataURL('image/png'));
    workflow.setStoryboardAnnotations(mergeAnnotations(
      workflow.storyboardAnnotations,
      extractStoryboardAnnotations(doc),
      overlayAnnotationInstructions(doc.annotations),
    ));
    workflow.setStoryboardAnnotationItems(doc.annotations);
    workflow.setStoryboardAnnotationsVisible(doc.annotationsVisible);
  }

  function mergeAnnotations(...groups: string[][]): string[] {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const group of groups) {
      for (const annotation of group) {
        const cleaned = annotation.trim();
        if (!cleaned || seen.has(cleaned)) continue;
        seen.add(cleaned);
        merged.push(cleaned);
      }
    }
    return merged.slice(-24);
  }

  function overlayAnnotationInstructions(items: AnnotationItem[]): string[] {
    return items
      .filter((item) => item.visible && item.text.trim())
      .map((item) => {
        const cx = Math.round(((item.x + item.width / 2) / Math.max(1, workflow.storyboardWidth)) * 100);
        const cy = Math.round(((item.y + item.height / 2) / Math.max(1, workflow.storyboardHeight)) * 100);
        return `at ${cx}% x, ${cy}% y (${item.kind} overlay): ${item.text.trim()}`;
      });
  }

  function extractStoryboardAnnotations(doc: PaintDocument): string[] {
    const annotations: string[] = [];
    for (const layer of doc.layers) {
      if (!layer.visible || layer.kind !== 'text' || !layer.text) continue;
      const text = modelToPlainText(layer.text).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const xPercent = Math.round((layer.text.x / Math.max(1, doc.width)) * 100);
      const yPercent = Math.round((layer.text.y / Math.max(1, doc.height)) * 100);
      const layerName = layer.name.trim() && layer.name !== text ? ` (${layer.name.trim()})` : '';
      annotations.push(`at ${xPercent}% x, ${yPercent}% y${layerName}: ${text}`);
    }
    return annotations;
  }

  function placementSummaryForCanvas(canvas: HTMLCanvasElement): string[] {
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    try {
      return storyboardPlacementSummary(ctx.getImageData(0, 0, canvas.width, canvas.height));
    } catch {
      return [];
    }
  }

  function storyboardAnnotationsForDisplay(): AnnotationItem[] {
    const base = workflow.storyboardEditing && storyboardDoc
      ? storyboardDoc.annotations
      : workflow.storyboardAnnotationItems;
    return [...base, ...(storyboardAnnotationDraft ? [storyboardAnnotationDraft] : [])];
  }

  function storyboardAnnotationScale(): number {
    if (!storyboardCanvas) return 1;
    if (workflow.storyboardEditing && storyboardViewport) return storyboardViewport.scale;
    return storyboardCanvas.getBoundingClientRect().width / Math.max(1, workflow.storyboardWidth);
  }

  function storyboardAnnotationScreenPoint(x: number, y: number): { x: number; y: number } {
    if (workflow.storyboardEditing && storyboardViewport) return storyboardViewport.docToScreen(x, y);
    const scale = storyboardAnnotationScale();
    return { x: x * scale, y: y * scale };
  }

  function updateStoryboardAnnotation(id: string, patch: Partial<Omit<AnnotationItem, 'id'>>): void {
    if (workflow.storyboardEditing && storyboardDoc) {
      editor.updateAnnotation(id, patch);
      persistStoryboardFromDoc();
      return;
    }
    workflow.setStoryboardAnnotationItems(workflow.storyboardAnnotationItems.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function deleteStoryboardAnnotation(id: string): void {
    if (workflow.storyboardEditing && storyboardDoc) {
      editor.deleteAnnotation(id);
      persistStoryboardFromDoc();
      return;
    }
    workflow.setStoryboardAnnotationItems(workflow.storyboardAnnotationItems.filter((item) => item.id !== id));
  }

  function endStoryboardEditSession(): void {
    if (storyboardDoc) persistStoryboardFromDoc();
    storyboardResizeObserver?.disconnect();
    storyboardResizeObserver = null;
    if (storyboardViewport) storyboardViewport.onAfterRender = undefined;
    storyboardViewport?.destroy();
    storyboardViewport = null;
    storyboardDoc = null;
    storyboardInteracting = false;
    storyboardPanning = false;
    storyboardPointerInViewport = false;
    editor.endEmbeddedDocument();
    requestAnimationFrame(() => {
      if (storyboardCanvas && !workflow.storyboardEditing) void restoreStoryboard(workflow.storyboardDataUrl);
    });
  }

  function storyboardPos(event: PointerEvent): { cssX: number; cssY: number } {
    const rect = storyboardCanvas!.getBoundingClientRect();
    return { cssX: event.clientX - rect.left, cssY: event.clientY - rect.top };
  }

  function storyboardPointerInfo(
    event: PointerEvent,
    cssX: number,
    cssY: number,
    dxCss: number,
    dyCss: number,
  ): PointerInfo {
    const viewport = storyboardViewport!;
    const point = viewport.screenToDoc(cssX, cssY);
    return {
      x: point.x,
      y: point.y,
      cssX,
      cssY,
      dxDoc: dxCss / viewport.scale,
      dyDoc: dyCss / viewport.scale,
      dxCss,
      dyCss,
      pressure: event.pressure || 0.5,
      buttons: event.buttons,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      event,
    };
  }

  function startStoryboardTool(event: PointerEvent): void {
    if (!workflow.storyboardEditing) {
      dragPointerDown(event, 'prompt');
      return;
    }
    if (!storyboardViewport || !storyboardCanvas) return;
    event.stopPropagation();
    storyboardPointerClientX = event.clientX;
    storyboardPointerClientY = event.clientY;
    if (editor.textEdit) {
      editor.commitActiveText();
      persistStoryboardFromDoc();
      return;
    }
    if (event.button === 0 && editor.activeTool.editsPixels && editor.activeLayer?.kind === 'text') {
      editor.promptRasterize(editor.activeLayer);
      return;
    }
    try {
      storyboardCanvas.setPointerCapture(event.pointerId);
    } catch {
      /* pointer may already be captured */
    }
    const { cssX, cssY } = storyboardPos(event);
    storyboardLast = { x: cssX, y: cssY };
    if (event.button === 1) {
      storyboardPanning = true;
      return;
    }
    if (event.button !== 0) return;
    if (editor.activeToolId === 'annotation') {
      const info = storyboardPointerInfo(event, cssX, cssY, 0, 0);
      storyboardAnnotationDragStart = { x: info.x, y: info.y };
      storyboardAnnotationDraft = annotationFromDrag({
        kind: editor.annotationType,
        text: editor.annotationText,
        start: storyboardAnnotationDragStart,
        end: { x: info.x, y: info.y },
        color: editor.foregroundCss,
      });
      storyboardInteracting = true;
      return;
    }
    storyboardInteracting = true;
    editor.activeTool.pointerDown(storyboardPointerInfo(event, cssX, cssY, 0, 0));
  }

  function moveStoryboardTool(event: PointerEvent): void {
    if (!workflow.storyboardEditing || !storyboardViewport || !storyboardCanvas) return;
    event.stopPropagation();
    storyboardPointerClientX = event.clientX;
    storyboardPointerClientY = event.clientY;
    const { cssX, cssY } = storyboardPos(event);
    const dxCss = cssX - storyboardLast.x;
    const dyCss = cssY - storyboardLast.y;
    const point = storyboardViewport.screenToDoc(cssX, cssY);
    storyboardViewport.cursor = { x: point.x, y: point.y };
    ui.cursor = { x: Math.floor(point.x), y: Math.floor(point.y) };
    if (storyboardPanning) {
      storyboardViewport.panBy(dxCss, dyCss);
    } else if (storyboardInteracting) {
      if (storyboardAnnotationDraft) {
        const info = storyboardPointerInfo(event, cssX, cssY, dxCss, dyCss);
        storyboardAnnotationDraft = annotationFromDrag({
          kind: storyboardAnnotationDraft.kind,
          text: storyboardAnnotationDraft.text,
          start: storyboardAnnotationDragStart ?? { x: storyboardAnnotationDraft.x, y: storyboardAnnotationDraft.y },
          end: { x: info.x, y: info.y },
          color: storyboardAnnotationDraft.color,
          id: storyboardAnnotationDraft.id,
        });
      } else {
        editor.activeTool.pointerMove(storyboardPointerInfo(event, cssX, cssY, dxCss, dyCss));
      }
    } else if (storyboardViewport.brushRadius > 0) {
      storyboardViewport.invalidate();
    }
    storyboardLast = { x: cssX, y: cssY };
  }

  function stopStoryboardTool(event: PointerEvent | undefined = undefined): void {
    if (!workflow.storyboardEditing || !storyboardViewport || !storyboardCanvas) return;
    event?.stopPropagation();
    if (event) {
      try {
        storyboardCanvas.releasePointerCapture(event.pointerId);
      } catch {
        /* pointer may not be captured */
      }
    }
    if (storyboardPanning) {
      storyboardPanning = false;
      return;
    }
    if (storyboardInteracting && event) {
      const css = storyboardPos(event);
      if (storyboardAnnotationDraft) {
        editor.addAnnotation(storyboardAnnotationDraft.kind, storyboardAnnotationDraft.x, storyboardAnnotationDraft.y, storyboardAnnotationDraft.width, storyboardAnnotationDraft.height, storyboardAnnotationDraft.text, {
          rotation: storyboardAnnotationDraft.rotation,
          flipX: storyboardAnnotationDraft.flipX,
          flipY: storyboardAnnotationDraft.flipY,
          color: storyboardAnnotationDraft.color,
        });
        storyboardAnnotationDraft = null;
        storyboardAnnotationDragStart = null;
      } else {
        editor.activeTool.pointerUp(storyboardPointerInfo(event, css.cssX, css.cssY, css.cssX - storyboardLast.x, css.cssY - storyboardLast.y));
      }
      storyboardInteracting = false;
      persistStoryboardFromDoc();
    }
  }

  function leaveStoryboardTool(): void {
    storyboardPointerInViewport = false;
    if (!storyboardViewport || storyboardInteracting || storyboardPanning) return;
    storyboardViewport.cursor = null;
    ui.cursor = null;
    if (storyboardViewport.brushRadius > 0) storyboardViewport.invalidate();
  }

  function storyboardWheel(event: WheelEvent): void {
    if (!workflow.storyboardEditing || !storyboardViewport || !storyboardCanvas) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      const rect = storyboardCanvas.getBoundingClientRect();
      storyboardViewport.zoomBy(wheelZoomFactor(event.deltaY, event.deltaMode), event.clientX - rect.left, event.clientY - rect.top);
    } else {
      storyboardViewport.panBy(-event.deltaX, -event.deltaY);
    }
  }

  function storyboardCtx(): CanvasRenderingContext2D | null {
    if (!storyboardCanvas) return null;
    const ctx = storyboardCanvas.getContext('2d');
    if (!ctx) return null;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, editor.brushSize);
    ctx.globalAlpha = Math.max(0.01, Math.min(1, editor.brushOpacity));
    ctx.globalCompositeOperation = workflow.storyboardTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = editor.foregroundCss;
    return ctx;
  }

  function isStoryboardBlank(): boolean {
    if (workflow.storyboardEditing && storyboardDoc) {
      const flattened = compositeToCanvas(storyboardDoc);
      const ctx = flattened.getContext('2d', { willReadFrequently: true });
      if (!ctx) return true;
      const data = ctx.getImageData(0, 0, flattened.width, flattened.height).data;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 0) return false;
      }
      return true;
    }
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
    const ctx = storyboardCanvas.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, storyboardCanvas.width, storyboardCanvas.height);
    if (!dataUrl) {
      ctx.restore();
      return;
    }
    try {
      const img = new globalThis.Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Could not load storyboard sketch.'));
        img.src = dataUrl;
      });
      ctx.drawImage(img, 0, 0, storyboardCanvas.width, storyboardCanvas.height);
    } finally {
      ctx.restore();
    }
  }

  function persistStoryboard(): void {
    if (workflow.storyboardEditing && storyboardDoc) {
      persistStoryboardFromDoc();
      return;
    }
    if (!storyboardCanvas || isStoryboardBlank()) {
      workflow.setStoryboardDataUrl(null);
      workflow.setStoryboardAnnotations([]);
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
    if (workflow.storyboardEditing) {
      startStoryboardTool(event);
      return;
    }
    dragPointerDown(event, 'prompt');
  }

  function moveSketch(event: PointerEvent): void {
    if (workflow.storyboardEditing) {
      moveStoryboardTool(event);
      return;
    }
    if (!sketching) return;
    const ctx = storyboardCtx();
    const point = sketchPoint(event);
    if (!ctx || !point) return;
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    event.stopPropagation();
  }

  function stopSketch(event: PointerEvent | undefined = undefined): void {
    if (workflow.storyboardEditing) {
      stopStoryboardTool(event);
      return;
    }
    if (!sketching) return;
    sketching = false;
    persistStoryboard();
    event?.stopPropagation();
  }

  function clearStoryboard(event: MouseEvent): void {
    event.stopPropagation();
    if (workflow.storyboardEditing && storyboardDoc) {
      for (const layer of storyboardDoc.layers) layer.clear();
      storyboardDoc.annotations = [];
      editor.bump();
      storyboardViewport?.invalidateComposite();
      workflow.setStoryboardDataUrl(null);
      workflow.setStoryboardAnnotations([]);
      workflow.setStoryboardAnnotationItems([]);
      return;
    }
    const ctx = storyboardCtx();
    if (!ctx || !storyboardCanvas) return;
    ctx.clearRect(0, 0, storyboardCanvas.width, storyboardCanvas.height);
    workflow.setStoryboardDataUrl(null);
    workflow.setStoryboardAnnotations([]);
    workflow.setStoryboardAnnotationItems([]);
  }

  function safeSegment(value: string, fallback: string): string {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/\.ora$/i, '')
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 52);
    return slug || fallback;
  }

  async function saveStoryboardOra(): Promise<void> {
    if (!storyboardCanvas) return;
    try {
      persistStoryboard();
      if (editor.textEdit) editor.commitActiveText();
      const doc = workflow.storyboardEditing && storyboardDoc
        ? storyboardDoc
        : new PaintDocument(workflow.storyboardWidth, workflow.storyboardHeight, workflow.compositionName || 'Storyboard');
      if (!workflow.storyboardEditing) {
        doc.annotations = workflow.storyboardAnnotationItems.map((item) => ({ ...item }));
        doc.annotationsVisible = workflow.storyboardAnnotationsVisible;
        const layer = new Layer(workflow.storyboardWidth, workflow.storyboardHeight, 'Storyboard sketch');
        layer.ctx.drawImage(storyboardCanvas, 0, 0, workflow.storyboardWidth, workflow.storyboardHeight);
        layer.touch();
        doc.layers = [layer];
        doc.activeLayerId = layer.id;
      }
      const blob = await saveOra(doc);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const path = `storyboards/${safeSegment(workflow.name, 'workflow')}-${safeSegment(workflow.compositionName, 'composition')}.ora`;
      const relativePath = await project.saveDocumentToPath(path, bytes);
      workflow.setStoryboardOraPath(relativePath);
      editor.flash(`Saved ${relativePath}`);
    } catch (e) {
      editor.flash('Storyboard save failed: ' + ((e as Error)?.message ?? String(e)));
    }
  }

  function storyboardAspectHeight(): number {
    return Math.max(120, Math.min(360, workflow.compositionWidth * (workflow.storyboardHeight / Math.max(1, workflow.storyboardWidth))));
  }

  function setStoryboardDimension(kind: 'width' | 'height', value: number): void {
    const width = kind === 'width' ? value : workflow.storyboardWidth;
    const height = kind === 'height' ? value : workflow.storyboardHeight;
    workflow.setStoryboardSize(width, height);
  }

  function applyOutputPreset(node: WorkflowOutputNode, width: number, height: number): void {
    workflow.setOutputFinalSize(node.id, width, height);
  }

  function targetOutputForGenerate(node: WorkflowOutputNode | undefined = undefined): WorkflowOutputNode {
    if (node) return node;
    if (workflow.selection?.kind === 'output') return workflow.outputNode(workflow.selection.id) ?? workflow.outputNodes[0];
    const connected = workflow.outgoing('composition').map((connection) => workflow.outputNode(connection.to)).find(Boolean);
    return connected ?? workflow.outputNodes[0];
  }

  async function generate(node: WorkflowOutputNode | undefined = undefined): Promise<void> {
    const targetOutput = targetOutputForGenerate(node);
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
    if (runOptions.provider === 'custom') {
      error = 'Workflow composition is currently available with Local Codex or Antigravity CLI.';
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
      progress = runOptions.provider === 'antigravity' ? 'Local Antigravity is running...' : 'Local Codex is running...';
    }

    try {
      if (workflow.storyboardEditing && editor.textEdit) editor.commitActiveText();
      const sources = [];
      let hasStoryboardSource = false;
      let storyboardPlacementText = '';
      if (storyboardCanvas && !isStoryboardBlank()) {
        const storyboardSource = workflow.storyboardEditing && storyboardDoc
          ? compositeToCanvas(storyboardDoc)
          : storyboardCanvas;
        storyboardPlacementText = placementSummaryForCanvas(storyboardSource)
          .map((line, index) => `${index + 1}. ${line}`)
          .join('\n');
        sources.push({
          name: 'Storyboard sketch - mandatory layout guide',
          bytes: await canvasToPngBytes(storyboardSource),
        });
        hasStoryboardSource = true;
        persistStoryboard();
      }
      const storyboardAnnotations = workflow.storyboardAnnotations
        .map((annotation, index) => `${index + 1}. ${annotation}`)
        .join('\n');
      for (const [index, node] of sourceNodes.entries()) {
        const asset = assetFor(node);
        if (!asset) continue;
        sources.push({
          name: node.note
            ? `Mandatory asset ${index + 1}: ${node.name}. Role: ${node.note}`
            : `Mandatory asset ${index + 1}: ${node.name}`,
          bytes: await project.readFile({ ...asset, kind: 'generated', modifiedAt: asset.createdAt, size: 0, exists: true }),
        });
      }
      if (!sources.length) throw new Error('Workflow asset files are missing.');
      const requiredAssets = sourceNodes.map((node, index) => `${index + 1}. ${node.name}${node.note ? ` - ${node.note}` : ''}`).join('\n');
      const prompt = `${workflow.prompt.trim()}

Final output aspect ratio: ${ratioLabel(targetOutput.finalWidth, targetOutput.finalHeight)}.

Mandatory connected assets that must be visibly represented:
${requiredAssets}

${hasStoryboardSource ? `Storyboard requirement: input image 1 is the composition storyboard. Treat it as the primary spatial plan for the final image. Preserve the storyboard's relative placement, left/right ordering, approximate scale, subject pose, gesture direction, prop positions, foreground/background zones, and major empty areas. The storyboard is a rough semantic diagram, so do not copy its sketch/grid style; translate it into a polished final image using the connected assets and text prompt.` : ''}

${storyboardPlacementText ? `Storyboard coordinate analysis extracted from the sketch pixels:
${storyboardPlacementText}

Use these coordinate notes as hard placement constraints. Keep the main subject/object centers in the same canvas region shown by the storyboard. If a major subject is detected in the left half or left third, do not move it to the right half in the final image unless the text explicitly says to override the storyboard.` : ''}

${storyboardAnnotations ? `Storyboard text annotations extracted from editable layers:
${storyboardAnnotations}

These annotations are direct user instructions attached to the storyboard. Apply them to the nearest relevant region of the storyboard and treat them as higher priority than guessing from pixels alone.` : ''}

Use the storyboard as the layout reference. This is a generative synthesis task, not a cut-and-paste pasteboard: reason from the connected assets and create a new coherent photo/image based on the text prompt. Use the assets as visual references for identity, subject appearance, prop/object appearance, environment, layout, lighting, and style. Do not blindly paste cropped source pixels together, and do not output only the background or only one source asset.

Unless the user explicitly asks for an impossible or surreal composition, preserve normal real-world structure: plausible anatomy, object scale, perspective, lighting, shadows, occlusion, contact, and physical interaction. If the user deliberately asks for something non-realistic, follow that request intentionally while keeping the result visually coherent.

Human anatomy quality gate: if the final image contains a person, the arms, wrists, hands, palms, and fingers must be natural and unbroken. For a held prop, show one clean believable grip with no duplicated palms, extra hands, fused fingers, missing fingers, or broken joints. Regenerate/refine before finishing if this quality gate is not met.`;
      const result =
        runOptions.provider === 'antigravity'
          ? await composeAntigravityWorkflow(antigravityConfigFromRunOptions(runOptions, project.path, runId), prompt, sources)
          : await composeCodexWorkflow(codexConfigFromRunOptions(runOptions, project.path, runId), prompt, sources);
      if (result.asset) {
        await project.refresh();
        workflow.setOutput(result.asset, targetOutput.id);
      }
      editor.flash(`Generated ${targetOutput.finalWidth} x ${targetOutput.finalHeight}`);
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
          onclick={() => void ui.withLoading('Refreshing project…', () => project.refresh())}
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
        <span>{workflow.nodes.length + 1 + workflow.outputNodes.length} nodes</span>
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
          <div
            class="storyboard"
            class:editing={workflow.storyboardEditing}
            role="group"
            aria-label="Composition storyboard"
            onpointerdown={(event) => {
              if (!workflow.storyboardEditing) dragPointerDown(event, 'prompt');
            }}
          >
            <div class="storyboard-head">
              <span><Icon svg={PaintBrush} size={13} /> Storyboard</span>
              <div class="storyboard-actions">
                <button
                  type="button"
                  class:active={workflow.storyboardEditing}
                  aria-label={workflow.storyboardEditing ? 'Exit storyboard edit mode' : 'Edit storyboard'}
                  use:tooltip={{ text: workflow.storyboardEditing ? 'View mode' : 'Edit storyboard', placement: 'top' }}
                  onpointerdown={(event) => event.stopPropagation()}
                  onclick={(event) => {
                    event.stopPropagation();
                    workflow.setStoryboardEditing(!workflow.storyboardEditing);
                  }}
                >
                  <Icon svg={Edit} size={13} />
                </button>
                <button
                  type="button"
                  aria-label="Save storyboard as OpenRaster"
                  use:tooltip={{ text: 'Save storyboard .ora', placement: 'top' }}
                  onpointerdown={(event) => event.stopPropagation()}
                  onclick={(event) => {
                    event.stopPropagation();
                    void saveStoryboardOra();
                  }}
                >
                  <Icon svg={DocumentSave} size={13} />
                </button>
                <button
                  type="button"
                  class:active={workflow.storyboardAnnotationsVisible}
                  aria-label={workflow.storyboardAnnotationsVisible ? 'Hide annotations' : 'Show annotations'}
                  use:tooltip={{ text: workflow.storyboardAnnotationsVisible ? 'Hide annotations' : 'Show annotations', placement: 'top' }}
                  onpointerdown={(event) => event.stopPropagation()}
                  onclick={(event) => {
                    event.stopPropagation();
                    if (storyboardDoc) storyboardDoc.annotationsVisible = !workflow.storyboardAnnotationsVisible;
                    workflow.setStoryboardAnnotationsVisible(!workflow.storyboardAnnotationsVisible);
                  }}
                >
                  <Icon svg={CommentNote} size={13} />
                </button>
                <button
                  type="button"
                  aria-label="Clear storyboard"
                  use:tooltip={{ text: 'Clear storyboard', placement: 'top' }}
                  onpointerdown={(event) => event.stopPropagation()}
                  onclick={clearStoryboard}
                >
                  <Icon svg={Dismiss} size={13} />
                </button>
              </div>
            </div>
            {#if workflow.storyboardEditing}
              <div class="storyboard-edit-bar" role="presentation" onpointerdown={(event) => event.stopPropagation()}>
                <label><Icon svg={SlideSize} size={13} /> <input type="number" min="64" step="1" value={workflow.storyboardWidth} oninput={(event) => setStoryboardDimension('width', event.currentTarget.valueAsNumber)} /></label>
                <span class="dim-x">x</span>
                <label><input type="number" min="64" step="1" value={workflow.storyboardHeight} oninput={(event) => setStoryboardDimension('height', event.currentTarget.valueAsNumber)} /></label>
              </div>
            {/if}
            {#if workflow.storyboardOraPath}
              <div class="storyboard-path" role="presentation" onpointerdown={(event) => event.stopPropagation()}>{workflow.storyboardOraPath}</div>
            {/if}
            <div class="storyboard-canvas-wrap" style={`height:${storyboardAspectHeight()}px`}>
              <canvas
                bind:this={storyboardCanvas}
                width={workflow.storyboardWidth}
                height={workflow.storyboardHeight}
                aria-label="Storyboard annotation canvas"
                onpointerenter={(event) => {
                  if (!workflow.storyboardEditing) return;
                  storyboardPointerInViewport = true;
                  storyboardPointerClientX = event.clientX;
                  storyboardPointerClientY = event.clientY;
                }}
                onpointerleave={workflow.storyboardEditing ? leaveStoryboardTool : undefined}
                onpointerdown={startSketch}
                onpointermove={moveSketch}
                onpointerup={stopSketch}
                onpointercancel={stopSketch}
                onwheel={storyboardWheel}
                oncontextmenu={(event) => {
                  if (workflow.storyboardEditing) event.preventDefault();
                }}
              ></canvas>
              <AnnotationOverlay
                annotations={storyboardAnnotationsForDisplay()}
                visible={workflow.storyboardAnnotationsVisible}
                scale={storyboardAnnotationScale()}
                revision={storyboardViewTick}
                selectedId={workflow.storyboardEditing ? editor.selectedAnnotationId : null}
                toScreen={storyboardAnnotationScreenPoint}
                onSelect={(id) => {
                  if (workflow.storyboardEditing) editor.selectAnnotation(id);
                }}
                onUpdate={updateStoryboardAnnotation}
                onDelete={deleteStoryboardAnnotation}
              />
            </div>
            {#if storyboardOverlayBox}
              <TextEditorOverlay box={storyboardOverlayBox} />
            {/if}
          </div>
          <textarea
            class="composition-text"
            placeholder="A girl on the beach standing in front of an ice cream truck, holding an ice cream..."
            value={workflow.prompt}
            onpointerdown={(event) => event.stopPropagation()}
            oninput={(event) => workflow.setPrompt(event.currentTarget.value)}
          ></textarea>
          {#if runOptions.provider === 'antigravity'}
            <label>
              <span>Antigravity command</span>
              <input bind:value={runOptions.antigravityBin} placeholder="agy or full path" />
            </label>
          {/if}
          <div class="composition-ai-options" role="presentation" onpointerdown={(event) => event.stopPropagation()}>
            <AiRunOptionsControl bind:options={runOptions} disabled={busy} />
          </div>
          {#if busy}<p class="progress">{progress}</p>{/if}
          {#if error}<p class="err">{error}</p>{/if}
        </article>

        {#each workflow.outputNodes as outputNode (outputNode.id)}
          {@const outputAsset = outputAssetFor(outputNode)}
          <article
            class="output-node"
            class:selected={workflow.selection?.kind === 'output' && workflow.selection.id === outputNode.id}
            style={`transform:translate(${outputNode.x}px, ${outputNode.y}px); width:${outputNode.width}px; --node-color:${outputNode.color}; --port-y:${outputNode.height / 2}px`}
            onpointerdown={(event) => {
              workflow.select({ kind: 'output', id: outputNode.id });
              event.stopPropagation();
            }}
          >
            <button
              class="node-port input"
              aria-label={portTitle('input', outputTitle(outputNode))}
              use:tooltip={{ text: 'Input', placement: 'left' }}
              onpointerdown={(event) => event.stopPropagation()}
              onpointerup={(event) => finishConnection(event, outputNode.id)}
            ></button>
            <button
              class="node-port output"
              aria-label={portTitle('output', outputTitle(outputNode))}
              use:tooltip={{ text: 'Output', placement: 'right' }}
              onpointerdown={(event) => startConnection(event, outputNode.id)}
            ></button>
            <div class="node-head">
              <span class="node-drag-region" use:dragHandle={{ type: 'output', node: outputNode }}>{outputTitle(outputNode)}</span>
              <div class="node-tools">
                <button
                  type="button"
                  aria-label={`Remove ${outputTitle(outputNode)}`}
                  use:tooltip={{ text: 'Remove output', placement: 'top' }}
                  disabled={workflow.outputNodes.length <= 1}
                  onpointerdown={(event) => event.stopPropagation()}
                  onclick={(event) => {
                    event.stopPropagation();
                    workflow.removeOutputNode(outputNode.id);
                  }}
                ><Icon svg={Delete} size={13} /></button>
              </div>
            </div>
            <div class="output-preview" style={`height:${Math.max(76, outputNode.height - 154)}px`}>
              {#if outputAsset?.previewDataUrl}<img class="preview-image" src={outputAsset.previewDataUrl} alt="" />{:else}<Icon svg={Image} size={32} />{/if}
            </div>
            <div class="output-props" role="presentation" onpointerdown={(event) => event.stopPropagation()}>
              <label>
                Width
                <input type="number" min="64" step="1" value={outputNode.finalWidth} oninput={(event) => workflow.setOutputFinalSize(outputNode.id, event.currentTarget.valueAsNumber, outputNode.finalHeight)} />
              </label>
              <label>
                Height
                <input type="number" min="64" step="1" value={outputNode.finalHeight} oninput={(event) => workflow.setOutputFinalSize(outputNode.id, outputNode.finalWidth, event.currentTarget.valueAsNumber)} />
              </label>
              <div class="preset-row">
                <button type="button" onclick={() => applyOutputPreset(outputNode, 1024, 1024)}>1:1</button>
                <button type="button" onclick={() => applyOutputPreset(outputNode, 1792, 1024)}>Banner</button>
                <button type="button" onclick={() => applyOutputPreset(outputNode, 1080, 1920)}>IG</button>
              </div>
            </div>
            <div class="output-actions">
              <button onclick={() => void generate(outputNode)} disabled={busy}>
                <Icon svg={PaintBrush} size={14} />
                Generate
              </button>
              <button onclick={() => void placeOutput(outputNode)} disabled={!outputAsset}>
                <Icon svg={Open} size={14} />
                Place
              </button>
            </div>
          </article>
        {/each}
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
  .node-head button.active,
  .storyboard-head button.active {
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
    cursor: grab;
  }
  .storyboard.editing {
    cursor: default;
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
  .storyboard-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .storyboard-edit-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
    color: var(--text-dim);
    font-size: 11px;
  }
  .storyboard-edit-bar label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
  }
  .storyboard-edit-bar input {
    width: 64px;
    height: 22px;
    padding: 2px 5px;
    font-size: 11px;
  }
  .dim-x {
    color: var(--text-dim);
  }
  .storyboard-path {
    padding: 0 8px 5px;
    color: var(--text-dim);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .storyboard-canvas-wrap {
    position: relative;
    width: 100%;
    max-height: 360px;
    overflow: hidden;
  }
  .storyboard canvas {
    display: block;
    width: 100%;
    height: 100%;
    cursor: grab;
    background:
      linear-gradient(rgba(255, 255, 255, 0.06) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255, 255, 255, 0.06) 1px, transparent 1px);
    background-color: #1d1f22;
    background-size: 24px 24px;
    touch-action: none;
  }
  .storyboard.editing canvas {
    cursor: crosshair;
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
  .composition-ai-options {
    display: flex;
    justify-content: flex-start;
    padding: 0 8px 8px;
  }
  .output-actions {
    justify-content: flex-end;
    padding: 8px;
    border-top: 1px solid #4b4d52;
  }
  .output-actions button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .output-props {
    display: grid;
    gap: 7px;
    padding: 8px;
    border-top: 1px solid #4b4d52;
    background: #242528;
    color: var(--text-dim);
    font-size: 11px;
  }
  .output-props label {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    align-items: center;
    gap: 6px;
  }
  .output-props input {
    min-width: 0;
    height: 24px;
    padding: 3px 6px;
  }
  .preset-row {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 5px;
  }
  .preset-row button {
    min-width: 0;
    padding: 3px 5px;
    font-size: 11px;
  }
  .draw-preview {
    position: absolute;
    border: 1px dashed var(--accent);
    background: color-mix(in srgb, var(--accent) 15%, transparent);
    pointer-events: none;
  }
</style>
