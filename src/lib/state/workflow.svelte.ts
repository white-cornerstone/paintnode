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
  type WorkflowDirectorProposal,
  type WorkflowDirectorSessionToken,
  createWorkflowDirectorPatchProposal,
  type WorkflowDirectorPatchProposal,
  type WorkflowDirectorPatchProposalResult,
} from '../workflow';

export interface WorkflowTransformExecutionState {
  state: 'idle' | 'running' | 'succeeded' | 'failed';
  message: string;
  assetId: string | null;
}

export interface WorkflowTransformStoreOutcome extends WorkflowTransformExecutionOutcome {
  committed: boolean;
  commitMessage: string;
}

export interface WorkflowStoreRunOptions extends ExecuteCampaignGenerateOptions {
  currentProjectIdentity?: () => string | null;
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

interface WorkflowDirectorPatchReview {
  proposal: WorkflowDirectorPatchProposal;
  session: WorkflowDirectorSessionToken;
  sourceBytes: string;
}

interface WorkflowDirectorPatchSnapshot {
  graph: WorkflowGraphV2;
  graphRevision: number;
  storeRevision: number;
}

interface WorkflowDirectorPatchTransaction {
  before: WorkflowDirectorPatchSnapshot;
  after: WorkflowDirectorPatchSnapshot;
  sessionIdentity: number;
}

interface WorkflowSaveSubmission {
  bytes: Uint8Array;
  serializedBytes: string;
  storeRevision: number;
  sessionIdentity: number;
  projectIdentity: string;
  pathIntentIdentity: number;
}

function workflowGraphBytes(graph: WorkflowGraphV2): string {
  return new WorkflowGraphDomain(graph).serialize();
}

function immutableWorkflowHistoryBytes(graph: WorkflowGraphV2): string {
  return JSON.stringify({
    assetReferences: graph.assetReferences,
    runRecords: graph.runRecords,
    runRecordLinks: graph.nodes
      .filter((node) => node.runRecordIds.length > 0)
      .map((node) => [node.id, node.runRecordIds]),
  });
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
  private workflowSessionIdentity = $state(0);
  private workflowMutationIdentity = $state(0);
  private readonly activeTransformRuns = new Map<string, number>();
  private pendingDirectorPatchReview: WorkflowDirectorPatchReview | null = null;
  private directorPatchUndoStack: WorkflowDirectorPatchTransaction[] = [];
  private directorPatchRedoStack: WorkflowDirectorPatchTransaction[] = [];
  private savedWorkflowBytes = $state<string | null>(null);
  private savePathIntentSequence = 0;
  private activeSavePathIntentIdentity = 0;
  private activeSavePathIntentTarget: string | null = null;

  constructor(options: WorkflowStoreOptions = {}) {
    this.graphIdGenerator = options.idGenerator;
    this.workflowGraphIdGenerator = options.workflowGraphIdGenerator;
  }

  get dirty(): boolean {
    this.rev;
    return this.savedWorkflowBytes === null
      ? this.rev !== this.savedRev
      : workflowGraphBytes(this.serialize()) !== this.savedWorkflowBytes;
  }

  get graphRevision(): number {
    return this.graphDomain?.revision ?? 0;
  }

  get pendingDirectorPatchProposal(): WorkflowDirectorPatchProposal | null {
    return this.pendingDirectorPatchReview?.proposal ?? null;
  }

  get canUndoDirectorPatch(): boolean {
    const transaction = this.directorPatchUndoStack.at(-1);
    return transaction !== undefined
      && transaction.sessionIdentity === this.workflowSessionIdentity
      && this.matchesDirectorPatchSnapshot(transaction.after);
  }

  get canRedoDirectorPatch(): boolean {
    const transaction = this.directorPatchRedoStack.at(-1);
    return transaction !== undefined
      && transaction.sessionIdentity === this.workflowSessionIdentity
      && this.matchesDirectorPatchSnapshot(transaction.before);
  }

  captureDirectorSession(): WorkflowDirectorSessionToken {
    return Object.freeze({
      sessionIdentity: this.workflowSessionIdentity,
      mutationIdentity: this.workflowMutationIdentity,
      graphRevision: this.graphRevision,
      storeRevision: this.rev,
    });
  }

  createDirectorPatchProposal(response: unknown): WorkflowDirectorPatchProposalResult {
    const graph = this.serialize();
    const domain = this.requireGraphDomain();
    const session = this.captureDirectorSession();
    const result = createWorkflowDirectorPatchProposal(response, graph, domain.contentRevision);
    this.pendingDirectorPatchReview = result.proposal
      ? {
          proposal: result.proposal,
          session,
          sourceBytes: workflowGraphBytes(graph),
        }
      : null;
    return result;
  }

  rejectDirectorPatchProposal(): void {
    this.pendingDirectorPatchReview = null;
  }

  acceptDirectorPatchProposal(): WorkflowDirectorPatchProposal {
    const review = this.pendingDirectorPatchReview;
    if (!review) throw new Error('There is no pending AI Director patch proposal to accept.');
    const currentSession = this.captureDirectorSession();
    const currentGraph = this.serialize();
    if (
      review.session.sessionIdentity !== currentSession.sessionIdentity
      || review.session.mutationIdentity !== currentSession.mutationIdentity
      || review.session.graphRevision !== currentSession.graphRevision
      || review.session.storeRevision !== currentSession.storeRevision
      || review.sourceBytes !== workflowGraphBytes(currentGraph)
      || review.proposal.sourceGraphRevision.graphId !== currentGraph.id
      || review.proposal.sourceGraphRevision.revision !== currentSession.graphRevision
    ) {
      this.pendingDirectorPatchReview = null;
      throw new Error('The workflow changed while this AI Director patch was being reviewed. Draft again before accepting.');
    }
    if (review.proposal.targetGraphRevision.graphId !== currentGraph.id
      || review.proposal.targetGraphRevision.revision !== currentSession.graphRevision + 1) {
      this.pendingDirectorPatchReview = null;
      throw new Error('The AI Director patch target revision is stale or invalid.');
    }
    if (immutableWorkflowHistoryBytes(currentGraph) !== immutableWorkflowHistoryBytes(review.proposal.graph)) {
      this.pendingDirectorPatchReview = null;
      throw new Error('AI Director patches cannot modify accepted candidates or workflow run history.');
    }

    const before = this.captureDirectorPatchSnapshot();
    // Validate the complete target and its exact content revision before any
    // reactive or history state is changed.
    const nextDomain = new WorkflowGraphDomain(review.proposal.graph, {
      idGenerator: this.graphIdGenerator,
      initialRevision: review.proposal.targetGraphRevision.revision,
    });
    const after: WorkflowDirectorPatchSnapshot = {
      graph: nextDomain.graph,
      graphRevision: nextDomain.revision,
      storeRevision: before.storeRevision + 1,
    };

    try {
      this.publishDirectorPatchSnapshot(after, nextDomain);
    } catch (error) {
      this.publishDirectorPatchSnapshot(before);
      throw error;
    }
    this.pendingDirectorPatchReview = null;
    this.directorPatchUndoStack.push({
      before,
      after,
      sessionIdentity: this.workflowSessionIdentity,
    });
    this.directorPatchRedoStack = [];
    this.workflowMutationIdentity += 1;
    return review.proposal;
  }

  undoDirectorPatch(): boolean {
    const transaction = this.directorPatchUndoStack.at(-1);
    if (!transaction) return false;
    if (transaction.sessionIdentity !== this.workflowSessionIdentity
      || !this.matchesDirectorPatchSnapshot(transaction.after)) {
      this.clearDirectorPatchHistory();
      return false;
    }
    this.directorPatchUndoStack.pop();
    this.publishDirectorPatchSnapshot(transaction.before);
    this.workflowMutationIdentity += 1;
    this.pendingDirectorPatchReview = null;
    this.directorPatchRedoStack.push(transaction);
    return true;
  }

  redoDirectorPatch(): boolean {
    const transaction = this.directorPatchRedoStack.at(-1);
    if (!transaction) return false;
    if (transaction.sessionIdentity !== this.workflowSessionIdentity
      || !this.matchesDirectorPatchSnapshot(transaction.before)) {
      this.clearDirectorPatchHistory();
      return false;
    }
    this.directorPatchRedoStack.pop();
    this.publishDirectorPatchSnapshot(transaction.after);
    this.workflowMutationIdentity += 1;
    this.pendingDirectorPatchReview = null;
    this.directorPatchUndoStack.push(transaction);
    return true;
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
    this.captureCurrentSavedBaseline();
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
    this.captureCurrentSavedBaseline();
  }

  applyDirectorProposal(
    proposal: WorkflowDirectorProposal,
    expectedSession?: WorkflowDirectorSessionToken,
  ): void {
    if (expectedSession && (
      expectedSession.sessionIdentity !== this.workflowSessionIdentity
      || expectedSession.mutationIdentity !== this.workflowMutationIdentity
      || expectedSession.graphRevision !== this.graphRevision
      || expectedSession.storeRevision !== this.rev
    )) {
      throw new Error('The workflow changed while this AI Director proposal was being reviewed. Draft again before accepting.');
    }
    if (!proposal.canAccept || proposal.issues.length > 0) {
      throw new Error('This AI Director proposal cannot be accepted until every validation issue is resolved.');
    }
    if (proposal.graph.nodes.some((node) => node.type === 'unsupported')
      || proposal.graph.assetReferences.length > 0
      || proposal.graph.runRecords.length > 0
      || proposal.graph.nodes.some((node) => node.runRecordIds.length > 0)) {
      throw new Error('This AI Director proposal cannot be accepted because it is not a fresh creator workflow.');
    }
    // Build and validate the complete replacement before touching session or
    // reactive state. A failure therefore leaves the current workflow intact.
    const nextDomain = new WorkflowGraphDomain(proposal.graph, { idGenerator: this.graphIdGenerator });
    const primaryArtDirection = nextDomain.graph.nodes.find((node) => node.type === 'art-direction') ?? null;

    this.beginWorkflowSession();
    this.active = true;
    ui.showWorkflow();
    this.name = nextDomain.graph.metadata.name;
    this.savedPath = null;
    this.migrationSourcePath = null;
    this.requiresExplicitSave = false;
    this.connectionError = null;
    this.tool = 'hand';
    this.zoomMode = 'in';
    this.selection = primaryArtDirection?.id === 'composition'
      ? { kind: 'composition' }
      : primaryArtDirection
        ? { kind: 'creator', id: primaryArtDirection.id }
        : null;
    this.storyboardEditing = false;
    this.storyboardTool = 'brush';
    this.panX = nextDomain.graph.viewport.panX;
    this.panY = nextDomain.graph.viewport.panY;
    this.zoom = nextDomain.graph.viewport.zoom;
    this.graphDomain = nextDomain;
    this.projectedGraphRevision = nextDomain.revision;
    this.syncReactiveGraph(nextDomain);
    this.rev = 1;
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

  transformExecution(nodeId: string): WorkflowTransformExecutionState {
    return this.transformExecutions[nodeId] ?? { state: 'idle', message: '', assetId: null };
  }

  async runCampaignGenerate(
    outputNodeId: string,
    options: WorkflowStoreRunOptions,
  ): Promise<WorkflowTransformStoreOutcome> {
    const graph = this.serialize();
    const sessionIdentity = this.workflowSessionIdentity;
    const mutationIdentity = this.workflowMutationIdentity;
    const graphRevision = this.graphRevision;
    const storeRevision = this.rev;
    const projectIdentity = options.currentProjectIdentity?.() ?? options.projectPath;
    const outputEdge = graph.edges.find((edge) => edge.target.nodeId === outputNodeId && edge.target.portId === 'source');
    const transformNodeId = outputEdge?.source.nodeId ?? 'transform';
    const run = ++this.transformRunSequence;
    this.activeTransformRuns.set(transformNodeId, run);
    this.transformExecutions = {
      ...this.transformExecutions,
      [transformNodeId]: { state: 'running', message: 'Generating…', assetId: null },
    };
    try {
      const outcome = await executeCampaignGenerateTransform(graph, outputNodeId, options);
      let commitMessage = '';
      if (this.workflowSessionIdentity !== sessionIdentity) {
        commitMessage = 'The workflow session changed while Generate was running. The result was not applied.';
      } else if (this.workflowMutationIdentity !== mutationIdentity) {
        commitMessage = 'The workflow changed while Generate was running. The result was not applied.';
      } else if (this.activeTransformRuns.get(transformNodeId) !== run) {
        commitMessage = 'A newer Generate run replaced this result before it could be applied.';
      } else if (this.graphRevision !== graphRevision || this.rev !== storeRevision) {
        commitMessage = 'The workflow changed while Generate was running. The result was not applied.';
      } else if ((options.currentProjectIdentity?.() ?? options.projectPath) !== projectIdentity) {
        commitMessage = 'The active project changed while Generate was running. The result was not applied.';
      }
      if (commitMessage) {
        commitMessage += ` The generated asset remains available at ${outcome.asset.relativePath}.`;
        if (
          this.workflowSessionIdentity === sessionIdentity
          && this.activeTransformRuns.get(transformNodeId) === run
        ) {
          this.transformExecutions = {
            ...this.transformExecutions,
            [transformNodeId]: { state: 'failed', message: commitMessage, assetId: null },
          };
        }
        return { ...outcome, committed: false, commitMessage };
      }
      if (this.activeTransformRuns.get(transformNodeId) === run) {
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
      if (this.activeTransformRuns.get(transformNodeId) === run) {
        this.transformExecutions = {
          ...this.transformExecutions,
          [transformNodeId]: {
            state: 'failed', message: (error as Error)?.message ?? String(error), assetId: null,
          },
        };
      }
      throw error;
    }
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
    this.rev = 0;
    this.savedRev = 0;
    this.captureCurrentSavedBaseline();
  }

  async save(): Promise<string | null> {
    if (!project.path) return null;
    const name = `${this.name || 'workflow'}${this.requiresExplicitSave ? '-v2' : ''}.cxflow.json`;
    const savedPath = this.savedPath;
    const submission = this.captureSaveSubmission(savedPath, savedPath === null);
    const relativePath = savedPath
      ? await project.saveDocumentToPath(savedPath, submission.bytes)
      : await project.saveDocument(name, submission.bytes);
    this.reconcileSaveCompletion(submission, relativePath);
    return relativePath;
  }

  async saveAs(name: string): Promise<string | null> {
    if (!project.path) return null;
    this.name = cleanWorkflowName(name);
    this.bump();
    const submission = this.captureSaveSubmission(null, true);
    const relativePath = await project.saveDocument(`${this.name}.cxflow.json`, submission.bytes);
    this.reconcileSaveCompletion(submission, relativePath);
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

  private beginWorkflowSession(): void {
    this.workflowSessionIdentity += 1;
    this.workflowMutationIdentity += 1;
    this.savedWorkflowBytes = null;
    this.activeSavePathIntentIdentity = ++this.savePathIntentSequence;
    this.activeSavePathIntentTarget = null;
    this.transformExecutions = {};
    this.activeTransformRuns.clear();
    this.pendingDirectorPatchReview = null;
    this.clearDirectorPatchHistory();
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

  private captureDirectorPatchSnapshot(): WorkflowDirectorPatchSnapshot {
    return {
      graph: this.serialize(),
      graphRevision: this.graphRevision,
      storeRevision: this.rev,
    };
  }

  private publishDirectorPatchSnapshot(
    snapshot: WorkflowDirectorPatchSnapshot,
    preparedDomain?: WorkflowGraphDomain,
  ): void {
    const domain = preparedDomain ?? new WorkflowGraphDomain(snapshot.graph, {
      idGenerator: this.graphIdGenerator,
      initialRevision: snapshot.graphRevision,
    });
    if (domain.graph.id !== snapshot.graph.id || domain.revision !== snapshot.graphRevision) {
      throw new Error('The AI Director patch transaction snapshot has an invalid graph revision.');
    }
    this.name = domain.graph.metadata.name;
    this.panX = domain.graph.viewport.panX;
    this.panY = domain.graph.viewport.panY;
    this.zoom = domain.graph.viewport.zoom;
    this.syncReactiveGraph(domain);
    this.graphDomain = domain;
    this.projectedGraphRevision = domain.revision;
    this.rev = snapshot.storeRevision;
  }

  private matchesDirectorPatchSnapshot(snapshot: WorkflowDirectorPatchSnapshot): boolean {
    return this.graphRevision === snapshot.graphRevision
      && this.rev === snapshot.storeRevision
      && workflowGraphBytes(this.serialize()) === workflowGraphBytes(snapshot.graph);
  }

  private captureCurrentSavedBaseline(): void {
    this.savedWorkflowBytes = workflowGraphBytes(this.serialize());
    this.activeSavePathIntentIdentity = ++this.savePathIntentSequence;
    this.activeSavePathIntentTarget = this.savedPath;
  }

  private captureSaveSubmission(
    targetPath: string | null,
    createsPath: boolean,
  ): WorkflowSaveSubmission {
    if (createsPath || targetPath !== this.activeSavePathIntentTarget) {
      this.activeSavePathIntentIdentity = ++this.savePathIntentSequence;
      this.activeSavePathIntentTarget = targetPath;
    }
    const bytes = this.toBytes();
    return {
      bytes,
      serializedBytes: new TextDecoder().decode(bytes),
      storeRevision: this.rev,
      sessionIdentity: this.workflowSessionIdentity,
      projectIdentity: project.identity,
      pathIntentIdentity: this.activeSavePathIntentIdentity,
    };
  }

  private reconcileSaveCompletion(
    submission: WorkflowSaveSubmission,
    relativePath: string | null,
  ): void {
    if (!relativePath
      || submission.sessionIdentity !== this.workflowSessionIdentity
      || submission.projectIdentity !== project.identity) return;
    if (submission.pathIntentIdentity !== this.activeSavePathIntentIdentity
      && relativePath !== this.activeSavePathIntentTarget) return;
    this.activeSavePathIntentTarget = relativePath;
    this.savedPath = relativePath;
    this.savedRev = submission.storeRevision;
    this.savedWorkflowBytes = submission.serializedBytes;
    this.requiresExplicitSave = false;
    this.migrationSourcePath = null;
  }

  private clearDirectorPatchHistory(): void {
    this.directorPatchUndoStack = [];
    this.directorPatchRedoStack = [];
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
    this.clearDirectorPatchHistory();
    this.workflowMutationIdentity += 1;
    this.rev++;
  }
}

export const workflow = new WorkflowStore();
