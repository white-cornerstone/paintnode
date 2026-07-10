import { WorkflowDomainError, WorkflowGraphDomain } from './domain';
import {
  CREATOR_NODE_DEFINITIONS,
  createCreatorNode,
  creatorNodeDefinition,
  type CreatorNodeType,
} from './registry';
import { WORKFLOW_GRAPH_VERSION, type WorkflowEdgeV2, type WorkflowGraphV2, type WorkflowNodePort } from './schema';

export const WORKFLOW_DIRECTOR_CONTEXT_VERSION = 1 as const;
export const WORKFLOW_DIRECTOR_GRAPH_DRAFT_VERSION = 1 as const;

export interface WorkflowDirectorAssetInput {
  id: string;
  name: string;
  kind: string;
  mime?: string | null;
  width?: number | null;
  height?: number | null;
  exists: boolean;
}

export interface WorkflowDirectorAsset {
  id: string;
  name: string;
  kind: string;
  mime: string | null;
  width: number | null;
  height: number | null;
  available: boolean;
}

export interface WorkflowDirectorRequestedOutput {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface WorkflowDirectorCapability {
  id: string;
  available: boolean;
  reason: string | null;
}

export interface WorkflowDirectorRegistryPort {
  id: string;
  label: string;
  dataType: WorkflowNodePort['dataType'];
  required: boolean;
  multiple: boolean;
}

export interface WorkflowDirectorRegistryNode {
  type: CreatorNodeType;
  label: string;
  description: string;
  inputs: readonly WorkflowDirectorRegistryPort[];
  outputs: readonly WorkflowDirectorRegistryPort[];
  settings: readonly string[];
}

export interface WorkflowDirectorContext {
  version: typeof WORKFLOW_DIRECTOR_CONTEXT_VERSION;
  brief: string;
  registry: readonly WorkflowDirectorRegistryNode[];
  assets: readonly WorkflowDirectorAsset[];
  requestedOutputs: readonly WorkflowDirectorRequestedOutput[];
  capabilities: readonly WorkflowDirectorCapability[];
}

export interface BuildWorkflowDirectorContextOptions {
  brief: string;
  assets: readonly WorkflowDirectorAssetInput[];
  requestedOutputs: readonly WorkflowDirectorRequestedOutput[];
  capabilities: readonly WorkflowDirectorCapability[];
}

interface WorkflowDirectorNodeBase {
  id: string;
  title: string;
}

export interface WorkflowDirectorInputDraft extends WorkflowDirectorNodeBase {
  type: 'input';
  assetId: string | null;
  role: string;
  required: boolean;
}

export interface WorkflowDirectorBriefDraft extends WorkflowDirectorNodeBase {
  type: 'brief';
  objective: string;
  guidance: string;
}

export interface WorkflowDirectorArtDirectionDraft extends WorkflowDirectorNodeBase {
  type: 'art-direction';
  prompt: string;
}

export interface WorkflowDirectorTransformDraft extends WorkflowDirectorNodeBase {
  type: 'transform';
  capability: string;
  instructions: string;
}

export interface WorkflowDirectorReviewDraft extends WorkflowDirectorNodeBase {
  type: 'review';
  mode: 'human' | 'ai-assisted';
  instructions: string;
}

export interface WorkflowDirectorOutputDraft extends WorkflowDirectorNodeBase {
  type: 'output';
  width: number;
  height: number;
}

export type WorkflowDirectorNodeDraft =
  | WorkflowDirectorInputDraft
  | WorkflowDirectorBriefDraft
  | WorkflowDirectorArtDirectionDraft
  | WorkflowDirectorTransformDraft
  | WorkflowDirectorReviewDraft
  | WorkflowDirectorOutputDraft;

export interface WorkflowDirectorEdgeDraft {
  id: string;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
}

export interface WorkflowDirectorGraphDraft {
  version: typeof WORKFLOW_DIRECTOR_GRAPH_DRAFT_VERSION;
  name: string;
  summary: string;
  nodes: WorkflowDirectorNodeDraft[];
  edges: WorkflowDirectorEdgeDraft[];
}

export interface WorkflowDirectorSchemaIssue {
  path: string;
  message: string;
}

export type WorkflowDirectorProposalIssueStage = 'domain' | 'connection' | 'capability' | 'readiness';

export interface WorkflowDirectorProposalIssue {
  stage: WorkflowDirectorProposalIssueStage;
  code: string;
  message: string;
  nodeId?: string;
}

export interface WorkflowDirectorRequirement {
  id: string;
  label: string;
  detail: string;
  status: 'ready' | 'missing' | 'unsupported';
}

export interface WorkflowDirectorUnsupportedCapability {
  capability: string;
  nodeId: string;
  reason: string;
}

export interface WorkflowDirectorProposal {
  draft: WorkflowDirectorGraphDraft;
  graph: WorkflowGraphV2;
  summary: string;
  nodes: readonly { id: string; type: CreatorNodeType; title: string }[];
  requirements: readonly WorkflowDirectorRequirement[];
  unsupportedCapabilities: readonly WorkflowDirectorUnsupportedCapability[];
  issues: readonly WorkflowDirectorProposalIssue[];
  canAccept: boolean;
}

export interface WorkflowDirectorProposalResult {
  proposal: WorkflowDirectorProposal | null;
  schemaIssues: readonly WorkflowDirectorSchemaIssue[];
}

export interface WorkflowDirector {
  draft(context: WorkflowDirectorContext): Promise<unknown>;
}

const nodeSettings: Readonly<Record<CreatorNodeType, readonly string[]>> = {
  input: ['assetId', 'role', 'required'],
  brief: ['objective', 'guidance'],
  'art-direction': ['prompt'],
  transform: ['capability', 'instructions'],
  review: ['mode', 'instructions'],
  output: ['width', 'height'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    Object.values(value).forEach(deepFreeze);
    return Object.freeze(value) as T;
  }
  return value;
}

function detachedFrozen<T>(value: T): T {
  return deepFreeze(cloneValue(value));
}

function contextPort(port: Readonly<WorkflowNodePort>): WorkflowDirectorRegistryPort {
  return {
    id: port.id,
    label: port.label,
    dataType: port.dataType,
    required: port.required === true,
    multiple: port.multiple === true,
  };
}

export function buildWorkflowDirectorContext(
  options: BuildWorkflowDirectorContextOptions,
): WorkflowDirectorContext {
  return detachedFrozen({
    version: WORKFLOW_DIRECTOR_CONTEXT_VERSION,
    brief: options.brief.trim(),
    registry: CREATOR_NODE_DEFINITIONS.map((definition) => ({
      type: definition.type,
      label: definition.label,
      description: definition.description,
      inputs: definition.ports.inputs.map(contextPort),
      outputs: definition.ports.outputs.map(contextPort),
      settings: [...nodeSettings[definition.type]],
    })),
    assets: options.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      mime: typeof asset.mime === 'string' ? asset.mime : null,
      width: typeof asset.width === 'number' && Number.isFinite(asset.width) ? asset.width : null,
      height: typeof asset.height === 'number' && Number.isFinite(asset.height) ? asset.height : null,
      available: asset.exists === true,
    })),
    requestedOutputs: options.requestedOutputs.map((output) => ({
      id: output.id,
      name: output.name,
      width: output.width,
      height: output.height,
    })),
    capabilities: options.capabilities.map((capability) => ({
      id: capability.id,
      available: capability.available === true,
      reason: capability.reason ?? null,
    })),
  });
}

