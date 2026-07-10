import { WorkflowGraphDomain } from './domain';
import { planWorkflowExecution, type WorkflowExecutionPlan } from './execution';
import { workflowReadiness } from './readiness';
import {
  createWorkflowRunRecord,
  isFullWorkflowRunRecord,
  workflowSha256Bytes,
  workflowSha256Text,
  type WorkflowRunMaterialDraft,
} from './provenance';
import type {
  WorkflowGraphV2,
  WorkflowNodeV2,
  WorkflowRunExecutor,
  WorkflowRunProvider,
  WorkflowRunRecordV1,
} from './schema';
import type { WorkflowCacheHash } from './execution';
import {
  requireProjectRelativeWorkflowReference,
  safeWorkflowIdentifier,
} from './provenanceSafety';

export interface WorkflowProjectAsset {
  id: string;
  name: string;
  relativePath: string;
  width?: number | null;
  height?: number | null;
  mime?: string | null;
}

export interface WorkflowAssetMaterial {
  bytes: Uint8Array | null;
  contentHash: string;
}

export interface WorkflowTransformSource {
  nodeId: string;
  portId: string;
  name: string;
  role: string;
  assetId: string;
  relativePath: string;
  contentHash: string;
  bytes: Uint8Array;
}

export interface WorkflowStoryboardDescriptor {
  dataUrl: string | null;
  oraPath: string | null;
  width: number;
  height: number;
  annotations: readonly string[];
  annotationItems: readonly unknown[];
  annotationsVisible: boolean;
}

export interface WorkflowStoryboardMaterialization extends WorkflowStoryboardDescriptor {
  placementConstraints: readonly string[];
  source: { name: string; bytes: Uint8Array } | null;
}

export interface WorkflowStoryboardRead {
  bytes: Uint8Array;
  relativePath: string;
}

export interface WorkflowTransformExecutionRequest {
  workflowId: string;
  nodeId: string;
  capability: string;
  provider: string;
  projectPath: string;
  brief: string;
  artDirection: string;
  transform: {
    capability: string;
    instructions: string;
    advanced: Readonly<Record<string, unknown>>;
  };
  prompt: string;
  sources: readonly WorkflowTransformSource[];
  storyboard: WorkflowStoryboardMaterialization | null;
  output: {
    nodeId: string;
    title: string;
    width: number;
    height: number;
  };
}

export interface WorkflowBytesArtifact {
  kind: 'bytes';
  name: string;
  bytes: Uint8Array;
  mime: string;
  width: number;
  height: number;
  contentHash?: string;
}

export interface WorkflowStoredAssetArtifact {
  kind: 'project-asset';
  asset: WorkflowProjectAsset;
  bytes: Uint8Array;
  contentHash?: string;
}

export type WorkflowTransformArtifact = WorkflowBytesArtifact | WorkflowStoredAssetArtifact;

export interface WorkflowNodeExecutor {
  provider: string;
  capabilities: readonly string[];
  materialization?: 'visual-bytes' | 'metadata-only';
  executor: WorkflowRunExecutor;
  describeRun(request: Readonly<WorkflowTransformExecutionRequest>): WorkflowRunProvider;
  execute(request: Readonly<WorkflowTransformExecutionRequest>): Promise<WorkflowTransformArtifact>;
}

export type WorkflowCompositionService = (
  request: Readonly<WorkflowTransformExecutionRequest>,
) => Promise<WorkflowTransformArtifact>;

export interface WorkflowAssetStoreRequest extends Omit<WorkflowBytesArtifact, 'kind'> {
  projectPath: string;
  prompt: string;
}

export interface ExecuteCampaignGenerateOptions {
  projectPath: string | null;
  provider: string;
  executors: readonly WorkflowNodeExecutor[];
  assets: readonly WorkflowProjectAsset[];
  resolveAsset: (asset: Readonly<WorkflowProjectAsset>) => Promise<WorkflowAssetMaterial>;
  readStoryboard?: (storyboard: Readonly<WorkflowStoryboardDescriptor>) => Promise<WorkflowStoryboardRead | null>;
  storeAsset: (request: Readonly<WorkflowAssetStoreRequest>) => Promise<WorkflowProjectAsset>;
  idGenerator?: () => string;
  runIdGenerator?: (nodeId: string, attempt: number) => string;
  clock?: () => number;
  hash?: WorkflowCacheHash;
}

