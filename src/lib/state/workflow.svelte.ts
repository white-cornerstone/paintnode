import type { ProjectAsset } from '../integrations/desktop';
import { project } from './project.svelte';

export interface WorkflowAssetNode {
  id: string;
  assetId: string | null;
  name: string;
  relativePath: string;
  x: number;
  y: number;
  note: string;
}

export interface WorkflowFile {
  version: 1;
  name: string;
  prompt: string;
  nodes: WorkflowAssetNode[];
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
  prompt = $state('');
  nodes = $state<WorkflowAssetNode[]>([]);
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
    this.name = cleanWorkflowName(name);
    this.savedPath = null;
    this.prompt = '';
    this.nodes = [];
    this.outputAssetId = null;
    this.outputRelativePath = null;
    this.rev = 0;
    this.savedRev = 0;
  }

  show(): void {
    if (!this.active) this.newBoard();
    this.active = true;
  }

  close(): void {
    this.active = false;
  }

  setName(name: string): void {
    this.name = cleanWorkflowName(name);
    this.bump();
  }

  addAsset(asset: ProjectAsset): void {
    const index = this.nodes.length;
    this.nodes = [
      ...this.nodes,
      {
        id: id('asset'),
        assetId: asset.id,
        name: asset.name.replace(/\.[^.]+$/, '') || 'Asset',
        relativePath: asset.relativePath,
        x: 80 + (index % 3) * 230,
        y: 110 + Math.floor(index / 3) * 160,
        note: '',
      },
    ];
    this.bump();
  }

  removeNode(id: string): void {
    this.nodes = this.nodes.filter((node) => node.id !== id);
    this.bump();
  }

  moveNode(id: string, x: number, y: number): void {
    const node = this.nodes.find((item) => item.id === id);
    if (!node) return;
    node.x = Math.round(x);
    node.y = Math.round(y);
    this.bump();
  }

  setPrompt(prompt: string): void {
    this.prompt = prompt;
    this.bump();
  }

  setNodeNote(id: string, note: string): void {
    const node = this.nodes.find((item) => item.id === id);
    if (!node) return;
    node.note = note;
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
      nodes: this.nodes.map((node) => ({ ...node })),
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
    this.name = cleanWorkflowName(parsed.name ?? fallbackName);
    this.savedPath = savedPath;
    this.prompt = parsed.prompt ?? '';
    this.nodes = parsed.nodes.map((node, index) => ({
      id: node.id || id('asset'),
      assetId: node.assetId ?? null,
      name: node.name || `Asset ${index + 1}`,
      relativePath: node.relativePath || '',
      x: Number.isFinite(node.x) ? Math.round(node.x) : 80 + index * 32,
      y: Number.isFinite(node.y) ? Math.round(node.y) : 120 + index * 32,
      note: node.note ?? '',
    })).filter((node) => node.relativePath);
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