function schemaIssue(issues: WorkflowDirectorSchemaIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: WorkflowDirectorSchemaIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) schemaIssue(issues, path ? `${path}.${key}` : key, `Property "${key}" is not allowed.`);
  }
}

function stringValue(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: WorkflowDirectorSchemaIssue[],
  maxLength = 2_000,
): string {
  const candidate = value[key];
  if (typeof candidate !== 'string' || candidate.trim().length === 0 || candidate.length > maxLength) {
    schemaIssue(issues, `${path}.${key}`, `${key} must be a non-empty string no longer than ${maxLength} characters.`);
    return '';
  }
  return candidate.trim();
}

function nullableStringValue(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: WorkflowDirectorSchemaIssue[],
): string | null {
  const candidate = value[key];
  if (candidate === null) return null;
  if (typeof candidate !== 'string' || candidate.trim().length === 0 || candidate.length > 256) {
    schemaIssue(issues, `${path}.${key}`, `${key} must be null or a non-empty string no longer than 256 characters.`);
    return null;
  }
  return candidate.trim();
}

function booleanValue(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: WorkflowDirectorSchemaIssue[],
): boolean {
  if (typeof value[key] !== 'boolean') {
    schemaIssue(issues, `${path}.${key}`, `${key} must be a boolean.`);
    return false;
  }
  return value[key] as boolean;
}

