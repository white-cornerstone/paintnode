import type { ProjectAsset } from '../integrations/desktop';
import { project } from './project.svelte';
import { ui } from './ui.svelte';
import { coerceAnnotations, type AnnotationItem } from '../engine/annotations';
import {
  WORKFLOW_GRAPH_VERSION,
  WorkflowGraphDomain,
  type WorkflowGraphV2,
  type WorkflowIdGenerator,
  type WorkflowNodeV2,
} from '../workflow';

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
}

export interface WorkflowConnection {
  id: string;
  from: string;
  to: string;
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
export type WorkflowSelection = { kind: 'asset'; id: string } | { kind: 'composition' } | { kind: 'output'; id: string };
export type WorkflowZoomMode = 'in' | 'out';
export type StoryboardTool = 'brush' | 'eraser';

export interface WorkflowFile {
  version: 1;
  name: string;
  prompt: string;
  compositionName?: string;
  compositionWidth?: number;
  compositionHeight?: number;
  compositionColor?: string;
  promptX: number;
  promptY: number;
  outputName?: string;
  outputWidth?: number;
  outputHeight?: number;
  outputColor?: string;
  outputX: number;
  outputY: number;
  outputNodes?: WorkflowOutputNode[];
  panX?: number;
  panY?: number;
  zoom?: number;
  storyboardDataUrl: string | null;
  storyboardWidth?: number;
  storyboardHeight?: number;
  storyboardOraPath?: string | null;
  storyboardAnnotations?: string[];
  storyboardAnnotationItems?: AnnotationItem[];
  storyboardAnnotationsVisible?: boolean;
  nodes: WorkflowAssetNode[];
  connections?: WorkflowConnection[];
  outputAssetId: string | null;
  outputRelativePath: string | null;
}

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
}

export class WorkflowStore {
  active = $state(false);
  name = $state('Untitled Workflow');
  savedPath = $state<string | null>(null);
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
  connections = $state<WorkflowConnection[]>([]);
  outputAssetId = $state<string | null>(null);
  outputRelativePath = $state<string | null>(null);
  rev = $state(0);
  savedRev = $state(0);
  private graphDomain: WorkflowGraphDomain | null = null;
  private readonly graphIdGenerator: WorkflowIdGenerator | undefined;
  private projectedGraphRevision = 0;

  constructor(options: WorkflowStoreOptions = {}) {
    this.graphIdGenerator = options.idGenerator;
  }

  get dirty(): boolean {
    this.rev;
    return this.rev !== this.savedRev;
  }

  get graphRevision(): number {
    return this.graphDomain?.revision ?? 0;
  }

  newBoard(name = 'Untitled Workflow'): void {
    this.active = true;
    ui.showWorkflow();
    this.name = cleanWorkflowName(name);
    this.savedPath = null;
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
    this.connections = [{ id: this.nextGraphId('edge'), from: 'composition', to: 'output' }];
    this.outputAssetId = null;
    this.outputRelativePath = null;
    this.rev = 0;
    this.savedRev = 0;
    this.resetGraphDomain();
  }

  show(): void {
    if (!this.active) this.newBoard();
    this.active = true;
    ui.showWorkflow();
  }

  close(): void {
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

  removeNode(id: string): void {
    if (!this.requireGraphDomain().node(id)) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.removeNode(id));
    if (this.selection?.kind === 'asset' && this.selection.id === id) this.selection = null;
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
      ports: { inputs: [{ id: 'composition', label: 'Composition', dataType: 'layout' }], outputs: [] },
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
      nodePortId: 'composition',
      other: { nodeId: 'composition', portId: 'composition' },
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
    this.panX = roundWorkflowNumber(this.panX + dx);
    this.panY = roundWorkflowNumber(this.panY + dy);
  }

  setZoom(nextZoom: number): void {
    this.zoom = Math.min(4, Math.max(0.2, Number(nextZoom.toFixed(3))));
  }

  zoomAt(viewX: number, viewY: number, direction: WorkflowZoomMode): void {
    const current = this.zoom;
    const next = Math.min(4, Math.max(0.2, current * (direction === 'in' ? 1.25 : 0.8)));
    const worldX = (viewX - this.panX) / current;
    const worldY = (viewY - this.panY) / current;
    this.zoom = Number(next.toFixed(3));
    this.panX = roundWorkflowNumber(viewX - worldX * this.zoom);
    this.panY = roundWorkflowNumber(viewY - worldY * this.zoom);
  }