export interface WorkflowTransformExecutionOutcome {
  graph: WorkflowGraphV2;
  plan: WorkflowExecutionPlan;
  request: Readonly<WorkflowTransformExecutionRequest>;
  asset: WorkflowProjectAsset;
  transformNodeId: string;
  outputNodeId: string;
}

export type WorkflowTransformExecutionErrorCode =
  | 'MISSING_PROJECT'
  | 'UNSUPPORTED_PROVIDER'
  | 'INVALID_TRANSFORM_PATH'
  | 'NOT_READY'
  | 'MISSING_ASSET'
  | 'EXECUTOR_ERROR'
  | 'ASSET_STORE_ERROR'
  | 'INVALID_EXECUTOR_RESULT';

export class WorkflowTransformExecutionError extends Error {
  constructor(
    readonly code: WorkflowTransformExecutionErrorCode,
    message: string,
    readonly nextAction: string,
    readonly failureGraph?: WorkflowGraphV2,
  ) {
    super(message);
    this.name = 'WorkflowTransformExecutionError';
  }
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneValue) as T;
  if (value instanceof Uint8Array) return new Uint8Array(value) as T;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)])) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || value instanceof Uint8Array) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function validAsset(asset: WorkflowProjectAsset, output: WorkflowNodeV2): boolean {
  return Boolean(
    asset.id.trim()
    && asset.name.trim()
    && asset.relativePath.trim()
    && asset.mime?.startsWith('image/')
    && asset.width === numberConfig(output, 'finalWidth')
    && asset.height === numberConfig(output, 'finalHeight'),
  );
}

function textConfig(node: WorkflowNodeV2, key: string): string {
  return typeof node.config[key] === 'string' ? node.config[key].trim() : '';
}