function dimensionValue(
  value: Record<string, unknown>,
  key: string,
  path: string,
  issues: WorkflowDirectorSchemaIssue[],
): number {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate) || (candidate as number) < 64 || (candidate as number) > 16_384) {
    schemaIssue(issues, `${path}.${key}`, `${key} must be a safe integer between 64 and 16384.`);
    return 64;
  }
  return candidate as number;
}

function parseNode(
  value: unknown,
  index: number,
  issues: WorkflowDirectorSchemaIssue[],
): WorkflowDirectorNodeDraft | null {
  const path = `nodes[${index}]`;
  if (!isRecord(value)) {
    schemaIssue(issues, path, 'Node must be an object.');
    return null;
  }
  const type = value.type;
  if (!CREATOR_NODE_DEFINITIONS.some((definition) => definition.type === type)) {
    schemaIssue(issues, `${path}.type`, `Unsupported creator node type: ${String(type)}.`);
    return null;
  }
  const creatorType = type as CreatorNodeType;
  exactKeys(value, ['id', 'type', 'title', ...nodeSettings[creatorType]], path, issues);
  const base = {
    id: stringValue(value, 'id', path, issues, 64),
    title: stringValue(value, 'title', path, issues, 160),
  };
  if (creatorType === 'input') {
    return {
      ...base,
      type: 'input',
      assetId: nullableStringValue(value, 'assetId', path, issues),
      role: stringValue(value, 'role', path, issues, 500),
      required: booleanValue(value, 'required', path, issues),
    };
  }
  if (creatorType === 'brief') {
    return {
      ...base,
      type: 'brief',
      objective: stringValue(value, 'objective', path, issues),
      guidance: stringValue(value, 'guidance', path, issues),
    };
  }
  if (creatorType === 'art-direction') {
    return { ...base, type: 'art-direction', prompt: stringValue(value, 'prompt', path, issues) };
  }
  if (creatorType === 'transform') {
    return {
      ...base,
      type: 'transform',
      capability: stringValue(value, 'capability', path, issues, 80),
      instructions: stringValue(value, 'instructions', path, issues),
    };
  }
  if (creatorType === 'review') {
    const mode = value.mode;
    if (mode !== 'human' && mode !== 'ai-assisted') {
      schemaIssue(issues, `${path}.mode`, 'mode must be "human" or "ai-assisted".');
    }
    return {
      ...base,
      type: 'review',
      mode: mode === 'ai-assisted' ? 'ai-assisted' : 'human',
      instructions: stringValue(value, 'instructions', path, issues),
    };
  }
  return {
    ...base,
    type: 'output',
    width: dimensionValue(value, 'width', path, issues),
    height: dimensionValue(value, 'height', path, issues),
  };
}

