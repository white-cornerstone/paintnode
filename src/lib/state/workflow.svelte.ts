import type { ProjectAsset } from '../integrations/desktop';
import { project } from './project.svelte';
import { ui } from './ui.svelte';
import { coerceAnnotations, type AnnotationItem } from '../engine/annotations';
import {
  WORKFLOW_GRAPH_VERSION,
  WorkflowGraphDomain,
  planWorkflowExecution,
  readWorkflowGraph,
  type WorkflowExecutionPlan,
  type WorkflowExecutionPlanOptions,
  type WorkflowEdgeV2,
  type WorkflowGraphV2,
  type WorkflowIdGenerator,
  type WorkflowNodeV2,
  type WorkflowNodePort,
  instantiateWorkflowTemplate,
  type WorkflowTemplateId,
  createCreatorNode,
  type CreatorNodeType,
  validateCreatorNodeConfig,
  executeCampaignGenerateTransform,
  type ExecuteCampaignGenerateOptions,
  type WorkflowTransformExecutionOutcome,
  WorkflowTransformExecutionError,
  createWorkflowRevision,
  deriveWorkflowNodeRunState,
  resolveWorkflowCancellation,
  WorkflowRunProgressRouter,
  type WorkflowCancellationHandler,
  type WorkflowCancellationResult,
  type WorkflowRunIdentity,
  type WorkflowRunProgressEvent,
  planSelectiveWorkflowExecution,
  executeSelectiveWorkflowPlan,
  createWorkflowExecutionRestrictions,
  prepareCampaignGenerateTransform,
  workflowSha256Bytes,
  isFullWorkflowRunRecord,
  type WorkflowSelectiveRunMode,
  type WorkflowSelectiveExecutionPlan,
  type WorkflowSelectiveExecutionOutcome,
  type WorkflowNodePreflight,
  type WorkflowRunRecordV1,
} from '../workflow';

export interface WorkflowTransformExecutionState {
  state: 'idle' | 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'stale';
  message: string;
  assetId: string | null;
}

export interface WorkflowTransformStoreOutcome extends WorkflowTransformExecutionOutcome {
  committed: boolean;
  commitMessage: string;
}

export interface WorkflowStoreRunOptions extends ExecuteCampaignGenerateOptions {
  currentProjectIdentity?: () => string | null;
  selectiveExecutionIdentity?: string;
  cancelExecution?: WorkflowCancellationHandler;
  cancellationTimeoutMs?: number;
}

export interface WorkflowSelectivePreflightProjection {
  plan: WorkflowSelectiveExecutionPlan;
  stateByNodeId: Readonly<Record<string, Readonly<WorkflowNodePreflight>>>;
}

export interface WorkflowSelectiveStoreExecutionOptions {
  maxConcurrency?: number;
  providerConcurrency?: Readonly<Record<string, number>>;
}

interface WorkflowSelectivePreflightSnapshot {
  sessionIdentity: number;
  graphRevision: number;
  storeRevision: number;
  graphBytes: string;
  projectIdentity: string | null;
  optionsIdentity: string;
}

interface ActiveWorkflowSelectiveOperation {
  controller: AbortController;
  transformNodeIds: Set<string>;
  stopExternalAbort: () => void;
  completion: Promise<void>;
  resolveCompletion: () => void;
  supersededPrior: boolean;
}

interface ActiveWorkflowTransformRun {
  sequence: number;
  sessionIdentity: number;
  controller: AbortController;
  cancelExecution?: WorkflowCancellationHandler;
  cancellationTimeoutMs: number;
  identity: WorkflowRunIdentity | null;
  stopProgress: (() => void) | null;
  progressOpen: boolean;
  cancellation: Promise<WorkflowCancellationResult> | null;
  completion: Promise<void>;
  resolveCompletion: () => void;
}

export interface WorkflowAssetNode {
  id: string;
  assetId: string | null;
  name: string;
  relativePath: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  included: boolean;
  note: string;
  slotId: string | null;
  required: boolean;
  guidance: string;
  creatorInput: boolean;
}

