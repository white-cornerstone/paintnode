import type { ProjectAsset } from '../integrations/desktop';
import { project } from './project.svelte';
import { ui } from './ui.svelte';

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

export type WorkflowTool = 'hand' | 'zoom' | 'asset' | 'composition' | 'output';
export type WorkflowSelection = { kind: 'asset'; id: string } | { kind: 'composition' } | { kind: 'output' };
export type WorkflowZoomMode = 'in' | 'out';

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
  panX?: number;
  panY?: number;
  zoom?: number;
  storyboardDataUrl: string | null;
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

class WorkflowStore {
  active = $state(false);
  name = $state('Untitled Workflow');
  savedPath = $state<string | null>(null);
  tool = $state<WorkflowTool>('hand');
  zoomMode = $state<WorkflowZoomMode>('in');
  selection = $state<WorkflowSelection | null>({ kind: 'composition' });
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
  panX = $state(0);
  panY = $state(0);
  zoom = $state(1);
  storyboardDataUrl = $state<string | null>(null);
  nodes = $state<WorkflowAssetNode[]>([]);
  connections = $state<WorkflowConnection[]>([]);
  outputAssetId = $state<string | null>(null);
  outputRelativePath = $state<string | null>(null);
  rev = $state(0);
  savedRev = $state(0);

  get dirty(): boolean {
    this.rev;
    return this.rev !== this.savedRev;
  }