function parseEndpoint(
  value: unknown,
  path: string,
  issues: WorkflowDirectorSchemaIssue[],
): { nodeId: string; portId: string } {
  if (!isRecord(value)) {
    schemaIssue(issues, path, 'Endpoint must be an object.');
    return { nodeId: '', portId: '' };
  }
  exactKeys(value, ['nodeId', 'portId'], path, issues);
  return {
    nodeId: stringValue(value, 'nodeId', path, issues, 64),
    portId: stringValue(value, 'portId', path, issues, 64),
  };
}

function parseEdge(
  value: unknown,
  index: number,
  issues: WorkflowDirectorSchemaIssue[],
): WorkflowDirectorEdgeDraft | null {
  const path = `edges[${index}]`;
  if (!isRecord(value)) {
    schemaIssue(issues, path, 'Edge must be an object.');
    return null;
  }
  exactKeys(value, ['id', 'source', 'target'], path, issues);
  return {
    id: stringValue(value, 'id', path, issues, 64),
    source: parseEndpoint(value.source, `${path}.source`, issues),
    target: parseEndpoint(value.target, `${path}.target`, issues),
  };
}

export function parseWorkflowDirectorGraphDraft(input: unknown): {
  value: WorkflowDirectorGraphDraft | null;
  issues: WorkflowDirectorSchemaIssue[];
} {
  const issues: WorkflowDirectorSchemaIssue[] = [];
  if (!isRecord(input)) {
    return { value: null, issues: [{ path: '', message: 'GraphDraft v1 must be an object.' }] };
  }
  exactKeys(input, ['version', 'name', 'summary', 'nodes', 'edges'], '', issues);
  if (input.version !== WORKFLOW_DIRECTOR_GRAPH_DRAFT_VERSION) {
    schemaIssue(issues, 'version', `GraphDraft version must be ${WORKFLOW_DIRECTOR_GRAPH_DRAFT_VERSION}.`);
  }
  const nodes = Array.isArray(input.nodes)
    ? input.nodes.map((node, index) => parseNode(node, index, issues)).filter((node): node is WorkflowDirectorNodeDraft => node !== null)
    : [];
  if (!Array.isArray(input.nodes)) schemaIssue(issues, 'nodes', 'nodes must be an array.');
  if (nodes.length === 0 || nodes.length > 64) schemaIssue(issues, 'nodes', 'nodes must contain between 1 and 64 creator nodes.');
  const edges = Array.isArray(input.edges)
    ? input.edges.map((edge, index) => parseEdge(edge, index, issues)).filter((edge): edge is WorkflowDirectorEdgeDraft => edge !== null)
    : [];
  if (!Array.isArray(input.edges)) schemaIssue(issues, 'edges', 'edges must be an array.');
  if (edges.length > 128) schemaIssue(issues, 'edges', 'edges must contain no more than 128 connections.');
  const value: WorkflowDirectorGraphDraft = {
    version: WORKFLOW_DIRECTOR_GRAPH_DRAFT_VERSION,
    name: stringValue(input, 'name', '', issues, 160),
    summary: stringValue(input, 'summary', '', issues, 2_000),
    nodes,
    edges,
  };
  return issues.length > 0 ? { value: null, issues } : { value: detachedFrozen(value), issues };
}