export interface WorkflowBriefNode {
  id: string;
  name: string;
  objective: string;
  guidance: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface WorkflowCreatorNode {
  id: string;
  type: 'art-direction' | 'transform' | 'review';
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  ports: { inputs: WorkflowNodePort[]; outputs: WorkflowNodePort[] };
  config: Record<string, unknown>;
}

export interface WorkflowConnection {
  id: string;
  from: string;
  to: string;
  sourcePortId: string;
  targetPortId: string;
}

export interface WorkflowUnsupportedNode {
  id: string;
  name: string;
  unsupportedType: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  ports: { inputs: WorkflowNodePort[]; outputs: WorkflowNodePort[] };
  config: Record<string, unknown>;
  runnable: false;
}

export interface WorkflowOutputNode {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  finalWidth: number;
  finalHeight: number;
  outputAssetId: string | null;
  outputRelativePath: string | null;
}

export type WorkflowTool = 'hand' | 'zoom' | 'asset' | 'composition' | 'output';
export type WorkflowSelection =
  | { kind: 'asset'; id: string }
  | { kind: 'creator'; id: string }
  | { kind: 'unsupported'; id: string }
  | { kind: 'composition' }
  | { kind: 'output'; id: string };
export type WorkflowZoomMode = 'in' | 'out';
export type StoryboardTool = 'brush' | 'eraser';

function id(prefix: string): string {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function cleanWorkflowName(name: string): string {
  const trimmed = name.trim().replace(/\.cxflow\.json$/i, '');
  return trimmed || 'Untitled Workflow';
}

function roundWorkflowNumber(value: number): number {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : rounded;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function defaultOutputNode(): WorkflowOutputNode {
  return {
    id: 'output',
    name: '',
    x: 895,
    y: 96,
    width: 210,
    height: 232,
    color: '#3a3c42',
    finalWidth: 1024,
    finalHeight: 1024,
    outputAssetId: null,
    outputRelativePath: null,
  };
}

export interface WorkflowStoreOptions {
  idGenerator?: WorkflowIdGenerator;
  workflowGraphIdGenerator?: () => string;
}

export class WorkflowStore {
  active = $state(false);
  name = $state('Untitled Workflow');
  savedPath = $state<string | null>(null);
  migrationSourcePath = $state<string | null>(null);
  requiresExplicitSave = $state(false);
  connectionError = $state<string | null>(null);
  tool = $state<WorkflowTool>('hand');
  zoomMode = $state<WorkflowZoomMode>('in');
  selection = $state<WorkflowSelection | null>({ kind: 'composition' });
  storyboardEditing = $state(false);
  storyboardTool = $state<StoryboardTool>('brush');
  prompt = $state('');
  compositionName = $state('');
  compositionWidth = $state(340);
  compositionHeight = $state(408);
  compositionColor = $state('#3a3c42');
  promptX = $state(480);
  promptY = $state(70);
  outputName = $state('');
  outputWidth = $state(210);
  outputHeight = $state(190);
  outputColor = $state('#3a3c42');
  outputX = $state(895);
  outputY = $state(96);
  outputNodes = $state<WorkflowOutputNode[]>([defaultOutputNode()]);
  panX = $state(0);
  panY = $state(0);
  zoom = $state(1);
  storyboardDataUrl = $state<string | null>(null);
  storyboardWidth = $state(1024);
  storyboardHeight = $state(768);
  storyboardOraPath = $state<string | null>(null);
  storyboardAnnotations = $state<string[]>([]);
  storyboardAnnotationItems = $state<AnnotationItem[]>([]);
  storyboardAnnotationsVisible = $state(true);
  nodes = $state<WorkflowAssetNode[]>([]);
  briefNodes = $state<WorkflowBriefNode[]>([]);
  creatorNodes = $state<WorkflowCreatorNode[]>([]);
  unsupportedNodes = $state<WorkflowUnsupportedNode[]>([]);
  connections = $state<WorkflowConnection[]>([]);
  outputAssetId = $state<string | null>(null);
  outputRelativePath = $state<string | null>(null);
  rev = $state(0);
  savedRev = $state(0);
  transformExecutions = $state<Record<string, WorkflowTransformExecutionState>>({});
  private graphDomain: WorkflowGraphDomain | null = null;
  private readonly graphIdGenerator: WorkflowIdGenerator | undefined;
  private readonly workflowGraphIdGenerator: (() => string) | undefined;
  private projectedGraphRevision = 0;
  private transformRunSequence = 0;
  private workflowSessionIdentity = 0;
  private readonly activeTransformRuns = new Map<string, ActiveWorkflowTransformRun>();
  private readonly transformStartQueues = new Map<string, Promise<void>>();
  private readonly latestTransformRunSequences = new Map<string, number>();
  private readonly progressRouter = new WorkflowRunProgressRouter();
  private readonly selectivePreflightSnapshots = new WeakMap<object, WorkflowSelectivePreflightSnapshot>();
  private activeSelectiveOperation: ActiveWorkflowSelectiveOperation | null = null;
  private selectiveLifecycleTail: Promise<void> = Promise.resolve();

  constructor(options: WorkflowStoreOptions = {}) {
    this.graphIdGenerator = options.idGenerator;
    this.workflowGraphIdGenerator = options.workflowGraphIdGenerator;
  }

  get dirty(): boolean {
    this.rev;
    return this.rev !== this.savedRev;
  }

  get graphRevision(): number {
    return this.graphDomain?.revision ?? 0;
  }

  newBoard(name = 'Untitled Workflow'): void {
    this.beginWorkflowSession();
    this.active = true;
    ui.showWorkflow();
    this.name = cleanWorkflowName(name);
    this.savedPath = null;
    this.migrationSourcePath = null;
    this.requiresExplicitSave = false;
    this.connectionError = null;
    this.tool = 'hand';
    this.zoomMode = 'in';
    this.selection = { kind: 'composition' };
    this.storyboardEditing = false;
    this.storyboardTool = 'brush';
    this.prompt = '';
    this.compositionName = '';
    this.compositionWidth = 340;
    this.compositionHeight = 408;
    this.compositionColor = '#3a3c42';
    this.promptX = 480;
    this.promptY = 70;
    this.outputName = '';
    this.outputWidth = 210;
    this.outputHeight = 190;
    this.outputColor = '#3a3c42';
    this.outputX = 895;
    this.outputY = 96;
    this.outputNodes = [defaultOutputNode()];
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.storyboardDataUrl = null;
    this.storyboardWidth = 1024;
    this.storyboardHeight = 768;
    this.storyboardOraPath = null;
    this.storyboardAnnotations = [];
    this.storyboardAnnotationItems = [];
    this.storyboardAnnotationsVisible = true;
    this.nodes = [];
    this.briefNodes = [];
    this.creatorNodes = [];
    this.unsupportedNodes = [];
    this.connections = [{
      id: this.nextGraphId('edge'),
      from: 'composition',
      to: 'output',
      sourcePortId: 'layout',
      targetPortId: 'source',
    }];
    this.outputAssetId = null;
    this.outputRelativePath = null;
    this.rev = 0;
    this.savedRev = 0;
    this.resetGraphDomain();
  }

  newFromTemplate(templateId: WorkflowTemplateId, name?: string): void {
    this.beginWorkflowSession();
    const graph = instantiateWorkflowTemplate(templateId, {
      name,
      graphId: this.workflowGraphIdGenerator?.(),
    });
    this.active = true;
    ui.showWorkflow();
    this.name = graph.metadata.name;
    this.savedPath = null;
    this.migrationSourcePath = null;
    this.requiresExplicitSave = false;
    this.connectionError = null;
    this.tool = 'hand';
    this.zoomMode = 'in';
    this.selection = { kind: 'composition' };
    this.storyboardEditing = false;
    this.storyboardTool = 'brush';
    this.panX = graph.viewport.panX;
    this.panY = graph.viewport.panY;
    this.zoom = graph.viewport.zoom;
    this.graphDomain = new WorkflowGraphDomain(graph, { idGenerator: this.graphIdGenerator });
    this.projectedGraphRevision = this.graphDomain.revision;
    this.syncReactiveGraph(this.graphDomain);
    this.rev = 0;
    this.savedRev = 0;
  }

  show(): void {
    if (!this.active) this.newBoard();
    this.active = true;
    ui.showWorkflow();
  }

  close(): void {
    this.beginWorkflowSession();
    this.active = false;
    ui.showDocument();
  }

  setName(name: string): void {
    this.name = cleanWorkflowName(name);
    this.bump();
  }

  setTool(tool: WorkflowTool): void {
    this.tool = tool;
  }

  setZoomMode(mode: WorkflowZoomMode): void {
    this.zoomMode = mode;
  }

  setStoryboardEditing(editing: boolean): void {
    this.storyboardEditing = editing;
    if (editing) {
      this.selection = { kind: 'composition' };
      this.tool = 'hand';
    }
  }

  setStoryboardTool(tool: StoryboardTool): void {
    this.storyboardTool = tool;
  }

  select(selection: WorkflowSelection | null): void {
    this.selection = selection;
  }

  addAsset(asset: ProjectAsset): void {
    const index = this.nodes.length;
    const domain = this.requireGraphDomain();
    const added = this.publishGraphMutation(domain, domain.addNodeWithEdge({
      type: 'input',
      title: asset.name.replace(/\.[^.]+$/, '') || 'Asset',
      position: { x: 80 + (index % 3) * 230, y: 110 + Math.floor(index / 3) * 160 },
      size: { width: 205, height: 190 },
      color: '#3a3c42',
      ports: { inputs: [], outputs: [{ id: 'asset', label: 'Asset', dataType: 'asset-reference' }] },
      config: { legacyKind: 'asset', assetId: asset.id, relativePath: asset.relativePath, note: '' },
      runRecordIds: [],
    }, {
      direction: 'outgoing',
      nodePortId: 'asset',
      other: { nodeId: 'composition', portId: 'assets' },
    }));
    this.selection = { kind: 'asset', id: added.node.id };
    this.tool = 'hand';
  }

  addBlankAsset(x: number, y: number, width: number, height: number): void {
    const domain = this.requireGraphDomain();
    const added = this.publishGraphMutation(domain, domain.addNodeWithEdge({
      type: 'input',
      title: `Asset ${this.nodes.length + 1}`,
      position: { x: roundWorkflowNumber(x), y: roundWorkflowNumber(y) },
      size: { width: Math.max(160, roundWorkflowNumber(width)), height: Math.max(130, roundWorkflowNumber(height)) },
      color: '#3a3c42',
      ports: { inputs: [], outputs: [{ id: 'asset', label: 'Asset', dataType: 'asset-reference' }] },
      config: { legacyKind: 'asset', assetId: null, relativePath: '', note: '' },
      runRecordIds: [],
    }, {
      direction: 'outgoing',
      nodePortId: 'asset',
      other: { nodeId: 'composition', portId: 'assets' },
    }));
    this.selection = { kind: 'asset', id: added.node.id };
    this.tool = 'hand';
  }

  addCreatorNode(
    type: CreatorNodeType,
    position?: { x: number; y: number },
    config?: Record<string, unknown>,
  ): string {
    const domain = this.requireGraphDomain();
    const node = createCreatorNode(type, {
      id: this.nextGraphId('node'),
      position: position
        ? { x: roundWorkflowNumber(position.x), y: roundWorkflowNumber(position.y) }
        : undefined,
      config,
    });
    this.publishGraphMutation(domain, domain.addNode(node));
    this.selection = type === 'input'
      ? { kind: 'asset', id: node.id }
      : type === 'output'
        ? { kind: 'output', id: node.id }
        : { kind: 'creator', id: node.id };
    this.tool = 'hand';
    return node.id;
  }

  removeNode(id: string): void {
    if (!this.requireGraphDomain().node(id)) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.removeNode(id));
    if ((this.selection?.kind === 'asset' || this.selection?.kind === 'creator' || this.selection?.kind === 'unsupported' || this.selection?.kind === 'output')
      && this.selection.id === id) this.selection = null;
  }

  moveNode(id: string, x: number, y: number): void {
    if (!this.requireGraphDomain().node(id)) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.moveNode(id, { x: roundWorkflowNumber(x), y: roundWorkflowNumber(y) }));
  }

  resizeNode(id: string, width: number, height: number): void {
    if (!this.requireGraphDomain().node(id)) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.resizeNode(id, {
      width: Math.max(160, roundWorkflowNumber(width)),
      height: Math.max(130, roundWorkflowNumber(height)),
    }));
  }

