import type { ProjectAsset, ProjectFile, WorkflowEditorReturnResult } from '../integrations/desktop';
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
  assertFreshWorkflowDirectorPatchProposal,
  workflowDirectorProtectedReviewHistoryBytes,
  type WorkflowDirectorPatchProposal,
  type WorkflowDirectorPatchProposalResult,
  assertFreshWorkflowDirectorProposal,
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
  workflowSha256Text,
  isFullWorkflowRunRecord,
  type WorkflowSelectiveRunMode,
  type WorkflowSelectiveExecutionPlan,
  type WorkflowSelectiveExecutionOutcome,
  type WorkflowNodePreflight,
  type WorkflowRunRecordV1,
  type WorkflowRunOutput,
  executeWorkflowCandidateBranches,
  retryWorkflowCandidateBranch,
  deriveWorkflowCandidateBranchGroups,
  type WorkflowCandidateBranchExecutionOptions,
  type WorkflowCandidateBranchExecutionOutcome,
  type WorkflowCandidateBranchGroup,
  type WorkflowCandidateSummary,
  deriveWorkflowReviewCandidates,
  promoteWorkflowCandidate,
  type WorkflowReviewCandidate,
  type WorkflowProjectAsset,
  resolveWorkflowCampaignPath,
  resolveWorkflowReviewTopology,
  appendWorkflowEditorRevision,
  resolveWorkflowEffectiveResult,
  type WorkflowEditableResultIdentity,
  type WorkflowEditorRevisionV1,
  type WorkflowRoundTripBindingV1,
} from '../workflow';
import {
  bindWorkflowRoundTripAuthority,
  workflowRoundTripAuthority,
  workflowRoundTripSessionsForWorkflow,
  type WorkflowRoundTripAuthorityInput,
} from './workflowEditorSession';

