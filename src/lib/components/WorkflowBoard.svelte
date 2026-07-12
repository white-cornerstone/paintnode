<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import { getSmoothStepPath, Position } from '@xyflow/system';
  import Icon from './Icon.svelte';
  import AiRunOptionsControl from './AiRunOptionsControl.svelte';
  import { tooltip } from '../actions/tooltip';
  import {
    codexConfigFromRunOptions,
    antigravityConfigFromRunOptions,
    cancelAiRun,
    isDesktop,
    providerQaMode,
    readProjectFile,
    resolveProjectAssetMaterial,
    storeProjectAssetBytes,
    type ProjectAsset,
  } from '../integrations/desktop';
  import { bytesToBitmap, canvasToPngBytes } from '../io';
  import { PaintDocument } from '../engine/Document.svelte';
  import { Layer } from '../engine/Layer.svelte';
  import { modelToPlainText } from '../engine/text/model';
  import { Viewport } from '../engine/Viewport';
  import type { PointerInfo } from '../engine/tools/Tool';
  import { wheelZoomFactor } from '../engine/zoomGesture';
  import { compositeToCanvas } from '../engine/compositor';
  import { saveOra } from '../ora/save';
  import { loadOra } from '../ora/load';
  import { editor } from '../state/editor.svelte';
  import { project } from '../state/project.svelte';
  import { settings } from '../state/settings.svelte';
  import { aiRunOptionsFromSettings } from '../state/settings';
  import { imageProviderFromRunOptions } from '../ai/taskSupport';
  import { ui } from '../state/ui.svelte';
  import { aiTasks } from '../state/aiTasks.svelte';
  import {
    workflow,
    type WorkflowAssetNode,
    type WorkflowBriefNode,
    type WorkflowConnection,
    type WorkflowCreatorNode,
    type WorkflowOutputNode,
    type WorkflowStoreRunOptions,
    type WorkflowUnsupportedNode,
  } from '../state/workflow.svelte';
  import { WorkflowSelectiveUiState } from '../state/workflowSelectiveUiState.svelte';
  import {
    nextWorkflowCandidateIndex,
    type WorkflowCandidateNavigationKey,
  } from '../workflow/candidateKeyboard';
  import {
    creatorNodeDefinition,
    creatorNodeFitsPlacementBounds,
    createWorkflowBoardRunIdGenerator,
    createWorkflowReviewRefreshIdentity,
    findOpenCreatorNodePlacement,
    resolveWorkflowBoardProjectAsset,
    resolveWorkflowStoryboardRead,
    selectiveExecutionOutcomeSummary,
    selectiveExecutionPreviewSummary,
    selectiveExecutionRunAvailability,
    workflowProviderSelection,
    workflowReadiness,
    workflowCandidateBranchResultSummary,
    workflowCandidateProgressLabel,
    resolveWorkflowCampaignPath,
    type CreatorNodeType,
    type WorkflowNodePort,
    type WorkflowSelectiveExecutionOutcome,
    type WorkflowSelectiveRunMode,
    type WorkflowStoryboardDescriptor,
    WorkflowReviewRefreshGate,
  } from '../workflow';
  import { restoreExternalDialogTrigger, workflowInitialFocusSelector } from '../state/workflowFocus';
  import { openWorkflowResultInEditor, type OpenWorkflowResultRequest } from '../state/workflowEditorCommands';
  import { Add, ArrowSync, CheckmarkCircle, CommentNote, Delete, Dismiss, DocumentSave, Edit, ErrorCircle, Image, Link, Open, PaintBrush, SlideSize, Sparkle } from '../icons';
  import TextEditorOverlay from './TextEditorOverlay.svelte';
  import AnnotationOverlay from './AnnotationOverlay.svelte';
  import WorkflowNodePorts from './workflow/WorkflowNodePorts.svelte';
  import WorkflowNodePalette from './workflow/WorkflowNodePalette.svelte';
  import WorkflowNodePreflight from './workflow/WorkflowNodePreflight.svelte';
  import { annotationFromDrag, type AnnotationItem } from '../engine/annotations';
  import {
    createAntigravityWorkflowTransformExecutor,
    createCodexWorkflowTransformExecutor,
  } from '../integrations/workflowCompositionExecutors';
  import {
    createProviderFreeQaWorkflowExecutor,
    type ProviderFreeQaScenario,
  } from '../integrations/providerFreeQaWorkflowExecutor';
  import WorkflowDirectorDialog from './WorkflowDirectorDialog.svelte';
  import WorkflowDirectorRevisionDialog from './WorkflowDirectorRevisionDialog.svelte';
  import { createProviderFreeWorkflowRevisionRequester } from '../integrations/providerFreeWorkflowRevision';
  import { createConfiguredWorkflowRevisionRequester } from '../integrations/workflowDirectorRevisionAdapters';
  import type { WorkflowDirectorRevisionRequester } from '../workflow';

  type WorkflowMapKind = 'asset' | 'brief' | 'composition' | 'creator' | 'output' | 'unsupported' | 'viewport';
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
  const briefCreatorDefinition = creatorNodeDefinition('brief');
  let runOptions = $state(aiRunOptionsFromSettings(settings.value));
  let busy = $state(false);
  let progress = $state('');
  let candidateResultMessages = $state<Record<string, string>>({});
  let error = $state('');
  const imageProvider = $derived(imageProviderFromRunOptions(runOptions));
  let qaMode = $state<'provider-free' | 'provider-e2e' | null>(null);
  let qaModeResolved = $state(!desktop);
  let qaScenario = $state<ProviderFreeQaScenario>('success');
  let candidateCount = $state(3);
  let candidateConcurrency = $state(2);
  let selectedReviewCandidates = $state<Record<string, string>>({});
  let reviewVerificationEpoch = 0;
  const reviewRefreshGate = new WorkflowReviewRefreshGate();
  let activeCandidateController: AbortController | null = null;
  const providerSelection = $derived(workflowProviderSelection(qaModeResolved, qaMode, imageProvider));
  let dragging: { type: 'asset' | 'prompt' | 'creator' | 'output' | 'unsupported'; id?: string; dx: number; dy: number } | null = null;
  let panning: { x: number; y: number } | null = null;
  let mapDragging = $state<{ offsetX: number; offsetY: number } | null>(null);
  let connecting = $state<{ from: { nodeId: WorkflowNodeId; portId: string }; x: number; y: number } | null>(null);
  let overscrollX = $state(0);
  let overscrollY = $state(0);
  let overscrollReturning = $state(false);
  let drawing = $state<{ type: 'asset' | 'composition' | 'output'; x: number; y: number; width: number; height: number } | null>(null);
  let sketching = false;
  let altDown = $state(false);
  let boardEl = $state<HTMLDivElement>();
  let paletteButton = $state<HTMLButtonElement>();
  let paletteOpen = $state(false);
  let directorOpen = $state(false);
  let revisionDirectorOpen = $state(false);
  let revisionDirectorRequester = $state<WorkflowDirectorRevisionRequester | null>(null);
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
  let activeTransformNodeId = $state<string | null>(null);
  let activeWorkflowTaskId = $state<string | null>(null);
  const selectiveUiState = new WorkflowSelectiveUiState();
  let selectiveTargetNodeId = $state<string | null>(null);
  let selectiveMode = $state<WorkflowSelectiveRunMode | null>(null);
  let selectiveOutcome = $state<WorkflowSelectiveExecutionOutcome | null>(null);
  let selectiveRunning = $state(false);
  let selectiveMessage = $state('');
  let selectiveError = $state('');
  let lastSelectiveContextIdentity = '';
  let boardDestroyed = false;
  let overscrollIdleTimer: ReturnType<typeof setTimeout> | null = null;
  let overscrollEndTimer: ReturnType<typeof setTimeout> | null = null;
  let handledFocusRequest = 0;

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
  function verifiedReviewResolutions() {
    return Object.fromEntries(workflow.graphSnapshot().nodes
      .filter((node) => node.type === 'review')
      .map((node) => [
        node.id,
        workflow.reviewResolution(node.id, assets, true, project.identity),
      ]));
  }
  const readiness = $derived.by(() => {
    workflow.rev;
    project.current;
    return workflowReadiness(workflow.graphSnapshot(), {
      desktop,
      projectPath: project.path,
      assets: assets.map((asset) => ({ id: asset.id, relativePath: asset.relativePath, exists: asset.exists })),
      provider: providerSelection.provider,
      supportedProviders: providerSelection.supportedProviders,
      requireVerifiedReview: true,
      reviewResolutions: verifiedReviewResolutions(),
    });
  });

  function outputReadiness(outputNodeId: string) {
    return workflowReadiness(workflow.graphSnapshot(), {
      desktop,
      projectPath: project.path,
      assets: assets.map((asset) => ({ id: asset.id, relativePath: asset.relativePath, exists: asset.exists })),
      provider: providerSelection.provider,
      supportedProviders: providerSelection.supportedProviders,
      targetNodeId: outputNodeId,
      requireVerifiedReview: true,
      reviewResolutions: verifiedReviewResolutions(),
    });
  }

  function selectivePreviewContextIdentity(): string {
    workflow.rev;
    return JSON.stringify({
      graphRevision: workflow.rev,
      projectIdentity: project.identity,
      provider: providerSelection.provider,
      qaScenario,
      options: JSON.stringify(runOptions),
      keepAiDebugArtifacts: settings.value.workspace.keepAiDebugArtifacts,
      assets: assets.map((asset) => [asset.id, asset.relativePath, asset.exists]),
    });
  }

  $effect(() => {
    const identity = selectivePreviewContextIdentity();
    if (lastSelectiveContextIdentity && identity !== lastSelectiveContextIdentity && !selectiveRunning) {
      invalidateSelectivePreview();
    }
    lastSelectiveContextIdentity = identity;
  });

  $effect(() => {
    const request = ui.workflowFocusRequest;
    if (request === 0 || request === handledFocusRequest) return;
    handledFocusRequest = request;
    const selector = workflowInitialFocusSelector(readiness.nextAction?.code ?? null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(selector)?.focus());
  });
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
    boardDestroyed = true;
    endStoryboardEditSession();
    if (overscrollIdleTimer) clearTimeout(overscrollIdleTimer);
    if (overscrollEndTimer) clearTimeout(overscrollEndTimer);
  });

  onMount(() => {
    if (desktop) {
      void providerQaMode()
        .then((mode) => {
          if (!boardDestroyed) qaMode = mode;
        })
        .catch(() => {
          if (!boardDestroyed) qaMode = null;
        })
        .finally(() => {
          if (!boardDestroyed) qaModeResolved = true;
        });
    }
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

  async function chooseProjectFolder(trigger: HTMLElement): Promise<void> {
    await project.openFolder();
    await tick();
    restoreExternalDialogTrigger(trigger);
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

  function openRevisionDirector(): void {
    revisionDirectorRequester = qaMode === 'provider-free'
      ? createProviderFreeWorkflowRevisionRequester()
      : createConfiguredWorkflowRevisionRequester(runOptions);
    revisionDirectorOpen = true;
  }

  function outputAssetFor(node: WorkflowOutputNode): ProjectAsset | null {
    const path = resolveWorkflowCampaignPath(workflow.serialize(), { outputNodeId: node.id });
    if (path?.reviewNodeId) {
      const resolution = workflow.reviewResolution(path.reviewNodeId, assets, true, project.identity);
      if (resolution.state !== 'ready') return null;
      return assets.find((asset) => (
        asset.id === resolution.output.assetId && asset.relativePath === resolution.output.relativePath
      )) ?? null;
    }
    if (path?.transformNodeId) {
      const effective = workflow.effectiveAcceptedEditorOutput(path.transformNodeId);
      if (effective) {
        return assets.find((asset) => (
          asset.id === effective.assetId && asset.relativePath === effective.relativePath
        )) ?? null;
      }
    }
    return assets.find((asset) => asset.id === node.outputAssetId || asset.relativePath === node.outputRelativePath) ?? null;
  }

  function creatorConfigString(config: Record<string, unknown>, key: string): string {
    return typeof config[key] === 'string' ? config[key] : '';
  }

  async function placeOutput(node: WorkflowOutputNode): Promise<void> {
    const outputAsset = outputAssetFor(node);
    if (!outputAsset) return;
    try {
      const result = await project.readAsset(outputAsset);
      const bytes = await (await fetch(result.dataUrl)).arrayBuffer();
      const bmp = await bytesToBitmap(new Uint8Array(bytes), outputAsset.mime ?? 'image/png');
      const placed = editor.placeImage(bmp, bmp.width, bmp.height, outputAsset.name.replace(/\.[^.]+$/, ''), {
        assetId: outputAsset.id,
        path: outputAsset.relativePath,
      });
      bmp.close();
      if (!placed.layerId) throw new Error('Open or create an image document before placing the workflow output.');
      editor.flash(`Placed ${outputAsset.name}`);
    } catch (e) {
      editor.flash('Place output failed: ' + ((e as Error)?.message ?? String(e)));
    }
  }

  async function openResultInEditor(request: OpenWorkflowResultRequest): Promise<void> {
    try {
      await openWorkflowResultInEditor(request);
      editor.flash('Opened workflow result in editor');
    } catch (cause) {
      editor.flash('Open in editor failed: ' + ((cause as Error)?.message ?? String(cause)));
    }
  }

  function dragPointerDown(
    event: PointerEvent,
    type: 'asset' | 'prompt' | 'creator' | 'output' | 'unsupported',
    node: WorkflowAssetNode | WorkflowBriefNode | WorkflowCreatorNode | WorkflowOutputNode | WorkflowUnsupportedNode | undefined = undefined,
  ): void {
    if (!(event.currentTarget instanceof HTMLElement) || !boardEl) return;
    const output = type === 'output' && node ? workflow.outputNode(node.id) : null;
    const x = type === 'asset' || type === 'creator' || type === 'unsupported' ? (node?.x ?? 0) : type === 'prompt' ? workflow.promptX : (output?.x ?? workflow.outputX);
    const y = type === 'asset' || type === 'creator' || type === 'unsupported' ? (node?.y ?? 0) : type === 'prompt' ? workflow.promptY : (output?.y ?? workflow.outputY);
    if (type === 'asset' && node) workflow.select({ kind: 'asset', id: node.id });
    else if (type === 'creator' && node) workflow.select({ kind: 'creator', id: node.id });
    else if (type === 'unsupported' && node) workflow.select({ kind: 'unsupported', id: node.id });
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
    params: { type: 'asset' | 'prompt' | 'creator' | 'output' | 'unsupported'; node?: WorkflowAssetNode | WorkflowBriefNode | WorkflowCreatorNode | WorkflowOutputNode | WorkflowUnsupportedNode },
  ): { update: (next: { type: 'asset' | 'prompt' | 'creator' | 'output' | 'unsupported'; node?: WorkflowAssetNode | WorkflowBriefNode | WorkflowCreatorNode | WorkflowOutputNode | WorkflowUnsupportedNode }) => void; destroy: () => void } {
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
      else if (dragging.type === 'creator' && dragging.id) workflow.moveNode(dragging.id, x, y);
      else if (dragging.type === 'unsupported' && dragging.id) workflow.moveNode(dragging.id, x, y);
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
      ...workflow.briefNodes.map((node) => ({
        id: node.id,
        kind: 'brief' as const,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        color: node.color,
      })),
      ...workflow.creatorNodes.map((node) => ({
        id: node.id,
        kind: 'creator' as const,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        color: node.color,
      })),
      ...workflow.unsupportedNodes.map((node) => ({
        id: node.id,
        kind: 'unsupported' as const,
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        color: node.color,
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
    const source = outputPortPoint(connection.from, connection.sourcePortId);
    const target = inputPortPoint(connection.to, connection.targetPortId);
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
    const briefNode = workflow.briefNodes.find((item) => item.id === nodeId);
    if (briefNode) return { x: briefNode.x, y: briefNode.y, width: briefNode.width, height: briefNode.height };
    const creatorNode = workflow.creatorNodes.find((item) => item.id === nodeId);
    if (creatorNode) return { x: creatorNode.x, y: creatorNode.y, width: creatorNode.width, height: creatorNode.height };
    const unsupportedNode = workflow.unsupportedNodes.find((item) => item.id === nodeId);
    if (unsupportedNode) return { x: unsupportedNode.x, y: unsupportedNode.y, width: unsupportedNode.width, height: unsupportedNode.height };
    const node = workflow.nodes.find((item) => item.id === nodeId);
    return node ? { x: node.x, y: node.y, width: node.width, height: node.height } : null;
  }

  function workflowNodePorts(nodeId: WorkflowNodeId): { inputs: WorkflowNodePort[]; outputs: WorkflowNodePort[] } {
    workflow.rev;
    const node = workflow.graphSnapshot().nodes.find((item) => item.id === nodeId);
    return node?.ports ?? { inputs: [], outputs: [] };
  }

  function inputPortPoint(nodeId: WorkflowNodeId, portId: string): { x: number; y: number } | null {
    const rect = workflowNodeRect(nodeId);
    const ports = workflowNodePorts(nodeId).inputs;
    const index = ports.findIndex((port) => port.id === portId);
    if (!rect || index < 0) return null;
    return { x: rect.x, y: rect.y + rect.height * ((index + 1) / (ports.length + 1)) };
  }

  function outputPortPoint(nodeId: WorkflowNodeId, portId: string): { x: number; y: number } | null {
    const rect = workflowNodeRect(nodeId);
    const ports = workflowNodePorts(nodeId).outputs;
    const index = ports.findIndex((port) => port.id === portId);
    if (!rect || index < 0) return null;
    return { x: rect.x + rect.width, y: rect.y + rect.height * ((index + 1) / (ports.length + 1)) };
  }

  function connectionPath(connection: WorkflowConnection): string {
    const source = outputPortPoint(connection.from, connection.sourcePortId);
    const target = inputPortPoint(connection.to, connection.targetPortId);
    if (!source || !target) return '';
    return routedPath(source, target);
  }

  function pendingConnectionPath(): string {
    if (!connecting) return '';
    const source = outputPortPoint(connecting.from.nodeId, connecting.from.portId);
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

  async function closeNodePalette(): Promise<void> {
    paletteOpen = false;
    await tick();
    paletteButton?.focus();
  }

  async function addCreatorNodeFromPalette(type: CreatorNodeType): Promise<void> {
    const definition = creatorNodeDefinition(type);
    const preferred = {
      x: (boardWidth / 2 - workflow.panX) / workflow.zoom - definition.defaultSize.width / 2,
      y: (boardHeight / 2 - workflow.panY) / workflow.zoom - definition.defaultSize.height / 2,
    };
    const visibleBounds = {
      x: -workflow.panX / workflow.zoom,
      y: -workflow.panY / workflow.zoom,
      width: boardWidth / workflow.zoom,
      height: boardHeight / workflow.zoom,
      padding: 12 / workflow.zoom,
    };
    const position = findOpenCreatorNodePlacement(preferred, definition.defaultSize, workflowMapItems(), 20, visibleBounds);
    const nodeId = workflow.addCreatorNode(type, position);
    paletteOpen = false;
    if (!creatorNodeFitsPlacementBounds(position, definition.defaultSize, visibleBounds)) {
      centerBoardAt(
        position.x + definition.defaultSize.width / 2,
        position.y + definition.defaultSize.height / 2,
      );
    }
    await tick();
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-workflow-node="${nodeId}"]`)?.focus());
  }

  function startConnection(event: PointerEvent, nodeId: WorkflowNodeId, portId: string): void {
    if (!(event.currentTarget instanceof HTMLElement)) return;
    const point = boardPoint(event);
    workflow.connectionError = null;
    connecting = { from: { nodeId, portId }, x: point.x, y: point.y };
    event.stopPropagation();
  }

  function finishConnection(event: PointerEvent, nodeId: WorkflowNodeId, portId: string): void {
    if (!connecting) return;
    workflow.connectPorts(connecting.from.nodeId, connecting.from.portId, nodeId, portId);
    connecting = null;
    event.stopPropagation();
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

  function invalidateSelectivePreview(): void {
    if (selectiveUiState.busy && !selectiveRunning) void workflow.cancelSelectiveExecution();
    selectiveUiState.invalidatePreview();
    selectiveOutcome = null;
    selectiveTargetNodeId = null;
    selectiveMode = null;
    selectiveMessage = '';
    selectiveError = '';
  }

  function preflightForNode(nodeId: string) {
    return selectiveUiState.preflight?.stateByNodeId[nodeId] ?? null;
  }

  function workflowExecutionOptionsIdentity(): string {
    return JSON.stringify({
      provider: providerSelection.provider,
      qaMode,
      qaScenario,
      options: JSON.stringify(runOptions),
      keepAiDebugArtifacts: settings.value.workspace.keepAiDebugArtifacts,
      assets: assets.map((asset) => [asset.id, asset.relativePath, asset.exists]),
    });
  }

  function createWorkflowExecutionContext(
    runId: string,
    progressLabel: (stage: string, message: string) => string = (_stage, message) => message,
  ) {
    const runSelection = providerSelection;
    if (!runSelection.ready || !runSelection.provider) {
      throw new Error('Wait for native QA mode detection before preparing execution.');
    }
    const runProjectPath = project.path;
    const runProvider = runSelection.provider;
    const runAssets = assets.map((asset) => ({ ...asset }));
    const runIdGenerator = createWorkflowBoardRunIdGenerator(runId);
    const executors = runSelection.qaFake
      ? [createProviderFreeQaWorkflowExecutor('provider-free', undefined, { scenario: qaScenario })]
      : [
          createCodexWorkflowTransformExecutor(codexConfigFromRunOptions(
            runOptions, runProjectPath, runId, false, settings.value.workspace.keepAiDebugArtifacts,
          )),
          createAntigravityWorkflowTransformExecutor(antigravityConfigFromRunOptions(
            runOptions, runProjectPath, runId, false, settings.value.workspace.keepAiDebugArtifacts,
          )),
        ];
    const options: WorkflowStoreRunOptions = {
      projectPath: runProjectPath,
      provider: runProvider,
      executors,
      assets: runAssets,
      selectiveExecutionIdentity: workflowExecutionOptionsIdentity(),
      currentProjectIdentity: () => project.identity,
      runIdGenerator,
      ...(runSelection.qaFake ? {} : {
        cancelExecutionForRun: async (attemptRunId: string) => {
          await cancelAiRun(attemptRunId);
          return { disposition: 'detached' as const };
        },
      }),
      onProgress: (event) => {
        const message = progressLabel(event.stage, event.message);
        progress = message;
        if (activeWorkflowTaskId) aiTasks.setProgress(activeWorkflowTaskId, message);
      },
      resolveAsset: (asset) => resolveWorkflowBoardProjectAsset(runProjectPath, asset, resolveProjectAssetMaterial),
      readStoryboard: (storyboard: Readonly<WorkflowStoryboardDescriptor>) => resolveWorkflowStoryboardRead(
        storyboard,
        {
          readEmbedded: async (dataUrl) => new Uint8Array(await (await fetch(dataUrl)).arrayBuffer()),
          readOra: async (relativePath) => {
            if (!runProjectPath) throw new Error('No project is open.');
            const bytes = await readProjectFile(runProjectPath, relativePath);
            const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
            return canvasToPngBytes(compositeToCanvas(await loadOra(buffer)));
          },
        },
      ),
      storeAsset: async (artifact) => (await storeProjectAssetBytes({
        projectPath: artifact.projectPath,
        name: artifact.name,
        bytes: artifact.bytes,
        kind: 'generated',
        prompt: artifact.prompt,
        width: artifact.width,
        height: artifact.height,
        mime: artifact.mime,
      })).asset,
    };
    return { runProjectPath, runProvider, options };
  }

  $effect(() => {
    workflow.rev;
    project.identity;
    const workflowId = workflow.graphSnapshot().id;
    const assetIdentity = assets.map((asset) => [asset.id, asset.relativePath, asset.exists] as const);
    const executionOptionsIdentity = workflowExecutionOptionsIdentity();
    const reviewNodeIds = workflow.graphSnapshot().nodes
      .filter((node) => node.type === 'review')
      .map((node) => node.id);
    const ready = providerSelection.ready && Boolean(providerSelection.provider);
    if (!ready) {
      untrack(() => workflow.invalidateReviewState(reviewNodeIds));
      reviewRefreshGate.reset();
      reviewVerificationEpoch += 1;
      return;
    }
    if (reviewNodeIds.length === 0) {
      reviewRefreshGate.reset();
      reviewVerificationEpoch += 1;
      return;
    }
    const refreshIdentity = createWorkflowReviewRefreshIdentity({
      workflowId,
      workflowRevision: workflow.rev,
      projectIdentity: project.identity,
      executionOptionsIdentity,
      assetIdentity,
    });
    if (!reviewRefreshGate.shouldRefresh(refreshIdentity)) return;
    const epoch = ++reviewVerificationEpoch;
    void (async () => {
      const context = untrack(() => createWorkflowExecutionContext(createRunId()));
      void assetIdentity;
      for (const reviewNodeId of reviewNodeIds) {
        try {
          await untrack(() => workflow.refreshReviewState(reviewNodeId, context.options));
        } catch {
          // The node remains recoverably stale/unavailable until a current snapshot verifies.
        }
        if (epoch !== reviewVerificationEpoch || boardDestroyed) return;
      }
    })();
  });

  async function previewSelectiveExecution(mode: WorkflowSelectiveRunMode, nodeId: string): Promise<void> {
    invalidateSelectivePreview();
    selectiveTargetNodeId = nodeId;
    selectiveMode = mode;
    if (!providerSelection.ready || !providerSelection.provider) {
      selectiveError = providerSelection.label;
      return;
    }
    const previewEpoch = selectiveUiState.beginPreview();
    if (workflow.storyboardEditing && editor.textEdit) editor.commitActiveText();
    if (storyboardCanvas) persistStoryboard();
    selectiveMessage = 'Preparing selective run preview…';
    const runId = createRunId();
    try {
      const context = createWorkflowExecutionContext(runId);
      selectiveUiState.runOptions = context.options;
      const preflight = await workflow.preflightSelectiveExecution(mode, nodeId, context.options);
      if (!selectiveUiState.isCurrentPreview(previewEpoch)) return;
      selectiveUiState.capture(preflight, context.options);
      selectiveMessage = selectiveExecutionPreviewSummary(preflight.plan.preflight);
    } catch (cause) {
      if (!selectiveUiState.isCurrentPreview(previewEpoch)) return;
      selectiveUiState.runOptions = null;
      selectiveError = (cause as Error)?.message ?? String(cause);
      selectiveMessage = '';
    } finally {
      selectiveUiState.settlePreview(previewEpoch);
    }
  }

  async function confirmSelectiveExecution(): Promise<void> {
    const preflight = selectiveUiState.preflight;
    const options = selectiveUiState.runOptions;
    if (!preflight || !options || !selectiveTargetNodeId) return;
    const availability = selectiveExecutionRunAvailability(preflight.plan.preflight);
    if (!availability.enabled) {
      selectiveError = availability.reason;
      return;
    }
    selectiveUiState.beginRun();
    selectiveRunning = true;
    busy = true;
    selectiveError = '';
    progress = 'Running selective workflow…';
    const task = aiTasks.create({
      projectPath: options.projectPath,
      kind: 'workflow',
      title: `Workflow: ${selectiveMode === 'run-node' ? 'Run this node' : 'Run from here'}`,
      subtitle: options.provider,
      progress,
      detail: {
        kind: 'workflow', providerLabel: options.provider, outputName: 'Selective execution',
      },
    });
    activeWorkflowTaskId = task.id;
    aiTasks.setCancel(task.id, async () => {
      await workflow.cancelSelectiveExecution();
    });
    try {
      const outcome = await workflow.runSelectiveExecution(preflight, options, { maxConcurrency: 1 });
      selectiveUiState.clear();
      selectiveOutcome = outcome;
      selectiveMessage = selectiveExecutionOutcomeSummary(outcome);
      if (outcome.executedNodeIds.length > 0 && options.projectPath) await project.refresh(options.projectPath);
      if (outcome.cancelledNodeIds.length > 0) aiTasks.markCancelled(task.id);
      else if (Object.keys(outcome.failures).length > 0) aiTasks.fail(task.id, selectiveMessage);
      else aiTasks.complete(task.id, selectiveMessage);
      editor.flash(selectiveMessage);
    } catch (cause) {
      selectiveUiState.clear();
      selectiveError = (cause as Error)?.message ?? String(cause);
      if ((cause as { code?: unknown })?.code === 'CANCELLED') aiTasks.markCancelled(task.id);
      else aiTasks.fail(task.id, selectiveError);
    } finally {
      aiTasks.setCancel(task.id, null);
      activeWorkflowTaskId = null;
      busy = false;
      selectiveUiState.settleRun();
      lastSelectiveContextIdentity = selectivePreviewContextIdentity();
      selectiveRunning = false;
      progress = '';
    }
  }

  async function cancelSelectiveExecution(): Promise<void> {
    selectiveMessage = selectiveRunning ? 'Cancelling selective run…' : 'Cancelling preview…';
    if (activeWorkflowTaskId) await aiTasks.cancel(activeWorkflowTaskId);
    else await workflow.cancelSelectiveExecution();
    if (!selectiveRunning) invalidateSelectivePreview();
  }

  async function generate(node: WorkflowOutputNode | undefined = undefined, forceRegenerate = false): Promise<void> {
    if (workflow.storyboardEditing && editor.textEdit) editor.commitActiveText();
    if (storyboardCanvas) persistStoryboard();
    const targetOutput = targetOutputForGenerate(node);
    error = '';
    const preflight = outputReadiness(targetOutput.id);
    if (!preflight.ready) {
      error = preflight.nextAction
        ? `${preflight.nextAction.message} Next: ${preflight.nextAction.action}.`
        : 'Complete the workflow checklist before generating.';
      return;
    }
    if (!providerSelection.ready || !providerSelection.provider) {
      error = 'Wait for native QA mode detection before generating.';
      return;
    }
    const path = resolveWorkflowCampaignPath(workflow.serialize(), { outputNodeId: targetOutput.id });
    const reviewedOutput = Boolean(path?.reviewNodeId);
    busy = true;
    progress = reviewedOutput
      ? 'Verifying promoted Review output…'
      : providerSelection.qaFake
      ? 'Running deterministic QA Fake output…'
      : 'Preparing workflow assets...';
    const runId = createRunId();
    const context = createWorkflowExecutionContext(runId);
    const { runProjectPath, runProvider } = context;
    try {
      activeTransformNodeId = reviewedOutput
        ? null
        : workflow.incoming(targetOutput.id)
          .find((connection) => connection.targetPortId === 'source')?.from ?? null;
      const task = aiTasks.create({
        projectPath: runProjectPath,
        kind: 'workflow',
        title: `Workflow: ${targetOutput.name || 'Generate output'}`,
        subtitle: runProvider,
        progress,
        runId,
        detail: {
          kind: 'workflow', providerLabel: runProvider, outputName: targetOutput.name || 'Output',
        },
      });
      activeWorkflowTaskId = task.id;
      aiTasks.setCancel(task.id, async () => {
        if (reviewedOutput) await workflow.cancelSelectiveExecution();
        else if (activeTransformNodeId) await workflow.cancelCampaignGenerate(activeTransformNodeId);
      });
      if (!reviewedOutput && !forceRegenerate && path?.transformNodeId) {
        aiTasks.setProgress(task.id, 'Checking for reusable output…');
        const reusePreflight = await workflow.preflightSelectiveExecution(
          'run-node', path.transformNodeId, context.options,
        );
        if (reusePreflight.stateByNodeId[path.transformNodeId]?.state === 'cached') {
          const outcome = await workflow.runSelectiveExecution(reusePreflight, context.options, { maxConcurrency: 1 });
          aiTasks.complete(task.id, `Reused verified output · ${selectiveExecutionOutcomeSummary(outcome)}`);
          editor.flash('Reused verified output; no provider request was sent');
          return;
        }
      }
      if (reviewedOutput) {
        const outcome = await workflow.runReviewedOutput(targetOutput.id, context.options);
        const summary = selectiveExecutionOutcomeSummary(outcome);
        aiTasks.complete(task.id, `Promoted Review output ready · ${summary}`);
        editor.flash('Promoted Review output is ready');
        return;
      }
      const outcome = await workflow.runCampaignGenerate(targetOutput.id, context.options);
      if (!outcome.committed) {
        if (project.path === runProjectPath) await project.refresh(runProjectPath);
        error = outcome.commitMessage;
        aiTasks.fail(task.id, error);
        return;
      }
      await project.refresh();
      aiTasks.complete(task.id, 'Workflow generation completed');
      editor.flash(`Generated ${targetOutput.finalWidth} x ${targetOutput.finalHeight}`);
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
      const cancelled = (e as { code?: unknown })?.code === 'CANCELLED';
      if (activeWorkflowTaskId) {
        if (cancelled) aiTasks.markCancelled(activeWorkflowTaskId);
        else aiTasks.fail(activeWorkflowTaskId, error);
      }
      editor.flash(cancelled ? 'Workflow generation cancelled' : 'Workflow generation failed');
    } finally {
      if (activeWorkflowTaskId) aiTasks.setCancel(activeWorkflowTaskId, null);
      busy = false;
      activeTransformNodeId = null;
      activeWorkflowTaskId = null;
      progress = '';
    }
  }

  function outputForTransform(nodeId: string): WorkflowOutputNode | null {
    const outputId = resolveWorkflowCampaignPath(workflow.serialize(), { transformNodeId: nodeId })?.outputNodeId ?? null;
    return outputId ? workflow.outputNode(outputId) ?? null : null;
  }

  function selectedReviewCandidate(nodeId: string) {
    const candidates = workflow.reviewCandidates(nodeId, assets, true, project.identity);
    const selectedId = selectedReviewCandidates[nodeId];
    return candidates.find((candidate) => candidate.candidateId === selectedId) ?? candidates[0] ?? null;
  }

  async function reviewCandidateKeydown(event: KeyboardEvent, nodeId: string): Promise<void> {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const candidates = workflow.reviewCandidates(nodeId, assets, true, project.identity);
    if (candidates.length === 0) return;
    const current = selectedReviewCandidate(nodeId);
    const currentIndex = Math.max(0, candidates.findIndex((candidate) => candidate.candidateId === current?.candidateId));
    const nextIndex = nextWorkflowCandidateIndex(
      event.key as WorkflowCandidateNavigationKey,
      currentIndex,
      candidates.length,
    );
    if (nextIndex === null) return;
    const next = candidates[nextIndex];
    selectedReviewCandidates[nodeId] = next.candidateId;
    await tick();
    document.getElementById(`review-candidate-tab-${nodeId}-${next.candidateId}`)?.focus();
  }

  async function focusReviewCandidates(nodeId?: string): Promise<void> {
    const reviewNode = nodeId
      ? workflow.creatorNodes.find((node) => node.id === nodeId && node.type === 'review')
      : workflow.creatorNodes.find((node) => node.type === 'review' && workflow.reviewCandidates(node.id, assets, true, project.identity).length > 0);
    if (!reviewNode) return;
    workflow.select({ kind: 'creator', id: reviewNode.id });
    await tick();
    const candidate = selectedReviewCandidate(reviewNode.id);
    if (candidate) document.getElementById(`review-candidate-tab-${reviewNode.id}-${candidate.candidateId}`)?.focus();
    else document.getElementById(`review-node-${reviewNode.id}`)?.focus();
  }

  function reviewKeyboardShortcut(event: KeyboardEvent): void {
    if (event.key === 'F7' || (event.altKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyR')) {
      event.preventDefault();
      void focusReviewCandidates();
      return;
    }
    const dedicatedPromote = event.key === 'F8';
    const modifiedPromote = event.ctrlKey && !event.altKey && !event.metaKey && (event.code === 'Enter' || event.code === 'NumpadEnter');
    if (!dedicatedPromote && !modifiedPromote) return;
    const selection = workflow.selection;
    if (selection?.kind !== 'creator') return;
    const node = workflow.creatorNodes.find((candidate) => candidate.id === selection.id);
    if (node?.type !== 'review' || selectedReviewCandidate(node.id)?.state !== 'eligible') return;
    event.preventDefault();
    void promoteReviewCandidate(node.id);
  }

  async function promoteReviewCandidate(nodeId: string): Promise<void> {
    const candidate = selectedReviewCandidate(nodeId);
    if (!candidate || candidate.state !== 'eligible') return;
    busy = true;
    error = '';
    const context = createWorkflowExecutionContext(
      createRunId(),
      workflowCandidateProgressLabel,
    );
    try {
      await workflow.promoteCandidate(nodeId, candidate.candidateId, context.options);
      editor.flash(`Promoted Candidate ${candidate.ordinal}`);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Candidate promotion failed.';
    } finally {
      busy = false;
    }
  }

  async function generateCandidateBranches(nodeId: string): Promise<void> {
    const output = outputForTransform(nodeId);
    if (!output) {
      error = 'Connect this Transform to an Output before generating candidate branches.';
      return;
    }
    if (!providerSelection.ready || !providerSelection.provider) {
      error = 'Wait for native QA mode detection before generating candidate branches.';
      return;
    }
    busy = true;
    error = '';
    progress = `Generating ${candidateCount} independent candidates…`;
    const controller = new AbortController();
    activeCandidateController = controller;
    const context = createWorkflowExecutionContext(createRunId());
    try {
      const outcome = await workflow.runCandidateBranches(output.id, {
        ...context.options,
        signal: controller.signal,
      }, {
        branchGroupId: `branch-${createRunId()}`,
        count: candidateCount,
        maxConcurrency: Math.min(candidateConcurrency, candidateCount),
      });
      if (!outcome.committed) {
        if (context.runProjectPath && project.path === context.runProjectPath) await project.refresh(context.runProjectPath);
        error = outcome.commitMessage;
      } else {
        if (context.runProjectPath) await project.refresh(context.runProjectPath);
        candidateResultMessages[nodeId] = workflowCandidateBranchResultSummary(outcome.group);
        editor.flash(outcome.commitMessage);
      }
    } catch (cause) {
      error = (cause as Error)?.message ?? String(cause);
    } finally {
      if (activeCandidateController === controller) activeCandidateController = null;
      busy = false;
      progress = '';
    }
  }

  async function retryCandidate(candidateId: string): Promise<void> {
    if (!providerSelection.ready || !providerSelection.provider) return;
    busy = true;
    error = '';
    progress = 'Retrying one candidate while preserving its siblings…';
    const controller = new AbortController();
    activeCandidateController = controller;
    const context = createWorkflowExecutionContext(createRunId());
    try {
      const outcome = await workflow.retryCandidateBranch(candidateId, {
        ...context.options,
        signal: controller.signal,
      });
      if (!outcome.committed) {
        if (context.runProjectPath && project.path === context.runProjectPath) await project.refresh(context.runProjectPath);
        error = outcome.commitMessage;
      } else {
        if (context.runProjectPath) await project.refresh(context.runProjectPath);
        editor.flash(outcome.commitMessage);
      }
    } catch (cause) {
      error = (cause as Error)?.message ?? String(cause);
    } finally {
      if (activeCandidateController === controller) activeCandidateController = null;
      busy = false;
      progress = '';
    }
  }

  async function cancelGenerate(): Promise<void> {
    if (activeCandidateController) {
      progress = 'Cancelling candidate branches…';
      activeCandidateController.abort();
      return;
    }
    if (activeWorkflowTaskId) {
      await aiTasks.cancel(activeWorkflowTaskId);
      return;
    }
    if (!activeTransformNodeId) return;
    progress = 'Cancelling…';
    await workflow.cancelCampaignGenerate(activeTransformNodeId);
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (event.key === 'Alt') altDown = true;
    reviewKeyboardShortcut(event);
  }}
  onkeyup={(event) => {
    if (event.key === 'Alt') altDown = false;
  }}
  onblur={() => (altDown = false)}
/>

<section class="workflow-shell">
  <div class="workflow-main">
    <aside class="asset-tray">
      <div class="tray-head node-library">
        <span>Nodes</span>
        <div class="tray-head-actions">
          {#if qaModeResolved && (qaMode === 'provider-free' || desktop)}
            <button
              type="button"
              aria-label="Revise current workflow"
              aria-haspopup="dialog"
              use:tooltip={{
                text: `Revise current workflow · ${qaMode === 'provider-free' ? 'QA Fake' : runOptions.directorProvider}`,
                placement: 'right',
              }}
              onclick={openRevisionDirector}
            >
              <Icon svg={ArrowSync} size={14} />
            </button>
          {/if}
          <button
            type="button"
            aria-label="Draft with AI Director"
            aria-haspopup="dialog"
            use:tooltip={{ text: 'Draft with AI Director', placement: 'right' }}
            onclick={() => (directorOpen = true)}
          >
            <Icon svg={Sparkle} size={14} />
          </button>
          <button
            bind:this={paletteButton}
            type="button"
            aria-label="Add workflow node"
            aria-haspopup="dialog"
            aria-expanded={paletteOpen}
            use:tooltip={{ text: 'Add workflow node', placement: 'right' }}
            onclick={() => (paletteOpen = !paletteOpen)}
          >
            <Icon svg={Add} size={14} />
          </button>
        </div>
      </div>
      {#if paletteOpen}
        <WorkflowNodePalette
          onAdd={(type) => void addCreatorNodeFromPalette(type)}
          onClose={() => void closeNodePalette()}
        />
      {/if}
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
              class:brief={item.kind === 'brief'}
              class:composition={item.kind === 'composition'}
              class:creator={item.kind === 'creator'}
              class:output={item.kind === 'output'}
              class:unsupported={item.kind === 'unsupported'}
              class:included={item.included}
              style={mapRectStyle(item, workflowMapModel)}
            ></span>
          {/each}
          <span class="map-viewport" style={mapRectStyle(workflowMapModel.viewport, workflowMapModel)}></span>
        </button>
        <div class="map-meta">
          <span>{workflow.nodes.length + workflow.briefNodes.length + workflow.creatorNodes.length + workflow.unsupportedNodes.length + 1 + workflow.outputNodes.length} nodes</span>
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
      tabindex="-1"
      data-workflow-board
      bind:this={boardEl}
      style={`background-position:${workflow.panX + overscrollX}px ${workflow.panY + overscrollY}px; background-size:${24 * workflow.zoom}px ${24 * workflow.zoom}px`}
      onpointerdown={onBoardPointerDown}
      onpointerleave={onPointerLeave}
      onpointermove={onPointerMove}
      onpointerup={stopDrag}
      onpointercancel={stopDrag}
    >
      {#if workflow.connectionError}
        <p class="connection-error" role="status" aria-live="polite">{workflow.connectionError}</p>
      {/if}
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
          {@const ports = workflowNodePorts(node.id)}
          <article
            class="asset-node"
            class:included={node.included}
            class:selected={workflow.selection?.kind === 'asset' && workflow.selection.id === node.id}
            tabindex="-1"
            data-workflow-node={node.id}
            data-creator-node-type="input"
            style={`transform:translate(${node.x}px, ${node.y}px); width:${node.width}px; height:${node.height}px; --node-color:${node.color}; --port-y:${node.height / 2}px`}
            onfocus={() => workflow.select({ kind: 'asset', id: node.id })}
            onpointerdown={(event) => {
              workflow.select({ kind: 'asset', id: node.id });
              event.stopPropagation();
            }}
          >
            <WorkflowNodePorts
              title={node.name}
              height={node.height}
              inputs={ports.inputs}
              outputs={ports.outputs}
              onStart={(event, portId) => startConnection(event, node.id, portId)}
              onFinish={(event, portId) => finishConnection(event, node.id, portId)}
            />
            <div class="node-head">
              <span class="node-drag-region" use:dragHandle={{ type: 'asset', node }}>
                {assetTitle(node)}
                {#if node.slotId}<small class:required={node.required}>{node.required ? 'Required' : 'Optional'}</small>{/if}
              </span>
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
            <WorkflowNodePreflight entry={preflightForNode(node.id)} />
            <div class="specialized-node-body asset-node-body">
              <div class="node-preview" style={`height:${Math.max(64, node.height - 150)}px`}>
                {#if asset?.previewDataUrl}<img class="preview-image" src={asset.previewDataUrl} alt="" />{:else}<Icon svg={Image} size={28} />{/if}
              </div>
              <label class="slot-picker" onpointerdown={(event) => event.stopPropagation()}>
                <span>{node.slotId ? (node.required ? 'Required asset' : 'Optional asset') : 'Project asset'}</span>
                <select
                  aria-label={`Asset for ${node.name}`}
                  data-workflow-required-slot={node.required ? '' : undefined}
                  value={asset?.id ?? ''}
                  oninput={(event) => workflow.assignAsset(
                    node.id,
                    assets.find((item) => item.id === event.currentTarget.value) ?? null,
                  )}
                >
                  <option value="">Choose from project…</option>
                  {#each assets as option (option.id)}<option value={option.id}>{option.name}</option>{/each}
                </select>
                <small aria-live="polite">{asset ? `Selected ${asset.name}` : 'No asset selected'}</small>
              </label>
              <textarea
                aria-label={`Role for ${node.name}`}
                placeholder={node.guidance || 'role in composition'}
                value={node.note}
                onpointerdown={(event) => event.stopPropagation()}
                oninput={(event) => node.creatorInput
                  ? workflow.configureCreatorNode(node.id, { role: event.currentTarget.value })
                  : workflow.setNodeNote(node.id, event.currentTarget.value)}
              ></textarea>
            </div>
          </article>
        {/each}

        {#each workflow.briefNodes as brief (brief.id)}
          {@const ports = workflowNodePorts(brief.id)}
          <article
            class="brief-node"
            class:selected={workflow.selection?.kind === 'creator' && workflow.selection.id === brief.id}
            tabindex="-1"
            data-workflow-node={brief.id}
            data-creator-node-type="brief"
            style={`transform:translate(${brief.x}px, ${brief.y}px); width:${brief.width}px; height:${brief.height}px; --node-color:${brief.color}; --port-y:${brief.height / 2}px`}
            onfocus={() => workflow.select({ kind: 'creator', id: brief.id })}
            onpointerdown={(event) => {
              workflow.select({ kind: 'creator', id: brief.id });
              event.stopPropagation();
            }}
          >
            <WorkflowNodePorts
              title={brief.name}
              height={brief.height}
              inputs={ports.inputs}
              outputs={ports.outputs}
              onStart={(event, portId) => startConnection(event, brief.id, portId)}
              onFinish={(event, portId) => finishConnection(event, brief.id, portId)}
            />
            <div class="node-head">
              <span class="node-drag-region" use:dragHandle={{ type: 'creator', node: brief }}>{brief.name}</span>
              <small>{briefCreatorDefinition.label}</small>
            </div>
            <WorkflowNodePreflight entry={preflightForNode(brief.id)} />
            <div class="specialized-node-body brief-node-body">
              <p>{brief.guidance}</p>
              <textarea
                aria-label={`${brief.name} objective`}
                placeholder="Outcome, audience, and non-negotiables…"
                value={brief.objective}
                oninput={(event) => workflow.setBriefObjective(brief.id, event.currentTarget.value)}
              ></textarea>
            </div>
          </article>
        {/each}

        {#each workflow.creatorNodes as node (node.id)}
          {@const definition = creatorNodeDefinition(node.type)}
          {@const transformRunState = workflow.transformExecution(node.id)}
          {@const acceptedEditorResult = workflow.acceptedEditorResult(node.id)}
          <article
            class="creator-node"
            class:selected={workflow.selection?.kind === 'creator' && workflow.selection.id === node.id}
            tabindex="-1"
            id={node.type === 'review' ? `review-node-${node.id}` : undefined}
            data-workflow-node={node.id}
            data-creator-node-type={node.type}
            style={`transform:translate(${node.x}px, ${node.y}px); width:${node.width}px; height:${node.height}px; --node-color:${node.color}; --port-y:${node.height / 2}px`}
            onfocus={() => workflow.select({ kind: 'creator', id: node.id })}
            onpointerdown={(event) => {
              workflow.select({ kind: 'creator', id: node.id });
              event.stopPropagation();
            }}
          >
            <WorkflowNodePorts
              title={node.name}
              height={node.height}
              inputs={node.ports.inputs}
              outputs={node.ports.outputs}
              onStart={(event, portId) => startConnection(event, node.id, portId)}
              onFinish={(event, portId) => finishConnection(event, node.id, portId)}
            />
            <div class="node-head">
              <span class="node-drag-region" use:dragHandle={{ type: 'creator', node }}>
                {node.name}
                <small>{definition.label}</small>
              </span>
              <div class="node-tools">
                <button
                  type="button"
                  aria-label={`Remove ${node.name}`}
                  use:tooltip={{ text: 'Remove node', placement: 'top' }}
                  onpointerdown={(event) => event.stopPropagation()}
                  onclick={(event) => {
                    event.stopPropagation();
                    workflow.removeNode(node.id);
                  }}
                ><Icon svg={Delete} size={13} /></button>
              </div>
            </div>
            <WorkflowNodePreflight entry={preflightForNode(node.id)} />
            <div class="creator-node-body">
              <p>{definition.description}</p>
              {#if node.type === 'art-direction'}
                <label class="creator-config-field">
                  Direction prompt
                  <textarea
                    aria-label={`${node.name} direction prompt`}
                    value={creatorConfigString(node.config, 'prompt')}
                    oninput={(event) => workflow.configureCreatorNode(node.id, { prompt: event.currentTarget.value })}
                  ></textarea>
                </label>
              {:else if node.type === 'transform'}
                <label class="creator-config-field">
                  Capability
                  <select
                    aria-label={`${node.name} capability`}
                    value={creatorConfigString(node.config, 'capability')}
                    onchange={(event) => workflow.configureCreatorNode(node.id, { capability: event.currentTarget.value })}
                  >
                    <option value="generate">Generate</option>
                    <option value="edit">Edit</option>
                    <option value="remove-background">Remove background</option>
                    <option value="relight">Relight</option>
                    <option value="upscale">Upscale</option>
                  </select>
                </label>
                <label class="creator-config-field">
                  Instructions
                  <textarea
                    aria-label={`${node.name} instructions`}
                    value={creatorConfigString(node.config, 'instructions')}
                    oninput={(event) => workflow.configureCreatorNode(node.id, { instructions: event.currentTarget.value })}
                  ></textarea>
                </label>
              {:else if node.type === 'review'}
                <label class="creator-config-field">
                  Review mode
                  <select
                    aria-label={`${node.name} review mode`}
                    value={creatorConfigString(node.config, 'mode')}
                    onchange={(event) => workflow.configureCreatorNode(node.id, { mode: event.currentTarget.value })}
                  >
                    <option value="human">Human review</option>
                    <option value="ai">AI-assisted review (draft)</option>
                  </select>
                </label>
                <label class="creator-config-field">
                  Review instructions
                  <textarea
                    aria-label={`${node.name} review instructions`}
                    value={creatorConfigString(node.config, 'instructions')}
                    oninput={(event) => workflow.configureCreatorNode(node.id, { instructions: event.currentTarget.value })}
                  ></textarea>
                </label>
                {@const reviewCandidates = workflow.reviewCandidates(node.id, assets, true, project.identity)}
                {@const reviewCandidate = selectedReviewCandidate(node.id)}
                {@const reviewResolution = workflow.reviewResolution(node.id, assets, true, project.identity)}
                <section class="review-compare" aria-label={`${node.name} candidate comparison`}>
                  <p class="review-keyboard-hint">Keyboard: F7 focuses candidates; F8 promotes the selected eligible candidate. Alt+R and Ctrl+Enter are also available.</p>
                  <button
                    type="button"
                    aria-keyshortcuts="F7 Alt+R"
                    onclick={() => void focusReviewCandidates(node.id)}
                  >Focus candidate review</button>
                  <p class="review-resolution" data-review-state={reviewResolution.state}>
                    {reviewResolution.state === 'ready'
                      ? `Promoted Candidate ${reviewCandidates.find((candidate) => candidate.candidateId === reviewResolution.promotion.candidateId)?.ordinal ?? ''}`
                      : reviewResolution.reason.message}
                  </p>
                  {#if reviewResolution.state === 'ready'}
                    <button
                      type="button"
                      disabled={busy}
                      onclick={() => void openResultInEditor({
                        nodeId: reviewResolution.promotion.sourceNodeId,
                        rootRunId: reviewResolution.promotion.candidateRunId,
                        assetReferenceId: reviewResolution.promotion.assetReferenceId,
                        promotionId: reviewResolution.promotion.id,
                      })}
                    >Open promoted result in Editor</button>
                  {/if}
                  <div
                    class="review-candidate-tabs"
                    role="tablist"
                    tabindex="-1"
                    aria-label="Concept candidates"
                    onkeydown={(event) => void reviewCandidateKeydown(event, node.id)}
                  >
                    {#each reviewCandidates as candidate (candidate.candidateId)}
                      <button
                        type="button"
                        role="tab"
                        id={`review-candidate-tab-${node.id}-${candidate.candidateId}`}
                        aria-controls={`review-candidate-panel-${node.id}`}
                        aria-selected={candidate.candidateId === reviewCandidate?.candidateId}
                        tabindex={candidate.candidateId === reviewCandidate?.candidateId ? 0 : -1}
                        data-candidate-state={candidate.state}
                        onclick={() => { selectedReviewCandidates[node.id] = candidate.candidateId; }}
                      >Candidate {candidate.ordinal} · {candidate.state}</button>
                    {/each}
                  </div>
                  {#if reviewCandidate}
                    {@const reviewAsset = assets.find((item) => item.id === reviewCandidate.output?.assetId)}
                    <div
                      class="review-candidate-context"
                      role="tabpanel"
                      id={`review-candidate-panel-${node.id}`}
                      aria-labelledby={`review-candidate-tab-${node.id}-${reviewCandidate.candidateId}`}
                      tabindex="0"
                    >
                      {#if reviewAsset?.previewDataUrl}
                        <img class="review-candidate-preview" src={reviewAsset.previewDataUrl} alt={`Candidate ${reviewCandidate.ordinal} preview`} />
                      {/if}
                      <p><strong>Brief</strong> {reviewCandidate.brief || 'No brief recorded.'}</p>
                      <p><strong>Art direction</strong> {reviewCandidate.artDirection || 'No art direction recorded.'}</p>
                      <small>
                        Provenance: {reviewCandidate.providerId}{reviewCandidate.model ? ` / ${reviewCandidate.model}` : ''}
                        · {reviewCandidate.sourceAssetIds.length} sources · run {reviewCandidate.latestRunId}
                      </small>
                      {#if reviewCandidate.failure}<p>{reviewCandidate.failure.message}</p>{/if}
                      <button
                        type="button"
                        aria-keyshortcuts="F8 Control+Enter"
                        disabled={busy || reviewCandidate.state !== 'eligible'}
                        onclick={() => void promoteReviewCandidate(node.id)}
                      >Promote this candidate</button>
                      {#if reviewCandidate.state !== 'eligible'}
                        <small>Resolve this candidate’s {reviewCandidate.state} state before promotion.</small>
                      {/if}
                    </div>
                  {:else}
                    <p class="draft-reason">Generate concept branches upstream to compare and promote them here.</p>
                  {/if}
                </section>
              {/if}
              {#if node.ports.inputs.length > 0}
                <div class="creator-port-list">
                  <b>Inputs</b>
                  {#each node.ports.inputs as port (port.id)}
                    <span>{port.label}<small>{port.dataType}{port.required ? ' · required' : ''}{port.multiple ? ' · multiple' : ''}</small></span>
                  {/each}
                </div>
              {/if}
              {#if node.ports.outputs.length > 0}
                <div class="creator-port-list">
                  <b>Outputs</b>
                  {#each node.ports.outputs as port (port.id)}
                    <span>{port.label}<small>{port.dataType}{port.multiple ? ' · multiple' : ''}</small></span>
                  {/each}
                </div>
              {/if}
              {#if node.type === 'transform' && definition.executor.status === 'available' && creatorConfigString(node.config, 'capability') === 'generate'}
                {#if acceptedEditorResult}
                  <button
                    type="button"
                    disabled={busy}
                    onclick={() => void openResultInEditor(acceptedEditorResult)}
                  >Open accepted result in Editor</button>
                {/if}
                {@const branchGroups = workflow.candidateBranchGroups(node.id)}
                {#if selectiveRunning && ['queued', 'running', 'cancelling'].includes(transformRunState.state)}
                  <p
                    class="selective-running-state"
                    data-workflow-selective-running-state={transformRunState.state}
                    aria-live="polite"
                  ><strong>{transformRunState.state}</strong> {transformRunState.message}</p>
                {/if}
                <div class="selective-node-actions" role="group" aria-label="Preview selective run">
                  <button
                    type="button"
                    disabled={busy || selectiveUiState.busy || !providerSelection.ready}
                    aria-describedby={`selective-action-reason-${node.id}`}
                    onclick={() => void previewSelectiveExecution('run-node', node.id)}
                  >Run this node</button>
                  <button
                    type="button"
                    disabled={busy || selectiveUiState.busy || !providerSelection.ready}
                    aria-describedby={`selective-action-reason-${node.id}`}
                    onclick={() => void previewSelectiveExecution('run-from-here', node.id)}
                  >Run from here</button>
                </div>
                <p class="transform-run-state" id={`selective-action-reason-${node.id}`}>
                  {providerSelection.ready
                    ? 'Preview planned, cached, blocked, and stale nodes before anything executes.'
                    : providerSelection.label}
                </p>
                {#if selectiveTargetNodeId === node.id}
                  <div class="selective-preview" aria-label="Confirm selective run" aria-live="polite">
                    <strong>{selectiveMode === 'run-node' ? 'Run this node' : 'Run from here'} preview</strong>
                    {#if selectiveMessage}<p>{selectiveMessage}</p>{/if}
                    {#if selectiveError}<p class="selective-error">{selectiveError}</p>{/if}
                    {#if selectiveUiState.preflight}
                      {@const runAvailability = selectiveExecutionRunAvailability(selectiveUiState.preflight.plan.preflight)}
                      <div class="selective-preview-actions">
                        <button
                          type="button"
                          disabled={selectiveUiState.busy || !runAvailability.enabled}
                          aria-describedby={`selective-run-reason-${node.id}`}
                          onclick={() => void confirmSelectiveExecution()}
                        >Confirm selective run</button>
                        <button type="button" onclick={() => void cancelSelectiveExecution()}>Cancel</button>
                      </div>
                      <p id={`selective-run-reason-${node.id}`}>{runAvailability.reason}</p>
                    {:else if selectiveUiState.busy}
                      <button type="button" onclick={() => void cancelSelectiveExecution()}>Cancel</button>
                    {:else if selectiveOutcome}
                      <button type="button" onclick={invalidateSelectivePreview}>Dismiss</button>
                    {/if}
                  </div>
                {/if}
                <section class="candidate-branches" aria-label={`${node.name} concept branches`} aria-live="polite">
                  <div class="candidate-branch-head">
                    <strong>Concept branches</strong>
                    <span>{branchGroups.reduce((total, group) => total + group.candidates.length, 0)} candidates</span>
                  </div>
                  {#if candidateResultMessages[node.id]}
                    <p class="candidate-result-summary" aria-live="polite">{candidateResultMessages[node.id]}</p>
                  {/if}
                  <div class="candidate-branch-controls" role="group" aria-label="Generate concept branches">
                    <label>
                      <span>Count</span>
                      <select bind:value={candidateCount} disabled={busy} aria-label="Candidate count">
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                        <option value={4}>4</option>
                      </select>
                    </label>
                    <label>
                      <span>Parallel</span>
                      <select bind:value={candidateConcurrency} disabled={busy} aria-label="Candidate concurrency">
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                      </select>
                    </label>
                    <button
                      type="button"
                      disabled={busy || !providerSelection.ready || !outputForTransform(node.id)}
                      onclick={() => void generateCandidateBranches(node.id)}
                    >Generate branches</button>
                  </div>
                  {#each branchGroups as group (group.id)}
                    <div class="candidate-group">
                      <p><strong>{group.candidates.length} branches</strong> from {group.sourceNodeId}</p>
                      <ol>
                        {#each group.candidates as candidate (candidate.candidateId)}
                          <li data-candidate-state={candidate.status}>
                            <span><b>Candidate {candidate.ordinal}</b> · {candidate.status}</span>
                            <small>
                              Lineage: {candidate.sourceAssetIds.length} sources · material {candidate.materialKey.slice(-10)} · run {candidate.latestRunId}
                            </small>
                            {#if candidate.failure}<small>{candidate.failure.message}</small>{/if}
                            {#if candidate.status === 'failed' || candidate.status === 'cancelled'}
                              <button type="button" disabled={busy} onclick={() => void retryCandidate(candidate.candidateId)}>
                                Retry candidate
                              </button>
                            {/if}
                          </li>
                        {/each}
                      </ol>
                    </div>
                  {/each}
                </section>
              {:else if node.type === 'transform' && definition.executor.status === 'available'}
                <p class="draft-reason" id={`draft-reason-${node.id}`}>
                  Only the Generate capability is executable in this slice. Configure this Transform as Generate to run it.
                </p>
                <button type="button" class="draft-run" disabled aria-describedby={`draft-reason-${node.id}`}>Run unavailable</button>
              {/if}
              {#if definition.executor.status === 'draft-only' && node.type !== 'review'}
                <p class="draft-reason" id={`draft-reason-${node.id}`}>{definition.executor.reason}</p>
                <button type="button" class="draft-run" disabled aria-describedby={`draft-reason-${node.id}`}>Run unavailable</button>
              {/if}
            </div>
          </article>
        {/each}

        {#each workflow.unsupportedNodes as node (node.id)}
          <article
            class="unsupported-node"
            class:selected={workflow.selection?.kind === 'unsupported' && workflow.selection.id === node.id}
            tabindex="-1"
            data-workflow-node={node.id}
            data-unsupported-node-type={node.unsupportedType}
            style={`transform:translate(${node.x}px, ${node.y}px); width:${node.width}px; height:${node.height}px; --node-color:${node.color}`}
            onfocus={() => workflow.select({ kind: 'unsupported', id: node.id })}
            onpointerdown={(event) => {
              workflow.select({ kind: 'unsupported', id: node.id });
              event.stopPropagation();
            }}
          >
            <div class="node-head">
              <span class="node-drag-region" use:dragHandle={{ type: 'unsupported', node }}>{node.name}</span>
              <small>Unsupported</small>
            </div>
            <WorkflowNodePreflight entry={preflightForNode(node.id)} />
            <div class="creator-node-body">
              <p>This “{node.unsupportedType}” node is preserved for a compatible future PaintNode version.</p>
              {#if node.ports.inputs.length + node.ports.outputs.length > 0}
                <div class="creator-port-list">
                  <b>Preserved ports</b>
                  {#each [...node.ports.inputs, ...node.ports.outputs] as port}
                    <span>{port.label}<small>{port.dataType}</small></span>
                  {/each}
                </div>
              {/if}
              <p class="draft-reason" id={`unsupported-reason-${node.id}`}>PaintNode cannot safely connect or execute this node yet. Its raw payload will be saved unchanged.</p>
              <button type="button" class="draft-run" disabled aria-describedby={`unsupported-reason-${node.id}`}>Run unavailable</button>
            </div>
          </article>
        {/each}

        <article
          class="prompt-node"
          class:selected={workflow.selection?.kind === 'composition'}
          tabindex="-1"
          data-workflow-node="composition"
          data-creator-node-type="art-direction"
          style={`transform:translate(${workflow.promptX}px, ${workflow.promptY}px); width:${workflow.compositionWidth}px; --node-color:${workflow.compositionColor}; --port-y:${workflow.compositionHeight / 2}px`}
          onfocus={() => workflow.select({ kind: 'composition' })}
          onpointerdown={(event) => {
            workflow.select({ kind: 'composition' });
            event.stopPropagation();
          }}
        >
          <WorkflowNodePorts
            title={compositionTitle()}
            height={workflow.compositionHeight}
            inputs={workflowNodePorts('composition').inputs}
            outputs={workflowNodePorts('composition').outputs}
            onStart={(event, portId) => startConnection(event, 'composition', portId)}
            onFinish={(event, portId) => finishConnection(event, 'composition', portId)}
          />
          <div class="node-head">
            <span class="node-drag-region" use:dragHandle={{ type: 'prompt' }}>{compositionTitle()}</span>
            <div class="node-tools">
              <span class="connected-count">{workflow.incoming('composition').length} in / {workflow.outgoing('composition').length} out</span>
            </div>
          </div>
          <WorkflowNodePreflight entry={preflightForNode('composition')} />
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
          {#if !providerSelection.qaFake && imageProvider === 'antigravity'}
            <label>
              <span>Antigravity auth helper</span>
              <input bind:value={runOptions.antigravityBin} placeholder="agy or full path" />
            </label>
          {/if}
          <div class="composition-ai-options" role="presentation" onpointerdown={(event) => event.stopPropagation()}>
            {#if providerSelection.qaFake}
              <div class="qa-fake-banner">
                <div role="status">
                  <strong>QA Fake</strong>
                  <span>Deterministic provider-free output. No AI provider or authentication is used.</span>
                </div>
                <label>
                  <span>Native QA scenario</span>
                  <select
                    aria-label="QA Fake scenario"
                    disabled={busy || selectiveUiState.busy}
                    value={qaScenario}
                    onchange={(event) => (qaScenario = event.currentTarget.value as ProviderFreeQaScenario)}
                  >
                    <option value="success">Standard checkpoint</option>
                    <option value="slow-success">Slow / cancellable</option>
                    <option value="failure">Failure / retry</option>
                    <option value="branch-one-failure">Branch recovery checkpoint</option>
                    <option value="format-recovery-checkpoint">Format recovery checkpoint</option>
                  </select>
                </label>
              </div>
            {:else}
              <AiRunOptionsControl bind:options={runOptions} disabled={busy || selectiveUiState.busy || !providerSelection.ready} />
            {/if}
          </div>
          <div class="readiness-checklist" role="group" aria-label="Generate checklist" tabindex="-1" data-workflow-checklist onpointerdown={(event) => event.stopPropagation()}>
            <div class="checklist-head">
              <strong>Before Generate</strong>
              <span>{readiness.ready ? 'Ready' : `${readiness.items.filter((item) => item.status === 'blocked').length} actions left`}</span>
            </div>
            {#each readiness.items as item (item.code)}
              <div class:blocked={item.status === 'blocked'} class="checklist-item">
                <Icon svg={item.status === 'complete' ? CheckmarkCircle : ErrorCircle} size={13} />
                <span><b>{item.label}</b><small>{item.message}</small></span>
                {#if item.code === 'project-folder' && item.status === 'blocked' && desktop}
                  <button type="button" onclick={(event) => void chooseProjectFolder(event.currentTarget)}>Choose folder…</button>
                {/if}
              </div>
            {/each}
          </div>
          {#if busy}
            <p class="progress">
              {progress}
              <button type="button" onclick={() => void cancelGenerate()}>Cancel</button>
            </p>
          {/if}
          {#if error}<p class="err">{error}</p>{/if}
        </article>

        {#each workflow.outputNodes as outputNode (outputNode.id)}
          {@const outputAsset = outputAssetFor(outputNode)}
          {@const ports = workflowNodePorts(outputNode.id)}
          {@const targetReadiness = outputReadiness(outputNode.id)}
          {@const reviewedOutput = Boolean(resolveWorkflowCampaignPath(workflow.serialize(), { outputNodeId: outputNode.id })?.reviewNodeId)}
          <article
            class="output-node"
            class:selected={workflow.selection?.kind === 'output' && workflow.selection.id === outputNode.id}
            tabindex="-1"
            data-workflow-node={outputNode.id}
            data-creator-node-type="output"
            style={`transform:translate(${outputNode.x}px, ${outputNode.y}px); width:${outputNode.width}px; height:${outputNode.height}px; --node-color:${outputNode.color}; --port-y:${outputNode.height / 2}px`}
            onfocus={() => workflow.select({ kind: 'output', id: outputNode.id })}
            onpointerdown={(event) => {
              workflow.select({ kind: 'output', id: outputNode.id });
              event.stopPropagation();
            }}
          >
            <WorkflowNodePorts
              title={outputTitle(outputNode)}
              height={outputNode.height}
              inputs={ports.inputs}
              outputs={ports.outputs}
              onStart={(event, portId) => startConnection(event, outputNode.id, portId)}
              onFinish={(event, portId) => finishConnection(event, outputNode.id, portId)}
            />
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
            <WorkflowNodePreflight entry={preflightForNode(outputNode.id)} />
            <div class="specialized-node-body output-node-body">
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
                <button onclick={() => void generate(outputNode)} disabled={busy || selectiveUiState.busy || !targetReadiness.ready} aria-describedby={`generate-block-${outputNode.id}`}>
                  <Icon svg={PaintBrush} size={14} />
                  {reviewedOutput ? 'Use promoted' : outputAsset ? 'Reuse or update' : providerSelection.qaFake ? 'Generate QA Fake' : 'Generate'}
                </button>
                {#if !reviewedOutput && outputAsset}
                  <button onclick={() => void generate(outputNode, true)} disabled={busy || selectiveUiState.busy || !targetReadiness.ready}>
                    <Icon svg={ArrowSync} size={14} /> Regenerate
                  </button>
                {/if}
                <button onclick={() => void placeOutput(outputNode)} disabled={!outputAsset}>
                  <Icon svg={Open} size={14} />
                  Place
                </button>
              </div>
              {#if !targetReadiness.ready && targetReadiness.nextAction}
                <p class="generate-block" id={`generate-block-${outputNode.id}`}>
                  {targetReadiness.nextAction.action}
                </p>
              {/if}
            </div>
          </article>
        {/each}
      </div>
    </div>
  </div>
</section>

{#if directorOpen}
  <WorkflowDirectorDialog
    {assets}
    {runOptions}
    {desktop}
    {qaMode}
    {qaModeResolved}
    imageCapabilityAvailable={providerSelection.ready}
    imageCapabilityReason={providerSelection.ready ? null : providerSelection.label}
    onClose={() => (directorOpen = false)}
  />
{/if}

{#if revisionDirectorOpen && revisionDirectorRequester}
  <WorkflowDirectorRevisionDialog
    requester={revisionDirectorRequester}
    onClose={() => {
      revisionDirectorOpen = false;
      revisionDirectorRequester = null;
    }}
  />
{/if}

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
    position: relative;
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
  .tray-head-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .workflows {
    border-top: 1px solid var(--border);
  }
  .node-library {
    border-bottom: 1px solid var(--border);
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
  .map-node.brief {
    background: color-mix(in srgb, #a77ad1 30%, #4b4d52);
    border-color: color-mix(in srgb, #a77ad1 68%, #65686f);
  }
  .map-node.creator {
    background: color-mix(in srgb, #59a2c8 28%, #4b4d52);
    border-color: color-mix(in srgb, #59a2c8 64%, #65686f);
  }
  .map-node.unsupported {
    border-style: dashed;
    background: color-mix(in srgb, #d08b67 22%, #4b4d52);
    border-color: color-mix(in srgb, #d08b67 65%, #65686f);
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
  .brief-node,
  .creator-node,
  .unsupported-node,
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
  .brief-node {
    width: 245px;
  }
  .creator-node {
    width: 240px;
  }
  .asset-node,
  .brief-node,
  .creator-node,
  .unsupported-node,
  .output-node {
    display: flex;
    flex-direction: column;
  }
  .unsupported-node {
    width: 240px;
    border-style: dashed;
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
  .brief-node.selected,
  .brief-node:focus-within,
  .creator-node.selected,
  .unsupported-node.selected,
  .prompt-node.selected,
  .output-node.selected {
    border-color: var(--accent);
    box-shadow:
      0 0 0 1px color-mix(in srgb, var(--accent) 72%, transparent),
      0 12px 30px rgba(0, 0, 0, 0.28);
  }
  .node-head {
    flex: none;
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
  .node-drag-region small,
  .brief-node .node-head small,
  .creator-node .node-head small,
  .unsupported-node .node-head small {
    margin-left: 7px;
    color: var(--text-dim);
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .node-drag-region small.required {
    color: #ffd38a;
  }
  .node-drag-region:active {
    cursor: grabbing;
  }
  .connection-error {
    position: absolute;
    top: 10px;
    left: 50%;
    z-index: 20;
    max-width: min(520px, calc(100% - 32px));
    margin: 0;
    padding: 6px 9px;
    border: 1px solid color-mix(in srgb, #ffb0b0 45%, var(--border));
    border-radius: 4px;
    background: color-mix(in srgb, #3b2527 92%, transparent);
    color: #ffcccc;
    font-size: 11px;
    line-height: 1.35;
    transform: translateX(-50%);
    pointer-events: none;
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
  .brief-node textarea,
  .prompt-node textarea {
    width: 100%;
    min-height: 52px;
    border: none;
    border-top: 1px solid #4b4d52;
    border-radius: 0;
    resize: vertical;
    background: #242528;
  }
  .slot-picker {
    display: grid;
    gap: 4px;
    padding: 7px 8px;
    border-top: 1px solid #4b4d52;
    background: #292a2e;
    color: var(--text-dim);
    font-size: 10px;
  }
  .slot-picker select {
    width: 100%;
    min-width: 0;
    height: 25px;
    font-size: 11px;
  }
  .brief-node p {
    margin: 0;
    padding: 9px 9px 5px;
    color: var(--text-dim);
    font-size: 10px;
    line-height: 1.35;
  }
  .creator-node-body {
    display: grid;
    flex: 1 1 auto;
    gap: 8px;
    min-height: 0;
    overflow: auto;
    padding: 9px;
    color: var(--text-dim);
    font-size: 10px;
  }
  .specialized-node-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .creator-node-body > p {
    margin: 0;
    line-height: 1.35;
  }
  .creator-config-field {
    display: grid;
    gap: 4px;
    padding: 0;
    color: var(--text-dim);
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .creator-config-field textarea,
  .creator-config-field select {
    width: 100%;
    min-width: 0;
    font-size: 10px;
    text-transform: none;
  }
  .creator-config-field textarea {
    min-height: 54px;
    resize: none;
  }
  .asset-node textarea,
  .brief-node textarea {
    resize: none;
  }
  .creator-port-list {
    display: grid;
    gap: 4px;
  }
  .creator-port-list b {
    color: var(--text-bright);
    font-size: 9px;
    text-transform: uppercase;
  }
  .creator-port-list span {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 7px;
    color: var(--text);
  }
  .creator-port-list small {
    color: var(--text-dim);
    font-size: 9px;
    text-align: right;
  }
  .creator-node-body .draft-reason {
    padding: 6px;
    border: 1px solid color-mix(in srgb, #ffd38a 30%, var(--border));
    border-radius: 4px;
    background: color-mix(in srgb, #ffd38a 7%, transparent);
    color: #e8c98f;
  }
  .draft-run {
    width: 100%;
  }
  .selective-node-actions,
  .selective-preview-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 5px;
  }
  .selective-node-actions button,
  .selective-preview-actions button {
    min-width: 0;
    padding: 5px;
    font-size: 10px;
  }
  .selective-preview {
    display: grid;
    gap: 6px;
    padding: 7px;
    border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent) 8%, #252629);
  }
  .selective-preview strong {
    color: var(--text-bright);
    font-size: 10px;
  }
  .selective-preview p {
    margin: 0;
    color: var(--text-dim);
    line-height: 1.35;
  }
  .selective-preview .selective-error {
    color: #ffb0b0;
  }
  .candidate-branches {
    display: grid;
    gap: 6px;
    padding: 7px;
    border-top: 1px solid #4b4d52;
    background: #292a2e;
  }

  .review-compare {
    display: grid;
    gap: 8px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }

  .review-candidate-tabs {
    display: flex;
    gap: 4px;
    overflow-x: auto;
  }

  .review-candidate-tabs button {
    flex: 0 0 auto;
    font-size: 11px;
  }

  .review-candidate-tabs button[aria-selected='true'] {
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .review-candidate-context {
    display: grid;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: color-mix(in srgb, var(--panel-bg) 88%, white 12%);
  }

  .review-candidate-preview {
    display: block;
    width: 100%;
    max-height: 180px;
    object-fit: contain;
    border-radius: 6px;
    background: var(--surface-sunken);
  }

  .review-candidate-context p,
  .review-candidate-context small {
    margin: 0;
  }
  .candidate-branch-head,
  .candidate-branch-controls,
  .candidate-branch-controls label,
  .candidate-group li {
    display: flex;
    align-items: center;
  }
  .candidate-branch-head {
    justify-content: space-between;
    color: var(--text-bright);
    font-size: 10px;
  }
  .candidate-branch-head span,
  .candidate-group small {
    color: var(--text-dim);
  }
  .candidate-branch-controls {
    gap: 5px;
  }
  .candidate-branch-controls label {
    gap: 3px;
    color: var(--text-dim);
    font-size: 9px;
  }
  .candidate-branch-controls select {
    width: 42px;
    min-width: 42px;
    height: 24px;
    padding: 2px;
    font-size: 10px;
  }
  .candidate-branch-controls button,
  .candidate-group button {
    min-width: 0;
    padding: 4px 6px;
    font-size: 10px;
  }
  .candidate-group {
    display: grid;
    gap: 4px;
    padding: 5px;
    border: 1px solid #45474c;
    border-radius: 4px;
    background: #252629;
  }
  .candidate-group p,
  .candidate-group ol {
    margin: 0;
  }
  .candidate-group p {
    color: var(--text-dim);
    font-size: 9px;
  }
  .candidate-group ol {
    display: grid;
    gap: 4px;
    padding: 0;
    list-style: none;
  }
  .candidate-group li {
    align-items: stretch;
    flex-direction: column;
    gap: 2px;
    padding: 4px;
    border-left: 2px solid #777b84;
    font-size: 9px;
  }
  .candidate-group li[data-candidate-state='succeeded'] {
    border-left-color: #70bd8b;
  }
  .candidate-group li[data-candidate-state='failed'],
  .candidate-group li[data-candidate-state='cancelled'] {
    border-left-color: #d28b78;
  }
  .selective-running-state {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 5px;
    align-items: baseline;
    padding: 6px;
    border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border));
    border-radius: 4px;
    background: color-mix(in srgb, var(--accent) 9%, transparent);
    color: var(--text);
  }
  .selective-running-state strong {
    color: #a9d5ff;
    text-transform: uppercase;
  }
  .brief-node textarea {
    min-height: 105px;
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
  .qa-fake-banner {
    display: grid;
    gap: 2px;
    width: 100%;
    padding: 7px 8px;
    border: 1px solid #48795e;
    border-radius: 4px;
    background: #20382a;
    color: #d8f3e3;
    font-size: 10px;
  }
  .qa-fake-banner > div,
  .qa-fake-banner label {
    display: grid;
    gap: 2px;
  }
  .qa-fake-banner span {
    color: #acd5bd;
  }
  .qa-fake-banner label {
    margin-top: 4px;
  }
  .qa-fake-banner select {
    min-width: 0;
    width: 100%;
  }
  .readiness-checklist {
    display: grid;
    gap: 4px;
    margin: 0 8px 8px;
    padding: 7px;
    border: 1px solid #4b4d52;
    border-radius: 4px;
    background: #252629;
    font-size: 10px;
  }
  .checklist-head,
  .checklist-item {
    display: flex;
    align-items: center;
  }
  .checklist-head {
    justify-content: space-between;
    color: var(--text-bright);
  }
  .checklist-head span {
    color: var(--text-dim);
  }
  .checklist-item {
    gap: 6px;
    color: #8fd4a6;
  }
  .checklist-item.blocked {
    color: #ffd38a;
  }
  .checklist-item > span {
    display: grid;
    flex: 1 1 auto;
    min-width: 0;
  }
  .checklist-item b {
    color: var(--text);
    font-size: 10px;
  }
  .checklist-item small {
    color: var(--text-dim);
    line-height: 1.25;
  }
  .checklist-item button {
    flex: 0 0 auto;
    padding: 3px 6px;
    font-size: 10px;
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
  .generate-block {
    margin: -3px 8px 8px;
    color: #ffd38a;
    font-size: 10px;
    line-height: 1.3;
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