  movePrompt(x: number, y: number): void {
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.moveNode('composition', { x: roundWorkflowNumber(x), y: roundWorkflowNumber(y) }));
  }

  resizePrompt(width: number, height: number): void {
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.resizeNode('composition', {
      width: Math.max(260, roundWorkflowNumber(width)),
      height: Math.max(260, roundWorkflowNumber(height)),
    }));
  }

  moveOutput(x: number, y: number): void {
    this.moveOutputNode('output', x, y);
  }

  resizeOutput(width: number, height: number): void {
    this.resizeOutputNode('output', width, height);
  }

  addOutputNode(x = this.outputX + 280, y = this.outputY, width = this.outputWidth, height = this.outputHeight): WorkflowOutputNode {
    const base = defaultOutputNode();
    const domain = this.requireGraphDomain();
    const added = this.publishGraphMutation(domain, domain.addNodeWithEdge({
      type: 'output',
      title: `Output ${this.outputNodes.length + 1}`,
      position: { x: roundWorkflowNumber(x), y: roundWorkflowNumber(y) },
      size: { width: Math.max(190, roundWorkflowNumber(width)), height: Math.max(190, roundWorkflowNumber(height)) },
      color: base.color,
      ports: { inputs: [{ id: 'source', label: 'Source', dataType: 'layout', required: true }], outputs: [] },
      config: {
        legacyKind: 'output',
        displayName: `Output ${this.outputNodes.length + 1}`,
        legacyX: roundWorkflowNumber(x),
        legacyY: roundWorkflowNumber(y),
        legacyWidth: Math.max(190, roundWorkflowNumber(width)),
        legacyHeight: Math.max(190, roundWorkflowNumber(height)),
        legacyColor: base.color,
        finalWidth: base.finalWidth,
        finalHeight: base.finalHeight,
        outputAssetId: null,
        outputRelativePath: null,
      },
      runRecordIds: [],
    }, {
      direction: 'incoming',
      nodePortId: 'source',
      other: { nodeId: 'composition', portId: 'layout' },
    }));
    const node = this.outputNode(added.node.id)!;
    this.selection = { kind: 'output', id: added.node.id };
    this.tool = 'hand';
    return node;
  }

  removeOutputNode(id: string): void {
    if (this.outputNodes.length <= 1) return;
    if (!this.requireGraphDomain().node(id)) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.removeNode(id));
    if (this.selection?.kind === 'output' && this.selection.id === id) this.selection = { kind: 'output', id: this.outputNodes[0].id };
  }

  outputNode(id: string | null | undefined): WorkflowOutputNode | null {
    return this.outputNodes.find((node) => node.id === id) ?? null;
  }

  selectedOutputNode(): WorkflowOutputNode | null {
    if (this.selection?.kind === 'output') return this.outputNode(this.selection.id);
    return this.outputNodes[0] ?? null;
  }

  moveOutputNode(id: string, x: number, y: number): void {
    const node = this.requireGraphDomain().node(id);
    if (!node) return;
    const position = { x: roundWorkflowNumber(x), y: roundWorkflowNumber(y) };
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.updateNode(id, {
      position,
      ...(id === 'output'
        ? { config: {
          ...node.config,
          legacyX: position.x,
          legacyY: position.y,
        } }
        : {}),
    }));
  }

  resizeOutputNode(id: string, width: number, height: number): void {
    const node = this.requireGraphDomain().node(id);
    if (!node) return;
    const size = {
      width: Math.max(190, roundWorkflowNumber(width)),
      height: Math.max(190, roundWorkflowNumber(height)),
    };
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.updateNode(id, {
      size,
      ...(id === 'output'
        ? { config: {
          ...node.config,
          legacyWidth: size.width,
          legacyHeight: size.height,
        } }
        : {}),
    }));
  }

  setOutputFinalSize(id: string, width: number, height: number): void {
    const node = this.requireGraphDomain().node(id);
    if (!node) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.configureNode(id, {
      ...node.config,
      finalWidth: Math.max(64, roundWorkflowNumber(width)),
      finalHeight: Math.max(64, roundWorkflowNumber(height)),
    }));
  }

  panBy(dx: number, dy: number): void {
    const panX = roundWorkflowNumber(this.panX + dx);
    const panY = roundWorkflowNumber(this.panY + dy);
    if (panX === this.panX && panY === this.panY) return;
    this.panX = panX;
    this.panY = panY;
    this.bump();
  }

  setZoom(nextZoom: number): void {
    const zoom = Math.min(4, Math.max(0.2, Number(nextZoom.toFixed(3))));
    if (zoom === this.zoom) return;
    this.zoom = zoom;
    this.bump();
  }

  zoomAt(viewX: number, viewY: number, direction: WorkflowZoomMode): void {
    const current = this.zoom;
    const next = Math.min(4, Math.max(0.2, current * (direction === 'in' ? 1.25 : 0.8)));
    const zoom = Number(next.toFixed(3));
    if (zoom === current) return;
    const worldX = (viewX - this.panX) / current;
    const worldY = (viewY - this.panY) / current;
    const panX = roundWorkflowNumber(viewX - worldX * zoom);
    const panY = roundWorkflowNumber(viewY - worldY * zoom);
    this.zoom = zoom;
    this.panX = panX;
    this.panY = panY;
    this.bump();
  }

  zoomBy(factor: number, viewX: number, viewY: number): void {
    const current = this.zoom;
    const next = Math.min(4, Math.max(0.2, current * factor));
    const zoom = Number(next.toFixed(3));
    if (zoom === current) return;
    const worldX = (viewX - this.panX) / current;
    const worldY = (viewY - this.panY) / current;
    const panX = roundWorkflowNumber(viewX - worldX * zoom);
    const panY = roundWorkflowNumber(viewY - worldY * zoom);
    this.zoom = zoom;
    this.panX = panX;
    this.panY = panY;
    this.bump();
  }

  resetZoom(): void {
    if (this.zoom === 1) return;
    this.zoom = 1;
    this.bump();
  }

  setNodeIncluded(id: string, included: boolean): void {
    const node = this.nodes.find((item) => item.id === id);
    if (!node) return;
    if (included) {
      if (!this.isConnected(id, 'composition')) this.connect(id, 'composition');
    } else {
      this.disconnectNodes(id, 'composition');
    }
  }

  connect(from: string, to: string): boolean {
    const domain = this.requireGraphDomain();
    const endpoints = this.connectionEndpoints(from, to);
    if (!endpoints) {
      const source = domain.node(from);
      const target = domain.node(to);
      this.connectionError = !source || !target
        ? 'Both workflow nodes must exist before they can be connected.'
        : source.ports.outputs.length === 0
          ? `Node "${source.title}" does not expose an output port.`
          : `Node "${target.title}" does not expose an input port.`;
      return false;
    }
    return this.connectPorts(from, endpoints.source.portId, to, endpoints.target.portId);
  }

  connectPorts(from: string, sourcePortId: string, to: string, targetPortId: string): boolean {
    const domain = this.requireGraphDomain();
    const endpoints = {
      source: { nodeId: from, portId: sourcePortId },
      target: { nodeId: to, portId: targetPortId },
    };
    const validation = domain.validateConnection(endpoints);
    if (!validation.ok) {
      this.connectionError = validation.message;
      return false;
    }
    this.publishGraphMutation(domain, domain.addEdge({
      source: endpoints.source,
      target: endpoints.target,
    }));
    this.connectionError = null;
    return true;
  }

  disconnectConnection(id: string): void {
    if (!this.requireGraphDomain().edge(id)) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.removeEdge(id));
  }

  disconnectNodes(from: string, to: string): void {
    const domain = this.requireGraphDomain();
    const edge = domain.outgoing(from).find((item) => item.target.nodeId === to);
    if (!edge) return;
    this.publishGraphMutation(domain, domain.removeEdge(edge.id));
  }

  isConnected(from: string, to: string): boolean {
    return this.requireGraphDomain().isConnected(from, to);
  }

  incoming(nodeId: string): WorkflowConnection[] {
    return this.requireGraphDomain().incoming(nodeId).map((edge) => ({
      id: edge.id,
      from: edge.source.nodeId,
      to: edge.target.nodeId,
      sourcePortId: edge.source.portId,
      targetPortId: edge.target.portId,
    }));
  }

  outgoing(nodeId: string): WorkflowConnection[] {
    return this.requireGraphDomain().outgoing(nodeId).map((edge) => ({
      id: edge.id,
      from: edge.source.nodeId,
      to: edge.target.nodeId,
      sourcePortId: edge.source.portId,
      targetPortId: edge.target.portId,
    }));
  }

  connectedAssetNodesTo(nodeId: string): WorkflowAssetNode[] {
    const incomingIds = new Set(this.incoming(nodeId).map((connection) => connection.from));
    return this.nodes.filter((node) => incomingIds.has(node.id));
  }

  canConnect(from: string, to: string): boolean {
    const domain = this.requireGraphDomain();
    const endpoints = this.connectionEndpoints(from, to);
    return endpoints !== null && domain.validateConnection(endpoints).ok;
  }

  setPrompt(prompt: string): void {
    this.configureComposition({ prompt });
  }

  setStoryboardDataUrl(dataUrl: string | null): void {
    this.configureComposition({ storyboardDataUrl: dataUrl });
  }

  setStoryboardSize(width: number, height: number): void {
    this.configureComposition({
      storyboardWidth: Math.max(64, roundWorkflowNumber(width)),
      storyboardHeight: Math.max(64, roundWorkflowNumber(height)),
    });
  }

  setStoryboardOraPath(path: string | null): void {
    this.configureComposition({ storyboardOraPath: path });
  }

  setStoryboardAnnotations(annotations: string[]): void {
    this.configureComposition({
      storyboardAnnotations: annotations
        .map((annotation) => annotation.trim())
        .filter(Boolean)
        .slice(0, 24),
    });
  }

  setStoryboardAnnotationItems(items: AnnotationItem[]): void {
    this.configureComposition({ storyboardAnnotationItems: coerceAnnotations(items) });
  }

  setStoryboardAnnotationsVisible(visible: boolean): void {
    this.configureComposition({ storyboardAnnotationsVisible: visible });
  }

  setNodeNote(id: string, note: string): void {
    const node = this.requireGraphDomain().node(id);
    if (!node) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.configureNode(id, { ...node.config, note }));
  }

  assignAsset(id: string, asset: ProjectAsset | null): void {
    const node = this.requireGraphDomain().node(id);
    if (!node || node.type !== 'input') return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.configureNode(id, {
      ...node.config,
      assetId: asset?.id ?? null,
      relativePath: asset?.relativePath ?? null,
    }));
  }

  configureCreatorNode(id: string, update: Record<string, unknown>): void {
    const node = this.requireGraphDomain().node(id);
    if (!node || node.type === 'unsupported') return;
    const config = { ...node.config, ...update };
    const issues = validateCreatorNodeConfig(node.type, config);
    if (issues.length > 0) {
      throw new Error(`Invalid creator node configuration: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    }
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.configureNode(id, config));
  }

  setBriefObjective(id: string, objective: string): void {
    const node = this.requireGraphDomain().node(id);
    if (!node || node.type !== 'brief') return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.configureNode(id, { ...node.config, objective }));
  }

  selectedLabel(): string {
    const selection = this.selection;
    if (selection?.kind === 'asset') {
      return this.nodes.find((node) => node.id === selection.id)?.name ?? '';
    }
    if (selection?.kind === 'composition') return this.compositionName;
    if (selection?.kind === 'output') return this.outputNode(selection.id)?.name ?? '';
    if (selection?.kind === 'creator') return this.requireGraphDomain().node(selection.id)?.title ?? '';
    if (selection?.kind === 'unsupported') return this.unsupportedNodes.find((node) => node.id === selection.id)?.name ?? '';
    return '';
  }

  selectedColor(): string {
    const selection = this.selection;
    if (selection?.kind === 'asset') {
      return this.nodes.find((node) => node.id === selection.id)?.color ?? '#3a3c42';
    }
    if (selection?.kind === 'composition') return this.compositionColor;
    if (selection?.kind === 'output') return this.outputNode(selection.id)?.color ?? '#3a3c42';
    if (selection?.kind === 'creator') return this.requireGraphDomain().node(selection.id)?.color ?? '#3a3c42';
    if (selection?.kind === 'unsupported') return this.unsupportedNodes.find((node) => node.id === selection.id)?.color ?? '#3a3c42';
    return '#3a3c42';
  }

  setSelectedLabel(name: string): void {
    const selection = this.selection;
    let nodeId: string;
    let displayName: string;
    let fallback: string;
    if (selection?.kind === 'asset') {
      nodeId = selection.id;
      displayName = name.trim() || 'Asset';
      fallback = 'Asset';
    } else if (selection?.kind === 'composition') {
      nodeId = 'composition';
      displayName = name.trim();
      fallback = 'Composition';
    } else if (selection?.kind === 'output') {
      nodeId = selection.id;
      displayName = name.trim();
      fallback = 'Output';
    } else if (selection?.kind === 'creator') {
      nodeId = selection.id;
      displayName = name.trim();
      fallback = this.requireGraphDomain().node(nodeId)?.title ?? 'Node';
    } else {
      return;
    }
    const node = this.requireGraphDomain().node(nodeId);
    if (!node) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.updateNode(nodeId, {
      title: displayName || fallback,
      config: { ...node.config, displayName },
    }));
  }

  setSelectedColor(color: string): void {
    const selection = this.selection;
    let nodeId: string;
    if (selection?.kind === 'asset') {
      nodeId = selection.id;
    } else if (selection?.kind === 'composition') {
      nodeId = 'composition';
    } else if (selection?.kind === 'output') {
      nodeId = selection.id;
    } else if (selection?.kind === 'creator') {
      nodeId = selection.id;
    } else {
      return;
    }
    const node = this.requireGraphDomain().node(nodeId);
    if (!node) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.updateNode(nodeId, {
      color,
      ...(nodeId === 'output' ? { config: { ...node.config, legacyColor: color } } : {}),
    }));
  }

  setOutput(asset: ProjectAsset | null, outputId = this.selectedOutputNode()?.id ?? 'output'): void {
    const node = this.requireGraphDomain().node(outputId);
    if (!node) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.configureNode(outputId, {
      ...node.config,
      outputAssetId: asset?.id ?? null,
      outputRelativePath: asset?.relativePath ?? null,
    }));
  }

  serialize(): WorkflowGraphV2 {
    const graph = this.requireGraphDomain().graph;
    return new WorkflowGraphDomain({
      ...graph,
      metadata: { ...graph.metadata, name: this.name },
      viewport: { panX: this.panX, panY: this.panY, zoom: this.zoom },
    }).graph;
  }

  toBytes(): Uint8Array {
    return new TextEncoder().encode(new WorkflowGraphDomain(this.serialize()).serialize());
  }

  graphSnapshot(): WorkflowGraphV2 {
    return this.requireGraphDomain().graph;
  }

  planExecution(targetNodeId: string, options: WorkflowExecutionPlanOptions): WorkflowExecutionPlan {
    return planWorkflowExecution(this.serialize(), targetNodeId, options);
  }

  async preflightSelectiveExecution(
    mode: WorkflowSelectiveRunMode,
    nodeId: string,
    options: WorkflowStoreRunOptions,
  ): Promise<WorkflowSelectivePreflightProjection> {
    const operation = await this.beginSelectiveOperation(options);
    try {
      return await this.buildSelectivePreflight(mode, nodeId, options, operation);
    } finally {
      this.finishSelectiveOperation(operation);
    }
  }

  async runSelectiveExecution(
    preflight: WorkflowSelectivePreflightProjection,
    options: WorkflowStoreRunOptions,
    scheduler: WorkflowSelectiveStoreExecutionOptions = {},
  ): Promise<WorkflowSelectiveExecutionOutcome> {
    const snapshot = this.selectivePreflightSnapshots.get(preflight);
    if (!snapshot) {
      throw new WorkflowTransformExecutionError(
        'CANCELLED', 'Selective execution requires a current store preflight.', 'Run preflight again',
      );
    }
    const operation = await this.beginSelectiveOperation(options);
    try {
      const maxConcurrency = scheduler.maxConcurrency ?? 1;
      const providerConcurrency = scheduler.providerConcurrency ?? Object.fromEntries(
        options.executors.map((executor) => [executor.provider, maxConcurrency]),
      );
      let currentPreflight = preflight;
      if (operation.supersededPrior) {
        currentPreflight = await this.buildSelectivePreflight(
          preflight.plan.mode,
          preflight.plan.targetNodeId,
          options,
          operation,
        );
      } else {
        this.requireCurrentSelectiveSnapshot(snapshot, options);
      }
      return await executeSelectiveWorkflowPlan(currentPreflight.plan, {
        maxConcurrency,
        providerConcurrency,
        signal: operation.controller.signal,
        providerKeyForNode: (node) => {
          const advanced = typeof node.config.advanced === 'object' && node.config.advanced !== null
            && !Array.isArray(node.config.advanced)
            ? node.config.advanced as Record<string, unknown>
            : {};
          return typeof advanced.provider === 'string' && advanced.provider.trim()
            ? advanced.provider.trim()
            : options.provider;
        },
        executeNode: async ({ nodeId: transformNodeId, materialKey }) => {
          if (operation.controller.signal.aborted) {
            throw new WorkflowTransformExecutionError('CANCELLED', 'Selective execution was cancelled.', 'Run again');
          }
          const graph = this.serialize();
          const outputNodeId = this.campaignOutputForTransform(graph, transformNodeId);
          if (!outputNodeId) throw new Error('Campaign Generate output is unavailable.');
          operation.transformNodeIds.add(transformNodeId);
          try {
            const outcome = await this.runCampaignGenerate(outputNodeId, {
              ...options,
              signal: operation.controller.signal,
              expectedMaterialKey: materialKey,
            });
            if (!outcome.committed) {
              throw new WorkflowTransformExecutionError(
                'NOT_READY', outcome.commitMessage, 'Run selective preflight again',
              );
            }
            const committedGraph = this.serialize();
            const transform = committedGraph.nodes.find((node) => node.id === transformNodeId);
            const run = transform?.runRecordIds
              .map((runId) => committedGraph.runRecords.find((record) => record.id === runId))
              .filter((record): record is WorkflowRunRecordV1 => Boolean(record && isFullWorkflowRunRecord(record)))
              .at(-1);
            if (!run || run.status !== 'succeeded' || run.materialKey !== materialKey) {
              throw new Error('Campaign Generate did not commit the prepared material result.');
            }
            return { cacheKey: materialKey, outputIds: run.outputs.map((output) => output.assetReferenceId) };
          } finally {
            operation.transformNodeIds.delete(transformNodeId);
          }
        },
        validateResultOwnership: ({ nodeId: transformNodeId, result }) => {
          const graph = this.serialize();
          const node = graph.nodes.find((candidate) => candidate.id === transformNodeId);
          return Boolean(node?.runRecordIds.some((runId) => {
            const run = graph.runRecords.find((record) => record.id === runId);
            return run && isFullWorkflowRunRecord(run) && run.status === 'succeeded'
              && run.materialKey === result.cacheKey
              && result.outputIds.every((outputId) => run.outputs.some((output) => output.assetReferenceId === outputId));
          }));
        },
        sanitizeFailure: (error) => error instanceof WorkflowTransformExecutionError
          ? { code: error.code, message: error.message }
          : { code: 'EXECUTOR_FAILED', message: 'Campaign Generate did not complete.' },
      });
    } finally {
      this.finishSelectiveOperation(operation);
    }
  }

  async cancelSelectiveExecution(): Promise<WorkflowCancellationResult> {
    const operation = this.activeSelectiveOperation;
    if (!operation) {
      return {
        disposition: 'detached',
        message: 'No active selective workflow execution could be terminated.',
      };
    }
    operation.controller.abort();
    const cancellations = await Promise.allSettled(
      [...operation.transformNodeIds].map((nodeId) => this.cancelCampaignGenerate(nodeId)),
    );
    await operation.completion;
    if (cancellations.some((result) => (
      result.status === 'rejected' || result.value.disposition !== 'terminated'
    ))) {
      return {
        disposition: 'detached',
        message: 'Provider termination was not confirmed for every active selective workflow node; late results will be ignored.',
      };
    }
    return { disposition: 'terminated', message: 'Selective workflow execution was cancelled.' };
  }

  transformExecution(nodeId: string): WorkflowTransformExecutionState {
    const transient = this.transformExecutions[nodeId];
    if (transient) return transient;
    const graph = this.requireGraphDomain().graph;
    const derived = deriveWorkflowNodeRunState(graph, nodeId);
    const latest = derived.latestRun;
    if (!latest) return { state: 'idle', message: '', assetId: null };
    const accepted = derived.acceptedOutputs.at(-1) ?? null;
    if (latest.status === 'succeeded' && latest.workflowRevision !== createWorkflowRevision(graph)) {
      return {
        state: 'stale', message: 'Workflow inputs changed after this result was generated.',
        assetId: accepted?.assetId ?? null,
      };
    }
    if (latest.status === 'succeeded') {
      return { state: 'succeeded', message: 'Generated', assetId: accepted?.assetId ?? null };
    }
    if (latest.status === 'running') {
      return { state: 'failed', message: 'The attempt was interrupted before it completed.', assetId: null };
    }
    if (latest.status === 'cancelled') {
      return { state: 'cancelled', message: latest.failure?.message ?? 'The attempt was cancelled.', assetId: null };
    }
    return {
      state: 'failed', message: latest.failure?.message ?? 'The latest generation attempt did not complete.', assetId: null,
    };
  }

  async runCampaignGenerate(
    outputNodeId: string,
    options: WorkflowStoreRunOptions,
  ): Promise<WorkflowTransformStoreOutcome> {
    const requestedSessionIdentity = this.workflowSessionIdentity;
    const initialGraph = this.serialize();
    const outputEdge = initialGraph.edges.find((edge) => edge.target.nodeId === outputNodeId && edge.target.portId === 'source');
    const transformNodeId = outputEdge?.source.nodeId ?? 'transform';
    const previousStart = this.transformStartQueues.get(transformNodeId);
    let releaseStart!: () => void;
    const startHeld = new Promise<void>((resolve) => { releaseStart = resolve; });
    const currentStart = previousStart
      ? previousStart.catch(() => undefined).then(() => startHeld)
      : startHeld;
    this.transformStartQueues.set(transformNodeId, currentStart);
    const finishStart = (): void => {
      releaseStart();
      if (this.transformStartQueues.get(transformNodeId) === currentStart) {
        this.transformStartQueues.delete(transformNodeId);
      }
    };
    if (previousStart) await previousStart.catch(() => undefined);
    if (this.workflowSessionIdentity !== requestedSessionIdentity) {
      finishStart();
      throw new WorkflowTransformExecutionError(
        'CANCELLED',
        'The workflow session changed before Generate could start.',
        'Run Generate again',
      );
    }
    const superseded = this.activeTransformRuns.get(transformNodeId);
    if (superseded) {
      const cancellation = this.cancelActiveTransformRun(superseded);
      await Promise.all([superseded.completion, cancellation]);
    }
    const graph = this.serialize();
    const sessionIdentity = this.workflowSessionIdentity;
    const graphRevision = this.graphRevision;
    const storeRevision = this.rev;
    const projectIdentity = options.currentProjectIdentity?.() ?? options.projectPath;
    const sequence = ++this.transformRunSequence;
    const controller = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const activeRun: ActiveWorkflowTransformRun = {
      sequence,
      sessionIdentity,
      controller,
      cancelExecution: options.cancelExecution,
      cancellationTimeoutMs: options.cancellationTimeoutMs ?? 1_500,
      identity: null,
      stopProgress: null,
      progressOpen: true,
      cancellation: null,
      completion,
      resolveCompletion,
    };
    const externalSignal = options.signal;
    const abortFromExternal = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    const commitBlockReason = (): string => {
      if (this.workflowSessionIdentity !== sessionIdentity) {
        return 'The workflow session changed while Generate was running. The result was not applied.';
      }
      if (this.activeTransformRuns.get(transformNodeId) !== activeRun) {
        return 'A newer Generate run replaced this result before it could be applied.';
      }
      if (this.graphRevision !== graphRevision || this.rev !== storeRevision) {
        return 'The workflow changed while Generate was running. The result was not applied.';
      }
      if ((options.currentProjectIdentity?.() ?? options.projectPath) !== projectIdentity) {
        return 'The active project changed while Generate was running. The result was not applied.';
      }
      return '';
    };
    this.latestTransformRunSequences.set(transformNodeId, sequence);
    this.activeTransformRuns.set(transformNodeId, activeRun);
    finishStart();
    this.transformExecutions = {
      ...this.transformExecutions,
      [transformNodeId]: { state: 'running', message: 'Preparing workflow execution…', assetId: null },
    };
    const routeProgress = (event: Readonly<WorkflowRunProgressEvent>): void => {
      if (!activeRun.progressOpen || this.activeTransformRuns.get(transformNodeId) !== activeRun) return;
      if (!activeRun.identity) {
        activeRun.identity = {
          workflowSessionId: event.workflowSessionId,
          workflowId: event.workflowId,
          runId: event.runId,
          nodeId: event.nodeId,
        };
        activeRun.stopProgress = this.progressRouter.subscribe(activeRun.identity, (progress) => {
          if (!activeRun.progressOpen || this.activeTransformRuns.get(transformNodeId) !== activeRun) return;
          const state = progress.stage === 'succeeded' ? 'running' : progress.stage;
          this.transformExecutions = {
            ...this.transformExecutions,
            [transformNodeId]: { state, message: progress.message, assetId: null },
          };
          try {
            options.onProgress?.(progress);
          } catch {
            // External observers cannot replace run state.
          }
        });
      }
      this.progressRouter.publish(event);
    };
    try {
      const outcome = await executeCampaignGenerateTransform(graph, outputNodeId, {
        ...options,
        workflowSessionId: `workflow-session-${sessionIdentity}`,
        signal: controller.signal,
        onProgress: routeProgress,
      });
      let commitMessage = commitBlockReason();
      if (!commitMessage && options.expectedMaterialKey) {
        const completedRun = outcome.graph.nodes.find((node) => node.id === outcome.transformNodeId)?.runRecordIds
          .map((runId) => outcome.graph.runRecords.find((record) => record.id === runId))
          .filter((record): record is WorkflowRunRecordV1 => Boolean(record && isFullWorkflowRunRecord(record)))
          .at(-1);
        if (!completedRun || completedRun.materialKey !== options.expectedMaterialKey) {
          commitMessage = 'Campaign Generate material changed after selective preflight. The result was not applied.';
        }
      }
      if (commitMessage) {
        commitMessage += ` The generated asset remains available at ${outcome.asset.relativePath}.`;
        if (
          this.workflowSessionIdentity === sessionIdentity
          && this.activeTransformRuns.get(transformNodeId) === activeRun
        ) {
          this.transformExecutions = {
            ...this.transformExecutions,
            [transformNodeId]: { state: 'failed', message: commitMessage, assetId: null },
          };
        }
        return { ...outcome, committed: false, commitMessage };
      }
      if (this.activeTransformRuns.get(transformNodeId) === activeRun) {
        this.graphDomain = new WorkflowGraphDomain(outcome.graph, { idGenerator: this.graphIdGenerator });
        this.projectedGraphRevision = this.graphDomain.revision;
        this.syncReactiveGraph(this.graphDomain);
        this.bump();
        this.transformExecutions = {
          ...this.transformExecutions,
          [transformNodeId]: {
            state: 'succeeded', message: 'Generated', assetId: outcome.asset.id,
          },
        };
      }
      return { ...outcome, committed: true, commitMessage: 'Generated result applied.' };
    } catch (error) {
      const failureGraph = error instanceof WorkflowTransformExecutionError ? error.failureGraph : undefined;
      if (failureGraph && !commitBlockReason()) {
        this.graphDomain = new WorkflowGraphDomain(failureGraph, { idGenerator: this.graphIdGenerator });
        this.projectedGraphRevision = this.graphDomain.revision;
        this.syncReactiveGraph(this.graphDomain);
        this.bump();
      }
      if (this.activeTransformRuns.get(transformNodeId) === activeRun) {
        const cancelled = error instanceof WorkflowTransformExecutionError && error.code === 'CANCELLED';
        this.transformExecutions = {
          ...this.transformExecutions,
          [transformNodeId]: {
            state: cancelled ? 'cancelled' : 'failed',
            message: (error as Error)?.message ?? String(error),
            assetId: null,
          },
        };
      }
      throw error;
    } finally {
      externalSignal?.removeEventListener('abort', abortFromExternal);
      activeRun.progressOpen = false;
      activeRun.stopProgress?.();
      if (activeRun.identity) this.progressRouter.close(activeRun.identity);
      if (this.activeTransformRuns.get(transformNodeId) === activeRun) {
        this.activeTransformRuns.delete(transformNodeId);
      }
      activeRun.resolveCompletion();
    }
  }

  async cancelCampaignGenerate(nodeId: string): Promise<WorkflowCancellationResult> {
    const activeRun = this.activeTransformRuns.get(nodeId);
    if (!activeRun) {
      return {
        disposition: 'detached',
        message: 'No active workflow attempt could be terminated; late results will be ignored.',
      };
    }
    const sessionIdentity = activeRun.sessionIdentity;
    const sequence = activeRun.sequence;
    if (this.activeTransformRuns.get(nodeId) === activeRun) {
      this.transformExecutions = {
        ...this.transformExecutions,
        [nodeId]: { state: 'cancelling', message: 'Cancelling…', assetId: null },
      };
    }
    const result = await this.cancelActiveTransformRun(activeRun);
    if (this.workflowSessionIdentity === sessionIdentity
      && this.latestTransformRunSequences.get(nodeId) === sequence) {
      this.transformExecutions = {
        ...this.transformExecutions,
        [nodeId]: { state: 'cancelled', message: result.message, assetId: null },
      };
    }
    return result;
  }

  openFromBytes(bytes: Uint8Array, savedPath: string | null, fallbackName: string): void {
    const text = new TextDecoder().decode(bytes);
    const result = readWorkflowGraph(JSON.parse(text));
    if (!result.ok || !result.graph) {
      const details = result.issues.map((issue) => `${issue.path || 'workflow'}: ${issue.message}`).join('; ');
      throw new Error(`Workflow file is not a supported PaintNode workflow. ${details}`);
    }
    this.beginWorkflowSession();
    this.active = true;
    ui.showWorkflow();
    this.tool = 'hand';
    this.zoomMode = 'in';
    this.selection = result.graph.nodes.some((node) => node.id === 'composition') ? { kind: 'composition' } : null;
    this.storyboardEditing = false;
    this.storyboardTool = 'brush';
    this.name = result.graph.metadata.name || cleanWorkflowName(fallbackName);
    this.savedPath = result.requiresExplicitSave ? null : savedPath;
    this.migrationSourcePath = result.requiresExplicitSave ? savedPath : null;
    this.requiresExplicitSave = result.requiresExplicitSave;
    this.connectionError = null;
    const legacyProjection = result.sourceVersion === 1;
    this.panX = legacyProjection ? roundWorkflowNumber(result.graph.viewport.panX) : result.graph.viewport.panX;
    this.panY = legacyProjection ? roundWorkflowNumber(result.graph.viewport.panY) : result.graph.viewport.panY;
    this.zoom = result.graph.viewport.zoom;
    this.graphDomain = new WorkflowGraphDomain(result.graph, { idGenerator: this.graphIdGenerator });
    this.projectedGraphRevision = this.graphDomain.revision;
    this.syncReactiveGraph(this.graphDomain, legacyProjection);
    this.rev = result.normalizedInterruptedRuns ? 1 : 0;
    this.savedRev = 0;
  }

  async save(): Promise<string | null> {
    if (!project.path) return null;
    const name = `${this.name || 'workflow'}${this.requiresExplicitSave ? '-v2' : ''}.cxflow.json`;
    const relativePath = this.savedPath
      ? await project.saveDocumentToPath(this.savedPath, this.toBytes())
      : await project.saveDocument(name, this.toBytes());
    if (relativePath) {
      this.savedPath = relativePath;
      this.savedRev = this.rev;
      this.requiresExplicitSave = false;
      this.migrationSourcePath = null;
    }
    return relativePath;
  }

  async saveAs(name: string): Promise<string | null> {
    if (!project.path) return null;
    this.name = cleanWorkflowName(name);
    this.bump();
    const relativePath = await project.saveDocument(`${this.name}.cxflow.json`, this.toBytes());
    if (relativePath) {
      this.savedPath = relativePath;
      this.savedRev = this.rev;
      this.requiresExplicitSave = false;
      this.migrationSourcePath = null;
    }
    return relativePath;
  }

  private configureComposition(update: Record<string, unknown>): void {
    const composition = this.requireGraphDomain().node('composition');
    if (!composition) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.configureNode('composition', {
      ...composition.config,
      ...update,
    }));
  }

  private nextGraphId(kind: 'node' | 'edge'): string {
    return this.graphIdGenerator?.(kind) ?? id(kind === 'node' ? 'asset' : 'connection');
  }

  private connectionEndpoints(from: string, to: string): Pick<WorkflowEdgeV2, 'source' | 'target'> | null {
    const domain = this.requireGraphDomain();
    const source = domain.node(from);
    const target = domain.node(to);
    if (!source || !target) return null;
    let compatible: Pick<WorkflowEdgeV2, 'source' | 'target'> | null = null;
    for (const sourcePort of source.ports.outputs) {
      for (const targetPort of target.ports.inputs) {
        if (sourcePort.dataType !== targetPort.dataType) continue;
        const endpoints = {
          source: { nodeId: from, portId: sourcePort.id },
          target: { nodeId: to, portId: targetPort.id },
        };
        compatible ??= endpoints;
        if (domain.validateConnection(endpoints).ok) return endpoints;
      }
    }
    const sourcePort = source.ports.outputs[0];
    const targetPort = target.ports.inputs[0];
    return compatible ?? (sourcePort && targetPort ? {
      source: { nodeId: from, portId: sourcePort.id },
      target: { nodeId: to, portId: targetPort.id },
    } : null);
  }

  private resetGraphDomain(): void {
    this.graphDomain = new WorkflowGraphDomain(this.domainGraphFromReactiveState(), {
      idGenerator: this.graphIdGenerator,
    });
    this.projectedGraphRevision = this.graphDomain.revision;
  }

  private async buildSelectivePreflight(
    mode: WorkflowSelectiveRunMode,
    nodeId: string,
    options: WorkflowStoreRunOptions,
    operation: ActiveWorkflowSelectiveOperation,
  ): Promise<WorkflowSelectivePreflightProjection> {
    const graph = this.serialize();
    const snapshot = this.captureSelectiveSnapshot(options);
    const placeholderKeys = Object.fromEntries(graph.nodes.map((node) => [node.id, `preflight:${node.id}`]));
    const draft = planSelectiveWorkflowExecution(graph, {
      mode,
      nodeId,
      materialKeys: placeholderKeys,
      isRunRecordReusable: () => false,
    });
    const materialKeys: Record<string, string> = {};
    const restrictions: Array<{ nodeId: string; kind: 'unavailable'; reason: string }> = [];
    for (const transformNodeId of draft.executionNodeIds) {
      const outputNodeId = this.campaignOutputForTransform(graph, transformNodeId);
      if (!outputNodeId) {
        restrictions.push({
          nodeId: transformNodeId,
          kind: 'unavailable',
          reason: 'Campaign Generate requires a directly connected Output.',
        });
        continue;
      }
      try {
        const prepared = await prepareCampaignGenerateTransform(graph, outputNodeId, {
          ...options,
          signal: operation.controller.signal,
        });
        this.requireCurrentSelectiveSnapshot(snapshot, options);
        if (prepared.transformNodeId !== transformNodeId) {
          throw new Error('Prepared Campaign Generate material belongs to a different node.');
        }
        materialKeys[transformNodeId] = prepared.materialKey;
      } catch (error) {
        if (operation.controller.signal.aborted) throw error;
        restrictions.push({
          nodeId: transformNodeId,
          kind: 'unavailable',
          reason: error instanceof WorkflowTransformExecutionError
            ? error.message
            : 'Campaign Generate material could not be prepared safely.',
        });
      }
    }

    const verifiedRunIds = new Set<string>();
    for (const transformNodeId of Object.keys(materialKeys)) {
      const node = graph.nodes.find((candidate) => candidate.id === transformNodeId);
      if (!node) continue;
      for (const runId of node.runRecordIds) {
        const record = graph.runRecords.find((candidate) => candidate.id === runId);
        if (!record || !isFullWorkflowRunRecord(record) || record.status !== 'succeeded'
          || record.materialKey !== materialKeys[transformNodeId] || record.outputs.length === 0) continue;
        let reusable = true;
        for (const output of record.outputs) {
          const asset = options.assets.find((candidate) => (
            candidate.id === output.assetId && candidate.relativePath === output.relativePath
          ));
          if (!asset) {
            reusable = false;
            break;
          }
          try {
            const material = await options.resolveAsset(asset);
            this.requireCurrentSelectiveSnapshot(snapshot, options);
            const resolvedBytes = material.bytes instanceof Uint8Array && material.bytes.length > 0
              ? material.bytes
              : null;
            const computedHash = resolvedBytes ? workflowSha256Bytes(resolvedBytes) : null;
            if (!resolvedBytes
              || material.assetId !== output.assetId
              || material.relativePath !== output.relativePath
              || material.contentHash !== output.contentHash
              || computedHash !== output.contentHash) {
              reusable = false;
              break;
            }
          } catch (error) {
            if (operation.controller.signal.aborted) throw error;
            reusable = false;
            break;
          }
        }
        if (reusable) verifiedRunIds.add(record.id);
      }
    }
    this.requireCurrentSelectiveSnapshot(snapshot, options);
    const plan = planSelectiveWorkflowExecution(graph, {
      mode,
      nodeId,
      materialKeys,
      ...(restrictions.length > 0
        ? { executionRestrictions: createWorkflowExecutionRestrictions(restrictions) }
        : {}),
      isRunRecordReusable: (record) => verifiedRunIds.has(record.id),
    });
    const stateByNodeId = Object.freeze(Object.fromEntries(
      plan.preflight.map((entry) => [entry.nodeId, entry]),
    ));
    const projection = Object.freeze({ plan, stateByNodeId });
    this.selectivePreflightSnapshots.set(projection, snapshot);
    return projection;
  }

  private selectiveProjectIdentity(options: WorkflowStoreRunOptions): string | null {
    return options.currentProjectIdentity?.() ?? options.projectPath;
  }

  private selectiveOptionsIdentity(options: WorkflowStoreRunOptions): string {
    const explicit = options.selectiveExecutionIdentity?.trim();
    return JSON.stringify({
      provider: options.provider,
      callerIdentity: explicit || null,
      executors: options.executors.map((executor) => ({
        provider: executor.provider,
        capabilities: [...executor.capabilities],
        materialization: executor.materialization ?? null,
      })),
      assets: options.assets.map((asset) => ({
        id: asset.id,
        relativePath: asset.relativePath,
        width: asset.width ?? null,
        height: asset.height ?? null,
        mime: asset.mime ?? null,
      })),
    });
  }

  private captureSelectiveSnapshot(options: WorkflowStoreRunOptions): WorkflowSelectivePreflightSnapshot {
    return {
      sessionIdentity: this.workflowSessionIdentity,
      graphRevision: this.graphRevision,
      storeRevision: this.rev,
      graphBytes: new TextDecoder().decode(this.toBytes()),
      projectIdentity: this.selectiveProjectIdentity(options),
      optionsIdentity: this.selectiveOptionsIdentity(options),
    };
  }

  private requireCurrentSelectiveSnapshot(
    snapshot: WorkflowSelectivePreflightSnapshot,
    options: WorkflowStoreRunOptions,
  ): void {
    if (snapshot.sessionIdentity !== this.workflowSessionIdentity
      || snapshot.graphRevision !== this.graphRevision
      || snapshot.storeRevision !== this.rev
      || snapshot.graphBytes !== new TextDecoder().decode(this.toBytes())
      || snapshot.projectIdentity !== this.selectiveProjectIdentity(options)) {
      throw new WorkflowTransformExecutionError(
        'CANCELLED',
        'The workflow or project changed after selective preflight.',
        'Run preflight again',
      );
    }
    if (snapshot.optionsIdentity !== this.selectiveOptionsIdentity(options)) {
      throw new WorkflowTransformExecutionError(
        'CANCELLED',
        'The provider or run options changed after selective preflight.',
        'Run preflight again',
      );
    }
  }

  private async beginSelectiveOperation(
    options: WorkflowStoreRunOptions,
  ): Promise<ActiveWorkflowSelectiveOperation> {
    let releaseLifecycle!: () => void;
    const lifecycleHeld = new Promise<void>((resolve) => { releaseLifecycle = resolve; });
    const previousLifecycle = this.selectiveLifecycleTail;
    this.selectiveLifecycleTail = previousLifecycle.catch(() => undefined).then(() => lifecycleHeld);
    await previousLifecycle.catch(() => undefined);
    try {
      const prior = this.activeSelectiveOperation;
      if (prior) {
        prior.controller.abort();
        await Promise.allSettled(
          [...prior.transformNodeIds].map((nodeId) => this.cancelCampaignGenerate(nodeId)),
        );
        await prior.completion;
      }
      const externalSignal = options.signal;
      const controller = new AbortController();
      const abortFromExternal = () => controller.abort();
      if (externalSignal?.aborted) controller.abort();
      else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
      const operation: ActiveWorkflowSelectiveOperation = {
        controller,
        transformNodeIds: new Set(),
        stopExternalAbort: () => externalSignal?.removeEventListener('abort', abortFromExternal),
        completion,
        resolveCompletion,
        supersededPrior: prior !== null,
      };
      this.activeSelectiveOperation = operation;
      return operation;
    } finally {
      releaseLifecycle();
    }
  }

  private finishSelectiveOperation(operation: ActiveWorkflowSelectiveOperation): void {
    try {
      operation.stopExternalAbort();
    } finally {
      if (this.activeSelectiveOperation === operation) this.activeSelectiveOperation = null;
      operation.resolveCompletion();
    }
  }

  private campaignOutputForTransform(graph: WorkflowGraphV2, transformNodeId: string): string | null {
    const edge = graph.edges.find((candidate) => (
      candidate.source.nodeId === transformNodeId
      && candidate.source.portId === 'result'
      && candidate.target.portId === 'source'
      && graph.nodes.some((node) => node.id === candidate.target.nodeId && node.type === 'output')
    ));
    return edge?.target.nodeId ?? null;
  }

  private beginWorkflowSession(): void {
    this.activeSelectiveOperation?.controller.abort();
    for (const run of this.activeTransformRuns.values()) {
      void this.cancelActiveTransformRun(run);
    }
    this.workflowSessionIdentity += 1;
    this.transformExecutions = {};
    this.activeTransformRuns.clear();
    this.transformStartQueues.clear();
    this.latestTransformRunSequences.clear();
    this.progressRouter.clear();
  }

  private cancelActiveTransformRun(
    run: ActiveWorkflowTransformRun,
  ): Promise<WorkflowCancellationResult> {
    if (run.cancellation) return run.cancellation;
    run.progressOpen = false;
    run.stopProgress?.();
    if (run.identity) this.progressRouter.close(run.identity);
    run.controller.abort();
    run.cancellation = resolveWorkflowCancellation(run.cancelExecution, run.cancellationTimeoutMs);
    return run.cancellation;
  }

  private requireGraphDomain(): WorkflowGraphDomain {
    if (!this.graphDomain) this.resetGraphDomain();
    return this.graphDomain!;
  }

  private publishGraphMutation<T>(domain: WorkflowGraphDomain, result: T): T {
    if (domain.revision !== this.projectedGraphRevision) {
      this.syncReactiveGraph(domain);
      this.bump();
      this.projectedGraphRevision = domain.revision;
    }
    return result;
  }

  private domainGraphFromReactiveState(): WorkflowGraphV2 {
    const composition: WorkflowNodeV2 = {
      id: 'composition',
      type: 'art-direction',
      title: this.compositionName || 'Composition',
      position: { x: this.promptX, y: this.promptY },
      size: { width: this.compositionWidth, height: this.compositionHeight },
      color: this.compositionColor,
      ports: {
        inputs: [{ id: 'assets', label: 'Assets', dataType: 'asset-reference', multiple: true }],
        outputs: [{ id: 'layout', label: 'Layout', dataType: 'layout' }],
      },
      config: {
        legacyKind: 'composition',
        displayName: this.compositionName,
        prompt: this.prompt,
        storyboardDataUrl: this.storyboardDataUrl,
        storyboardWidth: this.storyboardWidth,
        storyboardHeight: this.storyboardHeight,
        storyboardOraPath: this.storyboardOraPath,
        storyboardAnnotations: this.storyboardAnnotations,
        storyboardAnnotationItems: this.storyboardAnnotationItems,
        storyboardAnnotationsVisible: this.storyboardAnnotationsVisible,
      },
      runRecordIds: [],
    };
    const assets: WorkflowNodeV2[] = this.nodes.map((node) => ({
      id: node.id,
      type: 'input',
      title: node.name,
      position: { x: node.x, y: node.y },
      size: { width: node.width, height: node.height },
      color: node.color,
      ports: {
        inputs: [],
        outputs: [{ id: 'asset', label: 'Asset', dataType: 'asset-reference' }],
      },
      config: {
        legacyKind: 'asset',
        assetId: node.assetId,
        relativePath: node.relativePath,
        note: node.note,
      },
      runRecordIds: [],
    }));
    const outputs: WorkflowNodeV2[] = this.outputNodes.map((node, index) => ({
      id: node.id,
      type: 'output',
      title: node.name || 'Output',
      position: { x: node.x, y: node.y },
      size: { width: node.width, height: node.height },
      color: node.color,
      ports: {
        inputs: [{ id: 'source', label: 'Source', dataType: 'layout', required: true }],
        outputs: [],
      },
      config: {
        legacyKind: 'output',
        displayName: node.name,
        legacyX: index === 0 ? this.outputX : node.x,
        legacyY: index === 0 ? this.outputY : node.y,
        legacyWidth: index === 0 ? this.outputWidth : node.width,
        legacyHeight: index === 0 ? this.outputHeight : node.height,
        legacyColor: index === 0 ? this.outputColor : node.color,
        finalWidth: node.finalWidth,
        finalHeight: node.finalHeight,
        outputAssetId: node.outputAssetId,
        outputRelativePath: node.outputRelativePath,
      },
      runRecordIds: [],
    }));
    return {
      version: WORKFLOW_GRAPH_VERSION,
      id: 'workflow-active',
      metadata: { name: this.name, sourceVersion: null, migrations: [] },
      viewport: { panX: this.panX, panY: this.panY, zoom: this.zoom },
      nodes: [...assets, composition, ...outputs],
      edges: this.connections.map((connection) => ({
        id: connection.id,
        source: {
          nodeId: connection.from,
          portId: connection.from === 'composition' ? 'layout' : 'asset',
        },
        target: {
          nodeId: connection.to,
          portId: connection.to === 'composition' ? 'assets' : 'source',
        },
      })),
      assetReferences: [],
      runRecords: [],
    };
  }

  private syncReactiveGraph(domain: WorkflowGraphDomain, roundLegacyGeometry = false): void {
    const composition = domain.node('composition');
    if (composition) {
      const storyboard = recordValue(composition.config.storyboard);
      this.compositionName = typeof composition.config.displayName === 'string'
        ? composition.config.displayName
        : composition.title;
      this.promptX = roundLegacyGeometry ? roundWorkflowNumber(composition.position.x) : composition.position.x;
      this.promptY = roundLegacyGeometry ? roundWorkflowNumber(composition.position.y) : composition.position.y;
      this.compositionWidth = composition.size.width;
      this.compositionHeight = composition.size.height;
      this.compositionColor = composition.color;
      this.prompt = typeof composition.config.prompt === 'string' ? composition.config.prompt : '';
      const storyboardDataUrl = composition.config.storyboardDataUrl ?? storyboard.dataUrl;
      this.storyboardDataUrl = typeof storyboardDataUrl === 'string'
        ? storyboardDataUrl
        : null;
      const storyboardWidth = composition.config.storyboardWidth ?? storyboard.width;
      this.storyboardWidth = typeof storyboardWidth === 'number'
        ? storyboardWidth
        : 1024;
      const storyboardHeight = composition.config.storyboardHeight ?? storyboard.height;
      this.storyboardHeight = typeof storyboardHeight === 'number'
        ? storyboardHeight
        : 768;
      const storyboardOraPath = composition.config.storyboardOraPath ?? storyboard.oraPath;
      this.storyboardOraPath = typeof storyboardOraPath === 'string'
        ? storyboardOraPath
        : null;
      const storyboardAnnotations = composition.config.storyboardAnnotations ?? storyboard.annotations;
      this.storyboardAnnotations = Array.isArray(storyboardAnnotations)
        ? storyboardAnnotations.filter((item): item is string => typeof item === 'string')
        : [];
      this.storyboardAnnotationItems = coerceAnnotations(composition.config.storyboardAnnotationItems ?? storyboard.annotationItems);
      this.storyboardAnnotationsVisible = (composition.config.storyboardAnnotationsVisible ?? storyboard.annotationsVisible) !== false;
    }
    const references = new Map(domain.graph.assetReferences.map((reference) => [reference.id, reference]));
    this.nodes = domain.graph.nodes
      .filter((node) => node.type === 'input' || node.config.legacyKind === 'asset')
      .map((node) => {
        const reference = typeof node.config.assetReferenceId === 'string'
          ? references.get(node.config.assetReferenceId)
          : undefined;
        return {
          id: node.id,
          assetId: typeof node.config.assetId === 'string' ? node.config.assetId : reference?.assetId ?? null,
          name: node.title,
          relativePath: typeof node.config.relativePath === 'string' ? node.config.relativePath : reference?.relativePath ?? '',
          x: roundLegacyGeometry ? roundWorkflowNumber(node.position.x) : node.position.x,
          y: roundLegacyGeometry ? roundWorkflowNumber(node.position.y) : node.position.y,
          width: node.size.width,
          height: node.size.height,
          color: node.color,
          included: domain.isConnected(node.id, 'composition'),
          note: typeof node.config.note === 'string'
            ? node.config.note
            : typeof node.config.role === 'string' ? node.config.role : '',
          slotId: typeof node.config.slotId === 'string' ? node.config.slotId : null,
          required: node.config.required === true,
          guidance: typeof node.config.role === 'string' ? node.config.role : '',
          creatorInput: node.config.creatorRole === 'input',
        };
      });
    this.briefNodes = domain.graph.nodes
      .filter((node) => node.type === 'brief')
      .map((node) => ({
        id: node.id,
        name: node.title,
        objective: typeof node.config.objective === 'string' ? node.config.objective : '',
        guidance: typeof node.config.guidance === 'string' ? node.config.guidance : '',
        x: roundLegacyGeometry ? roundWorkflowNumber(node.position.x) : node.position.x,
        y: roundLegacyGeometry ? roundWorkflowNumber(node.position.y) : node.position.y,
        width: node.size.width,
        height: node.size.height,
        color: node.color,
      }));
    this.creatorNodes = domain.graph.nodes
      .filter((node): node is WorkflowNodeV2 & { type: WorkflowCreatorNode['type'] } => (
        node.type === 'transform'
        || node.type === 'review'
        || (node.type === 'art-direction' && node.id !== 'composition')
      ))
      .map((node) => ({
        id: node.id,
        type: node.type,
        name: node.title,
        x: roundLegacyGeometry ? roundWorkflowNumber(node.position.x) : node.position.x,
        y: roundLegacyGeometry ? roundWorkflowNumber(node.position.y) : node.position.y,
        width: node.size.width,
        height: node.size.height,
        color: node.color,
        ports: {
          inputs: node.ports.inputs.map((port) => ({ ...port })),
          outputs: node.ports.outputs.map((port) => ({ ...port })),
        },
        config: { ...node.config },
      }));
    this.unsupportedNodes = domain.graph.nodes
      .filter((node) => node.type === 'unsupported')
      .map((node) => ({
        id: node.id,
        name: node.title,
        unsupportedType: typeof node.config.unsupportedType === 'string' ? node.config.unsupportedType : 'unknown',
        x: roundLegacyGeometry ? roundWorkflowNumber(node.position.x) : node.position.x,
        y: roundLegacyGeometry ? roundWorkflowNumber(node.position.y) : node.position.y,
        width: node.size.width,
        height: node.size.height,
        color: node.color,
        ports: {
          inputs: node.ports.inputs.map((port) => ({ ...port })),
          outputs: node.ports.outputs.map((port) => ({ ...port })),
        },
        config: { ...node.config },
        runnable: false as const,
      }));
    this.outputNodes = domain.graph.nodes
      .filter((node) => node.type === 'output' || node.config.legacyKind === 'output')
      .map((node) => {
        const reference = typeof node.config.assetReferenceId === 'string'
          ? references.get(node.config.assetReferenceId)
          : undefined;
        const hasOutputAssetId = Object.prototype.hasOwnProperty.call(node.config, 'outputAssetId');
        const hasOutputRelativePath = Object.prototype.hasOwnProperty.call(node.config, 'outputRelativePath');
        return {
          id: node.id,
          name: typeof node.config.displayName === 'string' ? node.config.displayName : node.title,
          x: roundLegacyGeometry ? roundWorkflowNumber(node.position.x) : node.position.x,
          y: roundLegacyGeometry ? roundWorkflowNumber(node.position.y) : node.position.y,
          width: node.size.width,
          height: node.size.height,
          color: node.color,
          finalWidth: typeof node.config.finalWidth === 'number' ? node.config.finalWidth : 1024,
          finalHeight: typeof node.config.finalHeight === 'number' ? node.config.finalHeight : 1024,
          outputAssetId: hasOutputAssetId
            ? typeof node.config.outputAssetId === 'string' ? node.config.outputAssetId : null
            : reference?.assetId ?? null,
          outputRelativePath: hasOutputRelativePath
            ? typeof node.config.outputRelativePath === 'string' ? node.config.outputRelativePath : null
            : reference?.relativePath ?? null,
        };
      });
    this.connections = domain.graph.edges.map((edge) => ({
      id: edge.id,
      from: edge.source.nodeId,
      to: edge.target.nodeId,
      sourcePortId: edge.source.portId,
      targetPortId: edge.target.portId,
    }));
    const firstOutput = this.outputNodes[0] ?? defaultOutputNode();
    this.outputName = firstOutput.name;
    const firstOutputDomain = domain.node(firstOutput.id);
    this.outputWidth = typeof firstOutputDomain?.config.legacyWidth === 'number'
      ? firstOutputDomain.config.legacyWidth
      : firstOutput.width;
    this.outputHeight = typeof firstOutputDomain?.config.legacyHeight === 'number'
      ? firstOutputDomain.config.legacyHeight
      : firstOutput.height;
    this.outputColor = typeof firstOutputDomain?.config.legacyColor === 'string'
      ? firstOutputDomain.config.legacyColor
      : firstOutput.color;
    this.outputX = typeof firstOutputDomain?.config.legacyX === 'number'
      ? firstOutputDomain.config.legacyX
      : firstOutput.x;
    this.outputY = typeof firstOutputDomain?.config.legacyY === 'number'
      ? firstOutputDomain.config.legacyY
      : firstOutput.y;
    this.outputAssetId = firstOutput.outputAssetId;
    this.outputRelativePath = firstOutput.outputRelativePath;
  }

  private bump(): void {
    this.rev++;
  }
}

export const workflow = new WorkflowStore();