function workflowEditorContextKey(graph: WorkflowGraphV2, nodeId: string): string {
  const relevantIds = new Set([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of graph.edges) {
      if (!relevantIds.has(edge.target.nodeId) || relevantIds.has(edge.source.nodeId)) continue;
      relevantIds.add(edge.source.nodeId);
      changed = true;
    }
  }
  const runtimeConfigKeys = new Set([
    'resultAssetReferenceId', 'resultAssetId', 'resultRelativePath',
    'assetReferenceId', 'outputAssetId', 'outputRelativePath',
  ]);
  const nodes = graph.nodes
    .filter((node) => relevantIds.has(node.id))
    .map((node) => ({
      id: node.id,
      type: node.type,
      ports: node.ports,
      config: Object.fromEntries(Object.entries(node.config).filter(([key]) => !runtimeConfigKeys.has(key))),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const edges = graph.edges
    .filter((edge) => relevantIds.has(edge.source.nodeId) && relevantIds.has(edge.target.nodeId))
    .map((edge) => ({ source: edge.source, target: edge.target }))
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return workflowSha256Text(JSON.stringify({ nodeId, nodes, edges }));
}

export interface WorkflowTransformExecutionState {
  state: 'idle' | 'queued' | 'running' | 'cancelling' | 'cancelled' | 'succeeded' | 'failed' | 'stale';
  message: string;
  assetId: string | null;
}

export interface WorkflowTransformStoreOutcome extends WorkflowTransformExecutionOutcome {
  committed: boolean;
  commitMessage: string;
}

export interface WorkflowCandidateBranchStoreOutcome extends WorkflowCandidateBranchExecutionOutcome {
  committed: boolean;
  commitMessage: string;
}

export interface WorkflowCandidateRetryStoreOutcome {
  graph: WorkflowGraphV2;
  candidate: WorkflowCandidateSummary;
  committed: boolean;
  commitMessage: string;
}

export interface WorkflowStoreRunOptions extends ExecuteCampaignGenerateOptions {
  currentProjectIdentity?: () => string | null;
  selectiveExecutionIdentity?: string;
  cancelExecutionForRun?: (runId: string) => Promise<unknown>;
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

export interface WorkflowEditorOpenDescriptor {
  authority: WorkflowRoundTripAuthorityInput;
  output: { assetReferenceId: string; assetId: string; relativePath: string; contentHash: string };
  documentRelativePath: string | null;
  documentContentHash: string | null;
  editorRevisionId: string | null;
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

interface WorkflowReviewVerification {
  graphRevision: number;
  projectIdentity: string | null;
  assetFingerprint: string;
  materialKey: string;
  verifiedOutputIds: string[];
  optionsIdentity: string;
}

export interface WorkflowAssetNode {
  id: string;
  assetId: string | null;
  name: string;
  relativePath: string;
  oraRelativePath: string | null;
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
  type: 'art-direction' | 'extract-assets' | 'transform' | 'review';
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
    reviewPromotions: graph.reviewPromotions,
    editorRevisions: graph.editorRevisions,
    workflowRoundTrips: graph.workflowRoundTrips,
    runRecordLinks: graph.nodes
      .filter((node) => node.runRecordIds.length > 0)
      .map((node) => [node.id, node.runRecordIds]),
  });
}

function currentRoundTripBinding(
  graph: WorkflowGraphV2,
  identity: WorkflowEditableResultIdentity,
): WorkflowRoundTripBindingV1 | null {
  const matching = (graph.workflowRoundTrips ?? []).filter((binding) => (
    binding.target.nodeId === identity.nodeId
    && binding.target.rootRunId === identity.rootRunId
    && binding.target.promotionId === identity.promotionId
  ));
  const superseded = new Set(matching.map((binding) => binding.supersedesRoundTripId).filter(Boolean));
  const heads = matching.filter((binding) => !superseded.has(binding.id));
  return heads.length === 1 ? heads[0] : null;
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
  reviewVerifications = $state<Record<string, WorkflowReviewVerification>>({});
  private graphDomain: WorkflowGraphDomain | null = null;
  private readonly graphIdGenerator: WorkflowIdGenerator | undefined;
  private readonly workflowGraphIdGenerator: (() => string) | undefined;
  private projectedGraphRevision = 0;
  private transformRunSequence = 0;
  private workflowSessionIdentity = $state(0);
  private workflowMutationIdentity = $state(0);
  private readonly activeTransformRuns = new Map<string, ActiveWorkflowTransformRun>();
  private pendingDirectorPatchReview: WorkflowDirectorPatchReview | null = null;
  private directorPatchUndoStack: WorkflowDirectorPatchTransaction[] = [];
  private directorPatchRedoStack: WorkflowDirectorPatchTransaction[] = [];
  private savedWorkflowBytes = $state<string | null>(null);
  private savePathIntentSequence = 0;
  private activeSavePathIntentIdentity = 0;
  private activeSavePathIntentTarget: string | null = null;
  private readonly transformStartQueues = new Map<string, Promise<void>>();
  private readonly latestTransformRunSequences = new Map<string, number>();
  private readonly progressRouter = new WorkflowRunProgressRouter();
  private readonly selectivePreflightSnapshots = new WeakMap<object, WorkflowSelectivePreflightSnapshot>();
  private readonly reviewVerificationSequences = new Map<string, number>();
  private activeSelectiveOperation: ActiveWorkflowSelectiveOperation | null = null;
  private selectiveLifecycleTail: Promise<void> = Promise.resolve();

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
    const validatedGraph = assertFreshWorkflowDirectorPatchProposal(review.proposal);
    if (immutableWorkflowHistoryBytes(currentGraph) !== immutableWorkflowHistoryBytes(validatedGraph)) {
      this.pendingDirectorPatchReview = null;
      throw new Error('AI Director patches cannot modify accepted candidates or workflow run history.');
    }
    if (workflowDirectorProtectedReviewHistoryBytes(currentGraph)
      !== workflowDirectorProtectedReviewHistoryBytes(validatedGraph)) {
      this.pendingDirectorPatchReview = null;
      throw new Error('AI Director patches cannot remove or reconnect an accepted Review path.');
    }

    const before = this.captureDirectorPatchSnapshot();
    // Validate the complete target and its exact content revision before any
    // reactive or history state is changed.
    const nextDomain = new WorkflowGraphDomain(validatedGraph, {
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
    this.assertWorkflowReplacementAllowed();
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
    this.assertWorkflowReplacementAllowed();
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
    this.selection = graph.nodes.some((node) => node.id === 'composition') ? { kind: 'composition' } : null;
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
    const validatedGraph = assertFreshWorkflowDirectorProposal(proposal);
    // Build and validate the complete replacement before touching session or
    // reactive state. A failure therefore leaves the current workflow intact.
    const nextDomain = new WorkflowGraphDomain(validatedGraph, { idGenerator: this.graphIdGenerator });
    const primaryArtDirection = nextDomain.graph.nodes.find((node) => node.type === 'art-direction') ?? null;

    this.assertWorkflowReplacementAllowed();
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

  close(): boolean {
    const workflowId = this.graphDomain?.graph.id;
    if (workflowId && workflowRoundTripSessionsForWorkflow(workflowId).length > 0) return false;
    this.beginWorkflowSession();
    this.active = false;
    ui.showDocument();
    return true;
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
    const draft: WorkflowNodeV2 = {
      id: this.nextGraphId('node'),
      type: 'input',
      title: asset.name.replace(/\.[^.]+$/, '') || 'Asset',
      position: { x: 80 + (index % 3) * 230, y: 110 + Math.floor(index / 3) * 160 },
      size: { width: 205, height: 190 },
      color: '#3a3c42',
      ports: { inputs: [], outputs: [{ id: 'asset', label: 'Asset', dataType: 'asset-reference' }] },
      config: { legacyKind: 'asset', assetId: asset.id, relativePath: asset.relativePath, note: '' },
      runRecordIds: [],
    };
    const added = domain.node('composition')
      ? domain.addNodeWithEdge(draft, {
          direction: 'outgoing',
          nodePortId: 'asset',
          other: { nodeId: 'composition', portId: 'assets' },
        }).node
      : domain.addNode(draft);
    this.publishGraphMutation(domain, added);
    this.selection = { kind: 'asset', id: added.id };
    this.tool = 'hand';
  }

  addBlankAsset(x: number, y: number, width: number, height: number): void {
    const domain = this.requireGraphDomain();
    const draft: WorkflowNodeV2 = {
      id: this.nextGraphId('node'),
      type: 'input',
      title: `Asset ${this.nodes.length + 1}`,
      position: { x: roundWorkflowNumber(x), y: roundWorkflowNumber(y) },
      size: { width: Math.max(160, roundWorkflowNumber(width)), height: Math.max(130, roundWorkflowNumber(height)) },
      color: '#3a3c42',
      ports: { inputs: [], outputs: [{ id: 'asset', label: 'Asset', dataType: 'asset-reference' }] },
      config: { legacyKind: 'asset', assetId: null, relativePath: '', note: '' },
      runRecordIds: [],
    };
    const added = domain.node('composition')
      ? domain.addNodeWithEdge(draft, {
          direction: 'outgoing',
          nodePortId: 'asset',
          other: { nodeId: 'composition', portId: 'assets' },
        }).node
      : domain.addNode(draft);
    this.publishGraphMutation(domain, added);
    this.selection = { kind: 'asset', id: added.id };
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
    domain.updateNodePorts(id, {
      inputs: node.ports.inputs,
      outputs: node.ports.outputs.filter((port) => port.id !== 'annotation'),
    });
    this.publishGraphMutation(domain, domain.configureNode(id, {
      ...node.config,
      assetId: asset?.id ?? null,
      relativePath: asset?.relativePath ?? null,
      oraRelativePath: null,
      hasAnnotations: false,
    }));
  }

  assignOraDocument(id: string, file: ProjectFile, hasAnnotations: boolean): void {
    const node = this.requireGraphDomain().node(id);
    if (!node || node.type !== 'input') return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.configureNode(id, {
      ...node.config,
      assetId: null,
      relativePath: file.relativePath,
      oraRelativePath: file.relativePath,
      hasAnnotations,
    }));
    const baseOutput = node.ports.outputs.find((port) => port.id === 'asset') ?? {
      id: 'asset', label: 'Asset reference', dataType: 'asset-reference' as const,
    };
    domain.updateNodePorts(id, {
      inputs: node.ports.inputs,
      outputs: [
        { ...baseOutput, label: 'Asset reference' },
        ...(hasAnnotations ? [{ id: 'annotation', label: 'Annotation', dataType: 'asset-reference' as const }] : []),
      ],
    });
    this.publishGraphMutation(domain, undefined);
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

  acceptedEditorResult(nodeId: string): {
    nodeId: string;
    rootRunId: string;
    assetReferenceId: string;
  } | null {
    const candidates = this.serialize().runRecords.flatMap((record) => {
      if (!isFullWorkflowRunRecord(record) || record.nodeId !== nodeId || record.status !== 'succeeded' || record.candidate) {
        return [];
      }
      return record.outputs
        .filter((output) => output.acceptedAt !== undefined)
        .map((output) => ({
          nodeId,
          rootRunId: record.id,
          assetReferenceId: output.assetReferenceId,
          acceptedAt: output.acceptedAt!,
        }));
    }).sort((left, right) => right.acceptedAt - left.acceptedAt || right.rootRunId.localeCompare(left.rootRunId));
    const result = candidates[0];
    return result ? {
      nodeId: result.nodeId,
      rootRunId: result.rootRunId,
      assetReferenceId: result.assetReferenceId,
    } : null;
  }

  effectiveAcceptedEditorOutput(nodeId: string): WorkflowRunOutput | null {
    const accepted = this.acceptedEditorResult(nodeId);
    if (!accepted) return null;
    return resolveWorkflowEffectiveResult(this.serialize(), {
      nodeId,
      rootRunId: accepted.rootRunId,
    })?.output ?? null;
  }

  prepareWorkflowEditorRoundTrip(
    request: Readonly<{ nodeId: string; rootRunId: string; assetReferenceId: string; promotionId?: string }>,
    assets: readonly WorkflowProjectAsset[],
    projectIdentity: string,
  ): WorkflowEditorOpenDescriptor {
    const graph = this.serialize();
    const run = graph.runRecords.find((candidate) => candidate.id === request.rootRunId);
    if (!run || !isFullWorkflowRunRecord(run) || run.status !== 'succeeded' || run.nodeId !== request.nodeId) {
      throw new Error('The workflow result is no longer available.');
    }
    let promotion: WorkflowEditorRevisionV1['promotion'];
    if (request.promotionId) {
      const decision = (graph.reviewPromotions ?? []).find((candidate) => candidate.id === request.promotionId);
      const latest = decision
        ? (graph.reviewPromotions ?? []).filter((candidate) => candidate.reviewNodeId === decision.reviewNodeId).at(-1)
        : null;
      const resolution = decision ? this.reviewResolution(decision.reviewNodeId, assets, true, projectIdentity) : null;
      if (!decision || latest?.id !== decision.id || decision.candidateRunId !== run.id
        || resolution?.state !== 'ready' || resolution.promotion.id !== decision.id) {
        throw new Error('Only the currently promoted, verified result can open in the editor.');
      }
      promotion = { reviewNodeId: decision.reviewNodeId, promotionId: decision.id };
    } else if (run.candidate || !run.outputs.some((output) => (
      output.assetReferenceId === request.assetReferenceId && output.acceptedAt !== undefined
    ))) {
      throw new Error('Only an accepted workflow result can open in the editor.');
    }
    const identity: WorkflowEditableResultIdentity = {
      nodeId: run.nodeId,
      rootRunId: run.id,
      ...(run.candidate ? { candidateId: run.candidate.candidateId } : {}),
      ...(request.promotionId ? { promotionId: request.promotionId } : {}),
    };
    const effective = resolveWorkflowEffectiveResult(graph, identity);
    if (!effective) throw new Error('The workflow result lineage is unavailable.');
    const original = run.outputs.find((output) => output.assetReferenceId === request.assetReferenceId);
    if (!effective.editorRevision && !original) throw new Error('The workflow result output is unavailable.');
    const sourceOutput = effective.editorRevision?.output ?? original!;
    const source = {
      kind: effective.editorRevision ? 'editor-revision' as const : 'run-output' as const,
      id: effective.editorRevision?.id ?? run.id,
      assetReferenceId: sourceOutput.assetReferenceId,
      assetId: sourceOutput.assetId,
      relativePath: sourceOutput.relativePath,
      contentHash: sourceOutput.contentHash,
    };
    const authority: WorkflowRoundTripAuthorityInput = {
      id: `editor-session-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
      workflowId: graph.id,
      workflowSavedPath: this.savedPath,
      projectIdentity,
      sessionIdentity: this.workflowSessionIdentity,
      mutationIdentity: this.workflowMutationIdentity,
      storeRevision: this.rev,
      graphRevision: this.graphRevision,
      contextKey: workflowEditorContextKey(graph, run.nodeId),
      materialKey: effective.materialKey,
      identity,
      source,
      ...(run.candidate ? { candidate: {
        branchGroupId: run.candidate.branchGroupId,
        candidateId: run.candidate.candidateId,
      } } : {}),
      ...(promotion ? { promotion } : {}),
    };
    return {
      authority,
      output: structuredClone(sourceOutput),
      documentRelativePath: effective.editorRevision?.document.relativePath ?? null,
      documentContentHash: effective.editorRevision?.document.contentHash ?? null,
      editorRevisionId: effective.editorRevision?.id ?? null,
    };
  }

  commitWorkflowEditorReturn(
    documentSession: object,
    request: Readonly<{
      revisionId: string;
      bindingId: string;
      outputAssetReferenceId: string;
      artifacts: WorkflowEditorReturnResult;
      width: number;
      height: number;
      createdAt: number;
    }>,
  ): WorkflowEditorRevisionV1 {
    const authority = this.assertWorkflowEditorReturnAuthority(documentSession);
    const graph = this.serialize();
    const revision: WorkflowEditorRevisionV1 = {
      version: 1,
      id: request.revisionId,
      nodeId: authority.identity.nodeId,
      rootRunId: authority.identity.rootRunId,
      source: structuredClone(authority.source),
      ...(authority.candidate ? { candidate: structuredClone(authority.candidate) } : {}),
      ...(authority.promotion ? { promotion: structuredClone(authority.promotion) } : {}),
      document: structuredClone(request.artifacts.document),
      output: {
        assetReferenceId: request.outputAssetReferenceId,
        assetId: request.artifacts.output.id,
        relativePath: request.artifacts.output.relativePath,
        contentHash: request.artifacts.outputContentHash,
        width: request.width,
        height: request.height,
        mime: 'image/png',
      },
      createdAt: request.createdAt,
    };
    const priorBinding = currentRoundTripBinding(graph, authority.identity);
    const binding: WorkflowRoundTripBindingV1 = {
      version: 1,
      id: request.bindingId,
      target: {
        nodeId: authority.identity.nodeId,
        rootRunId: authority.identity.rootRunId,
        ...(authority.identity.promotionId ? { promotionId: authority.identity.promotionId } : {}),
      },
      editorRevisionId: revision.id,
      boundAt: request.createdAt,
      ...(priorBinding ? { supersedesRoundTripId: priorBinding.id } : {}),
    };
    const next = appendWorkflowEditorRevision(graph, revision, binding);
    const domain = new WorkflowGraphDomain(next, {
      idGenerator: this.graphIdGenerator,
      initialRevision: this.graphRevision + 1,
    });
    this.graphDomain = domain;
    this.projectedGraphRevision = domain.revision;
    this.syncReactiveGraph(domain);
    this.pendingDirectorPatchReview = null;
    this.reviewVerifications = {};
    this.bump();
    const nextEffective = resolveWorkflowEffectiveResult(next, authority.identity)!;
    bindWorkflowRoundTripAuthority(documentSession, {
      ...authority,
      mutationIdentity: this.workflowMutationIdentity,
      storeRevision: this.rev,
      graphRevision: this.graphRevision,
      contextKey: workflowEditorContextKey(next, authority.identity.nodeId),
      materialKey: nextEffective.materialKey,
      source: {
        kind: 'editor-revision',
        id: revision.id,
        assetReferenceId: revision.output.assetReferenceId,
        assetId: revision.output.assetId,
        relativePath: revision.output.relativePath,
        contentHash: revision.output.contentHash,
      },
    });
    return structuredClone(revision);
  }

  assertWorkflowEditorReturnAuthority(documentSession: object): WorkflowRoundTripAuthorityInput {
    const authority = workflowRoundTripAuthority(documentSession);
    if (!authority) throw new Error('This document is not linked to a workflow result.');
    if (authority.workflowId !== this.serialize().id
      || authority.projectIdentity !== project.identity
      || authority.sessionIdentity !== this.workflowSessionIdentity) {
      throw new Error('The workflow or project changed while this result was being edited. The stored artifacts were not linked.');
    }
    const graph = this.serialize();
    if (workflowEditorContextKey(graph, authority.identity.nodeId) !== authority.contextKey) {
      throw new Error('The workflow or project changed its source context while this result was being edited. The stored artifacts were not linked.');
    }
    const effective = resolveWorkflowEffectiveResult(graph, authority.identity);
    if (!effective || effective.materialKey !== authority.materialKey
      || effective.output.assetReferenceId !== authority.source.assetReferenceId
      || effective.output.assetId !== authority.source.assetId
      || effective.output.relativePath !== authority.source.relativePath
      || effective.output.contentHash !== authority.source.contentHash) {
      throw new Error('The source result changed while this document was open. The stored artifacts were not linked.');
    }
    if (authority.promotion) {
      const latest = (graph.reviewPromotions ?? [])
        .filter((candidate) => candidate.reviewNodeId === authority.promotion!.reviewNodeId).at(-1);
      if (latest?.id !== authority.promotion.promotionId) {
        throw new Error('A newer Review promotion replaced this editor session. The stored artifacts were not linked.');
      }
    }
    return structuredClone(authority);
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

  async runReviewedOutput(
    outputNodeId: string,
    options: WorkflowStoreRunOptions,
  ): Promise<WorkflowSelectiveExecutionOutcome> {
    const path = resolveWorkflowCampaignPath(this.serialize(), { outputNodeId });
    if (!path?.reviewNodeId) {
      throw new WorkflowTransformExecutionError(
        'INVALID_TRANSFORM_PATH', 'Reviewed Output execution requires one connected Review path.', 'Run Generate instead',
      );
    }
    const preflight = await this.preflightSelectiveExecution('run-node', outputNodeId, options);
    const blocked = preflight.stateByNodeId[path.reviewNodeId]?.state === 'blocked'
      ? preflight.stateByNodeId[path.reviewNodeId]
      : preflight.plan.preflight.find((entry) => entry.state === 'blocked');
    if (blocked) {
      throw new WorkflowTransformExecutionError('NOT_READY', blocked.reason.message, 'Resolve the Review block');
    }
    const outcome = await this.runSelectiveExecution(preflight, options, { maxConcurrency: 1 });
    const result = outcome.results[path.reviewNodeId];
    const resolution = this.reviewResolution(
      path.reviewNodeId,
      options.assets,
      true,
      options.currentProjectIdentity?.() ?? options.projectPath,
    );
    if (resolution.state !== 'ready'
      || !result
      || result.outputIds.length !== 1
      || result.outputIds[0] !== resolution.output.assetReferenceId
      || !outcome.cachedNodeIds.includes(path.reviewNodeId)
      || outcome.executedNodeIds.includes(path.transformNodeId)) {
      throw new WorkflowTransformExecutionError(
        'NOT_READY', 'The promoted Review result changed before the Output could consume it.', 'Run Review verification again',
      );
    }
    return outcome;
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
    const failureMessage = latest.failure?.message ?? 'The latest generation attempt did not complete.';
    return {
      state: 'failed', message: `${failureMessage} Retry Generate.`, assetId: null,
    };
  }

  candidateBranchGroups(sourceNodeId?: string): WorkflowCandidateBranchGroup[] {
    const groups = deriveWorkflowCandidateBranchGroups(this.serialize());
    return sourceNodeId ? groups.filter((group) => group.sourceNodeId === sourceNodeId) : groups;
  }

  reviewCandidates(
    reviewNodeId: string,
    availableAssets?: readonly WorkflowProjectAsset[],
    requireVerified = false,
    projectIdentity?: string | null,
  ): WorkflowReviewCandidate[] {
    const graph = this.serialize();
    const topology = resolveWorkflowReviewTopology(graph, { reviewNodeId });
    const verification = this.currentReviewVerification(reviewNodeId, availableAssets, projectIdentity);
    const verified = new Set(verification?.verifiedOutputIds ?? []);
    return deriveWorkflowReviewCandidates(graph, reviewNodeId, {
      ...(topology.transformNodeId
        ? { currentMaterialKeys: { [topology.transformNodeId]: verification?.materialKey ?? (requireVerified ? 'unverified' : '') } }
        : {}),
      ...(availableAssets ? {
        isOutputAvailable: (output) => verification
          ? verified.has(output.assetReferenceId)
          : !requireVerified && availableAssets.some((asset) => (
            asset.id === output.assetId && asset.relativePath === output.relativePath
            && (!('exists' in asset) || asset.exists !== false)
          )),
      } : {}),
    });
  }

  reviewResolution(
    reviewNodeId: string,
    availableAssets?: readonly WorkflowProjectAsset[],
    requireVerified = false,
    projectIdentity?: string | null,
  ) {
    const graph = this.serialize();
    const topology = resolveWorkflowReviewTopology(graph, { reviewNodeId });
    const verification = this.currentReviewVerification(reviewNodeId, availableAssets, projectIdentity);
    const verified = new Set(verification?.verifiedOutputIds ?? []);
    const resolution = resolveWorkflowReviewTopology(graph, {
      reviewNodeId,
      ...(topology.transformNodeId
        ? { currentMaterialKeys: { [topology.transformNodeId]: verification?.materialKey ?? (requireVerified ? 'unverified' : '') } }
        : {}),
      ...(availableAssets ? {
        isOutputAvailable: (output) => verification
          ? verified.has(output.assetReferenceId)
          : !requireVerified && availableAssets.some((asset) => (
            asset.id === output.assetId && asset.relativePath === output.relativePath
            && (!('exists' in asset) || asset.exists !== false)
          )),
      } : {}),
    });
    if (resolution.state !== 'ready') return resolution;
    const effective = resolveWorkflowEffectiveResult(graph, {
      nodeId: resolution.promotion.sourceNodeId,
      rootRunId: resolution.promotion.candidateRunId,
      candidateId: resolution.promotion.candidateId,
      promotionId: resolution.promotion.id,
    });
    if (!effective?.editorRevision) return resolution;
    const available = verification
      ? verified.has(effective.output.assetReferenceId)
      : !requireVerified && (!availableAssets || availableAssets.some((asset) => (
        asset.id === effective.output.assetId && asset.relativePath === effective.output.relativePath
        && (!('exists' in asset) || asset.exists !== false)
      )));
    if (!available) {
      return {
        state: 'blocked' as const,
        reviewNodeId,
        transformNodeId: resolution.transformNodeId,
        outputNodeId: resolution.outputNodeId,
        reason: {
          code: 'PROMOTED_OUTPUT_UNAVAILABLE' as const,
          message: 'The edited promoted result is unavailable.',
          action: 'Restore it or return the edit again',
        },
      };
    }
    return { ...resolution, output: structuredClone(effective.output) };
  }

  async refreshReviewState(
    reviewNodeId: string,
    options: WorkflowStoreRunOptions,
  ): Promise<Readonly<WorkflowReviewVerification>> {
    const sequence = (this.reviewVerificationSequences.get(reviewNodeId) ?? 0) + 1;
    this.reviewVerificationSequences.set(reviewNodeId, sequence);
    const projectIdentity = options.currentProjectIdentity?.() ?? options.projectPath;
    const optionsIdentity = this.reviewOptionsIdentity(options, projectIdentity);
    if (this.reviewVerifications[reviewNodeId]?.optionsIdentity !== optionsIdentity) {
      const { [reviewNodeId]: _stale, ...current } = this.reviewVerifications;
      this.reviewVerifications = current;
    }
    const graph = this.serialize();
    const graphRevision = this.graphRevision;
    const storeRevision = this.rev;
    const sessionIdentity = this.workflowSessionIdentity;
    const topology = resolveWorkflowReviewTopology(graph, { reviewNodeId });
    if (!topology.transformNodeId || !topology.outputNodeId) throw new Error('Review requires one unambiguous campaign path.');
    const prepared = await prepareCampaignGenerateTransform(graph, topology.outputNodeId, {
      ...options,
      allowUnpromotedReview: true,
    });
    const verifiedOutputIds: string[] = [];
    for (const candidate of deriveWorkflowReviewCandidates(graph, reviewNodeId)) {
      if (!candidate.output) continue;
      const asset = options.assets.find((item) => (
        item.id === candidate.output!.assetId && item.relativePath === candidate.output!.relativePath
      ));
      if (!asset) continue;
      try {
        const material = await options.resolveAsset(asset);
        const bytes = material.bytes instanceof Uint8Array && material.bytes.length > 0 ? material.bytes : null;
        if (bytes
          && material.assetId === candidate.output.assetId
          && material.relativePath === candidate.output.relativePath
          && material.contentHash === candidate.output.contentHash
          && workflowSha256Bytes(bytes) === candidate.output.contentHash) {
          verifiedOutputIds.push(candidate.output.assetReferenceId);
        }
      } catch {
        // Missing or unreadable candidate outputs remain recoverably unavailable.
      }
    }
    const promoted = resolveWorkflowReviewTopology(graph, { reviewNodeId });
    if (promoted.state === 'ready') {
      const effective = resolveWorkflowEffectiveResult(graph, {
        nodeId: promoted.promotion.sourceNodeId,
        rootRunId: promoted.promotion.candidateRunId,
        candidateId: promoted.promotion.candidateId,
        promotionId: promoted.promotion.id,
      });
      if (effective?.editorRevision) {
        const asset = options.assets.find((item) => (
          item.id === effective.output.assetId && item.relativePath === effective.output.relativePath
        ));
        if (asset) {
          try {
            const material = await options.resolveAsset(asset);
            const bytes = material.bytes instanceof Uint8Array && material.bytes.length > 0 ? material.bytes : null;
            if (bytes
              && material.assetId === effective.output.assetId
              && material.relativePath === effective.output.relativePath
              && material.contentHash === effective.output.contentHash
              && workflowSha256Bytes(bytes) === effective.output.contentHash) {
              verifiedOutputIds.push(effective.output.assetReferenceId);
            }
          } catch {
            // An unreadable edited promotion stays recoverably unavailable.
          }
        }
      }
    }
    if (this.reviewVerificationSequences.get(reviewNodeId) !== sequence) {
      throw new Error('Review verification was superseded by newer execution options.');
    }
    if (this.graphRevision !== graphRevision || this.rev !== storeRevision
      || this.workflowSessionIdentity !== sessionIdentity
      || (options.currentProjectIdentity?.() ?? options.projectPath) !== projectIdentity) {
      throw new Error('The workflow or project changed while Review state was being verified.');
    }
    const verification = Object.freeze({
      graphRevision,
      projectIdentity,
      assetFingerprint: this.reviewAssetFingerprint(options.assets),
      materialKey: prepared.materialKey,
      verifiedOutputIds: Object.freeze([...verifiedOutputIds]) as unknown as string[],
      optionsIdentity,
    });
    this.reviewVerifications = {
      ...this.reviewVerifications,
      [reviewNodeId]: verification,
    };
    return verification;
  }

  invalidateReviewState(reviewNodeIds: readonly string[]): void {
    if (reviewNodeIds.length === 0) return;
    const invalidated = new Set(reviewNodeIds);
    for (const reviewNodeId of invalidated) {
      const sequence = (this.reviewVerificationSequences.get(reviewNodeId) ?? 0) + 1;
      this.reviewVerificationSequences.set(reviewNodeId, sequence);
    }
    this.reviewVerifications = Object.fromEntries(
      Object.entries(this.reviewVerifications)
        .filter(([reviewNodeId]) => !invalidated.has(reviewNodeId)),
    );
  }

  async promoteCandidate(
    reviewNodeId: string,
    candidateId: string,
    options: WorkflowStoreRunOptions,
  ): Promise<void> {
    const sessionIdentity = this.workflowSessionIdentity;
    const graphRevision = this.graphRevision;
    const storeRevision = this.rev;
    const projectIdentity = options.currentProjectIdentity?.() ?? options.projectPath;
    const graph = this.serialize();
    const candidate = deriveWorkflowReviewCandidates(graph, reviewNodeId)
      .find((item) => item.candidateId === candidateId);
    if (!candidate?.output || candidate.state !== 'eligible') {
      throw new Error('Only an available, current candidate can be promoted.');
    }
    const path = resolveWorkflowCampaignPath(graph, { transformNodeId: candidate.sourceNodeId });
    if (!path || path.reviewNodeId !== reviewNodeId) {
      throw new Error('The candidate is no longer connected to this Review.');
    }
    const prepared = await prepareCampaignGenerateTransform(graph, path.outputNodeId, {
      ...options,
      allowUnpromotedReview: true,
    });
    if (prepared.materialKey !== candidate.materialKey) {
      throw new Error('The candidate is stale because its upstream creative material changed. Generate current branches first.');
    }
    const asset = options.assets.find((item) => (
      item.id === candidate.output!.assetId && item.relativePath === candidate.output!.relativePath
    ));
    if (!asset) throw new Error('The candidate asset is unavailable. Restore it or choose another candidate.');
    const material = await options.resolveAsset(asset);
    const computed = material.bytes instanceof Uint8Array && material.bytes.length > 0
      ? workflowSha256Bytes(material.bytes)
      : null;
    if (material.assetId !== candidate.output.assetId
      || material.relativePath !== candidate.output.relativePath
      || material.contentHash !== candidate.output.contentHash
      || computed !== candidate.output.contentHash) {
      throw new Error('The candidate asset changed and must be reviewed again.');
    }
    if (this.workflowSessionIdentity !== sessionIdentity
      || this.graphRevision !== graphRevision
      || this.rev !== storeRevision
      || (options.currentProjectIdentity?.() ?? options.projectPath) !== projectIdentity) {
      throw new Error('The workflow or project changed while promotion was being verified. Review the candidates again.');
    }
    const promoted = promoteWorkflowCandidate(graph, {
      reviewNodeId,
      candidateId,
      id: `promotion-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
      promotedAt: options.clock?.() ?? Date.now(),
      isOutputAvailable: () => true,
    });
    this.graphDomain = new WorkflowGraphDomain(promoted, { idGenerator: this.graphIdGenerator });
    this.projectedGraphRevision = this.graphDomain.revision;
    this.syncReactiveGraph(this.graphDomain);
    this.bump();
  }

  async runCandidateBranches(
    outputNodeId: string,
    options: WorkflowStoreRunOptions,
    branch: WorkflowCandidateBranchExecutionOptions,
  ): Promise<WorkflowCandidateBranchStoreOutcome> {
    const sessionIdentity = this.workflowSessionIdentity;
    const graphRevision = this.graphRevision;
    const storeRevision = this.rev;
    const projectIdentity = options.currentProjectIdentity?.() ?? options.projectPath;
    const outcome = await executeWorkflowCandidateBranches(this.serialize(), outputNodeId, options, branch);
    const commitMessage = this.workflowSessionIdentity !== sessionIdentity
      ? 'The workflow session changed while candidate branches were running.'
      : this.graphRevision !== graphRevision || this.rev !== storeRevision
        ? 'The workflow changed while candidate branches were running.'
        : (options.currentProjectIdentity?.() ?? options.projectPath) !== projectIdentity
          ? 'The active project changed while candidate branches were running.'
          : '';
    if (commitMessage) return { ...outcome, committed: false, commitMessage: `${commitMessage} Candidate assets remain in the project.` };
    this.graphDomain = new WorkflowGraphDomain(outcome.graph, { idGenerator: this.graphIdGenerator });
    this.projectedGraphRevision = this.graphDomain.revision;
    this.syncReactiveGraph(this.graphDomain);
    this.bump();
    return { ...outcome, committed: true, commitMessage: `Preserved ${outcome.group.candidates.length} candidate branches.` };
  }

  async retryCandidateBranch(
    candidateId: string,
    options: WorkflowStoreRunOptions,
  ): Promise<WorkflowCandidateRetryStoreOutcome> {
    const sessionIdentity = this.workflowSessionIdentity;
    const graphRevision = this.graphRevision;
    const storeRevision = this.rev;
    const projectIdentity = options.currentProjectIdentity?.() ?? options.projectPath;
    const outcome = await retryWorkflowCandidateBranch(this.serialize(), candidateId, options, { maxConcurrency: 1 });
    const commitMessage = this.workflowSessionIdentity !== sessionIdentity
      ? 'The workflow session changed while the candidate retry was running.'
      : this.graphRevision !== graphRevision || this.rev !== storeRevision
        ? 'The workflow changed while the candidate retry was running.'
        : (options.currentProjectIdentity?.() ?? options.projectPath) !== projectIdentity
          ? 'The active project changed while the candidate retry was running.'
          : '';
    if (commitMessage) return { ...outcome, committed: false, commitMessage: `${commitMessage} The candidate asset remains in the project.` };
    this.graphDomain = new WorkflowGraphDomain(outcome.graph, { idGenerator: this.graphIdGenerator });
    this.projectedGraphRevision = this.graphDomain.revision;
    this.syncReactiveGraph(this.graphDomain);
    this.bump();
    return { ...outcome, committed: true, commitMessage: 'Candidate retry preserved.' };
  }

  async runCampaignGenerate(
    outputNodeId: string,
    options: WorkflowStoreRunOptions,
  ): Promise<WorkflowTransformStoreOutcome> {
    const requestedSessionIdentity = this.workflowSessionIdentity;
    const initialGraph = this.serialize();
    const transformNodeId = resolveWorkflowCampaignPath(initialGraph, { outputNodeId })?.transformNodeId ?? 'transform';
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
    const mutationIdentity = this.workflowMutationIdentity;
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
      cancelExecution: options.cancelExecutionForRun
        ? async () => ({ disposition: 'terminated' as const, message: 'Cancelled before provider execution.' })
        : options.cancelExecution,
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
      if (this.workflowMutationIdentity !== mutationIdentity) {
        return 'The workflow changed while Generate was running. The result was not applied.';
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
        if (options.cancelExecutionForRun) {
          activeRun.cancelExecution = () => options.cancelExecutionForRun!(event.runId);
        }
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
      const surfacedFailure = error instanceof WorkflowTransformExecutionError
        ? error
        : new WorkflowTransformExecutionError(
          'EXECUTOR_ERROR',
          'The workflow could not prepare this generation attempt.',
          'Retry Generate',
        );
      const failureGraph = surfacedFailure.failureGraph;
      if (failureGraph && !commitBlockReason()) {
        this.graphDomain = new WorkflowGraphDomain(failureGraph, { idGenerator: this.graphIdGenerator });
        this.projectedGraphRevision = this.graphDomain.revision;
        this.syncReactiveGraph(this.graphDomain);
        this.bump();
      }
      if (this.activeTransformRuns.get(transformNodeId) === activeRun) {
        const cancelled = surfacedFailure.code === 'CANCELLED';
        const failureMessage = surfacedFailure.message;
        this.transformExecutions = {
          ...this.transformExecutions,
          [transformNodeId]: {
            state: cancelled ? 'cancelled' : 'failed',
            message: cancelled ? failureMessage : `${failureMessage} Retry Generate.`,
            assetId: null,
          },
        };
      }
      throw surfacedFailure;
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
    this.assertWorkflowReplacementAllowed();
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
    this.rev = result.requiresExplicitSave ? 1 : 0;
    this.savedRev = 0;
    if (!result.requiresExplicitSave) this.captureCurrentSavedBaseline();
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
    const reviewMaterialKeys: Record<string, string> = {};
    const reviewEffectiveOutputs: Record<string, WorkflowRunOutput> = {};
    const verifiedReviewOutputIds = new Set<string>();
    for (const review of graph.nodes.filter((candidate) => (
      candidate.type === 'review' && draft.requiredNodeIds.includes(candidate.id)
    ))) {
      try {
        const verification = await this.refreshReviewState(review.id, options);
        this.requireCurrentSelectiveSnapshot(snapshot, options);
        const topology = resolveWorkflowReviewTopology(graph, { reviewNodeId: review.id });
        if (topology.transformNodeId) {
          reviewMaterialKeys[topology.transformNodeId] = verification.materialKey;
          materialKeys[topology.transformNodeId] = verification.materialKey;
          verification.verifiedOutputIds.forEach((id) => verifiedReviewOutputIds.add(id));
          const effectiveResolution = this.reviewResolution(
            review.id,
            options.assets,
            true,
            options.currentProjectIdentity?.() ?? options.projectPath,
          );
          if (effectiveResolution.state === 'ready') {
            reviewEffectiveOutputs[review.id] = effectiveResolution.output;
          }
        }
      } catch (error) {
        if (operation.controller.signal.aborted) throw error;
        // Final planning derives a recoverable Review block from missing verification.
      }
    }
    const restrictions: Array<{ nodeId: string; kind: 'unavailable'; reason: string }> = [];
    for (const transformNodeId of draft.executionNodeIds) {
      const outputNodeId = this.campaignOutputForTransform(graph, transformNodeId);
      if (!outputNodeId) {
        restrictions.push({
          nodeId: transformNodeId,
          kind: 'unavailable',
          reason: 'Campaign Generate requires one unambiguous Output path, with at most one Review hop.',
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
    const effectiveRunResults: Record<string, {
      rootRunId: string;
      materialKey: string;
      output: WorkflowRunOutput;
    }> = {};
    for (const transformNodeId of Object.keys(materialKeys)) {
      const node = graph.nodes.find((candidate) => candidate.id === transformNodeId);
      if (!node) continue;
      for (const runId of node.runRecordIds) {
        const record = graph.runRecords.find((candidate) => candidate.id === runId);
        if (!record || !isFullWorkflowRunRecord(record) || record.candidate || record.status !== 'succeeded'
          || record.materialKey !== materialKeys[transformNodeId] || record.outputs.length === 0) continue;
        const effective = resolveWorkflowEffectiveResult(graph, {
          nodeId: record.nodeId,
          rootRunId: record.id,
        });
        const outputsToVerify = effective?.editorRevision ? [effective.output] : record.outputs;
        let reusable = true;
        for (const output of outputsToVerify) {
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
        if (reusable && effective?.editorRevision) {
          effectiveRunResults[record.nodeId] = {
            rootRunId: record.id,
            materialKey: effective.materialKey,
            output: effective.output,
          };
        }
        if (reusable) verifiedRunIds.add(record.id);
      }
    }
    this.requireCurrentSelectiveSnapshot(snapshot, options);
    const plan = planSelectiveWorkflowExecution(graph, {
      mode,
      nodeId,
      materialKeys,
      reviewMaterialKeys,
      reviewEffectiveOutputs,
      effectiveRunResults,
      isReviewOutputAvailable: (output) => verifiedReviewOutputIds.has(output.assetReferenceId),
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
    return resolveWorkflowCampaignPath(graph, { transformNodeId })?.outputNodeId ?? null;
  }

  private reviewAssetFingerprint(assets: readonly WorkflowStoreRunOptions['assets'][number][]): string {
    return JSON.stringify(assets.map((asset) => [
      asset.id, asset.relativePath, asset.width ?? null, asset.height ?? null, asset.mime ?? null,
      'exists' in asset ? asset.exists : true,
    ]).sort(([left], [right]) => String(left).localeCompare(String(right))));
  }

  private reviewOptionsIdentity(options: WorkflowStoreRunOptions, projectIdentity: string | null): string {
    return JSON.stringify({
      provider: options.provider,
      callerIdentity: options.selectiveExecutionIdentity?.trim() || null,
      projectIdentity,
      assets: this.reviewAssetFingerprint(options.assets),
      executors: options.executors.map((executor) => ({
        provider: executor.provider,
        capabilities: [...executor.capabilities].sort(),
        materialization: executor.materialization ?? null,
        executor: {
          id: executor.executor.id,
          version: executor.executor.version,
          requestSchemaVersion: executor.executor.requestSchemaVersion,
        },
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    });
  }

  private currentReviewVerification(
    reviewNodeId: string,
    assets?: readonly WorkflowProjectAsset[],
    projectIdentity?: string | null,
  ): WorkflowReviewVerification | null {
    const verification = this.reviewVerifications[reviewNodeId];
    if (!verification || verification.graphRevision !== this.graphRevision) return null;
    if (projectIdentity !== undefined && verification.projectIdentity !== projectIdentity) return null;
    if (assets && verification.assetFingerprint !== this.reviewAssetFingerprint(assets)) return null;
    return verification;
  }

  private assertWorkflowReplacementAllowed(): void {
    const workflowId = this.graphDomain?.graph.id;
    if (workflowId && workflowRoundTripSessionsForWorkflow(workflowId).length > 0) {
      throw new Error('Close or discard workflow-linked editor tabs before replacing the workflow.');
    }
  }

  private beginWorkflowSession(): void {
    this.activeSelectiveOperation?.controller.abort();
    for (const run of this.activeTransformRuns.values()) {
      void this.cancelActiveTransformRun(run);
    }
    this.workflowSessionIdentity += 1;
    this.workflowMutationIdentity += 1;
    this.savedWorkflowBytes = null;
    this.activeSavePathIntentIdentity = ++this.savePathIntentSequence;
    this.activeSavePathIntentTarget = null;
    this.transformExecutions = {};
    this.reviewVerifications = {};
    this.activeTransformRuns.clear();
    this.pendingDirectorPatchReview = null;
    this.clearDirectorPatchHistory();
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
          oraRelativePath: typeof node.config.oraRelativePath === 'string' ? node.config.oraRelativePath : null,
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
        || node.type === 'extract-assets'
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