  newBoard(name = 'Untitled Workflow'): void {
    this.active = true;
    ui.showWorkflow();
    this.name = cleanWorkflowName(name);
    this.savedPath = null;
    this.tool = 'hand';
    this.zoomMode = 'in';
    this.selection = { kind: 'composition' };
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
    this.panX = 0;
    this.panY = 0;
    this.zoom = 1;
    this.storyboardDataUrl = null;
    this.nodes = [];
    this.connections = [];
    this.outputAssetId = null;
    this.outputRelativePath = null;
    this.rev = 0;
    this.savedRev = 0;
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

  select(selection: WorkflowSelection | null): void {
    this.selection = selection;
  }

  addAsset(asset: ProjectAsset): void {
    const index = this.nodes.length;
    const node = {
      id: id('asset'),
      assetId: asset.id,
      name: asset.name.replace(/\.[^.]+$/, '') || 'Asset',
      relativePath: asset.relativePath,
      x: 80 + (index % 3) * 230,
      y: 110 + Math.floor(index / 3) * 160,
      width: 205,
      height: 190,
      color: '#3a3c42',
      included: true,
      note: '',
    };
    this.nodes = [
      ...this.nodes,
      node,
    ];
    this.connect(node.id, 'composition');
    this.selection = { kind: 'asset', id: node.id };
    this.tool = 'hand';
  }

  addBlankAsset(x: number, y: number, width: number, height: number): void {
    const node = {
      id: id('asset'),
      assetId: null,
      name: `Asset ${this.nodes.length + 1}`,
      relativePath: '',
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(160, Math.round(width)),
      height: Math.max(130, Math.round(height)),
      color: '#3a3c42',
      included: true,
      note: '',
    };
    this.nodes = [...this.nodes, node];
    this.connect(node.id, 'composition');
    this.selection = { kind: 'asset', id: node.id };
    this.tool = 'hand';
  }

  removeNode(id: string): void {
    this.nodes = this.nodes.filter((node) => node.id !== id);
    this.connections = this.connections.filter((connection) => connection.from !== id && connection.to !== id);
    if (this.selection?.kind === 'asset' && this.selection.id === id) this.selection = null;
    this.bump();
  }

  moveNode(id: string, x: number, y: number): void {
    const node = this.nodes.find((item) => item.id === id);
    if (!node) return;
    node.x = Math.round(x);
    node.y = Math.round(y);
    this.bump();
  }

  resizeNode(id: string, width: number, height: number): void {
    const node = this.nodes.find((item) => item.id === id);
    if (!node) return;
    node.width = Math.max(160, Math.round(width));
    node.height = Math.max(130, Math.round(height));
    this.bump();
  }

  movePrompt(x: number, y: number): void {
    this.promptX = Math.round(x);
    this.promptY = Math.round(y);
    this.bump();
  }

  resizePrompt(width: number, height: number): void {
    this.compositionWidth = Math.max(260, Math.round(width));
    this.compositionHeight = Math.max(260, Math.round(height));
    this.bump();
  }

  moveOutput(x: number, y: number): void {
    this.outputX = Math.round(x);
    this.outputY = Math.round(y);
    this.bump();
  }

  resizeOutput(width: number, height: number): void {
    this.outputWidth = Math.max(170, Math.round(width));
    this.outputHeight = Math.max(150, Math.round(height));
    this.bump();
  }

  panBy(dx: number, dy: number): void {
    this.panX = Math.round(this.panX + dx);
    this.panY = Math.round(this.panY + dy);
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
    this.panX = Math.round(viewX - worldX * this.zoom);
    this.panY = Math.round(viewY - worldY * this.zoom);
  }

  resetZoom(): void {
    this.zoom = 1;
  }

  setNodeIncluded(id: string, included: boolean): void {
    const node = this.nodes.find((item) => item.id === id);
    if (!node) return;
    const wasIncluded = node.included;
    if (included) {
      if (!this.isConnected(id, 'composition')) this.connect(id, 'composition');
      else if (!wasIncluded) {
        node.included = true;
        this.bump();
      }
    } else {
      this.disconnectNodes(id, 'composition');
    }
  }

  connect(from: string, to: string): void {
    if (!this.canConnect(from, to)) return;
    if (this.connections.some((connection) => connection.from === from && connection.to === to)) return;
    this.connections = [
      ...this.connections,
      { id: id('connection'), from, to },
    ];
    const fromNode = this.nodes.find((node) => node.id === from);
    if (fromNode && to === 'composition') fromNode.included = true;
    this.bump();
  }

  disconnectConnection(id: string): void {
    const connection = this.connections.find((item) => item.id === id);
    if (!connection) return;
    this.connections = this.connections.filter((item) => item.id !== id);
    if (connection?.to === 'composition') {
      const node = this.nodes.find((item) => item.id === connection.from);
      if (node) node.included = this.connections.some((item) => item.from === node.id && item.to === 'composition');
    }
    this.bump();
  }

  disconnectNodes(from: string, to: string): void {
    const before = this.connections.length;
    const node = to === 'composition' ? this.nodes.find((item) => item.id === from) : null;
    const wasIncluded = node?.included ?? false;
    this.connections = this.connections.filter((connection) => connection.from !== from || connection.to !== to);
    if (node) node.included = false;
    if (this.connections.length !== before || wasIncluded !== (node?.included ?? false)) this.bump();
  }

  isConnected(from: string, to: string): boolean {
    return this.connections.some((connection) => connection.from === from && connection.to === to);
  }

  incoming(nodeId: string): WorkflowConnection[] {
    return this.connections.filter((connection) => connection.to === nodeId);
  }

  outgoing(nodeId: string): WorkflowConnection[] {
    return this.connections.filter((connection) => connection.from === nodeId);
  }

  connectedAssetNodesTo(nodeId: string): WorkflowAssetNode[] {
    const incomingIds = new Set(this.incoming(nodeId).map((connection) => connection.from));
    return this.nodes.filter((node) => incomingIds.has(node.id));
  }

  canConnect(from: string, to: string): boolean {
    return from !== to && this.workflowNodeExists(from) && this.workflowNodeExists(to);
  }

  private workflowNodeExists(nodeId: string): boolean {
    return nodeId === 'composition' || nodeId === 'output' || this.nodes.some((node) => node.id === nodeId);
  }

  setPrompt(prompt: string): void {
    this.prompt = prompt;
    this.bump();
  }

  setStoryboardDataUrl(dataUrl: string | null): void {
    this.storyboardDataUrl = dataUrl;
    this.bump();
  }

  setNodeNote(id: string, note: string): void {
    const node = this.nodes.find((item) => item.id === id);
    if (!node) return;
    node.note = note;
    this.bump();
  }

  selectedLabel(): string {
    const selection = this.selection;
    if (selection?.kind === 'asset') {
      return this.nodes.find((node) => node.id === selection.id)?.name ?? '';
    }
    if (selection?.kind === 'composition') return this.compositionName;
    if (selection?.kind === 'output') return this.outputName;
    return '';
  }

  selectedColor(): string {
    const selection = this.selection;
    if (selection?.kind === 'asset') {
      return this.nodes.find((node) => node.id === selection.id)?.color ?? '#3a3c42';
    }
    if (selection?.kind === 'composition') return this.compositionColor;
    if (selection?.kind === 'output') return this.outputColor;
    return '#3a3c42';
  }

  setSelectedLabel(name: string): void {
    const selection = this.selection;
    if (selection?.kind === 'asset') {
      const node = this.nodes.find((item) => item.id === selection.id);
      if (!node) return;
      node.name = name.trim() || 'Asset';
    } else if (selection?.kind === 'composition') {
      this.compositionName = name.trim();
    } else if (selection?.kind === 'output') {
      this.outputName = name.trim();
    } else {
      return;
    }
    this.bump();
  }

  setSelectedColor(color: string): void {
    const selection = this.selection;
    if (selection?.kind === 'asset') {
      const node = this.nodes.find((item) => item.id === selection.id);
      if (!node) return;
      node.color = color;
    } else if (selection?.kind === 'composition') {
      this.compositionColor = color;
    } else if (selection?.kind === 'output') {
      this.outputColor = color;
    } else {
      return;
    }
    this.bump();
  }

  setOutput(asset: ProjectAsset | null): void {
    this.outputAssetId = asset?.id ?? null;
    this.outputRelativePath = asset?.relativePath ?? null;
    this.bump();
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
      panX: this.panX,
      panY: this.panY,
      zoom: this.zoom,
      storyboardDataUrl: this.storyboardDataUrl,
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
      throw new Error('Workflow file is not a supported CX Paint workflow.');
    }
    this.active = true;
    ui.showWorkflow();
    this.tool = 'hand';
    this.zoomMode = 'in';
    this.selection = { kind: 'composition' };
    this.name = cleanWorkflowName(parsed.name ?? fallbackName);
    this.savedPath = savedPath;
    this.prompt = parsed.prompt ?? '';
    this.compositionName = parsed.compositionName ?? '';
    this.compositionWidth = Number.isFinite(parsed.compositionWidth) ? Math.round(parsed.compositionWidth!) : 340;
    this.compositionHeight = Number.isFinite(parsed.compositionHeight) ? Math.round(parsed.compositionHeight!) : 408;
    this.compositionColor = parsed.compositionColor ?? '#3a3c42';
    this.promptX = Number.isFinite(parsed.promptX) ? Math.round(parsed.promptX!) : 480;
    this.promptY = Number.isFinite(parsed.promptY) ? Math.round(parsed.promptY!) : 70;
    this.outputName = parsed.outputName ?? '';
    this.outputWidth = Number.isFinite(parsed.outputWidth) ? Math.round(parsed.outputWidth!) : 210;
    this.outputHeight = Number.isFinite(parsed.outputHeight) ? Math.round(parsed.outputHeight!) : 190;
    this.outputColor = parsed.outputColor ?? '#3a3c42';
    this.outputX = Number.isFinite(parsed.outputX) ? Math.round(parsed.outputX!) : 895;
    this.outputY = Number.isFinite(parsed.outputY) ? Math.round(parsed.outputY!) : 96;
    this.panX = Number.isFinite(parsed.panX) ? Math.round(parsed.panX!) : 0;
    this.panY = Number.isFinite(parsed.panY) ? Math.round(parsed.panY!) : 0;
    this.zoom = Number.isFinite(parsed.zoom) ? Math.min(4, Math.max(0.2, Number(parsed.zoom!.toFixed(3)))) : 1;
    this.storyboardDataUrl = parsed.storyboardDataUrl ?? null;
    this.nodes = parsed.nodes.map((node, index) => ({
      id: node.id || id('asset'),
      assetId: node.assetId ?? null,
      name: node.name || `Asset ${index + 1}`,
      relativePath: node.relativePath || '',
      x: Number.isFinite(node.x) ? Math.round(node.x) : 80 + index * 32,
      y: Number.isFinite(node.y) ? Math.round(node.y) : 120 + index * 32,
      width: Number.isFinite(node.width) ? Math.max(160, Math.round(node.width!)) : 205,
      height: Number.isFinite(node.height) ? Math.max(130, Math.round(node.height!)) : 190,
      color: node.color || '#3a3c42',
      included: node.included ?? true,
      note: node.note ?? '',
    }));
    const parsedConnections = Array.isArray(parsed.connections)
      ? parsed.connections
        .filter((connection): connection is WorkflowConnection => typeof connection?.id === 'string' && typeof connection.from === 'string' && typeof connection.to === 'string')
        .filter((connection, index, all) => all.findIndex((item) => item.from === connection.from && item.to === connection.to) === index)
      : [];
    this.connections = parsedConnections.filter((connection) => this.canConnect(connection.from, connection.to));
    if (!parsedConnections.length) {
      this.connections = this.nodes
        .filter((node) => node.included)
        .map((node) => ({ id: id('connection'), from: node.id, to: 'composition' }));
    }
    this.outputAssetId = parsed.outputAssetId ?? null;
    this.outputRelativePath = parsed.outputRelativePath ?? null;
    this.rev = 0;
    this.savedRev = 0;
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

  private bump(): void {
    this.rev++;
  }
}

export const workflow = new WorkflowStore();