function nodeConfig(node: WorkflowDirectorNodeDraft): Record<string, unknown> {
  if (node.type === 'input') {
    return { creatorRole: 'input', assetId: node.assetId, relativePath: null, role: node.role, required: node.required };
  }
  if (node.type === 'brief') {
    return { creatorRole: 'brief', objective: node.objective, guidance: node.guidance };
  }
  if (node.type === 'art-direction') {
    return {
      creatorRole: 'art-direction',
      displayName: node.title,
      prompt: node.prompt,
      storyboardDataUrl: null,
      storyboardWidth: 1024,
      storyboardHeight: 768,
      storyboardOraPath: null,
      storyboardAnnotations: [],
      storyboardAnnotationItems: [],
      storyboardAnnotationsVisible: true,
    };
  }
  if (node.type === 'transform') {
    return {
      creatorRole: 'transform',
      capability: node.capability,
      instructions: node.instructions,
      advanced: { provider: null, model: null, options: {} },
    };
  }
  if (node.type === 'review') {
    return { creatorRole: 'review', mode: node.mode, instructions: node.instructions };
  }
  return {
    creatorRole: 'output',
    displayName: node.title,
    finalWidth: node.width,
    finalHeight: node.height,
    outputAssetId: null,
    outputRelativePath: null,
  };
}

function materializeDraft(
  draft: WorkflowDirectorGraphDraft,
  graphId: string,
): WorkflowGraphV2 {
  const counts = new Map<CreatorNodeType, number>();
  const columns: Record<CreatorNodeType, number> = {
    input: 30,
    brief: 290,
    'art-direction': 575,
    transform: 965,
    review: 1245,
    output: 1525,
  };
  const nodes = draft.nodes.map((node) => {
    const index = counts.get(node.type) ?? 0;
    counts.set(node.type, index + 1);
    return createCreatorNode(node.type, {
      id: node.id,
      title: node.title,
      position: { x: columns[node.type], y: 30 + index * 270 },
      replaceConfig: true,
      config: nodeConfig(node),
    });
  });
  return {
    version: WORKFLOW_GRAPH_VERSION,
    id: graphId,
    metadata: { name: draft.name, sourceVersion: null, migrations: [] },
    viewport: { panX: 10, panY: 10, zoom: 0.55 },
    nodes,
    edges: draft.edges.map((edge): WorkflowEdgeV2 => cloneValue(edge)),
    assetReferences: [],
    runRecords: [],
  };
}

function missingRequiredInputIssues(graph: WorkflowGraphV2): WorkflowDirectorProposalIssue[] {
  const issues: WorkflowDirectorProposalIssue[] = [];
  for (const node of graph.nodes) {
    for (const port of node.ports.inputs.filter((item) => item.required)) {
      if (!graph.edges.some((edge) => edge.target.nodeId === node.id && edge.target.portId === port.id)) {
        issues.push({
          stage: 'readiness',
          code: 'MISSING_REQUIRED_INPUT',
          nodeId: node.id,
          message: `${node.title} requires a connection on its named ${port.label} port.`,
        });
      }
    }
  }
  return issues;
}