  zoomBy(factor: number, viewX: number, viewY: number): void {
    const current = this.zoom;
    const next = Math.min(4, Math.max(0.2, current * factor));
    const worldX = (viewX - this.panX) / current;
    const worldY = (viewY - this.panY) / current;
    this.zoom = Number(next.toFixed(3));
    this.panX = roundWorkflowNumber(viewX - worldX * this.zoom);
    this.panY = roundWorkflowNumber(viewY - worldY * this.zoom);
  }

  resetZoom(): void {
    this.zoom = 1;
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

  connect(from: string, to: string): void {
    if (!this.canConnect(from, to)) return;
    if (this.isConnected(from, to)) return;
    const domain = this.requireGraphDomain();
    this.publishGraphMutation(domain, domain.addEdge({
      source: { nodeId: from, portId: from === 'composition' ? 'composition' : 'asset' },
      target: { nodeId: to, portId: to === 'composition' ? 'assets' : 'composition' },
    }));
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
    }));
  }

  outgoing(nodeId: string): WorkflowConnection[] {
    return this.requireGraphDomain().outgoing(nodeId).map((edge) => ({
      id: edge.id,
      from: edge.source.nodeId,
      to: edge.target.nodeId,
    }));
  }

  connectedAssetNodesTo(nodeId: string): WorkflowAssetNode[] {
    const incomingIds = new Set(this.incoming(nodeId).map((connection) => connection.from));
    return this.nodes.filter((node) => incomingIds.has(node.id));
  }

  canConnect(from: string, to: string): boolean {
    const domain = this.requireGraphDomain();
    return from !== to && domain.node(from) !== null && domain.node(to) !== null;
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

  selectedLabel(): string {
    const selection = this.selection;
    if (selection?.kind === 'asset') {
      return this.nodes.find((node) => node.id === selection.id)?.name ?? '';
    }
    if (selection?.kind === 'composition') return this.compositionName;
    if (selection?.kind === 'output') return this.outputNode(selection.id)?.name ?? '';
    return '';
  }

  selectedColor(): string {
    const selection = this.selection;
    if (selection?.kind === 'asset') {
      return this.nodes.find((node) => node.id === selection.id)?.color ?? '#3a3c42';
    }
    if (selection?.kind === 'composition') return this.compositionColor;
    if (selection?.kind === 'output') return this.outputNode(selection.id)?.color ?? '#3a3c42';
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

  serialize(): WorkflowFile {
    return {
      version: 1,
      name: this.name,
      prompt: this.prompt,
      compositionName: this.compositionName,
      compositionWidth: this.compositionWidth,
      compositionHeight: this.compositionHeight,
      compositionColor: this.compositionColor,
      promptX: this.promptX,
      promptY: this.promptY,
      outputName: this.outputName,
      outputWidth: this.outputWidth,
      outputHeight: this.outputHeight,
      outputColor: this.outputColor,
      outputX: this.outputX,
      outputY: this.outputY,
      outputNodes: this.outputNodes.map((node) => ({ ...node })),
      panX: this.panX,
      panY: this.panY,
      zoom: this.zoom,
      storyboardDataUrl: this.storyboardDataUrl,
      storyboardWidth: this.storyboardWidth,
      storyboardHeight: this.storyboardHeight,
      storyboardOraPath: this.storyboardOraPath,
      storyboardAnnotations: this.storyboardAnnotations,
      storyboardAnnotationItems: this.storyboardAnnotationItems,
      storyboardAnnotationsVisible: this.storyboardAnnotationsVisible,
      nodes: this.nodes.map((node) => ({ ...node })),
      connections: this.connections.map((connection) => ({ ...connection })),
      outputAssetId: this.outputAssetId,
      outputRelativePath: this.outputRelativePath,
    };
  }

  toBytes(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(this.serialize(), null, 2));
  }

  openFromBytes(bytes: Uint8Array, savedPath: string | null, fallbackName: string): void {
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text) as Partial<WorkflowFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) {
      throw new Error('Workflow file is not a supported PaintNode workflow.');
    }
    this.active = true;
    ui.showWorkflow();
    this.tool = 'hand';
    this.zoomMode = 'in';
    this.selection = { kind: 'composition' };
    this.storyboardEditing = false;
    this.storyboardTool = 'brush';
    this.name = cleanWorkflowName(parsed.name ?? fallbackName);
    this.savedPath = savedPath;
    this.prompt = parsed.prompt ?? '';
    this.compositionName = parsed.compositionName ?? '';
    this.compositionWidth = Number.isFinite(parsed.compositionWidth) ? roundWorkflowNumber(parsed.compositionWidth!) : 340;
    this.compositionHeight = Number.isFinite(parsed.compositionHeight) ? roundWorkflowNumber(parsed.compositionHeight!) : 408;
    this.compositionColor = parsed.compositionColor ?? '#3a3c42';
    this.promptX = Number.isFinite(parsed.promptX) ? roundWorkflowNumber(parsed.promptX!) : 480;
    this.promptY = Number.isFinite(parsed.promptY) ? roundWorkflowNumber(parsed.promptY!) : 70;
    this.outputName = parsed.outputName ?? '';
    this.outputWidth = Number.isFinite(parsed.outputWidth) ? roundWorkflowNumber(parsed.outputWidth!) : 210;
    this.outputHeight = Number.isFinite(parsed.outputHeight) ? roundWorkflowNumber(parsed.outputHeight!) : 190;
    this.outputColor = parsed.outputColor ?? '#3a3c42';
    this.outputX = Number.isFinite(parsed.outputX) ? roundWorkflowNumber(parsed.outputX!) : 895;
    this.outputY = Number.isFinite(parsed.outputY) ? roundWorkflowNumber(parsed.outputY!) : 96;
    const legacyOutput = defaultOutputNode();
    legacyOutput.name = parsed.outputName ?? '';
    legacyOutput.width = Number.isFinite(parsed.outputWidth) ? Math.max(190, roundWorkflowNumber(parsed.outputWidth!)) : 210;
    legacyOutput.height = Number.isFinite(parsed.outputHeight) ? Math.max(190, roundWorkflowNumber(parsed.outputHeight!)) : 232;
    legacyOutput.color = parsed.outputColor ?? '#3a3c42';
    legacyOutput.x = this.outputX;
    legacyOutput.y = this.outputY;
    legacyOutput.outputAssetId = parsed.outputAssetId ?? null;
    legacyOutput.outputRelativePath = parsed.outputRelativePath ?? null;
    this.outputNodes = Array.isArray(parsed.outputNodes) && parsed.outputNodes.length
      ? parsed.outputNodes.map((node, index) => ({
        id: node.id || (index === 0 ? 'output' : this.nextGraphId('node')),
        name: node.name ?? (index === 0 ? '' : `Output ${index + 1}`),
        x: Number.isFinite(node.x) ? roundWorkflowNumber(node.x) : legacyOutput.x + index * 280,
        y: Number.isFinite(node.y) ? roundWorkflowNumber(node.y) : legacyOutput.y,
        width: Number.isFinite(node.width) ? Math.max(190, roundWorkflowNumber(node.width)) : legacyOutput.width,
        height: Number.isFinite(node.height) ? Math.max(190, roundWorkflowNumber(node.height)) : legacyOutput.height,
        color: node.color || legacyOutput.color,
        finalWidth: Number.isFinite(node.finalWidth) ? Math.max(64, roundWorkflowNumber(node.finalWidth)) : legacyOutput.finalWidth,
        finalHeight: Number.isFinite(node.finalHeight) ? Math.max(64, roundWorkflowNumber(node.finalHeight)) : legacyOutput.finalHeight,
        outputAssetId: node.outputAssetId ?? (index === 0 ? legacyOutput.outputAssetId : null),
        outputRelativePath: node.outputRelativePath ?? (index === 0 ? legacyOutput.outputRelativePath : null),
      }))
      : [legacyOutput];
    if (parsed.outputName === undefined) this.outputName = this.outputNodes[0]?.name ?? '';
    if (!Number.isFinite(parsed.outputWidth)) this.outputWidth = this.outputNodes[0]?.width ?? legacyOutput.width;
    if (!Number.isFinite(parsed.outputHeight)) this.outputHeight = this.outputNodes[0]?.height ?? legacyOutput.height;
    if (parsed.outputColor === undefined) this.outputColor = this.outputNodes[0]?.color ?? legacyOutput.color;
    if (!Number.isFinite(parsed.outputX)) this.outputX = this.outputNodes[0]?.x ?? legacyOutput.x;
    if (!Number.isFinite(parsed.outputY)) this.outputY = this.outputNodes[0]?.y ?? legacyOutput.y;
    this.panX = Number.isFinite(parsed.panX) ? roundWorkflowNumber(parsed.panX!) : 0;
    this.panY = Number.isFinite(parsed.panY) ? roundWorkflowNumber(parsed.panY!) : 0;
    this.zoom = Number.isFinite(parsed.zoom) ? Math.min(4, Math.max(0.2, Number(parsed.zoom!.toFixed(3)))) : 1;
    this.storyboardDataUrl = parsed.storyboardDataUrl ?? null;
    this.storyboardWidth = Number.isFinite(parsed.storyboardWidth) ? Math.max(64, roundWorkflowNumber(parsed.storyboardWidth!)) : 1024;
    this.storyboardHeight = Number.isFinite(parsed.storyboardHeight) ? Math.max(64, roundWorkflowNumber(parsed.storyboardHeight!)) : 768;
    this.storyboardOraPath = parsed.storyboardOraPath ?? null;
    this.storyboardAnnotations = Array.isArray(parsed.storyboardAnnotations)
      ? parsed.storyboardAnnotations.map((annotation) => String(annotation).trim()).filter(Boolean).slice(0, 24)
      : [];
    this.storyboardAnnotationItems = coerceAnnotations(parsed.storyboardAnnotationItems);
    this.storyboardAnnotationsVisible = parsed.storyboardAnnotationsVisible !== false;
    this.nodes = parsed.nodes.map((node, index) => ({
      id: node.id || this.nextGraphId('node'),
      assetId: node.assetId ?? null,
      name: node.name || `Asset ${index + 1}`,
      relativePath: node.relativePath || '',
      x: Number.isFinite(node.x) ? roundWorkflowNumber(node.x) : 80 + index * 32,
      y: Number.isFinite(node.y) ? roundWorkflowNumber(node.y) : 120 + index * 32,
      width: Number.isFinite(node.width) ? Math.max(160, roundWorkflowNumber(node.width!)) : 205,
      height: Number.isFinite(node.height) ? Math.max(130, roundWorkflowNumber(node.height!)) : 190,
      color: node.color || '#3a3c42',
      included: node.included ?? true,
      note: node.note ?? '',
    }));
    const parsedConnections = Array.isArray(parsed.connections)
      ? parsed.connections
        .filter((connection): connection is WorkflowConnection => typeof connection?.id === 'string' && typeof connection.from === 'string' && typeof connection.to === 'string')
        .filter((connection, index, all) => all.findIndex((item) => item.from === connection.from && item.to === connection.to) === index)
      : [];
    const loadedNodeIds = new Set([
      'composition',
      ...this.nodes.map((node) => node.id),
      ...this.outputNodes.map((node) => node.id),
    ]);
    this.connections = parsedConnections.filter((connection) => (
      connection.from !== connection.to
      && loadedNodeIds.has(connection.from)
      && loadedNodeIds.has(connection.to)
    ));
    if (!parsedConnections.length) {
      this.connections = this.nodes
        .filter((node) => node.included)
        .map((node) => ({ id: this.nextGraphId('edge'), from: node.id, to: 'composition' }));
      this.connections = [
        ...this.connections,
        ...this.outputNodes.map((node) => ({ id: this.nextGraphId('edge'), from: 'composition', to: node.id })),
      ];
    }
    this.outputAssetId = this.outputNodes[0]?.outputAssetId ?? parsed.outputAssetId ?? null;
    this.outputRelativePath = this.outputNodes[0]?.outputRelativePath ?? parsed.outputRelativePath ?? null;
    this.rev = 0;
    this.savedRev = 0;
    this.resetGraphDomain();
  }

  async save(): Promise<string | null> {
    if (!project.path) return null;
    const name = `${this.name || 'workflow'}.cxflow.json`;
    const relativePath = this.savedPath
      ? await project.saveDocumentToPath(this.savedPath, this.toBytes())
      : await project.saveDocument(name, this.toBytes());
    if (relativePath) {
      this.savedPath = relativePath;
      this.savedRev = this.rev;
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

  private resetGraphDomain(): void {
    this.graphDomain = new WorkflowGraphDomain(this.domainGraphFromReactiveState(), {
      idGenerator: this.graphIdGenerator,
    });
    this.projectedGraphRevision = this.graphDomain.revision;
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
        outputs: [{ id: 'composition', label: 'Composition', dataType: 'layout' }],
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
        inputs: [{ id: 'composition', label: 'Composition', dataType: 'layout' }],
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
      metadata: { name: this.name, sourceVersion: 1, migrations: [{ from: 1, to: 2 }] },
      viewport: { panX: this.panX, panY: this.panY, zoom: this.zoom },
      nodes: [...assets, composition, ...outputs],
      edges: this.connections.map((connection) => ({
        id: connection.id,
        source: {
          nodeId: connection.from,
          portId: connection.from === 'composition' ? 'composition' : 'asset',
        },
        target: {
          nodeId: connection.to,
          portId: connection.to === 'composition' ? 'assets' : 'composition',
        },
      })),
      assetReferences: [],
      runRecords: [],
    };
  }

  private syncReactiveGraph(domain: WorkflowGraphDomain): void {
    const composition = domain.node('composition');
    if (composition) {
      this.compositionName = typeof composition.config.displayName === 'string'
        ? composition.config.displayName
        : composition.title;
      this.promptX = composition.position.x;
      this.promptY = composition.position.y;
      this.compositionWidth = composition.size.width;
      this.compositionHeight = composition.size.height;
      this.compositionColor = composition.color;
      this.prompt = typeof composition.config.prompt === 'string' ? composition.config.prompt : '';
      this.storyboardDataUrl = typeof composition.config.storyboardDataUrl === 'string'
        ? composition.config.storyboardDataUrl
        : null;
      this.storyboardWidth = typeof composition.config.storyboardWidth === 'number'
        ? composition.config.storyboardWidth
        : 1024;
      this.storyboardHeight = typeof composition.config.storyboardHeight === 'number'
        ? composition.config.storyboardHeight
        : 768;
      this.storyboardOraPath = typeof composition.config.storyboardOraPath === 'string'
        ? composition.config.storyboardOraPath
        : null;
      this.storyboardAnnotations = Array.isArray(composition.config.storyboardAnnotations)
        ? composition.config.storyboardAnnotations.filter((item): item is string => typeof item === 'string')
        : [];
      this.storyboardAnnotationItems = coerceAnnotations(composition.config.storyboardAnnotationItems);
      this.storyboardAnnotationsVisible = composition.config.storyboardAnnotationsVisible !== false;
    }
    this.nodes = domain.graph.nodes
      .filter((node) => node.config.legacyKind === 'asset')
      .map((node) => ({
        id: node.id,
        assetId: typeof node.config.assetId === 'string' ? node.config.assetId : null,
        name: node.title,
        relativePath: typeof node.config.relativePath === 'string' ? node.config.relativePath : '',
        x: node.position.x,
        y: node.position.y,
        width: node.size.width,
        height: node.size.height,
        color: node.color,
        included: domain.isConnected(node.id, 'composition'),
        note: typeof node.config.note === 'string' ? node.config.note : '',
      }));
    this.outputNodes = domain.graph.nodes
      .filter((node) => node.config.legacyKind === 'output')
      .map((node) => ({
        id: node.id,
        name: typeof node.config.displayName === 'string' ? node.config.displayName : node.title,
        x: node.position.x,
        y: node.position.y,
        width: node.size.width,
        height: node.size.height,
        color: node.color,
        finalWidth: typeof node.config.finalWidth === 'number' ? node.config.finalWidth : 1024,
        finalHeight: typeof node.config.finalHeight === 'number' ? node.config.finalHeight : 1024,
        outputAssetId: typeof node.config.outputAssetId === 'string' ? node.config.outputAssetId : null,
        outputRelativePath: typeof node.config.outputRelativePath === 'string' ? node.config.outputRelativePath : null,
      }));
    this.connections = domain.graph.edges.map((edge) => ({
      id: edge.id,
      from: edge.source.nodeId,
      to: edge.target.nodeId,
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