function numberConfig(node: WorkflowNodeV2, key: string): number {
  const value = node.config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function recordConfig(node: WorkflowNodeV2, key: string): Record<string, unknown> {
  const value = node.config[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? cloneValue(value as Record<string, unknown>)
    : {};
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? cloneValue(value) : [];
}

function storyboardDescriptor(node: WorkflowNodeV2): WorkflowStoryboardDescriptor | null {
  const nested = recordConfig(node, 'storyboard');
  const dataUrl = optionalText(node.config.storyboardDataUrl ?? nested.dataUrl);
  const oraPath = optionalText(node.config.storyboardOraPath ?? nested.oraPath);
  const annotations = stringArray(node.config.storyboardAnnotations ?? nested.annotations);
  const annotationItems = unknownArray(node.config.storyboardAnnotationItems ?? nested.annotationItems);
  if (!dataUrl && !oraPath && annotations.length === 0 && annotationItems.length === 0) return null;
  const widthValue = node.config.storyboardWidth ?? nested.width;
  const heightValue = node.config.storyboardHeight ?? nested.height;
  return {
    dataUrl,
    oraPath,
    width: typeof widthValue === 'number' && widthValue > 0 ? widthValue : 1024,
    height: typeof heightValue === 'number' && heightValue > 0 ? heightValue : 768,
    annotations,
    annotationItems,
    annotationsVisible: (node.config.storyboardAnnotationsVisible ?? nested.annotationsVisible) !== false,
  };
}

function annotationItemConstraints(
  items: readonly unknown[],
  width: number,
  height: number,
): string[] {
  return items.flatMap((item, index) => {
    if (typeof item !== 'object' || item === null) return [];
    const record = item as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (!text || record.visible === false) return [];
    const x = typeof record.x === 'number' ? record.x : 0;
    const y = typeof record.y === 'number' ? record.y : 0;
    const itemWidth = typeof record.width === 'number' ? record.width : 0;
    const itemHeight = typeof record.height === 'number' ? record.height : 0;
    const xPercent = Math.round(((x + itemWidth / 2) / Math.max(1, width)) * 100);
    const yPercent = Math.round(((y + itemHeight / 2) / Math.max(1, height)) * 100);
    const kind = typeof record.kind === 'string' ? record.kind : 'annotation';
    return [`Annotation ${index + 1} at ${xPercent}% x, ${yPercent}% y (${kind}): ${text}`];
  });
}

function requireTransformPath(graph: WorkflowGraphV2, outputNodeId: string): {
  output: WorkflowNodeV2;
  transform: WorkflowNodeV2;
  artDirection: WorkflowNodeV2;
} {
  const output = graph.nodes.find((node) => node.id === outputNodeId && node.type === 'output');
  const transformEdge = graph.edges.find((edge) => edge.target.nodeId === outputNodeId && edge.target.portId === 'source');
  const transform = graph.nodes.find((node) => node.id === transformEdge?.source.nodeId && node.type === 'transform');
  const artEdge = transform && graph.edges.find((edge) => edge.target.nodeId === transform.id && edge.target.portId === 'source');
  const artDirection = graph.nodes.find((node) => node.id === artEdge?.source.nodeId && node.type === 'art-direction');
  if (!output || !transform || !artDirection || transformEdge?.source.portId !== 'result' || artEdge?.source.portId !== 'layout') {
    throw new WorkflowTransformExecutionError(
      'INVALID_TRANSFORM_PATH',
      'Square Output must be connected through a Generate Transform from Art Direction.',
      'Reconnect Art Direction to Generate, then Generate to Square Output',
    );
  }
  return { output, transform, artDirection };
}

function boundAsset(node: WorkflowNodeV2, assets: readonly WorkflowProjectAsset[]): WorkflowProjectAsset | null {
  const assetId = textConfig(node, 'assetId');
  const relativePath = textConfig(node, 'relativePath');
  return assets.find((asset) => (
    (assetId.length > 0 && asset.id === assetId)
    || (relativePath.length > 0 && asset.relativePath === relativePath)
  )) ?? null;
}

function canonicalContentHash(value: unknown): string | null {
  const hash = typeof value === 'string' ? value.trim() : '';
  return /^sha256:[0-9a-f]{64}$/.test(hash) ? hash : null;
}

function appendRunRecord(
  graph: WorkflowGraphV2,
  nodeId: string,
  record: WorkflowRunRecordV1,
): WorkflowGraphV2 {
  return new WorkflowGraphDomain({
    ...graph,
    nodes: graph.nodes.map((node) => node.id === nodeId
      ? { ...node, runRecordIds: [...node.runRecordIds, record.id] }
      : node),
    runRecords: [...graph.runRecords, record],
  }).graph;
}

function nextRunAttempt(graph: WorkflowGraphV2, node: WorkflowNodeV2): number {
  const prior = node.runRecordIds
    .map((id) => graph.runRecords.find((record) => record.id === id))
    .filter(isFullWorkflowRunRecord)
    .reduce((maximum, record) => Math.max(maximum, record.attempt), 0);
  return Math.max(prior, node.runRecordIds.length) + 1;
}

export function createWorkflowCompositionExecutor(
  provider: string,
  service: WorkflowCompositionService,
  options: {
    materialization?: 'visual-bytes' | 'metadata-only';
    executor?: WorkflowRunExecutor;
    describeRun?: (request: Readonly<WorkflowTransformExecutionRequest>) => WorkflowRunProvider;
  } = {},
): WorkflowNodeExecutor {
  return Object.freeze({
    provider,
    capabilities: Object.freeze(['generate']),
    materialization: options.materialization ?? 'visual-bytes',
    executor: Object.freeze(options.executor ?? {
      id: 'campaign-generate', version: '1', requestSchemaVersion: '1',
    }),
    describeRun: options.describeRun ?? ((request) => ({
      id: provider,
      model: typeof request.transform.advanced.model === 'string' ? request.transform.advanced.model : null,
      effectiveOptions: typeof request.transform.advanced.options === 'object'
        && request.transform.advanced.options !== null
        && !Array.isArray(request.transform.advanced.options)
        ? cloneValue(request.transform.advanced.options as Record<string, unknown>)
        : {},
    })),
    execute: async (request: Readonly<WorkflowTransformExecutionRequest>) => service(
      deepFreeze(cloneValue(request)) as Readonly<WorkflowTransformExecutionRequest>,
    ),
  });
}

export async function executeCampaignGenerateTransform(
  inputGraph: WorkflowGraphV2,
  outputNodeId: string,
  options: ExecuteCampaignGenerateOptions,
): Promise<WorkflowTransformExecutionOutcome> {
  const graph = new WorkflowGraphDomain(inputGraph).graph;
  if (!options.projectPath?.trim()) {
    throw new WorkflowTransformExecutionError(
      'MISSING_PROJECT',
      'Generated workflow assets need a project folder.',
      'Choose or create a project folder',
    );
  }
  const { output, transform, artDirection } = requireTransformPath(graph, outputNodeId);
  const capability = textConfig(transform, 'capability');
  if (capability !== 'generate') {
    throw new WorkflowTransformExecutionError(
      'INVALID_TRANSFORM_PATH',
      'This thin slice can run only a Transform configured with the Generate capability.',
      'Configure this Transform as Generate',
    );
  }
  const advanced = recordConfig(transform, 'advanced');
  const configuredProvider = typeof advanced.provider === 'string' ? advanced.provider.trim() : '';
  const effectiveProvider = configuredProvider || options.provider;
  const executor = options.executors.find((candidate) => (
    candidate.provider === effectiveProvider && candidate.capabilities.includes(capability)
  ));
  if (!executor) {
    throw new WorkflowTransformExecutionError(
      'UNSUPPORTED_PROVIDER',
      `The provider “${effectiveProvider}” cannot execute the ${capability || 'configured'} Transform.`,
      'Choose a supported image provider',
    );
  }

  const readiness = workflowReadiness(graph, {
    desktop: true,
    projectPath: options.projectPath,
    assets: options.assets.map((asset) => ({ id: asset.id, relativePath: asset.relativePath, exists: true })),
    provider: effectiveProvider,
    supportedProviders: options.executors.map((candidate) => candidate.provider),
    targetNodeId: outputNodeId,
  });
  if (!readiness.ready) {
    throw new WorkflowTransformExecutionError(
      'NOT_READY',
      readiness.nextAction?.message ?? 'The workflow is not ready to run.',
      readiness.nextAction?.action ?? 'Complete the workflow checklist',
    );
  }

  const plan = planWorkflowExecution(graph, outputNodeId, { maxConcurrency: 4 });
  if (plan.blocked.length > 0) {
    throw new WorkflowTransformExecutionError('NOT_READY', plan.blocked[0].message, 'Reconnect the blocked workflow inputs');
  }

  const inputEdges = graph.edges.filter((edge) => edge.target.nodeId === artDirection.id && edge.target.portId === 'assets');
  const sources: WorkflowTransformSource[] = [];
  for (const edge of inputEdges) {
    const input = graph.nodes.find((node) => node.id === edge.source.nodeId && node.type === 'input');
    if (!input) continue;
    const asset = boundAsset(input, options.assets);
    if (!asset) {
      if (input.config.required !== true) continue;
      throw new WorkflowTransformExecutionError(
        'MISSING_ASSET',
        `${input.title} points to an unavailable project asset.`,
        `Replace the asset in ${input.title}`,
      );
    }
    const material = await options.resolveAsset(asset);
    const claimedHash = canonicalContentHash(material.contentHash);
    const visualBytes = material.bytes instanceof Uint8Array && material.bytes.length > 0
      ? new Uint8Array(material.bytes)
      : null;
    const computedHash = visualBytes ? workflowSha256Bytes(visualBytes) : null;
    if (!claimedHash || (computedHash && claimedHash !== computedHash)) {
      throw new WorkflowTransformExecutionError(
        'MISSING_ASSET',
        `${input.title} could not be verified from the exact project material used for this run.`,
        `Refresh or replace the asset in ${input.title}`,
      );
    }
    if (executor.materialization !== 'metadata-only' && !visualBytes) {
      throw new WorkflowTransformExecutionError(
        'MISSING_ASSET',
        `${input.title} could not be materialized for the image provider.`,
        `Refresh or replace the asset in ${input.title}`,
      );
    }
    const contentHash = computedHash ?? claimedHash;
    sources.push({
      nodeId: input.id,
      portId: edge.source.portId,
      name: input.title,
      role: textConfig(input, 'role'),
      assetId: asset.id,
      relativePath: asset.relativePath,
      contentHash,
      bytes: executor.materialization === 'metadata-only' ? new Uint8Array() : visualBytes!,
    });
  }

  const brief = graph.nodes.find((node) => node.type === 'brief');
  const briefText = textConfig(brief ?? artDirection, brief ? 'objective' : 'prompt');
  const artDirectionText = textConfig(artDirection, 'prompt');
  const transformInstructions = textConfig(transform, 'instructions');
  const storyboard = storyboardDescriptor(artDirection);
  const placementConstraints = storyboard ? [
    'Treat the storyboard as the primary spatial plan. Preserve relative placement, ordering, scale, pose, prop positions, foreground and background zones, and intentional empty areas.',
    ...storyboard.annotations,
    ...annotationItemConstraints(storyboard.annotationItems, storyboard.width, storyboard.height),
  ] : [];
  const storyboardRead = executor.materialization !== 'metadata-only'
    && storyboard && (storyboard.dataUrl || storyboard.oraPath)
    ? await options.readStoryboard?.(deepFreeze(cloneValue(storyboard)) as Readonly<WorkflowStoryboardDescriptor>) ?? null
    : null;
  const storyboardBytes = storyboardRead?.bytes instanceof Uint8Array && storyboardRead.bytes.length > 0
    ? new Uint8Array(storyboardRead.bytes)
    : null;
  const materializedStoryboard: WorkflowStoryboardMaterialization | null = storyboard ? {
    ...storyboard,
    placementConstraints,
    source: storyboardBytes ? {
      name: 'Storyboard sketch - mandatory layout guide',
      bytes: new Uint8Array(storyboardBytes),
    } : null,
  } : null;
  const prompt = [
    briefText ? `Creative brief:\n${briefText}` : '',
    `Art direction:\n${artDirectionText}`,
    transformInstructions ? `Transform instructions:\n${transformInstructions}` : '',
    sources.length > 0
      ? `Mandatory connected visual inputs:\n${sources.map((source, index) => `${index + 1}. ${source.name}${source.role ? ` - ${source.role}` : ''}`).join('\n')}`
      : '',
    placementConstraints.length > 0
      ? `Storyboard placement constraints:\n${placementConstraints.map((item, index) => `${index + 1}. ${item}`).join('\n')}`
      : '',
    `Final output shape: ${output.title}.`,
  ].filter(Boolean).join('\n\n');
  const request: WorkflowTransformExecutionRequest = {
    workflowId: graph.id,
    nodeId: transform.id,
    capability,
    provider: effectiveProvider,
    projectPath: options.projectPath,
    brief: briefText,
    artDirection: artDirectionText,
    transform: { capability, instructions: transformInstructions, advanced },
    prompt,
    sources,
    storyboard: materializedStoryboard,
    output: {
      nodeId: output.id,
      title: output.title,
      width: numberConfig(output, 'finalWidth'),
      height: numberConfig(output, 'finalHeight'),
    },
  };

  const attempt = nextRunAttempt(graph, transform);
  const startedAt = options.clock?.() ?? Date.now();
  const runId = options.runIdGenerator?.(transform.id, attempt)
    ?? globalThis.crypto?.randomUUID?.()
    ?? `run-${transform.id}-${startedAt}-${attempt}`;
  safeWorkflowIdentifier(runId, 'Run ID');
  if (graph.runRecords.some((record) => record.id === runId)) {
    throw new WorkflowTransformExecutionError(
      'INVALID_EXECUTOR_RESULT', 'The generated run ID collides with existing workflow history.', 'Retry Generate',
    );
  }
  const referenceId = options.idGenerator?.() ?? `result-${runId}`;
  safeWorkflowIdentifier(referenceId, 'Output asset reference ID');
  if (graph.assetReferences.some((reference) => reference.id === referenceId)
    || graph.runRecords.some((record) => isFullWorkflowRunRecord(record)
      && record.outputs.some((item) => item.assetReferenceId === referenceId))) {
    throw new WorkflowTransformExecutionError(
      'INVALID_EXECUTOR_RESULT',
      'The generated output reference collides with existing workflow history.',
      'Retry Generate',
    );
  }
  const hash = options.hash ?? workflowSha256Text;
  const provenanceSources = sources.map((source) => ({
    nodeId: source.nodeId,
    assetId: source.assetId,
    relativePath: source.relativePath,
    contentHash: source.contentHash,
    name: source.name,
    role: source.role,
  }));
  if (storyboardBytes && storyboardBytes.length > 0 && storyboard) {
    provenanceSources.push({
      nodeId: artDirection.id,
      assetId: `storyboard-${artDirection.id}`,
      relativePath: storyboardRead!.relativePath,
      contentHash: workflowSha256Bytes(storyboardBytes),
      name: 'Storyboard sketch',
      role: 'Mandatory layout guide used by the provider',
    });
  }
  const runMaterial: WorkflowRunMaterialDraft = {
    sourceAssets: provenanceSources,
    prompt: {
      brief: briefText,
      artDirection: artDirectionText,
      instructions: transformInstructions,
      constraints: placementConstraints,
      effectivePrompt: prompt,
    },
    provider: executor.describeRun(deepFreeze(cloneValue(request)) as Readonly<WorkflowTransformExecutionRequest>),
    executor: executor.executor,
    output: request.output,
  };
  createWorkflowRunRecord({
    id: runId,
    nodeId: transform.id,
    attempt,
    status: 'running',
    graph,
    material: runMaterial,
    startedAt,
    finishedAt: null,
    outputs: [],
  }, hash);

  let phase: 'executor' | 'store' | 'validation' = 'executor';
  let artifact: WorkflowTransformArtifact;
  let artifactContentHash: string | null = null;
  try {
    artifact = await executor.execute(deepFreeze(cloneValue(request)) as Readonly<WorkflowTransformExecutionRequest>);
    phase = 'validation';
  } catch (error) {
    const finishedAt = options.clock?.() ?? Date.now();
    const failed = createWorkflowRunRecord({
      id: runId, nodeId: transform.id, attempt, status: 'failed', graph, material: runMaterial,
      startedAt, finishedAt, outputs: [],
      failure: { code: 'EXECUTOR_ERROR', message: (error as Error)?.message ?? String(error) },
    }, hash);
    throw new WorkflowTransformExecutionError(
      'EXECUTOR_ERROR',
      failed.failure!.message,
      'Retry Generate',
      appendRunRecord(graph, transform.id, failed),
    );
  }
  let asset: WorkflowProjectAsset;
  try {
    if (artifact.bytes instanceof Uint8Array && artifact.bytes.length > 0) {
      artifactContentHash = workflowSha256Bytes(artifact.bytes);
      const claimedHash = canonicalContentHash(artifact.contentHash);
      if (artifact.contentHash !== undefined && claimedHash !== artifactContentHash) {
        throw new WorkflowTransformExecutionError(
          'INVALID_EXECUTOR_RESULT',
          'The executor output fingerprint does not match the returned image bytes.',
          'Retry Generate',
        );
      }
    }
    if (artifact.kind === 'project-asset') {
      asset = cloneValue(artifact.asset);
    } else if (
      artifact.kind === 'bytes'
      && artifact.bytes instanceof Uint8Array
      && artifact.bytes.length > 0
      && artifact.name.trim()
      && artifact.mime.startsWith('image/')
      && artifact.width === numberConfig(output, 'finalWidth')
      && artifact.height === numberConfig(output, 'finalHeight')
    ) {
      phase = 'store';
      asset = await options.storeAsset({
        projectPath: options.projectPath,
        prompt,
        name: artifact.name,
        bytes: new Uint8Array(artifact.bytes),
        mime: artifact.mime,
        width: artifact.width,
        height: artifact.height,
      });
      phase = 'validation';
    } else {
      throw new WorkflowTransformExecutionError(
        'INVALID_EXECUTOR_RESULT',
        'The Transform executor did not return a project asset or image bytes.',
        'Retry Generate',
      );
    }
    if (!validAsset(asset, output)) {
      throw new WorkflowTransformExecutionError(
        'INVALID_EXECUTOR_RESULT',
        `Generate must return an actual ${numberConfig(output, 'finalWidth')} x ${numberConfig(output, 'finalHeight')} image asset.`,
        'Retry Generate',
      );
    }
    safeWorkflowIdentifier(asset.id, 'Generated asset ID');
    requireProjectRelativeWorkflowReference(asset.relativePath, 'Generated asset path');
    if (graph.assetReferences.some((reference) => reference.assetId === asset.id)) {
      throw new WorkflowTransformExecutionError(
        'INVALID_EXECUTOR_RESULT',
        'The generated asset ID collides with an existing workflow asset.',
        'Retry Generate',
      );
    }
  } catch (error) {
    const finishedAt = options.clock?.() ?? Date.now();
    const original = error instanceof WorkflowTransformExecutionError ? error : null;
    const failureCode = phase === 'store' ? 'ASSET_STORE_ERROR' : 'INVALID_EXECUTOR_RESULT';
    const failed = createWorkflowRunRecord({
      id: runId, nodeId: transform.id, attempt, status: 'failed', graph, material: runMaterial,
      startedAt, finishedAt, outputs: [],
      failure: { code: failureCode, message: original?.message ?? (error as Error)?.message ?? String(error) },
    }, hash);
    throw new WorkflowTransformExecutionError(
      failureCode,
      failed.failure!.message,
      original?.nextAction ?? 'Retry Generate',
      appendRunRecord(graph, transform.id, failed),
    );
  }

  const outputContentHash = artifactContentHash;
  if (!outputContentHash) {
    const finishedAt = options.clock?.() ?? Date.now();
    const failed = createWorkflowRunRecord({
      id: runId, nodeId: transform.id, attempt, status: 'failed', graph, material: runMaterial,
      startedAt, finishedAt, outputs: [],
      failure: { code: 'INVALID_EXECUTOR_RESULT', message: 'Generated asset fingerprint is unavailable.' },
    }, hash);
    throw new WorkflowTransformExecutionError(
      'INVALID_EXECUTOR_RESULT', failed.failure!.message, 'Refresh the generated project asset',
      appendRunRecord(graph, transform.id, failed),
    );
  }

  const finishedAt = options.clock?.() ?? Date.now();
  let resultGraph: WorkflowGraphV2;
  try {
    const succeeded = createWorkflowRunRecord({
      id: runId,
      nodeId: transform.id,
      attempt,
      status: 'succeeded',
      graph,
      material: runMaterial,
      startedAt,
      finishedAt,
      outputs: [{
        assetReferenceId: referenceId,
        assetId: asset.id,
        relativePath: asset.relativePath,
        contentHash: outputContentHash,
        acceptedAt: finishedAt,
      }],
    }, hash);
    resultGraph = appendRunRecord({
      ...graph,
      nodes: graph.nodes.map((node) => {
        if (node.id === transform.id) {
          return { ...node, config: {
            ...node.config,
            resultAssetReferenceId: referenceId,
            resultAssetId: asset.id,
            resultRelativePath: asset.relativePath,
          } };
        }
        if (node.id === output.id) {
          return { ...node, config: {
            ...node.config,
            assetReferenceId: referenceId,
            outputAssetId: asset.id,
            outputRelativePath: asset.relativePath,
          } };
        }
        return node;
      }),
      assetReferences: [
        ...graph.assetReferences,
        { id: referenceId, role: 'output', assetId: asset.id, relativePath: asset.relativePath },
      ],
    }, transform.id, succeeded);
  } catch (error) {
    const failed = createWorkflowRunRecord({
      id: runId, nodeId: transform.id, attempt, status: 'failed', graph, material: runMaterial,
      startedAt, finishedAt, outputs: [],
      failure: { code: 'INVALID_EXECUTOR_RESULT', message: (error as Error)?.message ?? String(error) },
    }, hash);
    throw new WorkflowTransformExecutionError(
      'INVALID_EXECUTOR_RESULT', failed.failure!.message, 'Retry Generate',
      appendRunRecord(graph, transform.id, failed),
    );
  }
  return {
    graph: new WorkflowGraphDomain(resultGraph).graph,
    plan,
    request: deepFreeze(cloneValue(request)) as Readonly<WorkflowTransformExecutionRequest>,
    asset: cloneValue(asset),
    transformNodeId: transform.id,
    outputNodeId: output.id,
  };
}