function draftRequirements(
  draft: WorkflowDirectorGraphDraft,
  graph: WorkflowGraphV2,
  context: WorkflowDirectorContext,
): {
  requirements: WorkflowDirectorRequirement[];
  unsupported: WorkflowDirectorUnsupportedCapability[];
  issues: WorkflowDirectorProposalIssue[];
} {
  const requirements: WorkflowDirectorRequirement[] = [];
  const unsupported: WorkflowDirectorUnsupportedCapability[] = [];
  const issues: WorkflowDirectorProposalIssue[] = [];
  const assets = new Map(context.assets.filter((asset) => asset.available).map((asset) => [asset.id, asset]));
  const capabilities = new Map(context.capabilities.map((capability) => [capability.id, capability]));

  for (const node of draft.nodes) {
    if (node.type === 'input') {
      const available = node.assetId !== null && assets.has(node.assetId);
      const status = !node.required || available ? 'ready' : 'missing';
      requirements.push({
        id: `asset:${node.id}`,
        label: node.role || node.title,
        detail: available ? `Uses ${assets.get(node.assetId!)!.name}.` : node.required ? 'A project asset is required.' : 'Optional input may be supplied later.',
        status,
      });
      if (node.assetId !== null && !available) {
        issues.push({
          stage: 'readiness',
          code: 'ASSET_UNAVAILABLE',
          nodeId: node.id,
          message: `${node.title} refers to an asset that is not available in the supplied project asset list.`,
        });
      } else if (node.required && !available) {
        issues.push({
          stage: 'readiness',
          code: 'REQUIRED_ASSET_MISSING',
          nodeId: node.id,
          message: `${node.title} requires an available project asset.`,
        });
      }
    } else if (node.type === 'transform') {
      const availability = capabilities.get(node.capability);
      const available = availability?.available === true;
      const reason = availability?.reason
        ?? (availability ? 'This capability is currently unavailable.' : 'This capability was not included in PaintNode capability availability.');
      requirements.push({
        id: `capability:${node.id}`,
        label: node.capability,
        detail: available ? `${node.title} can use this capability.` : reason,
        status: available ? 'ready' : 'unsupported',
      });
      if (!available) {
        unsupported.push({ capability: node.capability, nodeId: node.id, reason });
        issues.push({
          stage: 'capability',
          code: 'UNSUPPORTED_CAPABILITY',
          nodeId: node.id,
          message: `${node.title} requests unsupported capability “${node.capability}”: ${reason}`,
        });
      }
    }
  }

  for (const output of context.requestedOutputs) {
    const found = draft.nodes.some((node) => node.type === 'output'
      && node.title === output.name && node.width === output.width && node.height === output.height);
    requirements.push({
      id: `output:${output.id}`,
      label: output.name,
      detail: `${output.width} x ${output.height}`,
      status: found ? 'ready' : 'missing',
    });
    if (!found) {
      issues.push({
        stage: 'readiness',
        code: 'REQUESTED_OUTPUT_MISSING',
        message: `Requested output ${output.name} (${output.width} x ${output.height}) is missing.`,
      });
    }
  }
  issues.push(...missingRequiredInputIssues(graph));
  return { requirements, unsupported, issues };
}

function domainStage(code: string): WorkflowDirectorProposalIssueStage {
  return code === 'CYCLE_DETECTED'
    || code === 'SOURCE_PORT_NOT_FOUND'
    || code === 'TARGET_PORT_NOT_FOUND'
    || code === 'INCOMPATIBLE_PORT_TYPES'
    || code === 'UNSUPPORTED_CONNECTION'
    || code === 'TARGET_PORT_OCCUPIED'
    || code === 'DUPLICATE_CONNECTION'
    || code === 'SELF_LINK'
    || code === 'ENDPOINT_NODE_NOT_FOUND'
    ? 'connection'
    : 'domain';
}

let directorGraphSequence = 0;

function freshDirectorGraphId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `workflow-${uuid}`;
  directorGraphSequence += 1;
  return `workflow-director-${Date.now()}-${directorGraphSequence}`;
}

export function createWorkflowDirectorProposal(
  response: unknown,
  context: WorkflowDirectorContext,
  options: { graphId?: string } = {},
): WorkflowDirectorProposalResult {
  const parsed = parseWorkflowDirectorGraphDraft(response);
  if (!parsed.value) return { proposal: null, schemaIssues: detachedFrozen(parsed.issues) };
  const graph = materializeDraft(parsed.value, options.graphId?.trim() || freshDirectorGraphId());
  const proposalIssues: WorkflowDirectorProposalIssue[] = [];
  let normalizedGraph = graph;
  try {
    normalizedGraph = new WorkflowGraphDomain(graph).graph;
  } catch (error) {
    if (error instanceof WorkflowDomainError) {
      proposalIssues.push({
        stage: domainStage(error.code),
        code: error.code,
        message: error.message,
      });
    } else {
      proposalIssues.push({
        stage: 'domain',
        code: 'INVALID_GRAPH',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const readiness = draftRequirements(parsed.value, normalizedGraph, context);
  proposalIssues.push(...readiness.issues);
  const proposal = detachedFrozen({
    draft: parsed.value,
    graph: normalizedGraph,
    summary: parsed.value.summary,
    nodes: parsed.value.nodes.map((node) => ({ id: node.id, type: node.type, title: node.title })),
    requirements: readiness.requirements,
    unsupportedCapabilities: readiness.unsupported,
    issues: proposalIssues,
    canAccept: proposalIssues.length === 0,
  });
  return { proposal, schemaIssues: [] };
}

export async function draftWorkflowWithDirector(
  director: WorkflowDirector,
  context: WorkflowDirectorContext,
  options: { graphId?: string } = {},
): Promise<WorkflowDirectorProposalResult> {
  const response = await director.draft(context);
  return createWorkflowDirectorProposal(response, context, options);
}

function normalizedTitle(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function semanticNodeKey(node: WorkflowGraphV2['nodes'][number]): string {
  if (node.type === 'input') return `input:${normalizedTitle(node.title)}`;
  if (node.type === 'output') {
    return `output:${normalizedTitle(node.title)}:${String(node.config.finalWidth)}x${String(node.config.finalHeight)}`;
  }
  if (node.type === 'transform') return `transform:${String(node.config.capability)}`;
  return node.type;
}

function semanticEdges(graph: WorkflowGraphV2): string[] {
  const keys = new Map(graph.nodes.map((node) => [node.id, semanticNodeKey(node)]));
  return graph.edges.map((edge) => (
    `${keys.get(edge.source.nodeId) ?? edge.source.nodeId}.${edge.source.portId}`
    + `->${keys.get(edge.target.nodeId) ?? edge.target.nodeId}.${edge.target.portId}`
  )).sort();
}

export function isCampaignRequirementsEquivalent(
  candidate: WorkflowGraphV2,
  supportedCampaign: WorkflowGraphV2,
): { equivalent: boolean; differences: string[] } {
  const differences: string[] = [];
  const expectedInputs = supportedCampaign.nodes.filter((node) => node.type === 'input');
  for (const expected of expectedInputs) {
    const actual = candidate.nodes.find((node) => node.type === 'input' && normalizedTitle(node.title) === normalizedTitle(expected.title));
    if (!actual) {
      differences.push(`${expected.title} input is missing.`);
      continue;
    }
    if ((actual.config.required === true) !== (expected.config.required === true)) {
      differences.push(`${expected.title} required status does not match supported Campaign semantics.`);
    }
  }
  const expectedOutputs = supportedCampaign.nodes.filter((node) => node.type === 'output')
    .map(semanticNodeKey).sort();
  const actualOutputs = candidate.nodes.filter((node) => node.type === 'output')
    .map(semanticNodeKey).sort();
  if (JSON.stringify(actualOutputs) !== JSON.stringify(expectedOutputs)) {
    differences.push('Requested Campaign output names and dimensions do not match.');
  }
  for (const node of candidate.nodes) {
    if (node.type === 'unsupported') {
      differences.push(`Unsupported node ${node.title} is not part of Campaign semantics.`);
      continue;
    }
    const definition = creatorNodeDefinition(node.type);
    const ports = (items: readonly WorkflowNodePort[]) => items.map(({ id, dataType, required, multiple }) => ({
      id, dataType, required: required === true, multiple: multiple === true,
    }));
    if (JSON.stringify(ports(node.ports.inputs)) !== JSON.stringify(ports(definition.ports.inputs))
      || JSON.stringify(ports(node.ports.outputs)) !== JSON.stringify(ports(definition.ports.outputs))) {
      differences.push(`${node.title} does not use the registry typed named ports.`);
    }
  }
  const actualEdges = semanticEdges(candidate);
  const expectedEdges = semanticEdges(supportedCampaign);
  if (JSON.stringify(actualEdges) !== JSON.stringify(expectedEdges)) {
    differences.push('Campaign topology and named-port connections do not match supported semantics.');
  }
  return { equivalent: differences.length === 0, differences };
}
